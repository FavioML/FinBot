# API Endpoints — NETO

## Webhook (Meta/WhatsApp)

| Method | Path | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/webhook` | Meta Verify Token | Verificación de webhook por Meta |
| POST | `/webhook` | Meta Signature | Recibe mensajes de WhatsApp (rate limited: 300/min) |

## Admin

| Method | Path | Auth | Descripción |
|--------|------|------|-------------|
| POST | `/admin/activar` | ADMIN_KEY (header) | Comp: regalar 1 mes de premium, sin pago de por medio. No premia al referrer y registra el pago en S/0. Para un pago real con comprobante es `/admin/aprobar-pago` (rate limited: 10/min) |
| GET | `/admin/pendientes` | ADMIN_KEY (header) | Listar pagos pendientes (rate limited: 10/min) |
| GET | `/admin/stats` | ADMIN_KEY (header) | Métricas: usuarios, transacciones, top categorías/bancos (rate limited: 10/min) |
| GET | `/admin/errores` | ADMIN_KEY (header) | Errores recientes con stack trace. Params: `limite` (default 20), `resueltos=true` para ver todos |

> **Auth admin:** la clave va en header `x-admin-key: <ADMIN_KEY>` (o `Authorization: Bearer <ADMIN_KEY>`). Nunca por query string ni body (se filtra a los access logs). Aplica a todos los endpoints `/admin/*`.

## Auth (OAuth2 Gmail)

| Method | Path | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/auth/callback` | OAuth2 | Callback de autorización Gmail |

## Referidos

| Method | Path | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/r/:code` | Público | Redirect de enlace de referido |

## Páginas estáticas

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/` | Health check / bienvenida |
| GET | `/health` | Health endpoint detallado |
| GET | `/privacidad` | Política de privacidad |
| GET | `/terminos` | Términos de servicio |
| GET | `/contacto` | Página de contacto |
| GET | `/faq` | Preguntas frecuentes |

## Dev/Test

| Method | Path | Auth | Descripción |
|--------|------|------|-------------|
| POST | `/admin/test-parser` | `x-admin-key` o `Authorization: Bearer` | Testear parser de email. Se mudó de `/test-parser` el 11-ago-2026 (S′9): leía la llave del body y colgaba del limiter público |

## Rate Limiting

- **Webhook**: 300 req/min global, keyed por número WhatsApp
- **Admin endpoints**: 10 req/min por IP
- Headers: `RateLimit-*` (RFC draft standard)
