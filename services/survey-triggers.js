/**
 * Survey Triggers — UPDATE-05
 *
 * Sistema de engagement por WhatsApp + invite a webapp.
 * Reglas operativas (basadas en research docs/research/whatsapp-surveys-research.md):
 *
 *   - Maximo 1 mensaje proactivo cada 7 dias por usuario (anti-fatiga + WhatsApp Quality Rating)
 *   - Respeta usuarios.recordatorios_activos = false (opt-out global)
 *   - No manda si hubo error reciente del usuario en ultimas 24h
 *   - One-shot triggers (webapp_invite_10tx, feedback_open_30tx, nps_inapp) usan unique
 *     constraint en DB para garantizar entrega unica
 *   - Hora de envio: 10am Lima (research: 9-11:30am es optimal en LATAM)
 */

const { supabase } = require('../lib/db');
const { notificarUsuario, CANALES } = require('../lib/notify-user');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');

const MIN_DAYS_BETWEEN_PROACTIVE = 7;
const ERROR_BLACKOUT_HOURS = 24;

/**
 * Los canales que cuentan como EMPUJE. Espejo de `CANALES_EMPUJE` en `cron/checks.js`, que es
 * quien escribe las filas que esta funcion lee.
 *
 * `webapp` queda afuera a proposito: es `nps_inapp`, una encuesta que se muestra cuando la
 * persona ya esta adentro de la app. No es un empuje y no deberia gastar esta ventana.
 *
 * `in_app` entro el 27-ago-2026, cuando `checkRecordatorioDiario` dejo de cortar a quien no
 * tiene numero y sus avisos empezaron a salir por la campana sola. Sin este valor, esas filas
 * no matchean y el usuario web-first queda fuera de la anti-fatiga: recibe su recordatorio de
 * inactividad y ademas los ocho triggers, todos en la misma semana.
 *
 * **Inocuo sobre los datos existentes**: al 27-ago no habia ninguna fila `in_app` (396
 * `whatsapp` + 6 `webapp`), asi que este `.in()` selecciona lo mismo que el `.eq('whatsapp')`
 * que reemplaza. Solo difiere sobre filas nuevas.
 */
const CANALES_EMPUJE = ['whatsapp', 'in_app'];

/** Devuelve true si al usuario YA se le mando algun mensaje proactivo en los ultimos N dias. */
async function recibioMensajeRecienteProactivo(userId, dias = MIN_DAYS_BETWEEN_PROACTIVE) {
  const cutoff = new Date(Date.now() - dias * 86400000).toISOString();
  const { data, error } = await supabase.from('survey_events')
    .select('id')
    .eq('user_id', userId)
    .in('channel', CANALES_EMPUJE)
    .gte('sent_at', cutoff)
    .limit(1);
  // Falla ABIERTO, y es el gate de los OCHO triggers: sin leer el error, `data` viene null,
  // esto devuelve false —"no le avisamos nada en 7 dias"— y el runner sigue de largo hasta
  // mandar. Una caida de Supabase no silencia el mensaje, lo DISPARA, y justo contra la
  // poblacion que la anti-fatiga existe para proteger.
  //
  // Tira en vez de devolver true porque el destino es el mismo (no mandar) pero el rastro no:
  // lo agarra el catch per-user de `checkSurveyTriggers`, que loguea con el userId y sigue
  // con el resto de la lista. Un `return true` mudo se leeria igual que "ya le avisamos".
  if (error) throw error;
  return Boolean(data && data.length > 0);
}

/** True si el usuario tuvo un error reciente. Evita encuestar tras una mala experiencia. */
async function tuvoErrorReciente(userId, horas = ERROR_BLACKOUT_HOURS) {
  const cutoff = new Date(Date.now() - horas * 3600 * 1000).toISOString();
  const { data: errs, error: errConsulta } = await supabase.from('errores')
    .select('id').eq('usuario_id', userId).gte('created_at', cutoff).limit(1);
  // Las dos fallan ABIERTO y con una ironia propia: la tabla que no se puede leer es la de
  // errores, o sea que el momento mas probable de que esta lectura falle es exactamente
  // cuando el usuario acaba de tener un mal rato. Sin leer el error devuelve false —"no tuvo
  // ningun problema"— y encima le llega la encuesta.
  if (errConsulta) throw errConsulta;
  if (errs && errs.length > 0) return true;
  const { data: nlpErrs, error: errNlp } = await supabase.from('nlp_errors')
    .select('id').eq('usuario_id', userId).gte('created_at', cutoff).limit(1);
  if (errNlp) throw errNlp;
  return Boolean(nlpErrs && nlpErrs.length > 0);
}

/** Cuenta transacciones del usuario (no eliminadas). */
async function contarTransacciones(userId) {
  const { count, error } = await supabase.from('transacciones')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', userId);
  // `count || 0` convierte un fallo en "este usuario nunca anoto nada", que es la peor
  // respuesta posible porque hace DOS danos opuestos a la vez:
  //   · dispara `reminder_d3`/`d7` (`if (txCount > 0) return false`) contra alguien que
  //     lleva meses anotando, con copy de primer gasto;
  //   · y le elige el copy equivocado a `wake_up_inactive`, que se bifurca por `txTotal === 0`
  //     entre "todavia no arrancaste" y "hace tiempo que no vuelves".
  // Nada de eso se ve en un log: el cron cuenta el envio como exitoso.
  if (error) throw error;
  return count || 0;
}

/** Cuenta transacciones del usuario en los ultimos N dias. */
async function contarTransaccionesUltimos(userId, dias) {
  const cutoff = new Date(Date.now() - dias * 86400000).toISOString().split('T')[0];
  const { count, error } = await supabase.from('transacciones')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', userId)
    .gte('fecha', cutoff);
  // Mismo `count || 0`, y los tres call-sites lo leen como permiso para mandar: `d14` corta
  // con `>= 3`, `d30` con `> 0` y `wake_up_inactive` con `> 0`. El cero de un fallo pasa los
  // tres.
  if (error) throw error;
  return count || 0;
}

/** Inserta survey_event marcando idempotencia para los one-shot tipos via unique index. */
async function registrarEvento({ userId, eventType, channel, messageSent, responseData = null }) {
  const { data, error } = await supabase.from('survey_events').insert({
    user_id: userId,
    event_type: eventType,
    channel,
    sent_at: new Date().toISOString(),
    message_sent: messageSent,
    response_data: responseData,
  }).select('id').single();
  if (error) {
    if (error.code === '23505') return null; // duplicate (unique constraint hit) — idempotente
    throw error;
  }
  return data?.id || null;
}

/**
 * ¿El aviso salio por ALGUN canal? Espejo del veredicto de `lib/notify-user.js`, que loguea
 * "Aviso proactivo sin entrega en ningun canal" con exactamente esta cuenta.
 *
 * Vive en UNA sola funcion porque la primera version lo copio a medias —solo la mitad de
 * WhatsApp— y las dos que faltaban muerden en direcciones opuestas: sin `email` un correo
 * entregado se lee como "no salio nada", y sin `test_user` un silencio pedido se lee como un
 * canal caido. Los dos consumidores (`enviarYRegistrar` y `liberarClaimSinEntrega`) hacen cosas
 * distintas con la respuesta, pero la pregunta es la misma y no puede tener dos respuestas.
 *
 * Defensivo con la forma: si el chokepoint devolviera algo raro, "no salio nada" es el lado
 * seguro para los dos (no registrar / liberar el claim), o sea reintentar.
 */
function salioPorAlgunCanal(resultado) {
  const wa = (resultado && resultado.wa) || {};
  const mail = (resultado && resultado.email) || {};
  if (wa.skipped === 'test_user') return true;   // silencio pedido, no fallo
  if (wa.ok === true && !wa.skipped) return true;
  if (mail.ok === true && !mail.skipped) return true;
  return resultado ? resultado.inApp === true : false;
}

/**
 * Devuelve el claim de un one-shot cuando el aviso no salio por NINGUN canal.
 *
 * **Por que hace falta desde el 01-sep-2026 (item 23), y no antes.** Los one-shot reclaman su
 * unique index ANTES de enviar, que es correcto: sin eso, dos corridas mandan el mismo mensaje.
 * El precio es que un fallo del envio quema la unica vez que se manda. Hasta el 01-sep eso era
 * tolerable porque el destinatario siempre tenia WhatsApp —el corte del bucle garantizaba el
 * numero— asi que el fallo era el 131047 de Meta, permanente, y reintentar no compraba nada.
 *
 * Para el usuario sin numero la campana es el UNICO canal, y `crearNotificacion` **devuelve
 * `false` en vez de lanzar** (supabase-js no lanza): un hipo de la base deja la fila de
 * `survey_events` puesta, la campana vacia, y el trigger devuelto como exitoso. Nadie se entera
 * y no hay reintento posible nunca mas.
 *
 * **Solo se llama desde las ramas que declararon el canal in-app**, y eso acota el riesgo del
 * arreglo: si se llamara desde un `SOLO_WHATSAPP`, un numero permanentemente inalcanzable
 * liberaria su claim todos los dias y el one-shot se convertiria en un cron diario **de mensajes
 * que si salen**, porque `enviarWhatsapp` sigue POSTeando a Meta aunque el 131047 llegue despues.
 *
 * Con in-app declarado el reintento es barato y acotado por construccion: se reintenta
 * exactamente mientras no salga NADA, y una corrida que tampoco entrega no le manda nada a nadie.
 * (Una version anterior de este parrafo decia que "cero canales significa que se cayeron los dos
 * a la vez, o sea infra". Es falso justo para la poblacion del arreglo: para el usuario sin
 * numero WhatsApp es un no-op de diseño —`skipped_no_whatsapp`— asi que cero canales significa
 * que fallo UNO. Lo que sostiene el arreglo no es que el fallo sea raro, es que el reintento no
 * cuesta un mensaje.)
 *
 * **El predicado de "no salio nada" es el mismo de `lib/notify-user.js`, los TRES canales.** La
 * primera version copio solo la mitad de WhatsApp: con `email` declarado —que es lo que el
 * CLAUDE.md empuja para los avisos que importan— un correo entregado se leia como "no salio
 * nada" y liberaba el claim, o sea un correo identico por dia. Y `skipped: 'test_user'` no es un
 * fallo: es un silencio pedido, y tratarlo como canal caido reintenta contra una cuenta de prueba.
 *
 * El DELETE va por `id` y con `.select('id')`: postgrest no devuelve error cuando no matchea
 * ninguna fila, asi que sin eso "no se pudo liberar" y "se libero" se ven igual.
 */
async function liberarClaimSinEntrega(eventoId, eventType, usuarioId, resultado) {
  if (salioPorAlgunCanal(resultado)) return false;

  const { data, error } = await supabase.from('survey_events')
    .delete().eq('id', eventoId).select('id');
  if (error) {
    log.error({ tag: 'SURVEY_TRIG', usuarioId, eventType, eventoId, err: error.message },
      'El aviso no salio por ningun canal y el claim NO se pudo liberar: este one-shot ya no se manda nunca');
    return false;
  }
  if (!data || data.length === 0) {
    log.error({ tag: 'SURVEY_TRIG', usuarioId, eventType, eventoId },
      'El aviso no salio por ningun canal y el claim ya no estaba: este one-shot ya no se manda nunca');
    return false;
  }
  log.warn({ tag: 'SURVEY_TRIG', usuarioId, eventType },
    'El aviso no salio por ningun canal: claim liberado, se reintenta en la proxima corrida');
  return true;
}

/**
 * Titulo, CUERPO y deeplink de la mitad in-app de cada recordatorio.
 *
 * Van los dos canales porque estos mensajes persiguen justo a quien dejo de escribir: por
 * definicion, la poblacion con mas chances de estar fuera de la ventana de 24h de Meta.
 *
 * **El `cuerpo` entro el 01-sep-2026 (item 23) y no es cosmetica.** Sin el, el chokepoint
 * deriva el texto in-app del de WhatsApp, y los cuatro copys de WhatsApp piden acciones que
 * solo existen en WhatsApp: *"escribeme cosas como…"*, *"sacale screenshot y mandamelo"*,
 * *"escribe /silenciar"*. Al usuario web-first —que ahora si recibe la campana, porque el
 * corte por falta de numero se fue— eso le pide algo que no puede hacer.
 *
 * El texto es UNO SOLO para las dos poblaciones, no dos copys bifurcados por si tiene numero:
 * la campana se lee DENTRO de la app, asi que apuntar a la app es correcto tambien para quien
 * si tiene WhatsApp. Bifurcar seria un segundo copy por trigger que envejece por separado.
 *
 * **"Anota un gasto" es accionable incluso para quien esta en el muro**, y hace falta decirlo
 * porque el destinatario de `reminder_d3`/`d7` esta ahi por construccion (los dos exigen
 * `txCount === 0`, y el trial arranca con el PRIMER gasto: sin gasto no hay trial). El
 * `QuickAddButton` vive en el chrome del dashboard, fuera del bloque que el muro reemplaza por
 * el Paywall (`webapp/src/components/dashboard/dashboard-shell.tsx`), asi que esta en todas las
 * rutas por igual. Es la regla del producto: escribir nunca se corta, lo que se cobra es leer.
 *
 * Y por eso el `link` sigue siendo `/dashboard` y no `/dashboard/transacciones`: para el muro
 * las dos rutas muestran el mismo Paywall con el mismo boton flotante encima, asi que apuntar
 * a la pantalla de transacciones no compra nada. (Se intento el 01-sep con el argumento de que
 * "ahi esta el quick-add"; medido, el quick-add esta en las dos.)
 *
 * Ninguno menciona `/silenciar`: ese comando solo existe en el chat. En la app la baja vive en
 * Configuracion, y prometer un comando inexistente es la misma clase de mentira que este
 * cuerpo vino a arreglar.
 */
const IN_APP_RECORDATORIO = {
  reminder_d3: {
    titulo: 'Registrar un gasto toma 2 segundos',
    cuerpo: 'Todavía no anotaste nada. Empieza por un gasto de hoy y Neto arma tus reportes solo.',
    link: '/dashboard',
  },
  reminder_d7: {
    titulo: 'Una semana con Neto',
    cuerpo: 'Llevas una semana sin anotar nada. Con un gasto ya empiezas a ver a dónde se te va la plata.',
    link: '/dashboard',
  },
  reminder_d14: {
    titulo: '¿Algo te complica con Neto?',
    cuerpo: 'Estás usando Neto poco esta semana. Si solo tuviste una semana ocupada, sigue cuando quieras.',
    link: '/dashboard',
  },
  reminder_d30: {
    titulo: 'Hace dos semanas que no registras nada',
    cuerpo: 'Si quieres retomarlo, anota cualquier gasto de hoy y arrancamos donde lo dejaste.',
    link: '/dashboard',
  },
};

/**
 * Envia el mensaje y registra el evento. **Si no salio por ningun canal, NO registra**, asi que
 * se reintenta en la proxima corrida.
 *
 * Ese "si falla no registra" estaba escrito aca desde siempre y era FALSO: `notificarUsuario` es
 * best-effort y nunca lanza, y esta funcion descartaba su retorno, asi que `registrarEvento`
 * corria entregara lo que entregara. La fila que quedaba hacia dos daños, los dos permanentes:
 * el dedup por tipo de cada `maybeReminderD*` corta con CUALQUIER fila previa —o sea que ese
 * recordatorio no se manda nunca mas— y ademas gasta la anti-fatiga de 7 dias, con lo cual un
 * aviso que no salio apaga al siguiente que si habria salido.
 *
 * Hasta el 01-sep-2026 era casi inalcanzable porque el destinatario siempre tenia numero y el
 * POST a Meta se aceptaba (el 131047 llega por callback, DESPUES). Para el usuario web-first la
 * campana es el unico canal y `crearNotificacion` devuelve `false` en vez de lanzar.
 *
 * Es la misma clase que `liberarClaimSinEntrega`, resuelta al reves porque aca el orden lo
 * permite: el one-shot tiene que reclamar ANTES de enviar y compensar despues; esto registra
 * DESPUES, asi que alcanza con no registrar.
 */
async function enviarYRegistrar(usuario, eventType, mensaje) {
  const inApp = IN_APP_RECORDATORIO[eventType];
  const resultado = await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id,
    whatsapp: usuario.whatsapp || null,
    tipo: 'survey_' + eventType,
    mensaje,
    titulo: inApp ? inApp.titulo : 'Un recordatorio de Neto',
    cuerpo: inApp ? inApp.cuerpo : null,
    tipoInApp: 'recordatorio',
    link: inApp ? inApp.link : '/dashboard',
  });
  if (!salioPorAlgunCanal(resultado)) {
    log.warn({ tag: 'SURVEY_TRIG', usuarioId: usuario.id, eventType },
      'El recordatorio no salio por ningun canal: no se registra, se reintenta en la proxima corrida');
    return null;
  }
  return registrarEvento({
    userId: usuario.id,
    eventType,
    // El canal REAL, no la etiqueta de siempre. Esta columna es lo que lee la anti-fatiga de
    // 7 dias (`recibioMensajeRecienteProactivo`, via CANALES_EMPUJE), asi que decir `whatsapp`
    // sobre un aviso que salio solo por la campana apaga los OCHO triggers una semana para
    // alguien a quien nunca se le mando un WhatsApp. Misma forma que el insert de
    // `checkUpsellPro` en `cron/checks.js`, a proposito: la comparten los dos guards.
    channel: usuario.whatsapp ? 'whatsapp' : 'in_app',
    messageSent: mensaje,
  });
}

// ===== Generadores de copy =====

function copyReminderD3(primerNombre) {
  const saludo = primerNombre ? primerNombre + ', ¿' : '¿';
  return `Hola ${saludo}qué tal va tu semana?\n\n` +
    'Te escribo para recordarte que registrar gastos en Neto es súper rápido. Solo escríbeme cosas como:\n' +
    '_"gasté 25 en almuerzo"_\n_"taxi 12 soles"_\n\n' +
    'O envíame foto de tu Yape/Plin y yo lo registro por ti.\n\n' +
    '¿Te animas a probar con tu último gasto?\n\n' +
    '_Si no quieres más recordatorios escribe /silenciar_';
}

function copyReminderD7(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, una semana ya 👀\n\n` +
    'Sin pelo en la lengua: registrar gastos no es divertido pero saber a dónde se te va la plata, sí.\n\n' +
    'Tip rápido: la próxima vez que pagues algo con Yape, sácale screenshot y mándamelo. Te toma 2 segundos y yo hago el resto.\n\n' +
    '_Para silenciar recordatorios escribe /silenciar_';
}

function copyReminderD14(primerNombre) {
  const saludo = primerNombre ? primerNombre + ', vi' : 'Vi';
  return `Oye ${saludo} que estás usando Neto poco esta semana.\n\n` +
    '¿Hay algo que te complica o que esperabas que funcionara distinto? Cuéntame en una sola línea, lo leo todo.\n\n' +
    'Si solo tuviste una semana ocupada, ningún problema, sigue cuando quieras.\n\n' +
    '_/silenciar para no recibir más recordatorios_';
}

function copyReminderD30(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, hace dos semanas que no registras nada en Neto.\n\n` +
    '¿Pasó algo? ¿Encontraste otra forma de llevar tus gastos, o simplemente se te olvidó?\n\n' +
    'Si quieres retomarlo, mándame cualquier gasto de hoy y arrancamos. Si prefieres pausarlo, escribe /silenciar y dejamos de molestarte.';
}

function copyWebappInvite(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, ya registraste 10 gastos con Neto 🎯\n\n` +
    '¿Sabías que también tienes una app web con tus charts, presupuestos visuales y reportes? Te toma 10 segundos entrar:\n\n' +
    '👉 https://app.neto.pe\n\n' +
    'Solo entras con tu Google y ya está, todo lo que registras por WhatsApp aparece ahí.\n\n' +
    '_Si no te interesa por ahora ningún problema, seguimos por aquí._';
}

function copyWakeUpInactiveNuevo(primerNombre) {
  const saludo = primerNombre ? primerNombre + ', hace' : 'Hace';
  return `Hola ${saludo} tiempo que no hablamos.\n\n` +
    'Te registraste en Neto pero quizás no llegaste a probarlo aún. ¿Quieres que te muestre cómo va? Solo escríbeme un gasto cualquiera, ej:\n\n' +
    '_"gasté 30 en almuerzo"_\n\n' +
    'Y verás lo rápido que es. Si ya no te interesa, escribe /silenciar y no te molesto más.';
}

function copyWakeUpInactiveChurn(primerNombre) {
  const saludo = primerNombre ? primerNombre + ', hace' : 'Hace';
  return `Hola ${saludo} tiempo que no registras nada en Neto.\n\n` +
    'Sin reproches: ¿pasó algo, encontraste otra forma de llevar tus gastos, o simplemente se te olvidó? Si quieres retomarlo, mándame cualquier gasto de hoy y arrancamos.\n\n' +
    'Si prefieres pausarlo definitivamente, escribe /silenciar.';
}

function copyFeedback30(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, llevamos 30 gastos juntos, ya eres usuario veterano 🙌\n\n` +
    'Una pregunta corta para mejorar Neto: si pudieras cambiar UNA sola cosa del producto, ¿qué sería?\n\n' +
    'Lo que se te venga primero a la mente. Una línea basta.';
}

function copyWakeUpOnboardingNombre() {
  return 'Hola, te registraste en Neto hace unos días pero el setup quedó a medias.\n\n' +
    'Solo me faltó saber cómo te llamas. Escríbeme tu nombre y te activo en 30 segundos. Ej:\n\n' +
    '_Carlos_\n_María Fernanda_\n\n' +
    'Si ya no te interesa, escribe /silenciar y no te molesto más.';
}

function copyWakeUpOnboardingEmail(primerNombre) {
  const nombre = primerNombre || 'Hola';
  return `${nombre}, casi lo logramos pero el setup quedó a medias.\n\n` +
    'Solo me faltó tu email para activarte. Escríbeme tu correo y arrancamos. Ej:\n\n' +
    '_juan@gmail.com_\n\n' +
    'Es el último paso, prometido. Si no te interesa más, escribe /silenciar.';
}

function copyWakeUpOnboardingGenerico() {
  return 'Hola, vi que te registraste en Neto pero el setup quedó incompleto.\n\n' +
    '¿Quieres que te ayude a terminar? Solo escríbeme tu nombre y te guío paso a paso.\n\n' +
    'Si prefieres, escribe /silenciar y no te molesto más.';
}

// ===== Triggers =====

/** Verifica si el usuario califica para reminder_d3 y manda el mensaje. */
async function maybeReminderD3(usuario) {
  const txCount = await contarTransacciones(usuario.id);
  if (txCount > 0) return false;

  const created = new Date(usuario.created_at).getTime();
  const dias = (Date.now() - created) / 86400000;
  if (dias < 3 || dias >= 4) return false;

  // No reenviar si ya recibio reminder_d3 antes
  const { data: prev, error: errPrev } = await supabase.from('survey_events')
    .select('id').eq('user_id', usuario.id).eq('event_type', 'reminder_d3').limit(1);
  // Dedup que falla ABIERTO: sin leer el error `prev` viene null, el corte de abajo no
  // dispara y el reminder se manda DE NUEVO. El unico freno que quedaria es la anti-fatiga de
  // 7 dias de arriba — que en el mismo escenario tambien esta fallando abierto.
  if (errPrev) throw errPrev;
  if (prev && prev.length > 0) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  await enviarYRegistrar(usuario, 'reminder_d3', copyReminderD3(primer));
  return true;
}

async function maybeReminderD7(usuario) {
  const txCount = await contarTransacciones(usuario.id);
  if (txCount > 0) return false;

  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 7 || dias >= 8) return false;

  const { data: prev, error: errPrev } = await supabase.from('survey_events')
    .select('id').eq('user_id', usuario.id).eq('event_type', 'reminder_d7').limit(1);
  if (errPrev) throw errPrev;
  if (prev && prev.length > 0) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  await enviarYRegistrar(usuario, 'reminder_d7', copyReminderD7(primer));
  return true;
}

async function maybeReminderD14(usuario) {
  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 14 || dias >= 15) return false;

  // EXENCION DECLARADA (item 23, 01-sep-2026), no el corte que se saco del bucle.
  //
  // Este trigger no es un empuje a usar el producto: es una PREGUNTA abierta —"¿hay algo que
  // te complica? Cuentame en una sola linea"— y su unico valor es la respuesta. La campana no
  // tiene caja de respuesta, y el hilo de soporte de Neto vive en WhatsApp por decision
  // escrita, asi que a quien no tiene numero se le estaria preguntando por un canal donde no
  // puede contestar. Se corta ANTES de `registrarEvento`, o sea que no se quema nada: el dia
  // que agregue un numero lo recibe normalmente.
  //
  // Es lo contrario del corte que este item elimino: aquel apagaba los ocho triggers sin
  // mirar cual, incluidos los cuatro cuya accion SI existe en la app.
  if (!usuario.whatsapp) return false;

  if (!usuario.onboarding_completado) return false;

  const txUltimos14 = await contarTransaccionesUltimos(usuario.id, 14);
  if (txUltimos14 >= 3) return false; // uso saludable, no encuestar

  const { data: prev, error: errPrev } = await supabase.from('survey_events')
    .select('id').eq('user_id', usuario.id).eq('event_type', 'reminder_d14').limit(1);
  if (errPrev) throw errPrev;
  if (prev && prev.length > 0) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  await enviarYRegistrar(usuario, 'reminder_d14', copyReminderD14(primer));
  return true;
}

async function maybeReminderD30(usuario) {
  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 30 || dias >= 31) return false;

  // Tuvo que haber usado antes (sino aplica reminder_d3/d7/d14, no churn early)
  const txTotal = await contarTransacciones(usuario.id);
  if (txTotal === 0) return false;

  const txUltimos14 = await contarTransaccionesUltimos(usuario.id, 14);
  if (txUltimos14 > 0) return false;

  const { data: prev, error: errPrev } = await supabase.from('survey_events')
    .select('id').eq('user_id', usuario.id).eq('event_type', 'reminder_d30').limit(1);
  if (errPrev) throw errPrev;
  if (prev && prev.length > 0) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  await enviarYRegistrar(usuario, 'reminder_d30', copyReminderD30(primer));
  return true;
}

async function maybeWebappInvite(usuario) {
  // Si tiene supabase_auth_id, ya se logueo en webapp alguna vez. No reinvitar.
  if (usuario.supabase_auth_id) return false;

  const txCount = await contarTransacciones(usuario.id);
  if (txCount < 10) return false;

  // Idempotencia DB-level: si ya recibio webapp_invite_10tx el INSERT fallara con 23505
  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const eventoId = await registrarEvento({
    userId: usuario.id,
    eventType: 'webapp_invite_10tx',
    // Fijo, y es el unico de los cinco que lo es: el envio de abajo es SOLO_WHATSAPP, o sea
    // que aca nunca se escribe una campana. Escribir `in_app` seria decir que salio por un
    // canal que este trigger no usa.
    //
    // Residual conocido y NO cerrado, dicho para que no se re-descubra: un usuario sin
    // NINGUNA de las dos identidades (ni numero ni `supabase_auth_id`) pasaria el gate, se
    // quemaria el one-shot y el mensaje no saldria por ningun lado. Hoy no existe —medido el
    // 01-sep-2026: 0 de 130— y no hay camino self-serve que lo produzca: `/unlink` borra el
    // numero pero deja `supabase_auth_id`, y el unico que borra esa columna es el borrado de
    // cuenta, que ademas pone `cuenta_borrada_at` y por eso ni entra a la poblacion. No se le
    // puso corte porque seria un corte sin poblacion; si algun dia aparece, va con los otros
    // tres.
    channel: 'whatsapp',
    messageSent: copyWebappInvite(primer),
  });
  if (!eventoId) return false; // ya existia, no reenviar

  // Solo si el insert paso, mandamos el mensaje
  await notificarUsuario({
    canales: CANALES.SOLO_WHATSAPP,
    motivo: 'el trigger exige supabase_auth_id NULL (arriba): el destinatario no tiene cuenta web, y el mensaje ES la invitación a crearla',
    usuarioId: usuario.id, whatsapp: usuario.whatsapp,
    tipo: 'survey_webapp_invite_10tx', mensaje: copyWebappInvite(primer),
  });
  return true;
}

/**
 * Wake-up para usuarios con >=30 dias desde registro y 0 transacciones en
 * los ultimos 30 dias. One-shot por usuario garantizado por unique index.
 * Copy distinto segun si nunca uso (tx_total = 0) o si uso pero churned.
 */
async function maybeWakeUpInactive(usuario) {
  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 30) return false;

  const tx30d = await contarTransaccionesUltimos(usuario.id, 30);
  if (tx30d > 0) return false; // sigue activo, no aplica

  const txTotal = await contarTransacciones(usuario.id);
  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const mensaje = txTotal === 0
    ? copyWakeUpInactiveNuevo(primer)
    : copyWakeUpInactiveChurn(primer);

  // Idempotencia DB-level: si ya recibio wake_up_inactive el INSERT fallara con 23505
  const eventoId = await registrarEvento({
    userId: usuario.id,
    eventType: 'wake_up_inactive',
    channel: usuario.whatsapp ? 'whatsapp' : 'in_app',
    messageSent: mensaje,
  });
  if (!eventoId) return false;

  const resultado = await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id, whatsapp: usuario.whatsapp || null,
    tipo: 'survey_wake_up_inactive', mensaje,
    titulo: 'Hace tiempo que no registras nada',
    // Cuerpo propio por lo mismo que los cuatro `reminder_dN`: los dos copys de WhatsApp piden
    // *"escribeme un gasto cualquiera"* y ofrecen `/silenciar`, y ninguna de las dos cosas
    // existe en la campana. La accion si existe, asi que el aviso se queda y cambia el verbo.
    cuerpo: txTotal === 0
      ? 'Te registraste en Neto pero quizás no llegaste a probarlo. Anota un gasto y ves lo rápido que es.'
      : 'Hace tiempo que no registras nada. Si quieres retomarlo, anota cualquier gasto de hoy.',
    tipoInApp: 'recordatorio', link: '/dashboard',
  });
  // El one-shot ya esta reclamado arriba: si no salio por ningun canal, devolverlo es la unica
  // forma de que este usuario lo reciba alguna vez. Ver `liberarClaimSinEntrega`.
  if (await liberarClaimSinEntrega(eventoId, 'wake_up_inactive', usuario.id, resultado)) return false;
  return true;
}

async function maybeFeedback30(usuario) {
  // EXENCION DECLARADA (item 23, 01-sep-2026), hermana de la de `maybeReminderD14` y por el
  // mismo motivo: el mensaje ES una pregunta abierta ("si pudieras cambiar UNA sola cosa del
  // producto, ¿que seria?") y la campana no tiene donde contestarla. Va antes del claim
  // one-shot a proposito: el unique index de `feedback_open_30tx` es irreversible, asi que
  // registrarlo aca le quemaria para siempre la unica vez que se manda.
  if (!usuario.whatsapp) return false;

  const txCount = await contarTransacciones(usuario.id);
  if (txCount < 30) return false;

  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const eventoId = await registrarEvento({
    userId: usuario.id,
    eventType: 'feedback_open_30tx',
    channel: usuario.whatsapp ? 'whatsapp' : 'in_app',
    messageSent: copyFeedback30(primer),
  });
  if (!eventoId) return false;

  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: usuario.id, whatsapp: usuario.whatsapp || null,
    tipo: 'survey_feedback_open_30tx', mensaje: copyFeedback30(primer),
    titulo: 'Llevamos 30 gastos juntos',
    link: '/dashboard',
  });
  return true;
}

/**
 * Wake-up para usuarios que NO completaron onboarding y llevan >=7 dias atascados.
 * El cron checkRecordatorioOnboarding existente solo dispara entre 3-6h
 * post-registro, por lo que estos usuarios nunca vuelven a recibir mensaje.
 *
 * Variantes segun onboarding_paso:
 *   100 / 0  : esperando nombre (mas comun)
 *   101      : esperando email (ya dio nombre)
 *   otro     : caso raro, copy generico
 *
 * One-shot por usuario via unique index. NOTA: este trigger es el unico que
 * NO requiere onboarding_completado; los demas triggers implicitamente lo
 * requieren porque chequean tx_count.
 */
async function maybeWakeUpOnboarding(usuario) {
  if (usuario.onboarding_completado === true) return false;

  // EXENCION DECLARADA (item 23, 01-sep-2026). El alta que este mensaje pide terminar es la de
  // WhatsApp —la maquina de estados vive en `handlers/onboarding.js` y se avanza escribiendole
  // al bot— asi que sin numero no hay forma de completarla y las tres variantes del copy
  // ("escribeme tu nombre", "escribeme tu correo") piden algo imposible.
  //
  // La primera version de este arreglo NO tenia este corte: afirmaba que el destinatario "tiene
  // numero por construccion", porque toda cuenta web nace con `onboarding_completado` en true
  // (`webapp/src/lib/create-web-user.ts`). Eso es una propiedad del NACIMIENTO, no un
  // invariante: `webapp/src/app/api/whatsapp/unlink/route.ts` pone `whatsapp: null` desde
  // Configuracion, self-serve, sin tocar `supabase_auth_id` ni `onboarding_completado`. Una
  // medicion ("0 de los 17 hoy") no cierra un camino que el propio usuario puede abrir.
  //
  // Va antes de `registrarEvento` para no quemar el one-shot, igual que las otras dos.
  if (!usuario.whatsapp) return false;

  const dias = (Date.now() - new Date(usuario.created_at).getTime()) / 86400000;
  if (dias < 7) return false;

  let mensaje;
  const primer = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  if (usuario.onboarding_paso === 101) {
    mensaje = copyWakeUpOnboardingEmail(primer);
  } else if (usuario.onboarding_paso === 100 || usuario.onboarding_paso === 0) {
    mensaje = copyWakeUpOnboardingNombre();
  } else {
    mensaje = copyWakeUpOnboardingGenerico();
  }

  const eventoId = await registrarEvento({
    userId: usuario.id,
    eventType: 'wake_up_onboarding',
    // Con el corte de arriba esta rama del ternario es la unica alcanzable, y se deja escrita
    // igual: es la misma forma que los otros tres call-sites, la que los dos guards comparten,
    // y la que queda correcta sola el dia que se levante la exencion.
    //
    // La version anterior justificaba el ternario diciendo que "sin numero solo puede haber
    // llegado por la campana". Era falso y en la direccion peligrosa: la rama `else` de abajo
    // manda `SOLO_WHATSAPP`, que NO escribe campana, asi que un destinatario sin numero y sin
    // cuenta web dejaba una fila diciendo `in_app` sobre un aviso que no salio por ningun lado
    // — y esa fila apaga los otros siete triggers una semana, porque `in_app` esta en
    // `CANALES_EMPUJE`.
    channel: usuario.whatsapp ? 'whatsapp' : 'in_app',
    messageSent: mensaje,
  });
  if (!eventoId) return false;

  // El canal se bifurca por lo que el usuario TIENE, igual que checkRecordatorioOnboarding.
  //
  // Antes salia SOLO_WHATSAPP con un motivo que afirmaba "no tiene cuenta web donde mostrarle
  // nada", y eso nunca estuvo garantizado: el trigger filtra por `onboarding_completado`, no
  // por `supabase_auth_id`. Medido el 20-ago-2026 sobre `survey_events` —el ledger real de este
  // trigger, mas viejo que `notification_deliveries`— de los **25 destinatarios historicos, 3
  // tienen cuenta web**. (Una medicion anterior decia "9, ninguno": salio de la tabla nueva, o
  // sea de un subconjunto, y se leyo como si fuera la poblacion.)
  //
  // Y el arreglo obvio —cortar con `if (usuario.supabase_auth_id) return false`— era al reves:
  // el runner ya descarta a quien no tiene WhatsApp, asi que eso solo silenciaba a quien tiene
  // las DOS cosas, o sea justo a quien si tiene campana donde verlo.
  const comun = {
    usuarioId: usuario.id, whatsapp: usuario.whatsapp,
    tipo: 'survey_wake_up_onboarding', mensaje,
  };
  if (usuario.supabase_auth_id) {
    const resultado = await notificarUsuario({
      canales: CANALES.AMBOS,
      ...comun,
      titulo: 'Te falta terminar de configurar Neto',
      // Cuerpo propio, por lo mismo que en `checkRecordatorioOnboarding`: sin el, el chokepoint
      // deriva el cuerpo in-app del mensaje de WhatsApp, y los tres copys de este trigger piden
      // que la persona ESCRIBA su nombre o su correo por chat y ofrecen "/silenciar". Ninguna de
      // las tres es una accion que exista en la campana. (La primera version de este arreglo se
      // olvido este `cuerpo`: el mismo defecto que corregia el archivo de al lado, en el mismo
      // commit.)
      //
      // Dice "por WhatsApp" y eso es cierto por el CORTE del principio de la funcion, no por
      // una propiedad del alta: sin ese corte, alguien que uso `/unlink` leeria en la campana
      // que termine por un canal que ya no tiene.
      cuerpo: 'Tu alta quedó a medias. Termínala por WhatsApp y Neto empieza a anotar tus gastos.',
      tipoInApp: 'recordatorio', link: '/dashboard',
    });
    // Mismo motivo que en `maybeWakeUpInactive`: el claim ya esta puesto y este es el unico
    // envio. Solo en esta rama — la de abajo es SOLO_WHATSAPP y liberar ahi convertiria un
    // numero inalcanzable en un reintento diario.
    if (await liberarClaimSinEntrega(eventoId, 'wake_up_onboarding', usuario.id, resultado)) return false;
  } else {
    await notificarUsuario({
      canales: CANALES.SOLO_WHATSAPP,
      motivo: 'la rama exige supabase_auth_id nulo: sin cuenta web no hay campana donde mostrar nada',
      ...comun,
    });
  }
  return true;
}

// ===== Medición de respuestas (T2) =====

/**
 * Marca que el usuario RESPONDIÓ a un mensaje proactivo reciente. Best-effort,
 * fire-and-forget: se llama desde el webhook cuando entra un mensaje del usuario.
 *
 * Cierra el loop de medición del audit 2026-07-03: antes `responded_at` solo se
 * seteaba manual (admin) o por NPS webapp, por eso salía 0 en TODOS los recordatorios
 * WhatsApp aunque el usuario respondiera. Ahora una respuesta del usuario dentro de los
 * 7 días de un envío proactivo marca ese survey_event como respondido.
 */
async function marcarRespuestaProactiva(usuarioId, replyText) {
  try {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: ev, error: errBusqueda } = await supabase.from('survey_events')
      .select('id, response_data')
      .eq('user_id', usuarioId).eq('channel', 'whatsapp')
      .is('responded_at', null)
      .gte('sent_at', cutoff)
      .order('sent_at', { ascending: false }).limit(1);
    // ACCESORIA, y por eso el arreglo es el opuesto al de los ocho triggers: esto no decide a
    // quien se le manda nada, solo mide si contestaron. Loguea y se va. Poner aca el
    // `throw` que corresponde arriba seria peor que el bug: lo llama el webhook por cada
    // mensaje entrante, asi que convertiria una lectura fallida en ruido en el camino
    // caliente. El corte de abajo (`!ev`) tiene que seguir siendo el de "no habia envio
    // reciente que marcar", no el de "no se pudo mirar".
    if (errBusqueda) {
      log.error({ tag: 'SURVEY_RESP', userId: usuarioId, err: errBusqueda.message }, 'No se pudo buscar el envio proactivo a marcar');
      return;
    }
    if (!ev || ev.length === 0) return;
    const prev = (ev[0].response_data && typeof ev[0].response_data === 'object') ? ev[0].response_data : {};
    // La escritura tampoco puede cortar nada: es el otro extremo de la misma medicion. Lo
    // que si tiene que hacer es DECIR que no se aplico — un `responded_at` que no quedo es
    // una respuesta que el reporte va a contar como silencio.
    const { error: errMarca } = await supabase.from('survey_events').update({
      responded_at: new Date().toISOString(),
      response_data: { ...prev, user_replied: true, reply_text: String(replyText || '').substring(0, 300) },
    }).eq('id', ev[0].id);
    if (errMarca) {
      log.error({ tag: 'SURVEY_RESP', userId: usuarioId, eventoId: ev[0].id, err: errMarca.message }, 'La respuesta no quedo marcada: responded_at sigue en null');
    }
  } catch (e) {
    // best-effort: nunca romper el flujo de mensaje entrante
  }
}

// ===== Orquestador =====

/**
 * Cron principal. Corre cada 15min entre 10:00-10:14 Lima.
 * Itera usuarios elegibles y aplica los 6 triggers en orden de prioridad.
 * Solo dispara MAX 1 mensaje por usuario por corrida (no spamear).
 */
async function checkSurveyTriggers() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 10 || horaLima.getMinutes() > 14) return;

  try {
    // No filtramos por onboarding_completado aqui: el trigger maybeWakeUpOnboarding
    // necesita ver a los que NO completaron. Los demas triggers implicitamente
    // requieren completion porque dependen de tx_count > 0.
    const { data: usuarios, error: errUsuarios } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, created_at, recordatorios_activos, onboarding_completado, onboarding_paso, supabase_auth_id')
      // Una cuenta borrada (migracion 073) sobrevive como lapida, y ESTE filtro es lo unico
      // que la deja afuera. Antes la salvaba de rebote el `if (!u.whatsapp) continue` de abajo
      // —la lapida no conserva el numero—, que era un efecto lateral de otra decision y no una
      // regla. Ese corte se fue el 01-sep-2026 (item 23), asi que hoy no hay red debajo: si
      // este `.is()` desaparece, el survey se le manda a alguien que pidio irse.
      // Guard de comportamiento: `tests/cron/lapida-no-recibe.test.js`.
      .is('cuenta_borrada_at', null);

    // La poblacion: el comportamiento correcto ya era no mandar nada, asi que el arreglo NO
    // cambia a quien le llega un mensaje. Lo que cambia es que ahora se distingue "hoy no
    // calificaba nadie" de "no se pudo preguntar", que hasta aca producian el mismo silencio.
    // Es exactamente como se perdieron 12 dias de `checkRecordatorioOnboarding`.
    if (errUsuarios) {
      log.error({ tag: 'SURVEY_TRIG', err: errUsuarios.message }, 'No se pudo leer la poblacion: no se evaluo ningun trigger');
      return;
    }
    if (!usuarios || usuarios.length === 0) return;

    let totalSent = 0;
    for (const u of usuarios) {
      try {
        if (u.recordatorios_activos === false) continue;
        // Aca habia un `if (!u.whatsapp) continue;`. Se fue el 01-sep-2026 (item 23) y es el
        // QUINTO sitio de la misma clase que el item 14 cerro en `cron/checks.js` el 27-ago.
        //
        // El corte no protegia nada: `notificarUsuario` con AMBOS ya maneja `whatsapp: null`
        // —llama igual a `enviarWhatsapp`, que hace no-op y deja `skipped_no_whatsapp` en el
        // ledger, y escribe la campana—. Lo unico que agregaba era apagarle la mitad in-app al
        // usuario web-first. Medido el 01-sep contra produccion: 17 usuarios sin numero, los 17
        // con cuenta web y los 17 con los recordatorios prendidos, con CERO eventos de los ocho
        // triggers de este archivo en toda la historia.
        //
        // Los dos triggers a los que NO les aplica la campana se declaran en su propia funcion
        // (`maybeReminderD14` y `maybeFeedback30`, los dos porque el mensaje es una pregunta
        // abierta y aca no hay donde contestarla). Eso es una exencion firmada por trigger, y
        // es distinto de un corte que apaga los ocho sin mirar cual.
        if (await recibioMensajeRecienteProactivo(u.id)) continue;
        if (await tuvoErrorReciente(u.id)) continue;

        // Orden de prioridad: triggers de progreso primero, recordatorios despues.
        // Un usuario solo recibe 1 mensaje por corrida.
        const triggers = [
          maybeFeedback30,
          maybeWebappInvite,
          maybeReminderD30,
          maybeReminderD14,
          maybeReminderD7,
          maybeReminderD3,
          maybeWakeUpOnboarding,
          maybeWakeUpInactive,
        ];

        for (const fn of triggers) {
          const sent = await fn(u);
          if (sent) {
            totalSent++;
            break;
          }
        }
      } catch (e) {
        log.error({ tag: 'SURVEY_TRIG', userId: u.id, err: e.message }, 'Error per-user en survey triggers');
      }
    }

    if (totalSent > 0) {
      log.info({ tag: 'SURVEY_TRIG', sent: totalSent, candidates: usuarios.length }, 'Survey triggers ejecutados');
    }
  } catch (e) {
    log.error({ tag: 'SURVEY_TRIG', err: e.message }, 'Error general survey triggers');
  }
}

module.exports = {
  checkSurveyTriggers,
  marcarRespuestaProactiva,
  // La mitad in-app de los cuatro `reminder_dN`, para el dry-run: sin esto el preview imprime
  // el copy de WhatsApp —o sea justo lo que el usuario sin numero NO recibe— y oculta lo unico
  // que si le llega.
  IN_APP_RECORDATORIO,
  // exported for dry-run script
  copyReminderD3,
  copyReminderD7,
  copyReminderD14,
  copyReminderD30,
  copyWebappInvite,
  copyFeedback30,
  copyWakeUpInactiveNuevo,
  copyWakeUpInactiveChurn,
  copyWakeUpOnboardingNombre,
  copyWakeUpOnboardingEmail,
  copyWakeUpOnboardingGenerico,
  recibioMensajeRecienteProactivo,
  tuvoErrorReciente,
  contarTransacciones,
  contarTransaccionesUltimos,
};
