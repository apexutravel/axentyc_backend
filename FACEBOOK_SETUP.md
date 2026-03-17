# Facebook Messenger Integration Setup

Esta guía te ayudará a configurar la integración de Facebook Messenger con CConeHub.

## Requisitos Previos

- Una cuenta de Facebook
- Una página de Facebook (no perfil personal)
- Acceso a [Facebook Developers](https://developers.facebook.com/)

## Paso 1: Crear una App de Facebook

1. Ve a [Facebook Developers](https://developers.facebook.com/)
2. Haz clic en **"My Apps"** → **"Create App"**
3. Selecciona **"Business"** como tipo de app
4. Completa los datos:
   - **App Name**: CConeHub (o el nombre que prefieras)
   - **App Contact Email**: Tu email
5. Haz clic en **"Create App"**

## Paso 2: Agregar el Producto Messenger

1. En el dashboard de tu app, busca **"Messenger"** en la lista de productos
2. Haz clic en **"Set Up"**
3. Esto agregará Messenger a tu app

## Paso 3: Configurar Variables de Entorno

Copia las credenciales de tu app y agrégalas al archivo `.env`:

```bash
# Facebook Integration
FACEBOOK_APP_ID=tu-app-id-aqui
FACEBOOK_APP_SECRET=tu-app-secret-aqui
FACEBOOK_VERIFY_TOKEN=cconehub_fb_verify
```

**Dónde encontrar estas credenciales:**
- **App ID** y **App Secret**: En **Settings** → **Basic** de tu app de Facebook
- **Verify Token**: Puedes usar cualquier string seguro (ej: `cconehub_fb_verify_12345`)

## Paso 4: Configurar el Webhook

1. En tu app de Facebook, ve a **Messenger** → **Settings**
2. En la sección **"Webhooks"**, haz clic en **"Add Callback URL"**
3. Completa:
   - **Callback URL**: `https://tu-dominio.com/webhook/facebook`
     - Para desarrollo local con ngrok: `https://abc123.ngrok.io/webhook/facebook`
   - **Verify Token**: El mismo que pusiste en `FACEBOOK_VERIFY_TOKEN`
4. Selecciona los siguientes **Webhook Fields**:
   - `messages`
   - `messaging_postbacks`
   - `message_reads`
   - `message_deliveries`
5. Haz clic en **"Verify and Save"**

## Paso 5: Usar ngrok para Desarrollo Local (Opcional)

Si estás desarrollando localmente, necesitas exponer tu servidor con ngrok:

```bash
# Instalar ngrok (si no lo tienes)
brew install ngrok

# Exponer el puerto 3001 (o el puerto de tu backend)
ngrok http 3001
```

Copia la URL HTTPS que te da ngrok (ej: `https://abc123.ngrok.io`) y úsala como base para el webhook.

## Paso 6: Conectar una Página desde el Frontend

1. Inicia tu backend: `npm run start:dev`
2. Inicia tu frontend: `npm run dev`
3. Ve a **Integraciones** en el CRM
4. Haz clic en **"Conectar con Facebook"** en la tarjeta de Facebook Messenger
5. Autoriza la app y selecciona la página que deseas conectar
6. ¡Listo! Los mensajes comenzarán a llegar automáticamente

## Paso 7: Configurar Permisos de la App (Producción)

Para usar la app en producción con páginas reales:

1. Ve a **App Review** en tu app de Facebook
2. Solicita los siguientes permisos:
   - `pages_messaging`
   - `pages_show_list`
   - `pages_manage_metadata`
   - `pages_read_engagement`
3. Completa el proceso de revisión de Facebook (puede tomar varios días)

## Flujo de Mensajes

### Mensajes Entrantes (Facebook → CConeHub)

1. Usuario envía mensaje a tu página de Facebook
2. Facebook envía webhook a `POST /webhook/facebook`
3. CConeHub crea/actualiza el contacto automáticamente
4. Se crea una conversación con canal `facebook`
5. El mensaje aparece en tiempo real en la bandeja de conversaciones

### Mensajes Salientes (CConeHub → Facebook)

1. Agente responde desde la interfaz de conversaciones
2. CConeHub envía el mensaje vía Graph API
3. Usuario recibe el mensaje en Facebook Messenger
4. Facebook envía confirmación de entrega/lectura vía webhook

## Arquitectura

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Facebook  │────────▶│   Webhook    │────────▶│  CConeHub   │
│  Messenger  │         │  (Backend)   │         │   (CRM)     │
└─────────────┘         └──────────────┘         └─────────────┘
      ▲                                                  │
      │                                                  │
      └──────────────────Graph API◀────────────────────┘
```

## Solución de Problemas

### El webhook no verifica

- Verifica que `FACEBOOK_VERIFY_TOKEN` en `.env` coincida exactamente con el token en Facebook
- Asegúrate de que tu servidor esté corriendo y accesible públicamente
- Revisa los logs del backend para ver errores

### No llegan mensajes

- Verifica que la página esté correctamente suscrita al webhook
- Revisa que los webhook fields estén seleccionados correctamente
- Verifica que el `pageAccessToken` esté guardado en la base de datos
- Revisa los logs del backend: `npm run start:dev`

### Error al enviar mensajes

- Verifica que el `pageAccessToken` sea válido (no haya expirado)
- Asegúrate de que la página tenga permisos de `pages_messaging`
- Revisa que el usuario haya iniciado la conversación (Facebook requiere esto)

## Recursos Adicionales

- [Facebook Messenger Platform Docs](https://developers.facebook.com/docs/messenger-platform)
- [Graph API Reference](https://developers.facebook.com/docs/graph-api)
- [Webhook Reference](https://developers.facebook.com/docs/messenger-platform/webhooks)

## Notas Importantes

- **Tokens de Página**: Los tokens de página de Facebook son de larga duración (~60 días) pero pueden expirar. Implementa un sistema de renovación si es necesario.
- **Límites de Rate**: Facebook tiene límites de tasa para envío de mensajes. Revisa la documentación oficial.
- **Ventana de 24 horas**: Solo puedes enviar mensajes promocionales dentro de las 24 horas después de que el usuario te escriba. Después de eso, necesitas usar templates aprobados.
- **HTTPS Requerido**: Facebook requiere HTTPS para webhooks. En desarrollo usa ngrok.
