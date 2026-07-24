const socket = io();
let currentUsers = {};
let loggedUserId = null;

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
});

// RESPOSTA: Solicitou recuperação
socket.on('reset_request_response', (res) => {
  Swal.fire({
    icon: res.success ? 'info' : 'error',
    title: res.success ? 'Solicitação Enviada!' : 'Erro',
    text: res.message,
    background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#38bdf8'
  });
});

// RESPOSTA: Resposta ADM Geral
socket.on('admin_response', (res) => {
  Swal.fire({
    icon: res.success ? 'success' : 'error',
    title: res.success ? 'Sucesso ADM' : 'Erro ADM',
    text: res.message,
    background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#22c55e'
  });
});

// RESPOSTA: Cadastro
socket.on('register_response', (res) => {
  if (res.success) {
    Swal.fire({
      icon: 'success', title: 'Sucesso!', text: res.message,
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#22c55e'
    });
    document.getElementById('reg-id').value = '';
    document.getElementById('reg-pass').value = '';
    document.getElementById('reg-name').value = '';
    document.getElementById('reg-key').value = '';
  } else {
    Swal.fire({
      icon: 'error', title: 'Erro no Cadastro', text: res.message,
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#ef4444'
    });
  }
});

// RESPOSTA: Login
socket.on('login_response', (res) => {
  if (res.success) {
    loggedUserId = res.accountId;
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('dashboard-screen').style.display = 'block';
    document.getElementById('welcome-msg').innerText = `Olá, ${res.user.name}`;
    updateUI();

    Swal.fire({
      icon: 'success', title: 'Bem-vindo!', text: res.message,
      toast: true, position: 'top-end', showConfirmButton: false, timer: 3000,
      background: '#1e293b', color: '#f8fafc'
    });
  } else {
    Swal.fire({
      icon: 'error', title: 'Acesso Negado', text: res.message,
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#ef4444'
    });
  }
});

// RESPOSTA: PIX
socket.on('pix_response', (res) => {
  if (res.success) {
    Swal.fire({
      icon: 'success', title: 'PIX Realizado!', text: res.message,
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#22c55e'
    });
    document.getElementById('pix-target').value = '';
    document.getElementById('pix-amount').value = '';
  } else {
    Swal.fire({
      icon: 'error', title: 'Transação Recusada', text: res.message,
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#ef4444'
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
      icon: 'warning', title: 'Atenção', text: 'Informe seu ID e Senha!',
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#f59e0b'
    });
  }
}

// CLIENTE: Pedir recuperação de senha
function requestPasswordReset() {
  Swal.fire({
    title: 'Recuperar Senha',
    input: 'text',
    inputLabel: 'Digite o ID da sua conta:',
    inputPlaceholder: 'ex: 101',
    showCancelButton: true,
    confirmButtonText: 'Enviar para o ADM',
    cancelButtonText: 'Cancelar',
    background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#38bdf8'
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
      icon: 'warning', title: 'Atenção', text: 'Preencha todos os campos!',
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#f59e0b'
    });
  }
}

function logout() {
  loggedUserId = null;
  document.getElementById('login-id').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('dashboard-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'block';
}

function updateUI() {
  if (!loggedUserId || !currentUsers[loggedUserId]) return;

  const user = currentUsers[loggedUserId];
  const balanceEl = document.getElementById('client-balance');
  const keyEl = document.getElementById('client-pix-key');
  const cardEl = document.getElementById('balance-card');
  const badgeEl = document.getElementById('block-badge');

  if (balanceEl) balanceEl.innerText = `R$ ${user.balance.toFixed(2)}`;
  if (keyEl) keyEl.innerText = `Chave PIX: ${user.pixKey}`;

  if (user.isBlocked) {
    if (cardEl) cardEl.classList.add('blocked');
    if (badgeEl) badgeEl.style.display = 'block';
  } else {
    if (cardEl) cardEl.classList.remove('blocked');
    if (badgeEl) badgeEl.style.display = 'none';
  }
}

function sendPix() {
  if (!loggedUserId) return;

  const targetPixKey = document.getElementById('pix-target').value.trim();
  const amount = document.getElementById('pix-amount').value;

  if (targetPixKey && amount) {
    socket.emit('client_send_pix', { senderId: loggedUserId, targetPixKey, amount });
  } else {
    Swal.fire({
      icon: 'warning', title: 'Dados Incompletos', text: 'Informe a chave PIX e o valor!',
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#f59e0b'
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
      icon: 'warning', title: 'Atenção', text: 'Informe o ID da conta e a nova senha!',
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#f59e0b'
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
      icon: 'warning', title: 'Atenção', text: 'Preencha ID e novo saldo!',
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#f59e0b'
    });
  }
}

function toggleBlock() {
  const accountId = document.getElementById('adm-acc-id').value.trim();
  if (accountId) {
    socket.emit('admin_toggle_block', { accountId });
  } else {
    Swal.fire({
      icon: 'warning', title: 'Atenção', text: 'Digite o ID da conta!',
      background: '#1e293b', color: '#f8fafc', confirmButtonColor: '#f59e0b'
    });
  }
}