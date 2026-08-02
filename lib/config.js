const log = require('./logger');

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'OPENAI_API_KEY',
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
];

const OPTIONAL = [
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'RAILWAY_URL',
  'ADMIN_KEY',
  'ADMIN_WHATSAPP',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ADMIN_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
  'INTERNAL_API_KEY',
  'ACTIVATION_TOKEN_SECRET',
  'PUBLIC_BACKEND_URL',
  'WA_PHONE_NUMBER',
  'SCAN_INTERVAL_HOURS',
  'LOG_LEVEL',
];

function validateConfig() {
  // En tests, no validar variables de entorno (vitest las mockea)
  if (process.env.NODE_ENV === 'test') return;

  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`\n❌ Variables de entorno requeridas no encontradas:\n   ${missing.join(', ')}\n\nCopia .env.example como .env y completa los valores.\n`);
    process.exit(1);
  }

  const missingOptional = OPTIONAL.filter(k => !process.env[k]);
  if (missingOptional.length > 0) {
    log.warn({ tag: 'CONFIG', missing: missingOptional }, 'Variables opcionales no configuradas');
  }

  // ENCRYPTION_KEY cifra los tokens OAuth Gmail (AES-256-GCM → llave de 32 bytes en hex).
  // Si está presente pero mal formada, fallar al boot en vez de reventar al guardar un token.
  if (process.env.ENCRYPTION_KEY) {
    const keyBytes = Buffer.from(process.env.ENCRYPTION_KEY, 'hex').length;
    if (keyBytes !== 32) {
      console.error(`\n❌ ENCRYPTION_KEY inválida: debe ser 32 bytes en hex (64 caracteres). Detectado: ${keyBytes} bytes.\n   Los tokens Gmail no se podrían cifrar/descifrar.\n`);
      process.exit(1);
    }
  } else {
    log.warn({ tag: 'CONFIG' }, 'ENCRYPTION_KEY no configurada — la integración Gmail (cifrado de tokens) fallará si se usa');
  }

  log.info({ tag: 'CONFIG' }, 'Configuración validada correctamente');
}

/** Centralized admin WhatsApp number — single source of truth */
const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';

/** Precios del plan Pro (PEN). Source of truth para detectar comprobantes de pago. */
const PRO_PRECIOS = { mensual: 10, anual: 99 };

/**
 * ¿La transacción parseada parece un pago Pro a Neto (Yape a Favio Mendoza)?
 * Combina destinatario (Favio Mendoza / Neto) + monto exacto del plan para evitar
 * falsos positivos con un contacto que se llame Favio.
 * @param {object} datos - { comercio, monto, metodo_pago, tipo }
 */
function esPagoNeto(datos) {
  if (!datos) return false;
  if (datos.tipo && datos.tipo !== 'gasto') return false; // un pago Pro siempre es gasto enviado
  const comercio = (datos.comercio || '').toLowerCase();
  const destinoNeto = /\bneto\b/.test(comercio) || /favio/.test(comercio);
  if (!destinoNeto) return false;
  const monto = parseFloat(datos.monto);
  if (isNaN(monto)) return false;
  const esMensual = Math.abs(monto - PRO_PRECIOS.mensual) < 0.5;
  const esAnual = Math.abs(monto - PRO_PRECIOS.anual) < 1.5;
  return esMensual || esAnual;
}

/** Deduce el tipo de plan (mensual/anual) a partir del monto detectado. */
function detectarTipoPlan(monto) {
  const m = parseFloat(monto);
  if (!isNaN(m) && Math.abs(m - PRO_PRECIOS.anual) < 10) return 'anual';
  return 'mensual';
}

/**
 * Resuelve el tipo de plan de un comprobante. El monto detectado manda porque es lo que
 * el usuario realmente pagó; el tipo_plan guardado solo se usa como fallback cuando no hay
 * monto, ya que puede venir viejo (un mensual que ahora paga el anual seguiría marcado
 * "mensual" y la notificación al admin mentiría). Ver caso Juan/Diego (jul 2026).
 * @param {number|string|null} montoDetectado
 * @param {string|null} tipoPlanGuardado
 */
function resolverTipoPlan(montoDetectado, tipoPlanGuardado) {
  if (montoDetectado != null && !isNaN(parseFloat(montoDetectado))) {
    return detectarTipoPlan(montoDetectado);
  }
  return tipoPlanGuardado || 'mensual';
}

/**
 * ¿El usuario tiene un descuento de referido vigente hoy? Devuelve el pct (>0) o 0.
 * @param {object} usuario  fila con referido_dscto_pct / referido_dscto_vence
 * @param {string} [hoyStr] fecha Lima 'YYYY-MM-DD'; si se omite se calcula.
 */
function descuentoReferidoVigente(usuario, hoyStr) {
  if (!usuario || !usuario.referido_dscto_pct) return 0;
  const vence = usuario.referido_dscto_vence ? String(usuario.referido_dscto_vence).slice(0, 10) : null;
  if (!vence) return 0;
  const hoy = hoyStr || require('./dates').hoyPeru();
  if (vence < hoy) return 0; // vencido → precio normal
  return usuario.referido_dscto_pct;
}

/**
 * Precio efectivo del plan Pro para el usuario, aplicando el descuento de referido si está
 * vigente. Solo aplica al MENSUAL (el anual es lump sum, no tiene "primer mes").
 * @returns {number} monto en soles (p.ej. 5 para mensual con 50% off, 10 sin descuento).
 */
function precioProEfectivo(usuario, tipoPlan, hoyStr) {
  const plan = tipoPlan === 'anual' ? 'anual' : 'mensual';
  const base = PRO_PRECIOS[plan];
  if (plan === 'anual') return base;
  const pct = descuentoReferidoVigente(usuario, hoyStr);
  if (!pct) return base;
  return Math.round(base * (100 - pct)) / 100;
}

module.exports = { validateConfig, ADMIN_NUMBER, PRO_PRECIOS, esPagoNeto, detectarTipoPlan, resolverTipoPlan, descuentoReferidoVigente, precioProEfectivo };
