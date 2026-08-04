// Trial de 14 días y el muro que viene después. Fuente única de las dos preguntas:
// "¿este usuario está en prueba?" y "¿este usuario puede LEER?".
//
// Contexto (baseline 2026-07-31, 82 usuarios): 5 de los últimos 6 pagos ocurrieron
// el mismo día del registro, con 40% de churn. La gente compraba la promesa, no el
// producto. El trial existe para que la decisión se tome con la data propia delante,
// no para forzar upgrades que hoy no existen.
//
// ── El modelo, y por qué es así ──────────────────────────────────────────────
// `plan` sigue teniendo dos valores y durante el trial vale 'premium', así que los
// ~40 sitios que chequean `plan === 'premium'` entregan Pro al usuario en prueba sin
// tocarse. Un tercer valor ('trial') habría roto todos, y un gate olvidado le daría
// Free EN SILENCIO — el peor modo de falla posible.
//
// Lo que cambió es qué significa 'free': ya no es un plan gratuito para siempre,
// es el MURO. Y el muro es de LECTURA, nunca de escritura: Neto sigue registrando
// gastos siempre, para siempre, gratis. Eso no se negocia — es la promesa del sprint
// de activación (commits 3c992bb..232e7f6) y matarla mataría al usuario que solo
// quiere WhatsApp. Lo que se cobra es ver: el desglose, el historial, el dashboard.
//
// El estado comercial vive aparte en `trial_estado` (migración 052), que es lo que
// distingue un 'premium' que paga de uno que está probando (importa para el MRR).

const { supabase } = require('./db');
const log = require('./logger');
const { hoyPeru, sumarDias } = require('./dates');
const { WEBAPP_URL } = require('./constants');
const { lineaPrecioPro } = require('./config');
const { formatFecha } = require('./formatters');
const { nudgeActivacion, construirLinkActivacion } = require('./activacion');
const analytics = require('./analytics');

// 14 días desde el PRIMER GASTO (no desde el alta). Con el alta reordenada alguien
// puede tardar días en registrar algo, y un trial que corre sobre una cuenta vacía
// no produce un pago informado: produce un aviso de vencimiento a quien nunca vio
// nada. Ver iniciarTrialSiCorresponde.
const TRIAL_DIAS = 14;

// El primer aviso sale cuando faltan 3 días (día 11 de 14). El segundo, el día 14.
const AVISO_DIAS_ANTES = 3;

/**
 * ¿El usuario está corriendo su prueba ahora mismo?
 *
 * Exige las DOS columnas a propósito. `trial_estado='activo'` solo dice que el reloj
 * comercial corre; `plan='premium'` es lo que de verdad le entrega Pro. Cuando se
 * desincronizan (le pasó a un usuario real: checkPremiumExpiry le bajó el plan y dejó el
 * estado en 'activo'), mirar una sola columna produce una pantalla que se contradice —
 * el banner decía "estás en Neto Pro, quedan 30 días" arriba del paywall que decía "tu
 * prueba terminó". Con las dos, esa contradicción es imposible de construir.
 */
function enTrial(usuario) {
  return !!usuario && usuario.plan === 'premium' && usuario.trial_estado === 'activo';
}

/**
 * ¿El usuario está en el muro? Es decir: ¿puede escribir pero NO leer?
 * Es el complemento exacto del entitlement Pro, a propósito: una sola condición,
 * imposible de desincronizar con el resto del código.
 */
function estaEnMuro(usuario) {
  if (!usuario) return true;
  return usuario.plan !== 'premium';
}

/**
 * ¿PAGA? Es la tercera pregunta, y la que no se puede responder con `plan` sola: durante
 * el trial esa columna vale 'premium'. La usa el descuento de referido (no se le ofrece a
 * quien ya paga, pero sí a quien está probando) y las métricas de ingreso.
 *
 * Vive acá y no repetida inline porque ya estaba escrita en tres lugares distintos, que es
 * exactamente cómo empiezan las divergencias que este modelo de dos columnas produce.
 * Espejo de `esProPagado` en `webapp/src/lib/plan.ts`.
 */
function esProPagado(usuario) {
  return !!usuario && usuario.plan === 'premium' && usuario.trial_estado !== 'activo';
}

/** Días que le quedan de prueba, en fecha Lima. 0 = vence hoy. null si no está en trial. */
function diasRestantesTrial(usuario, hoyStr) {
  if (!enTrial(usuario) || !usuario.trial_vence) return null;
  const hoy = hoyStr || hoyPeru();
  const vence = String(usuario.trial_vence).slice(0, 10);
  if (vence < hoy) return 0;
  const ms = new Date(vence + 'T12:00:00-05:00').getTime() - new Date(hoy + 'T12:00:00-05:00').getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

/**
 * Arranca el trial si al usuario le corresponde uno. Lo llama TODA escritura de
 * transacción (services/transactions.js para el backend; POST /internal/trial-iniciar
 * para la webapp), así que la invariante es fuerte:
 *
 *   cualquier usuario sin trial que registre una transacción arranca sus 14 días.
 *
 * O sea que nadie puede terminar en el muro sin haber tenido su prueba, y el estado
 * se auto-repara: si una fila quedó rara, el siguiente gasto la endereza.
 *
 * El UPDATE es un CAS: `WHERE trial_estado IS NULL AND plan <> 'premium'` es atómico
 * en Postgres, así que solo UNA ejecución gana la fila aunque lleguen dos gastos a la
 * vez. Las demás reciben null y no re-emiten el evento ni re-anclan el descuento.
 *
 * El `plan <> 'premium'` protege al que ya paga: a un Pro no se le pisa el plan ni se
 * le regala una prueba. Su trial_estado queda NULL y lo sella activarPro (si convierte)
 * o checkPremiumExpiry (si churnea).
 *
 * @param {string} usuarioId
 * @param {object} [opts]
 * @param {number} [opts.dias=TRIAL_DIAS]  duración (la cortesía a usuarios viejos usa 30)
 * @param {string} [opts.via='primer_gasto']  para el embudo de PostHog
 * @returns {Promise<{iniciado: boolean, trialVence: string|null}>}
 */
async function iniciarTrialSiCorresponde(usuarioId, opts = {}) {
  const vacio = { iniciado: false, trialVence: null };
  if (!usuarioId) return vacio;
  const dias = opts.dias || TRIAL_DIAS;
  const via = opts.via || 'primer_gasto';
  try {
    const trialVence = sumarDias(hoyPeru(), dias);
    const { data, error } = await supabase.from('usuarios')
      .update({
        trial_estado: 'activo',
        trial_inicio: new Date().toISOString(),
        trial_vence: trialVence,
        plan: 'premium',
        // `premium_vence` NULL es lo que hace que el trial le sea invisible a
        // checkPremiumExpiry (sus tres queries filtran por esa columna). Estaba escrito en
        // la migración 052 como invariante pero nadie lo forzaba, así que a quien traía un
        // premium_vence viejo de una suscripción pasada el cron le mataba el trial dentro
        // de la hora: le pasó a un ex-pagador real, cuya prueba duró 78 minutos y encima
        // recibió "tu plan Pro venció" por WhatsApp. El trial no hereda el vencimiento de
        // una suscripción que ya terminó.
        premium_vence: null,
      })
      .eq('id', usuarioId)
      .is('trial_estado', null)
      // `.neq('plan', ...)` descarta las filas con `plan` NULL (en SQL `NULL <> 'premium'`
      // es NULL, no true), o sea justo lo contrario de lo que quiere el filtro. La columna
      // es nullable pese al default 'free'; la 052 ya lo escribió bien en su backfill
      // (`u.plan IS NULL OR u.plan <> 'premium'`) y acá se había perdido.
      .or('plan.is.null,plan.neq.premium')
      .select('id, referido_dscto_pct, referido_dscto_vence')
      .maybeSingle();

    // supabase-js NO lanza: el error viene en {error}. Sin leerlo, un fallo de red
    // sería indistinguible de "ya tenía trial" y el usuario se quedaría sin su prueba
    // sin que ningún log lo delate.
    if (error) {
      log.error({ tag: 'TRIAL', err: error.message, usuarioId }, 'No se pudo arrancar el trial');
      return vacio;
    }
    if (!data) return vacio;   // ya tenía trial, o ya es Pro pagado: nada que hacer

    // Referidos: el 50% off se ancla al FIN del trial, no al registro. Si corriera en
    // paralelo, sus 7 días se queman dentro del trial (nadie paga mientras Pro está
    // gratis) y el incentivo aterriza en cero. Anclado al final, el descuento es lo que
    // está esperando en el muro — justo donde ocurre la conversión.
    // require diferido: services/referrals arrastra lib/whatsapp, y cargarlo acá arriba
    // acopla el módulo de trial a la cadena de envío sin necesidad.
    if (data.referido_dscto_pct) {
      try {
        const { anclarDescuentoAFinDeTrial } = require('../services/referrals');
        await anclarDescuentoAFinDeTrial(usuarioId, trialVence);
      } catch (e) {
        log.warn({ tag: 'TRIAL', err: e.message, usuarioId }, 'No se pudo anclar el descuento de referido al fin del trial');
      }
    }

    // Paso 300 del MISMO embudo que el alta (100) y la activación (200), emitido desde
    // el backend sobre usuarios.id: la webapp usa posthog-js con otro distinct_id y
    // emitir desde allá partiría el embudo en dos mitades que no se pueden unir.
    analytics.capture(usuarioId, 'wa_onboarding_step_ok', { paso: 300, siguiente: 400, via, dias });
    log.info({ tag: 'TRIAL', usuarioId, trialVence, via }, 'Trial iniciado');
    return { iniciado: true, trialVence };
  } catch (e) {
    log.error({ tag: 'TRIAL', err: e.message, usuarioId }, 'Excepción arrancando el trial');
    return vacio;
  }
}

/** Suma de gastos del mes en curso (fecha Lima), en soles. Query mínima, sin joins. */
async function totalGastadoMes(usuarioId) {
  try {
    const hoy = hoyPeru();
    const desde = hoy.slice(0, 8) + '01';
    const { data, error } = await supabase.from('transacciones')
      .select('monto, monto_pen')
      .eq('usuario_id', usuarioId)
      .eq('tipo', 'gasto')
      .gte('fecha', desde)
      .lte('fecha', hoy);
    if (error || !data) return null;
    // monto_pen es NULLABLE a propósito (la rama USD fuera de rango deja null honesto),
    // así que se lee con coalesce, igual que el resto del código.
    return data.reduce((acc, t) => acc + Number(t.monto_pen != null ? t.monto_pen : t.monto || 0), 0);
  } catch (e) {
    return null;
  }
}

/** Pie común de los tres mensajes del muro: qué recuperas y cuánto cuesta. */
function pieMuro(cuantos, verbo) {
  return 'Sigo anotando todo lo que me mandes y ' + cuantos + ' siguen guardados — no se borra nada.\n\n' +
    'Para ' + verbo + ' (gráficos, categorías, reportes e historial completo):\n' +
    lineaPrecioPro() + '\n' +
    '👉 ' + WEBAPP_URL + '/dashboard/pro';
}

/**
 * Respuesta única del muro cuando alguien pide una LECTURA sin tener derecho.
 * Nombra qué pasó, confirma que su data sigue ahí, y recuerda que escribir sigue
 * siendo gratis. Sin esa última línea el mensaje se lee como "Neto dejó de funcionar",
 * que es exactamente lo que no queremos que crea.
 *
 * Tres versiones, y la distinción NO es cosmética — cada una le habla a alguien que
 * llegó al muro por un camino distinto:
 *  · NUNCA tuvo prueba (`trial_estado` null) → decirle "tu prueba terminó" sería mentirle.
 *    Es el usuario dormido de antes del trial: su prueba arranca con su próximo gasto, así
 *    que el mensaje correcto es la invitación a anotar uno. Sale gratis y es mejor gancho
 *    de reactivación que un cobro.
 *  · EX-PAGADOR (`convertido` con historial de pago) → nunca tuvo "prueba": fue cliente.
 *    Decirle que se le acabó una prueba le borra eso, y es el segmento más valioso que hay
 *    para recuperar. Se le nombra lo que de verdad venció: su Pro.
 *  · Terminó su prueba (`vencido`) → se le nombra qué terminó y cuándo.
 *
 * ⚠️ `trial_estado` es lo que decide la rama, así que la fila TIENE que traer esa columna.
 * Una fila parcial (un `select` que se la olvidó) llegaba acá con `undefined`, caía en la
 * rama de "nunca tuvo prueba" y le prometía 14 días gratis a quien acababa de gastarlos —
 * y que por `trial_estado='vencido'` no iba a recibir otro nunca. Por eso `undefined` y
 * `null` ya no son lo mismo: el primero es un bug y se loguea, y se responde con el texto
 * genérico, que es verdadero en cualquier estado.
 */
/**
 * El "no" de la carga masiva de Excel/CSV, en UN solo lugar.
 *
 * La importación se pide en dos momentos separados por minutos: primero el usuario
 * pregunta cómo se hace (intent `cargar_excel` → el tutorial con la plantilla) y después
 * manda el archivo (`message.type === 'document'` en webhook.js). Los dos miran el MISMO
 * flag `excelUpload`, pero solo el segundo lo comprobaba: al del muro se le daba el
 * instructivo completo, bajaba la plantilla, la llenaba a mano y recién ahí —con el
 * trabajo hecho— se le decía que era Pro. La peor forma posible de cobrar algo.
 *
 * `cargar_excel` se queda en INTENTS_LIBRES: no es una lectura, así que el chokepoint del
 * muro no es su gate. Su gate es `excelUpload`, y el copy vive acá —con el resto del copy
 * del muro— para que no pueda divergir entre los dos call-sites. Lo fija
 * `tests/handlers/cargar-excel-muro.test.js`.
 *
 * Política (decisión de Favio, 04-ago-2026, auditoría CTO ola 3): esto NO contradice
 * "escribir nunca se corta". Anotar el gasto del día sigue gratis para siempre. Importar
 * 500 filas de historial no es ese hábito: es sembrar la data que el dashboard —lo que se
 * paga— vuelve legible, y `excelUpload:false` ya era Pro desde antes.
 *
 * **Manda al panel, NO a `"ver plan"`.** Ese comando llega a `ver_premium`, que para el
 * usuario del muro llama `solicitarComprobante` y abre 48h donde toda foto se lee como
 * comprobante: una que no parece el pago a Neto se rechaza SIN registrar el gasto. O sea
 * que empujarlo ahí le rompería justo la escritura por foto que este mismo mensaje le
 * acaba de prometer. Es la trampa de B12, encontrada al re-auditar el fix de M2.
 */
function mensajeCargaMasivaPro(usuario) {
  const destino = linkPanelPro(usuario);
  return '🔒 La *carga masiva de Excel/CSV* es una función Pro.\n\n' +
    'Con Pro importas tu historial completo desde tu estado de cuenta o la plantilla en segundos.\n\n' +
    'Mientras tanto, anótame los gastos por acá cuando quieras: eso no tiene límite ni costo.\n\n' +
    lineaPrecioPro() +
    (destino ? '\n👉 ' + destino : '');
}

function mensajeMuro(usuario, conteoTx) {
  const pn = usuario && usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const cuantos = conteoTx ? '*' + conteoTx + ' gastos*' : 'tus gastos';
  const saludo = (letra) => '🔒 ' + (pn ? pn + ', ' + letra.toLowerCase() : letra);

  // Fila incompleta: no se puede saber por qué está en el muro, así que no se afirma nada.
  if (usuario && usuario.trial_estado === undefined) {
    log.error({ tag: 'TRIAL', usuarioId: usuario.id },
      'mensajeMuro recibió una fila sin trial_estado: el select del llamador está incompleto');
    return saludo('Para') + ' ver tus gastos en gráficos necesitas *Neto Pro*.\n\n' +
      pieMuro(cuantos, 'verlos');
  }

  if (!usuario || !usuario.trial_estado) {
    // NO se menciona la tarjeta acá. "Sin tarjeta" tranquiliza a quien YA está dentro, pero
    // en el mismo mensaje que pide registrar un gasto introduce una tarjeta que nunca
    // existió, y se puede leer como que anotar el gasto dispara un cobro. Se nombra la
    // condición real y nada más: el gasto activa la prueba.
    return saludo('Para') + ' ver tus gastos en gráficos necesitas *Neto Pro*.\n\n' +
      'Y tienes *' + TRIAL_DIAS + ' días gratis* esperándote: se activan cuando registres tu ' +
      (conteoTx ? 'próximo' : 'primer') + ' gasto.\n\n' +
      '📝 Anótame uno: _"gasté 20 en taxi"_';
  }

  // Fecha legible, no ISO: "terminó el 2026-07-26" en un mensaje al usuario se lee como
  // un log, no como algo que le habla a una persona.
  const legible = (v) => (v ? formatFecha(String(v).slice(0, 10)) : null);

  // Ex-pagador: pagó de verdad y su suscripción venció. `convertido` también lo sella
  // activarPro para quien convirtió DESDE un trial, así que lo que distingue al cliente
  // es el historial de pago, no el estado del trial.
  if (usuario.trial_estado === 'convertido' && (usuario.premium_desde || usuario.premium_vence)) {
    const vencio = legible(usuario.premium_vence);
    return saludo('Tu') + ' *Neto Pro*' + (vencio ? ' venció el ' + vencio : ' venció') + '.\n\n' +
      pieMuro(cuantos, 'volver a verlos');
  }

  const cuando = legible(usuario.trial_vence);
  return saludo('Tu') + ' prueba de *Neto Pro*' + (cuando ? ' terminó el ' + cuando : ' terminó') + '.\n\n' +
    pieMuro(cuantos, 'volver a verlos');
}

/**
 * Respuesta única cuando alguien pide conectar Gmail sin ser Pro PAGADO.
 *
 * Gmail es la única capability del producto que se cobra por adelantado, y el motivo no es
 * comercial sino de inventario: cada conexión consume uno de los 100 cupos de Google que
 * tenemos hasta la certificación CASA. Un trial de 14 días quemaba un cupo permanente.
 *
 * Dos ramas, porque son dos conversaciones distintas:
 *  · EN PRUEBA → tiene Pro ahora mismo. Decirle "esto es una función Pro" (el copy viejo,
 *    heredado del gate `plan !== 'premium'`) le suena a bug: acaba de recibir Pro. Hay que
 *    nombrar la excepción y su motivo, que además es honesto y se entiende. Es el único
 *    momento del trial donde pedimos el pago por algo concreto, así que es conversión, no
 *    error: se le dice qué gana y cuándo.
 *  · EN EL MURO → la conversación normal de Pro, sin inventar una excepción que no aplica.
 *
 * @returns {string} texto para WhatsApp (markdown de WhatsApp, no Markdown)
 */
function mensajeGmailProPagado(usuario, opcion = 'conectar') {
  const pn = usuario && usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const precio = lineaPrecioPro() + '\n' +
    '👉 ' + WEBAPP_URL + '/dashboard/pro';

  // Elegir bancos no consume cupo por sí solo, pero es la mitad de la misma capability:
  // sin Gmail conectado, la selección no lee nada. Dejarla abierta al que no paga era un
  // callejón sin salida — configuraba una lectura que nunca iba a ocurrir.
  const queEs = opcion === 'bancos'
    ? 'elegir de qué bancos leo tus correos'
    : 'leer tus correos bancarios';

  if (enTrial(usuario)) {
    return '📧 ' + (pn ? pn + ', ' : '') + 'la *lectura de correos bancarios* es una función beta ' +
      'y se activa con *Pro pagado*.\n\n' +
      'Tu prueba te da todo lo demás. Esta es la única que pide el pago primero: ' +
      'conectarla nos cuesta un cupo con Google y los tenemos contados.\n\n' +
      'Actívala y empiezo a ' + (opcion === 'bancos' ? 'leer tus correos' : 'leerlos') + ' el mismo día:\n' + precio;
  }

  return '📧 ' + (pn ? pn + ', ' : '') + queEs + ' es parte de *Neto Pro* (función beta).\n\n' +
    'Yo detecto los gastos de tus notificaciones del banco y los anoto solos, sin que escribas nada.\n\n' + precio;
}

/**
 * A dónde mandar a este usuario para que gestione su Gmail, según su identidad.
 *
 * Un usuario con cuenta web entra directo al panel. Uno WhatsApp-only NO tiene sesión que
 * abrir: mandarlo a /dashboard/pro lo deposita en /login, donde un "Continuar con Google"
 * cualquiera le crea una cuenta huérfana en vez de vincularse a su número. El link firmado
 * de `lib/activacion.js` lleva su identidad dentro, que es exactamente para lo que existe.
 *
 * Necesita `id` y `supabase_auth_id`. Una fila parcial sin esa segunda columna la lee como
 * `undefined` y manda a un usuario CON cuenta web por el camino de activación, donde su token
 * es inerte (solo actúa si la fila no tiene `supabase_auth_id`) y termina en /login. Hoy los
 * cinco llamadores traen la fila entera con `select('*')`; si agregas uno con un select
 * acotado, incluí esa columna.
 *
 * @returns {string|null} URL, o null si no se pudo firmar el link de activación
 */
function linkPanelPro(usuario) {
  if (!usuario) return null;
  if (usuario.supabase_auth_id) return WEBAPP_URL + '/dashboard/pro';
  return construirLinkActivacion(usuario.id);
}

/**
 * Respuesta cuando un Pro PAGADO pide conectar/gestionar su Gmail desde WhatsApp.
 *
 * Conectar Gmail es web-only. El motivo no es de permisos —este usuario paga y tiene
 * derecho— sino de dónde se hace bien: el flujo termina en un navegador de todas formas, y
 * en la app el usuario ve la lista de bancos con checkboxes ANTES de autorizar, en vez de un
 * menú numerado repartido en dos mensajes cuyo estado vivía en la base entre uno y otro.
 *
 * Es el gemelo de `mensajeGmailProPagado`: la misma pregunta, la otra rama. El que no paga
 * recibe el pitch; el que paga recibe el link que sí lo lleva a alguna parte.
 *
 * `gestionar` es reconectar LA MISMA cuenta, no administrar varias: un usuario tiene un solo
 * Gmail vinculado, porque cada cuenta de Google distinta consume otro de los 100 cupos.
 *
 * @param {object} usuario  fila de usuarios (necesita id, supabase_auth_id, nombre)
 * @param {'conectar'|'bancos'|'gestionar'} [opcion]
 * @returns {string} texto para WhatsApp
 */
function mensajeConectarEnLaApp(usuario, opcion = 'conectar') {
  const pn = usuario && usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const hola = pn ? pn + ', ' : '';
  const link = linkPanelPro(usuario);

  const queEs = opcion === 'bancos'
    ? 'Elegir de qué bancos leo tus correos'
    : opcion === 'gestionar'
      ? 'Reconectar tu Gmail'
      : 'Conectar tu Gmail';

  // Sin link firmado (falta ACTIVATION_TOKEN_SECRET) no inventamos una URL que lo deje en
  // /login: se le da la dirección y se sigue.
  if (!link) {
    return '📧 ' + hola + queEs.toLowerCase() + ' se hace desde tu app: ' + WEBAPP_URL + '/dashboard/pro';
  }

  const cierre = usuario.supabase_auth_id
    ? '\n\n_Ahí eliges de qué bancos leo antes de autorizar._'
    : '\n\n_Un toque con tu Google y entras. Es la misma cuenta, con tus gastos de acá._';

  return '📧 ' + hola + '*' + queEs + '* se hace desde tu app.\n\n' +
    'Se autoriza con Google en el navegador, así que te dejo el atajo directo:\n\n' + link + cierre;
}

/**
 * Respuesta a un escaneo manual cuando el Gmail del usuario ya no responde.
 *
 * `escanearGmailYRegistrar` devuelve `{authError: true}` —un OBJETO— cuando el token murió,
 * y los dos disparadores manuales (`/escanear` y el intent `escanear_gmail`) lo tomaban como
 * si fuera el texto de la respuesta. O sea que quien tenía el Gmail caído pedía "escanea mi
 * correo" y recibía un objeto: basura o silencio, justo en el momento en que necesitaba
 * entender qué pasó. Es además el único momento en que el usuario PREGUNTA por ese estado.
 */
function mensajeGmailDesconectado(usuario) {
  const link = linkPanelPro(usuario);
  const cola = link
    ? '\n\nReconéctalo acá y todo vuelve a funcionar:\n' + link
    : '\n\nReconéctalo desde tu app: ' + WEBAPP_URL + '/dashboard/pro';
  return '⚠️ *Tu Gmail se desconectó*\n\n' +
    'Neto ya no puede leer tus correos bancarios, así que no hay nada nuevo que escanear. ' +
    'Tus gastos registrados siguen intactos.' + cola;
}

/**
 * Cola de la confirmación de un gasto para el usuario en el muro. Deja UN número —
 * el total del mes — y nada más.
 *
 * Ese número se queda a propósito: es la señal barata de que sus datos siguen
 * creciendo, y lo que genera la comezón que el desglose cobra. Quitarlo también
 * (muro duro) le saca al usuario el único motivo para seguir anotando, y sin
 * anotaciones el paywall termina vendiendo un dashboard sobre data muerta.
 *
 * @returns {Promise<string|null>} bloque a concatenar, o null si no está en el muro
 */
async function nudgeMuro(usuario) {
  if (!usuario || !estaEnMuro(usuario)) return null;
  const total = await totalGastadoMes(usuario.id);
  if (total == null) return null;
  return '\n\nVan *S/' + total.toFixed(2) + '* este mes.\n' +
    '👉 Mira en qué se te fue: ' + WEBAPP_URL + '/dashboard/pro';
}

/**
 * Lo que va al pie de CUALQUIER confirmación de gasto por WhatsApp. Reemplaza la llamada
 * directa a `nudgeActivacion` en los cuatro sitios que confirman un registro, porque las
 * tres colas posibles son mutuamente excluyentes y decidir cuál toca es una sola decisión:
 *
 *   1. Acaba de arrancar su trial  → se lo anunciamos (primer toque de comunicación del
 *      trial, y el único que ve el usuario WhatsApp-only que nunca abrirá el dashboard).
 *      Va acá y no en /activar a propósito: esa página tiene un solo trabajo — que toquen
 *      el botón — y meterle un segundo frame ("¿gratis? ¿o sea que después pago?") ante
 *      alguien que todavía no vio nada es justo lo que se le sacó cuando se rediseñó.
 *   2. Está en el muro            → el total del mes y nada más (ver nudgeMuro).
 *   3. Ninguna de las dos          → el empujón a activar la cuenta de siempre.
 *
 * @param {object} usuario   fila de usuarios (puede estar desactualizada respecto al trial)
 * @param {object|null} tx   fila devuelta por guardarTransaccion (trae `trialIniciado`)
 * @param {number} conteoTx  transacciones que lleva el usuario
 * @returns {Promise<string|null>}
 */
async function colaConfirmacionGasto(usuario, tx, conteoTx) {
  if (!usuario) return null;

  if (tx && tx.trialIniciado) {
    const base = '\n\n─────\n🎁 Acabas de estrenar *Neto Pro*: ' + TRIAL_DIAS +
      ' días con todo abierto — gráficos, categorías, reportes e historial completo.';
    const link = !usuario.supabase_auth_id ? construirLinkActivacion(usuario.id) : null;
    if (link) {
      return base + '\n\nActívalo con un toque, sin contraseñas:\n' + link;
    }
    return base + '\n\nMíralo en ' + WEBAPP_URL + '/dashboard';
  }

  const muro = await nudgeMuro(usuario);
  if (muro) return muro;

  return nudgeActivacion(usuario, conteoTx);
}

module.exports = {
  TRIAL_DIAS,
  AVISO_DIAS_ANTES,
  enTrial,
  estaEnMuro,
  esProPagado,
  diasRestantesTrial,
  iniciarTrialSiCorresponde,
  totalGastadoMes,
  mensajeMuro,
  mensajeCargaMasivaPro,
  mensajeGmailProPagado,
  mensajeConectarEnLaApp,
  mensajeGmailDesconectado,
  linkPanelPro,
  nudgeMuro,
  colaConfirmacionGasto,
};
