# API Endpoints — NETO (backend, `api.neto.pe`)

> **Los números de rate limit viven en UNA sola sección de este archivo** (abajo), y cada fila
> nombra su limiter en vez de repetir la cifra. El motivo: hasta el 05-sep-2026 el tope del
> webhook estaba escrito en dos lugares de este mismo doc, los dos decían **300** y el código
> decía **1200** desde que se subió el tope. Un número con seis dueños envejece seis veces.
> La autoridad sigue siendo `index.js`; esto es su índice.

## Webhook (Meta/WhatsApp)

| Method | Path | Auth | Limiter | Descripción |
|--------|------|------|---------|-------------|
| GET | `/webhook` | Meta Verify Token | — | Verificación de webhook por Meta (`hub.mode`/`hub.verify_token`/`hub.challenge`) |
| POST | `/webhook` | Firma HMAC de Meta | `webhookLimiter` | Recibe mensajes de WhatsApp y callbacks de status |

**El límite del webhook es por IP, no por número.** La versión anterior keyeaba por
`messages[0].from` del body, que corre **antes** del HMAC y por lo tanto lo controla el atacante:
cualquiera que supiera un número podía dejar a su dueño en 429 sin probar un byte de identidad
(hallazgo S′5). El límite **por remitente** existe igual, pero vive después de la firma:
`limiteRemitenteSuperado()` en `handlers/webhook.js`.

## Admin — `ADMIN_KEY`, todos con `adminLimiter`

Auth en header `x-admin-key: <ADMIN_KEY>` (o `Authorization: Bearer <ADMIN_KEY>`). Nunca por query
string ni body: se filtra a los access logs. Aplica a todo `/admin/*`.

| Method | Path | Descripción |
|--------|------|-------------|
| POST | `/admin/activar` | Comp: regala 1 mes de Pro sin pago. No premia al referrer (anti-cadena) y registra el pago en S/0. Para un pago real con comprobante es `/admin/aprobar-pago` |
| POST | `/admin/aprobar-pago` | Aprueba un pago, activa Pro, registra en historial y notifica al usuario. Body: `{ usuario_id \| whatsapp, tipo_plan }` |
| GET | `/admin/pendientes` | Lista pagos pendientes de aprobación |
| GET | `/admin/pagos` | Historial de pagos. Param opcional: `usuario_id` |
| GET | `/admin/usuarios` | Lista de usuarios registrados |
| GET | `/admin/stats` | Métricas: usuarios, transacciones, top categorías/bancos |
| GET | `/admin/errores` | Errores recientes con stack. Params: `limite` (default 20), `resueltos=true` |
| POST | `/admin/notify` | Manda un WhatsApp manual a un usuario. Body: `{ whatsapp \| usuario_id, mensaje }` (máx 4000 chars) |
| POST | `/admin/responder-ticket` | Responde un ticket de soporte y lo marca respondido. Body: `{ ticket_id? , whatsapp?, mensaje }` |
| POST | `/admin/contactar-usuario` | Abre conversación con un usuario desde el panel. Body: `{ whatsapp, mensaje, usuario_id?, nombre? }` |
| POST | `/admin/espacio-nuevo-miembro` | Aviso por WhatsApp: entró alguien al espacio |
| POST | `/admin/espacio-reparto-cambiado` | Aviso por WhatsApp: cambió el split por defecto |
| POST | `/admin/espacio-reglas-cambiadas` | Aviso por WhatsApp: cambiaron las reglas por categoría (Pro) |
| POST | `/admin/referido-web` | Vincula un referido web y siembra su 50% off. NO premia al referrer (eso salta cuando el referido paga). Body: `{ ref_code, referido_id }` |
| POST | `/admin/test-parser` | Testea el parser de email. Se mudó de `/test-parser` el 11-ago-2026 (S′9): leía la llave del body y colgaba del limiter público |

**Los tres `espacio-*` existen porque la webapp no puede mandar WhatsApp**: son un hop
server-to-server, no lógica de negocio duplicada.

## Webapp → backend — `INTERNAL_API_KEY`, todos con `proLimiter`

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/pro/bancos` | Catálogo de bancos para el upgrade |
| GET | `/pro/gmail-auth-url` | URL de consentimiento OAuth de Gmail |
| POST | `/pro/solicitud` | Solicitud de Pro con comprobante (`application/octet-stream`, máx 10 MB) |
| POST | `/internal/activacion-completada` | La webapp terminó de activar una cuenta |
| POST | `/internal/activacion-fallida` | La activación falló |
| POST | `/internal/trial-iniciar` | Arranca el trial de 14 días |
| POST | `/internal/trial-evento` | Evento del trial |
| POST | `/internal/cuenta/borrar` | Borrado real de cuenta (ver `docs/runbook-borrado-de-datos.md`) |

`proLimiter` keyea por `x-usuario-id` (header o query), **no** por IP: la webapp llama siempre
desde la IP de egress de Vercel, así que un limiter por IP throttlearía a todos los usuarios juntos.

## Públicas — `publicLimiter` salvo donde se diga

| Method | Path | Limiter | Descripción |
|--------|------|---------|-------------|
| GET | `/` | `publicLimiter` | Health check / bienvenida |
| GET | `/health` | — | Health endpoint detallado (`ok`, `uptime`, `ts`). Lo lee el canary diario |
| GET | `/version` | — | SHA del commit desplegado (`RAILWAY_GIT_COMMIT_SHA`), para el canary de frescura. Sin esto, un 200 de `/health` no distingue código nuevo de viejo |
| GET | `/r/:code` | `publicLimiter` | Redirect de enlace de referido |
| GET | `/api/referidor/:code` | `publicLimiter` | Nombre del referidor, para la mini-landing |
| GET | `/auth/callback` | `publicLimiter` | Callback OAuth2 de Gmail |
| GET·POST | `/baja-recordatorios` | `publicLimiter` | Baja de recordatorios desde el link del correo |
| POST | `/telegram/webhook` | `adminLimiter` | Webhook de Telegram: el admin aprueba pagos (`/pago`, `/activar`, `/panel`) desde el chat. Secret header + allowlist de `chat_id` |
| POST | `/webhooks/resend` | `webhookLimiter` | Callback de entrega de Resend. Va con el limiter del webhook y **no** con el público a propósito: es tráfico de proveedor, y un 429 acá pierde el `delivered_at` que hace medible el canal de correo |

**`/privacidad`, `/terminos`, `/contacto` y `/faq` NO son del backend.** Este documento las listó
hasta el 05-sep-2026; las cuatro dan **404** en `api.neto.pe` y no existen en el código. Viven en
la landing: `https://neto.pe/privacidad`, `/terminos`, `/contacto`, `/faq`.

## Rate limiting

Cuatro limiters, ventana de 60 s, headers `RateLimit-*` (RFC draft). **Esta tabla es el único
lugar del doc con cifras.**

| Limiter | Tope | Clave | Dónde aplica |
|---------|------|-------|--------------|
| `webhookLimiter` | 1200/min | IP (IPv6 agrupada por /56) | `POST /webhook`, `POST /webhooks/resend` |
| `publicLimiter` | 60/min | IP | catch-all de rutas públicas |
| `proLimiter` | 20/min | `x-usuario-id`, con fallback a IP | `/pro/*`, `/internal/*` |
| `adminLimiter` | 10/min | IP | `/admin/*`, `POST /telegram/webhook` |

El webhook está en 1200 y no en 300 porque **todo Meta comparte el bucket**: el pico conocido es
el cron de las 8pm, ~100 usuarios × 3 callbacks de status (sent, delivered, read) ≈ 300 requests
en ráfaga, más los mensajes entrantes de ese rato. 1200 deja ×4 de margen y sigue cortando un
flood; lo que rechaza es barato, porque un request sin firma válida muere en el HMAC sin tocar la
DB ni OpenAI.

**Cómo re-derivar estos cuatro números sin creerle a este archivo** — lee el header, no cuentes
429s (esa es la lección de la fila del 27-ago de `DEFECTOS.md`):

```bash
curl -sS -o /dev/null -D - -X POST https://api.neto.pe/webhook -d '{}' | grep -i ratelimit-policy
curl -sSI https://api.neto.pe/                                         | grep -i ratelimit-policy
curl -sS -o /dev/null -D - https://api.neto.pe/pro/bancos              | grep -i ratelimit-policy
curl -sS -o /dev/null -D - https://api.neto.pe/admin/stats             | grep -i ratelimit-policy
```

Los cuatro se corrieron el 05-sep-2026 contra producción y dieron `1200;w=60`, `60;w=60`,
`20;w=60` y `10;w=60`.
