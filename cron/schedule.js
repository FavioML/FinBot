/**
 * QUÉ corre y CADA CUÁNTO. Datos puros: sin `require` de los checks, sin efectos.
 *
 * Vive separado de `cron/index.js` —que es el CABLEADO— para que la CADENCIA se pueda leer y
 * declarar sin ejecutar nada: `nombre` es un string, no la función, y este archivo no importa
 * un solo módulo del backend.
 *
 * > El motivo original era que el guard pudiera leer la tabla sin arrastrar `checks.js` (que
 * > instancia Supabase al cargarse). Ya no es cierto: desde que el guard resuelve los nombres
 * > DE VERDAD contra el mapa de `cron/index.js` —en vez de leerlo con un regex, que dejaba
 * > pasar un export borrado— sí carga todo el árbol. La separación se queda igual, por lo de
 * > arriba.
 *
 * ### El invariante que NO se puede romper: intervalo ≤ 15 min
 *
 * Catorce de estos checks abren su ventana con `getMinutes() > 14` (o `getUTCMinutes()`),
 * o sea que solo hacen algo si el tick cae en los primeros 15 minutos de la hora. Con un
 * intervalo de 15 minutos eso funciona para CUALQUIER momento de arranque: los cuatro ticks
 * de una hora caen en m, m+15, m+30 y m+45, y exactamente uno de esos cuatro está en [0,14].
 *
 * Con un intervalo de 30 minutos deja de estar garantizado: si el proceso arranca en el
 * minuto 20, los ticks caen en :20 y :50 y el cron **no corre nunca**, en silencio, hasta el
 * siguiente deploy. Por eso el intervalo y el gate son una sola decisión y no dos, y por eso
 * el guard los mira juntos.
 *
 * El desfase de arranque (`offsetMs`, que calcula `cron/programar.js`) es seguro por el mismo
 * argumento: mueve la FASE, no el período, así que sigue habiendo exactamente un tick por
 * hora dentro de la ventana. Lo que cambia es en qué minuto de esa ventana cae.
 *
 * **Y el invariante no es solo de minutos.** `checkPremiumExpiry` y `checkTrialExpiry` gatean
 * con `getHours() >= 8` (ventana de 16h) y `checkRecordatorioOnboarding` / `checkActivacionDia2`
 * con 9-21h (12h). La regla general es **período ≤ ancho de la ventana**, y el guard
 * `tests/cron/scheduling.test.js` la verifica para las dos formas — fallando cerrado si aparece
 * una tercera que no sabe leer.
 */

const MIN = 60 * 1000;
const HORA = 60 * MIN;

// El único intervalo configurable por entorno. No tiene gate horario (barre Gmail cada vez que
// corre), así que no cae bajo el invariante de arriba.
//
// Ojo: esto se evalúa al CARGAR el módulo, y antes se calculaba dentro de `startCronJobs()`.
// Funciona porque `index.js` hace `dotenv.config()` antes de requerir `./cron`, pero es un
// acoplamiento nuevo al orden de los requires: un script que importe `cron/schedule` sin cargar
// dotenv primero congela el default de 0.25h.
//
// El `Number.isFinite` no es defensivo por gusto: con `SCAN_INTERVAL_HOURS="abc"` el período
// queda `NaN`, y `setInterval(fn, NaN)` **dispara cada milisegundo**. Ya pasaba antes de la
// tabla; se cierra acá porque es el único período que viene de afuera.
const _horasEscaneo = parseFloat(process.env.SCAN_INTERVAL_HOURS || '0.25');
const INTERVALO_ESCANEO_MS = (Number.isFinite(_horasEscaneo) && _horasEscaneo > 0 ? _horasEscaneo : 0.25) * HORA;

/**
 * Tareas que solo corren en producción.
 *
 * - `nombre`: la clave con la que `cron/index.js` resuelve la función. Un nombre que no
 *   resuelve revienta al boot a propósito (ver `programar`), no en silencio a los 15 min.
 * - `alBoot`: además del intervalo, corre una vez al levantar el proceso. Son barridos de
 *   reconciliación: un deploy es justo cuando conviene recoger lo que se coló.
 * - `ventanaMaxMs`: ancho REAL de la ventana de elegibilidad cuando NO está en el gate horario
 *   sino en el `WHERE` de la query. Ver abajo.
 *
 * ### `ventanaMaxMs`: la ventana que no se puede leer del gate
 *
 * `checkRecordatorioOnboarding` gatea de 9 a 21h, así que el guard leía una ventana de 12 horas.
 * Su elegibilidad real es otra: `created_at` entre un techo y un piso (`checks.js`), o sea una
 * **ventana móvil** que se cierra sola. Con período de 6 h el guard pasaba en verde y un
 * usuario registrado a las 07:00 (elegible de 10:00 a 13:00) con ticks a las 09:30 y 15:30 no
 * recibía el empujón **nunca**.
 *
 * El guard sabe detectar la FORMA (`.gte('created_at')` + `.lte('created_at')` en el mismo
 * cuerpo) y **exige la declaración**, pero no puede derivar el número: sale de restar dos
 * constantes que se calculan en el código. Por eso se declara acá, al lado del período.
 */
const TAREAS = [
  { nombre: 'escaneoAutomatico', cadaMs: INTERVALO_ESCANEO_MS, alBoot: true, tag: 'AUTO', mensaje: 'Escaneo automático de Gmail' },
  { nombre: 'checkResumenSemanal', cadaMs: 15 * MIN, tag: 'SEMANAL', mensaje: 'Resumen semanal (lunes 8am Lima)' },
  { nombre: 'checkResumenMensual', cadaMs: 15 * MIN, tag: 'MENSUAL', mensaje: 'Resumen mensual (1ro de cada mes, 9am Lima)' },
  { nombre: 'checkRecordatorioDiario', cadaMs: 15 * MIN, tag: 'INACTIVITY', mensaje: 'Recordatorios de inactividad (8pm Lima, cada 3+ días sin tx)' },
  { nombre: 'checkResumenDiarioManosLibres', cadaMs: 15 * MIN, tag: 'RESUMEN_DIARIO', mensaje: 'Resumen diario Manos Libres (Pro opt-in, 9pm Lima)' },
  { nombre: 'checkAlertasProactivas', cadaMs: 15 * MIN, tag: 'ALERTAS', mensaje: 'Alertas proactivas (miércoles 10am Lima)' },
  { nombre: 'checkPremiumExpiry', cadaMs: HORA, tag: 'EXPIRY', mensaje: 'Check expiración premium' },
  { nombre: 'checkTrialExpiry', cadaMs: HORA, tag: 'TRIAL_EXPIRY', mensaje: 'Check fin de trial (avisos día 11 y 14, downgrade al muro)' },
  // `ventanaMaxMs`: elegibles los registrados entre hace 18h y hace 3h (`checks.js`), o sea 15h.
  // Era 3h (techo de 6h) hasta el 20-ago-2026. El techo subió a 18h porque el gate de 9-21h y
  // una ventana de 3h se contradecían: quien se daba de alta a las 18:00 maduraba con el gate
  // ya cerrado y a las 9am ya había vencido — el 50.9% del padrón real no lo recibía nunca.
  // Este número NO se deriva solo: hay que restar las dos constantes de `checks.js` a mano.
  { nombre: 'checkRecordatorioOnboarding', cadaMs: 15 * MIN, ventanaMaxMs: 15 * HORA, tag: 'ONBOARDING', mensaje: 'Recordatorio onboarding (3-18h tras el registro, 9am-9pm Lima)' },
  // Elegibles los registrados entre hace 48h y hace 24h.
  { nombre: 'checkActivacionDia2', cadaMs: 15 * MIN, ventanaMaxMs: 24 * HORA, tag: 'ACTIVACION', mensaje: 'Empujón activación día 2 (24-48h tras registro, dentro de la ventana 24h de Meta)' },
  { nombre: 'checkRecordatorioDeudas', cadaMs: 15 * MIN, tag: 'DEUDAS', mensaje: 'Recordatorios de deudas (diario 9am Lima)' },
  { nombre: 'checkRecordatorioSuscripciones', cadaMs: 15 * MIN, tag: 'SUB_REMIND', mensaje: 'Recordatorios de cobro de suscripciones (Pro, 3d antes, 10am Lima)' },
  { nombre: 'checkCalcularNetoScore', cadaMs: 15 * MIN, tag: 'SCORE', mensaje: 'Cálculo diario Neto Score (6am Lima)' },
  { nombre: 'checkRetencionNotificaciones', cadaMs: 15 * MIN, tag: 'RETENCION', mensaje: 'Retención de la campana (4am Lima, 90 días + tope 100 por usuario)' },
  { nombre: 'checkNotificacionScore', cadaMs: 15 * MIN, tag: 'SCORE', mensaje: 'Notificación semanal del Score (domingos 10am Lima)' },
  { nombre: 'checkDetectorFugas', cadaMs: 15 * MIN, tag: 'FUGAS', mensaje: 'Detector de fugas (Pro: miércoles+15, Free: 1ro de mes, 11am Lima)' },
  { nombre: 'checkCheckInPlanes', cadaMs: 15 * MIN, tag: 'PLANES', mensaje: 'Check-in de planes de ahorro (Pro: 1ro y 15, 11am Lima)' },
  { nombre: 'checkRecordatorioEspacios', cadaMs: 15 * MIN, tag: 'ESPACIOS', mensaje: 'Recordatorio de espacios compartidos (viernes 6pm Lima)' },
  { nombre: 'checkRecordatoriosCostos', cadaMs: 15 * MIN, tag: 'COSTOS_REMIND', mensaje: 'Recordatorios de costos al admin (9am Lima diario)' },
  { nombre: 'checkSurveyTriggers', cadaMs: 15 * MIN, tag: 'SURVEY_TRIG', mensaje: 'Survey triggers (recordatorios + invite webapp + feedback 30tx, 10am Lima)' },
  { nombre: 'checkSurveyConversions', cadaMs: 15 * MIN, tag: 'SURVEY_CONV', mensaje: 'Conversión de recordatorios (7am Lima diario)' },
  { nombre: 'limpiarOTPVencidos', cadaMs: HORA, alBoot: true, tag: 'OTP_CLEANUP', mensaje: 'Limpieza de OTPs vencidos' },
  { nombre: 'checkGmailHuerfanos', cadaMs: 24 * HORA, alBoot: true, tag: 'GMAIL_HUERFANOS', mensaje: 'Barrido de cupos Gmail de no-pagados' },
  { nombre: 'keepWarmWebapp', cadaMs: 4 * MIN, alBoot: true, tag: 'KEEPWARM', mensaje: 'Keep-warm de /api/dashboard' },
];

/**
 * Corre en TODOS los entornos, producción incluida. Es el único que no depende de
 * `NODE_ENV`: sin él, los contadores del monitor de errores crecen sin límite en dev.
 */
const TAREAS_SIEMPRE = [
  { nombre: 'limpiarContadores', cadaMs: HORA, tag: 'MONITOR', mensaje: 'Monitor de errores' },
];

module.exports = { TAREAS, TAREAS_SIEMPRE, MIN, HORA };
