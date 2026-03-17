// File upload handler for widget
async function handleFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const fileInput = document.getElementById('cconehub-file-input');
  const attachBtn = document.getElementById('cconehub-attach-btn');
  
  // Show loading state
  if (attachBtn) {
    attachBtn.disabled = true;
    attachBtn.style.opacity = '0.5';
  }

  try {
    const formData = new FormData();
    formData.append('file', file);

    const uploadResponse = await fetch(`${apiUrl}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!uploadResponse.ok) {
      throw new Error('Upload failed');
    }

    const uploadData = await uploadResponse.json();
    const fileUrl = uploadData?.data?.url || uploadData?.url;

    if (!fileUrl) {
      throw new Error('No URL returned from upload');
    }

    // Send message with file
    const isImage = file.type.startsWith('image/');
    const visitorName = localStorage.getItem('cconehub_visitor_name');
    const visitorEmail = localStorage.getItem('cconehub_visitor_email');

    const response = await fetch(`${apiUrl}/chat-widget/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widgetId,
        visitorId,
        message: isImage ? '📷 Imagen' : `📎 ${file.name}`,
        visitorName,
        visitorEmail,
        type: isImage ? 'image' : 'file',
        media: {
          url: fileUrl,
          mimeType: file.type,
          fileName: file.name,
          fileSize: file.size,
        },
      }),
    });

    if (response.ok) {
      const raw = await response.json();
      const data = raw?.data || raw;
      if (data?.conversationId) {
        conversationId = String(data.conversationId);
      }
      if (data?.message) {
        messages.push(data.message);
      }
      renderMessages();
      scrollToBottom();
    }
  } catch (error) {
    console.error('Error uploading file:', error);
    alert('Error al subir el archivo. Por favor intenta de nuevo.');
  } finally {
    // Reset button state
    if (attachBtn) {
      attachBtn.disabled = false;
      attachBtn.style.opacity = '1';
    }
    if (fileInput) {
      fileInput.value = '';
    }
  }
}
