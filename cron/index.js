const log = require('../lib/logger');
const { limpiarContadores, registrarError } = require('../lib/error-monitor');
const { notificarErrorAdmin } = require('../lib/admin-notify');
const { escaneoAutomatico } = require('../services/gmail-scanner');
const { TAREAS, TAREAS_SIEMPRE } = require('./schedule');
const { programar } = require('./programar');
const {
  checkResumenMensual,
  checkResumenSemanal,
  checkResumenDiarioManosLibres,
  checkUpsellPro,
  checkPremiumExpiry,
  checkTrialExpiry,
  checkAlertasProactivas,
  checkRecordatorioOnboarding,
  checkActivacionDia2,
  checkRecordatorioDeudas,
  checkResumenDeudasSemanal,
  checkRecordatorioInactividadSemanal,
  checkRecordatorioSuscripciones,
  checkCalcularNetoScore,
  checkRetencionNotificaciones,
  checkNotificacionScore,
  checkDetectorFugas,
  checkCheckInPlanes,
  checkRecordatorioEspacios,
  checkRecordatoriosCostos,
  checkSurveyTriggers,
  checkSurveyConversions,
  limpiarOTPVencidos,
  checkGmailHuerfanos,
} = require('./checks');

// Keep-warm de la webapp (Vercel): pinguea /api/dashboard?warm=1 para mantener
// caliente el lambda y que la primera visita de un usuario no coma el cold start
// (~900ms). El ?warm hace un early-return barato (sin auth ni DB) en la route.
// Railway está always-on, así que este interval es confiable y gratis (no depende
// del plan de Vercel ni de un pinger externo).
const WEBAPP_WARM_URL = process.env.WEBAPP_WARM_URL || 'https://app.neto.pe/api/dashboard?warm=1';
async function keepWarmWebapp() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(WEBAPP_WARM_URL, { signal: controller.signal, headers: { 'x-keep-warm': '1' } });
    clearTimeout(timer);
    log.debug({ tag: 'KEEPWARM', status: res.status }, 'ping webapp');
  } catch (e) {
    log.warn({ tag: 'KEEPWARM', err: e.message }, 'ping webapp falló');
  }
}

/**
 * El único sitio donde un nombre de `schedule.js` se vuelve una función. Que la tabla sea data
 * y esto sea el mapa es lo que le permite al guard leer la tabla sin instanciar Supabase.
 */
const FUNCIONES = {
  escaneoAutomatico,
  checkResumenMensual,
  checkResumenSemanal,
  checkResumenDiarioManosLibres,
  checkUpsellPro,
  checkPremiumExpiry,
  checkTrialExpiry,
  checkAlertasProactivas,
  checkRecordatorioOnboarding,
  checkActivacionDia2,
  checkRecordatorioDeudas,
  checkResumenDeudasSemanal,
  checkRecordatorioInactividadSemanal,
  checkRecordatorioSuscripciones,
  checkCalcularNetoScore,
  checkRetencionNotificaciones,
  checkNotificacionScore,
  checkDetectorFugas,
  checkCheckInPlanes,
  checkRecordatorioEspacios,
  checkRecordatoriosCostos,
  checkSurveyTriggers,
  checkSurveyConversions,
  limpiarOTPVencidos,
  checkGmailHuerfanos,
  keepWarmWebapp,
  limpiarContadores,
};

/**
 * Un nombre de la tabla que no resuelve. La tarea simplemente no existe, y sin este aviso nadie
 * se entera hasta que alguien note que no llegó un resumen.
 */
function avisarTareaRota(nombre) {
  const msg = `La tarea programada "${nombre}" no resuelve a una función: no quedó programada`;
  log.error({ tag: 'CRON', tarea: nombre }, msg);
  registrarError('CRON', msg, { tarea: nombre });
  notificarErrorAdmin('CRON', msg);
}

/**
 * Una tarea que lleva varios ticks sin poder arrancar porque la anterior nunca terminó. Es el
 * precio del guard de no-solape y por eso no puede quedarse en un `log.warn`: ver `sin-solape.js`.
 */
function avisarTareaAtascada(nombre, seguidos) {
  const msg = `La tarea programada "${nombre}" lleva ${seguidos} ticks salteados: la corrida anterior nunca terminó`;
  log.error({ tag: 'CRON', tarea: nombre, saltadosSeguidos: seguidos }, msg);
  registrarError('CRON', msg, { tarea: nombre, saltadosSeguidos: seguidos });
  notificarErrorAdmin('CRON', msg);
}

const AVISOS = { alFaltarFuncion: avisarTareaRota, alAtascarse: avisarTareaAtascada };

function startCronJobs() {
  if (process.env.NODE_ENV === 'production') {
    programar(TAREAS, FUNCIONES, AVISOS);
  } else {
    log.warn({ tag: 'SERVER' }, 'Tareas programadas desactivadas (NODE_ENV !== production)');
  }
  // El backup ya no vive acá. Corre a diario en GitHub Actions
  // (.github/workflows/backup-db.yml) contra Cloudflare R2, cifrado y
  // completo. El que estaba acá subía 7 de 36 tablas en texto plano a un
  // Gist. Ver docs/runbook-restore.md.
  programar(TAREAS_SIEMPRE, FUNCIONES, AVISOS);
}

module.exports = { startCronJobs, FUNCIONES };
