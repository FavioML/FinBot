# API Endpoints — NETO

## Webhook (Meta/WhatsApp)

| Method | Path | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/webhook` | Meta Verify Token | Verificación de webhook por Meta |
| POST | `/webhook` | Meta Signature | Recibe mensajes de WhatsApp (rate limited: 300/min) |

## Reportes y Dashboard

| Method | Path | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/reporte/:id` | Público (token en URL) | Página HTML del reporte financiero |
| GET | `/mi-reporte/:id` | Público | Redirect a reporte personal |
| GET | `/dashboard/:id` | Público (token en URL) | Dashboard interactivo con Chart.js |
| GET | `/api/reporte/:id` | Público | Datos del reporte en JSON |
| GET | `/api/reporte/:id/mes/:mes/:anio` | Público | Datos de reporte mensual en JSON |

## Admin

| Method | Path | Auth | Descripción |
|--------|------|------|-------------|
| POST | `/admin/activar` | ADMIN_KEY (body) | Activar premium para un usuario (rate limited: 10/min) |
| GET | `/admin/pendientes` | ADMIN_KEY (query) | Listar pagos pendientes (rate limited: 10/min) |

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
| POST | `/test-parser` | Ninguna | Testear parser de email (solo desarrollo) |

## Rate Limiting

- **Webhook**: 300 req/min global, keyed por número WhatsApp
- **Admin endpoints**: 10 req/min por IP
- Headers: `RateLimit-*` (RFC draft standard)
