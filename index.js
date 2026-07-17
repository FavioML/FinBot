require('dotenv').config();
const { validateConfig } = require('./lib/config');
validateConfig();
const express = require('express');
const { rateLimit } = require('express-rate-limit');
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
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false, default: true },
  message: { error: 'Demasiadas solicitudes, intenta en un momento' },
  keyGenerator: (req) => {
    try {
      const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) return from;
    } catch {}
    return req.ip || '0.0.0.0';
  },
});
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes admin' },
});

// === Routes ===
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'NETO', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
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

app.use('/', publicRoutes);
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
