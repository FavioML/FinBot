require('dotenv').config();
const { validateConfig } = require('./lib/config');
validateConfig();
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const log = require('./lib/logger');
const { hoyPeru, ultimoDiaMes } = require('./lib/dates');
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP, MESES } = require('./lib/constants');
const { validarMonto, normalizarCategoria } = require('./lib/validators');
const { formatFecha, barraProgreso } = require('./lib/formatters');
const { parsearCorreoBancario, parsearRegistroManual, extraerLast4 } = require('./services/parsers');
const { notificarErrorAdmin } = require('./lib/admin-notify');
const { registrarError } = require('./lib/error-monitor');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const proRoutes = require('./routes/pro');
const internalRoutes = require('./routes/internal');
const { startCronJobs } = require('./cron');
const createWebhookHandler = require('./handlers/webhook');
const { telegramWebhookHandler } = require('./handlers/telegram-webhook');
const { registrarWebhookTelegram } = require('./lib/telegram');
const { procesarMensajeLibre } = require('./handlers/message-processor');
const analytics = require('./lib/analytics');

// Aliases para retrocompatibilidad (exports usados en tests)
function fechaHoyPeru() { return hoyPeru(); }
function fechaAyerPeru() { const { ayerPeru } = require('./lib/dates'); return ayerPeru(); }

const app = express();

// Railway está detrás de un proxy reverso. Confiamos en el primer hop para que
// req.ip refleje el IP real del cliente (y desactiva el warning de express-rate-limit).
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
  origin: ['https://app.neto.pe', 'https://neto.pe', 'https://neto-app.vercel.app'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.urlencoded({ extended: false }));
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// Rate limiters
// Cuando keyeamos por IP hay que pasarla por ipKeyGenerator: agrupa las IPv6 por su /56.
// Sin eso, un cliente IPv6 rota de dirección dentro de su propio bloque y evade el límite.
const claveIp = (req) => ipKeyGenerator(req.ip || '0.0.0.0');

// Este limiter corre ANTES del HMAC, así que solo puede mirar datos que un atacante no
// controla: la IP. La versión anterior leía `messages[0].from` del body sin verificar y lo
// usaba de clave, o sea que cualquiera que supiera un número podía mandar 300 requests
// basura con ese `from` y dejar al dueño en 429 sin haber probado un solo byte de identidad
// (hallazgo S′5). No hay forma de arreglar eso keyeando mejor: cualquier campo del body es
// del atacante hasta que la firma se verifica. El límite POR REMITENTE existe igual, pero
// vive después del HMAC — `limiteRemitenteSuperado()` en handlers/webhook.js.
//
// El tope se sube porque ahora TODO Meta comparte el bucket, y el pico conocido es el cron
// de las 8pm: ~100 usuarios notificados × 3 callbacks de status cada uno (sent, delivered,
// read) ≈ 300 requests en ráfaga, más los mensajes entrantes de ese rato. 1200 deja ×4 de
// margen sobre ese pico y sigue cortando un flood. Lo que rechaza acá es barato: un request
// sin firma válida muere en el HMAC sin tocar la DB ni OpenAI.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: true },
  message: { error: 'Demasiadas solicitudes, intenta en un momento' },
  keyGenerator: claveIp,
});
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes admin' },
});
// Rutas públicas (OAuth callback, /api/referidor de la mini-landing): superficie SIN auth.
// Por IP y holgado — un navegador real hace un puñado de hits; lo que corta es la
// enumeración de ref_codes (harvest de nombres) y la carga a la DB (auditoría 2026-08-03, S3).
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intenta en un momento' },
  keyGenerator: claveIp,
});
// Rutas /pro: la webapp (Vercel) llama SIEMPRE desde su IP de egress, así que un limiter
// por IP throttlearía a todos los usuarios juntos. Keyeamos por usuario_id (header/query).
const proLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intenta en un momento' },
  keyGenerator: (req) => req.get('x-usuario-id') || req.query.usuario_id || claveIp(req),
});

// === Routes ===
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'NETO', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// SHA del commit desplegado, para el canary de frescura del deploy (backend-deploy-fresh).
// `RAILWAY_GIT_COMMIT_SHA` lo inyecta Railway solo en cada deploy desde GitHub — no hay
// env var que configurar. Espejo del /api/version del webapp (que lee VERCEL_GIT_COMMIT_SHA).
// Sin este endpoint, un 307/200 de /health NO distingue código nuevo de viejo (solo da uptime).
app.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    sha: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    ref: process.env.RAILWAY_GIT_BRANCH || null,
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    log.info({ tag: 'WEBHOOK' }, 'Verificado por Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', webhookLimiter, createWebhookHandler(procesarMensajeLibre));

// Webhook entrante de Telegram: el admin aprueba pagos (/pago, /activar, /panel) desde
// el chat donde recibe las notificaciones. Seguridad: secret header + allowlist de chat_id
// (ver handlers/telegram-webhook.js). Limiter holgado propio.
app.post('/telegram/webhook', adminLimiter, telegramWebhookHandler);

// Upgrade Pro desde la webapp (solicitud + catálogo bancos + URL OAuth). Auth por
// INTERNAL_API_KEY (ver routes/pro.js). Antes del catch-all público.
app.use('/pro', proLimiter, proRoutes);

// Callbacks internos de la webapp (activación de cuenta). Misma auth por
// INTERNAL_API_KEY; ver routes/internal.js. También antes del catch-all público.
app.use('/internal', proLimiter, internalRoutes);

// Callback de entrega de Resend. Va ANTES del catch-all público y con el limiter de webhooks
// (1200/min) y no con `publicLimiter` (60/min): es tráfico de proveedor, no de navegador, y un
// 429 acá pierde el `delivered_at` que hace medible el canal de correo. Mismo trato que los
// callbacks de status de Meta, por el mismo motivo.
app.post('/webhooks/resend', webhookLimiter, publicRoutes.resendWebhookHandler);

app.use('/', publicLimiter, publicRoutes);
app.use('/admin', adminLimiter, adminRoutes);

// Error handler (must be after all routes)
app.use((err, req, res, next) => {
  log.error({ tag: 'EXPRESS', err: err.message, stack: err.stack, path: req.path, method: req.method }, 'Error no manejado');
  notificarErrorAdmin('EXPRESS', err.message, req.method + ' ' + req.path);
  registrarError('EXPRESS', err.message, { detalle: req.method + ' ' + req.path, stack: err.stack });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Server startup
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    log.info({ tag: 'SERVER', port: PORT }, 'NETO v5 iniciado');
    setTimeout(() => startCronJobs(), 30000);
    // Registrar el webhook entrante de Telegram (idempotente; no-op si faltan env vars).
    registrarWebhookTelegram().catch((e) => log.error({ tag: 'TELEGRAM', err: e.message }, 'Fallo registrando webhook al boot'));
  });

  // Flush de analytics antes de apagar (Railway envía SIGTERM en cada deploy)
  function gracefulShutdown(signal) {
    log.info({ tag: 'SERVER', signal }, 'Apagando — flush de analytics');
    analytics.shutdown().finally(() => process.exit(0));
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Red de seguridad para rechazos/excepciones fuera de un try (p.ej. un cron async
  // en setInterval que no atrapó su error). Sin esto, un solo rechazo tumba el proceso
  // hasta que Railway reinicie y corta la atención de todos los usuarios. Logueamos y
  // notificamos al admin, pero NO hacemos process.exit ciego: preferimos que el bot
  // siga vivo y degradado a caerse entero por un error aislado.
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    log.error({ tag: 'UNHANDLED_REJECTION', err: msg, stack }, 'Promesa rechazada sin catch');
    registrarError('UNHANDLED_REJECTION', msg, { stack });
    notificarErrorAdmin('UNHANDLED_REJECTION', msg, stack);
  });
  process.on('uncaughtException', (err) => {
    log.error({ tag: 'UNCAUGHT_EXCEPTION', err: err.message, stack: err.stack }, 'Excepción no atrapada');
    registrarError('UNCAUGHT_EXCEPTION', err.message, { stack: err.stack });
    notificarErrorAdmin('UNCAUGHT_EXCEPTION', err.message, err.stack);
  });
}

// Exports para tests
module.exports = {
  validarMonto, normalizarCategoria, formatFecha, barraProgreso,
  fechaHoyPeru, fechaAyerPeru, ultimoDiaMes,
  CATEGORIAS_VALIDAS, CATEGORIA_MAP, MESES,
  parsearCorreoBancario, parsearRegistroManual, extraerLast4,
  app
};
