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
  'WA_PHONE_NUMBER',
  'SCAN_INTERVAL_HOURS',
  'LOG_LEVEL',
  'GITHUB_BACKUP_TOKEN',
  'BACKUP_GIST_ID',
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

module.exports = { validateConfig, ADMIN_NUMBER, PRO_PRECIOS, esPagoNeto, detectarTipoPlan };
