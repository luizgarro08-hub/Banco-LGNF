'use strict';

/* =========================================================
   ÁUREA - front-end do banco digital de simulação

   Protocolo com o servidor (inalterado, mesmos eventos de antes):
     envia:   client_login, client_register, client_request_reset,
              client_send_pix, admin_set_balance,
              admin_toggle_block, admin_reset_password
     recebe:  update_data, login_response, register_response,
              pix_response, admin_response, reset_request_response

   O que o servidor já faz (login, saldo, Pix, bloqueio, senha) continua
   sendo do servidor. Os módulos novos (extrato detalhado, investimentos,
   cartões, fatura, pagamentos, notificações, perfil) rodam numa camada
   local por conta, guardada no navegador (localStorage). Tudo é
   fictício e nada aqui movimenta dinheiro real.
   ========================================================= */

const socket = io();

/* ---------- Configuração ---------- */

const CONFIG = {
  agency: '0001',
  highValue: 1000,            // a partir daqui pede confirmação de identidade
  depositMax: 50000,
  withdrawMax: 5000,
  cardLimitMin: 500,
  cardLimitMax: 20000,
  cardLimitDefault: 5000,
  invoiceCloseDay: 3,         // dia de fechamento da fatura
  invoiceDueDay: 10,          // dia de vencimento
  refiRate: 0.0299,           // juros mensais fictícios ao parcelar a fatura
  simDaysPerMinute: 3,        // 1 minuto real = 3 dias simulados nos investimentos
  processingMs: 1100,
  pixTimeoutMs: 12000,
  storagePrefix: 'aurea:v2:'
};

const SIM_EPOCH = Date.UTC(2024, 0, 1);

/* ---------- Catálogos ---------- */

const TYPES = {
  pix_out:      { label: 'Pix enviado',              icon: 'out',      group: 'pix',      tone: 'out' },
  pix_in:       { label: 'Pix recebido',             icon: 'in',       group: 'pix',      tone: 'in'  },
  transfer_out: { label: 'Transferência enviada',    icon: 'transfer', group: 'transfer', tone: 'out' },
  payment:      { label: 'Pagamento',                icon: 'pay',      group: 'payment',  tone: 'out' },
  card_bill:    { label: 'Pagamento de fatura',      icon: 'card',     group: 'payment',  tone: 'out' },
  deposit:      { label: 'Depósito',                 icon: 'deposit',  group: 'other',    tone: 'in'  },
  withdraw:     { label: 'Saque',                    icon: 'withdraw', group: 'other',    tone: 'out' },
  invest:       { label: 'Investimento aplicado',    icon: 'invest',   group: 'invest',   tone: 'inv' },
  redeem:       { label: 'Resgate de investimento',  icon: 'invest',   group: 'invest',   tone: 'inv' },
  credit:       { label: 'Crédito na conta',         icon: 'in',       group: 'other',    tone: 'in'  },
  debit:        { label: 'Débito na conta',          icon: 'out',      group: 'other',    tone: 'out' },
  adjust_in:    { label: 'Ajuste de saldo',          icon: 'shield',   group: 'other',    tone: 'in'  },
  adjust_out:   { label: 'Ajuste de saldo',          icon: 'shield',   group: 'other',    tone: 'out' }
};

const PRODUCTS = [
  { id: 'poupanca', name: 'Poupança',            icon: 'shield', rate: 6.2,  risk: 1, min: 1,   liq: 'Resgate na hora',
    desc: 'Rendimento simples e previsível. Bom para começar a guardar.' },
  { id: 'cdb',      name: 'CDB Áurea',           icon: 'invest', rate: 13.2, risk: 1, min: 100, liq: 'Resgate na hora',
    desc: 'Renda fixa com rentabilidade acima da poupança e sem oscilação.' },
  { id: 'tesouro',  name: 'Tesouro Selic',       icon: 'pay',    rate: 12.4, risk: 1, min: 30,  liq: 'Resgate na hora',
    desc: 'Título público fictício que acompanha a taxa básica de juros.' },
  { id: 'rendafixa', name: 'Renda fixa plus',    icon: 'chart',  rate: 11.2, risk: 2, min: 50,  liq: 'Resgate na hora',
    vol: { a: 0.004, p1: 13, b: 0.002, p2: 5 },
    desc: 'Carteira de títulos privados fictícios, com pequenas oscilações.' },
  { id: 'fundo',    name: 'Fundo de investimento', icon: 'users', rate: 15,  risk: 3, min: 100, liq: 'Resgate na hora',
    vol: { a: 0.012, p1: 11, b: 0.006, p2: 4 },
    desc: 'Um fundo multimercado fictício: rende mais, mas oscila mais.' },
  { id: 'acoes',    name: 'Ações fictícias AUR3', icon: 'invest', rate: 18,  risk: 5, min: 10,  liq: 'Resgate na hora',
    vol: { a: 0.07, p1: 9, b: 0.035, p2: 3.1 },
    desc: 'Papel inventado da própria Áurea. Pode subir e cair bastante.' }
];
const PRODUCT_BY_ID = Object.fromEntries(PRODUCTS.map(p => [p.id, p]));

const PAY_CATS = [
  { id: 'agua',     label: 'Água',     icon: 'droplet' },
  { id: 'energia',  label: 'Energia',  icon: 'zap' },
  { id: 'internet', label: 'Internet', icon: 'wifi' },
  { id: 'telefone', label: 'Telefone', icon: 'phone' },
  { id: 'compras',  label: 'Compras',  icon: 'bag' },
  { id: 'outros',   label: 'Outros',   icon: 'dots' }
];

const NOTIF_ICONS = { in: 'in', out: 'out', invest: 'invest', pay: 'pay', card: 'card', alert: 'alert', info: 'info', shield: 'shield' };

const EMOJIS = ['🦊', '🐼', '🦁', '🐙', '🦄', '🐢', '🌻', '🚀', '⚡', '🎧', '🍀', '🌙'];

const VIEW_TITLES = {
  home: 'Início', pix: 'Pix', transfer: 'Transferências', extract: 'Extrato', invest: 'Investimentos',
  cards: 'Cartões e fatura', pay: 'Pagamentos', analytics: 'Análises', notifs: 'Notificações', profile: 'Perfil e ajustes'
};

/* ---------- Estado ---------- */

const state = {
  users: {},
  history: [],
  me: null,
  acct: null,
  hidden: false,
  view: 'home',
  tabs: { pix: 'send', cards: 'card' },
  filter: 'all',
  search: '',
  period: '30d',
  cardSel: 'virtual',
  cardFlipped: false,
  cvvShown: false,
  payCat: null,
  prevHistoryKeys: new Set(),
  pendingPix: null,
  adminOpen: false,
  pendingAdmin: null,
  lastId: '',
  admSearch: '',
  pd: false,
  dirty: false,
  timers: []
};

/* ---------- Utilitários ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const round2 = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => brl.format(Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = v => `${(Number.isFinite(v) ? v : 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const compact = v => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1).replace('.', ',')} mi`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace('.', ',')} mil`;
  return String(Math.round(v));
};

function parseMoney(raw) {
  let s = String(raw == null ? '' : raw).replace(/[R$\s]/g, '').trim();
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? round2(n) : NaN;
}

const fmtDate = ts => new Date(ts).toLocaleDateString('pt-BR');
const fmtTime = ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = ts => `${fmtDate(ts)} às ${new Date(ts).toLocaleTimeString('pt-BR')}`;
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

function dayLabel(ts) {
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  return new Date(ts).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 172800) return 'ontem';
  return fmtDate(ts);
}

const uid = () => Math.random().toString(36).slice(2, 9);
const txId = () => `AUR${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

function hashStr(s) {
  let h = 2166136261;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ic = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* Valor monetário que respeita o botão de ocultar saldo */
function moneyHtml(v, prefix = '') {
  return `<span data-money data-val="${Number(v) || 0}" data-prefix="${esc(prefix)}">${state.hidden ? 'R$ ••••' : esc(prefix + money(v))}</span>`;
}
function setMoney(el, v, prefix = '') {
  if (!el) return;
  el.dataset.val = String(Number(v) || 0);
  el.dataset.prefix = prefix;
  el.textContent = state.hidden ? 'R$ ••••' : prefix + money(v);
}
function applyMask() {
  $$('[data-money]').forEach(el => {
    if (el.dataset.val === undefined) return;
    el.textContent = state.hidden ? 'R$ ••••' : (el.dataset.prefix || '') + money(Number(el.dataset.val));
  });
}

/* ---------- Armazenamento local (por conta) ---------- */

function defaultAccount() {
  return {
    v: 2,
    adj: 0,
    lastServerBalance: null,
    ledger: [],
    notifs: [],
    invest: [],
    keys: [],
    welcomed: false,
    card: { limit: CONFIG.cardLimitDefault, virtual: null, physical: null, purchases: [], payments: [], notified: {} },
    profile: {
      displayName: '',
      email: '',
      avatar: { type: 'initial' },
      prefs: { hideBalance: false, confirmHigh: true, notify: true }
    }
  };
}

function normalizeAccount(d) {
  const base = defaultAccount();
  if (!d || typeof d !== 'object') return base;
  const out = { ...base, ...d };
  out.card = { ...base.card, ...(d.card || {}) };
  out.profile = { ...base.profile, ...(d.profile || {}) };
  out.profile.prefs = { ...base.profile.prefs, ...((d.profile || {}).prefs || {}) };
  ['ledger', 'notifs', 'invest', 'keys'].forEach(k => { if (!Array.isArray(out[k])) out[k] = []; });
  ['purchases', 'payments'].forEach(k => { if (!Array.isArray(out.card[k])) out.card[k] = []; });
  if (!out.card.notified || typeof out.card.notified !== 'object') out.card.notified = {};
  if (!Number.isFinite(out.adj)) out.adj = 0;
  return out;
}

const Store = {
  key: id => CONFIG.storagePrefix + id,
  load(id) {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(this.key(id))); } catch (e) { d = null; }
    return normalizeAccount(d);
  },
  save(id, data) {
    try { localStorage.setItem(this.key(id), JSON.stringify(data)); } catch (e) { /* armazenamento cheio ou bloqueado */ }
  },
  remove(id) {
    try { localStorage.removeItem(this.key(id)); } catch (e) { /* ignora */ }
  }
};

function persist() {
  if (state.me && state.acct) Store.save(state.me, state.acct);
}

/* ---------- Toasts ---------- */

function toast({ type = 'info', title = '', msg = '', timeout = 3800 }) {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  const icon = type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info';
  el.innerHTML = `<span class="toast__ic">${ic(icon)}</span><div><b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ''}</div>`;
  root.appendChild(el);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  setTimeout(close, type === 'err' ? Math.max(timeout, 5200) : timeout);
  el.addEventListener('click', close);
  while (root.children.length > 4) root.firstElementChild.remove();
}

/* ---------- Modais ---------- */

const modalStack = [];

function openModal({ html = '', dismissible = true, onClose = null } = {}) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = '<div class="modal" role="dialog" aria-modal="true"></div>';
  const box = backdrop.firstElementChild;

  const m = {
    el: box,
    dismissible,
    closed: false,
    onClose,
    set(h, focus = true) {
      box.innerHTML = h;
      box.scrollTop = 0;
      if (focus) {
        setTimeout(() => {
          const f = box.querySelector('[autofocus], input:not([readonly]):not([type=hidden]), select');
          if (f) f.focus({ preventScroll: true });
        }, 40);
      }
    },
    close(v) {
      if (m.closed) return;
      m.closed = true;
      backdrop.remove();
      const i = modalStack.indexOf(m);
      if (i >= 0) modalStack.splice(i, 1);
      if (!modalStack.length) document.body.style.overflow = '';
      if (typeof m.onClose === 'function') m.onClose(v);
    }
  };

  backdrop.addEventListener('mousedown', e => {
    if (e.target === backdrop && m.dismissible) m.close(null);
  });

  root.appendChild(backdrop);
  modalStack.push(m);
  document.body.style.overflow = 'hidden';
  m.set(html);
  return m;
}

function closeAllModals() {
  while (modalStack.length) modalStack[modalStack.length - 1].close(null);
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const m = modalStack[modalStack.length - 1];
  if (m && m.dismissible) m.close(null);
});

function fieldHtml(f) {
  const id = `mf-${f.id}`;
  let control;
  if (f.type === 'select') {
    control = `<select id="${id}" name="${f.id}">${(f.options || []).map(o =>
      `<option value="${esc(o.v)}"${String(o.v) === String(f.value) ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`;
  } else {
    const type = f.type === 'money' ? 'text' : (f.type || 'text');
    const mode = f.type === 'money' ? ' inputmode="decimal"' : '';
    control = `<input id="${id}" name="${f.id}" type="${type}"${mode} placeholder="${esc(f.placeholder || '')}" value="${esc(f.value == null ? '' : f.value)}" autocomplete="off"${f.max ? ` maxlength="${f.max}"` : ''}>`;
  }
  return `<label class="field"><span>${esc(f.label)}</span>${control}${f.hint ? `<small class="hint">${f.hint}</small>` : ''}</label>`;
}

/* Modal com formulário; resolve com os valores ou null se cancelar */
function formModal({ title, sub = '', fields = [], submit = 'Continuar', validate = null, danger = false }) {
  return new Promise(resolve => {
    const m = openModal({ onClose: () => resolve(null) });
    m.set(`
      <h2>${esc(title)}</h2>
      ${sub ? `<p class="modal__sub">${sub}</p>` : ''}
      <form class="form" novalidate>
        ${fields.map(fieldHtml).join('')}
        <p class="modal__err" data-err role="alert"></p>
        <div class="modal__foot">
          <button type="button" class="btn" data-x>Cancelar</button>
          <button type="submit" class="btn ${danger ? 'btn--danger' : 'btn--primary'}">${esc(submit)}</button>
        </div>
      </form>`);
    const form = $('form', m.el);
    $('[data-x]', form).addEventListener('click', () => m.close(null));
    form.addEventListener('submit', e => {
      e.preventDefault();
      const vals = {};
      fields.forEach(f => { vals[f.id] = String(form.elements[f.id].value).trim(); });
      const err = validate ? validate(vals) : null;
      if (err) { $('[data-err]', form).textContent = err; return; }
      resolve(vals);
      m.close(vals);
    });
  });
}

function confirmDialog({ title, message = '', confirm = 'Confirmar', cancel = 'Cancelar', danger = false }) {
  return new Promise(resolve => {
    const m = openModal({ onClose: () => resolve(false) });
    m.set(`
      <h2>${esc(title)}</h2>
      <p class="modal__sub">${message}</p>
      <div class="modal__foot">
        <button type="button" class="btn" data-x>${esc(cancel)}</button>
        <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-ok>${esc(confirm)}</button>
      </div>`);
    $('[data-x]', m.el).addEventListener('click', () => m.close(false));
    $('[data-ok]', m.el).addEventListener('click', () => { resolve(true); m.close(true); });
  });
}

function noticeModal({ tone = 'info', title, message = '', button = 'Entendi' }) {
  const m = openModal();
  const bad = tone === 'err';
  m.set(`
    <div class="result">
      <div class="result__ic ${bad ? 'result__ic--bad' : 'result__ic--ok'}">${ic(bad ? 'x' : tone === 'ok' ? 'check' : 'info')}</div>
      <h2>${esc(title)}</h2>
      <p class="result__msg">${esc(message)}</p>
      <div class="modal__foot"><button type="button" class="btn btn--primary" data-x>${esc(button)}</button></div>
    </div>`);
  $('[data-x]', m.el).addEventListener('click', () => m.close(null));
  return m;
}

function errorScreen(title, message) {
  return noticeModal({ tone: 'err', title, message });
}

/* =========================================================
   DADOS DO SERVIDOR E CONTA ATUAL
   ========================================================= */

const hkey = h => `${h.date}|${h.desc}`;

function me() { return state.users[state.me] || null; }
function isBlocked() { const u = me(); return !!(u && u.isBlocked); }
function serverBalance() { const u = me(); return u ? round2(Number(u.balance) || 0) : 0; }
function available() { return round2(serverBalance() + (state.acct ? state.acct.adj : 0)); }
function displayName() { return (state.acct && state.acct.profile.displayName) || (me() && me().name) || 'Cliente'; }
function accountEmail() { return (state.acct && state.acct.profile.email) || `conta${state.me}@aurea.sim`; }

function findByPixKey(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  for (const [id, u] of Object.entries(state.users)) {
    if (String(u.pixKey || '').trim().toLowerCase() === k) return { id, ...u };
  }
  return null;
}
function findById(id) {
  const k = String(id || '').trim();
  const u = state.users[k];
  return u ? { id: k, ...u } : null;
}
function otherUsersCount() { return Object.keys(state.users).filter(id => id !== state.me).length; }

function fakeCpf() {
  const r = rng(hashStr(`cpf-${state.me}`));
  const d = () => Math.floor(r() * 10);
  const a = `${d()}${d()}${d()}`, b = `${d()}${d()}${d()}`;
  return `•••.${a}.${b}-••`;
}

/* ---------- Extrato local ---------- */

function addLedger({ type, dir, amount, party = '', desc = '', meta = {}, ts = Date.now(), balanceAfter }) {
  const e = {
    id: txId(), ts, type, dir,
    amount: round2(amount), party, desc, meta,
    balanceAfter: balanceAfter == null ? available() : round2(balanceAfter)
  };
  const L = state.acct.ledger;
  L.push(e);
  if (L.length > 1500) L.splice(0, L.length - 1500);
  persist();
  return e;
}

function applyAdj(delta) {
  state.acct.adj = round2(state.acct.adj + delta);
}

function ledgerDesc() {
  return state.acct.ledger.map((e, i) => ({ e, i })).sort((a, b) => (b.e.ts - a.e.ts) || (b.i - a.i)).map(x => x.e);
}

const isIncome = e => e.dir > 0 && e.type !== 'redeem';
const isSpend = e => e.dir < 0 && e.type !== 'invest';

function entryTitle(e) {
  const t = TYPES[e.type] || TYPES.debit;
  switch (e.type) {
    case 'pix_out': return `Pix para ${e.party || 'destinatário'}`;
    case 'pix_in': return e.party ? `Pix de ${e.party}` : 'Pix recebido';
    case 'transfer_out': return `Transferência para ${e.party || 'destinatário'}`;
    case 'payment': return e.party ? `Pagamento de ${e.party.toLowerCase()}` : 'Pagamento';
    case 'invest': return `Aplicação em ${e.party}`;
    case 'redeem': return `Resgate de ${e.party}`;
    case 'card_bill': return e.party || 'Fatura do cartão';
    default: return e.party || t.label;
  }
}

function matchesFilter(e, f) {
  const t = TYPES[e.type] || TYPES.debit;
  switch (f) {
    case 'in': return e.dir > 0;
    case 'out': return e.dir < 0;
    case 'pix': return t.group === 'pix';
    case 'transfer': return t.group === 'transfer';
    case 'payment': return t.group === 'payment';
    case 'invest': return t.group === 'invest';
    default: return true;
  }
}

function txRow(e, { bal = false, withDate = false } = {}) {
  const t = TYPES[e.type] || TYPES.debit;
  const sign = e.dir > 0 ? '+ ' : e.dir < 0 ? '− ' : '';
  const cls = t.tone === 'inv' ? '' : e.dir > 0 ? 'pos' : e.dir < 0 ? 'neg' : '';
  const sub = e.desc ? e.desc : t.label;
  const when = withDate ? `${fmtDate(e.ts)} ${fmtTime(e.ts)}` : fmtTime(e.ts);
  return `<button type="button" class="tx" data-action="tx-detail" data-arg="${esc(e.id)}">
    <span class="tx__ic tx__ic--${t.tone}">${ic(t.icon)}</span>
    <span class="tx__main"><b>${esc(entryTitle(e))}</b><small>${esc(sub)}</small>${bal ? `<small class="tx__bal">Saldo após: ${moneyHtml(e.balanceAfter)}</small>` : ''}</span>
    <span class="tx__val"><b class="${cls}">${sign}${esc(money(e.amount))}</b><small>${when}</small></span>
  </button>`;
}

function emptyBlock(title, text, btn = '') {
  return `<div class="empty"><b>${esc(title)}</b>${esc(text)}${btn}</div>`;
}

/* ---------- Notificações ---------- */

function unreadCount() { return state.acct ? state.acct.notifs.filter(n => !n.read).length : 0; }

function updateBadges() {
  const n = unreadCount();
  $$('[data-notif-badge]').forEach(el => {
    el.hidden = n === 0;
    el.textContent = n > 99 ? '99+' : String(n);
  });
}

function notify({ kind = 'info', title, msg = '', silent = false }) {
  if (!state.acct) return;
  const n = { id: uid(), ts: Date.now(), kind, title, msg, read: false };
  state.acct.notifs.unshift(n);
  if (state.acct.notifs.length > 100) state.acct.notifs.length = 100;
  persist();
  updateBadges();
  if (!silent && state.acct.profile.prefs.notify) {
    toast({ type: kind === 'alert' ? 'err' : 'info', title, msg });
  }
  if (state.view === 'notifs') renderNotifs();
}

/* ---------- Saldo do servidor: detectar entradas e saídas externas ---------- */

function mentionsMe(desc) {
  const u = me();
  if (!u) return false;
  const d = String(desc || '').toLowerCase();
  if (u.name && d.includes(String(u.name).toLowerCase())) return true;
  if (u.pixKey && d.includes(String(u.pixKey).toLowerCase())) return true;
  return new RegExp(`(conta|id)\\s*#?:?\\s*${escRe(state.me)}(?!\\d)`, 'i').test(String(desc || ''));
}

function amountsIn(desc) {
  const out = [];
  const re = /R\$\s*([\d.,]+)/g;
  let m;
  while ((m = re.exec(String(desc || '')))) {
    const n = parseMoney(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function parseBrDate(str) {
  const m = String(str || '').match(/(\d{2})\/(\d{2})\/(\d{4})[ ,]+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
}

function findServerLine(amt) {
  const cands = state.history.filter(h => mentionsMe(h.desc) && amountsIn(h.desc).some(a => Math.abs(a - amt) < 0.006));
  if (!cands.length) return null;
  const fresh = cands.filter(h => !state.prevHistoryKeys.has(hkey(h)));
  const pool = fresh.length ? fresh : cands;
  const dated = pool.map(h => ({ h, t: parseBrDate(h.date) })).filter(x => x.t);
  if (dated.length === pool.length) { dated.sort((a, b) => b.t - a.t); return dated[0].h; }
  return pool[0];
}

function findParty(desc) {
  const d = String(desc || '').toLowerCase();
  for (const [id, u] of Object.entries(state.users)) {
    if (id === state.me) continue;
    if (u.name && d.includes(String(u.name).toLowerCase())) return u.name;
    if (u.pixKey && d.includes(String(u.pixKey).toLowerCase())) return u.name || u.pixKey;
    if (new RegExp(`(conta|id)\\s*#?:?\\s*${escRe(id)}(?!\\d)`, 'i').test(String(desc || ''))) return u.name || id;
  }
  return null;
}

function recordExternalDelta(delta) {
  const amt = Math.abs(delta);
  const line = findServerLine(amt);
  const desc = line ? String(line.desc) : '';
  const party = desc ? findParty(desc) : null;
  const isPix = /pix/i.test(desc);
  const isAdj = /ajust|admin|saldo/i.test(desc);
  let type;
  if (delta > 0) type = (isPix || (party && !isAdj)) ? 'pix_in' : isAdj ? 'adjust_in' : 'credit';
  else type = isPix ? 'pix_out' : isAdj ? 'adjust_out' : 'debit';

  const e = addLedger({
    type, dir: delta > 0 ? 1 : -1, amount: amt,
    party: type === 'pix_in' || type === 'pix_out' ? (party || '') : '',
    desc: type.startsWith('adjust') ? 'Ajuste feito pelo administrador' : (type === 'credit' ? 'Crédito registrado pelo servidor' : type === 'debit' ? 'Débito registrado pelo servidor' : ''),
    meta: { source: 'server' }
  });

  if (type === 'pix_in') notify({ kind: 'in', title: 'Pix recebido', msg: `${party || 'Alguém'} enviou ${money(amt)} para você.` });
  else if (type === 'pix_out') notify({ kind: 'out', title: 'Pix enviado', msg: `${money(amt)} saíram da sua conta.` });
  else if (type.startsWith('adjust')) notify({ kind: 'shield', title: 'Saldo ajustado', msg: `O administrador ${delta > 0 ? 'somou' : 'retirou'} ${money(amt)} da sua conta.` });
  else if (delta > 0) notify({ kind: 'in', title: 'Crédito na conta', msg: `${money(amt)} entraram na sua conta.` });
  else notify({ kind: 'out', title: 'Débito na conta', msg: `${money(amt)} saíram da sua conta.` });
  return e;
}

function reconcileBalance() {
  const u = me();
  if (!u || !state.acct) return;
  const bal = round2(Number(u.balance) || 0);
  const last = state.acct.lastServerBalance;
  if (last === null || last === undefined) {
    state.acct.lastServerBalance = bal;
    persist();
    return;
  }
  const delta = round2(bal - last);
  if (Math.abs(delta) < 0.005) return;

  const p = state.pendingPix;
  if (p && delta < 0 && Math.abs(Math.abs(delta) - p.amount) < 0.005) {
    p.deltaSeen = true;
    state.acct.lastServerBalance = bal;
    persist();
    if (p.done) state.pendingPix = null;
    return;
  }
  state.acct.lastServerBalance = bal;
  recordExternalDelta(delta);
}

/* =========================================================
   INVESTIMENTOS (simulação)
   ========================================================= */

function simDays(ts) { return (ts - SIM_EPOCH) / 60000 * CONFIG.simDaysPerMinute; }

function osc(p, d) {
  const s = (hashStr(p.id) % 628) / 100;
  return 1 + p.vol.a * Math.sin(d / p.vol.p1 + s) + p.vol.b * Math.sin(d / p.vol.p2 + 2 * s);
}

function invValueAt(inv, ts, base = inv.base) {
  const p = PRODUCT_BY_ID[inv.pid];
  if (!p || !base) return 0;
  const dt = Math.max(0, simDays(ts) - simDays(inv.ts));
  let v = base * Math.pow(1 + p.rate / 100, dt / 365);
  if (p.vol) v *= osc(p, simDays(ts)) / osc(p, simDays(inv.ts));
  return v;
}

const invValue = inv => round2(invValueAt(inv, Date.now()));
const activeInvestments = () => state.acct.invest.filter(i => !i.closed);

function portfolio() {
  let cost = 0, value = 0;
  activeInvestments().forEach(i => { cost += i.cost; value += invValue(i); });
  cost = round2(cost); value = round2(value);
  return { cost, value, gain: round2(value - cost), pct: cost > 0 ? (value - cost) / cost * 100 : 0 };
}

const totalBalance = () => round2(available() + portfolio().value);

function createInvestment(pid, amount) {
  const ts = Date.now();
  const inv = { id: uid(), pid, ts, initial: amount, base: amount, cost: amount, closed: false, realized: 0, closedTs: null, events: [{ ts, type: 'aplicacao', amount }] };
  state.acct.invest.push(inv);
  persist();
  return inv;
}

function redeemInvestment(inv, amount) {
  const value = invValue(inv);
  const full = amount >= value - 0.005;
  const payout = full ? value : amount;
  const frac = full ? 1 : payout / value;
  const costPart = round2(inv.cost * frac);
  inv.realized = round2(inv.realized + (payout - costPart));
  inv.base = full ? 0 : inv.base * (1 - frac);
  inv.cost = full ? 0 : round2(inv.cost - costPart);
  inv.events.push({ ts: Date.now(), type: full ? 'resgate_total' : 'resgate', amount: payout });
  if (full) { inv.closed = true; inv.closedTs = Date.now(); }
  persist();
  return { payout, full };
}

function invSeries(inv, n = 48) {
  const t0 = inv.ts;
  const t1 = inv.closed && inv.closedTs ? inv.closedTs : Date.now();
  const base = inv.closed ? inv.initial : inv.base;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * i / n;
    pts.push({ t, v: round2(invValueAt(inv, t, base)) });
  }
  return pts;
}

function portfolioSeries(n = 48) {
  const act = activeInvestments();
  if (!act.length) return [];
  const t0 = Math.min(...act.map(i => i.ts));
  const t1 = Date.now();
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * i / n;
    let v = 0;
    act.forEach(inv => { if (t >= inv.ts) v += invValueAt(inv, t); });
    pts.push({ t, v: round2(v) });
  }
  return pts;
}

/* =========================================================
   CARTÕES E FATURA (simulação)
   ========================================================= */

function newCardFace() {
  const y = new Date().getFullYear();
  return {
    last4: String(1000 + Math.floor(Math.random() * 9000)),
    exp: `${pad(1 + Math.floor(Math.random() * 12))}/${pad((y + 4) % 100)}`,
    cvv: String(100 + Math.floor(Math.random() * 900)),
    blocked: false,
    createdTs: Date.now()
  };
}

function ensureCards() {
  const c = state.acct.card;
  if (!c.virtual) c.virtual = newCardFace();
  if (!c.physical) c.physical = newCardFace();
}

const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
function monthDiff(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}
function dueDate(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, CONFIG.invoiceDueDay, 23, 59, 59);
}
function openKey() {
  const d = new Date();
  const cur = monthKey(d);
  return d.getDate() > CONFIG.invoiceCloseDay ? addMonths(cur, 1) : cur;
}

function installmentAmount(p, k) {
  const base = Math.floor(p.total / p.n * 100) / 100;
  return k === p.n - 1 ? round2(p.total - base * (p.n - 1)) : base;
}
function invoiceItems(key) {
  const out = [];
  state.acct.card.purchases.forEach(p => {
    const k = monthDiff(p.firstKey, key);
    if (k >= 0 && k < p.n) out.push({ p, k, amount: installmentAmount(p, k) });
  });
  return out;
}
const invoiceTotal = key => round2(invoiceItems(key).reduce((s, i) => s + i.amount, 0));
const invoicePaid = key => round2(state.acct.card.payments.filter(x => x.key === key).reduce((s, x) => s + x.amount, 0));
const invoiceOutstanding = key => Math.max(0, round2(invoiceTotal(key) - invoicePaid(key)));
const cardUsed = () => Math.max(0, round2(
  state.acct.card.purchases.reduce((s, p) => s + p.total, 0) - state.acct.card.payments.reduce((s, x) => s + x.amount, 0)));
const cardAvailable = () => Math.max(0, round2(state.acct.card.limit - cardUsed()));

function invoiceStatus(key) {
  const total = invoiceTotal(key);
  const out = invoiceOutstanding(key);
  const ok = openKey();
  if (total > 0 && out <= 0.004) return { label: 'Paga', cls: 'status--ok' };
  if (key > ok) return { label: 'Futura', cls: 'status--muted' };
  if (key === ok) return { label: 'Aberta', cls: '' };
  return dueDate(key).getTime() < Date.now() ? { label: 'Vencida', cls: 'status--bad' } : { label: 'Fechada', cls: '' };
}

function pastInvoiceKeys() {
  const ok = openKey();
  const keys = new Set();
  state.acct.card.purchases.forEach(p => {
    for (let k = 0; k < p.n; k++) {
      const key = addMonths(p.firstKey, k);
      if (key < ok) keys.add(key);
    }
  });
  return [...keys].sort().reverse();
}

function overdueKey() {
  return pastInvoiceKeys().slice().reverse().find(k => invoiceOutstanding(k) > 0.004) || null;
}

function checkInvoiceNotifications() {
  if (!state.acct) return;
  const ok = openKey();
  const keys = [...new Set([...pastInvoiceKeys(), ok])];
  const seen = state.acct.card.notified;
  keys.forEach(key => {
    if (invoiceOutstanding(key) <= 0.004) return;
    const due = dueDate(key).getTime();
    const days = Math.ceil((due - Date.now()) / 86400000);
    if (days >= 0 && days <= 5 && !seen[`${key}:due`]) {
      seen[`${key}:due`] = true;
      notify({ kind: 'card', title: 'Fatura próxima do vencimento', msg: `A fatura de ${monthLabel(key)} vence em ${days === 0 ? 'hoje' : `${days} dia${days > 1 ? 's' : ''}`} (${money(invoiceOutstanding(key))}).` });
    }
    if (due < Date.now() && !seen[`${key}:late`]) {
      seen[`${key}:late`] = true;
      notify({ kind: 'alert', title: 'Fatura vencida', msg: `A fatura de ${monthLabel(key)} está em aberto: ${money(invoiceOutstanding(key))}.` });
    }
  });
  persist();
}

/* =========================================================
   ANÁLISES
   ========================================================= */

function periodBuckets(p) {
  const now = new Date();
  const Y = now.getFullYear(), M = now.getMonth(), D = now.getDate();
  const out = [];
  if (p === 'today') {
    const s = new Date(Y, M, D).getTime();
    for (let i = 0; i < 6; i++) out.push({ start: s + i * 4 * 3600000, end: s + (i + 1) * 4 * 3600000 - 1, label: `${pad(i * 4)}h` });
  } else if (p === '7d') {
    for (let i = 0; i < 7; i++) {
      const d = new Date(Y, M, D - 6 + i);
      out.push({ start: d.getTime(), end: new Date(Y, M, D - 6 + i + 1).getTime() - 1, label: d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '') });
    }
  } else if (p === '30d') {
    for (let i = 0; i < 10; i++) {
      const d = new Date(Y, M, D - 29 + i * 3);
      out.push({ start: d.getTime(), end: new Date(Y, M, D - 29 + i * 3 + 3).getTime() - 1, label: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}` });
    }
  } else {
    const n = p === '6m' ? 6 : 12;
    for (let i = 0; i < n; i++) {
      const d = new Date(Y, M - (n - 1) + i, 1);
      out.push({ start: d.getTime(), end: new Date(Y, M - (n - 1) + i + 1, 1).getTime() - 1, label: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '') });
    }
  }
  return { buckets: out, start: out[0].start, end: out[out.length - 1].end };
}

/* =========================================================
   GRÁFICOS (SVG puro, sem dependências)
   ========================================================= */

function svgBars(data, { single = false } = {}) {
  const W = 640, H = 230, L = 46, R = 8, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(1, ...data.map(d => Math.max(d.a, d.b))) * 1.12;
  const step = iw / data.length;
  const bw = Math.min(22, step * 0.32);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = T + ih - ih * i / 4;
    g += `<line class="ch-grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="ch-axis" x="${L - 6}" y="${y + 3}" text-anchor="end">${compact(max * i / 4)}</text>`;
  }
  data.forEach((d, i) => {
    const cx = L + step * i + step / 2;
    const ha = ih * d.a / max, hb = ih * d.b / max;
    if (single) {
      const w1 = Math.min(30, step * 0.5);
      g += `<rect class="bar ch-gold" x="${(cx - w1 / 2).toFixed(1)}" y="${(T + ih - ha).toFixed(1)}" width="${w1.toFixed(1)}" height="${(d.a > 0 ? Math.max(ha, 2) : 0).toFixed(1)}" rx="3"><title>${esc(d.label)}: ${esc(money(d.a))}</title></rect>`;
    } else {
      g += `<rect class="bar ch-in" x="${(cx - bw - 1).toFixed(1)}" y="${(T + ih - ha).toFixed(1)}" width="${bw.toFixed(1)}" height="${(d.a > 0 ? Math.max(ha, 2) : 0).toFixed(1)}" rx="3"><title>${esc(d.label)}: entradas ${esc(money(d.a))}</title></rect>`;
      g += `<rect class="bar ch-out" x="${(cx + 1).toFixed(1)}" y="${(T + ih - hb).toFixed(1)}" width="${bw.toFixed(1)}" height="${(d.b > 0 ? Math.max(hb, 2) : 0).toFixed(1)}" rx="3"><title>${esc(d.label)}: saídas ${esc(money(d.b))}</title></rect>`;
    }
    if (data.length <= 12 || i % 2 === 0) g += `<text class="ch-axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de entradas e saídas">${g}</svg>`;
}

function svgLine(points, { fmtX = t => fmtTime(t) } = {}) {
  const W = 640, H = 230, L = 58, R = 14, T = 14, B = 28;
  const iw = W - L - R, ih = H - T - B;
  if (!points.length) return '';
  let min = Math.min(...points.map(p => p.v));
  let max = Math.max(...points.map(p => p.v));
  if (max - min < 0.01) { const pad2 = Math.max(max * 0.01, 1); min -= pad2; max += pad2; }
  const span = max - min;
  min -= span * 0.08; max += span * 0.08;
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const x = t => L + (t1 === t0 ? iw : (t - t0) / (t1 - t0) * iw);
  const y = v => T + ih - (v - min) / (max - min) * ih;
  const gid = `g${uid()}`;
  let d = '';
  points.forEach((p, i) => { d += `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)} `; });
  const area = `${d}L${x(t1).toFixed(1)} ${T + ih} L${x(t0).toFixed(1)} ${T + ih} Z`;
  let g = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--gold)" stop-opacity="0.32"/><stop offset="1" stop-color="var(--gold)" stop-opacity="0"/></linearGradient></defs>`;
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4;
    const yy = y(v);
    g += `<line class="ch-grid" x1="${L}" x2="${W - R}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/><text class="ch-axis" x="${L - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${esc(money(v).replace(/\s/g, ' '))}</text>`;
  }
  const last = points[points.length - 1];
  g += `<path d="${area}" fill="url(#${gid})"/><path class="ch-line" d="${d.trim()}"/>`;
  g += `<circle class="ch-dot" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4.5"/>`;
  g += `<text class="ch-axis" x="${L}" y="${H - 8}">${esc(fmtX(t0))}</text><text class="ch-axis" x="${W - R}" y="${H - 8}" text-anchor="end">${esc(fmtX(t1))}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução do valor investido">${g}</svg>`;
}

function svgDonut(segs, centerLabel, fmt = money, sub = 'no período') {
  const total = segs.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return '';
  let off = 0;
  const rings = segs.map(s => {
    const p = s.value / total * 100;
    const c = `<circle cx="84" cy="84" r="54" pathLength="100" stroke="${s.color}" stroke-dasharray="${p.toFixed(2)} ${(100 - p).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 84 84)"><title>${esc(s.label)}: ${esc(fmt(s.value))}</title></circle>`;
    off += p;
    return c;
  }).join('');
  return `<svg class="donut" viewBox="0 0 168 168" role="img" aria-label="Distribuição">
    <circle cx="84" cy="84" r="54" stroke="var(--surface-2)"/>${rings}
    <text x="84" y="82" text-anchor="middle" font-size="13">${esc(centerLabel)}</text>
    <text x="84" y="100" text-anchor="middle" font-size="9" style="fill:var(--muted)">${esc(sub)}</text></svg>`;
}

function donutBlock(segs, centerLabel, fmt = money, sub = 'no período') {
  const svg = svgDonut(segs, centerLabel, fmt, sub);
  if (!svg) return '';
  const total = segs.reduce((s, x) => s + x.value, 0);
  return `${svg}<ul class="donut-legend">${segs.map(s =>
    `<li><i style="background:${s.color}"></i>${esc(s.label)}<span>${esc(fmt(s.value))} (${Math.round(s.value / total * 100)}%)</span></li>`).join('')}</ul>`;
}

function hbarsHtml(rows) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return rows.map(r => `<div class="hbar"><div class="hbar__top"><b>${esc(r.label)}</b><span>${moneyHtml(r.value)}</span></div>
    <div class="hbar__track"><div class="hbar__fill" style="width:${(r.value / max * 100).toFixed(1)}%;background:${r.color}"></div></div></div>`).join('');
}

/* ---------- QR Code fictício (só ilustrativo) ---------- */

function qrSvg(seed) {
  const N = 25;
  const r = rng(hashStr(seed));
  const m = Array.from({ length: N }, () => Array(N).fill(0));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) m[y][x] = r() > 0.52 ? 1 : 0;
  const finder = (ox, oy) => {
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
      const gx = ox + x, gy = oy + y;
      if (gx < 0 || gy < 0 || gx >= N || gy >= N) continue;
      const edge = x === 0 || x === 6 || y === 0 || y === 6;
      const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      m[gy][gx] = (x >= 0 && x <= 6 && y >= 0 && y <= 6 && (edge || core)) ? 1 : 0;
    }
  };
  finder(0, 0); finder(N - 7, 0); finder(0, N - 7);
  let rects = '';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (m[y][x]) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  return `<svg viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges" aria-hidden="true"><rect width="${N}" height="${N}" fill="#fff"/><g fill="#0a1120">${rects}</g></svg>`;
}

/* =========================================================
   TEMA, AVATAR E CABEÇALHO
   ========================================================= */

function currentThemePref() { try { return localStorage.getItem('aurea:theme') || 'dark'; } catch (e) { return 'dark'; } }
function resolvedTheme(pref) {
  if (pref === 'auto') return (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  return pref === 'light' ? 'light' : 'dark';
}
function setTheme(pref) {
  try { localStorage.setItem('aurea:theme', pref); } catch (e) { /* ignora */ }
  const t = resolvedTheme(pref);
  document.documentElement.setAttribute('data-theme', t);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#e9edf4' : '#0a0f1c');
  renderThemeIcons();
  $$('#theme-seg [data-theme-set]').forEach(b => b.classList.toggle('is-active', b.dataset.themeSet === pref));
}
function renderThemeIcons() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  $$('.theme-ic use').forEach(u => u.setAttribute('href', dark ? '#i-sun' : '#i-moon'));
}

function renderAvatars() {
  const av = state.acct ? state.acct.profile.avatar : { type: 'initial' };
  const name = state.acct ? displayName() : 'A';
  $$('[data-avatar]').forEach(el => {
    el.style.backgroundImage = '';
    el.textContent = '';
    if (av.type === 'image' && av.value) el.style.backgroundImage = `url("${av.value}")`;
    else if (av.type === 'emoji' && av.value) el.innerHTML = `<span class="avatar-emoji">${esc(av.value)}</span>`;
    else el.textContent = (name.trim()[0] || 'A').toUpperCase();
  });
}

function renderEye() {
  $$('[data-eye] use').forEach(u => u.setAttribute('href', state.hidden ? '#i-eye-off' : '#i-eye'));
  $$('[data-action="toggle-balance"]').forEach(b => b.setAttribute('aria-label', state.hidden ? 'Mostrar saldo' : 'Ocultar saldo'));
}

function renderShell() {
  if (!state.acct) return;
  $$('[data-user-name]').forEach(el => { el.textContent = displayName(); });
  $$('[data-user-account]').forEach(el => { el.textContent = `Conta ${state.me}`; });
  renderAvatars();
  updateBadges();
  renderEye();
  renderThemeIcons();
}

/* =========================================================
   NAVEGAÇÃO
   ========================================================= */

const RENDER = {
  home: () => renderHome(), pix: () => renderPix(), transfer: () => renderTransfer(), extract: () => renderExtract(),
  invest: () => renderInvest(), cards: () => renderCards(), pay: () => renderPay(), analytics: () => renderAnalytics(),
  notifs: () => renderNotifs(), profile: () => renderProfile()
};

function renderCurrent() {
  const fn = RENDER[state.view];
  if (fn && state.acct) fn();
  applyMask();
}

function safeRender() {
  if (state.pd) { state.dirty = true; return; }
  renderShell();
  renderCurrent();
  if (state.adminOpen) renderAdmin();
}

let notifTimer = null;

function navigate(name, { tab } = {}) {
  if (!VIEW_TITLES[name]) name = 'home';
  state.view = name;
  $$('.view').forEach(v => { v.hidden = v.dataset.view !== name; });
  const el = $(`#view-${name}`);
  if (el) {
    el.classList.remove('enter');
    void el.offsetWidth;
    el.classList.add('enter');
    setTimeout(() => el.classList.remove('enter'), 800);
  }
  if (tab) setTab(name, tab, false);
  $$('.nav__item[data-nav], .bottombar__item[data-nav]').forEach(b => b.classList.toggle('is-active', b.dataset.nav === name));
  $('#page-title').textContent = VIEW_TITLES[name];
  try { history.replaceState(null, '', `#/${name}`); } catch (e) { /* ignora */ }
  window.scrollTo({ top: 0 });
  clearTimeout(notifTimer);
  renderCurrent();
  if (name === 'notifs') {
    notifTimer = setTimeout(() => {
      if (state.view === 'notifs' && unreadCount() > 0) {
        state.acct.notifs.forEach(n => { n.read = true; });
        persist();
        updateBadges();
      }
    }, 2500);
  }
}

function setTab(group, tab, render = true) {
  state.tabs[group] = tab;
  $$(`.tabs[data-tabgroup="${group}"] .tab`).forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
  $$(`.tab-pane[data-group="${group}"]`).forEach(p => { p.hidden = p.dataset.pane !== tab; });
  if (render) renderCurrent();
}

/* =========================================================
   INÍCIO
   ========================================================= */

function monthStart() { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }

function setTone(el, tone) {
  el.classList.remove('pos', 'neg');
  if (tone) el.classList.add(tone);
}

function renderHome() {
  const u = me();
  if (!u) return;
  const h = new Date().getHours();
  const greeting = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  $('#welcome-msg').textContent = `${greeting}, ${displayName().split(' ')[0]}`;
  $('#today-date').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

  setMoney($('#bal-available'), available());
  setMoney($('#bal-total'), totalBalance());
  $('#bal-pixkey').textContent = `Chave Pix: ${u.pixKey}`;
  $('#bal-account').textContent = `Conta ${state.me} / Agência ${CONFIG.agency}`;
  $('#balance-card').classList.toggle('blocked', !!u.isBlocked);
  $('#block-badge').hidden = !u.isBlocked;

  const all = ledgerDesc();
  const last = all[0];
  if (last) {
    const sign = last.dir > 0 ? '+ ' : last.dir < 0 ? '− ' : '';
    $('#info-last').textContent = `${sign}${money(last.amount)}`;
    setTone($('#info-last'), last.dir > 0 && last.type !== 'redeem' ? 'pos' : last.dir < 0 && last.type !== 'invest' ? 'neg' : '');
    $('#info-last-sub').textContent = `${entryTitle(last)}, ${relTime(last.ts)}`;
  } else {
    $('#info-last').textContent = 'Nenhuma ainda';
    setTone($('#info-last'), '');
    $('#info-last-sub').textContent = 'Suas movimentações aparecem aqui.';
  }

  const ms = monthStart();
  const month = state.acct.ledger.filter(e => e.ts >= ms);
  setMoney($('#info-spend'), month.filter(isSpend).reduce((s, e) => s + e.amount, 0));
  setMoney($('#info-income'), month.filter(isIncome).reduce((s, e) => s + e.amount, 0));

  const pf = portfolio();
  setMoney($('#info-invest'), pf.value);
  $('#info-invest-sub').textContent = activeInvestments().length
    ? `${pf.gain >= 0 ? '+' : '−'} ${money(Math.abs(pf.gain))} (${pct(pf.pct)})`
    : 'Nenhum investimento ativo';
  setMoney($('#info-limit'), cardAvailable());
  $('#info-limit-sub').textContent = `disponível de ${money(state.acct.card.limit)}`;

  $('#home-recent').innerHTML = all.length
    ? all.slice(0, 5).map(e => txRow(e, { withDate: true })).join('')
    : `<li>${emptyBlock('Nenhuma movimentação ainda', 'Faça um depósito ou um Pix para começar.')}</li>`;

  const wk = periodBuckets('7d');
  const data = wk.buckets.map(b => {
    const es = state.acct.ledger.filter(e => e.ts >= b.start && e.ts <= b.end);
    return { label: b.label, a: es.filter(isIncome).reduce((s, e) => s + e.amount, 0), b: es.filter(isSpend).reduce((s, e) => s + e.amount, 0) };
  });
  $('#home-week').innerHTML = svgBars(data);
  $('#home-week-legend').innerHTML = '<span><i style="background:var(--emerald)"></i>Entradas</span><span><i style="background:var(--red)"></i>Saídas</span>';
}

/* =========================================================
   PIX
   ========================================================= */

const pixLimit = () => Math.max(0, Math.min(available(), serverBalance()));

function renderPix() {
  const u = me();
  if (!u) return;
  $('#pix-avail').textContent = `Disponível para Pix: ${state.hidden ? 'R$ ••••' : money(pixLimit())}`;

  const seed = `${state.me}|${u.pixKey}`;
  const qr = $('#qr-box');
  if (qr.dataset.seed !== seed) { qr.innerHTML = qrSvg(seed); qr.dataset.seed = seed; }
  $('#rc-name').textContent = displayName();
  $('#rc-key').textContent = u.pixKey;

  const pixes = ledgerDesc().filter(e => e.type === 'pix_in' || e.type === 'pix_out');
  const ins = pixes.filter(e => e.type === 'pix_in');
  $('#pix-received').innerHTML = ins.length
    ? ins.slice(0, 6).map(e => txRow(e, { withDate: true })).join('')
    : `<li>${emptyBlock('Nada por aqui ainda', 'Compartilhe sua chave para receber um Pix.')}</li>`;

  const sent = pixes.filter(e => e.type === 'pix_out').reduce((s, e) => s + e.amount, 0);
  const got = ins.reduce((s, e) => s + e.amount, 0);
  $('#pix-stats').innerHTML = `
    <div class="stat"><span>Enviados</span><b class="neg">${moneyHtml(sent)}</b></div>
    <div class="stat"><span>Recebidos</span><b class="pos">${moneyHtml(got)}</b></div>
    <div class="stat"><span>Quantidade</span><b>${pixes.length}</b></div>`;
  $('#pix-history').innerHTML = pixes.length
    ? pixes.map(e => txRow(e, { bal: true, withDate: true })).join('')
    : `<li>${emptyBlock('Nenhum Pix ainda', 'Seus Pix enviados e recebidos aparecem aqui.')}</li>`;

  const keys = [{ id: 'main', type: 'Chave principal', value: u.pixKey, main: true }, ...state.acct.keys];
  $('#keys-list').innerHTML = keys.map(k => `<li class="key-item">
      <span class="ico-badge">${ic('key')}</span>
      <div class="key-item__main"><b>${esc(k.value)}</b><small>${esc(k.type)}${k.main ? ', ativa para receber Pix' : ', somente demonstração'}</small></div>
      <button type="button" class="btn-icon btn-icon--ghost" data-action="key-copy" data-arg="${esc(k.value)}" aria-label="Copiar chave">${ic('copy')}</button>
      ${k.main ? '' : `<button type="button" class="btn-icon btn-icon--ghost" data-action="key-remove" data-arg="${esc(k.id)}" aria-label="Remover chave">${ic('trash')}</button>`}
    </li>`).join('');
}

function recipientBox(el, kind, html) {
  el.hidden = false;
  el.className = `recipient recipient--${kind}`;
  el.innerHTML = html;
}

function updatePixRecipient() {
  const key = $('#pix-key').value.trim();
  const box = $('#pix-recipient');
  if (!key) { box.hidden = true; return; }
  const u = findByPixKey(key);
  if (u && String(u.id) === state.me) recipientBox(box, 'bad', `${ic('alert')}<div><b>Essa é a sua própria chave</b><small>Escolha a chave de outra conta.</small></div>`);
  else if (u) recipientBox(box, 'ok', `${ic('check')}<div><b>${esc(u.name)}</b><small>Conta ${esc(u.id)}, chave encontrada</small></div>`);
  else if (otherUsersCount() > 0) recipientBox(box, 'bad', `${ic('alert')}<div><b>Chave não encontrada</b><small>Nenhum usuário do simulador usa essa chave.</small></div>`);
  else recipientBox(box, 'info', `${ic('info')}<div><b>Não deu para conferir a chave agora</b><small>O servidor faz a validação final ao enviar.</small></div>`);
}

function renderTransfer() {
  if (!me()) return;
  $('#tr-avail').textContent = `Disponível para transferir: ${state.hidden ? 'R$ ••••' : money(pixLimit())}`;
  const list = ledgerDesc().filter(e => e.type === 'transfer_out');
  $('#tr-recent').innerHTML = list.length
    ? list.slice(0, 6).map(e => txRow(e, { withDate: true })).join('')
    : `<li>${emptyBlock('Nenhuma transferência ainda', 'As transferências feitas por aqui aparecem nesta lista.')}</li>`;
}

function updateTransferRecipient() {
  const id = $('#tr-account').value.trim();
  const box = $('#tr-recipient');
  const name = $('#tr-name');
  name.value = '';
  if (!id) { box.hidden = true; return; }
  const u = findById(id);
  if (u && id === state.me) recipientBox(box, 'bad', `${ic('alert')}<div><b>Essa é a sua conta</b><small>Escolha a conta de outra pessoa.</small></div>`);
  else if (u) { name.value = u.name; recipientBox(box, 'ok', `${ic('check')}<div><b>${esc(u.name)}</b><small>Conta ${esc(id)}, agência ${CONFIG.agency}</small></div>`); }
  else if (otherUsersCount() > 0) recipientBox(box, 'bad', `${ic('alert')}<div><b>Conta não encontrada</b><small>Confira o número da conta.</small></div>`);
  else recipientBox(box, 'info', `${ic('info')}<div><b>Não deu para conferir a conta agora</b><small>O servidor faz a validação final.</small></div>`);
}

/* =========================================================
   EXTRATO
   ========================================================= */

function renderExtract() {
  if (!state.acct) return;
  $$('#ex-filters .filter').forEach(b => b.classList.toggle('is-active', b.dataset.filter === state.filter));
  const q = state.search.trim().toLowerCase();
  let list = ledgerDesc().filter(e => matchesFilter(e, state.filter));
  if (q) list = list.filter(e => `${entryTitle(e)} ${e.party} ${e.desc} ${(TYPES[e.type] || {}).label || ''}`.toLowerCase().includes(q));

  const inn = list.filter(e => e.dir > 0).reduce((s, e) => s + e.amount, 0);
  const out = list.filter(e => e.dir < 0).reduce((s, e) => s + e.amount, 0);
  $('#ex-summary').innerHTML = `
    <div class="stat"><span>Entradas</span><b class="pos">${moneyHtml(inn)}</b></div>
    <div class="stat"><span>Saídas</span><b class="neg">${moneyHtml(out)}</b></div>
    <div class="stat"><span>Operações</span><b>${list.length}</b></div>`;

  if (!list.length) {
    const filtered = state.filter !== 'all' || q;
    $('#ex-list').innerHTML = emptyBlock(
      filtered ? 'Nada encontrado' : 'Seu extrato está vazio',
      filtered ? 'Tente outro filtro ou outra busca.' : 'Faça um depósito, um Pix ou um pagamento e ele aparece aqui.');
  } else {
    let html = '', lastDay = '';
    list.forEach(e => {
      const lbl = dayLabel(e.ts);
      if (lbl !== lastDay) { html += `<div class="day-label">${esc(lbl)}</div>`; lastDay = lbl; }
      html += txRow(e, { bal: true });
    });
    $('#ex-list').innerHTML = html;
  }

  const recs = state.history.filter(h => mentionsMe(h.desc)).slice(0, 30);
  $('#ex-server-wrap').hidden = recs.length === 0;
  $('#ex-server').innerHTML = recs.map(h => `<li>[${esc(h.date)}] ${esc(h.desc)}</li>`).join('');
}

function receiptRowsFor(e) {
  const t = TYPES[e.type] || TYPES.debit;
  const rows = [
    ['Tipo', t.label],
    ['Valor', `${e.dir > 0 ? '+ ' : e.dir < 0 ? '− ' : ''}${money(e.amount)}`],
    ['Data', fmtDate(e.ts)],
    ['Horário', new Date(e.ts).toLocaleTimeString('pt-BR')]
  ];
  if (e.party) rows.push([e.dir > 0 ? 'De' : 'Para', e.party]);
  if (e.meta && e.meta.key) rows.push(['Chave Pix', e.meta.key, true]);
  if (e.meta && e.meta.account) rows.push(['Conta', `${e.meta.account}, agência ${CONFIG.agency}`]);
  if (e.desc) rows.push(['Descrição', e.desc]);
  rows.push(['Saldo após', state.hidden ? 'R$ ••••' : money(e.balanceAfter)]);
  rows.push(['ID', e.id, true]);
  return rows;
}

function rowsHtml(rows) {
  return `<dl class="rows">${rows.map(r => `<div><dt>${esc(r[0])}</dt><dd${r[2] ? ' class="mono"' : ''}>${esc(r[1])}</dd></div>`).join('')}</dl>`;
}

function receiptText(title, rows, ts = Date.now()) {
  return [
    'ÁUREA - COMPROVANTE FICTÍCIO (SIMULADOR)',
    title,
    ...rows.map(r => `${r[0]}: ${r[1]}`),
    `Emitido em: ${fmtDateTime(ts)}`,
    'Documento sem valor financeiro. Nenhum dinheiro real foi movimentado.'
  ].join('\n');
}

function showTxDetail(id) {
  const e = state.acct.ledger.find(x => x.id === id);
  if (!e) return;
  const t = TYPES[e.type] || TYPES.debit;
  const rows = receiptRowsFor(e);
  const m = openModal();
  m.set(`
    <h2>${esc(entryTitle(e))}</h2>
    <p class="modal__sub">${esc(t.label)}</p>
    <p class="amount-big ${e.dir > 0 && t.tone !== 'inv' ? 'pos' : e.dir < 0 && t.tone !== 'inv' ? 'neg' : ''}">${e.dir > 0 ? '+ ' : e.dir < 0 ? '− ' : ''}${esc(money(e.amount))}</p>
    ${rowsHtml(rows)}
    <div class="modal__foot">
      <button type="button" class="btn" data-copy>${ic('copy')} Copiar</button>
      <button type="button" class="btn" data-share>${ic('share')} Compartilhar</button>
      <button type="button" class="btn btn--primary" data-x>Fechar</button>
    </div>`);
  const text = receiptText(entryTitle(e), rows, e.ts);
  $('[data-copy]', m.el).addEventListener('click', () => copyText(text, 'Comprovante copiado'));
  $('[data-share]', m.el).addEventListener('click', () => shareText(entryTitle(e), text));
  $('[data-x]', m.el).addEventListener('click', () => m.close(null));
}

/* =========================================================
   INVESTIMENTOS
   ========================================================= */

function riskDots(n) { return `<span class="risk" aria-label="Risco ${n} de 5">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`; }

function renderInvest() {
  if (!state.acct) return;
  const p = portfolio();
  setMoney($('#iv-invested'), p.cost);
  setMoney($('#iv-value'), p.value);
  setMoney($('#iv-yield'), Math.abs(p.gain), p.gain < 0 ? '− ' : '+ ');
  $('#iv-yield').className = p.gain > 0 ? 'pos' : p.gain < 0 ? 'neg' : '';
  const pe = $('#iv-pct');
  pe.textContent = `${p.pct > 0 ? '+' : ''}${pct(p.pct)}`;
  pe.className = p.gain > 0 ? 'pos' : p.gain < 0 ? 'neg' : '';

  const series = portfolioSeries();
  $('#iv-chart').innerHTML = series.length
    ? svgLine(series, { fmtX: t => `${fmtDate(t).slice(0, 5)} ${fmtTime(t)}` })
    : emptyBlock('Sem investimentos ativos', 'Escolha um produto abaixo e invista para ver a evolução da carteira.');

  const invs = [...state.acct.invest].sort((a, b) => (a.closed - b.closed) || (b.ts - a.ts));
  $('#iv-list').innerHTML = invs.length ? invs.map(inv => {
    const pr = PRODUCT_BY_ID[inv.pid];
    if (!pr) return '';
    if (inv.closed) {
      return `<div class="inv"><div class="inv__name"><span class="ico-badge">${ic(pr.icon)}</span><div><b>${esc(pr.name)}</b><small>Encerrado em ${fmtDate(inv.closedTs || inv.ts)}</small></div></div>
        <div class="inv__nums"><div><span>Aplicado</span><b>${moneyHtml(inv.initial)}</b></div><div><span>Rendimento obtido</span><b class="${inv.realized >= 0 ? 'pos' : 'neg'}">${moneyHtml(Math.abs(inv.realized), inv.realized >= 0 ? '+ ' : '− ')}</b></div><div><span>Situação</span><b>Resgatado</b></div></div>
        <div class="inv__actions"><button type="button" class="btn" data-action="inv-detail" data-arg="${inv.id}">Detalhes</button></div></div>`;
    }
    const v = invValue(inv);
    const gain = round2(v - inv.cost);
    const gp = inv.cost > 0 ? gain / inv.cost * 100 : 0;
    return `<div class="inv"><div class="inv__name"><span class="ico-badge">${ic(pr.icon)}</span><div><b>${esc(pr.name)}</b><small>Aplicado em ${fmtDate(inv.ts)}</small></div></div>
      <div class="inv__nums"><div><span>Investido</span><b>${moneyHtml(inv.cost)}</b></div><div><span>Valor atual</span><b>${moneyHtml(v)}</b></div>
      <div><span>Rendimento</span><b class="${gain > 0 ? 'pos' : gain < 0 ? 'neg' : ''}">${moneyHtml(Math.abs(gain), gain < 0 ? '− ' : '+ ')} (${pct(gp)})</b></div></div>
      <div class="inv__actions"><button type="button" class="btn" data-action="inv-detail" data-arg="${inv.id}">Detalhes</button><button type="button" class="btn btn--primary" data-action="inv-redeem" data-arg="${inv.id}">Resgatar</button></div></div>`;
  }).join('') : emptyBlock('Você ainda não investiu', 'Escolha um dos produtos abaixo para começar.');

  $('#iv-products').innerHTML = PRODUCTS.map(pr => `<div class="product">
      <div class="product__head"><span class="ico-badge">${ic(pr.icon)}</span><b>${esc(pr.name)}</b></div>
      <div class="product__rate">${pct(pr.rate)}<small>ao ano (fictício)</small></div>
      <p>${esc(pr.desc)}</p>
      <div class="product__meta"><span>Mínimo ${esc(money(pr.min))}</span><span>Risco ${riskDots(pr.risk)}</span></div>
      <button type="button" class="btn btn--primary btn--block" data-action="invest" data-arg="${pr.id}">Investir</button>
    </div>`).join('');
}

function showInvestDetail(id) {
  const inv = state.acct.invest.find(i => i.id === id);
  if (!inv) return;
  const pr = PRODUCT_BY_ID[inv.pid];
  const v = inv.closed ? 0 : invValue(inv);
  const gain = inv.closed ? inv.realized : round2(v - inv.cost);
  const gp = (inv.closed ? inv.initial : inv.cost) > 0 ? gain / (inv.closed ? inv.initial : inv.cost) * 100 : 0;
  const series = invSeries(inv, 48);
  const step = Math.max(1, Math.floor(series.length / 6));
  const snaps = series.filter((_, i) => i % step === 0 || i === series.length - 1).slice(-7);
  const evLabel = { aplicacao: 'Aplicação', resgate: 'Resgate parcial', resgate_total: 'Resgate total' };

  const m = openModal();
  m.el.style.maxWidth = '560px';
  m.set(`
    <h2>${esc(pr.name)}</h2>
    <p class="modal__sub">Aplicado em ${fmtDate(inv.ts)} às ${fmtTime(inv.ts)}. Taxa fictícia de ${pct(pr.rate)} ao ano.</p>
    <div class="stat-row">
      <div class="stat"><span>${inv.closed ? 'Aplicado' : 'Investido'}</span><b>${moneyHtml(inv.closed ? inv.initial : inv.cost)}</b></div>
      <div class="stat"><span>${inv.closed ? 'Resgatado' : 'Valor atual'}</span><b>${inv.closed ? 'Sim' : moneyHtml(v)}</b></div>
      <div class="stat"><span>Rendimento</span><b class="${gain >= 0 ? 'pos' : 'neg'}">${moneyHtml(Math.abs(gain), gain < 0 ? '− ' : '+ ')}</b><small>${pct(gp)}</small></div>
    </div>
    <div class="chart">${svgLine(series, { fmtX: t => `${fmtDate(t).slice(0, 5)} ${fmtTime(t)}` })}</div>
    <h3 class="mt">Histórico de rendimento</h3>
    <ul class="log-list">${snaps.map((s, i) => {
      const prev = i ? snaps[i - 1].v : s.v;
      const d = round2(s.v - prev);
      return `<li class="${d > 0 ? 'ok' : d < 0 ? 'bad' : ''}">${fmtDate(s.t)} ${fmtTime(s.t)}: ${esc(money(s.v))}${i ? ` (${d >= 0 ? '+' : '−'}${esc(money(Math.abs(d)))})` : ''}</li>`;
    }).join('')}</ul>
    <h3 class="mt">Movimentações</h3>
    <ul class="log-list">${inv.events.slice().reverse().map(ev => `<li>${fmtDate(ev.ts)} ${fmtTime(ev.ts)}: ${evLabel[ev.type] || ev.type} de ${esc(money(ev.amount))}</li>`).join('')}</ul>
    <div class="modal__foot">
      <button type="button" class="btn" data-x>Fechar</button>
      ${inv.closed ? '' : '<button type="button" class="btn btn--primary" data-redeem>Resgatar</button>'}
    </div>`);
  $('[data-x]', m.el).addEventListener('click', () => m.close(null));
  const rb = $('[data-redeem]', m.el);
  if (rb) rb.addEventListener('click', () => { m.close(null); redeemFlow(inv.id); });
}

/* =========================================================
   CARTÕES E FATURA
   ========================================================= */

function cardStageHtml() {
  const kind = state.cardSel;
  const c = state.acct.card[kind];
  const name = esc(displayName().toUpperCase());
  const kindLabel = kind === 'virtual' ? 'Cartão virtual' : 'Cartão físico fictício';
  const blocked = c.blocked ? ' is-blocked' : '';
  return `<div class="cc-flip${state.cardFlipped ? ' is-flipped' : ''}" data-action="card-flip" role="button" tabindex="0" aria-label="Virar cartão">
    <div class="cc cc--${kind}${blocked}">
      <div class="cc__lock">${ic('lock')} Cartão bloqueado</div>
      <div class="cc__top"><span class="chip"></span><span class="cc__kind">${kindLabel}</span></div>
      <div class="cc__num">•••• •••• •••• ${esc(c.last4)}</div>
      <div class="cc__bottom">
        <div><small>Nome</small><b>${name}</b></div>
        <div><small>Validade</small><b>${esc(c.exp)}</b></div>
        <div><small>Bandeira</small><b>Áurea sim.</b></div>
      </div>
    </div>
    <div class="cc cc--${kind} cc--back${blocked}">
      <div class="cc__lock">${ic('lock')} Cartão bloqueado</div>
      <div class="cc__stripe"></div>
      <div class="cc__cvv"><span>CVV ${state.cvvShown ? esc(c.cvv) : '•••'}</span><button type="button" data-action="cvv-toggle">${state.cvvShown ? 'Ocultar' : 'Mostrar'}</button></div>
      <p class="cc__fine">Cartão fictício do simulador. Não use em compras reais.</p>
    </div>
  </div>`;
}

function renderCards() {
  if (!state.acct) return;
  ensureCards();
  $$('#card-switch .seg__btn').forEach(b => b.classList.toggle('is-active', b.dataset.card === state.cardSel));
  $('#card-stage').innerHTML = cardStageHtml();

  const c = state.acct.card[state.cardSel];
  const btn = $('#btn-card-block');
  btn.querySelector('span').textContent = c.blocked ? 'Desbloquear cartão' : 'Bloquear cartão';
  btn.querySelector('use').setAttribute('href', c.blocked ? '#i-unlock' : '#i-lock');

  const limit = state.acct.card.limit;
  const used = cardUsed();
  $('#card-meter').style.width = `${clamp(limit ? used / limit * 100 : 0, 0, 100)}%`;
  setMoney($('#card-avail'), cardAvailable());
  setMoney($('#card-used'), used);
  setMoney($('#card-total'), limit);

  const recent = state.acct.card.purchases.slice().sort((a, b) => b.ts - a.ts).slice(0, 5);
  $('#card-recent').innerHTML = recent.length ? recent.map(p => purchaseRow(p)).join('')
    : `<li>${emptyBlock('Nenhuma compra ainda', 'Use "Simular compra no cartão" para testar a fatura.')}</li>`;

  renderInvoice();
}

function purchaseRow(p, k = null) {
  const parc = p.n > 1 ? (k != null ? `Parcela ${k + 1} de ${p.n}` : `${p.n}x de ${money(installmentAmount(p, 0))}`) : 'À vista';
  const amount = k != null ? installmentAmount(p, k) : p.total;
  return `<li class="tx"><span class="tx__ic tx__ic--out">${ic(p.kind === 'refi' ? 'refresh' : 'bag')}</span>
    <span class="tx__main"><b>${esc(p.merchant)}</b><small>${esc(parc)}, ${fmtDate(p.ts)}</small></span>
    <span class="tx__val"><b>${esc(money(amount))}</b>${k == null && p.n > 1 ? `<small>total ${esc(money(p.total))}</small>` : ''}</span></li>`;
}

function renderInvoice() {
  const key = openKey();
  const total = invoiceTotal(key);
  const out = invoiceOutstanding(key);
  const st = invoiceStatus(key);
  $('#fa-title').textContent = `Fatura de ${monthLabel(key)}`;
  const se = $('#fa-status');
  se.textContent = st.label;
  se.className = `status ${st.cls}`;
  setMoney($('#fa-total'), out > 0 ? out : total);
  const due = dueDate(key);
  const days = Math.ceil((due.getTime() - Date.now()) / 86400000);
  $('#fa-due').textContent = `${fmtDate(due)}${days >= 0 ? ` (em ${days} dia${days === 1 ? '' : 's'})` : ''}`;
  setMoney($('#fa-avail'), cardAvailable());
  setMoney($('#fa-limit'), state.acct.card.limit);

  const late = overdueKey();
  const al = $('#fa-alert');
  if (late) {
    al.hidden = false;
    al.innerHTML = `<span>${ic('alert')} A fatura de ${esc(monthLabel(late))} está em aberto: <b>${moneyHtml(invoiceOutstanding(late))}</b>.</span><button type="button" class="btn btn--primary" data-action="invoice-pay-key" data-arg="${late}">Pagar agora</button>`;
  } else al.hidden = true;

  const items = invoiceItems(key);
  $('#fa-items').innerHTML = items.length ? items.map(i => purchaseRow(i.p, i.k)).join('')
    : `<li>${emptyBlock('Fatura sem compras', 'As compras do cartão entram aqui.')}</li>`;

  const inst = state.acct.card.purchases.filter(p => p.n > 1).sort((a, b) => b.ts - a.ts);
  $('#fa-installments').innerHTML = inst.length ? inst.map(p => {
    const done = clamp(monthDiff(p.firstKey, openKey()), 0, p.n);
    return `<li class="tx"><span class="tx__ic tx__ic--out">${ic(p.kind === 'refi' ? 'refresh' : 'bag')}</span>
      <span class="tx__main"><b>${esc(p.merchant)}</b><small>${done} de ${p.n} parcelas fechadas</small></span>
      <span class="tx__val"><b>${esc(money(installmentAmount(p, 0)))}</b><small>por mês</small></span></li>`;
  }).join('') : `<li>${emptyBlock('Sem compras parceladas', 'Compras em 2x ou mais aparecem aqui.')}</li>`;

  const past = pastInvoiceKeys();
  $('#fa-history').innerHTML = past.length ? past.map(k => {
    const s = invoiceStatus(k);
    const o = invoiceOutstanding(k);
    return `<li class="tx"><span class="tx__ic">${ic('statement')}</span>
      <span class="tx__main"><b>${esc(monthLabel(k))}</b><small>Venceu em ${fmtDate(dueDate(k))}</small></span>
      <span class="tx__val"><b>${esc(money(invoiceTotal(k)))}</b><small><span class="status ${s.cls}">${s.label}</span></small></span></li>${o > 0.004 ? `<li class="hint" style="padding:0 4px 8px"><button type="button" class="btn-link" data-action="invoice-pay-key" data-arg="${k}">Pagar ${esc(money(o))}</button></li>` : ''}`;
  }).join('') : `<li>${emptyBlock('Sem faturas anteriores', 'O histórico começa quando uma fatura fechar.')}</li>`;
}

/* =========================================================
   PAGAMENTOS
   ========================================================= */

function renderPay() {
  if (!state.acct) return;
  $('#pay-cats').innerHTML = PAY_CATS.map(c => `<button type="button" class="cat${state.payCat === c.id ? ' is-active' : ''}" data-cat="${c.id}">${ic(c.icon)}<span>${c.label}</span></button>`).join('');
  const cat = PAY_CATS.find(c => c.id === state.payCat);
  $('#pay-selected').innerHTML = cat ? `Categoria: <b>${esc(cat.label)}</b>` : 'Escolha uma categoria acima.';
  $('#pay-avail').textContent = `Saldo disponível: ${state.hidden ? 'R$ ••••' : money(available())}`;
  const d = $('#pay-date');
  if (!d.value) { const t = new Date(); d.value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; }
  const list = ledgerDesc().filter(e => e.type === 'payment');
  $('#pay-history').innerHTML = list.length ? list.slice(0, 8).map(e => txRow(e, { withDate: true })).join('')
    : `<li>${emptyBlock('Nenhum pagamento ainda', 'Suas contas pagas aparecem aqui.')}</li>`;
}

/* =========================================================
   ANÁLISES
   ========================================================= */

function renderAnalytics() {
  if (!state.acct) return;
  $$('#an-periods .filter').forEach(b => b.classList.toggle('is-active', b.dataset.period === state.period));
  const { buckets, start, end } = periodBuckets(state.period);
  const es = state.acct.ledger.filter(e => e.ts >= start && e.ts <= end);
  const income = es.filter(isIncome).reduce((s, e) => s + e.amount, 0);
  const spendList = es.filter(isSpend);
  const spend = spendList.reduce((s, e) => s + e.amount, 0);
  const invested = es.filter(e => e.type === 'invest').reduce((s, e) => s + e.amount, 0);
  const biggest = spendList.slice().sort((a, b) => b.amount - a.amount)[0];

  setMoney($('#an-in'), income);
  setMoney($('#an-out'), spend);
  setMoney($('#an-invest'), invested);
  setMoney($('#an-max'), biggest ? biggest.amount : 0);
  $('#an-max-sub').textContent = biggest ? entryTitle(biggest) : 'Sem gastos no período';
  $('#an-count').textContent = String(es.length);

  const data = buckets.map(b => {
    const bs = es.filter(e => e.ts >= b.start && e.ts <= b.end);
    return { label: b.label, a: bs.filter(isIncome).reduce((s, e) => s + e.amount, 0), b: bs.filter(isSpend).reduce((s, e) => s + e.amount, 0) };
  });
  const hasData = data.some(d => d.a > 0 || d.b > 0);
  $('#an-bars').innerHTML = hasData ? svgBars(data) : emptyBlock('Sem movimentação no período', 'Escolha outro período ou faça algumas operações.');
  $('#an-bars-legend').innerHTML = hasData ? '<span><i style="background:var(--emerald)"></i>Entradas</span><span><i style="background:var(--red)"></i>Saídas</span>' : '';

  const sum = types => es.filter(e => types.includes(e.type)).reduce((s, e) => s + e.amount, 0);
  const segs = [
    { label: 'Pix enviados', value: sum(['pix_out']), color: 'var(--c3)' },
    { label: 'Transferências', value: sum(['transfer_out']), color: 'var(--c5)' },
    { label: 'Pagamentos', value: sum(['payment']), color: 'var(--c1)' },
    { label: 'Fatura do cartão', value: sum(['card_bill']), color: 'var(--c6)' },
    { label: 'Saques', value: sum(['withdraw']), color: 'var(--c4)' },
    { label: 'Investimentos', value: sum(['invest']), color: 'var(--c2)' },
    { label: 'Outros débitos', value: sum(['debit', 'adjust_out']), color: 'var(--muted-2)' }
  ].filter(s => s.value > 0);
  $('#an-donut').innerHTML = segs.length ? donutBlock(segs, money(segs.reduce((s, x) => s + x.value, 0))) : emptyBlock('Sem saídas no período', 'Quando você gastar ou investir, a divisão aparece aqui.');

  const pixVol = sum(['pix_out', 'pix_in']);
  $('#an-cats').innerHTML = hbarsHtml([
    { label: 'Entradas', value: income, color: 'var(--emerald)' },
    { label: 'Saídas', value: spend, color: 'var(--red)' },
    { label: 'PIX (enviados e recebidos)', value: pixVol, color: 'var(--c3)' },
    { label: 'Pagamentos', value: sum(['payment', 'card_bill']), color: 'var(--c1)' },
    { label: 'Investimentos', value: invested, color: 'var(--c5)' }
  ]);
}

/* =========================================================
   NOTIFICAÇÕES
   ========================================================= */

function renderNotifs() {
  if (!state.acct) return;
  const list = state.acct.notifs;
  $('#nt-list').innerHTML = list.length ? list.map(n => {
    const tone = n.kind === 'in' ? 'in' : (n.kind === 'out' || n.kind === 'alert') ? 'out' : n.kind === 'invest' ? 'inv' : '';
    return `<li><button type="button" class="nt${n.read ? '' : ' is-unread'}" data-action="notif-open" data-arg="${n.id}">
      <span class="tx__ic tx__ic--${tone}">${ic(NOTIF_ICONS[n.kind] || 'info')}</span>
      <span><b>${esc(n.title)}</b><p>${esc(n.msg)}</p></span><small>${esc(relTime(n.ts))}</small></button></li>`;
  }).join('') : `<li>${emptyBlock('Nenhuma notificação', 'Avisos de Pix, pagamentos, investimentos e fatura aparecem aqui.')}</li>`;
}

/* =========================================================
   PERFIL
   ========================================================= */

function renderProfile() {
  const u = me();
  if (!u || !state.acct) return;
  $('#pf-name').textContent = displayName();
  $('#pf-email').textContent = accountEmail();
  $('#pf-cpf').textContent = fakeCpf();
  $('#pf-account').textContent = state.me;
  $('#pf-agency').textContent = CONFIG.agency;
  $('#pf-key').textContent = u.pixKey;
  const pr = state.acct.profile.prefs;
  $('#pref-confirm').checked = !!pr.confirmHigh;
  $('#pref-hide').checked = !!pr.hideBalance;
  $('#pref-notify').checked = !!pr.notify;
  $$('#theme-seg [data-theme-set]').forEach(b => b.classList.toggle('is-active', b.dataset.themeSet === currentThemePref()));
}

/* =========================================================
   ÁREA DE TRANSFERÊNCIA E COMPARTILHAMENTO
   ========================================================= */

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  if (ok) done();
  else toast({ type: 'err', title: 'Não foi possível copiar', msg: text });
}

function copyText(text, okMsg = 'Copiado') {
  const done = () => toast({ type: 'ok', title: okMsg, timeout: 2200 });
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}

async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copyText(text, 'Copiado para compartilhar');
}

/* =========================================================
   FLUXO PADRÃO DE OPERAÇÃO
   confirmar (com identidade se valor alto) > processando > resultado
   ========================================================= */

const needsIdentity = amount => !!(state.acct && state.acct.profile.prefs.confirmHigh && amount >= CONFIG.highValue);

function guardBlocked() {
  if (isBlocked()) {
    errorScreen('Conta bloqueada', 'Sua conta está bloqueada por segurança e não pode fazer operações agora. Peça ajuda ao suporte para liberar.');
    return true;
  }
  return false;
}

function refreshAfterChange() {
  renderShell();
  renderCurrent();
}

async function runTransaction({ title, amount, rows, confirmText = 'Confirmar', identity = false, run, successTitle, receiptTitle, gotoLabel = 'Ver extrato', gotoView = 'extract', gotoTab = null }) {
  const m = openModal();
  const ok = await new Promise(resolve => {
    m.onClose = () => resolve(false);
    m.set(`
      <h2>${esc(title)}</h2>
      <p class="modal__sub">Confira os dados antes de confirmar.</p>
      <p class="amount-big">${esc(money(amount))}</p>
      ${rowsHtml(rows)}
      ${identity ? `<label class="field" style="margin-top:14px"><span>Confirmação de identidade: digite o ID da sua conta</span><input id="idc" type="text" inputmode="numeric" autocomplete="off" placeholder="ID da conta"></label>` : ''}
      <p class="modal__err" data-err role="alert"></p>
      <div class="modal__foot">
        <button type="button" class="btn" data-x>Cancelar</button>
        <button type="button" class="btn btn--primary" data-ok>${esc(confirmText)}</button>
      </div>`);
    $('[data-x]', m.el).addEventListener('click', () => m.close(false));
    $('[data-ok]', m.el).addEventListener('click', () => {
      if (identity) {
        const v = $('#idc', m.el).value.trim();
        if (v !== String(state.me)) { $('[data-err]', m.el).textContent = 'O ID informado não confere com o da sua conta.'; return; }
      }
      resolve(true);
    });
  });
  if (!ok) { m.close(false); return null; }

  m.onClose = null;
  m.dismissible = false;
  m.set('<div class="processing"><div class="spinner"></div><h2>Processando</h2><p>Aguarde só um instante…</p></div>', false);

  const started = Date.now();
  let res;
  try { res = await run(); } catch (err) { res = { ok: false, title: 'Algo deu errado', message: (err && err.message) || 'Erro inesperado.' }; }
  const wait = CONFIG.processingMs - (Date.now() - started);
  if (wait > 0) await sleep(wait);
  m.dismissible = true;

  if (!res || !res.ok) {
    m.set(`
      <div class="result">
        <div class="result__ic result__ic--bad">${ic('x')}</div>
        <h2>${esc((res && res.title) || 'Operação não realizada')}</h2>
        <p class="result__msg">${esc((res && res.message) || 'Tente novamente em instantes.')}</p>
        <div class="modal__foot"><button type="button" class="btn btn--primary" data-x>Entendi</button></div>
      </div>`, false);
    $('[data-x]', m.el).addEventListener('click', () => m.close(null));
    refreshAfterChange();
    return res;
  }

  const entry = res.entry;
  const ts = entry ? entry.ts : Date.now();
  const id = entry ? entry.id : txId();
  const all = [...(res.rows || rows), ['Data e horário', fmtDateTime(ts)], ['ID da transação', id, true]];
  const text = receiptText(receiptTitle || successTitle, all, ts);

  m.set(`
    <div class="result">
      <div class="result__ic result__ic--ok">${ic('check')}</div>
      <h2>${esc(successTitle)}</h2>
      <p class="amount-big">${esc(money(amount))}</p>
      ${rowsHtml(all)}
      <p class="stamp">Comprovante fictício do simulador Áurea. Sem valor financeiro.</p>
      <div class="btn-row btn-row--center">
        <button type="button" class="btn" data-copy>${ic('copy')} Copiar comprovante</button>
        <button type="button" class="btn" data-share>${ic('share')} Compartilhar</button>
      </div>
      <div class="modal__foot modal__foot--stack">
        <button type="button" class="btn btn--primary" data-x>Concluir</button>
        <button type="button" class="btn" data-goto>${esc(gotoLabel)}</button>
      </div>
    </div>`, false);
  $('[data-copy]', m.el).addEventListener('click', () => copyText(text, 'Comprovante copiado'));
  $('[data-share]', m.el).addEventListener('click', () => shareText(receiptTitle || successTitle, text));
  $('[data-x]', m.el).addEventListener('click', () => m.close(null));
  $('[data-goto]', m.el).addEventListener('click', () => { m.close(null); navigate(gotoView, gotoTab ? { tab: gotoTab } : {}); });
  refreshAfterChange();
  return res;
}

/* =========================================================
   PIX E TRANSFERÊNCIA (usam o Pix do servidor)
   ========================================================= */

function sendPixToServer({ targetPixKey, amount }) {
  return new Promise(resolve => {
    const p = { amount, deltaSeen: false, done: false, resolve, timer: null };
    state.pendingPix = p;
    p.timer = setTimeout(() => {
      if (p.done) return;
      p.done = true;
      state.pendingPix = null;
      resolve({ success: false, message: 'O servidor demorou para responder. Confira o extrato antes de tentar de novo.' });
    }, CONFIG.pixTimeoutMs);
    socket.emit('client_send_pix', { senderId: state.me, targetPixKey, amount: amount.toFixed(2) });
  });
}

function mapPixError(message) {
  const msg = String(message || '');
  const l = msg.toLowerCase();
  if (l.includes('saldo')) return { title: 'Saldo insuficiente', message: msg };
  if (l.includes('bloque')) return { title: 'Conta bloqueada', message: msg };
  if (l.includes('exist') || l.includes('encontr') || l.includes('inválid') || l.includes('invalid') || l.includes('chave')) return { title: 'Usuário não encontrado', message: msg };
  return { title: 'Transação recusada', message: msg || 'O servidor recusou a operação.' };
}

function submitOutgoing(kind) {
  if (guardBlocked()) return;
  const isPix = kind === 'pix';
  const typedKey = $('#pix-key').value.trim();
  const typedAcc = $('#tr-account').value.trim();
  const amount = parseMoney($(isPix ? '#pix-amount' : '#tr-amount').value);
  const desc = $(isPix ? '#pix-desc' : '#tr-desc').value.trim();
  const target = isPix ? findByPixKey(typedKey) : findById(typedAcc);

  if (isPix && !typedKey) return errorScreen('Informe a chave Pix', 'Digite a chave Pix de quem vai receber.');
  if (!isPix && !typedAcc) return errorScreen('Informe a conta', 'Digite o número da conta de quem vai receber.');
  if (!Number.isFinite(amount) || amount <= 0) return errorScreen('Valor inválido', 'Informe um valor maior que zero.');
  if (amount > 10000000) return errorScreen('Valor muito alto', 'Esse valor passa do máximo aceito pelo simulador.');
  if (!target) {
    if (!isPix || otherUsersCount() > 0) return errorScreen('Usuário não encontrado', isPix ? 'Não existe nenhum usuário com essa chave Pix.' : 'Não existe nenhuma conta com esse número.');
  }
  if (target && String(target.id) === state.me) return errorScreen('Destinatário inválido', 'Você não pode enviar dinheiro para a sua própria conta.');
  if (amount > available()) return errorScreen('Saldo insuficiente', `Seu saldo disponível é ${money(available())}, menor que ${money(amount)}.`);
  if (amount > serverBalance()) return errorScreen('Saldo insuficiente para Pix', `O saldo da conta principal é ${money(serverBalance())}. Depósitos simulados ficam só neste navegador e ainda não podem ser usados em Pix.`);

  const key = target ? target.pixKey : typedKey;
  const name = target ? target.name : 'Destinatário não identificado';
  const rows = [['Para', name]];
  if (isPix) rows.push(['Chave Pix', key, true]);
  else rows.push(['Conta', `${target.id}, agência ${CONFIG.agency}`]);
  rows.push(['De', `${displayName()}, conta ${state.me}`]);
  if (desc) rows.push(['Descrição', desc]);

  runTransaction({
    title: isPix ? 'Confirmar Pix' : 'Confirmar transferência',
    amount, rows,
    confirmText: isPix ? 'Enviar Pix' : 'Transferir',
    identity: needsIdentity(amount),
    successTitle: isPix ? 'Pix enviado' : 'Transferência realizada',
    receiptTitle: isPix ? 'Pix enviado' : 'Transferência realizada',
    run: async () => {
      const res = await sendPixToServer({ targetPixKey: key, amount });
      if (!res.success) return { ok: false, ...mapPixError(res.message) };
      const after = round2(available() - (res.deltaSeen ? 0 : amount));
      const entry = addLedger({
        type: isPix ? 'pix_out' : 'transfer_out', dir: -1, amount, party: name, desc,
        meta: { key, account: target ? target.id : '' }, balanceAfter: after
      });
      notify({ kind: 'out', title: isPix ? 'Pix enviado' : 'Transferência realizada', msg: `${money(amount)} para ${name}.`, silent: true });
      (isPix ? ['#pix-key', '#pix-amount', '#pix-desc'] : ['#tr-account', '#tr-name', '#tr-amount', '#tr-desc']).forEach(s => { $(s).value = ''; });
      $(isPix ? '#pix-recipient' : '#tr-recipient').hidden = true;
      return { ok: true, entry };
    }
  });
}

/* =========================================================
   DEPÓSITO, SAQUE E PAGAMENTO
   ========================================================= */

async function depositFlow() {
  if (guardBlocked()) return;
  const v = await formModal({
    title: 'Depositar',
    sub: `Depósito simulado: cria saldo fictício neste navegador. Máximo de ${esc(money(CONFIG.depositMax))} por vez.`,
    fields: [{ id: 'amount', label: 'Valor', type: 'money', placeholder: 'R$ 0,00' }],
    validate: x => {
      const a = parseMoney(x.amount);
      if (!(a > 0)) return 'Informe um valor maior que zero.';
      if (a > CONFIG.depositMax) return `O máximo por depósito é ${money(CONFIG.depositMax)}.`;
      return null;
    }
  });
  if (!v) return;
  const amount = parseMoney(v.amount);
  runTransaction({
    title: 'Confirmar depósito', amount,
    rows: [['Origem', 'Depósito simulado'], ['Destino', `Conta ${state.me}, agência ${CONFIG.agency}`]],
    confirmText: 'Depositar', identity: needsIdentity(amount),
    successTitle: 'Depósito realizado', receiptTitle: 'Depósito',
    run: async () => {
      applyAdj(amount);
      const entry = addLedger({ type: 'deposit', dir: 1, amount, party: 'Depósito simulado', desc: 'Saldo fictício adicionado' });
      notify({ kind: 'in', title: 'Depósito realizado', msg: `${money(amount)} adicionados à sua conta.`, silent: true });
      return { ok: true, entry };
    }
  });
}

async function withdrawFlow() {
  if (guardBlocked()) return;
  const v = await formModal({
    title: 'Sacar',
    sub: `Saque simulado. Saldo disponível: ${esc(money(available()))}. Máximo de ${esc(money(CONFIG.withdrawMax))} por vez.`,
    fields: [{ id: 'amount', label: 'Valor', type: 'money', placeholder: 'R$ 0,00' }],
    validate: x => {
      const a = parseMoney(x.amount);
      if (!(a > 0)) return 'Informe um valor maior que zero.';
      if (a > CONFIG.withdrawMax) return `O máximo por saque é ${money(CONFIG.withdrawMax)}.`;
      if (a > available()) return 'Saldo insuficiente para esse saque.';
      return null;
    }
  });
  if (!v) return;
  const amount = parseMoney(v.amount);
  runTransaction({
    title: 'Confirmar saque', amount,
    rows: [['Origem', `Conta ${state.me}, agência ${CONFIG.agency}`], ['Destino', 'Saque simulado']],
    confirmText: 'Sacar', identity: needsIdentity(amount),
    successTitle: 'Saque realizado', receiptTitle: 'Saque',
    run: async () => {
      if (amount > available()) return { ok: false, title: 'Saldo insuficiente', message: 'Seu saldo mudou e não cobre mais esse saque.' };
      applyAdj(-amount);
      const entry = addLedger({ type: 'withdraw', dir: -1, amount, party: 'Saque simulado', desc: 'Retirada de dinheiro fictício' });
      notify({ kind: 'out', title: 'Saque realizado', msg: `${money(amount)} saíram da sua conta.`, silent: true });
      return { ok: true, entry };
    }
  });
}

function submitPayment() {
  if (guardBlocked()) return;
  const cat = PAY_CATS.find(c => c.id === state.payCat);
  if (!cat) return errorScreen('Escolha uma categoria', 'Selecione o tipo de pagamento antes de continuar.');
  const amount = parseMoney($('#pay-amount').value);
  const desc = $('#pay-desc').value.trim() || cat.label;
  const due = $('#pay-date').value;
  if (!Number.isFinite(amount) || amount <= 0) return errorScreen('Valor inválido', 'Informe um valor maior que zero.');
  if (amount > available()) return errorScreen('Saldo insuficiente', `Seu saldo disponível é ${money(available())}, menor que ${money(amount)}.`);
  const dueTxt = due ? due.split('-').reverse().join('/') : fmtDate(Date.now());

  runTransaction({
    title: 'Confirmar pagamento', amount,
    rows: [['Categoria', cat.label], ['Descrição', desc], ['Vencimento', dueTxt], ['Pago com', `Saldo da conta ${state.me}`]],
    confirmText: 'Pagar', identity: needsIdentity(amount),
    successTitle: 'Pagamento realizado', receiptTitle: 'Pagamento',
    run: async () => {
      if (amount > available()) return { ok: false, title: 'Saldo insuficiente', message: 'Seu saldo mudou e não cobre mais esse pagamento.' };
      applyAdj(-amount);
      const entry = addLedger({ type: 'payment', dir: -1, amount, party: cat.label, desc, meta: { category: cat.id, due: dueTxt } });
      notify({ kind: 'pay', title: 'Pagamento realizado', msg: `${money(amount)} em ${cat.label.toLowerCase()}.`, silent: true });
      $('#pay-amount').value = ''; $('#pay-desc').value = '';
      return { ok: true, entry };
    }
  });
}

/* =========================================================
   INVESTIMENTOS
   ========================================================= */

async function investFlow(pid) {
  if (guardBlocked()) return;
  const pr = PRODUCT_BY_ID[pid];
  if (!pr) return;
  const v = await formModal({
    title: `Investir em ${pr.name}`,
    sub: `Taxa fictícia de ${esc(pct(pr.rate))} ao ano. Mínimo de ${esc(money(pr.min))}. Saldo disponível: ${esc(money(available()))}.`,
    fields: [{ id: 'amount', label: 'Quanto investir', type: 'money', placeholder: 'R$ 0,00' }],
    validate: x => {
      const a = parseMoney(x.amount);
      if (!(a > 0)) return 'Informe um valor maior que zero.';
      if (a < pr.min) return `O mínimo para este produto é ${money(pr.min)}.`;
      if (a > available()) return 'Saldo insuficiente para esse investimento.';
      return null;
    }
  });
  if (!v) return;
  const amount = parseMoney(v.amount);
  runTransaction({
    title: 'Confirmar investimento', amount,
    rows: [['Produto', pr.name], ['Taxa (fictícia)', `${pct(pr.rate)} ao ano`], ['Liquidez', pr.liq], ['Saída', `Saldo da conta ${state.me}`]],
    confirmText: 'Investir', identity: needsIdentity(amount),
    successTitle: 'Investimento realizado', receiptTitle: 'Investimento',
    gotoLabel: 'Ver meus investimentos', gotoView: 'invest',
    run: async () => {
      if (amount > available()) return { ok: false, title: 'Saldo insuficiente', message: 'Seu saldo mudou e não cobre mais esse investimento.' };
      applyAdj(-amount);
      createInvestment(pid, amount);
      const entry = addLedger({ type: 'invest', dir: -1, amount, party: pr.name, desc: `Aplicação em ${pr.name}` });
      notify({ kind: 'invest', title: 'Investimento realizado', msg: `${money(amount)} aplicados em ${pr.name}.`, silent: true });
      return { ok: true, entry };
    }
  });
}

async function redeemFlow(id) {
  if (guardBlocked()) return;
  const inv = state.acct.invest.find(i => i.id === id && !i.closed);
  if (!inv) return;
  const pr = PRODUCT_BY_ID[inv.pid];
  const cur = invValue(inv);
  const v = await formModal({
    title: `Resgatar de ${pr.name}`,
    sub: `Valor atual: ${esc(money(cur))}. Deixe o valor cheio para resgatar tudo ou digite uma parte.`,
    fields: [{ id: 'amount', label: 'Quanto resgatar', type: 'money', value: cur.toFixed(2).replace('.', ','), placeholder: 'R$ 0,00' }],
    validate: x => {
      const a = parseMoney(x.amount);
      if (!(a > 0)) return 'Informe um valor maior que zero.';
      if (a > invValue(inv) + 0.005) return 'Esse valor é maior que o saldo do investimento.';
      return null;
    }
  });
  if (!v) return;
  const amount = Math.min(parseMoney(v.amount), invValue(inv));
  runTransaction({
    title: 'Confirmar resgate', amount,
    rows: [['Produto', pr.name], ['Tipo', amount >= invValue(inv) - 0.005 ? 'Resgate total' : 'Resgate parcial'], ['Destino', `Saldo da conta ${state.me}`]],
    confirmText: 'Resgatar', identity: needsIdentity(amount),
    successTitle: 'Resgate realizado', receiptTitle: 'Resgate de investimento',
    run: async () => {
      const { payout } = redeemInvestment(inv, amount);
      applyAdj(payout);
      const entry = addLedger({ type: 'redeem', dir: 1, amount: payout, party: pr.name, desc: `Resgate de ${pr.name}` });
      notify({ kind: 'invest', title: 'Resgate realizado', msg: `${money(payout)} voltaram para o seu saldo.`, silent: true });
      return { ok: true, entry, rows: [['Produto', pr.name], ['Valor resgatado', money(payout)], ['Destino', `Saldo da conta ${state.me}`]] };
    }
  });
}

/* =========================================================
   CARTÕES E FATURA
   ========================================================= */

async function cardToggleBlock() {
  const kind = state.cardSel;
  const c = state.acct.card[kind];
  const label = kind === 'virtual' ? 'virtual' : 'físico';
  const ok = await confirmDialog({
    title: c.blocked ? `Desbloquear cartão ${label}?` : `Bloquear cartão ${label}?`,
    message: c.blocked ? 'O cartão volta a aceitar compras simuladas.' : 'Enquanto estiver bloqueado, nenhuma compra simulada será aprovada.',
    confirm: c.blocked ? 'Desbloquear' : 'Bloquear', danger: !c.blocked
  });
  if (!ok) return;
  c.blocked = !c.blocked;
  persist();
  notify({ kind: 'card', title: c.blocked ? 'Cartão bloqueado' : 'Cartão desbloqueado', msg: `Seu cartão ${label} final ${c.last4} foi ${c.blocked ? 'bloqueado' : 'desbloqueado'}.` });
  renderCurrent();
}

async function cardLimitFlow() {
  const used = cardUsed();
  const v = await formModal({
    title: 'Alterar limite',
    sub: `Limite atual: ${esc(money(state.acct.card.limit))}. Em uso: ${esc(money(used))}. Escolha entre ${esc(money(CONFIG.cardLimitMin))} e ${esc(money(CONFIG.cardLimitMax))}.`,
    fields: [{ id: 'limit', label: 'Novo limite', type: 'money', value: String(state.acct.card.limit).replace('.', ','), placeholder: 'R$ 0,00' }],
    validate: x => {
      const a = parseMoney(x.limit);
      if (!Number.isFinite(a)) return 'Informe um valor válido.';
      if (a < CONFIG.cardLimitMin || a > CONFIG.cardLimitMax) return `O limite deve ficar entre ${money(CONFIG.cardLimitMin)} e ${money(CONFIG.cardLimitMax)}.`;
      if (a < used) return `O limite não pode ser menor que o valor em uso (${money(used)}).`;
      return null;
    }
  });
  if (!v) return;
  const limit = parseMoney(v.limit);
  state.acct.card.limit = limit;
  persist();
  notify({ kind: 'card', title: 'Limite alterado', msg: `Seu novo limite é ${money(limit)}.` });
  renderCurrent();
}

async function cardNewVirtual() {
  const ok = await confirmDialog({
    title: 'Gerar novo cartão virtual?',
    message: 'O cartão virtual atual deixa de valer e um novo número fictício é criado. As compras já feitas continuam na fatura.',
    confirm: 'Gerar novo cartão'
  });
  if (!ok) return;
  state.acct.card.virtual = newCardFace();
  state.cardSel = 'virtual';
  state.cardFlipped = false;
  state.cvvShown = false;
  persist();
  notify({ kind: 'card', title: 'Novo cartão virtual', msg: `Cartão virtual final ${state.acct.card.virtual.last4} criado.` });
  renderCurrent();
}

async function cardPurchaseFlow() {
  const c = state.acct.card;
  const v = await formModal({
    title: 'Simular compra no cartão',
    sub: `Limite disponível: ${esc(money(cardAvailable()))}. A compra entra na fatura, e o saldo só muda quando você pagar a fatura.`,
    fields: [
      { id: 'card', label: 'Cartão', type: 'select', value: state.cardSel, options: [{ v: 'virtual', l: `Virtual final ${c.virtual.last4}` }, { v: 'physical', l: `Físico final ${c.physical.last4}` }] },
      { id: 'merchant', label: 'Loja', value: 'Loja Exemplo', placeholder: 'Nome da loja', max: 40 },
      { id: 'amount', label: 'Valor', type: 'money', placeholder: 'R$ 0,00' },
      { id: 'n', label: 'Parcelas', type: 'select', value: '1', options: Array.from({ length: 12 }, (_, i) => ({ v: i + 1, l: i === 0 ? 'À vista' : `${i + 1}x sem juros` })) }
    ],
    validate: x => {
      const a = parseMoney(x.amount);
      if (!x.merchant) return 'Informe o nome da loja.';
      if (!(a > 0)) return 'Informe um valor maior que zero.';
      return null;
    }
  });
  if (!v) return;
  const amount = parseMoney(v.amount);
  const n = parseInt(v.n, 10) || 1;
  const face = c[v.card];
  if (face.blocked) return errorScreen('Cartão bloqueado', 'Esse cartão está bloqueado. Desbloqueie para aprovar compras.');
  if (amount > cardAvailable()) return errorScreen('Limite insuficiente', `O limite disponível é ${money(cardAvailable())}, menor que ${money(amount)}.`);

  runTransaction({
    title: 'Confirmar compra', amount,
    rows: [['Loja', v.merchant], ['Cartão', `${v.card === 'virtual' ? 'Virtual' : 'Físico'} final ${face.last4}`], ['Parcelas', n === 1 ? 'À vista' : `${n}x de ${money(Math.floor(amount / n * 100) / 100)}`], ['Entra na fatura de', monthLabel(openKey())]],
    confirmText: 'Comprar', identity: needsIdentity(amount),
    successTitle: 'Compra aprovada', receiptTitle: 'Compra no cartão',
    gotoLabel: 'Ver fatura', gotoView: 'cards', gotoTab: 'invoice',
    run: async () => {
      if (amount > cardAvailable()) return { ok: false, title: 'Limite insuficiente', message: 'O limite mudou e não cobre mais essa compra.' };
      c.purchases.push({ id: uid(), merchant: v.merchant, total: amount, n, ts: Date.now(), firstKey: openKey(), kind: 'purchase', card: v.card });
      persist();
      notify({ kind: 'card', title: 'Compra aprovada', msg: `${money(amount)} em ${v.merchant}${n > 1 ? `, em ${n}x` : ''}.`, silent: true });
      return { ok: true };
    }
  });
}

function invoicePayFlow(key) {
  if (guardBlocked()) return;
  const out = invoiceOutstanding(key);
  if (out <= 0.004) return noticeModal({ tone: 'info', title: 'Nada a pagar', message: `A fatura de ${monthLabel(key)} não tem valor em aberto.` });
  if (out > available()) return errorScreen('Saldo insuficiente', `A fatura é de ${money(out)} e seu saldo disponível é ${money(available())}. Você pode parcelar a fatura.`);
  runTransaction({
    title: 'Pagar fatura', amount: out,
    rows: [['Fatura', monthLabel(key)], ['Vencimento', fmtDate(dueDate(key))], ['Pago com', `Saldo da conta ${state.me}`]],
    confirmText: 'Pagar fatura', identity: needsIdentity(out),
    successTitle: 'Fatura paga', receiptTitle: 'Pagamento de fatura',
    gotoLabel: 'Ver fatura', gotoView: 'cards', gotoTab: 'invoice',
    run: async () => {
      if (out > available()) return { ok: false, title: 'Saldo insuficiente', message: 'Seu saldo mudou e não cobre mais a fatura.' };
      applyAdj(-out);
      state.acct.card.payments.push({ id: uid(), key, amount: out, ts: Date.now(), method: 'saldo' });
      const entry = addLedger({ type: 'card_bill', dir: -1, amount: out, party: `Fatura de ${monthLabel(key)}`, desc: 'Pagamento da fatura do cartão', meta: { key } });
      notify({ kind: 'card', title: 'Fatura paga', msg: `Você pagou ${money(out)} da fatura de ${monthLabel(key)}.`, silent: true });
      return { ok: true, entry };
    }
  });
}

async function invoiceSplitFlow() {
  if (guardBlocked()) return;
  const key = overdueKey() || openKey();
  const out = invoiceOutstanding(key);
  if (out <= 0.004) return noticeModal({ tone: 'info', title: 'Nada para parcelar', message: 'A fatura não tem valor em aberto.' });
  const i = CONFIG.refiRate;
  const plan = n => { const pmt = out * i / (1 - Math.pow(1 + i, -n)); return { pmt: round2(pmt), total: round2(pmt * n) }; };
  const v = await formModal({
    title: 'Parcelar fatura',
    sub: `Fatura de ${esc(monthLabel(key))}: ${esc(money(out))}. Juros fictícios de ${esc(pct(i * 100))} ao mês.`,
    fields: [{ id: 'n', label: 'Em quantas parcelas', type: 'select', value: '3', options: [2, 3, 6, 12].map(n => ({ v: n, l: `${n}x de ${money(plan(n).pmt)} (total ${money(plan(n).total)})` })) }],
    submit: 'Continuar'
  });
  if (!v) return;
  const n = parseInt(v.n, 10);
  const pl = plan(n);
  runTransaction({
    title: 'Confirmar parcelamento', amount: out,
    rows: [['Fatura', monthLabel(key)], ['Valor parcelado', money(out)], ['Parcelas', `${n}x de ${money(pl.pmt)}`], ['Total com juros', money(pl.total)], ['Primeira parcela em', monthLabel(addMonths(key < openKey() ? openKey() : key, 1))]],
    confirmText: 'Parcelar', successTitle: 'Fatura parcelada', receiptTitle: 'Parcelamento de fatura',
    gotoLabel: 'Ver fatura', gotoView: 'cards', gotoTab: 'invoice',
    run: async () => {
      const c = state.acct.card;
      c.payments.push({ id: uid(), key, amount: out, ts: Date.now(), method: 'parcelamento' });
      c.purchases.push({ id: uid(), merchant: `Parcelamento da fatura de ${monthLabel(key)}`, total: pl.total, n, ts: Date.now(), firstKey: addMonths(key < openKey() ? openKey() : key, 1), kind: 'refi', card: 'virtual' });
      persist();
      notify({ kind: 'card', title: 'Fatura parcelada', msg: `${money(out)} parcelados em ${n}x de ${money(pl.pmt)}.`, silent: true });
      return { ok: true };
    }
  });
}

/* =========================================================
   PERFIL E CHAVES
   ========================================================= */

async function editNameFlow() {
  const v = await formModal({
    title: 'Alterar nome', sub: 'O nome novo aparece no app e nos cartões. O servidor continua usando o nome do cadastro.',
    fields: [{ id: 'name', label: 'Nome de exibição', value: displayName(), max: 40 }],
    validate: x => (x.name.length < 2 ? 'Digite um nome com pelo menos 2 letras.' : null)
  });
  if (!v) return;
  state.acct.profile.displayName = v.name;
  persist();
  toast({ type: 'ok', title: 'Nome atualizado' });
  renderShell();
  renderCurrent();
}

async function editEmailFlow() {
  const v = await formModal({
    title: 'Alterar e-mail', sub: 'Use um e-mail de mentira. Nada é enviado para ele.',
    fields: [{ id: 'email', label: 'E-mail', value: state.acct.profile.email || '', placeholder: 'voce@exemplo.com', max: 60 }],
    validate: x => (x.email && !/^\S+@\S+\.\S+$/.test(x.email) ? 'Digite um e-mail válido.' : null)
  });
  if (!v) return;
  state.acct.profile.email = v.email;
  persist();
  toast({ type: 'ok', title: 'E-mail atualizado' });
  renderCurrent();
}

function readAvatarFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('Escolha um arquivo de imagem.'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('A imagem passa de 8 MB.'));
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Imagem inválida.'));
      img.onload = () => {
        const S = 160;
        const cv = document.createElement('canvas');
        cv.width = S; cv.height = S;
        const side = Math.min(img.width, img.height);
        cv.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
        resolve(cv.toDataURL('image/jpeg', 0.85));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function editAvatarFlow() {
  const cur = state.acct.profile.avatar;
  const m = openModal();
  m.set(`
    <h2>Foto ou avatar</h2>
    <p class="modal__sub">Escolha um avatar ou envie uma foto. Ela fica só neste navegador.</p>
    <div class="avatar-picker">${EMOJIS.map(e => `<button type="button" data-emoji="${e}" class="${cur.type === 'emoji' && cur.value === e ? 'is-active' : ''}" aria-label="Avatar ${e}">${e}</button>`).join('')}</div>
    <input type="file" accept="image/*" id="av-file" hidden>
    <div class="modal__foot modal__foot--stack">
      <button type="button" class="btn" data-upload>${ic('camera')} Enviar uma foto</button>
      <button type="button" class="btn" data-initial>Usar a inicial do nome</button>
      <button type="button" class="btn" data-x>Fechar</button>
    </div>`);
  const apply = av => { state.acct.profile.avatar = av; persist(); renderAvatars(); m.close(null); toast({ type: 'ok', title: 'Avatar atualizado', timeout: 2200 }); };
  $$('[data-emoji]', m.el).forEach(b => b.addEventListener('click', () => apply({ type: 'emoji', value: b.dataset.emoji })));
  $('[data-initial]', m.el).addEventListener('click', () => apply({ type: 'initial' }));
  $('[data-x]', m.el).addEventListener('click', () => m.close(null));
  const file = $('#av-file', m.el);
  $('[data-upload]', m.el).addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    try { apply({ type: 'image', value: await readAvatarFile(file.files[0]) }); }
    catch (err) { toast({ type: 'err', title: 'Não foi possível usar a foto', msg: err.message }); }
  });
}

function makeDemoKey(type) {
  const r = () => Math.floor(Math.random() * 10);
  const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  if (type === 'email') {
    const slug = displayName().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'cliente';
    return { type: 'E-mail fictício', value: `${slug}${r()}${r()}@aurea.sim` };
  }
  if (type === 'phone') return { type: 'Telefone fictício', value: `(00) 9${r()}${r()}${r()}${r()}-${r()}${r()}${r()}${r()}` };
  if (type === 'cpf') return { type: 'CPF fictício', value: `•••.${r()}${r()}${r()}.${r()}${r()}${r()}-••` };
  return { type: 'Chave aleatória', value: `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}` };
}

async function changePasswordFlow() {
  const ok = await confirmDialog({
    title: 'Pedir nova senha?',
    message: 'Enviamos um pedido ao administrador do simulador, que define uma senha nova para a sua conta.',
    confirm: 'Enviar pedido'
  });
  if (ok) socket.emit('client_request_reset', { accountId: state.me });
}

async function resetLocalFlow() {
  const ok = await confirmDialog({
    title: 'Limpar dados locais?',
    message: 'Isso apaga extrato detalhado, notificações, investimentos, cartão, fatura e ajustes desta conta neste navegador. O saldo guardado no servidor não muda. Não dá para desfazer.',
    confirm: 'Limpar tudo', danger: true
  });
  if (!ok) return;
  Store.remove(state.me);
  state.acct = normalizeAccount(null);
  ensureCards();
  state.acct.welcomed = true;
  state.acct.lastServerBalance = serverBalance();
  state.hidden = false;
  persist();
  toast({ type: 'ok', title: 'Dados locais apagados' });
  refreshAfterChange();
}

/* =========================================================
   PAINEL ADMINISTRATIVO
   Mesmos eventos de antes. Agora cada ação pede motivo,
   confirmação e fica registrada (auditoria local).
   ========================================================= */

const AUDIT_KEY = 'aurea:admin-audit';

function loadAudit() { try { return JSON.parse(localStorage.getItem(AUDIT_KEY)) || []; } catch (e) { return []; } }
function saveAudit(list) { try { localStorage.setItem(AUDIT_KEY, JSON.stringify(list.slice(0, 200))); } catch (e) { /* ignora */ } }
function pushAudit(item) { const l = loadAudit(); l.unshift(item); saveAudit(l); return item.id; }
function updateAudit(id, patch) { const l = loadAudit(); const it = l.find(x => x.id === id); if (it) { Object.assign(it, patch); saveAudit(l); } }

function renderAudit() {
  const list = loadAudit();
  $('#adm-audit').innerHTML = list.length
    ? list.map(a => `<li class="${a.status === 'ok' ? 'ok' : a.status === 'bad' ? 'bad' : ''}">[${esc(fmtDate(a.ts))} ${esc(fmtTime(a.ts))}] ${esc(a.action)}, conta ${esc(a.accountId)}. Motivo: ${esc(a.reason)}. ${esc(a.status === 'ok' ? 'Concluída' : a.status === 'bad' ? 'Recusada' : 'Enviada')}${a.message ? `: ${esc(a.message)}` : ''}</li>`).join('')
    : '<li class="is-empty">Nenhuma alteração feita ainda.</li>';
}

function renderAdmin() {
  const users = Object.entries(state.users);
  const totalBal = users.reduce((s, [, u]) => s + (Number(u.balance) || 0), 0);
  const blocked = users.filter(([, u]) => u.isBlocked).length;
  const pixLines = state.history.filter(h => /pix/i.test(h.desc));
  const moved = pixLines.reduce((s, h) => s + (amountsIn(h.desc)[0] || 0), 0);

  $('#adm-stats').innerHTML = `
    <div class="stat"><span>Contas</span><b>${users.length}</b></div>
    <div class="stat"><span>Saldo somado</span><b>${esc(money(totalBal))}</b></div>
    <div class="stat"><span>Contas bloqueadas</span><b>${blocked}</b></div>
    <div class="stat"><span>Movimentações</span><b>${state.history.length}</b></div>
    <div class="stat"><span>Registros de Pix</span><b>${pixLines.length}</b></div>
    <div class="stat"><span>Valor em Pix</span><b>${esc(money(moved))}</b><small>estimado pelo histórico</small></div>`;

  const top = users.slice().sort((a, b) => (Number(b[1].balance) || 0) - (Number(a[1].balance) || 0)).slice(0, 10);
  $('#adm-chart-bal').innerHTML = top.length
    ? svgBars(top.map(([id, u]) => ({ label: `${u.name || id}`.split(' ')[0], a: Number(u.balance) || 0, b: 0 })), { single: true })
    : emptyBlock('Sem contas', 'Nenhuma conta cadastrada ainda.');
  $('#adm-chart-status').innerHTML = users.length
    ? donutBlock([
      { label: 'Ativas', value: users.length - blocked, color: 'var(--emerald)' },
      { label: 'Bloqueadas', value: blocked, color: 'var(--red)' }
    ].filter(s => s.value > 0), `${users.length} contas`, v => `${v}`, 'no sistema')
    : emptyBlock('Sem contas', 'Nenhuma conta cadastrada ainda.');

  $('#adm-users tbody').innerHTML = users.length ? users.map(([id, u]) => `<tr>
      <td class="mono">${esc(id)}</td><td>${esc(u.name || '-')}</td><td class="mono">${esc(u.pixKey || '-')}</td>
      <td class="num">${esc(money(u.balance))}</td>
      <td><span class="status ${u.isBlocked ? 'status--bad' : 'status--ok'}">${u.isBlocked ? 'Bloqueada' : 'Ativa'}</span></td>
      <td><button type="button" class="btn" data-action="adm-pick" data-arg="${esc(id)}">Selecionar</button></td></tr>`).join('')
    : '<tr><td colspan="6"><div class="empty">Nenhuma conta cadastrada.</div></td></tr>';

  const q = state.admSearch.trim().toLowerCase();
  const hist = state.history.filter(h => !q || `${h.date} ${h.desc}`.toLowerCase().includes(q));
  $('#adm-history').innerHTML = hist.length
    ? hist.map(h => `<li>[${esc(h.date)}] ${esc(h.desc)}</li>`).join('')
    : `<li class="is-empty">${state.history.length ? 'Nada encontrado.' : 'Nenhuma movimentação até o momento.'}</li>`;
  renderAudit();
}

async function adminSubmit(kind) {
  let id, reason, event, payload, title, detail, danger = false;
  const reasonOf = sel => $(sel).value.trim();
  const chk = accId => {
    if (!accId) return 'Informe o ID da conta.';
    if (Object.keys(state.users).length && !state.users[accId]) return 'Não existe conta com esse ID.';
    return null;
  };
  let err = null, action = '';

  if (kind === 'balance') {
    id = $('#adm-bal-id').value.trim();
    reason = reasonOf('#adm-bal-reason');
    const v = parseMoney($('#adm-bal-value').value);
    err = chk(id) || (!Number.isFinite(v) || v < 0 ? 'Informe um saldo válido (zero ou mais).' : null);
    if (!err) {
      const u = state.users[id];
      event = 'admin_set_balance';
      payload = { accountId: id, newBalance: v.toFixed(2) };
      title = 'Ajustar saldo';
      action = 'Ajuste de saldo';
      detail = `Conta <b>${esc(id)}</b>${u ? ` (${esc(u.name)})` : ''}: saldo de ${esc(money(u ? u.balance : 0))} para <b>${esc(money(v))}</b>.`;
    }
  } else if (kind === 'pass') {
    id = $('#adm-pass-id').value.trim();
    reason = reasonOf('#adm-pass-reason');
    const pw = $('#adm-pass-value').value.trim();
    err = chk(id) || (!pw ? 'Informe a nova senha.' : null);
    if (!err) {
      event = 'admin_reset_password';
      payload = { accountId: id, newPassword: pw };
      title = 'Redefinir senha';
      action = 'Redefinição de senha';
      detail = `Definir uma nova senha para a conta <b>${esc(id)}</b>.`;
    }
  } else {
    id = $('#adm-block-id').value.trim();
    reason = reasonOf('#adm-block-reason');
    err = chk(id);
    if (!err) {
      const u = state.users[id];
      event = 'admin_toggle_block';
      payload = { accountId: id };
      title = u && u.isBlocked ? 'Desbloquear conta' : 'Bloquear conta';
      action = u && u.isBlocked ? 'Desbloqueio de conta' : 'Bloqueio de conta';
      detail = `${u && u.isBlocked ? 'Desbloquear' : 'Bloquear'} a conta <b>${esc(id)}</b>${u ? ` (${esc(u.name)})` : ''}.`;
      danger = !(u && u.isBlocked);
    }
  }
  if (!err && reason.length < 3) err = 'Escreva o motivo da alteração (mínimo de 3 letras).';
  if (err) return errorScreen('Confira os dados', err);

  const ok = await confirmDialog({
    title,
    message: `${detail}<br><br><b>Motivo:</b> ${esc(reason)}<br><small>Esta ação fica registrada no painel.</small>`,
    confirm: 'Confirmar', danger
  });
  if (!ok) return;

  const auditId = uid();
  pushAudit({ id: auditId, ts: Date.now(), action, accountId: id, reason, status: 'sent', message: '' });
  state.pendingAdmin = auditId;
  socket.emit(event, { ...payload, reason });
  if (kind === 'balance') { $('#adm-bal-value').value = ''; $('#adm-bal-reason').value = ''; }
  else if (kind === 'pass') { $('#adm-pass-value').value = ''; $('#adm-pass-reason').value = ''; }
  else { $('#adm-block-reason').value = ''; }
  renderAudit();
}

function openAdmin() {
  state.adminOpen = true;
  $('#auth-screen').hidden = true;
  $('#app-screen').hidden = true;
  $('#admin-screen').hidden = false;
  window.scrollTo({ top: 0 });
  renderAdmin();
  const s = $('#admin-screen');
  s.classList.remove('enter'); void s.offsetWidth; s.classList.add('enter');
}

function closeAdmin() {
  state.adminOpen = false;
  $('#admin-screen').hidden = true;
  if (state.me) { $('#app-screen').hidden = false; renderCurrent(); }
  else $('#auth-screen').hidden = false;
}

/* =========================================================
   SESSÃO
   ========================================================= */

function setAuthTab(tab) {
  $$('[data-auth-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.authTab === tab));
  $('#login-form').hidden = tab !== 'login';
  $('#register-form').hidden = tab !== 'register';
}

function stopTimers() { state.timers.forEach(clearInterval); state.timers = []; }

function startSession(accountId, resUser, message) {
  state.me = String(accountId);
  state.acct = Store.load(state.me);
  ensureCards();
  if (!state.users[state.me] && resUser) state.users[state.me] = resUser;
  state.hidden = !!state.acct.profile.prefs.hideBalance;
  state.cardSel = 'virtual'; state.cardFlipped = false; state.cvvShown = false; state.payCat = null;
  state.filter = 'all'; state.search = ''; state.period = '30d';
  $('#ex-search').value = '';

  $('#auth-screen').hidden = true;
  $('#admin-screen').hidden = true;
  state.adminOpen = false;
  $('#app-screen').hidden = false;
  try { localStorage.setItem('aurea:lastId', state.me); } catch (e) { /* ignora */ }

  if (!state.acct.welcomed) {
    state.acct.welcomed = true;
    notify({ kind: 'shield', title: 'Bem-vindo à Áurea', msg: 'Este é um banco de simulação. Nada aqui é dinheiro de verdade.', silent: true });
  }
  reconcileBalance();
  checkInvoiceNotifications();
  persist();

  const home = $('#view-home');
  home.classList.add('is-loading');
  setTimeout(() => home.classList.remove('is-loading'), 700);
  setTab('pix', 'send', false);
  setTab('cards', 'card', false);
  navigate('home');
  renderShell();
  toast({ type: 'ok', title: 'Bem-vindo', msg: message || '', timeout: 2800 });

  stopTimers();
  state.timers.push(setInterval(() => {
    if (!state.me || modalStack.length) return;
    if (state.view === 'invest' || state.view === 'home') safeRender();
  }, 5000));
  state.timers.push(setInterval(() => { if (state.me) checkInvoiceNotifications(); }, 3600000));
}

function logout() {
  closeAllModals();
  stopTimers();
  clearTimeout(notifTimer);
  state.me = null; state.acct = null; state.hidden = false; state.pendingPix = null;
  $('#login-id').value = state.lastId || '';
  $('#login-pass').value = '';
  $('#app-screen').hidden = true;
  $('#admin-screen').hidden = true;
  $('#auth-screen').hidden = false;
  setAuthTab('login');
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignora */ }
  window.scrollTo({ top: 0 });
}

function requestPasswordReset() {
  formModal({
    title: 'Recuperar senha', sub: 'Digite o ID da sua conta. O pedido vai para o administrador, que define uma senha nova.',
    fields: [{ id: 'accountId', label: 'ID da conta', value: $('#login-id').value.trim(), placeholder: 'Ex: 101' }],
    submit: 'Enviar ao administrador',
    validate: v => (v.accountId ? null : 'Informe o ID da conta.')
  }).then(v => { if (v) socket.emit('client_request_reset', { accountId: v.accountId }); });
}

function toggleBalance() {
  state.hidden = !state.hidden;
  renderEye();
  renderCurrent();
}

function openMore() {
  const items = [['transfer', 'Transferências', 'transfer'], ['invest', 'Investimentos', 'invest'], ['pay', 'Pagamentos', 'pay'],
    ['analytics', 'Análises', 'chart'], ['notifs', 'Notificações', 'bell'], ['profile', 'Perfil e ajustes', 'user']];
  const m = openModal();
  m.set(`<h2>Mais opções</h2><div class="more-list">
    ${items.map(([v, l, i]) => `<button type="button" class="nav__item" data-nav="${v}">${ic(i)}<span>${l}</span>${v === 'notifs' ? '<b class="badge" data-notif-badge hidden>0</b>' : ''}</button>`).join('')}
    <button type="button" class="nav__item" data-action="deposit" data-close>${ic('deposit')}<span>Depositar</span></button>
    <button type="button" class="nav__item" data-action="withdraw" data-close>${ic('withdraw')}<span>Sacar</span></button>
    <button type="button" class="nav__item nav__item--quiet" data-action="logout">${ic('logout')}<span>Sair</span></button>
  </div>`, false);
  updateBadges();
}

/* =========================================================
   AÇÕES (data-action)
   ========================================================= */

const ACTIONS = {
  'toggle-theme': () => setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'),
  'forgot': requestPasswordReset,
  'open-admin': openAdmin,
  'close-admin': closeAdmin,
  'toggle-balance': toggleBalance,
  'logout': logout,
  'deposit': depositFlow,
  'withdraw': withdrawFlow,
  'more': openMore,
  'copy-key': () => { if (me()) copyText(me().pixKey, 'Chave Pix copiada'); },
  'share-key': () => { if (me()) shareText('Minha chave Pix na Áurea', `Chave Pix no simulador Áurea: ${me().pixKey}`); },
  'key-copy': arg => copyText(arg, 'Chave copiada'),
  'key-remove': arg => { state.acct.keys = state.acct.keys.filter(k => k.id !== arg); persist(); renderPix(); toast({ type: 'info', title: 'Chave removida', timeout: 2200 }); },
  'tx-detail': arg => showTxDetail(arg),
  'invest': arg => investFlow(arg),
  'inv-detail': arg => showInvestDetail(arg),
  'inv-redeem': arg => redeemFlow(arg),
  'card-toggle-block': cardToggleBlock,
  'card-limit': cardLimitFlow,
  'card-invoice': () => setTab('cards', 'invoice'),
  'card-new-virtual': cardNewVirtual,
  'card-purchase': cardPurchaseFlow,
  'card-flip': () => { state.cardFlipped = !state.cardFlipped; const f = $('.cc-flip'); if (f) f.classList.toggle('is-flipped', state.cardFlipped); },
  'cvv-toggle': () => {
    state.cvvShown = !state.cvvShown;
    const c = state.acct.card[state.cardSel];
    const s = $('.cc--back .cc__cvv');
    if (s) { s.querySelector('span').textContent = `CVV ${state.cvvShown ? c.cvv : '•••'}`; s.querySelector('button').textContent = state.cvvShown ? 'Ocultar' : 'Mostrar'; }
  },
  'invoice-pay': () => invoicePayFlow(overdueKey() || openKey()),
  'invoice-pay-key': arg => invoicePayFlow(arg),
  'invoice-split': invoiceSplitFlow,
  'notifs-read-all': () => { state.acct.notifs.forEach(n => { n.read = true; }); persist(); updateBadges(); renderNotifs(); },
  'notif-open': arg => {
    const n = state.acct.notifs.find(x => x.id === arg);
    if (!n) return;
    n.read = true; persist(); updateBadges();
    const go = { in: ['extract'], out: ['extract'], pay: ['extract'], invest: ['invest'], card: ['cards', 'invoice'] }[n.kind];
    if (go) navigate(go[0], go[1] ? { tab: go[1] } : {}); else renderNotifs();
  },
  'edit-avatar': editAvatarFlow,
  'edit-name': editNameFlow,
  'edit-email': editEmailFlow,
  'change-password': changePasswordFlow,
  'reset-local': resetLocalFlow,
  'adm-pick': arg => { ['#adm-bal-id', '#adm-pass-id', '#adm-block-id'].forEach(s => { $(s).value = arg; }); toast({ type: 'info', title: `Conta ${arg} selecionada`, timeout: 1800 }); }
};

document.addEventListener('click', e => {
  const t = e.target;
  if (!t.closest) return;
  let el = t.closest('[data-action]');
  if (el) {
    const fn = ACTIONS[el.dataset.action];
    if (fn) { e.preventDefault(); if (el.hasAttribute('data-close')) closeAllModals(); fn(el.dataset.arg, el, e); }
    return;
  }
  if ((el = t.closest('[data-nav]'))) { closeAllModals(); navigate(el.dataset.nav); return; }
  if ((el = t.closest('.tabs[data-tabgroup] [data-tab]'))) { setTab(el.closest('.tabs').dataset.tabgroup, el.dataset.tab); return; }
  if ((el = t.closest('[data-auth-tab]'))) { setAuthTab(el.dataset.authTab); return; }
  if ((el = t.closest('#ex-filters [data-filter]'))) { state.filter = el.dataset.filter; renderExtract(); applyMask(); return; }
  if ((el = t.closest('#an-periods [data-period]'))) { state.period = el.dataset.period; el.closest('.view').classList.add('enter'); renderAnalytics(); applyMask(); setTimeout(() => el.closest('.view').classList.remove('enter'), 700); return; }
  if ((el = t.closest('[data-amt]'))) {
    const target = $(`#${el.closest('[data-amount-chips]').dataset.amountChips}`);
    if (target) { target.value = String(el.dataset.amt).replace('.', ','); target.focus(); }
    return;
  }
  if ((el = t.closest('#card-switch [data-card]'))) { state.cardSel = el.dataset.card; state.cardFlipped = false; state.cvvShown = false; renderCards(); applyMask(); return; }
  if ((el = t.closest('#theme-seg [data-theme-set]'))) { setTheme(el.dataset.themeSet); return; }
  if ((el = t.closest('#pay-cats [data-cat]'))) { state.payCat = el.dataset.cat; renderPay(); return; }
});

document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.cc-flip')) { e.preventDefault(); ACTIONS['card-flip'](); }
});

/* Evita perder cliques quando a tela se atualiza no meio do toque */
function releasePointer() {
  clearTimeout(state.pdTimer);
  state.pd = false;
  if (state.dirty) { state.dirty = false; setTimeout(safeRender, 80); }
}
document.addEventListener('pointerdown', () => {
  state.pd = true;
  clearTimeout(state.pdTimer);
  state.pdTimer = setTimeout(releasePointer, 1500); // garantia, caso o "soltar" se perca
}, true);
['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, releasePointer, true));

/* =========================================================
   EVENTOS DO SERVIDOR (Socket.IO)
   ========================================================= */

socket.on('connect', () => { $('#conn-banner').hidden = true; });
socket.on('disconnect', () => { $('#conn-banner').hidden = false; });
socket.on('connect_error', () => { $('#conn-banner').hidden = false; });

socket.on('update_data', payload => {
  const { users, history: hist } = payload || {};
  state.users = users || {};
  state.history = Array.isArray(hist) ? hist : [];
  if (state.me && state.acct) reconcileBalance();
  state.prevHistoryKeys = new Set(state.history.map(hkey));
  safeRender();
});

socket.on('reset_request_response', res => {
  noticeModal({ tone: res.success ? 'info' : 'err', title: res.success ? 'Solicitação enviada' : 'Não foi possível enviar', message: res.message || '' });
});

socket.on('admin_response', res => {
  if (state.pendingAdmin) {
    updateAudit(state.pendingAdmin, { status: res.success ? 'ok' : 'bad', message: res.message || '' });
    state.pendingAdmin = null;
    if (state.adminOpen) renderAudit();
  }
  toast({ type: res.success ? 'ok' : 'err', title: res.success ? 'Feito' : 'Não foi possível concluir', msg: res.message || '' });
});

socket.on('register_response', res => {
  if (res.success) {
    const id = $('#reg-id').value.trim();
    noticeModal({ tone: 'ok', title: 'Conta criada', message: res.message || 'Agora é só entrar com o seu ID e a senha.', button: 'Ir para o login' });
    $('#login-id').value = id;
    ['#reg-id', '#reg-pass', '#reg-name', '#reg-key'].forEach(s => { $(s).value = ''; });
    setAuthTab('login');
  } else {
    noticeModal({ tone: 'err', title: 'Erro no cadastro', message: res.message || 'Não foi possível criar a conta.' });
  }
});

socket.on('login_response', res => {
  if (res.success) startSession(res.accountId, res.user, res.message);
  else noticeModal({ tone: 'err', title: 'Acesso negado', message: res.message || 'ID ou senha incorretos.' });
});

socket.on('pix_response', res => {
  const p = state.pendingPix;
  if (p && !p.done) {
    clearTimeout(p.timer);
    p.done = true;
    if (!res.success) state.pendingPix = null;
    else if (p.deltaSeen) state.pendingPix = null;
    else setTimeout(() => { if (state.pendingPix === p) state.pendingPix = null; }, 5000);
    p.resolve({ ...res, deltaSeen: p.deltaSeen });
  } else {
    toast({ type: res.success ? 'ok' : 'err', title: res.success ? 'Pix realizado' : 'Transação recusada', msg: res.message || '' });
  }
});

/* =========================================================
   INICIALIZAÇÃO
   ========================================================= */

function init() {
  setTheme(currentThemePref());
  try { state.lastId = localStorage.getItem('aurea:lastId') || ''; } catch (e) { state.lastId = ''; }
  $('#login-id').value = state.lastId;
  setAuthTab('login');

  /* Login e cadastro (mesmas regras de antes) */
  $('#login-form').addEventListener('submit', e => {
    e.preventDefault();
    const accountId = $('#login-id').value.trim();
    const password = $('#login-pass').value.trim();
    if (accountId && password) socket.emit('client_login', { accountId, password });
    else toast({ type: 'err', title: 'Atenção', msg: 'Informe seu ID e sua senha.' });
  });
  $('#register-form').addEventListener('submit', e => {
    e.preventDefault();
    const accountId = $('#reg-id').value.trim();
    const password = $('#reg-pass').value.trim();
    const name = $('#reg-name').value.trim();
    const pixKey = $('#reg-key').value.trim();
    if (accountId && password && name && pixKey) socket.emit('client_register', { accountId, password, name, pixKey });
    else toast({ type: 'err', title: 'Atenção', msg: 'Preencha todos os campos.' });
  });

  /* Pix, transferência e pagamento */
  $('#pix-form').addEventListener('submit', e => { e.preventDefault(); submitOutgoing('pix'); });
  $('#transfer-form').addEventListener('submit', e => { e.preventDefault(); submitOutgoing('transfer'); });
  $('#pay-form').addEventListener('submit', e => { e.preventDefault(); submitPayment(); });
  $('#pix-key').addEventListener('input', updatePixRecipient);
  $('#tr-account').addEventListener('input', updateTransferRecipient);

  $('#key-form').addEventListener('submit', e => {
    e.preventDefault();
    if (state.acct.keys.length >= 5) return toast({ type: 'err', title: 'Limite de chaves', msg: 'Você pode ter até 5 chaves de demonstração.' });
    const k = makeDemoKey($('#key-type').value);
    state.acct.keys.push({ id: uid(), ...k });
    persist();
    renderPix();
    toast({ type: 'ok', title: 'Chave criada', msg: 'Ela é só ilustrativa e não recebe Pix.', timeout: 2800 });
  });

  /* Extrato */
  $('#ex-search').addEventListener('input', e => { state.search = e.target.value; renderExtract(); applyMask(); });

  /* Preferências */
  const pref = (sel, key) => $(sel).addEventListener('change', e => { state.acct.profile.prefs[key] = e.target.checked; persist(); });
  pref('#pref-confirm', 'confirmHigh');
  pref('#pref-hide', 'hideBalance');
  pref('#pref-notify', 'notify');

  /* Administração */
  $('#adm-balance-form').addEventListener('submit', e => { e.preventDefault(); adminSubmit('balance'); });
  $('#adm-pass-form').addEventListener('submit', e => { e.preventDefault(); adminSubmit('pass'); });
  $('#adm-block-form').addEventListener('submit', e => { e.preventDefault(); adminSubmit('block'); });
  $('#adm-hist-search').addEventListener('input', e => { state.admSearch = e.target.value; renderAdmin(); });

  if (window.matchMedia) {
    const mq = matchMedia('(prefers-color-scheme: light)');
    const onChange = () => { if (currentThemePref() === 'auto') setTheme('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }
}

init();
