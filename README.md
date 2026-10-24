# AXENTYC Backend

API de AXENTYC: bandeja omnicanal (Facebook, Instagram, email, widget web), CRM, facturación y automatizaciones.
NestJS 11 · MongoDB (Mongoose) · Socket.IO + Redis · JWT en cookies HttpOnly.

## Módulos (`src/`)

| Módulo | Qué hace |
|---|---|
| `auth` | Registro, login, refresh, recuperación de contraseña, invitaciones |
| `tenants`, `workspaces`, `memberships` | Cuenta (agencia), empresas (workspaces) y permisos. Todo dato de negocio vive en un workspace |
| `billing` | Planes (`plans.ts` es la fuente única), límites, estados de acceso, Stripe, avisos por correo |
| `conversations`, `chat-widget`, `facebook`, `emails`, `integrations` | Canales y bandeja |
| `crm` | Contactos, leads, deals (+ import/export CSV) |
| `activities` | Tareas, notas, respuestas rápidas, historial por cliente |
| `invoicing` | Cotizaciones, facturas, pagos manuales, catálogo, PDF y envío por email |
| `automations` | Motor de reglas "cuando X, haz Y" + historial de ejecuciones |
| `reports` | Dashboard y reportes (tiempos de respuesta, embudo, ventas) |
| `events` | Socket.IO autenticado por la cookie de sesión |

## Reglas que conviene conocer
- **Workspace obligatorio:** `WorkspaceScopeGuard` exige un `workspaceId` válido y accesible en las rutas de datos de negocio.
- **Planes:** `SubscriptionGuard` deja una cuenta con prueba vencida o pago fallido en solo lectura (GET y DELETE siguen funcionando). `@RequiresFeature('deals' | 'invoicing' ...)` bloquea por plan.
- **Webhooks:** Facebook y Stripe se aceptan solo con firma válida.
- **Dinero:** siempre en centavos enteros; ver `invoicing/totals.ts`.
- **Seguridad:** `helmet`, rate limit global (300/min) y más estricto en login/registro/widget, tokens nunca se devuelven al navegador.

## Puesta en marcha

```bash
cp .env.example .env      # completa los valores
npm install
npm run start:dev         # http://localhost:3003/api/v1  (Swagger si SWAGGER_ENABLED=true)
```

Variables: ver `.env.example` (Mongo, JWT, Redis, Meta, Stripe, SMTP del sistema, Firebase).
Configuración de cobros: `../docs/BILLING_STRIPE_SETUP.md`. Configuración de Meta: `../docs/backend/FACEBOOK_SETUP.md`.

## Pruebas

```bash
npm test                  # unitarias (jest)
npm run build && npm run test:smoke   # extremo a extremo contra la base de .env
```

`test:smoke` levanta `dist/main` en el puerto 3999, crea una cuenta temporal y la borra al terminar.
Cubre CRM, facturas/PDF, automatizaciones, reportes, planes, widget, seguridad y recuperación de contraseña.

## Operación
- Al arrancar corren migraciones idempotentes (correo multi-cuenta, workspaces, planes). Haz un respaldo de la base antes de desplegar una versión nueva.
- Cuentas de cortesía: `node scripts/grant-plan.js "Nombre de la cuenta" agency`.
- Detrás de nginx/Caddy: `TRUST_PROXY` queda activo por defecto (usa la IP real para el rate limit).
