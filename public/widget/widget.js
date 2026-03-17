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
  let viewingImage = null;
  let messages = [];
  let conversationId = null;
  let adminTyping = false;
  let adminTypingTimeout = null;
  let typingDebounceTimeout = null;
  let pendingAttachment = null;
  let pendingAttachmentUrl = null;
  let mobileViewportCleanup = null;
  let originalBodyOverflow = '';
  let originalBodyPosition = '';
  let originalBodyTop = '';
  let originalBodyWidth = '';
  let lockedScrollY = 0;
  let lastKnownViewportHeight = 0;
  const prefersDarkScheme = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

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
        syncConversationIdFromMessages();
        renderMessages();
        if (isOpen) notifyMessagesRead();
      }
    } catch (error) {}
  }

  function syncConversationIdFromMessages() {
    if (conversationId) return;
    const firstWithConversationId = messages.find((msg) => msg?.conversationId);
    if (firstWithConversationId?.conversationId) {
      conversationId = String(firstWithConversationId.conversationId);
    }
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
      if (message?.conversationId) {
        conversationId = String(message.conversationId);
      }
      setAdminTyping(false);

      // De-duplicate by message _id to avoid double rendering
      const incomingId = message && message._id ? String(message._id) : null;
      if (incomingId) {
        const alreadyExists = messages.some((m) => String(m?._id) === incomingId);
        if (alreadyExists) {
          // Optionally update existing message properties (e.g., status)
          messages = messages.map((m) => (String(m?._id) === incomingId ? { ...m, ...message } : m));
          renderMessages();
          return;
        }
      }

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

    socket.on('widget:typing', (data) => {
      if (data?.sender !== 'admin') return;
      if (conversationId && data?.conversationId && data.conversationId !== conversationId) return;
      setAdminTyping(Boolean(data?.isTyping));
    });

  }

  function createWidget() {
    const position = widgetConfig.position || 'right';
    const primaryColor = widgetConfig.primaryColor || '#0084FF';
    const textColor = widgetConfig.textColor || getContrastColor(primaryColor);

    const widgetHTML = `
      <div id="cconehub-widget" class="cconehub-widget cconehub-${position}">
        <div id="cconehub-button" class="cconehub-button">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <span id="cconehub-unread-badge" class="cconehub-badge" style="display: none;">0</span>
        </div>
        
        <div id="cconehub-chat-window" class="cconehub-chat-window" style="display: none;">
          <div class="cconehub-header">
            <div class="cconehub-header-content">
              ${widgetConfig.avatarUrl ? `<img src="${widgetConfig.avatarUrl}" class="cconehub-avatar" alt="Avatar">` : ''}
              <div class="cconehub-header-text">
                <div class="cconehub-title">${widgetConfig.title || 'Chat'}</div>
                <div class="cconehub-subtitle">${widgetConfig.subtitle || 'We\'re here to help'}</div>
              </div>
            </div>
            <button id="cconehub-close" class="cconehub-close-btn">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          
          <div id="cconehub-messages" class="cconehub-messages"></div>
          
          <div id="cconehub-image-preview-overlay" class="cconehub-image-preview-overlay" style="display: none;">
            <div class="cconehub-preview-header">
              <button id="cconehub-preview-close" class="cconehub-preview-close" aria-label="Cerrar">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div class="cconehub-preview-image-container">
              <img id="cconehub-preview-image" src="" alt="Preview" />
            </div>
            <div class="cconehub-preview-input-area">
              <textarea 
                id="cconehub-preview-caption" 
                class="cconehub-preview-caption" 
                placeholder="Añade un mensaje..."
                rows="1"
              ></textarea>
              <button id="cconehub-preview-send" class="cconehub-preview-send-btn">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              </button>
            </div>
          </div>
          
          <div id="cconehub-image-modal" class="cconehub-image-modal" style="display: none;">
            <button id="cconehub-modal-close" class="cconehub-modal-close" aria-label="Cerrar">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
            <img id="cconehub-modal-image" src="" alt="Full size" />
          </div>
          
          <div class="cconehub-input-container">
            <input type="file" id="cconehub-file-input" accept="image/*" style="display: none;" />
            <button id="cconehub-attach-btn" class="cconehub-attach-btn" title="Adjuntar imagen">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
              </svg>
            </button>
            <textarea 
              id="cconehub-input" 
              class="cconehub-input" 
              placeholder="Type your message..."
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              rows="1"
              enterkeyhint="send"
            ></textarea>
            <button id="cconehub-send" class="cconehub-send-btn">
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

  function autoExpandTextarea() {
    const input = document.getElementById('cconehub-input');
    if (!input) return;
    input.style.height = 'auto';
    const maxHeight = parseFloat(getComputedStyle(input).lineHeight) * 6;
    input.style.height = Math.min(input.scrollHeight, maxHeight) + 'px';
  }

  function attachEventListeners() {
    const button = document.getElementById('cconehub-button');
    const closeBtn = document.getElementById('cconehub-close');
    const sendBtn = document.getElementById('cconehub-send');
    const attachBtn = document.getElementById('cconehub-attach-btn');
    const fileInput = document.getElementById('cconehub-file-input');
    const previewCloseBtn = document.getElementById('cconehub-preview-close');
    const previewSendBtn = document.getElementById('cconehub-preview-send');

    button.addEventListener('click', toggleChat);
    closeBtn.addEventListener('click', toggleChat);
    sendBtn.addEventListener('click', sendMessage);
    
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', handleFileSelect);
    }

    if (previewCloseBtn) {
      previewCloseBtn.addEventListener('click', closeImagePreview);
    }

    if (previewSendBtn) {
      previewSendBtn.addEventListener('click', sendImageWithCaption);
    }

    const modalCloseBtn = document.getElementById('cconehub-modal-close');
    if (modalCloseBtn) {
      modalCloseBtn.addEventListener('click', closeImageModal);
    }

    const imageModal = document.getElementById('cconehub-image-modal');
    if (imageModal) {
      imageModal.addEventListener('click', (e) => {
        if (e.target === imageModal) closeImageModal();
      });
    }
    
    const input = document.getElementById('cconehub-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener('input', autoExpandTextarea);
    input.addEventListener('input', () => {
      emitTypingStatus(input.value.trim().length > 0);
      if (isMobileViewport()) {
        window.requestAnimationFrame(scrollToBottom);
      }
    });
    input.addEventListener('focus', () => {
      if (typeof window !== 'undefined' && isMobileViewport()) {
        document.body.classList.add('cconehub-keyboard-active');
        lockBodyScroll(true);
        setTimeout(() => {
          adjustForMobileViewport();
          scrollToBottom();
        }, 220);
      }
    });
    input.addEventListener('blur', () => {
      emitTypingStatus(false);
      if (isMobileViewport()) {
        document.body.classList.remove('cconehub-keyboard-active');
        setTimeout(adjustForMobileViewport, 100);
      }
    });
  }

  function toggleChat() {
    isOpen = !isOpen;
    const chatWindow = document.getElementById('cconehub-chat-window');
    const button = document.getElementById('cconehub-button');
    
    if (isOpen) {
      chatWindow.style.display = 'flex';
      button.style.display = 'none';
      if (isMobileViewport()) lockBodyScroll(true);
      setupMobileViewportBehavior();
      if (!isMobileViewport()) {
        setTimeout(() => {
          const input = document.getElementById('cconehub-input');
          if (input) input.focus({ preventScroll: true });
        }, 120);
      }
      clearUnreadBadge();
      scrollToBottom();
      notifyMessagesRead();
    } else {
      chatWindow.style.display = 'none';
      button.style.display = 'flex';
      setAdminTyping(false);
      document.body.classList.remove('cconehub-keyboard-active');
      if (isMobileViewport()) lockBodyScroll(false);
      teardownMobileViewportBehavior();
    }
  }

  function handleFileSelect(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileInput = document.getElementById('cconehub-file-input');
    const overlay = document.getElementById('cconehub-image-preview-overlay');
    const previewImg = document.getElementById('cconehub-preview-image');
    const captionInput = document.getElementById('cconehub-preview-caption');

    if (pendingAttachmentUrl) {
      try { URL.revokeObjectURL(pendingAttachmentUrl); } catch (e) {}
      pendingAttachmentUrl = null;
    }
    pendingAttachment = file;
    pendingAttachmentUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;

    if (pendingAttachmentUrl && overlay && previewImg) {
      previewImg.src = pendingAttachmentUrl;
      overlay.style.display = 'flex';
      if (captionInput) {
        captionInput.value = '';
        captionInput.focus();
      }
    } else {
      if (pendingAttachmentUrl) { try { URL.revokeObjectURL(pendingAttachmentUrl); } catch(e){} }
      pendingAttachment = null;
      pendingAttachmentUrl = null;
      if (fileInput) fileInput.value = '';
    }
  }

  function closeImagePreview() {
    const overlay = document.getElementById('cconehub-image-preview-overlay');
    const previewImg = document.getElementById('cconehub-preview-image');
    const captionInput = document.getElementById('cconehub-preview-caption');
    const fileInput = document.getElementById('cconehub-file-input');

    if (pendingAttachmentUrl) { try { URL.revokeObjectURL(pendingAttachmentUrl); } catch(e){} pendingAttachmentUrl = null; }
    pendingAttachment = null;
    if (overlay) overlay.style.display = 'none';
    if (previewImg) previewImg.src = '';
    if (captionInput) captionInput.value = '';
    if (fileInput) fileInput.value = '';
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
    autoExpandTextarea({ target: input });

    try {
      const payload = {
        widgetId,
        visitorId,
        message,
        visitorName,
        visitorEmail,
      };

      const response = await fetch(`${apiUrl}/chat-widget/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const raw = await response.json();
        const data = raw?.data || raw;
        if (data?.conversationId) {
          conversationId = String(data.conversationId);
        }
        messages = messages.filter(m => !m._temp);
        if (data?.message) {
          messages.push(data.message);
        }
        emitTypingStatus(false);
        setAdminTyping(false);
        renderMessages();
        scrollToBottom();
      }
    } catch (error) {
      messages = messages.filter(m => !m._temp);
      emitTypingStatus(false);
      renderMessages();
    }
  }

  async function sendImageWithCaption() {
    if (!pendingAttachment) return;

    const captionInput = document.getElementById('cconehub-preview-caption');
    const caption = captionInput ? captionInput.value.trim() : '';
    const visitorName = localStorage.getItem('cconehub_visitor_name');
    const visitorEmail = localStorage.getItem('cconehub_visitor_email');

    // Save reference before closing preview (which clears pendingAttachment)
    const fileToUpload = pendingAttachment;

    const tempMessage = {
      content: caption || '📷 Imagen',
      direction: 'inbound',
      senderName: 'You',
      createdAt: new Date().toISOString(),
      _temp: true,
      type: 'image',
    };

    messages.push(tempMessage);
    closeImagePreview();
    renderMessages();
    scrollToBottom();

    try {
      const fd = new FormData();
      fd.append('file', fileToUpload);
      const upRes = await fetch(`${apiUrl}/upload`, { method: 'POST', body: fd });
      if (!upRes.ok) throw new Error('Upload failed');
      const upData = await upRes.json();
      const fileUrl = upData?.data?.url || upData?.url;

      const payload = {
        widgetId,
        visitorId,
        message: caption || '📷 Imagen',
        visitorName,
        visitorEmail,
        type: 'image',
        media: {
          url: fileUrl,
          mimeType: fileToUpload.type,
          fileName: fileToUpload.name,
          fileSize: fileToUpload.size,
        },
      };

      const response = await fetch(`${apiUrl}/chat-widget/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const raw = await response.json();
        const data = raw?.data || raw;
        if (data?.conversationId) {
          conversationId = String(data.conversationId);
        }
        messages = messages.filter(m => !m._temp);
        if (data?.message) {
          messages.push(data.message);
        }
        emitTypingStatus(false);
        setAdminTyping(false);
        renderMessages();
        scrollToBottom();
      }
    } catch (error) {
      messages = messages.filter(m => !m._temp);
      emitTypingStatus(false);
      renderMessages();
    }
  }

  function setAdminTyping(isTyping) {
    adminTyping = Boolean(isTyping);
    if (adminTypingTimeout) {
      clearTimeout(adminTypingTimeout);
      adminTypingTimeout = null;
    }
    if (adminTyping) {
      adminTypingTimeout = setTimeout(() => {
        adminTyping = false;
        renderMessages();
      }, 2200);
    }
    renderMessages();
    if (adminTyping) scrollToBottom();
  }

  function emitTypingStatus(isTyping) {
    if (!socket || !conversationId) return;
    socket.emit('widget:typing', {
      conversationId,
      isTyping: Boolean(isTyping),
    });
    if (typingDebounceTimeout) {
      clearTimeout(typingDebounceTimeout);
      typingDebounceTimeout = null;
    }
    if (isTyping) {
      typingDebounceTimeout = setTimeout(() => {
        if (socket && conversationId) {
          socket.emit('widget:typing', {
            conversationId,
            isTyping: false,
          });
        }
      }, 900);
    }
  }

  function isMobileViewport() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  }

  function adjustForMobileViewport() {
    if (!isMobileViewport()) return;
    const chatWindow = document.getElementById('cconehub-chat-window');
    if (!chatWindow || !isOpen) return;

    const vv = window.visualViewport;
    const baseHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    if (!lastKnownViewportHeight || baseHeight > lastKnownViewportHeight) {
      lastKnownViewportHeight = baseHeight;
    }

    const viewportHeight = vv?.height || window.innerHeight || baseHeight;
    const viewportOffsetTop = vv?.offsetTop || 0;
    const keyboardHeight = Math.max(0, lastKnownViewportHeight - viewportHeight - viewportOffsetTop);
    const keyboardOpen = keyboardHeight > 100;
    if (keyboardOpen) {
      chatWindow.style.height = `${viewportHeight}px`;
      chatWindow.style.maxHeight = `${viewportHeight}px`;
      chatWindow.style.top = `${viewportOffsetTop}px`;
      chatWindow.style.bottom = 'auto';
      chatWindow.classList.add('cconehub-keyboard-open');
      document.body.classList.add('cconehub-keyboard-active');
      window.requestAnimationFrame(scrollToBottom);
    } else {
      chatWindow.style.height = '';
      chatWindow.style.maxHeight = '';
      chatWindow.style.top = '';
      chatWindow.style.bottom = '';
      chatWindow.classList.remove('cconehub-keyboard-open');
      document.body.classList.remove('cconehub-keyboard-active');
    }
  }

  function setupMobileViewportBehavior() {
    if (!isMobileViewport()) return;
    lastKnownViewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    const onViewportChange = () => adjustForMobileViewport();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onViewportChange);
      window.visualViewport.addEventListener('scroll', onViewportChange);
    }
    window.addEventListener('orientationchange', onViewportChange);
    window.addEventListener('resize', onViewportChange);
    mobileViewportCleanup = () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', onViewportChange);
        window.visualViewport.removeEventListener('scroll', onViewportChange);
      }
      window.removeEventListener('orientationchange', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
      mobileViewportCleanup = null;
    };
    adjustForMobileViewport();
  }

  function teardownMobileViewportBehavior() {
    if (mobileViewportCleanup) mobileViewportCleanup();
    const chatWindow = document.getElementById('cconehub-chat-window');
    if (chatWindow) {
      chatWindow.style.height = '';
      chatWindow.style.maxHeight = '';
      chatWindow.style.top = '';
      chatWindow.style.bottom = '';
      chatWindow.classList.remove('cconehub-keyboard-open');
    }
  }

  function lockBodyScroll(lock) {
    if (!document?.body) return;
    if (lock) {
      lockedScrollY = window.scrollY || window.pageYOffset || 0;
      originalBodyOverflow = document.body.style.overflow;
      originalBodyPosition = document.body.style.position;
      originalBodyTop = document.body.style.top;
      originalBodyWidth = document.body.style.width;
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.top = `-${lockedScrollY}px`;
      document.body.style.width = '100%';
      return;
    }
    document.body.style.overflow = originalBodyOverflow || '';
    document.body.style.position = originalBodyPosition || '';
    document.body.style.top = originalBodyTop || '';
    document.body.style.width = originalBodyWidth || '';
    if (typeof window !== 'undefined') {
      window.scrollTo(0, lockedScrollY);
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

    const messagesHtml = messages.map(msg => {
      const isFromVisitor = msg.direction === 'inbound';
      const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const status = msg.status || 'sent';
      const statusMeta = getMessageStatusMeta(status);
      const isImage = (msg.type === 'image' && msg.media && msg.media.url) || ((msg.media?.mimeType || '').startsWith('image/'));
      const isFile = msg.type === 'file' && msg.media && msg.media.url;
      let contentHtml = '';
      if (isImage) {
        contentHtml = `<img src="${msg.media.url}" alt="${(msg.media.fileName || 'image').replace(/"/g, '&quot;')}" class="cconehub-image" loading="lazy" onclick="viewFullImage('${msg.media.url}')" />`;
        if (msg.content && msg.content !== '📷 Imagen') {
          contentHtml += `<div class="cconehub-message-text cconehub-image-caption">${escapeHtml(msg.content)}</div>`;
        }
      } else if (isFile) {
        contentHtml = `<a href="${msg.media.url}" target="_blank" rel="noopener noreferrer" class="cconehub-file-link">${escapeHtml(msg.content || msg.media.fileName || 'Archivo')}</a>`;
      } else {
        contentHtml = `<div class="cconehub-message-text">${escapeHtml(msg.content)}</div>`;
      }
      
      return `
        <div class="cconehub-message ${isFromVisitor ? 'cconehub-message-outbound' : 'cconehub-message-inbound'}">
          ${!isFromVisitor ? `<div class=\"cconehub-message-sender-label\">${escapeHtml(msg.senderName || 'Support')}</div>` : ''}
          <div class="cconehub-message-wrapper">
            <div class="cconehub-message-content">
              ${contentHtml}
            </div>
            <div class="cconehub-message-meta">
              <span class="cconehub-message-time">${time}</span>
              ${isFromVisitor ? `<span class="cconehub-message-status ${statusMeta.className}">${statusMeta.icon}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    const typingHtml = adminTyping
      ? `
        <div class="cconehub-message cconehub-message-inbound cconehub-typing-row">
          <div class="cconehub-message-wrapper">
            <div class="cconehub-message-content cconehub-typing-bubble">
              <div class="cconehub-typing-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        </div>
      `
      : '';

    container.innerHTML = messagesHtml + typingHtml;
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
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text || '').replace(/[&<>"']/g, m => map[m]);
  }

  window.viewFullImage = function(url) {
    viewingImage = url;
    const modal = document.getElementById('cconehub-image-modal');
    const modalImg = document.getElementById('cconehub-modal-image');
    if (modal && modalImg) {
      modalImg.src = url;
      modal.style.display = 'flex';
    }
  };

  function closeImageModal() {
    viewingImage = null;
    const modal = document.getElementById('cconehub-image-modal');
    if (modal) {
      modal.style.display = 'none';
      const modalImg = document.getElementById('cconehub-modal-image');
      if (modalImg) modalImg.src = '';
    }
  }

  function adjustColorBrightness(color, percent) {
    const num = parseInt(color.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.min(255, (num >> 16) + amt);
    const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
    const B = Math.min(255, (num & 0x0000FF) + amt);
    return '#' + (0x1000000 + (R * 0x10000) + (G * 0x100) + B).toString(16).slice(1);
  }

  function hexToRgb(hex) {
    let c = (hex || '').replace('#', '');
    if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
    const num = parseInt(c, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function hexToRgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex || '#000000');
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function getContrastColor(hex) {
    const { r, g, b } = hexToRgb(hex || '#000000');
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 160 ? '#111827' : '#FFFFFF';
  }

  function encodeColor(hex) {
    return `%23${String(hex || '#000000').replace('#', '')}`;
  }

  function getExplicitThemePreference() {
    const root = document.documentElement;
    const body = document.body;
    const rootTheme = root?.getAttribute('data-theme');
    const bodyTheme = body?.getAttribute('data-theme');

    if (
      root?.classList.contains('dark') ||
      body?.classList.contains('dark') ||
      rootTheme === 'dark' ||
      bodyTheme === 'dark'
    ) {
      return 'dark';
    }

    if (
      root?.classList.contains('light') ||
      body?.classList.contains('light') ||
      rootTheme === 'light' ||
      bodyTheme === 'light'
    ) {
      return 'light';
    }

    return null;
  }

  function shouldUseDarkTheme() {
    const explicitTheme = getExplicitThemePreference();
    if (explicitTheme === 'dark') return true;
    if (explicitTheme === 'light') return false;
    return Boolean(prefersDarkScheme?.matches);
  }

  function applyThemeMode() {
    const widgetRoot = document.getElementById('cconehub-widget');
    if (!widgetRoot) return;

    const isDark = shouldUseDarkTheme();
    widgetRoot.classList.toggle('cconehub-theme-dark', isDark);
  }

  function observeThemeChanges() {
    const observer = new MutationObserver(() => {
      applyThemeMode();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });

    if (document.body) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
      });
    }

    if (prefersDarkScheme) {
      const onThemeChange = () => applyThemeMode();
      if (typeof prefersDarkScheme.addEventListener === 'function') {
        prefersDarkScheme.addEventListener('change', onThemeChange);
      } else if (typeof prefersDarkScheme.addListener === 'function') {
        prefersDarkScheme.addListener(onThemeChange);
      }
    }
  }

  function injectStyles() {
    const primary = widgetConfig.primaryColor || '#0084FF';
    const textOnPrimary = widgetConfig.textColor || getContrastColor(primary);
    const p600 = adjustColorBrightness(primary, -8);
    const p700 = adjustColorBrightness(primary, -15);
    const ring = hexToRgba(primary, 0.12);
    const shadow20 = hexToRgba(primary, 0.2);
    const shadow30 = hexToRgba(primary, 0.3);
    const shadow35 = hexToRgba(primary, 0.35);
    const shadow40 = hexToRgba(primary, 0.4);
    const encodedPrimary = encodeColor(primary);

    const styles = `
      #cconehub-widget {
        --ch-primary: ${primary};
        --ch-primary-600: ${p600};
        --ch-primary-700: ${p700};
        --ch-text-on-primary: ${textOnPrimary};
        --ch-ring: ${ring};
        --ch-shadow-20: ${shadow20};
        --ch-shadow-30: ${shadow30};
        --ch-shadow-35: ${shadow35};
        --ch-shadow-40: ${shadow40};
      }
      .cconehub-widget {
        position: fixed;
        bottom: 20px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      }
      .cconehub-right { right: 20px; }
      .cconehub-left { left: 20px; }
      .cconehub-right .cconehub-chat-window {
        right: 20px;
        left: auto;
      }
      .cconehub-left .cconehub-chat-window {
        left: 20px;
        right: auto;
      }
      
      .cconehub-button {
        width: 64px;
        height: 64px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        background: linear-gradient(135deg, var(--ch-primary) 0%, var(--ch-primary-700) 100%);
        box-shadow: 0 8px 28px var(--ch-shadow-35), 0 4px 12px rgba(0,0,0,0.15);
        transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        position: relative;
        border: none;
        animation: cconehubPulse 2.5s ease-in-out infinite;
        color: var(--ch-text-on-primary);
      }
      
      @keyframes cconehubPulse {
        0% {
          box-shadow: 0 8px 28px var(--ch-shadow-35), 0 4px 12px rgba(0,0,0,0.15), 0 0 0 0 var(--ch-ring);
        }
        100% {
          box-shadow: 0 8px 28px var(--ch-shadow-35), 0 4px 12px rgba(0,0,0,0.15), 0 0 0 16px transparent;
        }
      }
      
      .cconehub-button:hover {
        transform: translateY(-6px) scale(1.08);
        box-shadow: 0 16px 40px var(--ch-shadow-40), 0 8px 16px rgba(0,0,0,0.2);
        animation: none;
      }
      .cconehub-button:active {
        transform: translateY(-3px) scale(1.04);
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
        position: fixed;
        bottom: 100px;
        width: 400px;
        max-width: calc(100vw - 40px);
        height: 680px;
        max-height: 85vh;
        background: #ffffff;
        border-radius: 24px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25), 0 8px 20px rgba(0, 0, 0, 0.15), 0 0 1px rgba(0,0,0,0.1);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 999998;
        animation: slideUpChat 0.45s cubic-bezier(0.16, 1, 0.3, 1);
        overscroll-behavior: contain;
        backdrop-filter: blur(10px);
      }
      
      @keyframes slideUpChat {
        from {
          opacity: 0;
          transform: translateY(40px) scale(0.92);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      
      .cconehub-header {
        padding: 24px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: linear-gradient(135deg, var(--ch-primary) 0%, var(--ch-primary-600) 100%);
        box-shadow: 0 4px 16px rgba(0,0,0,0.12), inset 0 -1px 0 rgba(255,255,255,0.1);
        position: relative;
        color: var(--ch-text-on-primary);
      }
      
      .cconehub-header::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 100%;
        background: linear-gradient(180deg, rgba(255,255,255,0.08) 0%, transparent 100%);
        pointer-events: none;
      }
      
      .cconehub-header-content {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      
      .cconehub-avatar {
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: rgba(255,255,255,0.25);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        color: white;
        font-size: 18px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.3);
        border: 2px solid rgba(255,255,255,0.3);
      }
      
      .cconehub-title {
        font-size: 17px;
        font-weight: 700;
        color: white;
        text-shadow: 0 1px 2px rgba(0,0,0,0.1);
        letter-spacing: -0.2px;
      }
      
      .cconehub-subtitle {
        font-size: 13px;
        color: rgba(255,255,255,0.9);
        margin-top: 3px;
        font-weight: 400;
        text-shadow: 0 1px 2px rgba(0,0,0,0.08);
      }
      
      .cconehub-close-btn {
        background: rgba(255,255,255,0.1);
        border: none;
        color: white;
        font-size: 20px;
        cursor: pointer;
        padding: 8px;
        border-radius: 10px;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        width: 38px;
        height: 38px;
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(10px);
      }
      .cconehub-close-btn:hover { 
        background: rgba(255,255,255,0.25);
        transform: scale(1.05);
      }
      .cconehub-close-btn:active {
        transform: scale(0.95);
      }
      
      .cconehub-messages {
        flex: 1;
        overflow-y: auto;
        padding: 20px 16px;
        background: linear-gradient(to bottom, #f8f9fa 0%, #f0f2f5 100%);
        overscroll-behavior: contain;
        position: relative;
      }
      
      .cconehub-messages::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        opacity: 0.5;
        background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="0 0 360 360"><defs><pattern id="icons" x="0" y="0" width="60" height="60" patternUnits="userSpaceOnUse"><g stroke="%23cbd5e1" stroke-width="1.2" fill="none" opacity="0.5"><rect x="6" y="6" width="16" height="12" rx="2"/><path d="M8 14l4-4 4 4 6-6"/><circle cx="42" cy="12" r="6"/><path d="M38 12h8M42 8v8"/><path d="M8 40l14-6-4 14-3-5-7-3z"/><rect x="36" y="36" width="12" height="10" rx="2"/></g></pattern></defs><rect width="360" height="360" fill="url(%23icons)"/></svg>');
        background-repeat: repeat;
        background-size: 360px 360px;
        pointer-events: none;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-messages::before {
        opacity: 0.42;
        background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="0 0 360 360"><defs><pattern id="icons" x="0" y="0" width="60" height="60" patternUnits="userSpaceOnUse"><g stroke="%234b5563" stroke-width="1.2" fill="none" opacity="0.55"><rect x="6" y="6" width="16" height="12" rx="2"/><path d="M8 14l4-4 4 4 6-6"/><circle cx="42" cy="12" r="6"/><path d="M38 12h8M42 8v8"/><path d="M8 40l14-6-4 14-3-5-7-3z"/><rect x="36" y="36" width="12" height="10" rx="2"/></g></pattern></defs><rect width="360" height="360" fill="url(%23icons)"/></svg>');
        background-repeat: repeat;
        background-size: 360px 360px;
      }
      
      .cconehub-messages::-webkit-scrollbar {
        width: 8px;
      }
      
      .cconehub-messages::-webkit-scrollbar-track {
        background: rgba(0,0,0,0.02);
        border-radius: 10px;
      }
      
      .cconehub-messages::-webkit-scrollbar-thumb {
        background: linear-gradient(180deg, #cbd5e1 0%, #94a3b8 100%);
        border-radius: 10px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      
      .cconehub-messages::-webkit-scrollbar-thumb:hover {
        background: linear-gradient(180deg, #94a3b8 0%, #64748b 100%);
        background-clip: padding-box;
      }
      
      .cconehub-welcome {
        text-align: center;
        padding: 40px 20px;
        color: #666;
      }
      
      .cconehub-message {
        display: flex;
        flex-direction: column;
        margin-bottom: 12px;
        animation: cconehubMessageSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      
      @keyframes fadeInMessage {
        from {
          opacity: 0;
          transform: translateY(12px) scale(0.96);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      
      .cconehub-message-inbound {
        justify-content: flex-start;
        align-items: flex-start;
      }
      
      .cconehub-message-outbound {
        justify-content: flex-end;
        align-items: flex-end;
      }
      
      .cconehub-message-wrapper {
        display: inline-flex;
        flex-direction: column;
        max-width: 75%;
        gap: 3px;
      }
      
      .cconehub-message-content {
        border-radius: 12px;
        word-wrap: break-word;
        overflow-wrap: anywhere;
        word-break: normal;
        position: relative;
        box-shadow: 0 1px 2px rgba(0,0,0,0.08);
        overflow: hidden;
      }

      .cconehub-message-content:has(.cconehub-image) {
        padding: 0;
      }

      .cconehub-message-content:not(:has(.cconehub-image)) {
        padding: 8px 12px;
      }

      .cconehub-typing-row {
        margin-top: -2px;
      }

      .cconehub-typing-bubble {
        min-width: 58px;
        padding: 10px 12px;
      }

      .cconehub-typing-dots {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }

      .cconehub-typing-dots span {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #9ca3af;
        animation: cconehubTypingBounce 1s infinite ease-in-out;
        opacity: 0.65;
      }

      .cconehub-typing-dots span:nth-child(2) {
        animation-delay: 0.15s;
      }

      .cconehub-typing-dots span:nth-child(3) {
        animation-delay: 0.3s;
      }

      @keyframes cconehubTypingBounce {
        0%, 80%, 100% {
          transform: translateY(0) scale(0.9);
          opacity: 0.45;
        }
        40% {
          transform: translateY(-3px) scale(1);
          opacity: 1;
        }
      }
      
      .cconehub-message-outbound .cconehub-message-content {
        background: linear-gradient(135deg, var(--ch-primary) 0%, var(--ch-primary-600) 100%);
        color: white;
        border-bottom-right-radius: 4px;
      }
      
      .cconehub-message-inbound .cconehub-message-content {
        background: #ffffff;
        color: #111827;
        border-bottom-left-radius: 4px;
      }
      
      .cconehub-message-sender-label {
        font-size: 11px;
        font-weight: 600;
        margin-bottom: 2px;
        margin-left: 12px;
        color: #667085;
        opacity: 0.85;
      }

      .cconehub-image {
        max-width: 280px;
        max-height: 350px;
        width: 100%;
        height: auto;
        display: block;
        object-fit: cover;
        cursor: pointer;
        transition: opacity 0.2s ease;
        border-radius: 0;
      }

      .cconehub-image:hover {
        opacity: 0.95;
      }

      .cconehub-image-caption {
        padding: 6px 10px 8px 10px;
        margin: 0;
        font-size: 14.5px;
      }

      .cconehub-file-link {
        color: inherit;
        text-decoration: underline;
        display: inline-block;
      }
      
      .cconehub-message-text {
        font-size: 14.5px;
        line-height: 1.5;
        overflow-wrap: break-word;
        word-break: keep-all;
        hyphens: none;
        white-space: pre-wrap;
        color: inherit;
      }
      .cconehub-message-inbound .cconehub-message-text {
        color: #111827 !important;
      }
      .cconehub-message-outbound .cconehub-message-text { color: var(--ch-text-on-primary) !important; }
      .cconehub-message-meta {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 3px;
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
      
      /* Mobile refinements */
      @media (max-width: 480px) {
        .cconehub-message-wrapper { max-width: 96%; }
        .cconehub-messages { padding-left: 10px; padding-right: 10px; }
      }

      /* WhatsApp-style image preview overlay */
      .cconehub-image-preview-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.95);
        z-index: 1000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: space-between;
      }

      .cconehub-preview-header {
        width: 100%;
        padding: 16px;
        display: flex;
        justify-content: flex-end;
      }

      .cconehub-preview-close {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }

      .cconehub-preview-close:hover {
        background: rgba(255, 255, 255, 0.2);
        transform: scale(1.05);
      }

      .cconehub-preview-image-container {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        width: 100%;
        overflow: hidden;
      }

      .cconehub-preview-image-container img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: 8px;
      }

      .cconehub-preview-input-area {
        width: 100%;
        padding: 16px;
        background: rgba(30, 30, 30, 0.9);
        display: flex;
        gap: 12px;
        align-items: flex-end;
      }

      .cconehub-preview-caption {
        flex: 1;
        padding: 12px 16px;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-radius: 24px;
        font-size: 15px;
        line-height: 1.5;
        color: #fff;
        background: rgba(255, 255, 255, 0.1);
        outline: none;
        resize: none;
        max-height: 120px;
        font-family: inherit;
      }

      .cconehub-preview-caption::placeholder {
        color: rgba(255, 255, 255, 0.5);
      }

      .cconehub-preview-caption:focus {
        border-color: var(--ch-primary);
        background: rgba(255, 255, 255, 0.15);
      }

      .cconehub-preview-send-btn {
        width: 46px;
        height: 46px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, var(--ch-primary) 0%, var(--ch-primary-700) 100%);
        color: var(--ch-text-on-primary);
        box-shadow: 0 4px 12px var(--ch-shadow-30);
        transition: all 0.3s ease;
        flex-shrink: 0;
      }

      .cconehub-preview-send-btn:hover {
        transform: scale(1.08) translateY(-2px);
        box-shadow: 0 6px 16px var(--ch-shadow-40);
      }

      .cconehub-preview-send-btn:active {
        transform: scale(0.98);
      }

      /* Full-size image modal */
      .cconehub-image-modal {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.95);
        z-index: 2000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }

      .cconehub-image-modal img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: 8px;
      }

      .cconehub-modal-close {
        position: absolute;
        top: 16px;
        right: 16px;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        z-index: 2001;
      }

      .cconehub-modal-close:hover {
        background: rgba(255, 255, 255, 0.2);
        transform: scale(1.05);
      }
      
      .cconehub-input-container {
        display: flex;
        padding: 16px;
        background: #ffffff;
        border-top: 1px solid #e5e7eb;
        gap: 12px;
        box-shadow: 0 -6px 20px rgba(0,0,0,0.06), 0 -2px 6px rgba(0,0,0,0.04);
        align-items: flex-end;
      }
      
      .cconehub-input {
        flex: 1;
        padding: 12px 16px;
        border: 2px solid #e5e7eb;
        border-radius: 24px;
        font-size: 15px;
        line-height: 1.5;
        color: #111827;
        background: #f9fafb;
        outline: none;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        resize: none;
        overflow-y: auto;
        max-height: 144px;
        font-family: inherit;
        -webkit-appearance: none;
        appearance: none;
        box-shadow: inset 0 1px 3px rgba(0,0,0,0.04);
        scrollbar-width: none;
      }
      
      .cconehub-input::-webkit-scrollbar {
        display: none;
      }
      .cconehub-input::placeholder {
        color: #9ca3af;
      }
      .cconehub-input:focus {
        border-color: var(--ch-primary);
        background: #ffffff;
        box-shadow: 0 0 0 3px var(--ch-ring), inset 0 1px 3px rgba(0,0,0,0.04);
        transform: translateY(-1px);
      }
      
      .cconehub-attach-btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        background: #f3f4f6;
        color: #6b7280;
        flex-shrink: 0;
      }
      .cconehub-attach-btn:hover {
        background: #e5e7eb;
        color: var(--ch-primary);
        transform: scale(1.05);
      }
      .cconehub-attach-btn:active {
        transform: scale(0.95);
      }
      .cconehub-attach-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      .cconehub-send-btn {
        width: 46px;
        height: 46px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        background: linear-gradient(135deg, var(--ch-primary) 0%, var(--ch-primary-700) 100%);
        box-shadow: 0 4px 12px var(--ch-shadow-30), 0 2px 4px rgba(0,0,0,0.1);
        flex-shrink: 0;
        color: var(--ch-text-on-primary);
      }
      .cconehub-send-btn:hover {
        transform: scale(1.08) translateY(-2px);
        box-shadow: 0 6px 16px var(--ch-shadow-40), 0 3px 6px rgba(0,0,0,0.15);
      }
      .cconehub-send-btn:active {
        transform: scale(0.98);
        box-shadow: 0 2px 8px var(--ch-shadow-20), 0 1px 2px rgba(0,0,0,0.1);
      }
      
      .cconehub-branding {
        padding: 10px;
        text-align: center;
        font-size: 10px;
        color: #9ca3af;
        background: #f9fafb;
        border-top: 1px solid #e5e7eb;
      }

      .cconehub-widget.cconehub-theme-dark .cconehub-chat-window {
          background: #1f2937;
          box-shadow: 0 12px 40px rgba(0,0,0,0.4), 0 4px 12px rgba(0,0,0,0.3);
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-messages {
          background: #0b141a;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-messages::-webkit-scrollbar-thumb {
          background: #4b5563;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-messages::-webkit-scrollbar-thumb:hover {
          background: #6b7280;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-message-outbound .cconehub-message-content {
          background: linear-gradient(135deg, var(--ch-primary-700) 0%, var(--ch-primary-600) 100%);
          color: var(--ch-text-on-primary);
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-message-inbound .cconehub-message-content {
          background: #374151;
          color: #f3f4f6;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-typing-dots span {
          background: #cbd5e1;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-message-inbound .cconehub-message-text {
          color: #f3f4f6 !important;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-message-inbound .cconehub-message-time {
          color: #9ca3af;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-message-sender-label {
          color: #d1d5db;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-input-container {
          background: #1f2937;
          border-top-color: #374151;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-input {
          background: #374151;
          border-color: #4b5563;
          color: #f3f4f6;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-input:focus {
          background: #4b5563;
          border-color: var(--ch-primary);
          box-shadow: 0 0 0 3px var(--ch-ring), inset 0 1px 3px rgba(0,0,0,0.04);
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-input::placeholder {
          color: #9ca3af;
      }
      .cconehub-widget.cconehub-theme-dark .cconehub-branding {
          background: #1f2937;
          border-top-color: #374151;
          color: #6b7280;
      }
      
      @media (max-width: 768px) {
        .cconehub-widget {
          bottom: 0;
          right: 0;
          left: 0;
        }
        
        .cconehub-button {
          position: fixed;
          bottom: max(16px, env(safe-area-inset-bottom));
          right: max(16px, env(safe-area-inset-right));
          width: 56px;
          height: 56px;
        }
        
        .cconehub-chat-window {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          width: 100%;
          height: 100svh;
          max-height: 100svh;
          border-radius: 0;
          margin: 0;
        }

        .cconehub-chat-window.cconehub-keyboard-open {
          border-radius: 0;
        }
        
        .cconehub-header {
          padding: 16px 20px;
          padding-top: max(16px, env(safe-area-inset-top));
        }
        
        .cconehub-messages {
          padding: 14px 10px;
          padding-bottom: max(12px, env(safe-area-inset-bottom));
        }
        
        .cconehub-input-container {
          padding: 12px 10px;
          padding-bottom: max(10px, env(safe-area-inset-bottom));
        }

        .cconehub-chat-window.cconehub-keyboard-open .cconehub-input-container {
          padding-bottom: max(8px, env(safe-area-inset-bottom));
        }
        
        .cconehub-input {
          font-size: 16px;
          padding: 12px 14px;
        }
        
        .cconehub-send-btn {
          width: 44px;
          height: 44px;
          flex-shrink: 0;
        }
        
        .cconehub-message-content {
          max-width: 85%;
        }
        
        .cconehub-avatar {
          width: 40px;
          height: 40px;
        }
        
        .cconehub-title {
          font-size: 15px;
        }
        
        .cconehub-subtitle {
          font-size: 11px;
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
    applyThemeMode();
    observeThemeChanges();
    
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
