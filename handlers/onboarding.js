// Maquina de estados del onboarding (alta de usuarios) de Neto por WhatsApp.
//
// Extraida de handlers/webhook.js para aislar el flujo mas critico del producto
// (el alta) de la cascada de despacho de comandos. El estado vive en la columna
// usuarios.onboarding_paso; los valores en uso son: -1 (desconexion/wipe),
// 0 (idle/completado), 1 (elige Free/Pro), 2 (elige plan / espera comprobante),
// 10 (categorias), 20 (presupuesto opcional), 100 (pide nombre).
// El marcador de "alta completa" es la columna booleana onboarding_completado,
// no un valor de paso: al terminar, onboarding_paso vuelve a 0.
//
// Los pasos 30 y 31 (elegir bancos por menu numerado, antes y despues de conectar
// Gmail) se retiraron cuando la conexion paso a ser web-only. Eran el unico estado
// que vivia en la DB ENTRE dos mensajes de una capability de pago, y por eso cada
// uno necesitaba su propio gate duplicado: el gate del comando ya habia quedado
// atras cuando llegaba la respuesta al menu. En produccion ninguno de los 93
// usuarios llego a fijar `bancos_seleccionados`: el multiselect de la webapp
// produce el mismo valor mostrando los bancos ANTES de autorizar.
//
// El alta termina en el paso 100: nombre (salteable) y listo. Los pasos 1 y 2
// (Free/Pro y comprobante) siguen vivos porque los usa /premium y el flujo de
// pago Yape, pero el alta ya NO enruta hacia ellos. El paso 101 (email) se
// retiro: era el punto de fuga mas caro y su unica razon de ser era vincular la
// cuenta web, cosa que ahora resuelve el link firmado de lib/activacion.js.
//
// Contrato: manejarOnboarding devuelve el texto a enviar si el mensaje pertenece
// al alta, o null si no (para que webhook.js siga a su cascada de comandos y NLP).
// Los efectos de DB (updates a usuarios, deletes del wipe) y analytics ocurren
// aqui dentro; el envio por WhatsApp lo hace webhook con el string devuelto.
//
// Precedencia (identica a la del webhook original): primero las guardas por
// onboarding_paso (solo cuando el mensaje NO es un /comando — un "/x" siempre
// escapa la maquina de estados), y solo si ninguna aplica, los triggers de
// entrada (hola / usuario nuevo / /manual). Un "hola" de usuario ya onboardeado
// NO es alta: devuelve null y webhook maneja el saludo normal.

const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { notificarAdmin } = require('../lib/admin-notify');
const { registrarError } = require('../lib/error-monitor');
const { PRO_PRECIOS } = require('../lib/config');
const { CATEGORIAS_SUGERIDAS } = require('../lib/constants');
const { parsearIndicesRespuesta } = require('../lib/formatters');
const { obtenerCuentasGmail, revocarAccesoGmail } = require('../gmail');
const { linkPanelPro, esProPagado } = require('../lib/trial');
const { crearCategoriasDesdeIndices } = require('../services/categories');
const { interpretarComandoPresupuesto } = require('../services/parsers');
const { guardarPresupuesto } = require('../services/budget');
const analytics = require('../lib/analytics');

// Telemetría del alta. Hasta ahora solo se capturaba el inicio (wa_user_registered)
// y el final (wa_onboarding_completed), así que los pasos intermedios — donde se cae
// la mayor parte de la gente — solo se podían mirar a mano con SQL. Estos dos eventos
// cierran el embudo en PostHog.
//
// NUNCA mandar el contenido del mensaje: el motivo y el paso alcanzan para
// diagnosticar, y el texto literal ya queda en `conversaciones`.
function stepOk(usuario, paso, siguiente, via) {
  const props = { paso, siguiente };
  if (via) props.via = via;
  analytics.capture(usuario.id, 'wa_onboarding_step_ok', props);
}
function stepFailed(usuario, paso, motivo) {
  analytics.capture(usuario.id, 'wa_onboarding_step_failed', { paso, motivo });
}

// ─── Alta reordenada: el valor antes que la identidad ────────────────────────
// El alta pedía nombre → email → plan y recién ahí dejaba registrar un gasto.
// 21 de 82 usuarios se caían antes de haber usado Neto una sola vez. Ahora lo
// único previo es el nombre (y es salteable); todo lo demás — vincular la cuenta
// web, elegir plan — pasa después, cuando la persona ya vio para qué sirve esto.

// ¿El mensaje trae un monto? Un nombre no lleva números. Es el mismo regex de
// salvarGastoSinIA (message-processor.js): barato, local y determinista — un
// discriminador NO puede costar una llamada a OpenAI en cada nombre que entra.
function pareceTransaccion(msg) {
  const texto = (msg || '').trim();
  if (/(\d+(?:[.,]\d{1,2})?)/.test(texto)) return true;
  return /\b(gast[eé]|pagu[eé]|compr[eé]|almuerzo|taxi|soles?|s\/)\b/i.test(texto);
}

function esSkipNombre(cmd) {
  return /^(saltar|omitir|luego|despu[eé]s|paso|skip|no|prefiero no|nada)$/i.test((cmd || '').trim());
}

// Cierra el alta. El marcador real es onboarding_completado; onboarding_paso
// vuelve a 0. `via` alimenta el embudo de PostHog.
async function completarAlta(usuario, via) {
  // Acá había un `cuenta_borrada_at: null`, con el argumento de que volver "PASA
  // obligatoriamente por esta función". Era falso y la revisión adversarial lo desarmó:
  // `onboarding_completado = true` se escribe en al menos otros cinco lugares que no
  // limpiaban nada (`lib/pro-payment.js` al aprobar un pago, los pasos 1 y 10, el callback
  // de Gmail, y el alta web). El peor: wipe → `/premium` → Yape → aprobado → un cliente
  // que PAGA quedaba marcado como baja para siempre, invisible en el MRR.
  //
  // Y `merge_and_link` hereda las dos columnas en el MISMO update, así que tras un merge
  // el usuario quedaba marcado Y con el alta cerrada: ni siquiera podía volver a pasar
  // por acá. La marca era una trampa sin salida.
  //
  // Por eso `cuenta_borrada_at` es un HECHO y no ESTADO: cuándo pidió la baja, y no se
  // limpia nunca. "¿Está de baja HOY?" se responde DERIVÁNDOLO (la baja contra un pago
  // posterior), no manteniendo una marca sincronizada en N lugares. Un hecho no se
  // desincroniza.
  //
  // PENDIENTE, y por eso hoy la columna sólo se ESCRIBE: el consumidor de métricas quedó
  // fuera a propósito. Dos rondas de revisión adversarial encontraron que excluir la baja
  // del MRR sin tocar churn ni el histórico produce un número que miente distinto, y que
  // el testigo obvio de un retorno (`fecha_pago`, `premium_desde`) se escribe sin que entre
  // plata — un comp del admin o el premio de referidos resucitaría a un churneado. El
  // testigo correcto es una fila de `pagos` aprobada posterior a la baja. Decisión de Favio
  // (17-ago-2026): shippear el aviso, que es lo que cierra el agujero de no enterarse, y
  // hacer la exclusión del MRR en una pasada propia.
  await supabase.from('usuarios')
    .update({ onboarding_paso: 0, onboarding_completado: true })
    .eq('id', usuario.id);
  stepOk(usuario, 100, 0, via);
  analytics.capture(usuario.id, 'wa_onboarding_completed', { via });
}

// El único mensaje del alta que importa: pedir el primer gasto. Nada de plan,
// nada de email. El link de activación llega DESPUÉS de ese gasto, no antes.
function mensajePrimerGasto(nombre) {
  const primerNombre = nombre ? nombre.split(' ')[0] : '';
  return (primerNombre ? '¡Listo, *' + primerNombre + '*! 🤝' : '¡Listo! 🤝') + '\n\n' +
    'Anótame tu primer gasto y te muestro cómo funciono:\n\n' +
    '📝 _"gasté 20 en taxi"_\n' +
    '📸 O mándame la foto de un Yape o Plin\n\n' +
    '_Lo que sea, del monto que sea._';
}

// ─── Borrado total de datos (el "wipe") ──────────────────────────────────────
//
// Estaba escrito TRES veces (multi-cuenta, una cuenta, sin cuentas) y las tres copias
// compartían el mismo agujero: borraban los datos y no dejaban rastro de que alguien se
// había ido. Medido el 17-ago-2026: DOS de los cinco Pro pagados pasaron por acá — uno
// con plan anual vigente hasta 2027 — y siguieron contando como ingreso recurrente. Nadie
// se enteró: el flujo no avisa, no escribe en `errores` y no abre ticket.
//
// Es la única baja DECLARADA del producto. Todo lo demás (inactividad, vencimiento) es
// una inferencia nuestra; esto lo pidió la persona.
//
// Lo que NO hace, y es deliberado: no toca `plan` ni `premium_vence`. Quien pagó tiene
// derecho a su Pro si vuelve. La marca es para las MÉTRICAS; el entitlement no se mueve.
async function ejecutarBorradoTotal(usuario, { tieneGmail }) {
  // El conteo va ANTES de borrar, que es la única ventana donde existe. Es lo que
  // convierte el aviso en accionable: "se fue" vale poco, "se fue con 131 movimientos y
  // plan anual vigente hasta 2027" dice si hay que llamarlo.
  let filas = null;
  try {
    const { count } = await supabase.from('transacciones')
      .select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id);
    filas = typeof count === 'number' ? count : null;
  } catch (e) { /* el conteo es para el aviso: nunca puede impedir que el usuario borre */ }

  // Los tres deletes LEEN su error. supabase-js no lanza: sin mirarlo, un statement
  // timeout sobre un historial grande dejaba los datos intactos, escribia igual la marca
  // de baja, le decia a la persona "todos tus datos han sido eliminados" y al admin
  // "movimientos borrados: 131". Tres afirmaciones falsas y ni una linea de log.
  //
  // EL ORDEN ES LA GARANTÍA, y por eso `transacciones` va ÚLTIMA. Antes iba primera y el
  // bucle ACUMULABA los fallos en vez de cortar, así que un fallo en `categorias_usuario`
  // dejaba el peor estado posible: los movimientos ya borrados (irreversible), categorías y
  // presupuestos vivos, la baja sin marcar, y a la persona leyendo "No pude eliminar todos
  // tus datos" — lo contrario de lo que había pasado. Lo levantó la segunda revisión
  // adversarial del 17-ago y se pusheó igual porque el arreglo pedía repensar el flujo.
  //
  // Con lo irreversible al final y cortando al primer fallo, el invariante que sale gratis
  // es el que hace que el mensaje de abajo NUNCA mienta: **si algo falla, las transacciones
  // siguen ahí**. O el wipe llegó hasta el final, o el dato que no se puede recuperar no se
  // tocó. Perder categorías y presupuestos de alguien que pidió borrar TODO no es agradable,
  // pero es reconstruible y no es plata; un historial de gastos, no.
  //
  // Y cortar en vez de acumular no pierde nada: el usuario reintenta y los deletes son
  // idempotentes, así que la segunda vuelta converge sola.
  let tablaQueFallo = null;
  for (const tabla of ['presupuestos', 'categorias_usuario', 'transacciones']) {
    const { error } = await supabase.from(tabla).delete().eq('usuario_id', usuario.id);
    if (error) {
      tablaQueFallo = tabla;
      log.error({ tag: 'WIPE', usuarioId: usuario.id, tabla, err: error.message }, 'El borrado de datos FALLO');
      break;
    }
  }

  // El corte va ANTES de escribir nada. En la primera versión el `if (fallos.length)`
  // estaba al final, después del UPDATE: o sea que un borrado fallido igual marcaba la
  // baja y sacaba el aviso, y solo cambiaba el texto que leía la persona. Lo encontró el
  // test que se escribió para esta rama, no la lectura del código.
  if (tablaQueFallo) {
    // Sacarlo del paso -1 es parte del arreglo, no limpieza. Quedándose ahí, el siguiente
    // mensaje que no fuera el número exacto del menú caía en "Cancelado. Tu cuenta sigue
    // igual. 👍" — una SEGUNDA afirmación falsa sobre el mismo evento, y encima la persona
    // se quedaba creyendo que no había pasado nada. Y el "escríbeme de nuevo" del mensaje
    // viejo era imposible de obedecer: escribir cualquier cosa caía justo en ese "Cancelado".
    const { error: errPaso } = await supabase.from('usuarios')
      .update({ onboarding_paso: 0 }).eq('id', usuario.id);
    if (errPaso) {
      log.error({ tag: 'WIPE', usuarioId: usuario.id, err: errPaso.message },
        'El borrado falló Y no pude sacarlo del menú: queda en paso -1');
    }

    // EL MENSAJE MIDE, NO DEDUCE — y medir UNA sola cosa tampoco alcanzó. La primera versión
    // afirmaba "tus movimientos siguen ahí" deduciéndolo del orden de los deletes; la segunda
    // recontaba `transacciones` y leía `quedan === 0` como "se borraron igual". Las dos
    // estaban mal, y la segunda de una forma más fea: `quedan === 0` tiene DOS causas
    // indistinguibles —el DELETE commiteó pese al `{error}`, o el usuario no tenía nada que
    // borrar— y elegía siempre la primera. A alguien con cero gastos que pedía la baja y se
    // caía en `presupuestos` le decía "tus movimientos sí se eliminaron" con `transacciones`
    // sin tocar una sola vez, y lo mandaba a soporte diciéndole que no había reintento.
    //
    // El desambiguador ya estaba calculado dos líneas arriba: `filas`, el conteo PREVIO. La
    // pérdida solo es afirmable si se cumplen las tres: falló `transacciones`, antes había
    // algo, y ahora no queda nada.
    //
    // Por qué `{ error }` no basta: significa "el cliente no pudo confirmar", NO "el servidor
    // no lo hizo". Un 504 del edge, un socket cortado o un restart del contenedor devuelven
    // error mientras Postgres termina el DELETE y COMMITEA. Y `transacciones` es la última Y
    // la más cara (el trigger `trg_audit_borrado` le suma un INSERT por fila), o sea la que
    // más probablemente se corta por arriba.
    let quedan = null;
    try {
      const { count, error: errConteo } = await supabase.from('transacciones')
        .select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id);
      if (!errConteo && typeof count === 'number') quedan = count;
    } catch (e) { /* sin conteo no se afirma nada: "no sé" es un TERCER estado */ }

    const fallóEnTx = tablaQueFallo === 'transacciones';
    // Solo con las TRES. `filas === null` (el conteo previo tampoco se pudo leer) no cuenta
    // como "había algo": no se afirma una pérdida sobre un dato que no se midió.
    const sePerdieron = fallóEnTx && typeof filas === 'number' && filas > 0 && quedan === 0;
    // Si falló `transacciones`, las otras dos SÍ se borraron: son las que van antes y el bucle
    // corta al primer fallo. Callarlo dejaba a la persona con sus categorías y presupuestos
    // destruidos creyendo que no había pasado nada.
    const perdióElResto = fallóEnTx;

    // Esto va al admin DIRECTO, y no por `registrarError`: esa función solo notifica cuando la
    // misma clave llega a 5 en una hora, contra un contador EN MEMORIA que un redeploy borra.
    // O sea que un wipe fallido aislado —justo el que pudo destruir `presupuestos` y
    // `categorias_usuario` en silencio— dejaba una fila en una tabla que nadie mira y cero
    // avisos, mientras el wipe EXITOSO sí empuja notificación. El evento inocuo sonaba y el
    // destructivo era mudo. `registrarError` se queda igual: es el rastro consultable.
    const detalleFallo = 'tabla: ' + tablaQueFallo +
      ' · transacciones antes: ' + (filas === null ? 'no se pudo contar' : filas) +
      ' · ahora: ' + (quedan === null ? 'no se pudo contar' : quedan) +
      (errPaso ? ' · NO se pudo sacar del paso -1' : '');
    try {
      await registrarError('WIPE', 'El borrado total FALLO en ' + tablaQueFallo, {
        usuarioId: usuario.id, detalle: detalleFallo,
      });
    } catch (e) { /* el registro del fallo no puede ser el que rompa la respuesta */ }
    try {
      await notificarAdmin('⚠️ *WIPE FALLIDO* — un borrado de cuenta quedó a medias\n\n' +
        'Usuario: ' + (usuario.nombre || 'sin nombre') + ' (' + String(usuario.id).slice(0, 8) + ')\n' +
        detalleFallo +
        (sePerdieron ? '\n\n❗ Las transacciones SE PERDIERON pese al error: hay que cerrarlo a mano.' : '') +
        (perdióElResto ? '\n\n❗ `presupuestos` y `categorias_usuario` SÍ se borraron.' : ''));
    } catch (e) { /* `notificarAdmin` no lanza, pero el aviso nunca puede tumbar la respuesta */ }

    // `/soporte` es un COMANDO, así que escapa la máquina de estados y al clasificador. El
    // mensaje viejo mandaba a escribir "eliminar mi cuenta", que es exactamente la frase que
    // el harness de esta sesión documenta como misclasificada: cuando gpt-4o-mini la manda a
    // `deshacer_ultimo`, la guarda responde "escribe *borra el último*" y NUNCA abre el menú
    // de baja. De `desconectar_cuenta` no hay comando: solo se llega por NLP.
    if (sePerdieron) {
      return '⚠️ El borrado quedó a medias: tus movimientos sí se eliminaron, pero no pude ' +
        'cerrar tu baja.\n\nEscríbeme */soporte* y lo terminamos a mano.';
    }
    if (fallóEnTx && quedan === null) {
      // Falló justo la tabla irreversible y no puedo confirmar en qué quedó. Es el único caso
      // donde el silencio es la respuesta honesta.
      return '⚠️ Algo falló al eliminar tus datos y no pude confirmar en qué quedó.\n\n' +
        'Escríbeme */soporte* y lo revisamos contigo.';
    }
    // Acá abajo nada irreversible se perdió: o no se llegó a `transacciones`, o su delete falló
    // y las filas siguen. El reintento converge solo, porque los deletes son idempotentes.
    return '⚠️ No pude terminar de eliminar tus datos ahora mismo.' +
      (perdióElResto ? ' Tus categorías y presupuestos sí se borraron, pero *tus movimientos siguen ahí*.' : '') +
      '\n\nVuelve a pedirme la baja en un rato. Si te vuelve a fallar, escríbeme */soporte*.';
  }

  const campos = { email: null, onboarding_paso: 0, onboarding_completado: false, cuenta_borrada_at: new Date().toISOString() };
  // Las dos escrituras de Gmail eran las que quedaban SIN leer su resultado: el arreglo de
  // "leer el `{error}`" cubría 3 de 5. Acá no se corta ni se revierte —los datos ya se
  // borraron y el usuario pidió irse— pero el fallo tiene que llegar al admin: si el grant
  // sobrevive, seguimos con permiso de lectura sobre la bandeja de alguien que se fue, y eso
  // se arregla a mano o no se arregla. `revocarAccesoGmail` además puede LANZAR
  // (`obtenerCuentasGmail` no está guardado por dentro), y sin este try la excepción se
  // llevaba puestos la marca de baja y el aviso, con los datos ya borrados.
  let gmailSucio = null;
  if (tieneGmail) {
    // `(e && e.message) || String(e)` y no `e.message`: si el rechazo no es un Error (`throw
    // 'x'`, un reject con null) eso rompía DENTRO del catch, y esa excepción se llevaba la
    // marca de baja y el aviso con los datos ya borrados — el peor caso, causado por el
    // manejo del peor caso.
    //
    // Los dos pasos van en try SEPARADOS a propósito. Con uno solo, una excepción de
    // `revocarAccesoGmail` se llevaba puesto también el delete de la fila —que no depende
    // de que la revocación haya salido bien— y el aviso al admin decía "falló la
    // revocación" sin mencionar que la fila seguía viva. El admin iba a la consola de
    // Google, revocaba a mano, y dejaba la fila que alimenta `emailGmailVinculado` y el
    // `login_hint`. Cada mitad falla por su lado y cada mitad se nombra.
    const sucio = [];
    try {
      // Revocar ANTES del delete: borrar la fila tira el refresh token, y sin token el
      // grant queda vivo en Google para siempre, sin forma de alcanzarlo.
      await revocarAccesoGmail(usuario.id, { motivo: 'usuario_borro_cuenta' });
    } catch (e) {
      sucio.push('falló la revocación en Google: ' + ((e && e.message) || String(e)));
    }
    try {
      const { error: errGmail } = await supabase.from('gmail_cuentas').delete().eq('usuario_id', usuario.id);
      if (errGmail) sucio.push('quedó viva la fila de `gmail_cuentas`: ' + errGmail.message);
    } catch (e) {
      sucio.push('quedó viva la fila de `gmail_cuentas`: ' + ((e && e.message) || String(e)));
    }
    if (sucio.length) gmailSucio = sucio.join(' · ');
    if (gmailSucio) {
      log.error({ tag: 'WIPE', usuarioId: usuario.id, err: gmailSucio }, 'El wipe dejó Gmail a medias');
    }
    campos.gmail_access_token = null;
    campos.gmail_refresh_token = null;
    campos.gmail_token_expiry = null;
  }
  // Se lee el `error`: supabase-js NO lanza, así que sin mirarlo un UPDATE rechazado
  // dejaría la marca sin poner y el aviso saldría igual, diciendo algo que no pasó.
  const { error: errMarca } = await supabase.from('usuarios').update(campos).eq('id', usuario.id);
  if (errMarca) {
    log.error({ tag: 'WIPE', usuarioId: usuario.id, err: errMarca.message }, 'No se pudo marcar la baja: los datos SI se borraron');
  }

  await avisarBajaAlAdmin(usuario, { filas, marcada: !errMarca, gmailSucio });

  // Los dos textos son los de antes, palabra por palabra, y la condición es la misma que
  // los elegía (había Gmail o no). El conteo NO entra acá: hacerlo depender de `filas`
  // cambiaría el mensaje de un usuario sin Gmail y con gastos, que hoy lee "Datos
  // eliminados". Nadie pidió eso y un refactor no es el lugar para decidirlo.
  return tieneGmail
    ? '🗑️ *Cuenta limpia*\n\nTodos tus datos han sido eliminados. Si quieres volver, escribe _"hola"_ y empezamos de cero.'
    : '🗑️ *Datos eliminados*\n\nSi quieres volver, escribe _"hola"_.';
}

// El aviso es best-effort por construcción: el usuario ya borró sus datos y no hay nada
// que reintentar. Un fallo acá no puede propagarse a la respuesta que espera la persona.
async function avisarBajaAlAdmin(usuario, { filas, marcada, gmailSucio = null }) {
  try {
    const pagado = esProPagado(usuario);
    const partes = [
      '🗑️ *BAJA DECLARADA* — un usuario borró todos sus datos',
      '',
      'Usuario: ' + (usuario.nombre || 'sin nombre') + ' (' + String(usuario.id).slice(0, 8) + ')',
      'Movimientos que tenia: ' + (filas === null ? 'no se pudo contar' : filas),
    ];
    if (pagado) {
      // Lo que hace que este aviso valga la pena leerlo: distingue a alguien que probó y
      // se fue de un CLIENTE que pagó y se fue.
      partes.push('');
      partes.push('⚠️ *ES PRO PAGADO* — plan ' + (usuario.tipo_plan || 'mensual') +
        ', vigente hasta ' + (usuario.premium_vence || 'sin fecha'));
      partes.push('El plan NO se tocó: si vuelve, conserva lo que pagó.');
    }
    if (!marcada) {
      partes.push('');
      partes.push('❗ No se pudo escribir `cuenta_borrada_at`: sigue contando en el MRR.');
    }
    if (gmailSucio) {
      // Los datos ya no están, así que esto no tiene reintento automático: o alguien lo
      // limpia a mano, o nos quedamos con permiso de lectura sobre la bandeja de alguien
      // que se fue.
      partes.push('');
      partes.push('❗ Gmail quedó a medias — ' + gmailSucio);
      partes.push('Hay que revocar a mano en la consola de Google.');
    }
    // `notificarAdmin` NUNCA lanza: tiene su propio try/catch y devuelve false cuando
    // fallan los dos canales (Telegram caído + WhatsApp fuera de la ventana de 24h de
    // Meta). Sin leer el booleano, el catch de abajo era inalcanzable y la única baja
    // declarada del producto podía evaporarse sin dejar rastro en ningún lado. Este
    // evento no tiene reintento ni cola, así que el log ES el último respaldo.
    const ok = await notificarAdmin(partes.join('\n'));
    if (!ok) {
      log.error({ tag: 'WIPE', usuarioId: usuario.id, pagado, filas },
        'BAJA DECLARADA sin avisar: fallaron Telegram y WhatsApp');
    }
  } catch (e) {
    log.error({ tag: 'WIPE', usuarioId: usuario.id, err: e.message }, 'No se pudo avisar la baja al admin');
  }
}

// Cola de los mensajes de desconexión. Decían "vuelve a conectar escribiendo _conectar
// gmail_", que desde que la conexión es web-only devolvía al usuario a un canal sin botón.
function colaReconexion(usuario) {
  const link = linkPanelPro(usuario);
  return link ? '\n\nPuedes volver a conectarlo cuando quieras desde tu app:\n' + link : '';
}

/**
 * @param {object} args
 * @param {object} args.usuario  fila de usuarios (incluye onboarding_paso, nombre, ...)
 * @param {string} args.msg      texto crudo del mensaje entrante
 * @param {string} args.cmd      msg.toLowerCase().trim()
 * @returns {Promise<string|null>} texto a enviar, o null si no es parte del alta
 */
async function manejarOnboarding({ usuario, msg, cmd }) {
  // ─── Flujo desconectar cuenta / wipe (paso -1) ─────────────────────────────
  if (usuario.onboarding_paso === -1 && !cmd.startsWith('/')) {
    const respDesc = parseInt(cmd.trim());
    const cuentasActivas = await obtenerCuentasGmail(usuario.id);
    const numCuentas = cuentasActivas.length;

    // La rama multi-cuenta NO es alcanzable con el modelo actual (un usuario, un correo, para
    // siempre) y al 2026-08-03 ningún usuario tiene dos cuentas activas. Se evaluó borrarla y se
    // decidió que NO, por una razón concreta: el índice único de `gmail_cuentas` es sobre
    // `(usuario_id, email)`, no sobre `usuario_id`. O sea que la regla de una-sola vive en
    // `guardarTokens` y en NADA de la base — dos filas siguen siendo insertables, y nunca se
    // hizo un backfill que garantice que no existan. Sin esta rama, un usuario en ese estado
    // cae al "Cancelado" del final y se queda SIN FORMA de soltar un Gmail que quiere soltar.
    // Borrar 20 líneas inalcanzables no vale dejar a alguien sin la puerta de salida de sus
    // propios datos. El menú de `handlers/intents/moderacion.js` ramifica igual, en espejo.
    if (numCuentas > 1) {
      // Multi-cuenta: 1..N = desconectar individual, N+1 = todas, N+2 = eliminar todo
      if (respDesc >= 1 && respDesc <= numCuentas) {
        const cuentaTarget = cuentasActivas[respDesc - 1];
        // Revoca en Google, no solo marca la fila: el flip local le corta la lectura al
        // usuario pero nos deja el permiso vivo sobre una bandeja que pidió cerrar.
        await revocarAccesoGmail(usuario.id, { motivo: 'usuario_desconecto_una', cuentaId: cuentaTarget.id });
        await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
        return '✅ *' + cuentaTarget.email + ' desconectado*\n\nTus otras cuentas siguen activas. Tu historial se mantiene intacto.';
      } else if (respDesc === numCuentas + 1) {
        await revocarAccesoGmail(usuario.id, { motivo: 'usuario_desconecto_todas' });
        await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
        return '✅ *Todas las cuentas Gmail desconectadas*\n\nTu historial de gastos se mantiene intacto.' + colaReconexion(usuario);
      } else if (respDesc === numCuentas + 2) {
        return await ejecutarBorradoTotal(usuario, { tieneGmail: true });
      }
    } else if (numCuentas === 1) {
      if (respDesc === 1) {
        await revocarAccesoGmail(usuario.id, { motivo: 'usuario_desconecto' });
        await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
        return '✅ *Gmail desconectado*\n\nTu historial de gastos se mantiene intacto.' + colaReconexion(usuario);
      } else if (respDesc === 2) {
        return await ejecutarBorradoTotal(usuario, { tieneGmail: true });
      }
    } else {
      // Sin cuentas Gmail, solo opción de eliminar datos
      if (respDesc === 1) {
        return await ejecutarBorradoTotal(usuario, { tieneGmail: false });
      }
    }
    // Respuesta no válida → cancelar
    await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
    return 'Cancelado. Tu cuenta sigue igual. 👍';
  }

  // ─── Paso 100: Recoger nombre del usuario ──────────────────────────────────
  // Ya NO es un bucle. Tenía una sola salida (dar un nombre que pasara el
  // validador) y ahí se caían 10 de 82 usuarios, con una vida mediana de 5
  // minutos. Ahora tiene tres, y ninguna deja a nadie atrapado: el nombre es lo
  // único que se pide antes de que Neto sea útil, y ni siquiera es obligatorio.
  if (usuario.onboarding_paso === 100 && !cmd.startsWith('/')) {
    // El usuario quiere empezar a usar Neto ya, no presentarse.
    if (esSkipNombre(cmd)) {
      await completarAlta(usuario, 'saltado');
      return mensajePrimerGasto(null);
    }
    // Escribió un gasto en vez de su nombre. Antes esto se guardaba COMO nombre
    // ("Gasté 20 En Taxi"): el validador acepta cualquier cosa de 2-50 chars, así
    // que el primer gasto de la persona se perdía y encima quedaba de nombre.
    // Ahora el alta se cierra y el mensaje cae al pipeline normal, que lo registra.
    if (pareceTransaccion(msg)) {
      await completarAlta(usuario, 'primer_gasto');
      return null;   // ← fall-through: lo procesa message-processor como siempre
    }
    let nombreInput = msg.trim();
    const nombreMatch = nombreInput.match(/(?:me llamo|mi nombre es|soy|es)\s+(.+)/i);
    if (nombreMatch) nombreInput = nombreMatch[1].trim();
    nombreInput = nombreInput.replace(/[.,!]+$/, '').trim();
    if (nombreInput.length < 2 || nombreInput.length > 50 || /^\d+$/.test(nombreInput)) {
      stepFailed(usuario, 100, 'nombre_invalido');
      // Se repregunta UNA sola vez. Al segundo intento fallido el nombre deja de
      // importar: vale más un usuario activo sin nombre que uno trabado con él.
      if (usuario.nombre_intentos >= 1) {
        await completarAlta(usuario, 'saltado');
        return mensajePrimerGasto(null);
      }
      await supabase.from('usuarios').update({ nombre_intentos: (usuario.nombre_intentos || 0) + 1 }).eq('id', usuario.id);
      return 'No pillé tu nombre. 🤔\n\nEscríbelo solito (ej: _"María"_) o dime *saltar* y empezamos de una.';
    }
    const nombreLimpio = nombreInput.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    await supabase.from('usuarios').update({ nombre: nombreLimpio }).eq('id', usuario.id);
    await completarAlta(usuario, 'nombre');
    return mensajePrimerGasto(nombreLimpio);
  }

  // ─── Paso 101 (retirado): pedía el email ───────────────────────────────────
  // El email era el peor punto de fuga del alta (7 de 82) y no tenía razón de
  // producto: se pedía para vincular la cuenta web, y eso ahora lo resuelve el
  // link de activación firmado (lib/activacion.js), que ya lleva la identidad.
  // Esta rama solo desatasca a quien quedó en 101 con el flujo viejo: data en
  // vuelo al momento del deploy, o alguien que vuelve meses después.
  if (usuario.onboarding_paso === 101 && !cmd.startsWith('/')) {
    await completarAlta(usuario, 'desatascado_101');
    if (pareceTransaccion(msg)) return null;   // si escribió un gasto, que se registre
    return mensajePrimerGasto(usuario.nombre);
  }

  // ─── Paso 1: Usuario elige Free/Pro ────────────────────────────────────────
  if (usuario.onboarding_paso === 1 && !cmd.startsWith('/')) {
    const resp1 = cmd.trim().toLowerCase();
    if (resp1 === 'free' || resp1 === 'gratis' || resp1 === 'manual') {
      await supabase.from('usuarios').update({
        plan: 'free',
        onboarding_paso: 0,
        onboarding_completado: true
      }).eq('id', usuario.id);
      analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'free' });
      return '🆓 *¡Bienvenido a Neto Free!*\n\n' +
        'Registra gastos así:\n\n' +
        '📝 _"gasté 50 en taxi"_\n' +
        '📸 Envía una foto de Yape o Plin\n\n' +
        '📊 Configura tus presupuestos en tu dashboard:\nhttps://app.neto.pe/dashboard/presupuestos\n\n' +
        '¿Por dónde empezamos?';
    }
    if (resp1 === 'pro' || resp1 === 'si' || resp1 === 'sí' || resp1 === 'yes' || resp1 === 'dale' || resp1 === 'va' || resp1 === 'quiero') {
      await supabase.from('usuarios').update({ onboarding_paso: 2 }).eq('id', usuario.id);
      stepOk(usuario, 1, 2);
      return '🎉 *¡Genial!*\n\n' +
        'Elige tu plan:\n\n' +
        '1️⃣ *Mensual* — S/' + PRO_PRECIOS.mensual + '/mes\n' +
        '2️⃣ *Anual* — S/' + PRO_PRECIOS.anual + '/año (2 meses gratis)\n\n' +
        '📲 *Yapea al:* 970398192\n' +
        '👤 *A nombre de:* Favio Mendoza\n\n' +
        'Después envíame la captura del Yape aquí. 📸';
    }
    if (resp1 === 'no' || resp1 === 'no gracias') {
      await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
      stepFailed(usuario, 1, 'rechaza_plan');
      return '👍 Sin problema. Si cambias de opinión, escribe *hola* cuando quieras.';
    }
    stepFailed(usuario, 1, 'plan_no_reconocido');
    return 'Escribe *free* para empezar gratis o *pro* para activar el plan Pro.';
  }

  // ─── Paso 2: Esperando selección de plan o comprobante de pago ─────────────
  // (La captura de pago por imagen la maneja el handler de IMAGEN en webhook.js
  //  vía esperaComprobante(), que lee onboarding_paso === 2.)
  if (usuario.onboarding_paso === 2 && !cmd.startsWith('/')) {
    if (cmd === '1' || cmd.trim().toLowerCase() === 'mensual') {
      await supabase.from('usuarios').update({ tipo_plan: 'mensual' }).eq('id', usuario.id);
      return '✅ Plan *mensual* (S/' + PRO_PRECIOS.mensual + '/mes).\n\n📲 Yapea S/' + PRO_PRECIOS.mensual + ' al *970398192* (Favio Mendoza) y envíame la captura aquí. 📸';
    } else if (cmd === '2' || cmd.trim().toLowerCase() === 'anual') {
      await supabase.from('usuarios').update({ tipo_plan: 'anual' }).eq('id', usuario.id);
      return '✅ Plan *anual* (S/' + PRO_PRECIOS.anual + '/año — 2 meses gratis).\n\n📲 Yapea S/' + PRO_PRECIOS.anual + ' al *970398192* (Favio Mendoza) y envíame la captura aquí. 📸';
    }
    return 'Elige tu plan:\n\n1️⃣ *Mensual* — S/' + PRO_PRECIOS.mensual + '\n2️⃣ *Anual* — S/' + PRO_PRECIOS.anual + '\n\nO envíame la captura de tu Yape si ya pagaste. 📸';
  }

  // ─── Paso 10: Selección de categorías ──────────────────────────────────────
  // Sin índices válidos NO retorna: cae a los triggers de entrada de abajo
  // (comportamiento heredado del webhook original).
  if (usuario.onboarding_paso === 10 && !cmd.startsWith('/')) {
    const idxResp = parsearIndicesRespuesta(msg, CATEGORIAS_SUGERIDAS.length);
    if (idxResp.length > 0) {
      await crearCategoriasDesdeIndices(usuario.id, idxResp);
      const nombresAct = idxResp.map(function(i){ return CATEGORIAS_SUGERIDAS[i-1].emoji+' '+CATEGORIAS_SUGERIDAS[i-1].nombre; }).join(', ');
      const rspCat = '🎉 *Categorias activadas:*\n' + nombresAct + '\n\nCada una tiene subcategorias sugeridas.\n\n*¿Quieres configurar un presupuesto mensual?* 💰\n\nEj: _"limite de 500 soles en Comida"_\n\nO escribe *listo* para empezar con NETO.';
      await supabase.from('usuarios').update({ onboarding_paso: 20, onboarding_completado: true }).eq('id', usuario.id);
      analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'categorias' });
      return rspCat;
    }
  }

  // ─── Paso 20: Presupuesto opcional ─────────────────────────────────────────
  // Texto no reconocido como presupuesto NO retorna: cae a los triggers de abajo.
  if (usuario.onboarding_paso === 20 && !cmd.startsWith('/')) {
    const cmdLower20 = cmd.trim().toLowerCase();
    if (cmdLower20 === 'listo' || cmdLower20 === 'no' || cmdLower20 === 'omitir' || cmdLower20 === 'saltar') {
      await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
      const primerNombre20 = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
      return (primerNombre20 ? 'Listo, ' + primerNombre20 + '.' : 'Listo.') + ' Ya estoy trabajando por ti.\n\nEscribeme como quieras:\n_"cuanto gaste esta semana"_\n_"como va mi delivery"_\n_"dame mi reporte"_\n\n¿Por donde empezamos?';
    }
    try {
      const interpPres20 = await interpretarComandoPresupuesto(msg);
      if (interpPres20.es_presupuesto && interpPres20.categoria && interpPres20.monto) {
        await guardarPresupuesto(usuario.id, interpPres20.categoria, interpPres20.monto);
        return '✅ Presupuesto de *' + interpPres20.categoria + '*: *S/ ' + parseFloat(interpPres20.monto).toFixed(2) + '/mes*\n\n¿Alguna otra categoria? O escribe *listo* para terminar.';
      }
    } catch (e) {}
  }

  // ─── Triggers de entrada al alta ───────────────────────────────────────────
  const esUsuarioNuevo = !usuario.gmail_access_token && !usuario.onboarding_completado;
  if (cmd === 'hola' || cmd === 'hi' || cmd === 'inicio') {
    const tieneGmail = !!usuario.gmail_access_token;
    if (!tieneGmail && !usuario.onboarding_completado) {
      if (!usuario.nombre) {
        await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', usuario.id);
        return '👋 ¡Hola! Soy *NETO*, tu asistente financiero por WhatsApp.\n\n' +
          '¿Cómo te llamas?\n\n_O dime *saltar* si prefieres ir directo._';
      }
      // Ya tiene nombre → no queda nada que preguntar. El plan ya no se elige en
      // el alta: el modelo es probar primero y pagar después, así que invitar a
      // Pro el día 1 (antes de que la persona registre un solo gasto) no aplica.
      await completarAlta(usuario, 'nombre');
      return mensajePrimerGasto(usuario.nombre);
    }
    // Usuario ya onboardeado o con Gmail → NO es alta. El saludo normal (con
    // total del mes) lo maneja webhook.js.
    return null;
  }

  if (cmd === '/manual') {
    await supabase.from('usuarios').update({ plan: 'free' }).eq('id', usuario.id);
    await completarAlta(usuario, 'manual');
    return mensajePrimerGasto(usuario.nombre);
  }

  if (esUsuarioNuevo && !cmd.startsWith('/')) {
    // El primer mensaje YA es un gasto. Se cierra el alta en silencio y se deja
    // pasar: que la primera respuesta de Neto sea el gasto registrado (con el
    // link de activación al pie) y no un formulario es el punto de todo esto.
    if (pareceTransaccion(msg)) {
      await completarAlta(usuario, 'primer_gasto');
      return null;
    }
    await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', usuario.id);
    return '👋 ¡Hola! Soy *NETO*, tu asistente financiero.\n\n' +
      '¿Cómo te llamas?\n\n_O dime *saltar* y empezamos de una._';
  }

  // El mensaje no pertenece al alta.
  return null;
}

module.exports = { manejarOnboarding };
