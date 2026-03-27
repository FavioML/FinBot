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

module.exports = { validateConfig };
