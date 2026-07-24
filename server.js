const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('frontend')); 

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

let users = {};
let history = [];

io.on('connection', (socket) => {
  socket.emit('update_data', { users, history });

  // 1. CADASTRO DE CONTA
  socket.on('client_register', ({ accountId, password, name, pixKey }) => {
    if (users[accountId]) {
      socket.emit('register_response', { success: false, message: 'Já existe uma conta com este ID!' });
      return;
    }

    const pixExists = Object.values(users).some(user => user.pixKey === pixKey);
    if (pixExists) {
      socket.emit('register_response', { success: false, message: 'Esta chave PIX já pertence a outra conta!' });
      return;
    }

    users[accountId] = { password, name, pixKey, balance: 0, isBlocked: false };

    history.unshift({
      date: new Date().toLocaleTimeString(),
      desc: `🎉 Nova conta cadastrada: ${name} (ID: ${accountId})`
    });

    socket.emit('register_response', { success: true, message: 'Conta criada com sucesso! Faça login.' });
    io.emit('update_data', { users, history });
  });

  // 2. LOGIN
  socket.on('client_login', ({ accountId, password }) => {
    const user = users[accountId];
    if (!user) {
      socket.emit('login_response', { success: false, message: 'ID de conta não encontrado!' });
      return;
    }
    if (user.password !== password) {
      socket.emit('login_response', { success: false, message: 'Senha incorreta!' });
      return;
    }

    socket.emit('login_response', { success: true, message: 'Login realizado com sucesso!', accountId, user });
  });

  // 3. SOLICITAR RECUPERAÇÃO DE SENHA (CLIENTE)
  socket.on('client_request_reset', ({ accountId }) => {
    const user = users[accountId];
    if (!user) {
      socket.emit('reset_request_response', { success: false, message: 'ID de conta não encontrado!' });
      return;
    }

    history.unshift({
      date: new Date().toLocaleTimeString(),
      desc: `🔑 SOLICITAÇÃO DE SENHA: ${user.name} (ID: ${accountId}) pediu redefinição!`
    });

    socket.emit('reset_request_response', { 
      success: true, 
      message: 'Solicitação enviada ao ADM! Informe ao suporte para redefinir sua senha.' 
    });

    io.emit('update_data', { users, history });
  });

  // 4. REDEFINIR SENHA (ADM)
  socket.on('admin_reset_password', ({ accountId, newPassword }) => {
    if (users[accountId]) {
      users[accountId].password = newPassword;

      history.unshift({
        date: new Date().toLocaleTimeString(),
        desc: `🔐 SENHA ALTERADA: A senha do ID ${accountId} (${users[accountId].name}) foi redefinida pelo ADM.`
      });

      socket.emit('admin_response', { success: true, message: `Nova senha para ID ${accountId} salva!` });
      io.emit('update_data', { users, history });
    } else {
      socket.emit('admin_response', { success: false, message: 'ID de conta não encontrado!' });
    }
  });

  // 5. ADM: ALTERAR SALDO
  socket.on('admin_set_balance', ({ accountId, newBalance }) => {
    if (users[accountId]) {
      users[accountId].balance = parseFloat(newBalance) || 0;
      history.unshift({
        date: new Date().toLocaleTimeString(),
        desc: `⚙️ Saldo de ${users[accountId].name} ajustado para R$ ${users[accountId].balance.toFixed(2)}`
      });
      io.emit('update_data', { users, history });
    }
  });

  // 6. ADM: BLOQUEAR / DESBLOQUEAR
  socket.on('admin_toggle_block', ({ accountId }) => {
    if (users[accountId]) {
      users[accountId].isBlocked = !users[accountId].isBlocked;
      const status = users[accountId].isBlocked ? '🔒 BLOQUEADO' : '🔓 DESBLOQUEADO';
      history.unshift({
        date: new Date().toLocaleTimeString(),
        desc: `🚨 Status de ${users[accountId].name}: ${status}`
      });
      io.emit('update_data', { users, history });
    }
  });

  // 7. CLIENTE: PIX
  socket.on('client_send_pix', ({ senderId, targetPixKey, amount }) => {
    const val = parseFloat(amount);
    const sender = users[senderId];

    if (!sender) return;
    if (sender.isBlocked) {
      socket.emit('pix_response', { success: false, message: '🚫 Conta bloqueada por segurança!' });
      return;
    }
    if (sender.balance < val || val <= 0) {
      socket.emit('pix_response', { success: false, message: 'Saldo insuficiente ou valor inválido!' });
      return;
    }

    const targetId = Object.keys(users).find(id => users[id].pixKey === targetPixKey);
    if (!targetId) {
      socket.emit('pix_response', { success: false, message: 'Chave PIX não encontrada!' });
      return;
    }
    if (targetId === senderId) {
      socket.emit('pix_response', { success: false, message: 'Não pode transferir para você mesmo!' });
      return;
    }

    users[senderId].balance -= val;
    users[targetId].balance += val;

    history.unshift({
      date: new Date().toLocaleTimeString(),
      desc: `💸 PIX: ${sender.name} enviou R$ ${val.toFixed(2)} para ${users[targetId].name}`
    });

    socket.emit('pix_response', { success: true, message: 'PIX realizado com sucesso!' });
    io.emit('update_data', { users, history });
  });
});

server.listen(3000, '0.0.0.0', () => {
  console.log(`🚀 Banco Servidor Rodando em http://localhost:3000`);
});