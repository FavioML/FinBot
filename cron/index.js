const log = require('../lib/logger');
const { limpiarContadores } = require('../lib/error-monitor');
const { runBackup } = require('../scripts/backup');
const { escaneoAutomatico } = require('../services/gmail-scanner');
const {
  checkResumenMensual,
  checkResumenSemanal,
  checkRecordatorioDiario,
  checkPremiumExpiry,
  checkAlertasProactivas,
  checkRecordatorioOnboarding,
  checkRecordatorioDeudas,
  checkCalcularNetoScore,
  checkNotificacionScore,
  checkDetectorFugas,
  checkCheckInPlanes,
  checkRecordatorioEspacios,
} = require('./checks');

function startCronJobs() {
  const INTERVALO_HORAS = parseFloat(process.env.SCAN_INTERVAL_HOURS || '0.25');
  const INTERVALO_MS = INTERVALO_HORAS * 60 * 60 * 1000;

  if (process.env.NODE_ENV === 'production') {
    escaneoAutomatico();
    setInterval(escaneoAutomatico, INTERVALO_MS);
    log.info({ tag: 'AUTO', intervaloHoras: INTERVALO_HORAS }, 'Escaneo automático activo');
    setInterval(checkResumenSemanal, 15 * 60 * 1000);
    log.info({ tag: 'SEMANAL' }, 'Resumen semanal activo (lunes 8am Lima)');
    setInterval(checkResumenMensual, 15 * 60 * 1000);
    log.info({ tag: 'MENSUAL' }, 'Resumen mensual activo (1ro de cada mes 9am Lima)');
    setInterval(checkRecordatorioDiario, 15 * 60 * 1000);
    log.info({ tag: 'RECORDATORIO' }, 'Recordatorios diarios activos (8pm Lima)');
    setInterval(checkAlertasProactivas, 15 * 60 * 1000);
    log.info({ tag: 'ALERTAS' }, 'Alertas proactivas activas (miércoles 10am Lima)');
    setInterval(checkPremiumExpiry, 60 * 60 * 1000);
    log.info({ tag: 'EXPIRY' }, 'Check expiración premium activo (cada 1h)');
    setInterval(checkRecordatorioOnboarding, 15 * 60 * 1000);
    log.info({ tag: 'ONBOARDING' }, 'Recordatorio onboarding activo (3h después de registro, 9am-9pm Lima)');
    setInterval(checkRecordatorioDeudas, 15 * 60 * 1000);
    log.info({ tag: 'DEUDAS' }, 'Recordatorios de deudas activos (diario 9am Lima)');
    setInterval(checkCalcularNetoScore, 15 * 60 * 1000);
    log.info({ tag: 'SCORE' }, 'Cálculo diario Neto Score activo (6am Lima)');
    setInterval(checkNotificacionScore, 15 * 60 * 1000);
    log.info({ tag: 'SCORE' }, 'Notificación semanal Score activa (domingos 10am Lima)');
    setInterval(checkDetectorFugas, 15 * 60 * 1000);
    log.info({ tag: 'FUGAS' }, 'Detector de fugas activo (Pro: miércoles+15, Free: 1ro mes, 11am Lima)');
    setInterval(checkCheckInPlanes, 15 * 60 * 1000);
    log.info({ tag: 'PLANES' }, 'Check-in planes de ahorro activo (Pro: 1ro y 15, 11am Lima)');
    setInterval(checkRecordatorioEspacios, 15 * 60 * 1000);
    log.info({ tag: 'ESPACIOS' }, 'Recordatorio espacios compartidos activo (viernes 6pm Lima)');
    setTimeout(runBackup, 60000);
    setInterval(runBackup, 7 * 24 * 60 * 60 * 1000);
    log.info({ tag: 'BACKUP' }, 'Backup semanal activo');
  } else {
    log.warn({ tag: 'SERVER' }, 'Tareas programadas desactivadas (NODE_ENV !== production)');
  }
  setInterval(limpiarContadores, 60 * 60 * 1000);
  log.info({ tag: 'MONITOR' }, 'Monitor de errores activo');
}

module.exports = { startCronJobs };
