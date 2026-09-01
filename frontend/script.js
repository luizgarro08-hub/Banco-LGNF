const socket = io();
let currentUsers = {};
let loggedUserId = null;
let balanceHidden = false;
let lastBalanceValue = 0;

const SWAL_BG = '#10192b';
const SWAL_TEXT = '#f1f3f8';
const SWAL_GOLD = '#c9a24b';
const SWAL_EMERALD = '#2fa875';
const SWAL_RED = '#d65c55';

// ATUALIZAÇÃO GERAL
socket.on('update_data', ({ users, history }) => {
  currentUsers = users;
  updateUI();

  const historyEl = document.getElementById('admin-history');
  if (historyEl) {
    historyEl.innerHTML = '';
    if (history.length === 0) {
      historyEl.innerHTML = '<li>Nenhuma movimentação até o momento.</li>';
    } else {
      history.forEach(item => {
        const li = document.createElement('li');
        li.innerText = `[${item.date}] ${item.desc}`;
        historyEl.appendChild(li);
      });
    }
  }

  const clientHistoryEl = document.getElementById('client-extract');
  if (clientHistoryEl) {
    clientHistoryEl.innerHTML = '';
    if (history.length === 0) {
      clientHistoryEl.innerHTML = '<li>Nenhuma movimentação ainda.</li>';
    } else {
      history.forEach(item => {
        const li = document.createElement('li');
        li.innerText = `[${item.date}] ${item.desc}`;
        clientHistoryEl.appendChild(li);
      });
    }
  }
});

// RESPOSTA: Solicitou recuperação
socket.on('reset_request_response', (res) => {
  Swal.fire({
    icon: res.success ? 'info' : 'error',
    title: res.success ? 'Solicitação enviada' : 'Erro',
    text: res.message,
    background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
  });
});

// RESPOSTA: Resposta ADM Geral
socket.on('admin_response', (res) => {
  Swal.fire({
    icon: res.success ? 'success' : 'error',
    title: res.success ? 'Sucesso' : 'Erro',
    text: res.message,
    background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: res.success ? SWAL_EMERALD : SWAL_RED
  });
});

// RESPOSTA: Cadastro
socket.on('register_response', (res) => {
  if (res.success) {
    Swal.fire({
      icon: 'success', title: 'Conta criada', text: res.message,
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_EMERALD
    });
    document.getElementById('reg-id').value = '';
    document.getElementById('reg-pass').value = '';
    document.getElementById('reg-name').value = '';
    document.getElementById('reg-key').value = '';
  } else {
    Swal.fire({
      icon: 'error', title: 'Erro no cadastro', text: res.message,
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_RED
    });
  }
});

// RESPOSTA: Login
socket.on('login_response', (res) => {
  if (res.success) {
    loggedUserId = res.accountId;
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('dashboard-screen').style.display = 'block';

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
    document.getElementById('welcome-msg').innerText = `${greeting}, ${res.user.name}`;

    const dateEl = document.getElementById('today-date');
    if (dateEl) {
      dateEl.innerText = new Date().toLocaleDateString('pt-BR', {
        weekday: 'long', day: 'numeric', month: 'long'
      });
    }

    balanceHidden = false;
    updateUI();

    Swal.fire({
      icon: 'success', title: 'Bem-vindo', text: res.message,
      toast: true, position: 'top-end', showConfirmButton: false, timer: 3000,
      background: SWAL_BG, color: SWAL_TEXT
    });
  } else {
    Swal.fire({
      icon: 'error', title: 'Acesso negado', text: res.message,
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_RED
    });
  }
});

// RESPOSTA: PIX
socket.on('pix_response', (res) => {
  if (res.success) {
    Swal.fire({
      icon: 'success', title: 'Pix realizado', text: res.message,
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_EMERALD
    });
    document.getElementById('pix-target').value = '';
    document.getElementById('pix-amount').value = '';
  } else {
    Swal.fire({
      icon: 'error', title: 'Transação recusada', text: res.message,
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_RED
    });
  }
});

// AÇÕES DE LOGIN E CADASTRO
function loginAccount() {
  const accountId = document.getElementById('login-id').value.trim();
  const password = document.getElementById('login-pass').value.trim();

  if (accountId && password) {
    socket.emit('client_login', { accountId, password });
  } else {
    Swal.fire({
      icon: 'warning', title: 'Atenção', text: 'Informe seu ID e senha.',
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
    });
  }
}

// CLIENTE: Pedir recuperação de senha
function requestPasswordReset() {
  Swal.fire({
    title: 'Recuperar senha',
    input: 'text',
    inputLabel: 'Digite o ID da sua conta:',
    inputPlaceholder: 'ex: 101',
    showCancelButton: true,
    confirmButtonText: 'Enviar para o ADM',
    cancelButtonText: 'Cancelar',
    background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
  }).then((result) => {
    if (result.isConfirmed && result.value) {
      socket.emit('client_request_reset', { accountId: result.value.trim() });
    }
  });
}

function registerAccount() {
  const accountId = document.getElementById('reg-id').value.trim();
  const password = document.getElementById('reg-pass').value.trim();
  const name = document.getElementById('reg-name').value.trim();
  const pixKey = document.getElementById('reg-key').value.trim();

  if (accountId && password && name && pixKey) {
    socket.emit('client_register', { accountId, password, name, pixKey });
  } else {
    Swal.fire({
      icon: 'warning', title: 'Atenção', text: 'Preencha todos os campos.',
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
    });
  }
}

function logout() {
  loggedUserId = null;
  balanceHidden = false;
  document.getElementById('login-id').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('dashboard-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'block';
}

function renderBalance() {
  const balanceEl = document.getElementById('client-balance');
  if (!balanceEl) return;
  balanceEl.innerText = balanceHidden ? 'R$ ••••••' : `R$ ${lastBalanceValue.toFixed(2)}`;
}

function toggleBalanceVisibility() {
  balanceHidden = !balanceHidden;
  renderBalance();

  const icon = document.getElementById('eye-icon');
  const btn = document.getElementById('toggle-balance');
  if (icon) {
    icon.innerHTML = balanceHidden
      ? '<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.5 5.1A10.7 10.7 0 0 1 12 5c7 0 10.5 7 10.5 7a13.7 13.7 0 0 1-3.1 4M6.2 6.6C3.7 8.4 1.5 12 1.5 12s3.5 7 10.5 7c1.4 0 2.7-.2 3.9-.7"/>'
      : '<path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/>';
  }
  if (btn) btn.setAttribute('aria-label', balanceHidden ? 'Mostrar saldo' : 'Ocultar saldo');
}

function updateUI() {
  if (!loggedUserId || !currentUsers[loggedUserId]) return;

  const user = currentUsers[loggedUserId];
  const keyEl = document.getElementById('client-pix-key');
  const accountLineEl = document.getElementById('client-account-line');
  const cardEl = document.getElementById('balance-card');
  const badgeEl = document.getElementById('block-badge');

  lastBalanceValue = user.balance;
  renderBalance();

  if (keyEl) keyEl.innerText = `Chave Pix: ${user.pixKey}`;
  if (accountLineEl) accountLineEl.innerText = `Conta ${loggedUserId} · Agência 0001`;

  if (user.isBlocked) {
    if (cardEl) cardEl.classList.add('blocked');
    if (badgeEl) badgeEl.style.display = 'block';
  } else {
    if (cardEl) cardEl.classList.remove('blocked');
    if (badgeEl) badgeEl.style.display = 'none';
  }
}

// AÇÕES RÁPIDAS
function focusPix() {
  const el = document.getElementById('pix-target');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
  }
}

function scrollToExtract() {
  const el = document.getElementById('extrato-anchor');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function copyPixKey() {
  if (!loggedUserId || !currentUsers[loggedUserId]) return;
  const key = currentUsers[loggedUserId].pixKey;

  navigator.clipboard.writeText(key).then(() => {
    Swal.fire({
      icon: 'success', title: 'Chave copiada', text: key,
      toast: true, position: 'top-end', showConfirmButton: false, timer: 2000,
      background: SWAL_BG, color: SWAL_TEXT
    });
  }).catch(() => {
    Swal.fire({
      icon: 'error', title: 'Não foi possível copiar', text: `Copie manualmente: ${key}`,
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
    });
  });
}

function showHelp() {
  Swal.fire({
    icon: 'info',
    title: 'Precisa de ajuda?',
    text: 'Use "Esqueci minha senha" na tela de login ou fale com o suporte informando o ID da sua conta.',
    background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
  });
}

function sendPix() {
  if (!loggedUserId) return;

  const targetPixKey = document.getElementById('pix-target').value.trim();
  const amount = document.getElementById('pix-amount').value;

  if (targetPixKey && amount) {
    socket.emit('client_send_pix', { senderId: loggedUserId, targetPixKey, amount });
  } else {
    Swal.fire({
      icon: 'warning', title: 'Dados incompletos', text: 'Informe a chave Pix e o valor.',
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
    });
  }
}

// ADM: Alterar Senha do Usuário
function resetPasswordByAdmin() {
  const accountId = document.getElementById('adm-reset-id').value.trim();
  const newPassword = document.getElementById('adm-reset-pass').value.trim();

  if (accountId && newPassword) {
    socket.emit('admin_reset_password', { accountId, newPassword });
    document.getElementById('adm-reset-id').value = '';
    document.getElementById('adm-reset-pass').value = '';
  } else {
    Swal.fire({
      icon: 'warning', title: 'Atenção', text: 'Informe o ID da conta e a nova senha.',
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
    });
  }
}

// ADM: Outras Ações
function saveAccount() {
  const accountId = document.getElementById('adm-acc-id').value.trim();
  const newBalance = document.getElementById('adm-acc-balance').value;

  if (accountId && newBalance !== '') {
    socket.emit('admin_set_balance', { accountId, newBalance });
  } else {
    Swal.fire({
      icon: 'warning', title: 'Atenção', text: 'Preencha ID e novo saldo.',
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
    });
  }
}

function toggleBlock() {
  const accountId = document.getElementById('adm-acc-id').value.trim();
  if (accountId) {
    socket.emit('admin_toggle_block', { accountId });
  } else {
    Swal.fire({
      icon: 'warning', title: 'Atenção', text: 'Digite o ID da conta.',
      background: SWAL_BG, color: SWAL_TEXT, confirmButtonColor: SWAL_GOLD
    });
  }
}
