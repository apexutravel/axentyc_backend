(function() {
  'use strict';

  const config = window.CconeHubWidget || {};
  const widgetId = config.widgetId;
  const apiUrl = config.apiUrl || 'http://localhost:3001';

  if (!widgetId) {
    return;
  }

  let widgetConfig = null;
  let socket = null;
  let visitorId = getOrCreateVisitorId();
  let isOpen = false;
  let messages = [];

  function getOrCreateVisitorId() {
    let id = localStorage.getItem('cconehub_visitor_id');
    if (!id) {
      id = 'visitor_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('cconehub_visitor_id', id);
    }
    return id;
  }

  async function loadConfig() {
    try {
      const response = await fetch(`${apiUrl}/chat-widget/config/${widgetId}`);
      if (!response.ok) throw new Error('Failed to load widget config');
      const raw = await response.json();
      widgetConfig = raw?.data || raw;
      if (!widgetConfig.enabled) {
        return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  async function loadMessages() {
    try {
      const response = await fetch(
        `${apiUrl}/chat-widget/messages/${widgetId}?visitorId=${visitorId}`
      );
      if (response.ok) {
        const raw = await response.json();
        messages = raw?.data || raw;
        if (!Array.isArray(messages)) messages = [];
        renderMessages();
        if (isOpen) notifyMessagesRead();
      }
    } catch (error) {}
  }

  function notifyMessagesRead() {
    fetch(`${apiUrl}/chat-widget/messages/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widgetId, visitorId }),
    }).catch(() => {});
  }

  function initSocket() {
    const socketUrl = apiUrl.replace('/api/v1', '');
    socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      socket.emit('widget:join', { widgetId, visitorId });
    });

    socket.on('widget:message:new', (message) => {
      messages.push(message);
      renderMessages();
      scrollToBottom();
      playNotificationSound();
      if (isOpen) notifyMessagesRead();
    });

    socket.on('widget:message:status', (data) => {
      messages.forEach(msg => {
        if (msg.direction === 'inbound') {
          msg.status = data.status;
        }
      });
      renderMessages();
    });

  }

  function createWidget() {
    const position = widgetConfig.position || 'right';
    const primaryColor = widgetConfig.primaryColor || '#0084FF';
    const textColor = widgetConfig.textColor || '#FFFFFF';

    const widgetHTML = `
      <div id="cconehub-widget" class="cconehub-widget cconehub-${position}">
        <div id="cconehub-button" class="cconehub-button" style="background-color: ${primaryColor};">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${textColor}" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <span id="cconehub-unread-badge" class="cconehub-badge" style="display: none;">0</span>
        </div>
        
        <div id="cconehub-chat-window" class="cconehub-chat-window" style="display: none;">
          <div class="cconehub-header" style="background-color: ${primaryColor}; color: ${textColor};">
            <div class="cconehub-header-content">
              ${widgetConfig.avatarUrl ? `<img src="${widgetConfig.avatarUrl}" class="cconehub-avatar" alt="Avatar">` : ''}
              <div class="cconehub-header-text">
                <div class="cconehub-title">${widgetConfig.title || 'Chat'}</div>
                <div class="cconehub-subtitle">${widgetConfig.subtitle || 'We\'re here to help'}</div>
              </div>
            </div>
            <button id="cconehub-close" class="cconehub-close-btn" style="color: ${textColor};">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          
          <div id="cconehub-messages" class="cconehub-messages"></div>
          
          <div class="cconehub-input-container">
            <input 
              type="text" 
              id="cconehub-input" 
              class="cconehub-input" 
              placeholder="Type your message..."
              autocomplete="off"
            >
            <button id="cconehub-send" class="cconehub-send-btn" style="background-color: ${primaryColor}; color: ${textColor};">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </div>
          
          ${widgetConfig.showBranding !== false ? `
            <div class="cconehub-branding">
              Powered by <strong>CconeHub</strong>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    const container = document.createElement('div');
    container.innerHTML = widgetHTML;
    document.body.appendChild(container.firstElementChild);

    attachEventListeners();
    loadMessages();
  }

  function attachEventListeners() {
    const button = document.getElementById('cconehub-button');
    const closeBtn = document.getElementById('cconehub-close');
    const sendBtn = document.getElementById('cconehub-send');
    const input = document.getElementById('cconehub-input');

    button.addEventListener('click', toggleChat);
    closeBtn.addEventListener('click', toggleChat);
    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
  }

  function toggleChat() {
    isOpen = !isOpen;
    const chatWindow = document.getElementById('cconehub-chat-window');
    const button = document.getElementById('cconehub-button');
    
    if (isOpen) {
      chatWindow.style.display = 'flex';
      button.style.display = 'none';
      document.getElementById('cconehub-input').focus();
      clearUnreadBadge();
      scrollToBottom();
      notifyMessagesRead();
    } else {
      chatWindow.style.display = 'none';
      button.style.display = 'flex';
    }
  }

  async function sendMessage() {
    const input = document.getElementById('cconehub-input');
    const message = input.value.trim();
    
    if (!message) return;

    const visitorName = localStorage.getItem('cconehub_visitor_name');
    const visitorEmail = localStorage.getItem('cconehub_visitor_email');

    const tempMessage = {
      content: message,
      direction: 'inbound',
      senderName: 'You',
      createdAt: new Date().toISOString(),
      _temp: true,
    };

    messages.push(tempMessage);
    renderMessages();
    scrollToBottom();
    input.value = '';

    try {
      const response = await fetch(`${apiUrl}/chat-widget/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          widgetId,
          visitorId,
          message,
          visitorName,
          visitorEmail,
        }),
      });

      if (response.ok) {
        const raw = await response.json();
        const data = raw?.data || raw;
        messages = messages.filter(m => !m._temp);
        if (data?.message) {
          messages.push(data.message);
        }
        renderMessages();
        scrollToBottom();
      }
    } catch (error) {
      messages = messages.filter(m => !m._temp);
      renderMessages();
    }
  }

  function renderMessages() {
    const container = document.getElementById('cconehub-messages');
    if (!container) return;

    if (messages.length === 0) {
      container.innerHTML = `
        <div class="cconehub-welcome">
          <p>${widgetConfig.welcomeMessage || 'Hello! How can we help you today?'}</p>
        </div>
      `;
      return;
    }

    container.innerHTML = messages.map(msg => {
      const isFromVisitor = msg.direction === 'inbound';
      const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const status = msg.status || 'sent';
      const statusMeta = getMessageStatusMeta(status);
      
      return `
        <div class="cconehub-message ${isFromVisitor ? 'cconehub-message-outbound' : 'cconehub-message-inbound'}">
          <div class="cconehub-message-wrapper">
            <div class="cconehub-message-content">
              ${!isFromVisitor ? `<div class="cconehub-message-sender">${msg.senderName || 'Support'}</div>` : ''}
              <div class="cconehub-message-text">${escapeHtml(msg.content)}</div>
            </div>
            <div class="cconehub-message-meta">
              <span class="cconehub-message-time">${time}</span>
              ${isFromVisitor ? `<span class="cconehub-message-status ${statusMeta.className}">${statusMeta.icon}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function getMessageStatusMeta(status) {
    // 2 palomas azules = leído
    if (status === 'read') return { icon: '<svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor"><path d="M11.766.522A.75.75 0 0 0 10.732.5L6.232 5l-1.982-1.982a.75.75 0 0 0-1.06 1.06l2.5 2.5a.75.75 0 0 0 1.06 0l5-5a.75.75 0 0 0 .016-1.056zm3.5 0a.75.75 0 0 0-1.034-.022l-5 5a.75.75 0 0 0 1.06 1.06l5-5a.75.75 0 0 0-.026-1.038z"/></svg>', className: 'status-read' };
    // 2 palomas grises = entregado
    if (status === 'delivered') return { icon: '<svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor"><path d="M11.766.522A.75.75 0 0 0 10.732.5L6.232 5l-1.982-1.982a.75.75 0 0 0-1.06 1.06l2.5 2.5a.75.75 0 0 0 1.06 0l5-5a.75.75 0 0 0 .016-1.056zm3.5 0a.75.75 0 0 0-1.034-.022l-5 5a.75.75 0 0 0 1.06 1.06l5-5a.75.75 0 0 0-.026-1.038z"/></svg>', className: 'status-delivered' };
    // Reloj para pendiente
    if (status === 'pending') return { icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="6" cy="6" r="5.5" stroke="currentColor" stroke-width="1" fill="none"/><path d="M6 3v3l2 2" stroke="currentColor" stroke-width="1" fill="none"/></svg>', className: 'status-pending' };
    // Exclamación para error
    if (status === 'failed') return { icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="6" cy="6" r="5.5" stroke="currentColor" stroke-width="1" fill="none"/><path d="M6 3v3M6 8h.01"/></svg>', className: 'status-failed' };
    // 1 paloma gris = enviado (default)
    return { icon: '<svg width="12" height="9" viewBox="0 0 12 9" fill="currentColor"><path d="M10.97.97a.75.75 0 0 1 1.06 1.06l-7.5 7.5a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06L4 7.94l6.97-6.97z"/></svg>', className: 'status-sent' };
  }

  function scrollToBottom() {
    const container = document.getElementById('cconehub-messages');
    if (container) {
      setTimeout(() => {
        container.scrollTop = container.scrollHeight;
      }, 100);
    }
  }

  function clearUnreadBadge() {
    const badge = document.getElementById('cconehub-unread-badge');
    if (badge) {
      badge.style.display = 'none';
      badge.textContent = '0';
    }
  }

  function playNotificationSound() {
    if (!isOpen) {
      const badge = document.getElementById('cconehub-unread-badge');
      if (badge) {
        const current = parseInt(badge.textContent) || 0;
        badge.textContent = current + 1;
        badge.style.display = 'block';
      }
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function adjustColorBrightness(color, percent) {
    const num = parseInt(color.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.min(255, (num >> 16) + amt);
    const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
    const B = Math.min(255, (num & 0x0000FF) + amt);
    return '#' + (0x1000000 + (R * 0x10000) + (G * 0x100) + B).toString(16).slice(1);
  }

  function injectStyles() {
    const styles = `
      .cconehub-widget {
        position: fixed;
        bottom: 20px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      }
      .cconehub-right { right: 20px; }
      .cconehub-left { left: 20px; }
      
      .cconehub-button {
        width: 64px;
        height: 64px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0,0,0,0.15), 0 4px 8px rgba(0,0,0,0.1);
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        border: 3px solid rgba(255,255,255,0.2);
      }
      .cconehub-button:hover {
        transform: translateY(-4px) scale(1.05);
        box-shadow: 0 12px 32px rgba(0,0,0,0.2), 0 6px 12px rgba(0,0,0,0.15);
      }
      .cconehub-button:active {
        transform: translateY(-2px) scale(1.02);
      }
      
      .cconehub-badge {
        position: absolute;
        top: -5px;
        right: -5px;
        background: #ff4444;
        color: white;
        border-radius: 10px;
        padding: 2px 6px;
        font-size: 12px;
        font-weight: bold;
        min-width: 20px;
        text-align: center;
      }
      
      .cconehub-chat-window {
        width: 400px;
        height: 650px;
        max-height: calc(100vh - 80px);
        background: #ffffff;
        border-radius: 20px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.15), 0 8px 20px rgba(0,0,0,0.1);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: slideUp 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        border: 1px solid rgba(0,0,0,0.05);
      }
      
      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateY(30px) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      
      .cconehub-header {
        padding: 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: ${widgetConfig.primaryColor || '#0084FF'};
        border-bottom: 2px solid #ffffff;
        box-shadow: 0 1px 0 rgba(255, 255, 255, 0.55);
      }
      
      .cconehub-header-content {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      
      .cconehub-avatar {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: rgba(255,255,255,0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        color: white;
        font-size: 16px;
      }
      
      .cconehub-title {
        font-size: 16px;
        font-weight: 600;
        color: white;
      }
      
      .cconehub-subtitle {
        font-size: 12px;
        color: rgba(255,255,255,0.85);
        margin-top: 2px;
        font-weight: 400;
      }
      
      .cconehub-close-btn {
        background: transparent;
        border: none;
        color: white;
        font-size: 20px;
        cursor: pointer;
        padding: 8px;
        border-radius: 8px;
        transition: all 0.2s ease;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .cconehub-close-btn:hover { 
        background: rgba(255,255,255,0.15);
      }
      
      .cconehub-messages {
        flex: 1;
        overflow-y: auto;
        padding: 20px 16px;
        background: #f0f2f5;
      }
      
      .cconehub-messages::-webkit-scrollbar {
        width: 6px;
      }
      
      .cconehub-messages::-webkit-scrollbar-track {
        background: transparent;
      }
      
      .cconehub-messages::-webkit-scrollbar-thumb {
        background: #d1d5db;
        border-radius: 3px;
      }
      
      .cconehub-messages::-webkit-scrollbar-thumb:hover {
        background: #9ca3af;
      }
      
      .cconehub-welcome {
        text-align: center;
        padding: 40px 20px;
        color: #666;
      }
      
      .cconehub-message {
        margin-bottom: 12px;
        display: flex;
        animation: fadeIn 0.2s ease-out;
      }
      
      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      
      .cconehub-message-inbound {
        justify-content: flex-start;
      }
      
      .cconehub-message-outbound {
        justify-content: flex-end;
      }
      
      .cconehub-message-wrapper {
        display: flex;
        flex-direction: column;
        max-width: 70%;
        gap: 4px;
      }
      
      .cconehub-message-content {
        padding: 8px 12px;
        border-radius: 8px;
        background: white;
        color: #111827;
      }
      
      .cconehub-message-outbound .cconehub-message-content {
        background: ${widgetConfig.primaryColor || '#0084FF'};
        color: white;
        border-bottom-right-radius: 2px;
      }
      
      .cconehub-message-inbound .cconehub-message-content {
        background: #ffffff;
        color: #111827;
        border-bottom-left-radius: 2px;
      }
      
      .cconehub-message-sender {
        font-size: 12px;
        font-weight: 600;
        margin-bottom: 4px;
        color: #666;
      }
      
      .cconehub-message-text {
        font-size: 14px;
        line-height: 1.5;
        word-wrap: break-word;
        color: inherit;
      }
      .cconehub-message-inbound .cconehub-message-text {
        color: #111827 !important;
      }
      .cconehub-message-outbound .cconehub-message-text {
        color: white !important;
      }
      .cconehub-message-meta {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 4px;
      }
      .cconehub-message-inbound .cconehub-message-meta {
        justify-content: flex-start;
      }
      .cconehub-message-outbound .cconehub-message-meta {
        justify-content: flex-end;
      }
      .cconehub-message-time {
        font-size: 11px;
        color: #8696a0;
      }
      .cconehub-message-status {
        font-size: 12px;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        color: #8696a0;
      }
      .cconehub-message-status svg {
        width: 16px;
        height: 16px;
      }
      .cconehub-message-status.status-read {
        color: #53bdeb;
      }
      .cconehub-message-status.status-failed {
        color: #f87171;
      }
      
      .cconehub-input-container {
        display: flex;
        padding: 20px;
        background: #ffffff;
        border-top: 1px solid #e5e7eb;
        gap: 12px;
        box-shadow: 0 -4px 12px rgba(0,0,0,0.03);
      }
      
      .cconehub-input {
        flex: 1;
        padding: 12px 16px;
        border: 1px solid #e5e7eb;
        border-radius: 24px;
        font-size: 14px;
        color: #111827;
        background: #f9fafb;
        outline: none;
        transition: all 0.2s ease;
      }
      .cconehub-input::placeholder {
        color: #9ca3af;
      }
      .cconehub-input:focus {
        border-color: ${widgetConfig.primaryColor || '#0084FF'};
        background: #ffffff;
      }
      
      .cconehub-send-btn {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        background: ${widgetConfig.primaryColor || '#0084FF'};
      }
      .cconehub-send-btn:hover {
        opacity: 0.9;
      }
      .cconehub-send-btn:active {
        transform: scale(0.95);
      }
      
      .cconehub-branding {
        padding: 10px;
        text-align: center;
        font-size: 10px;
        color: #9ca3af;
        background: #f9fafb;
        border-top: 1px solid #e5e7eb;
      }

      @media (prefers-color-scheme: dark) {
        .cconehub-chat-window {
          background: #1f2937;
          box-shadow: 0 12px 40px rgba(0,0,0,0.4), 0 4px 12px rgba(0,0,0,0.3);
        }
        .cconehub-messages {
          background: #0b141a;
          background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><defs><pattern id="pattern-dark" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M0 20 Q10 10 20 20 T40 20" stroke="%23182229" stroke-width="0.5" fill="none" opacity="0.4"/></pattern></defs><rect width="400" height="400" fill="url(%23pattern-dark)"/></svg>');
        }
        .cconehub-messages::-webkit-scrollbar-thumb {
          background: #4b5563;
        }
        .cconehub-messages::-webkit-scrollbar-thumb:hover {
          background: #6b7280;
        }
        .cconehub-message-outbound .cconehub-message-content {
          background: ${adjustColorBrightness(widgetConfig.primaryColor || '#0084FF', -20)};
          color: white;
        }
        .cconehub-message-inbound .cconehub-message-content {
          background: #374151;
          color: #f3f4f6;
        }
        .cconehub-message-inbound .cconehub-message-text {
          color: #f3f4f6 !important;
        }
        .cconehub-message-inbound .cconehub-message-time {
          color: #9ca3af;
        }
        .cconehub-message-sender {
          color: #d1d5db;
        }
        .cconehub-input-container {
          background: #1f2937;
          border-top-color: #374151;
        }
        .cconehub-input {
          background: #374151;
          border-color: #4b5563;
          color: #f3f4f6;
        }
        .cconehub-input:focus {
          background: #4b5563;
          border-color: ${widgetConfig.primaryColor || '#0084FF'};
        }
        .cconehub-input::placeholder {
          color: #9ca3af;
        }
        .cconehub-branding {
          background: #1f2937;
          border-top-color: #374151;
          color: #6b7280;
        }
      }
      
      @media (max-width: 480px) {
        .cconehub-chat-window {
          width: calc(100vw - 40px);
          height: calc(100vh - 40px);
          max-height: calc(100vh - 40px);
        }
      }
      
      ${widgetConfig.customCSS || ''}
    `;

    const styleSheet = document.createElement('style');
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);
  }

  async function init() {
    const loaded = await loadConfig();
    if (!loaded) return;

    injectStyles();
    createWidget();
    
    const socketScript = document.createElement('script');
    socketScript.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
    socketScript.onload = () => {
      initSocket();
    };
    document.head.appendChild(socketScript);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
