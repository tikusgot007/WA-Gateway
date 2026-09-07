(function () {
  'use strict';

  const POLL_STATUS_MS = 2000;
  const POLL_MESSAGES_MS = 3000;
  const POLL_EVENTS_MS = 3000;
  const POLL_CHATS_MS = 3000;
  const POLL_CONVERSATION_MS = 2500;

  let openChatId = null; // chatId (JID asli) dari conversation yang sedang dibuka, null jika tidak ada

  const el = {
    statusBadge: document.getElementById('status-badge'),
    statusNumber: document.getElementById('status-number'),
    statusConnectedAt: document.getElementById('status-connected-at'),
    statusDisconnectedAt: document.getElementById('status-disconnected-at'),
    statusReason: document.getElementById('status-reason'),
    qrContainer: document.getElementById('qr-container'),
    qrImage: document.getElementById('qr-image'),
    btnReconnect: document.getElementById('btn-reconnect'),
    btnLogout: document.getElementById('btn-logout'),
    actionFeedback: document.getElementById('action-feedback'),
    sendForm: document.getElementById('send-form'),
    sendFeedback: document.getElementById('send-feedback'),
    messagesList: document.getElementById('messages-list'),
    eventsList: document.getElementById('events-list'),

    chatList: document.getElementById('chat-list'),
    conversationView: document.getElementById('conversation-view'),
    btnCloseConversation: document.getElementById('btn-close-conversation'),
    convChatId: document.getElementById('conv-chat-id'),
    convJidType: document.getElementById('conv-jid-type'),
    convName: document.getElementById('conv-name'),
    convPhone: document.getElementById('conv-phone'),
    conversationMessages: document.getElementById('conversation-messages'),
    replyForm: document.getElementById('reply-form'),
    replyFeedback: document.getElementById('reply-feedback'),
  };

  function fmtTime(iso) {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleString('id-ID');
    } catch (e) {
      return iso;
    }
  }

  function setFeedback(node, message, type) {
    node.textContent = message;
    node.className = 'feedback' + (type ? ' ' + type : '');
    if (message) {
      setTimeout(() => {
        if (node.textContent === message) {
          node.textContent = '';
          node.className = 'feedback';
        }
      }, 5000);
    }
  }

  async function api(path, options) {
    const res = await fetch('/api' + path, options);
    const body = await res.json().catch(() => ({ ok: false, error: 'Response tidak valid' }));
    if (!res.ok || !body.ok) {
      throw new Error(body.error || `Request gagal (${res.status})`);
    }
    return body.data !== undefined ? body.data : body;
  }

  async function refreshStatus() {
    try {
      const data = await api('/status');
      el.statusBadge.textContent = data.status;
      el.statusBadge.className = 'badge badge-' + data.status;
      el.statusNumber.textContent = data.connectedNumber || '-';
      el.statusConnectedAt.textContent = fmtTime(data.lastConnectedAt);
      el.statusDisconnectedAt.textContent = fmtTime(data.lastDisconnectedAt);
      el.statusReason.textContent = data.lastDisconnectReason || '-';

      if (data.hasQr && data.status !== 'connected') {
        await refreshQr();
        el.qrContainer.classList.remove('hidden');
      } else {
        el.qrContainer.classList.add('hidden');
      }
    } catch (err) {
      el.statusBadge.textContent = 'error';
      el.statusBadge.className = 'badge badge-error';
    }
  }

  async function refreshQr() {
    try {
      const data = await api('/qr');
      if (data.available && data.qrDataUrl) {
        el.qrImage.src = data.qrDataUrl;
      }
    } catch (err) {
      // diamkan, akan dicoba lagi di polling berikutnya
    }
  }

  async function refreshMessages() {
    try {
      const messages = await api('/messages?limit=50');
      if (!messages.length) {
        el.messagesList.innerHTML = '<p class="empty-state">Belum ada pesan masuk.</p>';
        return;
      }
      el.messagesList.innerHTML = messages
        .map((m) => {
          const cls = m.fromMe ? 'from-me' : 'from-customer';
          const identity = m.sender.phone ? escapeHtml(m.sender.phone) : escapeHtml(m.chatId) + ' (@lid, tanpa nomor)';
          const name = m.sender.name ? `${escapeHtml(m.sender.name)} (${identity})` : identity;
          const jidType = m.jidType || 'unknown';
          return `
            <div class="message-item ${cls}">
              <div>${escapeHtml(m.text)} <span class="badge badge-${escapeHtml(jidType)}">${escapeHtml(jidType)}</span></div>
              <div class="meta">
                ${m.fromMe ? 'Dari akun sendiri' : 'Dari: ' + name}
                &middot; ${fmtTime(m.timestamp)}
                &middot; ID: ${escapeHtml(m.messageId || '-')}
              </div>
            </div>`;
        })
        .join('');
    } catch (err) {
      // diamkan
    }
  }

  async function refreshEvents() {
    try {
      const events = await api('/events');
      if (!events.length) {
        el.eventsList.innerHTML = '<p class="empty-state">Belum ada event.</p>';
        return;
      }
      el.eventsList.innerHTML = events
        .slice(0, 100)
        .map((e) => {
          const t = new Date(e.time).toLocaleTimeString('id-ID');
          return `<div class="event-line level-${e.level}">[${t}] ${escapeHtml(e.message)}</div>`;
        })
        .join('');
    } catch (err) {
      // diamkan
    }
  }

  // ------------------------------------------------------------------------
  // Conversations (chat berdasarkan chatId/JID asli, termasuk kasus @lid)
  // ------------------------------------------------------------------------

  async function refreshChatList() {
    try {
      const chats = await api('/chats');
      if (!chats.length) {
        el.chatList.innerHTML = '<p class="empty-state">Belum ada conversation.</p>';
        return;
      }
      el.chatList.innerHTML = chats
        .map((c) => {
          const name = c.name ? escapeHtml(c.name) : '(tanpa nama)';
          const jidType = c.jidType || 'unknown';
          return `
            <div class="chat-item" data-chat-id="${escapeHtml(c.chatId)}">
              <div class="chat-info">
                <div class="chat-name">${name} <span class="badge badge-${escapeHtml(jidType)}">${escapeHtml(jidType)}</span></div>
                <div class="chat-jid">JID: ${escapeHtml(c.chatId)}${c.phone ? ' &middot; Phone: ' + escapeHtml(c.phone) : ''}</div>
                <div class="chat-last">${c.lastFromMe ? 'Anda: ' : ''}${escapeHtml(c.lastMessageText)} &middot; ${fmtTime(c.lastTimestamp)}</div>
              </div>
              <button class="small open-chat-btn" data-chat-id="${escapeHtml(c.chatId)}">Buka Chat</button>
            </div>`;
        })
        .join('');

      el.chatList.querySelectorAll('.open-chat-btn').forEach((btn) => {
        btn.addEventListener('click', () => openConversation(btn.dataset.chatId));
      });
    } catch (err) {
      // diamkan, coba lagi di polling berikutnya
    }
  }

  async function openConversation(chatId) {
    openChatId = chatId;
    el.conversationView.classList.remove('hidden');
    el.convChatId.textContent = chatId;
    const jidType = classifyJidClient(chatId);
    el.convJidType.textContent = jidType;
    el.convJidType.className = 'badge badge-' + jidType;
    await refreshConversationMessages();
    el.conversationView.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeConversation() {
    openChatId = null;
    el.conversationView.classList.add('hidden');
  }

  // Klasifikasi ringan di sisi client HANYA untuk keperluan tampilan badge
  // (server tetap sumber kebenaran; ini tidak dipakai untuk menentukan target kirim).
  function classifyJidClient(jid) {
    if (!jid) return 'unknown';
    if (jid.endsWith('@g.us')) return 'group';
    if (jid.endsWith('@lid')) return 'lid';
    if (jid.endsWith('@s.whatsapp.net')) return 'pn';
    return 'unknown';
  }

  async function refreshConversationMessages() {
    if (!openChatId) return;
    try {
      const messages = await api('/chats/' + encodeURIComponent(openChatId) + '/messages');

      if (messages.length) {
        const last = messages[messages.length - 1];
        el.convName.textContent = (!last.fromMe && last.sender.name) ? last.sender.name : (messages.find(m => !m.fromMe)?.sender?.name || '-');
        const withPhone = messages.find((m) => !m.fromMe && m.sender.phone);
        el.convPhone.textContent = withPhone ? withPhone.sender.phone : 'null (tidak tersedia, ini normal untuk @lid)';
      }

      if (!messages.length) {
        el.conversationMessages.innerHTML = '<p class="empty-state">Belum ada pesan pada conversation ini.</p>';
        return;
      }

      el.conversationMessages.innerHTML = messages
        .map((m) => {
          const cls = m.fromMe ? 'from-me' : 'from-customer';
          return `
            <div class="message-item ${cls}">
              <div>${m.fromMe ? '[outgoing] ' : '[incoming] '}${escapeHtml(m.text)}</div>
              <div class="meta">${fmtTime(m.timestamp)} &middot; ID: ${escapeHtml(m.messageId || '-')}</div>
            </div>`;
        })
        .join('');
    } catch (err) {
      // diamkan
    }
  }

  el.btnCloseConversation.addEventListener('click', closeConversation);

  el.replyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!openChatId) return;
    const textInput = document.getElementById('reply-text');
    const text = textInput.value.trim();
    const submitBtn = el.replyForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const data = await api('/chats/' + encodeURIComponent(openChatId) + '/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      setFeedback(el.replyFeedback, `Balasan terkirim ke chatId ini. Message ID: ${data.messageId || '-'}`, 'success');
      textInput.value = '';
      refreshConversationMessages();
      refreshChatList();
    } catch (err) {
      setFeedback(el.replyFeedback, err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  el.btnReconnect.addEventListener('click', async () => {
    el.btnReconnect.disabled = true;
    try {
      await api('/reconnect', { method: 'POST' });
      setFeedback(el.actionFeedback, 'Reconnect dipicu...', 'success');
    } catch (err) {
      setFeedback(el.actionFeedback, err.message, 'error');
    } finally {
      el.btnReconnect.disabled = false;
    }
  });

  el.btnLogout.addEventListener('click', async () => {
    if (!confirm('Yakin ingin logout/reset session? Anda perlu scan QR ulang.')) return;
    el.btnLogout.disabled = true;
    try {
      await api('/logout', { method: 'POST' });
      setFeedback(el.actionFeedback, 'Logout dipicu, menunggu QR baru...', 'success');
    } catch (err) {
      setFeedback(el.actionFeedback, err.message, 'error');
    } finally {
      el.btnLogout.disabled = false;
    }
  });

  el.sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const to = document.getElementById('to').value.trim();
    const text = document.getElementById('text').value.trim();
    const submitBtn = el.sendForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const data = await api('/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, text }),
      });
      setFeedback(el.sendFeedback, `Pesan terkirim. Message ID: ${data.messageId || '-'}`, 'success');
      el.sendForm.reset();
      refreshMessages();
    } catch (err) {
      setFeedback(el.sendFeedback, err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  refreshStatus();
  refreshMessages();
  refreshEvents();
  refreshChatList();

  setInterval(refreshStatus, POLL_STATUS_MS);
  setInterval(refreshMessages, POLL_MESSAGES_MS);
  setInterval(refreshEvents, POLL_EVENTS_MS);
  setInterval(refreshChatList, POLL_CHATS_MS);
  setInterval(refreshConversationMessages, POLL_CONVERSATION_MS);
})();
