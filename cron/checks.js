const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru, sumarMeses, sumarDias } = require('../lib/dates');
const { getUserPlanConfig } = require('../helpers/db-helpers');
const { generarResumenSemanal, generarResumenMensual, generarResumenDiario } = require('../services/summaries');
const { verificarAlertasProactivas } = require('../services/recommendations');
const { obtenerDeudasProximasVencer } = require('../services/debts');
const { notificarUsuario, CANALES } = require('../lib/notify-user');
const { ADMIN_NUMBER, lineaPrecioPro } = require('../lib/config');
const { WEBAPP_URL } = require('../lib/constants');
const { formatFecha } = require('../lib/formatters');
const { notificarAdmin } = require('../lib/admin-notify');
const { checkSurveyTriggers } = require('../services/survey-triggers');
const { solicitarComprobante } = require('../lib/pro-payment');
const { planCostReminders } = require('../lib/cost-reminders');
const { mensajeActivacionDia2 } = require('../lib/activacion');
const { mensajeMuro, estaEnMuro, esProPagado, linkPanelPro, AVISO_DIAS_ANTES } = require('../lib/trial');
const { revocarAccesoGmail } = require('../gmail');
const analytics = require('../lib/analytics');

// `msgErr` vive en `lib/error-monitor.js`. Acá importa especialmente: un `e.message` a secas
// dentro del catch de un loop tira `TypeError` si el rechazo no es un Error, la excepción se
// escapa del `for`, la traga el catch externo por la misma vía, y **se saltan todos los usuarios
// que faltaban** — con el cron saliendo en `count: 0`, indistinguible de "no había a quién
// avisarle". Lo midió la revisión adversarial de este commit: con `upsertScore` rechazando
// `null` sobre un padrón de dos, se llamaba UNA vez y el log quedaba sin `usuarioId`.
const { msgErr } = require('../lib/error-monitor');

/**
 * Cola para el aviso de vencimiento cuando además se le soltó el Gmail.
 *
 * Va acá y no dentro de `mensajeMuro` a propósito: ese formateador ramifica por `trial_estado`
 * y ya produjo un bug caro por decidir con una fila incompleta. Se queda puro. Acá la línea es
 * condicional al RESULTADO real de la revocación, no a una suposición sobre el usuario.
 *
 * Desconectar en silencio algo que el usuario conectó a propósito se lee como un bug la
 * próxima vez que abre /dashboard/pro y ve "Conecta tu Gmail" sin explicación.
 */
function avisoGmailDesconectado(revocadas) {
  if (!revocadas) return '';
  return '\n\n📧 También desconectamos tu Gmail. Al renovar lo reconectas en un clic.';
}

async function checkResumenMensual() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getDate() !== 1 || horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    // Sin filtro por gmail_access_token: el resumen se arma con transacciones, presupuestos,
    // metas y deudas — no depende de Gmail. Exigirlo dejaba fuera a la mayoria de usuarios Pro
    // en silencio. Si no hay movimientos, generarResumenMensual ya devuelve null.
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios').select('*').eq('plan', 'premium').is('cuenta_borrada_at', null);
    if (errUsuarios) log.error({ tag: 'MENSUAL', err: errUsuarios.message }, 'Query usuarios fallo: el resumen mensual no se envio a nadie');
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenMensual(usuario);
        if (resumen) {
          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'resumen_mensual', mensaje: resumen,
            titulo: 'Tu resumen mensual',
            cuerpo: resumen.replace(/[*_]/g, '').substring(0, 400),
            link: '/dashboard',
          });
        }
      } catch(e) { log.error({ tag: 'MENSUAL', whatsapp: usuario.whatsapp, err: msgErr(e) }, 'Error resumen mensual usuario'); }
    }
  } catch(e) { log.error({ tag: 'MENSUAL', err: msgErr(e) }, 'Error general resumen mensual'); }
}

async function checkResumenSemanal() {
  const horaLima = new Date(Date.now() - 5 * 60 * 60 * 1000);
  if (horaLima.getUTCDay() !== 1 || horaLima.getUTCHours() !== 8 || horaLima.getUTCMinutes() > 14) return;
  try {
    // Mismo criterio que el resumen mensual: sin filtro por gmail_access_token.
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios').select('*').eq('plan', 'premium').is('cuenta_borrada_at', null);
    if (errUsuarios) log.error({ tag: 'SEMANAL', err: errUsuarios.message }, 'Query usuarios fallo: el resumen semanal no se envio a nadie');
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenSemanal(usuario);
        if (resumen) {
          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'resumen_semanal', mensaje: resumen,
            titulo: 'Tu resumen semanal',
            cuerpo: resumen.replace(/[*_]/g, '').substring(0, 400),
            link: '/dashboard',
          });
        }
      } catch(e) { log.error({ tag: 'SEMANAL', whatsapp: usuario.whatsapp, err: msgErr(e) }, 'Error resumen semanal usuario'); }
    }
  } catch(e) { log.error({ tag: 'SEMANAL', err: msgErr(e) }, 'Error general resumen semanal'); }
}

/**
 * Recordatorio de inactividad — UPDATE-08
 *
 * Antes era un recordatorio DIARIO ("¿registraste tus gastos hoy?") que se
 * mandaba todos los dias a usuarios Pro sin tx hoy. Sustituido por:
 *
 *   - Cadencia: 1 mensaje cada 3 dias de inactividad (no diario)
 *   - Aplica a TODOS los usuarios con onboarding completo + recordatorios_activos
 *     (antes solo Pro). Free ya no recibia este cron, ahora si — pero solo si
 *     llevan 3+ dias sin tx, no diariamente
 *   - Anti-fatiga via survey_events: skip si recibio CUALQUIER mensaje proactivo
 *     en los ultimos 3 dias (incluye otros triggers de UPDATE-05/06/07)
 *   - Visible en /admin/surveys con event_type = 'inactivity_reminder'
 *
 * Adicional: el upsell a Pro de dia 28-30 (que estaba dentro del mismo cron)
 * tambien se migra a survey_events como pro_upsell_d28 one-shot.
 */
/**
 * Los canales de `survey_events` que cuentan como EMPUJE para la anti-fatiga.
 *
 * Hasta el 27-ago-2026 los dos lectores preguntaban `.eq('channel', 'whatsapp')`, y eso era
 * correcto solo porque el cron cortaba antes a quien no tenía número: no existía un empuje que
 * no fuera de WhatsApp. Al sacar ese corte (item 14) el aviso empezó a salir por la campana
 * sola, y escribir `channel: 'whatsapp'` sobre esa fila habría sido mentir en la columna de la
 * que dependen los dos dedup.
 *
 * `webapp` queda AFUERA a propósito y no por olvido: es lo que usa `nps_inapp`, una encuesta
 * que se muestra dentro de la app cuando la persona ya está ahí. Eso no es un empuje y no
 * debería gastar la ventana de fatiga de los ocho triggers.
 *
 * **El cambio es demostrablemente inocuo para los datos que ya existen**: al 27-ago hay 396
 * filas y ninguna con `in_app` (396 `whatsapp` + 6 `webapp`), así que este `.in()` selecciona
 * exactamente lo mismo que el `.eq()` anterior. Solo empieza a diferir sobre filas nuevas —
 * que son justo las del usuario web-first.
 */
const CANALES_EMPUJE = ['whatsapp', 'in_app'];

async function checkRecordatorioDiario() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 20 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios')
      // `supabase_auth_id` alimenta `llegoElAviso` más abajo: sin él la guarda decidiría con
      // `undefined` y nunca abriría la ventana. Es la regla "una fila parcial no puede
      // decidir" de `app/CLAUDE.md` — si tu select alimenta una decisión, trae TODAS las
      // columnas que esa decisión mira.
      .select('id, whatsapp, nombre, plan, recordatorios_activos, created_at, supabase_auth_id')
      .eq('onboarding_completado', true);
    // Sin leer el error, una caída de Supabase acá se lee como "no hay nadie a quien
    // recordarle nada" y la corrida de las 8pm se apaga entera sin dejar nada.
    //
    // **Y lo que deja este log es una línea en stdout de Railway, NO una fila en `errores`.**
    // La distinción importa porque el runbook manda a consultar esa tabla: el único que
    // escribe ahí es `registrarError` (`lib/error-monitor.js`), y este archivo no lo importa.
    // Enrutar los errores de los crons a la tabla es un trabajo aparte, no este.
    if (errUsuarios) {
      log.error({ tag: 'INACTIVITY', err: errUsuarios.message }, 'No se pudo leer la población: no se envió ningún recordatorio');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;

    let totalInactivity = 0;
    let totalUpsell = 0;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        // Acá había un `if (!usuario.whatsapp) continue;`. Se fue el 27-ago-2026 (item 14) y
        // el motivo es que **no protegía nada**: el envío de abajo declara `CANALES.AMBOS`, y
        // `notificarUsuario` maneja `whatsapp: null` sin ayuda (deja `skipped_no_whatsapp` en
        // el ledger y escribe la campana igual). Lo único que hacía el corte era apagar la
        // mitad in-app para quien no tiene número — 14 usuarios reales al 27-ago, **los 14 con
        // cuenta web donde ver la campana y los 14 con los recordatorios prendidos**.
        //
        // Lo que el corte SÍ hacía sin decirlo, y por eso se verificó antes de sacarlo: tapaba
        // de rebote a las cuentas borradas, cuyo `whatsapp` queda en NULL por el wipe. Sigue
        // tapado, y ahora por dos gates que lo dicen a propósito — la migración 073 pone
        // `recordatorios_activos = false` **y** `onboarding_completado = false` en la lápida, y
        // este cron filtra por los dos. Verificado sobre las 3 lápidas vivas: 0 pasan.

        const planConfig = getUserPlanConfig(usuario);
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
        const diasDesdeRegistro = Math.floor((Date.now() - new Date(usuario.created_at).getTime()) / 86400000);

        // Anti-fatiga: skip si recibio cualquier EMPUJE en los ultimos 3 dias.
        //
        // Tiene que aceptar los mismos canales que escribe el insert de mas abajo, o el dedup
        // deja de encontrar su propia marca. Ese desajuste manda el aviso TODOS LOS DIAS al
        // usuario sin numero: la fila se escribe con `in_app`, este `select` busca solo
        // `whatsapp`, no la encuentra, y vuelve a mandar mañana.
        const cutoff3d = new Date(Date.now() - 3 * 86400000).toISOString();
        const { data: recentEvents, error: errFatiga } = await supabase.from('survey_events')
          .select('id').eq('user_id', usuario.id).in('channel', CANALES_EMPUJE)
          .gte('sent_at', cutoff3d).limit(1);
        // Esta es de las que fallan ABIERTO: sin leer el error, `recentEvents` viene null,
        // `recibioMensajeReciente` queda en false y el cron manda **igual**. O sea que una
        // caída de Supabase no silencia el aviso, lo DISPARA — justo contra la población que
        // el anti-fatiga protege. Se salta este usuario y se reintenta a la noche siguiente.
        if (errFatiga) throw errFatiga;
        const recibioMensajeReciente = recentEvents && recentEvents.length > 0;

        // ===== Pro upsell (one-shot, dias 28-30 desde registro) =====
        if (!planConfig.recordatorios && diasDesdeRegistro >= 28 && diasDesdeRegistro <= 30) {
          if (recibioMensajeReciente) continue;

          // El copy vendía el Free viejo ("historial completo, no solo este mes"), que
          // describía un plan gratuito permanente que ya no existe: hoy `free` ES el muro
          // y no tiene historial ninguno. A quien le llega esto ya terminó su prueba, así
          // que lo que hay que nombrar es lo que perdió, no un límite que nunca tuvo.
          const upsellMsg = '🎉 ' + (primerNombre ? primerNombre + ', ¡' : '¡') + 'llevas 1 mes usando Neto!\n\n' +
            'Sigo anotando todo lo que me mandas, y ahí está todo guardado. Con *Neto Pro* vuelves a verlo:\n\n' +
            '✅ Gráficos y desglose por categoría\n' +
            '✅ Historial completo, sin límite de meses\n' +
            '✅ Presupuestos, metas y reportes\n' +
            '✅ Lectura automática de tus correos bancarios\n\n' +
            lineaPrecioPro() + '\n\n' +
            '📲 Yapea al *970398192* y envíame la captura.\n\n' +
            '_Escribe /premium para más info._';

          // Idempotencia DB-level: one-shot via unique partial index
          const { data: insertResult, error: insertErr } = await supabase.from('survey_events').insert({
            user_id: usuario.id,
            event_type: 'pro_upsell_d28',
            // El canal REAL, no la etiqueta de siempre. Esta columna es lo que leen los dos
            // dedup, así que decir `whatsapp` sobre un aviso que salió solo por la campana
            // rompe a los dos a la vez. Ver CANALES_EMPUJE.
            channel: usuario.whatsapp ? 'whatsapp' : 'in_app',
            sent_at: new Date().toISOString(),
            message_sent: upsellMsg,
          }).select('id').single();
          if (insertErr) {
            if (insertErr.code === '23505') continue; // ya recibio el upsell antes
            throw insertErr;
          }

          // Es el mensaje comercial de mayor valor del producto y salía por el canal menos
          // fiable, así que va por los dos.
          //
          // Acá decía "a los 28-30 días casi siempre ya activó su cuenta web", y **es falso**:
          // de los 13 `pro_upsell_d28` enviados, **7 fueron a usuarios sin cuenta web**. Esa
          // suposición es justo la que hacía inofensivo el bug de `llegoElAviso` (B23) a los
          // ojos de quien lo leía.
          const avisadoUpsell = await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'pro_upsell_d28', mensaje: upsellMsg,
            titulo: 'Llevas 1 mes usando Neto',
            link: '/dashboard/pro',
          });
          // Misma guarda que los avisos de vencimiento (ver `llegoElAviso`): sin un lugar donde
          // el aviso lo espere, no se abre la ventana de 48h que convierte toda foto en
          // "captura de pago". Este call-site se había quedado sin ella (B14), y es el peor de
          // los cuatro para no tenerla: el destinatario acaba de terminar su prueba, o sea que
          // lleva días sin escribir, y de esos 13 envíos ni uno figura entregado.
          if (llegoElAviso(avisadoUpsell, usuario)) await solicitarComprobante(usuario.id);
          totalUpsell++;
          continue;
        }

        if (!planConfig.recordatorios) continue;

        // ===== Inactivity reminder (Pro: cada 3 dias de inactividad) =====
        // Buscar la ultima transaccion del usuario
        const { data: ultimaTx, error: errUltimaTx } = await supabase.from('transacciones')
          .select('fecha').eq('usuario_id', usuario.id)
          .order('fecha', { ascending: false }).limit(1);
        // Falla cerrado por accidente: sin leer el error, `ultimaTx` null cae en el
        // `continue` de abajo como si el usuario nunca hubiera anotado nada. La decisión
        // resultante es la correcta; lo que faltaba era el rastro de que se tomó por un fallo.
        if (errUltimaTx) throw errUltimaTx;

        const ultimaFecha = ultimaTx && ultimaTx.length > 0 ? ultimaTx[0].fecha : null;
        if (!ultimaFecha) continue; // nunca uso, ya cubre wake_up_inactive/onboarding

        const diasSinTx = Math.floor((Date.now() - new Date(ultimaFecha + 'T12:00:00').getTime()) / 86400000);
        if (diasSinTx < 3) continue; // sigue activo

        if (recibioMensajeReciente) continue; // anti-fatiga

        const msg = (primerNombre ? primerNombre + ', hace' : 'Hace') + ' ' + diasSinTx + ' días que no registras nada en Neto.\n\n' +
          '¿Algo te complica o solo se te pasó? Recuerda que puedes:\n' +
          '• Escribirme un gasto: _"almuerzo 25 soles"_\n' +
          '• Mandarme foto de tu Yape/Plin\n\n' +
          '_Si prefieres pausar recordatorios escribe /silenciar_';

        // Registrar en survey_events ANTES de enviar.
        //
        // Esto NO es un audit trail, aunque se escribio como si lo fuera: esta fila es el
        // dedup. La lee el corte de 3 dias de este mismo cron (`recentEvents`) y el de 7 dias
        // de `recibioMensajeRecienteProactivo` en survey-triggers. Si el insert falla callado,
        // el mensaje sale igual y manana sale otra vez, porque no quedo la marca de que salio.
        const { error: errMarca } = await supabase.from('survey_events').insert({
          user_id: usuario.id,
          event_type: 'inactivity_reminder',
          channel: usuario.whatsapp ? 'whatsapp' : 'in_app',   // ver CANALES_EMPUJE
          sent_at: new Date().toISOString(),
          message_sent: msg,
          response_data: { dias_sin_tx: diasSinTx },
        });
        // Se salta al usuario ANTES de mandar: sin marca, mandar es comprometerse a repetir.
        // El orden importa y por eso el insert va antes del envio, no despues.
        if (errMarca) {
          log.error({ tag: 'INACTIVITY', userId: usuario.id, err: errMarca.message }, 'No se pudo marcar el dedup: no se envia el recordatorio para no repetirlo manana');
          continue;
        }

        // El destinatario es Pro y lleva >=3 días sin escribir: por construcción, la
        // población con más chances de estar fuera de la ventana de 24h de Meta. El mensaje
        // que persigue a un inactivo era justo el que menos se entregaba.
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'inactivity', mensaje: msg,
          titulo: 'Hace ' + diasSinTx + ' días que no registras nada',
          tipoInApp: 'recordatorio', link: '/dashboard',
        });
        totalInactivity++;
        // Saltar al siguiente usuario sigue siendo correcto, pero sin log un fallo
        // SISTEMÁTICO acá se ve igual que "nadie estaba inactivo": el contador de abajo
        // solo cuenta éxitos, así que un error de scope o una query caída dejaban la
        // corrida entera de las 8pm en cero sin una línea en `log.error` ni en `errores`.
        // Lo encontró la prueba por mutación de la Ola 2 (B25), no una corrida verde — y
        // la ironía útil: si el error hubiera estado acá, el barrido que MIDIÓ B23 no
        // habría tenido con qué medirlo.
      } catch(e) { log.error({ tag: 'INACTIVITY', userId: usuario.id, err: msgErr(e) }, 'Error procesando usuario en el recordatorio de las 8pm'); }
    }

    if (totalInactivity > 0 || totalUpsell > 0) {
      log.info({ tag: 'INACTIVITY', inactivity: totalInactivity, upsell: totalUpsell, candidates: usuarios.length },
        'Recordatorios de inactividad enviados');
    }
  } catch(e) { log.error({ tag: 'INACTIVITY', err: msgErr(e) }, 'Error recordatorio inactividad'); }
}

// Este cron NUNCA puede tocar a alguien que está corriendo su prueba. La invariante que lo
// separaba del trial era "durante el trial premium_vence queda NULL", pero eso es un dato y
// los datos se ensucian: un ex-pagador que arranca un trial trae el premium_vence de su
// suscripción anterior, y sus tres queries lo agarraban. Pasó de verdad el 2026-08-01 — el
// trial duró 78 minutos y el usuario recibió "tu plan Pro venció, ahora estás en Free".
//
// `iniciarTrialSiCorresponde` ahora limpia esa columna, así que este filtro es la segunda
// red y no la primera. Va igual porque el downgrade es la operación destructiva: si las dos
// fallan, alguien pierde acceso pagado o prometido.
//
// Se escribe con `.or()` y no con `.neq()` porque `.neq('trial_estado','activo')` descarta
// las filas con la columna en NULL (`NULL <> 'activo'` es NULL en SQL), que son la mayoría.
const SIN_TRIAL_ACTIVO = 'trial_estado.is.null,trial_estado.neq.activo';

/**
 * ¿Hay una superficie donde este aviso esté esperando al usuario? Es el permiso para hacer
 * cosas que solo tienen sentido si la persona se puede enterar — hoy, abrir la ventana de
 * comprobante, que durante 48h convierte toda foto en "captura de pago".
 *
 * **La pregunta se responde con lo que se sabe AHORA, y de WhatsApp ahora no se sabe nada.**
 * Ese es el hallazgo B23, y es más grande de lo que parecía: la versión anterior contaba dos
 * cosas como entrega y las dos eran falsas.
 *
 * | término viejo | por qué no era entrega | medido el 14-ago-2026 |
 * |---|---|---|
 * | `res.inApp === true` | significa "la fila se escribió", no "hay campana donde verla" | 92 filas in-app de **21 usuarios sin cuenta web**; 44 de 106 son WhatsApp-only |
 * | `wa.ok === true && !wa.skipped` | significa "Meta aceptó el POST" | de 260 envíos proactivos desde el 01-ago, **40 entregados (15%)** y 219 fallidos |
 *
 * El segundo era el dominante y nadie lo vio, porque el comentario de este archivo afirmaba
 * que Meta rechaza el texto libre devolviendo `{ok:false, code:131047}`. **En producción no
 * pasa eso**: Meta devuelve 200 con wamid y el 131047 llega DESPUÉS, como callback de status.
 * Filas con `estado='blocked_24h'` (el rechazo síncrono) en toda la historia: **0**. Filas con
 * `fail_code=131047` (el asíncrono) desde el 01-ago: **214**. O sea que ese término daba
 * `true` para los 260, y arreglar solo el término in-app no habría cambiado nada para los 44
 * WhatsApp-only, que es exactamente la población del hallazgo.
 *
 * Sobre los 4 tipos que gatean esto (`pro_upsell_d28`, `premium_expiry_3d`/`_hoy`,
 * `premium_expired`): 25 envíos en toda la historia, **0 entregados confirmados**, 10 fallidos.
 *
 * Así que queda un solo término, y es el único comprobable en el instante de decidir: **la
 * fila in-app se escribió Y el usuario tiene cuenta web donde verla**. La campana es durable
 * (se queda ahí hasta que la lea), así que "alcanzable" acá sí equivale a "le va a llegar".
 *
 * Lo que WhatsApp pierde con esto: para los 44 WhatsApp-only la ventana ya no la abre un cron.
 * La puerta pasa a ser `/premium`, y esa **siempre** funciona — si el usuario escribe, está
 * dentro de la ventana de 24h de Meta por construcción, así que la respuesta se entrega.
 * Decisión de Favio, 14-ago-2026.
 *
 * @param {{wa?:object, inApp?:boolean}} res  lo que devolvió `notificarUsuario` de ESE aviso
 * @param {{supabase_auth_id?:string}} usuario  la fila del destinatario de ESE aviso
 */
function llegoElAviso(res, usuario) {
  if (!res || !usuario) return false;
  return res.inApp === true && !!usuario.supabase_auth_id;
}

async function checkPremiumExpiry() {
  try {
    const hoy = hoyPeru();
    const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));

    // Avisos de vencimiento (3d antes + día exacto).
    // El cron corre cada 1h; sin dedup esto disparaba las 24 corridas del día (bug: 24
    // notificaciones idénticas por usuario). La idempotencia por día contra `notificaciones`
    // es lo que corta el 24x; el gate horario (>=8am) solo evita mandar de madrugada y permite
    // catch-up si se cae una corrida (sale en la primera corrida del día a partir de las 8am).
    if (horaLima.getHours() >= 8) {
      const en3dias = new Date(new Date(hoy + 'T12:00:00').getTime() + 3 * 86400000).toISOString().split('T')[0];
      const inicioHoy = new Date(hoy + 'T00:00:00-05:00').toISOString();
      // `supabase_auth_id`: ver `llegoElAviso`. Sin esa columna la guarda de más abajo decide
      // con `undefined` y la ventana de comprobante no se abre nunca, ni para quien sí tiene
      // campana.
      const { data: porVencer, error: errPorVencer } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence, supabase_auth_id')
        .eq('plan', 'premium').eq('premium_vence', en3dias)
        .is('cuenta_borrada_at', null)
        .or(SIN_TRIAL_ACTIVO);
      // Sin esto, una caída se lee como "hoy no vence nadie en 3 días" — que es el caso
      // normal la mayoría de los días, o sea el silencio más fácil de confundir con salud.
      if (errPorVencer) log.error({ tag: 'EXPIRY_WARN', err: errPorVencer.message }, 'No se pudo leer a quién le vence en 3 días: nadie fue avisado');
      if (porVencer && porVencer.length > 0) {
        for (const usuario of porVencer) {
          try {
            // Dedup: ¿ya avisamos hoy a este usuario?
            // El dedup falla ABIERTO, y por eso es de los pocos que cambian de comportamiento
            // acá: sin leer el error, `yaAviso` null significa "todavía no le avisamos" y el
            // cron re-manda. Es B6 con otra causa — este cron corre cada hora con gate >=8am,
            // así que una Supabase intermitente se convierte en hasta 16 avisos idénticos en
            // un día. Ante la duda se asume que YA se avisó: perder un aviso de vencimiento
            // duele menos que 16, y el catch-up del día siguiente lo recupera si el usuario
            // sigue a 3 días. Fuera de eso queda `/premium`, que siempre funciona.
            const { data: yaAviso, error: errDedup } = await supabase.from('notificaciones')
              .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
              .eq('titulo', 'Plan Pro vence en 3 días').gte('fecha', inicioHoy).limit(1);
            if (errDedup) {
              log.error({ tag: 'EXPIRY_WARN', userId: usuario.id, err: errDedup.message }, 'No se pudo comprobar el dedup: no se reenvía el aviso de 3 días');
              continue;
            }
            if (yaAviso && yaAviso.length > 0) continue;

            const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
            const avisado3d = await notificarUsuario({
              canales: CANALES.AMBOS,
              usuarioId: usuario.id, whatsapp: usuario.whatsapp,
              tipo: 'premium_expiry_3d',
              mensaje: '⚠️ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* vence en 3 días (' + usuario.premium_vence + ').\n\n¿Quieres renovar?\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.\n\n_Renueva antes para no perder acceso._',
              // El título es la clave del dedup de arriba: cambiarlo sin cambiar esa query
              // reintroduce el bug de 24 notificaciones idénticas por día.
              titulo: 'Plan Pro vence en 3 días', tipoInApp: 'recordatorio',
              // La fila in-app ES el marcador que lee el dedup de arriba. Sin esto se escribe
              // DESPUÉS del WhatsApp, así que un insert fallido dejaba el dedup ciego y este
              // cron horario re-mandaba el mismo aviso en cada corrida desde las 8am (B6).
              claimInApp: true,
              cuerpo: 'Tu plan NETO Pro vence el ' + usuario.premium_vence + '. Renueva para no perder acceso.',
              link: '/dashboard/configuracion',
            });
            // Solo se abre la espera de comprobante si el aviso tiene DÓNDE esperarlo.
            //
            // `solicitarComprobante` pone `esperando_comprobante` por 48h, y en esa ventana
            // toda foto se lee como captura de pago: una que no parece el pago a Neto se
            // rechaza SIN registrar el gasto. Abrirla para alguien que nunca supo del aviso
            // le rompe el registro por foto sin decirle por qué — la trampa de B12.
            //
            // Este comentario tuvo dos versiones equivocadas antes. La primera cortaba solo
            // con `skipped !== 'claim_in_app_fallo'`, el modo de falla raro. La segunda —la que
            // estaba acá— decía que el modo FRECUENTE es Meta devolviendo `{ok:false,
            // code:131047}` sin `skipped`, y **eso no ocurre**: Meta acepta el POST y el 131047
            // llega después como callback de status. Cero filas `blocked_24h` en toda la
            // historia contra 214 con `fail_code=131047` desde el 01-ago. Ver `llegoElAviso`.
            if (llegoElAviso(avisado3d, usuario)) await solicitarComprobante(usuario.id);
          } catch(e) { log.error({ tag: 'EXPIRY_WARN', userId: usuario.id, err: msgErr(e) }, 'Error warning premium 3d'); }
        }
      }

      // Aviso "vence HOY" — el día exacto del vencimiento (antes no existía: había 3d antes y
      // el downgrade al día siguiente, pero nada el día clave). Free-form + in-app, dedup por día.
      const { data: venceHoy, error: errVenceHoy } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence, supabase_auth_id')
        .eq('plan', 'premium').eq('premium_vence', hoy)
        .is('cuenta_borrada_at', null)
        .or(SIN_TRIAL_ACTIVO);
      if (errVenceHoy) log.error({ tag: 'EXPIRY_HOY', err: errVenceHoy.message }, 'No se pudo leer a quién le vence hoy: nadie fue avisado');
      if (venceHoy && venceHoy.length > 0) {
        for (const usuario of venceHoy) {
          try {
            // Ver el dedup del aviso de 3 días: falla abierto y este cron es horario.
            const { data: yaAvisoHoy, error: errDedupHoy } = await supabase.from('notificaciones')
              .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
              .eq('titulo', 'Plan Pro vence hoy').gte('fecha', inicioHoy).limit(1);
            if (errDedupHoy) {
              log.error({ tag: 'EXPIRY_HOY', userId: usuario.id, err: errDedupHoy.message }, 'No se pudo comprobar el dedup: no se reenvía el aviso de vence hoy');
              continue;
            }
            if (yaAvisoHoy && yaAvisoHoy.length > 0) continue;

            const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
            const avisadoHoy = await notificarUsuario({
              canales: CANALES.AMBOS,
              usuarioId: usuario.id, whatsapp: usuario.whatsapp,
              tipo: 'premium_expiry_hoy',
              mensaje: '🔔 ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* vence *hoy*.\n\nRenuévalo hoy para no perder acceso.\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.',
              titulo: 'Plan Pro vence hoy', tipoInApp: 'recordatorio',
              claimInApp: true, // ver el aviso de 3 días (B6)
              cuerpo: 'Tu plan NETO Pro vence hoy. Renueva para no perder acceso.',
              link: '/dashboard/configuracion',
            });
            // Ver el aviso de 3 días: sin aviso entregado no se abre la ventana de 48h que
            // convierte toda foto en "captura de pago".
            if (llegoElAviso(avisadoHoy, usuario)) await solicitarComprobante(usuario.id);
          } catch(e) { log.error({ tag: 'EXPIRY_HOY', userId: usuario.id, err: msgErr(e) }, 'Error aviso vence hoy'); }
        }
      }
    }

    // Expirados — downgrade a free
    const { data: expirados, error: errExpirados } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence, estado_pago, supabase_auth_id')
      .eq('plan', 'premium').not('premium_vence', 'is', null).lt('premium_vence', hoy)
      .is('cuenta_borrada_at', null)
      .or(SIN_TRIAL_ACTIVO);
    // No hacer nada acá es lo correcto (el downgrade se reintenta a la hora siguiente), pero
    // sin log una caída sostenida deja a ex-pagadores con Pro abierto sin que nada lo diga.
    if (errExpirados) {
      log.error({ tag: 'EXPIRY', err: errExpirados.message }, 'No se pudo leer a los expirados: no se downgradeó a nadie');
      return;
    }
    if (!expirados || expirados.length === 0) return;
    for (const usuario of expirados) {
      try {
        // `estado_pago` viaja con el plan. Bajar solo `plan` dejaba a un ex-pagador
        // con `estado_pago='pagado'` para siempre: la columna pasaba a significar
        // "alguna vez pagó" en vez de "está pagado", y quedaba lista para que la
        // primera lectura que gatee por ella sola le entregue Pro gratis. Ya hay 2
        // usuarios post-churn en ese estado (hallazgo D3 de la auditoría 03-ago).
        //
        // Solo se toca cuando venía en 'pagado', y por dos motivos: acá también caen
        // Pro que nunca pagaron (meses de referido, comps) —marcarlos 'vencido' los
        // haría figurar como pagadores que churnearon en el panel y en el CSV— y un
        // comprobante recién subido deja 'pendiente', que este cron pisaría, borrando
        // el ⏳ de un pago que sigue esperando aprobación.
        //
        // 'vencido' y no null: el CHECK de la columna tiene ese valor justamente
        // para esto, y borrarlo perdería que sí llegó a pagar. La invariante que
        // importa —y la que fija el test— es que después del downgrade NO puede
        // quedar en 'pagado'.
        const cambios = { plan: 'free' };
        if (usuario.estado_pago === 'pagado') cambios.estado_pago = 'vencido';
        // Leer el error NO es ceremonia: si este UPDATE no entra y seguimos, revocamos
        // el Gmail (irreversible: el cupo de Google no vuelve) y le avisamos "tu plan
        // venció" a alguien que en la base sigue en 'premium' — y a la hora siguiente
        // el cron lo vuelve a seleccionar y repite el ciclo entero, cada hora, para
        // siempre. Mejor saltarlo y reintentar en la próxima corrida.
        const { error: errDown } = await supabase.from('usuarios').update(cambios).eq('id', usuario.id);
        if (errDown) {
          log.error({ tag: 'EXPIRY', userId: usuario.id, err: errDown.message }, 'No se pudo downgradear: se salta (sin revocar Gmail ni avisar)');
          continue;
        }
        // Bajar el plan corta la LECTURA de correos, pero el grant seguía vivo en Google y el
        // cupo ocupado para siempre. Se suelta acá mismo, sin gracia.
        const { revocadas } = await revocarAccesoGmail(usuario.id, { motivo: 'premium_vencido' });
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
        const avisadoExpirado = await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'premium_expired',
          // El copy describía el freemium MUERTO ("el plan Free, historial limitado a 1 mes").
          // Hoy `free` no es un plan con límites: es el MURO. Y lo que sigue abierto —anotar
          // gastos, para siempre— es justo lo que hay que decirle a alguien que acaba de
          // perder el acceso, o entiende que Neto dejó de servirle y se va. Es el mismo
          // residual que M10 sacó del bot en la ola 3; este vivía en el cron.
          mensaje: '⏰ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* venció.\n\nSigo anotando tus gastos por acá, gratis y sin límite. Lo que queda cerrado es el dashboard, el historial y los reportes.\n\n¿Quieres renovar?\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.\n\n_No se borra nada. Al renovar recuperas acceso completo._' + avisoGmailDesconectado(revocadas),
          titulo: 'Plan Pro expirado',
          cuerpo: 'Tu plan NETO Pro venció. Sigo anotando tus gastos; el dashboard y el historial quedan cerrados hasta que renueves.',
          link: '/dashboard/configuracion',
        });
        // Misma guarda que los avisos de 3d y de hoy (ver `llegoElAviso`): abrir la ventana de
        // comprobante a quien no se enteró del aviso le rompe el registro por foto durante 48h
        // sin decirle por qué. Este call-site se había quedado sin ella (B14).
        if (llegoElAviso(avisadoExpirado, usuario)) await solicitarComprobante(usuario.id);
        log.info({ tag: 'EXPIRY', userId: usuario.id }, 'Premium expirado, downgradeado a free');
      } catch(e) { log.error({ tag: 'EXPIRY', userId: usuario.id, err: msgErr(e) }, 'Error downgradeando usuario'); }
    }
  } catch(e) { log.error({ tag: 'EXPIRY', err: msgErr(e) }, 'Error general check premium expiry'); }
}

async function checkAlertasProactivas() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getDay() !== 3 || horaLima.getHours() !== 10 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('onboarding_completado', true);
    if (errUsuarios) {
      log.error({ tag: 'ALERTA_PROACTIVA', err: errUsuarios.message }, 'No se pudo leer la población: no salió ninguna alerta de presupuesto');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        // El muro es de LECTURA, y esto es una lectura: el mensaje dice cuánto llevas
        // gastado de tu límite por categoría y cuánto bajó tu score. `ver_presupuesto` y
        // `ver_neto_score` están los dos en INTENTS_LECTURA, o sea que por WhatsApp se
        // cobran — pero este cron los empujaba gratis, y encima sin que el usuario los
        // pidiera. Eran 6 usuarios en el muro recibiéndolo cada miércoles.
        if (estaEnMuro(usuario)) continue;
        const alerta = await verificarAlertasProactivas(usuario.id, usuario.nombre);
        if (alerta) {
          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'alerta_presupuesto', mensaje: alerta,
            titulo: 'Alerta de presupuesto', tipoInApp: 'recordatorio',
            link: '/dashboard/presupuestos',
          });
        }
      } catch (e) { log.error({ tag: 'ALERTA_PROACTIVA', userId: usuario.id, err: msgErr(e) }, 'Alerta de presupuesto omitida para el usuario'); }
    }
  } catch (e) { log.error({ tag: 'ALERTA_PROACTIVA', err: msgErr(e) }, 'Error alertas proactivas'); }
}

/**
 * El empujón a quien se dio de alta y todavía no anotó NADA.
 *
 * **El criterio es "no tiene ni una transacción", no `onboarding_completado`**, y
 * ese cambio se pagó con 12 días de silencio. Hasta el 17-ago-2026 esta función
 * seleccionaba con `onboarding_completado.eq.false`, que describía bien al usuario
 * del alta VIEJA (nombre → email → plan, varios mensajes en los que la columna
 * seguía en false). Desde el alta reordenada del 31-jul (`3c992bb`, migración 051)
 * `completarAlta()` la pone en **true** apenas la persona da su nombre o dice
 * "saltar", así que el que completa el alta y no anota nada quedaba FUERA del
 * filtro — que es exactamente a quien este mensaje apunta.
 *
 * Medido antes de tocar nada: último envío de tipo `onboarding` el **5-ago**, con
 * 22 altas posteriores; de los 8 usuarios de agosto que nunca registraron una
 * transacción, **ninguno** recibió esto y cuatro no recibieron absolutamente nada.
 * El cron corría, no fallaba y no logueaba error: simplemente su población se
 * había vaciado porque cambió el significado de una columna en otro archivo.
 *
 * **El piso de 3h no es estético: es lo que hace esto entregable.** El WhatsApp
 * libre sólo sale dentro de las 24h desde el último mensaje del usuario, y acá esa
 * ventana está abierta por construcción (se acaba de dar de alta). El contraste
 * está medido en `notification_deliveries`: `activacion_ok` entrega 8 de 8 porque
 * va pegado a un mensaje de la persona, mientras los `survey_wake_up_*`, que
 * persiguen inactivos de semanas, entregan **0 de 28**.
 *
 * **El techo pasó de 6h a 18h el 20-ago-2026, y eso NO contradice lo de arriba.**
 * Con 6h, el gate de 9-21h dejaba a la mitad del producto sin recibir esto jamás:
 * quien se da de alta a las 18:00 madura a las 21:00, justo cuando el gate cierra,
 * y a las 9am del día siguiente ya pasó de las 6h. La ventana no volvía a abrirse.
 * **Medido: 54 de 106 usuarios reales (50.9%) se dieron de alta entre las 18:00 y
 * las 02:59 Lima**, o sea que el agujero era la mitad del padrón, no un borde.
 *
 * El 18 sale de la aritmética, no de un número redondo: el gate está cerrado 12h
 * (21:00→09:00) y el piso son 3h. La espera máxima es de **15h14m**, y el peor caso
 * no es el alta de las 18:00 sino la de las **17:46**: madura 20:46, le quedan 14
 * minutos de gate y el tick es cada 15, así que puede no caer ahí y esperar hasta
 * las 09:00. Los ~2h45 restantes son margen para una caída del cron.
 *
 * **Dentro de las 24h de Meta — pero eso vale para la rama `SOLO_WHATSAPP`, no para
 * las dos.** El reloj de Meta arranca en el último mensaje de la persona. Para un
 * usuario sin cuenta web el alta ES un mensaje suyo (las únicas dos vías que crean
 * una fila de `usuarios` son `obtenerOCrearUsuario`, que sólo se llama desde el
 * webhook, y el alta web, que siempre pone `supabase_auth_id`), así que su último
 * mensaje es posterior o igual a `created_at` y a 18h quedan 6h de sobra. Ahí la
 * cota se demuestra. **En la rama `AMBOS` no**: `merge_and_link` conserva la fila
 * WEB como superviviente, así que un alta web que fusiona un número viejo queda con
 * `created_at` de hoy y último mensaje entrante de hace meses. A esa gente la mitad
 * de WhatsApp puede irse en 131047 igual — pero le llega la campana, que es
 * justamente por lo que esa rama es `AMBOS`.
 *
 * **Dependencia que ahora tiene guard, y hasta el 26-ago-2026 sólo tenía este párrafo:**
 * `usuarios.created_at` es `timestamp WITHOUT time zone` y esto compara contra
 * `toISOString()`. PostgREST castea el `...Z` descartando el offset, así que la
 * aritmética de arriba sólo es correcta mientras el GUC `TimeZone` de la base sea UTC.
 * Con `America/Lima` la ventana entera se corre 5h en silencio.
 *
 * Un test no puede vigilarlo —la suite mockea Supabase, así que el GUC real no participa
 * y `tests/cron/nudge-primer-gasto.test.js` pasa idéntico con la base en cualquier zona—
 * y el GUC se cambia desde el dashboard, sin un commit. O sea que es del canary:
 * `qa-e2e/qa-reloj-ventanas.mjs` (migración 075). Mide el HECHO, no el nombre de la zona:
 * lo que la columna guardaría contra lo que esta ventana compara, más el offset en enero
 * y en julio, porque una zona con horario de verano da 0 medio año y se corre sola el otro
 * medio. Verificado en rojo contra `America/Lima` y contra `Atlantic/Azores`.
 *
 * Ensanchar el techo **no cambia nada** para quien madura con el gate abierto: el
 * cron corre cada 15 minutos y lo agarra a las 3h igual. Sólo rescata a quien maduró
 * de madrugada. Y no produce un blast de una sola vez — medido antes de shipear:
 * con la ventana de 18h enganchaban **0 usuarios** en ese momento.
 *
 * Lo que sigue vigente: no lo muevas a 24h+ sin asumir que dejará de entregarse por
 * WhatsApp. Ahí ya no hay ventana de Meta que valga y el canal pasa a ser la campana.
 *
 * **El ledger es `notification_deliveries`**, no una columna de `usuarios`. Antes
 * se marcaba pisando `onboarding_paso` a 100, y con el criterio nuevo eso sería un
 * bug de verdad: `manejarOnboarding` trata el siguiente mensaje de un usuario en
 * paso 100 como su NOMBRE, así que el primer gasto de alguien con el alta ya
 * cerrada se convertiría en su nombre en vez de registrarse.
 */
async function checkRecordatorioOnboarding() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() < 9 || horaLima.getHours() >= 21) return;
  try {
    // Techo y piso: ver el docblock. El techo cubre la espera máxima que puede imponer el gate
    // (12h cerrado + 3h de piso = 15h) más margen; el piso es lo que evita escribirle a alguien
    // que se dio de alta hace diez minutos. El dedup por `notification_deliveries` es lo que
    // hace que una ventana ancha no signifique varios avisos: sigue siendo uno por persona.
    const HORAS_TECHO = 18;
    const HORAS_PISO = 3;
    const techo = new Date(Date.now() - HORAS_TECHO * 60 * 60 * 1000).toISOString();
    const piso = new Date(Date.now() - HORAS_PISO * 60 * 60 * 1000).toISOString();
    const { data: candidatos, error: errCand } = await supabase.from('usuarios')
      // `supabase_auth_id` decide el canal del nudge (ver la bifurcación abajo), no es adorno.
      // `recordatorios_activos` faltaba: mientras el nudge salía solo por WhatsApp a gente sin
      // cuenta web, nadie de esa población podía apagar el toggle. Con la rama in-app apunta
      // justo a quien SÍ tiene `/dashboard/configuracion` para apagarlo.
      // Medido: hay 3 filas en `false`, y las 3 ya estaban fuera por otra condición (2 lápidas
      // de cuentas borradas —la migración 073 lo pone en false— y 1 `is_test_user`). Usuarios
      // reales vivos con el toggle apagado: CERO. O sea que esto no cambia a quién le llega hoy;
      // cierra el agujero antes de que importe.
      .select('id, whatsapp, nombre, onboarding_paso, supabase_auth_id, recordatorios_activos')
      .gte('created_at', techo)
      .lte('created_at', piso)
      .neq('is_test_user', true)
      // Alguien que se dio de alta y borro su cuenta dentro de las 18h cae en esta ventana. La
      // lapida tiene `whatsapp` en null, asi que el envio seria un no-op — pero apoyarse en eso
      // es apoyarse en un efecto lateral de otra decision.
      .is('cuenta_borrada_at', null);
    // supabase-js no lanza: sin leer el error, una caída se lee igual que "no hay
    // nadie a quien empujar" y este cron se apaga en silencio por segunda vez.
    if (errCand) {
      log.error({ tag: 'ONBOARDING_REMINDER', err: errCand.message }, 'No se pudo leer a los candidatos del nudge');
      return;
    }
    if (!candidatos || candidatos.length === 0) return;

    const ids = candidatos.map((u) => u.id);
    // Las dos preguntas son de EXISTENCIA ("¿este ya anotó algo?", "¿a este ya se le avisó?"),
    // y se responden por candidato con `limit(1)` en vez de traerse TODAS sus filas con un
    // `.in(...)` colectivo. No es estilo: PostgREST corta en **1000 filas** sin avisar, y un
    // recorte cae del lado peligroso — el usuario cuyas filas quedaron afuera se lee como
    // "no anotó nada" y recibe el empujón de alta estando ya activo, que es justo lo que el
    // comentario del error de acá abajo declara inaceptable.
    //
    // Era latente y no teórico. La ventana es de 3 a 18 horas desde el alta, así que los
    // candidatos son 1-3 por corrida y hoy no llegan ni cerca del tope. Lo que sí lo alcanza
    // es UNA carga masiva de Excel dentro de esas primeras 18h: esas filas son de un solo
    // usuario pero llenan el cupo COMPARTIDO del `.in()`, y quien se queda sin lugar es el
    // OTRO candidato de la misma corrida. Con `limit(1)` por usuario, cuántas filas tenga
    // cada uno deja de importar.
    //
    // El costo es 2 consultas por candidato en vez de 2 en total, y está acotado por la
    // ventana: no crece con el tamaño de la base.
    const existe = async (tabla, filtrar) => {
      const { data, error } = await filtrar(supabase.from(tabla).select('usuario_id')).limit(1);
      // supabase-js NO lanza: sin leer el error, una caída se leería como "no hay fila", que
      // es la respuesta que manda el mensaje. Se convierte en excepción para que el catch de
      // abajo corte la corrida entera en vez de descartar a este candidato en silencio.
      if (error) throw new Error(tabla + ': ' + error.message);
      return (data || []).length > 0;
    };
    let activados, avisados;
    try {
      const [tx, avisos] = await Promise.all([
        Promise.all(ids.map((id) => existe('transacciones', (q) => q.eq('usuario_id', id)))),
        Promise.all(ids.map((id) => existe('notification_deliveries', (q) => q.eq('tipo', 'onboarding').eq('usuario_id', id)))),
      ]);
      activados = new Set(ids.filter((_, k) => tx[k]));
      avisados = new Set(ids.filter((_, k) => avisos[k]));
    } catch (eDescartar) {
      // Mismo criterio: sin poder descartar, NO se manda. Un error leído como
      // "este no tiene transacciones" le escribe a quien ya está usando Neto.
      log.error({ tag: 'ONBOARDING_REMINDER', err: msgErr(eDescartar) }, 'No se pudo descartar candidatos; no se envía nada');
      return;
    }
    // El dedup NO filtra los `estado` que empiezan con `skipped`, y es deliberado. Suena al
    // arreglo obvio —una fila `skipped_no_whatsapp` parecía "no se le avisó, reintentar"— pero
    // con el canal ya bifurcado esa fila significa lo contrario: al web-first se le escribió en
    // la campana y el `skipped` es solo la mitad de WhatsApp del envío. Filtrarlo lo re-avisaría
    // en CADA corrida mientras dure la ventana, y este cron corre **cada 15 minutos**
    // (`cron/schedule.js`), no cada hora. Con la ventana de 15h son hasta **~60** avisos.
    // Que la cadencia hace exactamente eso está MEDIDO, no calculado: el 17-jul y el 20-jul un
    // usuario cada día recibió 12 `onboarding` idénticos, espaciados 15 minutos exactos, cuando
    // la ventana era de 3h. (La causa de aquello fue otra —entonces el dedup no existía— pero
    // la cadencia y la aritmética son las mismas, y ahora la ventana es 5x más ancha.)
    // `skipped_test` tampoco se filtra: el silencio a un usuario de prueba es un silencio pedido.
    // Lo que protege el caso "la campana tampoco se escribió" es `claimInApp` en la rama AMBOS,
    // que corta ANTES de dejar la fila. La consulta de vigilancia de la señal diaria sí tiene
    // que excluir `skipped%`, porque ahí la pregunta es otra: "¿alguien se quedó sin nada?".
    const usuarios = candidatos.filter((u) => !activados.has(u.id) && !avisados.has(u.id)
      // `=== false` y no falsy: la columna es nullable y su default es 'sí quiere'.
      && u.recordatorios_activos !== false);
    if (usuarios.length === 0) return;
    for (const u of usuarios) {
      try {
        const primerNombre = u.nombre ? u.nombre.split(' ')[0] : null;
        // Un solo mensaje, y no ramifica por `onboarding_paso`: con el criterio
        // nuevo el paso ya no dice nada sobre esta persona (el alta se cierra en
        // el primer o segundo turno). Lo que la define es que no anotó nada, y a
        // eso se le responde siempre lo mismo — pedir el primer gasto, con la
        // salida de "saltar" a la vista.
        const nudge = '👋 ' + (primerNombre ? primerNombre + ', a' : 'A') + 'nótame un gasto y te muestro cómo funciono.\n\n' +
          '📝 _"gasté 20 en taxi"_\n' +
          '📸 O mándame la foto de un Yape\n\n' +
          '_Si prefieres, dime *saltar* y lo dejamos para después._';
        // El canal se BIFURCA por lo que el usuario tiene, y no es cosmético: hasta el
        // 20-ago-2026 este nudge salía siempre SOLO_WHATSAPP con el motivo "todavía no tiene
        // cuenta web: no hay campana donde mostrar nada". Esa premisa era cierta para la
        // población que el cron capturaba ANTES del fix de selección (`000fc52`) y dejó de
        // serlo con la que captura ahora: los 3 candidatos del 17 y 18-ago tenían cuenta web
        // y `whatsapp IS NULL`, así que los 3 salieron `skipped_no_whatsapp` y no se enteró
        // nadie. Hoy 9 de 106 usuarios reales son web-first — no es un caso de borde.
        //
        // Son dos llamadas y no un ternario a propósito: `tests/notificaciones-duales.test.js`
        // exige el par `canales:`/`motivo:` como literales pegados, y aflojar esa regex para
        // que entienda una expresión es cómo un guard deja de ver.
        const base = { usuarioId: u.id, whatsapp: u.whatsapp, tipo: 'onboarding', mensaje: nudge };
        if (u.supabase_auth_id) {
          // `claimInApp` porque el dedup de este cron (arriba, `avisados`) lee
          // `notification_deliveries`, y esa fila la escribe `enviarWhatsapp`. Para el
          // web-first con `whatsapp` null la fila sale `skipped_no_whatsapp` — que con este
          // canal YA NO significa "no se le avisó", significa "se le avisó por la campana".
          // Si la campana no se pudo escribir, el claim corta antes de dejar esa fila y el
          // usuario vuelve a entrar en la corrida siguiente (cada 15 min, y la ventana dura
          // 15h: así que fallar cerrado lo pospone, no lo pierde).
          //
          // Lo que el claim NO cubre, y conviene tener presente: la campana se escribe y la fila
          // de `notification_deliveries` no. Ahí el dedup queda ciego y a los 15 min entra de
          // nuevo. Son DOS escenarios y solo uno tiene remedio: si el insert es RECHAZADO,
          // `registrarEntrega` lo loguea desde el 20-ago; si el proceso MUERE en el medio, no
          // corre nada y no hay log posible.
          await notificarUsuario({
            canales: CANALES.AMBOS,
            ...base,
            titulo: 'Anota tu primer gasto',
            // Cuerpo propio: el de WhatsApp dice "mándame la foto" y "dime saltar", que en la
            // campana no son acciones posibles.
            cuerpo: 'Registra un gasto y Neto empieza a mostrarte a dónde se te va la plata.',
            tipoInApp: 'recordatorio', link: '/dashboard/transacciones',
            claimInApp: true,
          });
        } else {
          await notificarUsuario({
            canales: CANALES.SOLO_WHATSAPP,
            motivo: 'la rama exige supabase_auth_id nulo: sin cuenta web no hay campana donde mostrar nada, y el mensaje ES el empujón para que empiece',
            ...base,
          });
        }
        // NO se toca `onboarding_paso`. La marca de "ya se le mandó" es la fila que
        // `notificarUsuario` deja en `notification_deliveries`, que además es el
        // registro real del envío. Pisar el paso a 100 acá mandaría el próximo
        // mensaje de la persona al parser de NOMBRES.
      } catch(e) { log.error({ tag: 'ONBOARDING_REMINDER', userId: u.id, err: msgErr(e) }, 'Error empujando el nudge de onboarding'); }
    }
    log.info({ tag: 'ONBOARDING_REMINDER', enviados: usuarios.length, candidatos: candidatos.length }, 'Nudges de primer gasto enviados');
  } catch(e) { log.error({ tag: 'ONBOARDING_REMINDER', err: msgErr(e) }, 'Error recordatorio onboarding'); }
}

// Empujón del día 2 a activar la cuenta web. El corte del flujo nuevo es "al
// tercer gasto o al día 2, lo que llegue primero": esto cubre la segunda mitad,
// para el que registró uno o dos gastos y no volvió a abrir el chat.
//
// El día 2 no es arbitrario: la ventana de 24h de Meta se cuenta desde el ÚLTIMO
// mensaje del usuario, así que un empujón al día 7 sencillamente no se entrega
// (los 16 survey_wake_up del barrido de churn tuvieron 0 respuestas y 0 entregas
// confirmadas). Por eso se exige que haya escrito hace menos de 23h: si la
// ventana ya se cerró, no se gasta el envío ni se quema el ledger.
async function checkActivacionDia2() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() < 9 || horaLima.getHours() >= 21) return;
  try {
    const hace48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, supabase_auth_id, activacion_nudge_at')
      .is('supabase_auth_id', null)      // sin cuenta web = el objetivo
      .is('activacion_nudge_at', null)   // ledger: un solo envío por usuario
      .not('whatsapp', 'is', null)
      .gte('created_at', hace48h)
      .lte('created_at', hace24h);
    // El cron corre cada 15 minutos sobre una ventana de 24h, así que un error transitorio
    // acá se reintenta solo: lo que se pierde con el `return` es una corrida, no el usuario.
    //
    // **El que no se reintenta es el UPDATE del ledger, más abajo** (`activacion_nudge_at`):
    // si falla, todas las condiciones de selección valen igual en el tick siguiente y el mismo
    // link puede salir decenas de veces en un día. Esa escritura ya lee su error y lo loguea
    // (ítem 7); lo que no se puede es evitar la duplicación, porque el mensaje ya salió.
    if (errUsuarios) {
      log.error({ tag: 'ACTIVACION_DIA2', err: errUsuarios.message }, 'No se pudo leer la población: nadie recibió el link de activación');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;

    const limiteVentana = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    for (const u of usuarios) {
      try {
        // Solo a quien YA registró algo: sin un gasto propio el link no tiene qué
        // mostrar, y a ese usuario lo trabaja checkRecordatorioOnboarding.
        const { count: conteoTx, error: errConteo } = await supabase.from('transacciones')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', u.id);
        // Falla cerrado por accidente: un error deja `count` en null y el `continue` de abajo
        // lo trata como "todavía no anotó nada". El destino es correcto —no mandar un link a
        // un dashboard vacío—, pero sin esto no queda registro de por qué no se mandó.
        if (errConteo) throw errConteo;
        if (!conteoTx) continue;

        // ¿Sigue abierta la ventana de 24h? El último turno del usuario en
        // `conversaciones` es la única marca de "cuándo escribió por última vez".
        const { data: ultimoTurno, error: errTurno } = await supabase.from('conversaciones')
          .select('created_at').eq('usuario_id', u.id).eq('rol', 'usuario')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        // Igual que el conteo de arriba: el error se leía como "no escribió nunca" y el
        // usuario se descartaba por fuera-de-ventana sin que nada lo dijera.
        if (errTurno) throw errTurno;
        if (!ultimoTurno || ultimoTurno.created_at < limiteVentana) continue;

        const mensaje = mensajeActivacionDia2(u, conteoTx);
        if (!mensaje) continue;   // sin secreto configurado no hay link que mandar
        const { wa } = await notificarUsuario({
          canales: CANALES.SOLO_WHATSAPP,
          motivo: 'la query selecciona supabase_auth_id IS NULL: no hay cuenta web donde aterrizar el aviso, y el mensaje ES el link para crearla',
          usuarioId: u.id, whatsapp: u.whatsapp, tipo: 'activacion', mensaje,
        });
        // El ledger se marca aunque Meta rechace: reintentar fuera de ventana no
        // cambia el resultado y solo acumula filas blocked_24h.
        if (wa && !wa.skipped) {
          // `activacion_nudge_at` es el UNICO freno de este cron, y este cron corre cada 15
          // minutos con gate 9-21h: son 48 corridas al dia. Un UPDATE que falla en silencio
          // no se traduce en "un link de mas", se traduce en un link cada 15 minutos hasta
          // que la escritura vuelva a funcionar. Ya salio el mensaje, asi que la duplicacion
          // no se puede evitar desde aca; lo que si se puede es que quede dicha.
          const { error: errNudge } = await supabase.from('usuarios').update({ activacion_nudge_at: new Date().toISOString() }).eq('id', u.id);
          if (errNudge) {
            log.error({ tag: 'ACTIVACION_DIA2', userId: u.id, err: errNudge.message }, 'El link se envio pero el ledger no quedo marcado: se va a reenviar en la proxima corrida (cada 15 min)');
          }
          analytics.capture(u.id, 'wa_activation_link_sent', { conteo_tx: conteoTx, canal: 'cron' });
        }
      } catch (e) { log.error({ tag: 'ACTIVACION_DIA2', userId: u.id, err: msgErr(e) }, 'Error empujando el link de activación'); }
    }
  } catch (e) { log.error({ tag: 'ACTIVACION_DIA2', err: msgErr(e) }, 'Error empujón activación día 2'); }
}

// ─── Fin del trial: dos avisos y el downgrade ────────────────────────────────
//
// Día 11 (faltan 3), día 14 (último día), y al día 15 cae al muro. Corre cada hora con
// gate >=9am Lima: el gate evita mandar de madrugada y permite catch-up si se cae una
// corrida, y la idempotencia real la da el dedup por día contra `notificaciones` — el
// mismo esquema que checkPremiumExpiry, que sin él mandaba el aviso 24 veces al día.
//
// NO colisiona con checkPremiumExpiry: durante el trial `premium_vence` queda NULL, y las
// tres queries de ese cron filtran por premium_vence (= en3dias, = hoy, IS NOT NULL). Los
// usuarios en prueba le son invisibles.
//
// ─── Sobre la entrega: acá decía que ésta era la MEJOR población, y se midió que NO ──────
//
// El texto anterior afirmaba que ésta era "la de MEJOR caso para la ventana de 24h, porque
// por construcción registró un gasto hace <=14 días". Es falso, y el error de razonamiento
// vale más que el número: **registrar un gasto no implica haberlo registrado POR WhatsApp**.
// Se anota también desde la webapp, y la ventana de 24h de Meta sólo la abre un mensaje
// ENTRANTE.
//
// Medido sobre 30 días al 31-ago-2026, por WhatsApp:
//
//   trial_d11 ("termina en 3 días")  34 intentos →  1 entregado, 30 rechazados con 131047
//   trial_d14 ("termina hoy")        31 intentos →  0 entregados, 28 rechazados con 131047
//   trial_vencido ("terminó")        15 intentos →  0 entregados, 12 rechazados con 131047
//
// O sea 1 de 80. Y de las 26 pruebas vivas ese día, sólo 2 tenían la ventana abierta.
// Las plantillas de Meta NO son la salida (descartadas con su motivo en
// docs/whatsapp-templates.md: se pagaría por alcanzar a quien no usa el producto), y
// WA_TRIAL_TEMPLATE_ENABLED se queda en false.
//
// La salida es el CORREO, que desde el 31-ago-2026 declaran los tres avisos. WhatsApp e
// in-app salen igual: el correo se suma, no reemplaza. `notification_deliveries` sigue
// siendo la única fuente de verdad de qué llegó — por canal, y por callback, nunca por el
// resultado del POST.
async function checkTrialExpiry() {
  try {
    const hoy = hoyPeru();
    const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
    const inicioHoy = new Date(hoy + 'T00:00:00-05:00').toISOString();
    const usaTemplate = process.env.WA_TRIAL_TEMPLATE_ENABLED === 'true';

    if (horaLima.getHours() >= 8) {
      const avisos = [
        { fecha: sumarDias(hoy, AVISO_DIAS_ANTES), titulo: 'Tu prueba Pro termina en 3 días', tipo: 'trial_d11', cuando: 'en 3 días', via: 'd11' },
        { fecha: hoy, titulo: 'Tu prueba Pro termina hoy', tipo: 'trial_d14', cuando: 'hoy', via: 'd14' },
      ];
      for (const aviso of avisos) {
        // `email` y `recordatorios_activos` entran acá porque el canal de correo los necesita
        // en el LLAMADOR: `notificarUsuario` no lee la base (decisión tomada y revertida una
        // vez, ver el bloque de `cuenta_borrada_at` en lib/notify-user.js). Sin la columna en
        // el select, `usuario.email` es undefined y el correo sale como `skipped_no_email`
        // para todo el mundo — un canal apagado con cara de canal encendido.
        const { data: porVencer, error: errPorVencer } = await supabase.from('usuarios')
          .select('id, whatsapp, nombre, trial_vence, supabase_auth_id, email, recordatorios_activos')
          .eq('trial_estado', 'activo').eq('trial_vence', aviso.fecha)
          .is('cuenta_borrada_at', null);
        if (errPorVencer) {
          log.error({ tag: 'TRIAL_EXPIRY', via: aviso.via, err: errPorVencer.message }, 'No se pudo leer a quién se le vence la prueba: nadie fue avisado');
          continue;
        }
        if (!porVencer || porVencer.length === 0) continue;
        for (const usuario of porVencer) {
          try {
            // La baja apaga TODOS los canales, y no es una interpretación: el pie de cada
            // correo dice textual "Dejar de recibirlos (todos los canales, también WhatsApp)".
            // Desde que este aviso declara `email`, respetarla dejó de ser opcional — un
            // opt-out con excepciones que la persona no puede ver no es un opt-out. Mismo
            // corte que checkRecordatorioDeudas. Cuesta cero hoy: 1 de 131 del padrón se dio
            // de baja, y no está en prueba. Y el que se dio de baja igual ve el muro cuando
            // entra a la app: el aviso empuja, no es el único camino.
            if (usuario.recordatorios_activos === false) continue;
            // Mismo dedup que checkPremiumExpiry y misma trampa: falla abierto, y este cron
            // también es horario con gate >=8am. Ante la duda se asume avisado.
            const { data: yaAviso, error: errDedup } = await supabase.from('notificaciones')
              .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
              .eq('titulo', aviso.titulo).gte('fecha', inicioHoy).limit(1);
            if (errDedup) {
              log.error({ tag: 'TRIAL_EXPIRY', userId: usuario.id, via: aviso.via, err: errDedup.message }, 'No se pudo comprobar el dedup: no se reenvía el aviso de fin de prueba');
              continue;
            }
            if (yaAviso && yaAviso.length > 0) continue;

            const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
            // Al que nunca activó su cuenta web se le empuja a activarla, no a pagar: está
            // por terminar 14 días de Pro sin haber visto una sola vez lo que se le está
            // por acabar. Pedirle plata por algo que no vio no puede funcionar.
            // El destino se calcula UNA vez y viaja también como `link`, en vez de quedar sólo
            // dentro del texto. Antes el aviso mandaba siempre `link: '/dashboard/pro'`, lo
            // cual da igual mientras el destinatario tenga cuenta web — pero desde que hay
            // correo, el botón "Ver en Neto" deposita al que NUNCA activó en `/login`, o sea
            // en la pantalla donde un "Continuar con Google" le crea una cuenta huérfana en
            // lugar de vincularlo a su número. El cuerpo ya bifurcaba; el destino no.
            //
            // Es `linkPanelPro` y no una copia suya: esta bifurcación estaba escrita inline
            // acá desde antes, y sacarla del helper la deja fuera del alcance de
            // `tests/lib/trial-link-panel-pro.test.js` — o sea que cambiar el helper dejaría
            // este cron divergiendo en silencio, con el guard en verde. El `|| /dashboard` es
            // el mismo fallback que ya tenía el cuerpo para cuando no se puede firmar el link.
            //
            // **El precio, que es real y se elige a sabiendas.** `link` es UN parámetro y va a
            // los tres canales, así que para el que no activó, la fila de la campana queda con
            // la URL de activación. Esa fila hoy es inalcanzable —sin cuenta web no hay
            // campana—; si más adelante activa y clickea ese aviso viejo, su token ya está
            // gastado y `/activar` lo manda a `/dashboard` en vez de `/dashboard/pro`. Se
            // acepta porque el otro lado es peor: el botón del correo llevaría a `/login` a
            // alguien que nunca vio la app, justo en el aviso que pide plata.
            const linkAviso = linkPanelPro(usuario) || WEBAPP_URL + '/dashboard';
            const cuerpo = usuario.supabase_auth_id
              ? 'Después de eso sigo anotando todos tus gastos, pero el dashboard, el historial y los reportes quedan cerrados.\n\n' +
                'Para seguir con todo abierto:\n' + lineaPrecioPro() + '\n' +
                '👉 ' + linkAviso
              : 'Y todavía no has entrado ni una vez a ver tus gastos en gráficos.\n\n' +
                'Míralos ahora, mientras sigue abierto:\n👉 ' + linkAviso;
            // formatFecha y no el ISO crudo: el muro ya dice "29-jul-26" y ver "2026-08-04"
            // en el aviso previo delata dos manos escribiendo el mismo flujo.
            const venceLegible = formatFecha(String(usuario.trial_vence).slice(0, 10));
            const msg = '⏳ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u prueba de *Neto Pro* termina ' +
              aviso.cuando + (aviso.via === 'd11' ? ' (' + venceLegible + ')' : '') + '.\n\n' + cuerpo;

            const tpl = usaTemplate ? {
              name: 'trial_por_vencer', language: { code: 'es' },
              components: [{ type: 'body', parameters: [
                { type: 'text', text: primerNombre || 'Hola' },
                { type: 'text', text: aviso.via === 'd11' ? 'en 3 días (' + venceLegible + ')' : 'hoy' },
              ] }],
            } : null;

            // El asunto NO puede ser el `titulo` de la campana ("Tu prueba Pro termina en 3
            // días"): en una bandeja, al lado de otros treinta, eso no dice qué se pierde ni
            // cuándo. Lleva la FECHA y la consecuencia concreta, que es lo que hace que
            // alguien lo abra, y va delante porque el móvil corta cerca de los 35 caracteres.
            // Sin emoji a propósito — el asunto es lo único que miran los filtros de spam
            // antes de decidir. Misma regla que el asunto de `deuda`.
            //
            // Uno solo por aviso, sin ramificar por `supabase_auth_id` como sí hace el cuerpo:
            // "se cierra tu dashboard" es cierto lo hayas abierto o no, y al 31-ago la
            // intersección de "nunca activó la web" con "tiene correo" en la cohorte viva es
            // CERO, así que la segunda variante no tendría a quién hablarle.
            const asuntoTrial = aviso.via === 'd11'
              ? 'Tu prueba Pro termina el ' + venceLegible + ' y se cierra tu dashboard'
              : 'Último día de tu prueba Pro: mañana se cierra tu dashboard';

            const { wa } = await notificarUsuario({
              canales: CANALES.AMBOS,
              usuarioId: usuario.id, whatsapp: usuario.whatsapp,
              tipo: aviso.tipo, mensaje: msg, template: tpl,
              titulo: aviso.titulo, tipoInApp: 'recordatorio', link: linkAviso,
              claimInApp: true, // el dedup de arriba lee la fila in-app; sin claim, re-envío horario (B6)
              // El único aviso del producto que pide plata, y por WhatsApp llegó 1 de 65 en 30
              // días (ver el bloque de arriba). El correo va EN PARALELO, no como fallback de
              // `wa.ok`: el rechazo de Meta llega por callback y todavía no existe cuando esta
              // llamada retorna — un fallback condicionado habría mandado cero correos.
              email: { to: usuario.email || null, asunto: asuntoTrial },
            });
            // Solo se cuenta como "aviso" lo que Meta aceptó: un blocked_24h no avisó a nadie
            // y contarlo taparía justo el problema que se está midiendo.
            //
            // Este evento sigue siendo de WHATSAPP y no cuenta el correo, a propósito: mover
            // el gate ahora rompería la comparación con los 30 días de historia que
            // justificaron el cambio. El correo se mide donde corresponde, que es
            // `notification_deliveries` con canal='email' y tipo='trial_d11'/'trial_d14'.
            if (wa && wa.ok && !wa.skipped) {
              analytics.capture(usuario.id, 'wa_onboarding_step_ok', { paso: 310, via: aviso.via, canal: tpl ? 'template' : 'texto' });
            }
          } catch (e) { log.error({ tag: 'TRIAL_EXPIRY', userId: usuario.id, err: msgErr(e) }, 'Error avisando fin de trial'); }
        }
      }
    }

    // Vencidos → al muro. Sin gate horario: el downgrade no molesta a nadie de madrugada y
    // dejar a alguien con Pro un día de más por una corrida perdida sería peor.
    // `trial_estado`, `premium_desde` y `premium_vence` van en el select porque mensajeMuro
    // ramifica por ellas. Sin `trial_estado` la fila llegaba con `undefined`, el mensaje caía
    // en la rama de "nunca tuviste prueba" y le prometía 14 días gratis a quien acababa de
    // terminar los suyos — el único mensaje que el trial existe para mandar, y salía al revés.
    // `estado_pago` va en el select por el mismo motivo que en checkPremiumExpiry: hay que
    // saber si venía en 'pagado' para no dejarlo ahí después del downgrade (hallazgo D6).
    // `email` y `recordatorios_activos`, por el mismo motivo que en el select de arriba: el
    // canal de correo se declara en el llamador y el chokepoint no lee la base.
    const { data: vencidos, error: errVencidos } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, trial_estado, trial_vence, premium_desde, premium_vence, estado_pago, email, recordatorios_activos')
      .eq('trial_estado', 'activo').lt('trial_vence', hoy)
      .is('cuenta_borrada_at', null);
    // El silencio acá es el que más se parece a la salud: "hoy no venció ninguna prueba" es
    // el caso normal. Un fallo sostenido deja pruebas vencidas con Pro abierto y sin muro.
    if (errVencidos) {
      log.error({ tag: 'TRIAL_EXPIRY', err: errVencidos.message }, 'No se pudo leer las pruebas vencidas: nadie bajó al muro');
      return;
    }
    if (!vencidos || vencidos.length === 0) return;
    for (const usuario of vencidos) {
      try {
        // `estado_pago` viaja con el plan, igual que en checkPremiumExpiry. Este cron no lo
        // tocaba, y por ahí se cuela el caso D6: el usuario de cortesía de la migración 054
        // quedó `plan='premium'`, `premium_vence=NULL` y `trial_estado='activo'`, así que a
        // quien lo va a bajar es ESTE cron y no el otro — y con `estado_pago='pagado'`
        // colgando para siempre. Es D3 con otra causa y con fecha puesta.
        //
        // Mismas dos reglas que el cron hermano: solo se toca si venía en 'pagado' (un
        // 'pendiente' es un comprobante esperando aprobación y pisarlo borra el ⏳), y se
        // escribe 'vencido' y no null, que es el valor que el CHECK de la columna tiene
        // justamente para esto y conserva que sí llegó a pagar alguna vez.
        const cambios = { plan: 'free', trial_estado: 'vencido' };
        if (usuario.estado_pago === 'pagado') cambios.estado_pago = 'vencido';
        // Un UPDATE condicionado a trial_estado='activo' es el claim: si dos corridas se
        // solapan, solo una baja el plan y solo una avisa.
        const { data: bajado, error: errBaja } = await supabase.from('usuarios')
          .update(cambios)
          .eq('id', usuario.id).eq('trial_estado', 'activo')
          .select('id').maybeSingle();
        if (errBaja) { log.error({ tag: 'TRIAL_EXPIRY', userId: usuario.id, err: errBaja.message }, 'No se pudo bajar el plan al vencer el trial'); continue; }
        if (!bajado) continue;   // otra corrida ganó
        // La fila en memoria es de ANTES del UPDATE. Se sincroniza para que mensajeMuro lea
        // el estado real y no el que tenía hace tres líneas.
        usuario.trial_estado = 'vencido';

        // Conectar Gmail ya es exclusivo de Pro pagado, así que un trial normal no llega acá
        // con cuentas. Se llama igual por los que quedaron conectados de antes del gate: es
        // barato (un select que devuelve vacío) y no depende de que el barrido pase primero.
        const { revocadas } = await revocarAccesoGmail(usuario.id, { motivo: 'trial_vencido' });

        // ACCESORIA a propósito, y de las dos únicas del archivo que NO cortan al fallar.
        // `mensajeMuro` usa este número sólo para elegir entre "*7 gastos*" y "tus gastos":
        // un null degrada el copy y nada más. Y acá el downgrade YA se aplicó tres líneas
        // arriba, así que un `continue` dejaría a alguien recién bajado al muro sin ninguna
        // explicación de por qué perdió el dashboard. Se loguea y se manda igual.
        const { count: conteoTx, error: errConteo } = await supabase.from('transacciones')
          .select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id);
        if (errConteo) log.warn({ tag: 'TRIAL_EXPIRY', userId: usuario.id, err: errConteo.message }, 'Sin conteo de gastos: el mensaje del muro sale con el copy genérico');

        // Mismo corte que en los avisos de arriba y que checkRecordatorioDeudas. Va DESPUÉS
        // del downgrade a propósito: la baja apaga los AVISOS, no el vencimiento de la prueba.
        // Quien pidió no recibir mensajes igual pierde Pro, y lo ve en el muro cuando entra.
        //
        // Y va ANTES del conteo de gastos recientes, no después. Con el orden invertido, a un
        // usuario dado de baja se le pagaba una query que no iba a decidir nada y, peor, el log
        // del gate afirmaba 'no sale por correo porque no registró gastos' cuando en realidad no
        // salía nada por ningún canal — sobrecontando dos supresiones distintas en el mismo
        // instrumento con que se va a medir el gate.
        //
        // Lo que se pierde con el corte, dicho en voz alta: el mensaje incluye
        // `avisoGmailDesconectado(revocadas)`, así que al silenciado se le revoca Gmail sin
        // avisarle por ningún canal, y antes de este cambio sí se enteraba. Se acepta porque la
        // alternativa es peor: el pie de cada correo promete por escrito que la baja apaga
        // TODOS los canales, y una excepción que la persona no puede ver convierte la promesa
        // en mentira. Hoy cuesta cero — 1 de 131 del padrón se dio de baja y no está en prueba.
        if (usuario.recordatorios_activos === false) {
          log.info({ tag: 'TRIAL_EXPIRY', userId: usuario.id }, 'Bajado al muro sin avisar: pidió no recibir recordatorios');
        } else {
          // ─── El correo de ESTE aviso lleva un gate que los otros dos no llevan ───────────
          //
          // El criterio es la HONESTIDAD DE LA AFIRMACIÓN, no la reputación del dominio, y la
          // diferencia importa porque decide dónde va el corte. d11 y d14 le hablan a alguien
          // que todavía tiene la prueba y anuncian algo FUTURO: "esto termina, pagá antes". Eso
          // es cierto lo esté usando o no, y por eso salen sin gate. Éste afirma algo en pasado
          // —"se cerró tu dashboard"— y para quien no anota nada hace dos semanas esa pérdida no
          // ocurrió: no es un aviso transaccional, es outbound frío con forma de recibo.
          //
          // > Acá decía que el motivo era no quemar la reputación del dominio con un envío
          // > masivo a inactivos. Una revisión adversarial lo desarmó y tenía razón: si ese
          // > fuera el criterio, el corte tendría que estar en los TRES avisos, porque la misma
          // > población recibe d11 y d14 sin gate tres días antes. El argumento de reputación
          // > justificaba un gate que no hace ese trabajo, así que se fue.
          //
          // El bloque que lo vuelve concreto igual existe: al 31-ago-2026, 16 de las 26 pruebas
          // vivas comparten `trial_inicio = 2026-08-01` (el backfill de la migración 052 — una
          // fecha copiada, no un comportamiento) y vencen todas el mismo día, **16 de 16 con
          // correo y 1 de 16 con un gasto en 14 días**. A esos 16 el d11 y el d14 ya les salieron
          // sin correo, porque este canal no existía todavía para este cron; lo único que llega
          // acá es el `trial_vencido`, y son exactamente 15 recibos de una pérdida que nadie tuvo.
          //
          // Falla CERRADO —sin lectura no hay correo— y es la excepción al fail-open del resto
          // del canal, por la asimetría del daño: afirmarle una pérdida a quien no la tuvo no se
          // puede desdecir, y callarse cuesta un correo. WhatsApp y la campana salen igual en
          // los dos casos, así que nadie se queda sin enterarse del muro por esto.
          const desde14d = new Date(sumarDias(hoy, -14) + 'T00:00:00-05:00').toISOString();
          const { count: txRecientes, error: errRecientes } = await supabase.from('transacciones')
            .select('id', { count: 'exact', head: true })
            .eq('usuario_id', usuario.id).gte('created_at', desde14d);
          if (errRecientes) log.warn({ tag: 'TRIAL_EXPIRY', userId: usuario.id, err: errRecientes.message }, 'Sin conteo de gastos recientes: el aviso de fin de prueba no sale por correo (in-app y WhatsApp salen igual)');
          const usoReciente = !errRecientes && (txRecientes || 0) > 0;
          // El gate deja RASTRO. Sin esto es el único camino del canal que suprime un envío sin
          // dejar nada: no hay fila en `notification_deliveries` (a propósito — ver el spread de
          // abajo), no hay evento, y un gate que por diseño espera callar 15 de 16 es justo el
          // que hay que poder contar. Se cuenta acá y no en el ledger porque el estado que
          // correspondería (`skipped_sin_uso_reciente`) lo escribe `enviarEmail`, y a
          // `enviarEmail` no se llega: la decisión es del llamador, que es donde vive.
          if (!usoReciente) log.info({ tag: 'TRIAL_EXPIRY', userId: usuario.id, txRecientes: txRecientes || 0 }, 'Fin de prueba sin correo: no registró gastos en 14 días (in-app y WhatsApp salen igual)');

          const msg = mensajeMuro(usuario, conteoTx) + avisoGmailDesconectado(revocadas);
          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'trial_vencido', mensaje: msg,
            titulo: 'Tu prueba Pro terminó',
            cuerpo: 'Sigo anotando todos tus gastos y no se borró nada. Para volver a verlos, activa Pro.',
            link: '/dashboard/pro',
            // El `email` se OMITE cuando no hubo uso reciente, en vez de pasar `to: null`.
            // Un `to` nulo dejaría una fila `skipped_no_email` indistinguible de "no tiene
            // correo", y son dos cosas distintas: acá el canal no se declaró.
            ...(usoReciente ? { email: { to: usuario.email || null, asunto: 'Tu prueba Pro terminó y tu dashboard quedó cerrado' } } : {}),
          });
        }
        analytics.capture(usuario.id, 'wa_onboarding_step_failed', { paso: 400, motivo: 'trial_vencido', conteo_tx: conteoTx || 0 });
        log.info({ tag: 'TRIAL_EXPIRY', userId: usuario.id }, 'Trial vencido, usuario al muro');
      } catch (e) { log.error({ tag: 'TRIAL_EXPIRY', userId: usuario.id, err: msgErr(e) }, 'Error bajando al muro'); }
    }
  } catch (e) { log.error({ tag: 'TRIAL_EXPIRY', err: msgErr(e) }, 'Error general check trial expiry'); }
}

async function checkRecordatorioDeudas() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    const hoy = hoyPeru();
    const hoyDate = new Date(hoy + 'T12:00:00');
    const deudasProximas = await obtenerDeudasProximasVencer();
    if (!deudasProximas.length) return;

    // Touches en orden de urgencia (más avanzado primero). reached(d) = el touch ya "llegó".
    // Se envía a lo sumo 1 por corrida: el touch más avanzado alcanzado que aún no se mandó.
    // Esto da catch-up (si se perdió el de 3d, lo manda el día 2) sin duplicar (ledger en DB).
    const TOUCHES = [
      { key: 'p3', diff: -3, reached: d => d <= -3 },
      { key: 'v0', diff: 0,  reached: d => d <= 0 },
      { key: 'v1', diff: 1,  reached: d => d <= 1 },
      { key: 'v3', diff: 3,  reached: d => d <= 3 },
    ];

    for (const deuda of deudasProximas) {
      try {
        if (deuda.usuarios.recordatorios_activos === false) continue;
        // El recordatorio ES el ledger ("le debes S/X a Y, vence el Z"), y eso es lectura.
        if (estaEnMuro(deuda.usuarios)) continue;
        const venc = new Date(deuda.fecha_vencimiento + 'T12:00:00');
        const diffDias = Math.round((venc - hoyDate) / 86400000);
        const enviados = Array.isArray(deuda.recordatorios_enviados) ? deuda.recordatorios_enviados : [];

        const reached = TOUCHES.filter(t => t.reached(diffDias));
        const touch = reached.find(t => !enviados.includes(t.key));
        if (!touch) continue;
        const cd = touch.diff; // diffDias canónico del touch: copy estable aunque haya catch-up

        const sym = deuda.moneda === 'USD' ? '$' : 'S/';
        const primerNombre = deuda.usuarios.nombre ? deuda.usuarios.nombre.split(' ')[0] : null;
        const saludo = primerNombre ? primerNombre + ', ' : '';
        const montoStr = sym + ' ' + parseFloat(deuda.monto_pendiente).toFixed(2);

        let msgDeuda;
        if (cd === 3) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '📅 ' + saludo + 'en 3 días vence lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Ya te pagó?'
            : '📅 ' + saludo + 'en 3 días vence tu deuda con *' + deuda.contraparte + '* (' + montoStr + '). ¡No te olvides!';
        } else if (cd === 1) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '⏰ ' + saludo + 'mañana vence lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Ya te pagó?\n\n_Responde "sí, ya me pagó" o "todavía no"._'
            : '⏰ ' + saludo + 'mañana vence tu deuda con *' + deuda.contraparte + '* (' + montoStr + '). ¡Que no se te pase!';
        } else if (cd === 0) {
          msgDeuda = '🔴 ' + saludo + '¡Hoy vence ' + (deuda.tipo === 'me_deben' ? 'lo que te debe' : 'tu deuda con') + ' *' + deuda.contraparte + '* (' + montoStr + ')!';
        } else { // cd === -3
          msgDeuda = deuda.tipo === 'me_deben'
            ? '⚠️ ' + saludo + 'ya pasaron 3 días desde que venció lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Le recuerdas?'
            : '⚠️ ' + saludo + 'tu deuda con *' + deuda.contraparte + '* lleva 3 días vencida (' + montoStr + '). ¿Ya pagaste?';
        }

        // Template utility (entrega fuera de ventana 24h) cuando está habilitado y aprobado.
        // Si el flag está off, template=null → sale el texto libre (msgDeuda).
        const dTemplate = process.env.WA_TEMPLATES_ENABLED === 'true' ? {
          name: 'deuda_por_vencer', language: { code: 'es' },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: primerNombre || 'Hola' },
            { type: 'text', text: (deuda.tipo === 'me_deben' ? 'lo que te debe ' : 'tu deuda con ') + deuda.contraparte },
            { type: 'text', text: montoStr },
            { type: 'text', text: cd === 3 ? 'en 3 días' : cd === 1 ? 'mañana' : cd === 0 ? 'hoy' : 'hace 3 días' },
          ] }],
        } : null;
        // El asunto NO puede ser el `titulo` de la campana ("Deuda vence hoy"): en una bandeja,
        // al lado de otros treinta, eso no dice de quién ni de cuánto. Lleva contraparte y
        // monto porque son lo que hace que alguien lo abra. Sin emoji a propósito — el asunto
        // es lo único que miran los filtros de spam antes de decidir.
        const cuando = cd === 3 ? 'vence en 3 días' : cd === 1 ? 'vence mañana'
          : cd === 0 ? 'vence hoy' : 'venció hace 3 días';
        const asuntoDeuda = deuda.tipo === 'me_deben'
          ? 'Lo que te debe ' + deuda.contraparte + ' ' + cuando + ' (' + montoStr + ')'
          : 'Tu deuda con ' + deuda.contraparte + ' ' + cuando + ' (' + montoStr + ')';
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: deuda.usuario_id, whatsapp: deuda.usuarios.whatsapp,
          tipo: 'deuda', mensaje: msgDeuda, template: dTemplate,
          titulo: cd === 0 ? 'Deuda vence hoy' : cd > 0 ? 'Deuda vence en ' + cd + ' días' : 'Deuda vencida hace ' + Math.abs(cd) + ' días',
          tipoInApp: 'deuda_vence',
          link: '/dashboard/deudas', datos: { deuda_id: deuda.id },
          // Primer emisor del canal de correo (27-ago-2026), y el elegido por medición: los 12
          // usuarios que recibieron un aviso de plata en 30 días tienen email los 12 y número
          // 11, y **ninguno** es solo-WhatsApp. Este aviso es fechado — pierde valor mañana —
          // y por WhatsApp llegó 6 de 35 veces.
          email: { to: deuda.usuarios.email || null, asunto: asuntoDeuda },
        });
        // Ledger: marca el touch enviado Y todos los touches ya alcanzados. Evita el back-fill de
        // copy caduco cuando la deuda entra ya vencida o se saltó un umbral (un touch menos avanzado
        // ya no aplica). Preserva el catch-up: se manda el más avanzado alcanzado que faltaba.
        const keysAlcanzados = [...new Set([...enviados, ...reached.map(t => t.key)])];
        // El ledger que lee `enviados` al principio del loop. Sin marcar, el mismo touch se
        // vuelve a mandar manana con el mismo copy.
        const { error: errLedger } = await supabase.from('deudas').update({ recordatorios_enviados: keysAlcanzados }).eq('id', deuda.id);
        if (errLedger) {
          log.error({ tag: 'DEUDA_REMINDER', deudaId: deuda.id, userId: deuda.usuario_id, err: errLedger.message }, 'El recordatorio se envio pero el ledger no quedo marcado: se va a repetir');
        }
      } catch (e) { log.error({ tag: 'DEUDA_REMINDER', deudaId: deuda.id, userId: deuda.usuario_id, err: msgErr(e) }, 'Recordatorio de deuda omitido'); }
    }
  } catch (e) { log.error({ tag: 'DEUDA_REMINDER', err: msgErr(e) }, 'Error recordatorio deudas'); }
}

// ═══════════════════════════════════════════════════════════════
// DETECTOR DE FUGAS — Proactive spending leak alerts
// ═══════════════════════════════════════════════════════════════
const { generarAlertasFugas, generarMensajeFugas, guardarAlertas } = require('../services/spending-alerts');

async function checkDetectorFugas() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const dia = horaLima.getDate();
  const diaSemana = horaLima.getDay();
  const hora = horaLima.getHours();
  if (hora !== 11 || horaLima.getMinutes() > 14) return;

  try {
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('onboarding_completado', true);
    if (errUsuarios) {
      log.error({ tag: 'FUGAS', err: errUsuarios.message }, 'No se pudo leer la población: el detector de fugas no corrió para nadie');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;

    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        // El detector de fugas es una lectura agregada sobre la data del usuario
        // (`ver_fugas` está en INTENTS_LECTURA). Acá el plan solo elegía la CADENCIA —
        // free recibía la versión reducida el día 1 de cada mes —, que era coherente
        // cuando free era un plan gratuito y dejó de serlo cuando free pasó a ser el muro.
        // `PLAN_CONFIG.free.fugasFrequency` ya decía 'none' desde el sprint del trial;
        // este cron nunca leyó esa constante, así que la seguía mandando.
        if (estaEnMuro(usuario)) continue;

        // Miércoles y día 15.
        if (diaSemana !== 3 && dia !== 15) continue;

        const alertas = await generarAlertasFugas(usuario.id, true);
        if (alertas.length === 0) continue;

        const mensaje = await generarMensajeFugas(alertas, usuario.nombre, true);
        if (!mensaje) continue;

        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'fugas', mensaje,
          titulo: 'Fugas de gasto detectadas', tipoInApp: 'alerta_fugas',
          cuerpo: mensaje.replace(/[*_]/g, '').substring(0, 200),
          link: '/dashboard/alertas',
        });
        await guardarAlertas(usuario.id, alertas, mensaje);
      } catch (e) {
        // Saltar al siguiente usuario es correcto (una alerta menos es mejor que una
        // inventada), pero sin log un fallo sistemático se ve igual que "nadie tenía fugas".
        log.error({ tag: 'FUGAS_USER', err: msgErr(e), usuarioId: usuario.id }, 'Fugas omitidas para el usuario');
      }
    }
    log.info({ tag: 'FUGAS' }, 'Detector de fugas ejecutado');
  } catch (e) { log.error({ tag: 'FUGAS', err: msgErr(e) }, 'Error detector de fugas'); }
}

// ═══════════════════════════════════════════════════════════════
// NETO SCORE — Daily calculation + weekly notification (Pro)
// ═══════════════════════════════════════════════════════════════
const { upsertScore, obtenerTendenciaScore, scoreLabel } = require('../services/neto-score');

async function checkCalcularNetoScore() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 6 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios').select('id')
      .eq('onboarding_completado', true);
    // No empuja nada, pero es el productor del score: si esto se apaga mudo, el domingo
    // `checkNotificacionScore` no encuentra tendencia y ese silencio se lee como "nadie
    // tenía score que contar" — dos crons callados por una sola caída.
    if (errUsuarios) {
      log.error({ tag: 'SCORE', err: errUsuarios.message }, 'No se pudo leer la población: no se calculó ningún score');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;
    let ok = 0;
    let fallidos = 0;
    for (const u of usuarios) {
      try {
        await upsertScore(u.id);
        ok++;
      } catch (e) {
        // Saltar al siguiente es lo correcto —un score que no salió no justifica dejar sin
        // score a los demás—, pero `count: 0` a secas se lee como padrón vacío. Es la misma
        // confusión que dejó `checkRecordatorioOnboarding` doce días sin destinatarios.
        fallidos++;
        log.error({ tag: 'SCORE', err: msgErr(e), usuarioId: u.id }, 'No se pudo calcular el score de este usuario');
      }
    }
    log.info({ tag: 'SCORE', count: ok, fallidos }, 'Neto Scores calculados');
  } catch (e) { log.error({ tag: 'SCORE', err: msgErr(e) }, 'Error calculando scores'); }
}

async function checkNotificacionScore() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  // Domingos 10am Lima
  if (horaLima.getDay() !== 0 || horaLima.getHours() !== 10 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('plan', 'premium').eq('onboarding_completado', true);
    if (errUsuarios) {
      log.error({ tag: 'SCORE_NOTIF', err: errUsuarios.message }, 'No se pudo leer la población: nadie recibió su score semanal');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        const trend = await obtenerTendenciaScore(usuario.id);
        if (!trend) continue;
        const label = scoreLabel(trend.current);
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
        let arrow = '→';
        let diffText = 'igual que la semana pasada';
        if (trend.diff > 0) { arrow = '↑'; diffText = '+' + trend.diff + ' vs semana pasada'; }
        else if (trend.diff < 0) { arrow = '↓'; diffText = trend.diff + ' vs semana pasada'; }

        const msg = '📊 ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u Neto Score semanal:\n\n' +
          '*' + trend.current + '/100* ' + arrow + ' — ' + label + '\n' +
          '(' + diffText + ')\n\n' +
          '_Escribe "mi score" para ver el desglose completo._';
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'score_semanal', mensaje: msg,
          titulo: 'Tu Neto Score semanal', link: '/dashboard/score',
        });
      } catch (e) {
        // `obtenerTendenciaScore` caído para todos y "nadie tiene score todavía" producen el
        // mismo silencio: cero avisos y cero rastro. El destino no cambia —se salta igual—,
        // así que el log es lo único observable.
        log.error({ tag: 'SCORE_NOTIF', err: msgErr(e), usuarioId: usuario.id }, 'Score semanal omitido para el usuario');
      }
    }
  } catch (e) { log.error({ tag: 'SCORE_NOTIF', err: msgErr(e) }, 'Error notificación score semanal'); }
}

// Check-in planes de ahorro: 1ro y 15 del mes, 11am Lima, Pro only
async function checkCheckInPlanes() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const dia = horaLima.getDate();
  if ((dia !== 1 && dia !== 15) || horaLima.getHours() !== 11 || horaLima.getMinutes() > 14) return;
  try {
    const { calcularRitmoAhorro } = require('../services/metas');
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('plan', 'premium').eq('onboarding_completado', true);
    if (errUsuarios) {
      log.error({ tag: 'CHECKIN_PLANES', err: errUsuarios.message }, 'No se pudo leer la población: no salió ningún check-in de planes');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;

    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        const { data: metas, error: errMetas } = await supabase.from('metas_ahorro').select('*')
          .eq('usuario_id', usuario.id).eq('completada', false)
          .not('status', 'eq', 'abandoned')
          .order('created_at', { ascending: false });
        // Falla cerrado por accidente: null se lee como "no tiene planes activos". El
        // `catch` de este loop es silencioso a propósito (una alerta menos es mejor que una
        // inventada), así que el error se registra acá o no se registra en ningún lado.
        if (errMetas) {
          log.error({ tag: 'CHECKIN_PLANES', userId: usuario.id, err: errMetas.message }, 'No se pudieron leer las metas: se salta el check-in de este usuario');
          continue;
        }
        if (!metas || metas.length === 0) continue;

        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
        let msg = '🎯 ' + (primerNombre ? primerNombre + ', ' : '') + 'check-in de tus planes de ahorro:\n';

        for (const m of metas) {
          const pct = m.monto_objetivo > 0 ? Math.round((parseFloat(m.monto_actual || 0) / parseFloat(m.monto_objetivo)) * 100) : 0;
          msg += '\n*' + m.nombre + '* — ' + pct + '%';
          if (m.fecha_limite) {
            const ritmo = calcularRitmoAhorro(m);
            if (ritmo.enRitmo !== null) {
              msg += ' ' + (ritmo.enRitmo ? '✅' : '⚠️');
              if (ritmo.montoMensual > 0) msg += ' (S/' + ritmo.montoMensual.toFixed(0) + '/mes)';
            }
          }
          if (m.monthly_quota) {
            msg += '\n  Cuota: S/ ' + parseFloat(m.monthly_quota).toFixed(0) + '/mes';
          }
        }
        msg += '\n\n_Escribe "ahorré X para [nombre]" para registrar un abono._';
        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'checkin_planes', mensaje: msg,
          titulo: 'Check-in de tus planes de ahorro', tipoInApp: 'recordatorio',
          link: '/dashboard/planes',
        });
      } catch (e) {
        // El `if (errMetas)` de arriba ya loguea la lectura caída; esto cubre el resto del
        // cuerpo (`calcularRitmoAhorro`, el armado del mensaje, el envío), que era lo único
        // que seguía cayendo mudo.
        log.error({ tag: 'CHECKIN_PLANES', err: msgErr(e), usuarioId: usuario.id }, 'Check-in de planes omitido para el usuario');
      }
    }
  } catch (e) { log.error({ tag: 'CHECKIN_PLANES', err: msgErr(e) }, 'Error check-in planes'); }
}

// Recordatorio espacios compartidos: viernes 6pm Lima, balances >S/50 pendientes
async function checkRecordatorioEspacios() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getDay() !== 5 || horaLima.getHours() !== 18 || horaLima.getMinutes() > 14) return;
  try {
    const { obtenerBalanceEspacio, ownerEsPro } = require('../services/shared-spaces');
    // Get all active spaces
    const { data: spaces, error: errSpaces } = await supabase.from('shared_spaces').select('id, name');
    if (errSpaces) {
      log.error({ tag: 'ESPACIOS_REMIND', err: errSpaces.message }, 'No se pudo leer los espacios: no salió ningún recordatorio de balance');
      return;
    }
    if (!spaces || spaces.length === 0) return;

    for (const space of spaces) {
      try {
        // El balance de un espacio es lectura (`ver_balance_espacio` está en
        // INTENTS_LECTURA), y el tier que manda es el del DUEÑO, no el de cada miembro:
        // ese es el modelo "host paga" y este cron era el único camino que se lo saltaba
        // entero. Si el dueño cayó al muro, el espacio deja de empujar balances a nadie.
        if (!(await ownerEsPro(space.id))) continue;
        const { debts } = await obtenerBalanceEspacio(space.id);
        if (!debts || debts.length === 0) continue;

        // Only remind for debts > S/50
        const significantDebts = debts.filter(d => d.amount > 50);
        if (significantDebts.length === 0) continue;

        // Get all members to notify
        const { data: members, error: errMembers } = await supabase.from('space_members')
          .select('user_id, usuarios(whatsapp, nombre, recordatorios_activos)')
          .eq('space_id', space.id);
        // El `(members || [])` de abajo convierte el error en un loop vacío, o sea en un
        // espacio entero al que no se le avisa. El `catch` de este bloque es silencioso, así
        // que sin esta línea no queda nada.
        if (errMembers) {
          log.error({ tag: 'ESPACIOS_REMIND', spaceId: space.id, err: errMembers.message }, 'No se pudo leer los miembros: se salta este espacio');
          continue;
        }

        for (const m of (members || [])) {
          // El `!m.usuarios?.whatsapp` de esta línea se fue el 27-ago (item 14): el envío
          // declara AMBOS y el corte solo apagaba la campana del miembro sin número. Lo que
          // NO se puede sacar es el `!m.usuarios`: el embed puede venir nulo (miembro cuya
          // fila de `usuarios` no resolvió) y sin esa mitad el `?.` de la línea siguiente
          // daría `undefined !== false`, o sea que pasaría a notificar a un fantasma.
          //
          // Y este bucle no necesita el gate de lápida de sus hermanos por una razón distinta,
          // no por olvido: la migración 073 **borra** las filas de `space_members` de quien se
          // da de baja, así que una lápida nunca llega hasta acá.
          if (!m.usuarios || m.usuarios.recordatorios_activos === false) continue;
          const myDebts = significantDebts.filter(d => d.from === m.user_id);
          if (myDebts.length === 0) continue;

          // Anti-fatiga: no repetir el mismo espacio a este miembro más de 1 vez cada 10 días
          // (el cron es semanal; sin esto se re-mandaba el mismo balance estancado cada viernes).
          const cutoff10d = new Date(Date.now() - 10 * 86400000).toISOString();
          // Falla abierto igual que los dedups de vencimiento, con menos volumen porque el
          // cron es semanal: el costo de no leerlo es re-mandar el mismo balance estancado el
          // viernes siguiente, que es exactamente lo que esta ventana de 10 días vino a evitar.
          const { data: yaRecordado, error: errDedup } = await supabase.from('notificaciones')
            .select('id').eq('usuario_id', m.user_id).eq('tipo', 'recordatorio')
            .eq('titulo', 'Recordatorio de ' + space.name).gte('fecha', cutoff10d).limit(1);
          if (errDedup) {
            log.error({ tag: 'ESPACIOS_REMIND', spaceId: space.id, userId: m.user_id, err: errDedup.message }, 'No se pudo comprobar la anti-fatiga: no se reenvía el balance');
            continue;
          }
          if (yaRecordado && yaRecordado.length > 0) continue;

          const primerNombre = m.usuarios.nombre?.split(' ')[0] || '';
          let msg = '🏠 ' + (primerNombre ? primerNombre + ', r' : 'R') + 'ecordatorio de *' + space.name + '*:\n\n';
          for (const d of myDebts) {
            msg += '  → Le debes S/ ' + d.amount.toFixed(2) + ' a ' + (d.toNombre?.split(' ')[0] || '?') + '\n';
          }
          msg += '\n_Escribe "le pagué X a [nombre] del ' + space.name + '" para registrar tu pago._';
          try {
            await notificarUsuario({
              canales: CANALES.AMBOS,
              usuarioId: m.user_id, whatsapp: m.usuarios.whatsapp,
              tipo: 'espacios', mensaje: msg,
              titulo: 'Recordatorio de ' + space.name, tipoInApp: 'recordatorio',
              link: '/dashboard/espacios',
            });
          } catch (e) {
            // Pierde UN miembro. Se sigue con los demás a propósito, pero acá lo que no se
            // avisa es plata que alguien le debe a otro: sin log, nadie sabe que ese cobro
            // no salió. La anti-fatiga de 10 días no deja fila, así que el viernes siguiente
            // se reintenta solo — eso es recuperación, no motivo para callarlo hoy.
            log.error({ tag: 'ESPACIOS_REMIND', err: msgErr(e), spaceId: space.id, userId: m.user_id }, 'No se pudo avisar el balance a este miembro');
          }
        }
      } catch (e) {
        // Pierde el ESPACIO entero, con todos sus miembros: `ownerEsPro` y
        // `obtenerBalanceEspacio` corren antes del loop. Es la clase "población" del ítem 1
        // aplicada a un solo espacio, y por eso lleva `spaceId` y no un `usuarioId`.
        log.error({ tag: 'ESPACIOS_REMIND', err: msgErr(e), spaceId: space.id }, 'Espacio omitido: no se avisó a ninguno de sus miembros');
      }
    }
  } catch (e) { log.error({ tag: 'ESPACIOS_REMIND', err: msgErr(e) }, 'Error recordatorio espacios'); }
}

/**
 * Costos operativos del admin (Favio). Corre 9am Lima diario. Toma los costos activos que vencen
 * hoy o están atrasados y manda un solo mensaje consolidado por el canal admin (Telegram-first,
 * via notificarAdmin). La lógica de qué hacer con cada costo vive en lib/cost-reminders.js (puro,
 * testeado); acá solo se aplican los efectos.
 *
 *  - MANUAL (auto_debit=false): recordatorio "por pagar" (vence hoy / atrasado). Dedup por-día vía
 *    last_reminder_sent_at (el cron corre cada ~15min entre 9:00 y 9:14). NO avanza next_due_date:
 *    eso pasa cuando el admin marca pagado desde la UI, para que el track refleje la realidad.
 *  - AUTO (auto_debit=true): se cobra solo → no se molesta con "págalo". El día del cobro se
 *    registra el pago en paid_history (para el P&L) y se avanza next_due_date (el propio avance es
 *    el guard de idempotencia), y se manda una línea informativa "se debita X, verifica que pasó".
 */
async function checkRecordatoriosCostos() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    const hoy = hoyPeru();
    const { data: costos, error: errCostos } = await supabase.from('admin_costs')
      .select('id, label, amount_pen, currency, amount_original, frequency, next_due_date, active, auto_debit, last_reminder_sent_at, paid_history')
      .eq('active', true)
      .lte('next_due_date', hoy);
    // El destinatario es Favio, no un usuario, y por eso mismo el silencio es peor: "hoy no
    // vence ningún costo" es un mensaje que nunca llega, así que no hay nada que notar hasta
    // que un servicio se corta por falta de pago.
    if (errCostos) {
      log.error({ tag: 'COSTOS_REMIND', err: errCostos.message }, 'No se pudo leer los costos: no salió el recordatorio de hoy');
      return;
    }
    if (!costos || costos.length === 0) return;

    const { toNotify, toAutoProcess } = planCostReminders(costos, hoy);

    // 1) Auto-débito: registrar el cobro (paid_history) y avanzar la fecha, por costo. Solo se
    //    anuncia el que se registró bien (si el update falla, no mentimos que se debitó).
    const costById = new Map(costos.map((c) => [c.id, c]));
    const autoLines = [];
    for (const a of toAutoProcess) {
      const original = costById.get(a.id);
      const history = Array.isArray(original && original.paid_history) ? original.paid_history : [];
      const { error } = await supabase.from('admin_costs')
        .update({ paid_history: [...history, a.paidEntry], next_due_date: a.newNextDue, active: a.newActive })
        .eq('id', a.id);
      if (error) {
        log.error({ tag: 'COSTOS_REMIND', id: a.id, err: error.message }, 'Error auto-procesando costo');
        continue;
      }
      let line = '• ' + a.label + ' — S/ ' + a.amount_pen.toFixed(2);
      if (a.currency === 'USD' && a.amount_original) line += ' ($' + a.amount_original.toFixed(2) + ')';
      autoLines.push(line);
    }

    // 2) Manual: líneas de recordatorio + total a pagar a mano.
    let manualTotal = 0;
    const manualLines = toNotify.map((m) => {
      manualTotal += m.amount_pen;
      let line = '• ' + m.label + ' — S/ ' + m.amount_pen.toFixed(2);
      if (m.currency === 'USD' && m.amount_original) line += ' ($' + m.amount_original.toFixed(2) + ')';
      line += m.estado === 'atrasado'
        ? ' — ATRASADO (hace ' + m.dias_atraso + (m.dias_atraso === 1 ? ' día' : ' días') + ')'
        : ' — vence hoy';
      return line;
    });

    if (manualLines.length === 0 && autoLines.length === 0) return;

    let msg = '💸 Costos operativos\n\n';
    if (manualLines.length > 0) {
      msg += 'Por pagar:\n' + manualLines.join('\n') + '\n';
      msg += '\nTotal a pagar: S/ ' + manualTotal.toFixed(2) + '\n';
      msg += 'Márcalos como pagados en app.neto.pe/admin/costs\n';
    }
    if (autoLines.length > 0) {
      if (manualLines.length > 0) msg += '\n';
      msg += 'Débito automático hoy (verifica que pasó en tu tarjeta):\n' + autoLines.join('\n') + '\n';
    }

    await notificarAdmin(msg.trim());

    if (toNotify.length > 0) {
      const ids = toNotify.map((m) => m.id);
      const { error: errRecordado } = await supabase.from('admin_costs')
        .update({ last_reminder_sent_at: new Date().toISOString() })
        .in('id', ids);
      if (errRecordado) {
        log.error({ tag: 'COSTOS_REMIND', costos: ids.length, err: errRecordado.message }, 'El recordatorio de costos se envio pero el ledger no quedo marcado: se va a repetir');
      }
    }

    log.info({ tag: 'COSTOS_REMIND', manual: toNotify.length, auto: toAutoProcess.length, total: manualTotal.toFixed(2) },
      'Recordatorios/débitos de costos procesados');
  } catch (e) {
    log.error({ tag: 'COSTOS_REMIND', err: msgErr(e) }, 'Error recordatorio costos');
  }
}

/**
 * Conversión de recordatorios (T2, audit 2026-07-03).
 * Corre 7am Lima diario. Para cada survey_event de recordatorio cuya ventana de 24h ya
 * cerró, marca conversion_within_24h=true si el usuario registró una transacción dentro de
 * las 24h posteriores al envío. Antes estas columnas nunca se escribían (siempre false) y el
 * panel admin graficaba conversión 0 estructural.
 *
 * conversion_within_7d (webapp_invite) NO se calcula: requiere un timestamp de login en webapp
 * que hoy no se registra (solo existe supabase_auth_id sin fecha). Queda pendiente.
 */
const REMINDER_CONV_TYPES = ['reminder_d3', 'reminder_d7', 'reminder_d14', 'reminder_d30', 'inactivity_reminder', 'wake_up_inactive', 'pro_upsell_d28'];

async function checkSurveyConversions() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 7 || horaLima.getMinutes() > 14) return;
  try {
    const desde = new Date(Date.now() - 14 * 86400000).toISOString();
    const hasta = new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // ventana 24h ya cerrada
    const { data: eventos, error: errEventos } = await supabase.from('survey_events')
      .select('id, user_id, sent_at')
      .in('event_type', REMINDER_CONV_TYPES)
      .eq('conversion_within_24h', false)
      .not('sent_at', 'is', null)
      .gte('sent_at', desde).lte('sent_at', hasta);
    // No empuja nada, pero un fallo mudo acá reintroduce exactamente el síntoma que esta
    // función vino a curar: el panel admin vuelve a graficar 0% de conversión estructural,
    // que se lee como "los recordatorios no funcionan" y no como "nadie los evaluó".
    if (errEventos) {
      log.error({ tag: 'SURVEY_CONV', err: errEventos.message }, 'No se pudo leer los eventos: no se evaluó ninguna conversión');
      return;
    }
    if (!eventos || eventos.length === 0) return;

    let marcados = 0;
    let fallidos = 0;
    for (const ev of eventos) {
      try {
        const fin = new Date(new Date(ev.sent_at).getTime() + 24 * 3600 * 1000).toISOString();
        // La segunda ACCESORIA del archivo. Corre por evento (hasta cientos por corrida) con
        // un `catch` silencioso deliberado, así que un log por fallo sería ruido que nadie
        // lee. Se cuenta y se reporta UNA línea agregada al final: alcanza para distinguir
        // "nadie convirtió" de "no se pudo preguntar", que es la confusión que importa.
        const { count, error: errCount } = await supabase.from('transacciones')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', ev.user_id)
          .gte('created_at', ev.sent_at).lt('created_at', fin);
        if (errCount) { fallidos++; continue; }
        if (count && count > 0) {
          const { error: errConv } = await supabase.from('survey_events').update({ conversion_within_24h: true }).eq('id', ev.id);
          // Entra a la MISMA cuenta que las lecturas fallidas: las dos mitades producen el
          // mismo sintoma en el panel (una conversion que ocurrio y no figura).
          if (errConv) { fallidos++; continue; }
          marcados++;
        }
      } catch (e) {
        // La única de las ocho que NO lleva log por sitio, y es deliberado: corre por evento,
        // hasta cientos por corrida. Lo que estaba mal es que la cuenta agregada que ya existía
        // no contaba esto: un `sent_at` corrupto revienta el `.toISOString()` de la ventana y
        // el evento desaparecía sin entrar ni en `fallidos` ni en `marcados`, o sea que el
        // panel volvía a graficar la conversión subcontada — el síntoma exacto que esta
        // función vino a curar. Un throw y una lectura fallida son el mismo evento no evaluado.
        fallidos++;
      }
    }
    if (fallidos > 0) log.error({ tag: 'SURVEY_CONV', fallidos, evaluados: eventos.length }, 'Eventos que no se pudieron evaluar: la conversión que reporta el panel está subcontada');
    if (marcados > 0) log.info({ tag: 'SURVEY_CONV', marcados, evaluados: eventos.length }, 'Conversiones de recordatorio marcadas');
  } catch (e) {
    log.error({ tag: 'SURVEY_CONV', err: msgErr(e) }, 'Error calculando conversiones');
  }
}

/**
 * Recordatorio de cobro de suscripciones (Pro) — 10am Lima diario.
 *
 * Neto detecta suscripciones desde las transacciones (no hay tabla con fecha de
 * cobro), así que la próxima fecha se estima como el mismo día del último pago,
 * adelantada mes a mes hasta caer en el futuro. Avisa SUB_LEAD_DIAS antes.
 *
 * Solo suscripciones con estado 'activa' (match de catálogo, no las 'posible' por
 * patrón, para no generar ruido). Gate a Pro (getUserPlanConfig().recordatorios),
 * consistente con el intent recordatorio_pago.
 *
 * Dedup por ciclo vía `notificaciones` (mismo patrón que checkRecordatorioEspacios):
 * 1 aviso por suscripción cada 25 días. Fuera de la ventana 24h de Meta el mensaje
 * se bloquea igual que el resto de recordatorios proactivos (se registra en
 * notification_deliveries); cuando haya template aprobado se puede reforzar.
 */
const SUB_LEAD_DIAS = 3;

async function checkRecordatorioSuscripciones() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 10 || horaLima.getMinutes() > 14) return;
  try {
    const { detectarSuscripciones } = require('../services/subscriptions');
    const hoy = hoyPeru();
    const hoyDate = new Date(hoy + 'T12:00:00');
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, plan, recordatorios_activos')
      .eq('onboarding_completado', true);
    if (errUsuarios) {
      log.error({ tag: 'SUB_REMIND', err: errUsuarios.message }, 'No se pudo leer la población: no salió ningún aviso de cobro');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;

    let enviados = 0;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        // Sin `!usuario.whatsapp` desde el 27-ago (item 14): el aviso de cobro declara AMBOS,
        // así que el corte solo le apagaba la campana al Pro que entró por la web. Es de los
        // cuatro el que peor se lleva con el silencio junto al de Manos Libres — avisa de una
        // suscripción que está por cobrarse, o sea que caducaba con el mes.
        if (!getUserPlanConfig(usuario).recordatorios) continue; // Pro

        const { suscripciones_detectadas } = await detectarSuscripciones(usuario.id);
        if (!suscripciones_detectadas || suscripciones_detectadas.length === 0) continue;

        for (const sub of suscripciones_detectadas) {
          if (sub.estado !== 'activa' || !sub.ultimo_pago) continue;

          // Próxima fecha de cobro: mismo día del último pago, adelantado mes a mes.
          // Con `setMonth` el "mismo día" era mentira: un cobro del 31 saltaba al 3 del mes
          // subsiguiente y, como el avance es iterativo, se quedaba en el 3 para siempre.
          // El aviso solo sale si faltan exactamente SUB_LEAD_DIAS, así que el recordatorio
          // simplemente dejaba de salir. `sumarMeses` recorta al último día del mes destino.
          if (!/^\d{4}-\d{2}-\d{2}/.test(String(sub.ultimo_pago))) continue;
          let meses = 1;
          let next = new Date(sumarMeses(sub.ultimo_pago, meses) + 'T12:00:00');
          while (next < hoyDate && meses < 25) {
            meses++;
            next = new Date(sumarMeses(sub.ultimo_pago, meses) + 'T12:00:00');
          }
          const diasFalta = Math.round((next - hoyDate) / 86400000);
          if (diasFalta !== SUB_LEAD_DIAS) continue;

          // Dedup por ciclo: ¿ya avisamos de esta suscripción en los últimos 25 días?
          const titulo = 'Cobro próximo: ' + sub.nombre;
          const cutoff25d = new Date(Date.now() - 25 * 86400000).toISOString();
          // El quinto dedup que falla abierto, y el único donde el intercambio se discute.
          //
          // Acá decía que fallar cerrado sale gratis "porque con Supabase caída el envío
          // tampoco iba a funcionar", **y eso es falso**: el error está acotado a UNA request
          // de PostgREST sobre `notificaciones` (timeout, 5xx, RLS), mientras `notificarUsuario`
          // sale a Meta por otro camino. El envío podría haber funcionado perfectamente.
          //
          // El intercambio real, sin adornos. Este cron tiene UN tick por día (gate
          // 10:00-10:14, intervalo de 15 min), y el aviso sólo sale si faltan EXACTAMENTE 3
          // días, así que:
          //   · cortar cuesta el aviso de ESE ciclo, sin reintento hasta el mes que viene;
          //   · no cortar cuesta un duplicado sólo si `detectarSuscripciones` mueve
          //     `ultimo_pago` y vuelve a dar 3 días dentro de la ventana de 25 días.
          // O sea que el costo de cortar es más probable que el de no cortar. Va cerrado igual
          // por una razón que no es aritmética: el duplicado habla de PLATA que se le va a
          // cobrar al usuario, y un aviso de cobro repetido se lee como un cobro repetido.
          const { data: yaAviso, error: errDedup } = await supabase.from('notificaciones')
            .select('id').eq('usuario_id', usuario.id).eq('tipo', 'recordatorio')
            .eq('titulo', titulo).gte('fecha', cutoff25d).limit(1);
          if (errDedup) {
            log.error({ tag: 'SUB_REMIND', userId: usuario.id, sub: sub.nombre, err: errDedup.message }, 'No se pudo comprobar el dedup: no se avisa este cobro');
            continue;
          }
          if (yaAviso && yaAviso.length > 0) continue;

          const sym = sub.moneda === 'USD' ? '$' : 'S/';
          const montoStr = sym + ' ' + parseFloat(sub.monto_detectado).toFixed(2);
          const pn = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
          const dd = String(next.getDate()).padStart(2, '0');
          const msg = (sub.icono ? sub.icono + ' ' : '') + (pn ? pn + ', ' : '') +
            'en 3 días se te cobra *' + sub.nombre + '* (' + montoStr + '), el ' + dd + '.\n\n' +
            '_Si ya no la usas, es buen momento para cancelarla._';

          await notificarUsuario({
            canales: CANALES.AMBOS,
            usuarioId: usuario.id, whatsapp: usuario.whatsapp,
            tipo: 'suscripcion_cobro', mensaje: msg,
            titulo, tipoInApp: 'recordatorio',
            link: '/dashboard/suscripciones',
            // A PROPÓSITO sin `claimInApp`, a diferencia de los otros tres avisos con dedup
            // por fecha. Acá el intercambio se da vuelta:
            //   · No tiene el problema que el claim resuelve. B6 es "el cron re-manda hasta
            //     16 veces al día"; este aviso solo sale si faltan EXACTAMENTE 3 días para
            //     el cobro y en la ventana de las 10:00-10:14, o sea una vez y punto.
            //   · Y fallar cerrado acá cuesta el aviso ENTERO: al día siguiente faltan 2
            //     días, el `continue` de arriba lo descarta, y el ciclo de 25 días se pierde
            //     sin reintento. El "se reintenta en la próxima corrida" que justifica el
            //     claim no aplica a un aviso anclado a un día exacto.
            // Lo detectó el revisor del diff de la ola 4; la primera versión sí lo llevaba.
          });
          enviados++;
        }
      } catch (e) {
        // Se pierden TODAS las suscripciones de este usuario, no una: `detectarSuscripciones`
        // corre antes del loop interno. Y el aviso está anclado a "faltan exactamente 3 días",
        // así que no hay reintento hasta el ciclo que viene — el mismo motivo por el que este
        // sitio no lleva `claimInApp`.
        log.error({ tag: 'SUB_REMIND', err: msgErr(e), usuarioId: usuario.id }, 'Recordatorios de suscripción omitidos para el usuario');
      }
    }
    if (enviados > 0) log.info({ tag: 'SUB_REMIND', enviados }, 'Recordatorios de suscripción enviados');
  } catch (e) { log.error({ tag: 'SUB_REMIND', err: msgErr(e) }, 'Error recordatorio suscripciones'); }
}

/**
 * Modo Manos Libres (Pro, opt-in) — 9pm Lima diario.
 *
 * Solo usuarios con manos_libres = true. Envía el resumen del día (generarResumenDiario,
 * que devuelve null si no hubo gastos → no se manda nada esos días). A diferencia del
 * cron de inactividad (UPDATE-08, anti-fatiga), este es explícitamente opt-in: el usuario
 * lo activa con /manoslibres o desde la webapp.
 */
async function checkResumenDiarioManosLibres() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 21 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, plan, recordatorios_activos, manos_libres')
      .eq('onboarding_completado', true).eq('manos_libres', true);
    // Manos Libres es opt-in explícito: el usuario lo prendió y espera su resumen todas las
    // noches. Es el único cron donde el silencio contradice algo que la persona pidió.
    if (errUsuarios) {
      log.error({ tag: 'RESUMEN_DIARIO', err: errUsuarios.message }, 'No se pudo leer la población: nadie recibió su resumen diario');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;

    let enviados = 0;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        // Sin `!usuario.whatsapp` desde el 27-ago (item 14), y de los cuatro cortes éste era
        // el más difícil de defender: el comentario de arriba ya decía que Manos Libres es
        // opt-in explícito y *"el único cron donde el silencio contradice algo que la persona
        // pidió"*. Al Pro web-first le contradecía eso todas las noches, sin dejar más rastro
        // que un `continue`.
        if (!getUserPlanConfig(usuario).resumenDiario) continue; // Pro

        const resumen = await generarResumenDiario(usuario);
        if (!resumen) continue;

        await notificarUsuario({
          canales: CANALES.AMBOS,
          usuarioId: usuario.id, whatsapp: usuario.whatsapp,
          tipo: 'resumen_diario', mensaje: resumen,
          titulo: 'Tu resumen de hoy',
          cuerpo: resumen.replace(/[*_]/g, '').substring(0, 400),
          link: '/dashboard',
        });
        enviados++;
      } catch (e) {
        // Manos Libres es opt-in explícito: esta persona prendió el resumen y lo espera todas
        // las noches. Es el único de los ocho donde el silencio contradice algo que pidió.
        log.error({ tag: 'RESUMEN_DIARIO', err: msgErr(e), usuarioId: usuario.id }, 'Resumen diario omitido para el usuario');
      }
    }
    if (enviados > 0) log.info({ tag: 'RESUMEN_DIARIO', enviados }, 'Resúmenes diarios (manos libres) enviados');
  } catch (e) { log.error({ tag: 'RESUMEN_DIARIO', err: msgErr(e) }, 'Error resumen diario manos libres'); }
}

// Limpieza periódica de OTPs de verificación web vencidos (evita acumulación de filas muertas;
// el unique index por supabase_auth_id ya reemplaza al regenerar, esto borra los abandonados).
/**
 * Barrido de accesos a Gmail colgados: cuentas activas de quien ya no es Pro pagado.
 *
 * Lo que corrige es un permiso VIVO, no un cupo: el cupo de Google se pierde al conectar y no
 * vuelve (ver `revocarAccesoGmail`). Lo que este barrido evita es seguir teniendo permiso de
 * lectura sobre la bandeja de alguien que dejó de pagar.
 *
 * Las dos bajas de plan (checkTrialExpiry, checkPremiumExpiry) ya revocan en el momento, así
 * que en régimen esto no debería encontrar nada. Existe igual, y no como script de una vez,
 * porque se cuela por caminos que no pasan por esos crons: un downgrade por SQL a mano
 * (pasó el 01-ago), un cron que muere a mitad del loop, un plan cambiado desde el panel admin.
 *
 * NO notifica: a estos usuarios ya se les avisó cuando venció su plan, y un WhatsApp sobre
 * algo que pasó hace semanas se lee como spam. Por eso está exento en
 * `tests/cron/lecturas-proactivas.test.js`.
 */
async function checkGmailHuerfanos() {
  try {
    // La verdad de "quién tiene cupo tomado" está en gmail_cuentas, así que se arranca de ahí
    // y no de usuarios: barre también al que ya no aparecería en una query por plan.
    const { data: cuentas, error: errCuentas } = await supabase.from('gmail_cuentas')
      .select('usuario_id, usuarios!inner(id, plan, trial_estado)')
      .eq('activa', true);
    // Este barrido está para no encontrar nada en régimen, así que su silencio normal y su
    // silencio por caída son idénticos. Lo que queda vivo si falla es un permiso de lectura
    // sobre la bandeja de alguien que dejó de pagar: se registra aunque no notifique.
    if (errCuentas) {
      log.error({ tag: 'GMAIL_HUERFANOS', err: errCuentas.message }, 'No se pudo leer las cuentas activas: no se revocó ningún acceso colgado');
      return;
    }
    if (!cuentas || cuentas.length === 0) return;

    const huerfanos = [...new Map(
      cuentas.filter((c) => !esProPagado(c.usuarios)).map((c) => [c.usuario_id, c.usuarios]),
    ).keys()];
    if (huerfanos.length === 0) return;

    let revocadasTotal = 0;
    for (const usuarioId of huerfanos) {
      try {
        const { revocadas } = await revocarAccesoGmail(usuarioId, { motivo: 'barrido_huerfanos' });
        revocadasTotal += revocadas;
      } catch (e) {
        log.error({ tag: 'GMAIL_HUERFANOS', usuarioId, err: msgErr(e) }, 'No se pudo revocar; se reintenta mañana');
      }
    }
    log.info({ tag: 'GMAIL_HUERFANOS', usuarios: huerfanos.length, revocadas: revocadasTotal }, 'Accesos a Gmail de no-pagadores revocados');
  } catch (e) {
    log.error({ tag: 'GMAIL_HUERFANOS', err: msgErr(e) }, 'Error general en el barrido de accesos Gmail');
  }
}

async function limpiarOTPVencidos() {
  try {
    // El `catch` de abajo nunca se iba a ejecutar: supabase-js no lanza. O sea que el log de
    // esta funcion era inalcanzable y el barrido fallaba mudo.
    //
    // Accesoria de verdad: un OTP vencido que no se borra no autentica a nadie igual —lo
    // rechaza el chequeo de expiracion al usarlo— asi que esto no corta ni tira. Lo unico
    // que se pierde es la limpieza, y eso ahora se dice.
    const { error } = await supabase.from('webapp_otp').delete().lt('expires_at', new Date().toISOString());
    if (error) log.warn({ tag: 'OTP_CLEANUP', err: error.message }, 'No se pudieron borrar los OTP vencidos: quedan en la tabla (siguen siendo invalidos)');
  } catch (e) { log.warn({ tag: 'OTP_CLEANUP', err: msgErr(e) }, 'Error limpiando OTPs vencidos'); }
}

// Retencion de la campana. La tabla `notificaciones` no se podaba NUNCA: al medirla el
// 2026-08-27 la fila viva mas vieja era del 3 de abril (146 dias), un usuario acumulaba 786
// filas y otro 364. El problema no es el espacio (1848 filas en total): es que `total` no tiene
// techo, o sea que "¿la campana es ruidosa?" se vuelve incontestable, y un aviso de abril que
// dice "tu deuda vence en 7 dias" es ruido por definicion.
//
// Las dos clausulas y por que hacen falta las dos estan en `migrations/077`. Los numeros van
// aca como constantes y no dentro de la funcion de Postgres a proposito: cambiarlos es una
// decision de producto y tiene que verse en un diff de este repo, no en una migracion aplicada.
const RETENCION_DIAS = 90;
const RETENCION_TOPE_POR_USUARIO = 100;

async function checkRetencionNotificaciones() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  // 4am: la unica franja donde no compite con ningun otro cron de esta tabla.
  if (horaLima.getHours() !== 4 || horaLima.getMinutes() > 14) return;
  try {
    const { data, error } = await supabase.rpc('notificaciones_podar', {
      p_dias: RETENCION_DIAS,
      p_tope: RETENCION_TOPE_POR_USUARIO,
    }).maybeSingle();
    // supabase-js no lanza: sin leer esto, una poda que dejo de correr se ve identica a una
    // que no tenia nada que borrar — que es el estado normal a partir del segundo dia.
    if (error) {
      log.error({ tag: 'RETENCION', err: error.message }, 'La poda de notificaciones no corrio');
      return;
    }
    const porEdad = Number(data?.por_edad ?? 0);
    const porTope = Number(data?.por_tope ?? 0);
    // Se loguea SIEMPRE, incluido el cero: el cero es la unica evidencia de que corrio y no
    // encontro nada, y sin el la ausencia de linea significaria las dos cosas a la vez.
    log.info({ tag: 'RETENCION', porEdad, porTope, dias: RETENCION_DIAS, tope: RETENCION_TOPE_POR_USUARIO },
      'Poda de notificaciones');
  } catch (e) {
    log.error({ tag: 'RETENCION', err: e.message }, 'La poda de notificaciones lanzo');
  }
}

module.exports = {
  // Exportado para su test: es el predicado que decide si se abre la ventana de comprobante,
  // y equivocarse ahí le rompe el registro por foto a quien nunca recibió el aviso.
  llegoElAviso,
  checkResumenMensual,
  checkResumenSemanal,
  checkResumenDiarioManosLibres,
  limpiarOTPVencidos,
  checkGmailHuerfanos,
  checkRecordatorioDiario,
  checkPremiumExpiry,
  checkTrialExpiry,
  checkAlertasProactivas,
  checkRecordatorioOnboarding,
  checkActivacionDia2,
  checkRecordatorioDeudas,
  checkRecordatorioSuscripciones,
  checkCalcularNetoScore,
  checkNotificacionScore,
  checkDetectorFugas,
  checkCheckInPlanes,
  checkRecordatorioEspacios,
  checkRecordatoriosCostos,
  checkSurveyTriggers,
  checkSurveyConversions,
  checkRetencionNotificaciones,
};
