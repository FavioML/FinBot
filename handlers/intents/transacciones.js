const log = require('../../lib/logger');
// `estaEnMuro` se importa de `lib/trial`, que es la fuente única, y NO se reimplementa
// inline como `plan !== 'premium'`: durante el trial esa columna vale 'premium' y la
// pregunta "¿está en el muro?" tiene su predicado justamente para que no se copie mal.
const { colaConfirmacionGasto, estaEnMuro } = require('../../lib/trial');
const { validarMonto } = require('../../lib/validators');
const { subcategoriaUtil, esSubSinClasificar } = require('../../lib/subcategoria');
const { extraerGastoSinIA, quitarTokensDeMoneda, contarMontosCandidatos, mencionaMonedaNoSoportada, montoEscritoEnMensaje, tipoContradiceElMensaje } = require('../../lib/nlp-guards');
const { registrarError } = require('../../lib/error-monitor');
const { revisarEdicion, pedirOrden } = require('../../lib/orden-edicion');
const { pideAlcanceRetroactivo } = require('../../lib/datos-dichos');
const { esComercioCentinela } = require('../../services/parsers');

// Un mensaje que es SOLO un número (con o sin moneda) no se rescata.
//
// `extraerGastoSinIA` sí lo acepta, por su rama "número suelto + una o dos palabras", que
// existe para "4.10 pastillas". Ahí la palabra es la evidencia de que hubo una compra. Sin
// NINGUNA palabra no queda evidencia de nada, y los dos casos reales que se midieron eran
// SALDOS: "592.91" y —una vez reformulado— "En mi cuenta de ahorros de BCP tengo 1045.21".
// Uno de esos usuarios había pagado S/10 esa mañana, terminó anotando su saldo como ingreso
// porque era la única forma de que entrara, y su resumen del día quedó diciendo
// "Ingresos: S/ 3815.70" sobre plata que no era ingreso.
//
// O sea que acá el rebote es lo CORRECTO y registrarlo en silencio sería peor que hoy:
// modelar saldos es otra decisión de producto, no este arreglo.
//
// La lista de monedas NO se escribe acá: se le pide a `nlp-guards`, que es donde vive la que
// usa el extractor. La primera versión sí tenía lista propia y aceptaba la moneda solo como
// PREFIJO, así que "592.91 usd" se escapaba y entraba como gasto en dólares — o sea el saldo
// multiplicado por el tipo de cambio en `monto_pen`, que es lo que alimenta reportes y score.
// Y "20 lucas" registraba mientras "250 soles" rebotaba, siendo lo mismo.
//
// La guarda vive en este call-site y NO adentro de `extraerGastoSinIA` a propósito: tocarlo
// allá cambiaría también el camino del 429, que es otro contexto (ahí no hubo clasificador y
// el mensaje se pierde entero si nadie lo rescata).
function esSoloUnNumero(msg) {
  return /^\s*\d+(?:[.,]\d+)?\s*[.!]?\s*$/.test(quitarTokensDeMoneda(msg));
}

// Los rebotes de `registrar_manual`, uno por cada `decision` del parser que no registra.
// Fijos y sin estado. Todo ejemplo que den tiene que ser una forma que el parser acepte: lo
// mide la batería `copy` de `qa-e2e/probe-parser-decision.mjs`.
const COPY_SIN_MONTO = 'No pude leer el monto de ahí. Mándamelo con el número y qué fue, así: "almuerzo 15" o "gasté 110.70 en carne". Si son varios gastos, va uno por mensaje.';
const COPY_NO_ES_MOVIMIENTO = 'Eso no lo anoté: registro plata que ya entró o salió. Un saldo, el cupo de una tarjeta, lo que ganas al mes o un pago que todavía no haces no son un movimiento. Cuando se mueva, mándamelo así: "almuerzo 15" o "me pagaron 500".';
const COPY_MONEDA_NO_SOPORTADA = 'Por ahora solo anoto soles y dólares, así que ese no lo registré. Si lo pagaste en soles o en dólares, mándame ese monto, por ejemplo: "gasté 80 en un polo".';

/**
 * La pregunta para un monto sin sentido ("35.00", "Neto es 15800"). Nombra el monto para que
 * la persona sepa de qué se le pregunta, y le da las dos formas con verbo, que entran directo.
 */
function preguntaTipoDudoso(parsed) {
  const m = Number(parsed && parsed.monto_dudoso);
  if (!Number.isFinite(m) || m <= 0) {
    return '¿Esa plata entró o salió? Escríbemelo con el verbo: "gasté 35 en…" o "me pagaron 35".';
  }
  const num = Number.isInteger(m) ? String(m) : m.toFixed(2);
  const usd = parsed.moneda === 'USD';
  const conMoneda = usd ? num + ' dólares' : num;
  return '¿Esos ' + (usd ? '$' : 'S/') + num + ' entraron o salieron? Escríbemelo con el verbo: "gasté ' + conMoneda + ' en…" o "me pagaron ' + conMoneda + '".';
}

// El LLM a veces clasifica queries como register_transaction tras un burst de gastos
// previos en el contexto (bal-001/004/005). Cuando el parser falla por falta de monto,
// chequeamos si es una query disfrazada y redirigimos al handler correcto.
function detectarQuerySinMonto(msg) {
  const m = (msg || '').toLowerCase().trim();
  if (!m) return null;
  // \b en JS no se lleva con caracteres unicode (é/ó/á): /\bgasté\b/ falla porque
  // la `é` no es word-char ASCII y el boundary post-tilde no encaja. Usamos boundary manual.
  const reCuanto = /(?:^|\s)cu[aá]nto(?:s)?(?:\s|$|,|\?)/;
  const reGasto = /(?:^|\s)(gast[eéó]|llev[oó]|he\s+gastado|gastad[oa]s?)(?:\s|$|,|\?)/;
  const reQueda = /(?:^|\s)(me\s+queda|me\s+sobra|tengo\s+disponible|me\s+resta|disponible)(?:\s|$|,|\?)/;
  const rePresupuesto = /presupuesto/;
  const reMayor = /(?:^|\s)(mayor|m[aá]s\s+alto|m[aá]s\s+grande|m[aá]ximo)(?:\s|$|,|\?)/;
  const reMenor = /(?:^|\s)(menor|m[aá]s\s+(?:bajo|peque[nñ]o|chico)|m[ií]nimo)(?:\s|$|,|\?)/;
  const reCualGasto = /(?:^|\s)cu[aá]l(?:es)?\s.*(gasto|gastos)/;
  const reSaldo = /(?:^|\s)(saldo|balance)(?:\s|$|,|\?|\.)/;
  const hoy = /\bhoy\b/.test(m);
  const ayer = /\bayer\b/.test(m);
  const semana = /\b(esta\s+semana|semana\s+actual)\b/.test(m);
  const mesPalabra = /\b(este\s+mes|mes\s+actual|del\s+mes)\b/.test(m);

  // Palabras-clave → categoría canónica (subset de CATEGORIA_MAP, suficiente para queries WhatsApp)
  const CATEGORY_ALIASES = [
    [/\b(comida|alimentos?|alimentaci[oó]n)\b/, 'Alimentación'],
    [/\b(transporte|taxis?|ubers?|bus|micro|gasolina)\b/, 'Transporte'],
    [/\b(salud|farmacia|cl[ií]nica|m[eé]dico)\b/, 'Salud'],
    [/\b(vivienda|hogar|alquiler|renta)\b/, 'Vivienda'],
    [/\b(entretenimiento|cine|salidas?|fiesta)\b/, 'Entretenimiento'],
    [/\b(compras|ropa|calzado)\b/, 'Compras'],
    [/\b(educaci[oó]n|cursos?|colegio|universidad)\b/, 'Educación'],
    [/\b(suscripciones|streaming|netflix|spotify)\b/, 'Suscripciones'],
  ];

  // Saldo/balance del mes: query directa, no requiere "cuánto"
  if (reSaldo.test(m)) {
    return { intencion: 'ver_balance', datos: {} };
  }
  if (reCuanto.test(m) && reQueda.test(m) && rePresupuesto.test(m)) {
    for (const [re, cat] of CATEGORY_ALIASES) {
      if (re.test(m)) {
        return { intencion: 'ver_presupuesto', datos: { categoria: cat } };
      }
    }
    return { intencion: 'ver_presupuesto', datos: {} };
  }
  if ((reCualGasto.test(m) || reCuanto.test(m)) && reMayor.test(m)) {
    return { intencion: 'ver_gasto_mayor', datos: {} };
  }
  if ((reCualGasto.test(m) || reCuanto.test(m)) && reMenor.test(m)) {
    return { intencion: 'ver_gasto_menor', datos: {} };
  }
  if (reCuanto.test(m) && reGasto.test(m) && (hoy || ayer)) {
    return { intencion: 'listar_gastos_dia', datos: {} };
  }
  if (reCuanto.test(m) && reGasto.test(m) && semana) {
    return { intencion: 'listar_gastos_semana', datos: {} };
  }
  if (reCuanto.test(m) && reGasto.test(m) && mesPalabra) {
    return { intencion: 'ver_total_gastado', datos: { periodo: 'mes' } };
  }
  // Filtro por categoría: "cuánto he gastado en comida", "cuánto llevo en taxi"
  if (reCuanto.test(m) && reGasto.test(m)) {
    for (const [re, cat] of CATEGORY_ALIASES) {
      if (re.test(m)) {
        return { intencion: 'ver_total_gastado', datos: { categoria: cat, periodo: 'mes' } };
      }
    }
  }
  return null;
}

// `deshacer_ultimo` es el ÚNICO borrado sin sujeto: no nombra qué eliminar, así que
// ejecuta sobre lo que haya. Eso lo vuelve el destino barato de cualquier frase que el
// clasificador no sepa dónde poner. Caso real (17-ago-2026): un usuario escribió
// "Quiero reiniciar" y recibió "Deshecho: Eliminé Sueldo — S/ 480.00". Nunca pidió borrar.
//
// La guarda NO vive en el prompt del tool a propósito. Ahí ya hay una lista blanca
// ('restablecer', 'restaurar', 'devolver' = restore, no undo) y es de la clase que sólo
// cubre lo que alguien ya vio fallar: "reiniciar" es primo hermano de "restablecer" y cayó
// del lado destructivo. Acá la condición es determinística y se puede matar por mutación,
// cosa que una instrucción en lenguaje natural a gpt-4o-mini no permite.
//
// Es un filtro de CONFIRMACIÓN, no de intención: si el mensaje no nombra la acción, se
// muestra qué se borraría y se pide la orden explícita. No hay estado entre mensajes
// (esa es la deuda que dejaron los pasos 30/31 del onboarding) — la segunda vuelta trae
// la palabra y pasa sola.
// `revier` va aparte de `revert`: el presente de "revertir" es "revierte", que NO comparte
// prefijo con el infinitivo. Lo encontró el test, no la lectura del patrón.
// `PIDE_BORRAR` vivía acá: la lista de señales de borrado (`deshac|borr|elimin|cancel|...`). Se
// retiró el 14-sep-2026 junto con `HABLA_DE_LA_CUENTA`, cuando la guarda pasó a comparar la
// orden ENTERA (`ORDEN_CANONICA`, abajo). Lo que enseñaron sigue valiendo y está escrito ahí.

// Y el reverso, que la primera versión no tenía y era el agujero más grave: PIDE_BORRAR
// acepta `elimin`, `borr` y `cancel`, así que **"quiero eliminar mi cuenta" la pasaba** y
// terminaba borrando el último gasto con un "Listo. Eliminé Sueldo S/480". El destino
// correcto de esa frase es `desconectar_cuenta` (handlers/intents/moderacion.js), y es la
// MISMA clase de misroute que produjo "Quiero reiniciar": la guarda verificaba que el
// mensaje nombrara *un* borrado, no que nombrara una TRANSACCIÓN. O sea que las frases más
// peligrosas eran justo las únicas que no filtraba. Lo encontró la segunda revisión
// adversarial, sobre el arreglo de la primera. (`HABLA_DE_LA_CUENTA`, que la cerraba, se retiró
// el 14-sep-2026: con la orden entera, "borra todos mis datos" ya no es una orden canónica.)

// Tercera puerta de la misma clase: "empecemos de cero, cancela todo" trae `cancel` y no
// nombra la cuenta, así que pasaba la guarda y borraba el último movimiento sin preguntar.
// Quien pide EMPEZAR DE NUEVO no pidió borrar UN gasto: se le muestra qué se borraría y se
// espera la orden explícita, igual que con "Quiero reiniciar".
// LA ORDEN ENTERA, no fragmentos (14-sep-2026, cuarta vuelta). Tres vueltas de lista negra
// ("reiniciar", "empecemos de cero, cancela todo", "borra todas mis transacciones", "volver a
// empezar", "borra lo que anoté", "borra todo menos el último"...) y una de lista blanca POR
// FRAGMENTOS no cerraron: la tercera revisión adversarial mostró que "esta mal el total" —sin
// tilde, como se escribe en WhatsApp— contaba "esta" como demostrativo y borraba, igual que
// "elimina esa categoría" o "borra el último año". Un fragmento aparece dentro de cualquier frase.
//
// Lo que sí se cierra es la frase COMPLETA: sin sujeto, solo se borra si el mensaje, sin tildes
// ni puntuación, ES una orden corta de borrar lo último ("borra el último", "bórralo", "elimina
// eso", "deshacer"), con a lo sumo cláusulas de una lista cerrada alrededor ("está mal,
// bórralo", "deshaz eso, me equivoqué"). Todo lo demás pide la confirmación, cuyo texto pide
// justamente "borra el último". Cuesta un mensaje a quien lo dice de otra forma; no le borra
// nada a quien no lo pidió. Y como se comparan sin tildes, "elimínalo" y "quítalo" cuentan.
const CLAUSULA_PREVIA = '(?:si|ok|ya|dale|listo|oe|todo bien|me equivoque|esta mal|estaba mal|no era(?: ese)?|lo (?:anote|puse) (?:de nuevo|dos veces|mal))';
const CLAUSULA_FINAL = '(?:porfa|porfis|por favor|pls|please|gracias|pe|me equivoque|esta mal|estaba mal|estaba todo mal|no era(?: ese)?)';
const OBJETO_ULTIMO = '(?:el ultimo(?: gasto| registro| movimiento)?|la ultima(?: transaccion| compra)?|lo ultimo|eso|esto'
  + '|ese(?: gasto| registro| movimiento)?|esa(?: transaccion| compra)?|este(?: gasto| registro)?'
  // "lo que anoté" a secas NO: puede ser todo lo anotado. Solo lo inequívocamente último.
  + '|lo anterior|el anterior|lo ultimo que (?:puse|anote)|lo que acabo de (?:poner|anotar))';
const ORDEN_BORRAR_ULTIMO = '(?:(?:borra|elimina|quita|anula|cancela|saca|deshaz|revierte) ' + OBJETO_ULTIMO
  + '|(?:borra|borren|elimina|quita|anula|cancela|saca|deshaz|deshace)(?:me)?(?:lo|la)'
  + '|deshacer(?: (?:el ultimo|lo ultimo|ultimo))?|deshaz|deshace|undo|revertir|revierte)';
const ORDEN_CANONICA = new RegExp('^(?:' + CLAUSULA_PREVIA + ' )*' + ORDEN_BORRAR_ULTIMO + '(?: ' + CLAUSULA_FINAL + ')*$');

function normalizarOrden(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * ¿El mensaje pide borrar UNA TRANSACCIÓN, la última? Desde el 14-sep-2026, solo si el mensaje
 * ENTERO es una orden canónica (`ORDEN_CANONICA`, arriba); cualquier otra frase pide la
 * confirmación. Ya no hay señales sueltas ni lista de lo que "no es un borrado".
 *
 * La lección de abajo es de la versión anterior y sigue valiendo para toda regex de este archivo.
 *
 * Gotcha que costó una vuelta: la primera versión de `HABLA_DE_LA_CUENTA` se escribió con
 * un script y los `\b` terminaron como el carácter BACKSPACE (0x08) en vez de la clase de
 * borde de palabra. La regex compilaba, no fallaba, y **no matcheaba nada** — o sea que la
 * guarda existía y era un no-op. Lo delató el test, no la lectura: `sed` muestra `\b` y
 * `JSON.stringify` también (porque `\b` ES el escape de backspace en JSON). Si alguna vez
 * un patrón acá "no matchea sin razón", mirá `re.source`, no el archivo.
 */
function pideBorrarUnGasto(msg) {
  return ORDEN_CANONICA.test(normalizarOrden(msg));
}

/**
 * Lo que responde la guarda cuando un borrado sin sujeto no es una orden canónica: PIDE la
 * orden, no dice que no entendió (15-sep-2026). Decía "No estoy seguro de qué quieres hacer" a
 * quien había escrito "no espera, bórralo", o sea que el clasificador acertaba y el texto
 * afirmaba lo contrario.
 *
 * La orden que se pide sigue siendo una frase fija y no un "sí", a propósito. Un "sí" suelto no
 * se puede atar a ESTE mensaje: el de la oferta de Manos Libres se retiró el 14-sep después de
 * dos revisiones que lo rompieron en direcciones opuestas (ver lib/cierre-dia-prueba.js), y acá
 * un "sí" equivocado borra plata. "borra el último" es canónica siempre, sin estado.
 */
function pedirOrdenDeBorrado(tx, formatFecha) {
  const monto = tx.moneda === 'USD' ? '$' + parseFloat(tx.monto).toFixed(2) : 'S/ ' + parseFloat(tx.monto).toFixed(2);
  return '¿Borro *' + (tx.comercio || 'tu último registro') + '* (' + monto + ')'
    + (tx.fecha ? ' del ' + formatFecha(tx.fecha) : '') + '?\n\n'
    + 'Para confirmarlo, escribe *"borra el último"*. Si era otro, dime el comercio o el monto.';
}

// Guarda la copia que hace posible el "restaura" y confirma que quedó escrita.
// postgrest NO lanza cuando el insert falla: devuelve el fallo en `error`. El patrón
// anterior (`.then(() => {}).catch(...)`) solo veía errores de red, así que un insert
// rechazado (RLS, constraint, payload inválido) pasaba por bueno, borrábamos la
// transacción igual y le prometíamos al usuario una restauración imposible.
async function guardarSnapshotEliminacion(supabase, usuarioId, tx, tag) {
  try {
    const { data, error } = await supabase.from('transacciones_eliminadas').insert({
      usuario_id: usuarioId,
      tx_id: tx.id,
      snapshot: { ...tx },
    }).select('id').single();
    if (error || !data) {
      log.warn({ tag, err: (error && error.message) || 'insert sin fila devuelta' }, 'No se pudo guardar snapshot');
      return null;
    }
    // Devuelve el ID y no un booleano: es lo que le permite a `descartarSnapshot` apuntar a ESTA
    // copia. Ver allá por qué reconstruir el WHERE no servía.
    return data.id;
  } catch (e) {
    log.warn({ tag, err: e.message }, 'No se pudo guardar snapshot');
    return null;
  }
}

// Contraparte de `guardarSnapshotEliminacion`: si el DELETE no entró, la copia sobra y además
// es peligrosa. `restaurar_eliminado` re-inserta toda copia pendiente sin preguntar si el
// original sigue vivo, así que un snapshot huérfano es una duplicación de plata esperando a que
// alguien escriba "restaura". Falla ruidosa pero NO cambia la respuesta al usuario: lo que a él
// le importa es que su gasto sigue ahí, y eso es lo que el mensaje ya le dice.
// **Borra por ID, y la primera versión no lo hacía.** Reconstruía el WHERE
// (`usuario_id + tx_id + restored_at is null`) y eso está mal por dos motivos que se midieron:
//
//  · `transacciones_eliminadas` no tiene unique sobre `tx_id` (migración 005), así que dos
//    borrados concurrentes del mismo gasto dejan DOS copias pendientes. Con el WHERE
//    reconstruido, la compensación de uno se llevaba también la copia del otro — que ya había
//    borrado la fila y ya le había prometido al usuario que podía restaurarla.
//  · Un DELETE destructivo sostenido por tres filtros que ningún test verifica es un comentario,
//    no una garantía: la revisión adversarial quitó los tres, de a uno, y la suite quedó verde
//    con los tres. Por ID el radio de daño es una fila y ES la fila que este mensaje escribió.
async function descartarSnapshot(supabase, snapshotId, tag) {
  try {
    const { error } = await supabase.from('transacciones_eliminadas').delete().eq('id', snapshotId);
    if (error) log.error({ tag, snapshotId, err: error.message }, 'Snapshot huérfano: el delete falló y la copia quedó restaurable');
  } catch (e) {
    log.error({ tag, snapshotId, err: e.message }, 'Snapshot huérfano: el delete falló y la copia quedó restaurable');
  }
}

// Cierre del mensaje de borrado. Solo ofrecemos restaurar si hay de dónde restaurar.
function avisoRestauracion(snapshotOk) {
  return snapshotOk
    ? '\n\n_Si fue un error, escribe "restaura" y lo devuelvo._'
    : '\n\n_Ojo: no pude guardar la copia de respaldo, así que este no lo voy a poder restaurar._';
}

const { resolverNombre, filasQueNombra, patronAmplio, listaNombres } = require('../../lib/resolver-nombre');

module.exports = {
  intents: ['registrar_manual', 'corregir_categoria', 'corregir_multiple', 'corregir_monto_moneda', 'eliminar_transaccion', 'editar_monto', 'editar_fecha', 'editar_comercio', 'editar_categoria_comercio', 'deshacer_ultimo', 'restaurar_eliminado', 'marcar_como_ingreso', 'dividir_gasto', 'duplicar_gasto'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, mesActual, anioActual,
      obtenerUltimaTransaccion, recategorizarTransaccion, guardarReglaComercio,
      retroaplicarRegla, corregirTransaccionEspecifica, guardarTransaccion,
      obtenerTipoCambio, convertirUsdAPen, tipoCambioDeLaFila, verificarAlertaPresupuesto,
      asegurarCategoriaUsuario, crearSubcategoriaLibreUsuario, detectarCategoriaIA,
      parsearRegistroManual, parsearCorreccionesMultiples,
      fechaHoyPeru, fechaAyerPeru, formatFecha
    } = ctx;

    // Una edición de un movimiento que ya existe necesita una ORDEN en el mensaje (chip 5,
    // 01-oct-2026): la forma entera, el valor nuevo escrito y el sujeto nombrado. Ver
    // lib/orden-edicion.js. Antes del switch y no en cada `case`: una sola puerta para las siete,
    // la lección del 17-ago con la puerta gemela del borrado.
    // `historialConv` decide si vale una corrección ELÍPTICA ("eran 30"): solo detrás de la
    // confirmación de un movimiento guardado (regla 3 de lib/orden-edicion.js).
    const revision = revisarEdicion(intencion, msg, datos, { historial: ctx.historialConv });
    if (!revision.ok) {
      log.info({ tag: 'EDICION_SIN_ORDEN', intencion, motivo: revision.motivo, campo: revision.campo, texto: String(msg || '').slice(0, 80) }, 'Edición sin orden en el mensaje: se pregunta, no se edita');
      return pedirOrden(intencion);
    }
    datos = revision.datos;

    switch (intencion) {

      case 'registrar_manual': {
        try {
          // Mensaje COMPUESTO (un gasto y una consulta juntos): acá se registra únicamente la
          // mitad de escritura, y la de lectura la resuelve la continuación multi-intent de
          // message-processor, que la manda por `dispatchIntent` y por lo tanto por el muro.
          // La regla del producto sale entera: se escribe gratis, se cobra leer.
          //
          // Sin esto, "Gasté 20 en Movilidad, cuánto llevo hoy" se perdía por completo:
          // `tienePatronGasto` saltea el pre-check, el parser devuelve ok:false (la banda
          // inestable de gpt-4o-mini, ver el rescate más abajo), y entonces el redirect de ahí
          // abajo lee el mensaje ENTERO como consulta y lo despacha. El gasto no se guarda en
          // ningún lado, y quien está en el muro recibe el paywall en su lugar.
          //
          // Va ANTES del parser y no dentro de la rama de fallo, aunque el bug se manifieste
          // ahí, por dos motivos que valen igual cuando el parser acierta:
          //  · los guards de fecha de más abajo miran `msg`, y "cuánto llevo *hoy*" les mete un
          //    marcador temporal que pertenece a la pregunta, no al gasto: con el mensaje
          //    entero, `_tieneFechaExplicita` da true y el TZ_GUARD deja pasar una fecha
          //    alucinada que sin la pregunta habría corregido.
          //  · `detectarCategoriaIA` y `descripcion_original` quedan sobre el texto del gasto
          //    solo, que es lo que de verdad describe la transacción.
          //
          // Se reasigna `msg` a propósito: de acá hasta el `return` de este case, el mensaje ES
          // la mitad de escritura. `message-processor` conserva el original en su propio scope,
          // que es el que necesita para resolver la mitad de lectura.
          {
            const { partirEscrituraLectura } = require('../../services/multi-intent-splitter');
            const mixto = partirEscrituraLectura(msg);
            if (mixto) {
              log.info({ tag: 'MSG_MIXTO', escritura: mixto.parte1.substring(0, 60), lectura: mixto.intencionLectura },
                'Mensaje mixto: se registra la escritura; la lectura la resuelve la continuación');
              // El log de arriba va a stdout de Railway y NO se puede consultar, así que sin
              // esto no habría forma de saber nunca si a alguien le pasa de verdad. Se midió
              // el 2026-08-18 que esta forma de mensaje tiene CERO ocurrencias en la historia
              // del producto (0 en 355 mensajes reales); el evento existe para poder rehacer
              // esa medición dentro de un mes sin volver a leer `conversaciones`, que se
              // auto-purga. `enMuro` es la dimensión que importa: es el subconjunto donde
              // perder el gasto significaba además recibir un pedido de plata en su lugar.
              // `analytics.capture` no lanza y es no-op sin POSTHOG_KEY.
              require('../../lib/analytics').capture(usuario.id, 'wa_mensaje_mixto', {
                lectura: mixto.intencionLectura,
                enMuro: estaEnMuro(usuario),
              });
              msg = mixto.parte1;
            }
          }

          // Pre-check: ¿el LLM clasificó como register pero el msg es claramente una query?
          // Bajo burst de gastos previos, gpt-4o-mini hereda contexto e inventa monto incluso
          // cuando el usuario pregunta "cuánto gasté hoy". Solo redirigimos si NO hay un patrón
          // literal de "verbo + monto + en/de/por + sustantivo" (eso seguiría siendo register).
          const tienePatronGasto = /(?:gast[eé]|gaste|pagu[eé]|compr[eé])\s+\d+(?:[.,]\d{1,2})?\s+(?:soles?\s+)?(?:en|de|por)\s+[a-záéíóúñü]/i.test(msg || '');
          if (!tienePatronGasto) {
            const redirectPre = detectarQuerySinMonto(msg);
            if (redirectPre) {
              try {
                // Vía `dispatchIntent`, no `getHandler`: los siete destinos de
                // `detectarQuerySinMonto` son intents de LECTURA y este redirect sale de
                // uno LIBRE, así que llamar al handler directo entregaba la lectura gratis
                // a quien está en el muro (M21). El gate vive adentro del dispatch.
                const { dispatchIntent } = require('../intent-registry');
                log.info({ tag: 'QUERY_REDIRECT', from: 'registrar_manual', to: redirectPre.intencion, msg: msg.substring(0, 80) }, 'Query disfrazada como register (pre-parser)');
                const dPre = await dispatchIntent({ intencion: redirectPre.intencion, msg, datos: redirectPre.datos, usuario, from, ctx });
                // Este redirect resolvió el mensaje ENTERO como query, así que la
                // continuación multi-intent no tiene que volver a resolver la parte 2:
                // sería el mismo handler dos veces. Ver message-processor.
                if (dPre.manejado) { ctx.redirigidoAQuery = true; return dPre.respuesta; }
              } catch(eRedirPre) { log.warn({ tag: 'QUERY_REDIRECT', err: eRedirPre.message }, 'Fallback redirect pre-parser falló'); }
            }
          }

          // Guard fecha futura: rechazar registros de gastos que aún no ocurrieron.
          // Conservador: requiere marcador temporal futuro Y verbo futuro/perífrasis.
          // Si solo aparece uno, dejamos pasar al parser (evita falsos positivos).
          {
            const _msgFutLower = (msg || '').toLowerCase();
            const _marcadorFuturo = /\bma[ñn]ana\b|\bpasado\s+ma[ñn]ana\b|\bla\s+pr[oó]xima\s+semana\b|\bel\s+pr[oó]ximo\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\bel\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+que\s+viene\b/i.test(_msgFutLower);
            const _verboFuturo = /\bvoy\s+a\s+(gastar|pagar|comprar|invertir|salir|comer|cenar|almorzar)\b|\bgastar[eé]\b|\bpagar[eé]\b|\bcomprar[eé]\b|\bpienso\s+(gastar|comprar|pagar)\b/i.test(_msgFutLower);
            if (_marcadorFuturo && _verboFuturo) {
              log.info({ tag: 'FUTURE_DATE_REJECT', msg: msg.substring(0, 80) }, 'Mensaje describe gasto futuro — no registrar');
              return 'No registro gastos futuros. Cuando ya hayas hecho el gasto, dime el monto y lo anoto. Si quieres, dime "recuérdame mañana" y te aviso.';
            }
          }

          const fechaHoy = fechaHoyPeru();
          // Las dos llamadas a gpt-4o-mini de este camino reciben SOLO `msg` y no dependen
          // entre sí: en serie eran dos round-trips al modelo, uno detrás del otro, sobre el
          // camino del gasto. Se disparan juntas y se cosecha `detCat` más abajo, donde el
          // código ya la esperaba.
          //
          // El `.catch` mudo NO consume el rechazo (awaitear la promesa después sigue
          // lanzando): solo evita un unhandledRejection en las rutas que salen antes de ese
          // await — el redirect a query cuando el parser no encuentra monto.
          //
          // NO se reemplaza `parsearRegistroManual` por el `datos` del tool call: ese prompt
          // lleva las reglas peruanas (lucas/cocos/mangos) y las de fecha que el maestro no tiene.
          // Se cancela en las salidas donde `detCat` ya no se va a leer: sin eso, el cliente
          // de OpenAI (maxRetries 3, timeout 60s) sigue reintentando durante minutos una
          // respuesta que nadie espera, y encima quemando presupuesto de rate-limit — el 429
          // es la causa documentada de `salvarGastoSinIA`.
          const abortoDetCat = new AbortController();
          const pDetCat = detectarCategoriaIA(msg, usuario.id, { signal: abortoDetCat.signal });
          pDetCat.catch(() => {});
          let parsed;
          try {
            parsed = await parsearRegistroManual(msg, fechaHoy);
          } catch (eParser) {
            abortoDetCat.abort();
            throw eParser;
          }
          // Neto anota soles y dólares, nada más. `guardarTransaccion` sólo convierte USD, así
          // que cualquier otra moneda se guardaba con `monto_pen = monto`: "20 euros" entraba
          // como S/20 en reportes, presupuesto y score. El esquema del parser deja que el modelo
          // diga EUR u 'otra' justamente para poder cortar con la verdad.
          //
          // Va ANTES de mirar la decisión, no después del rescate: con "20 euros" suelto el
          // modelo contesta `tipo_dudoso` con moneda EUR, y la pregunta de tipo decía "¿Esos S/20
          // entraron o salieron?"; quien obedecía escribiendo "gasté 20 en…" guardaba S/20 (lo
          // encontró la revisión adversarial). También cubre el fallback sub-1, que devuelve EUR
          // y GBP. El rescate determinístico se niega ante las monedas de
          // `MONEDAS_NO_SOPORTADAS` (lib/nlp-guards.js) pegadas a una cifra; una moneda que no
          // esté en esa lista ("20 libras", que también es peso) todavía pasaría como soles.
          if (parsed.moneda && parsed.moneda !== 'PEN' && parsed.moneda !== 'USD') {
            abortoDetCat.abort();
            log.info({ tag: 'MONEDA_NO_SOPORTADA', moneda: parsed.moneda, decision: parsed.decision || null, msg: (msg || '').substring(0, 80) }, 'Moneda distinta de PEN/USD: no se registra');
            return COPY_MONEDA_NO_SOPORTADA;
          }
          // Dos invariantes sobre lo que el modelo quiere REGISTRAR, en código y no en el prompt.
          // El 30-sep el prompt se ajustó tres veces y cada ajuste movió un error a otro mensaje
          // (un signo dado vuelta, un monto mal leído); estas dos no dependen de cómo quedó
          // redactado, y las dos fallan hacia el lado seguro.
          //  · el monto tiene que estar ESCRITO en el mensaje. Si no está ("s/.25 menú" leído
          //    como S/0.25), se rebota pidiendo el número. NO se le pasa al rescate: la tercera
          //    revisión adversarial midió que otro lector adivinando es peor ("me depositaron
          //    15mil soles" terminaba como gasto S/15, "50 céntimos" como S/50);
          //  · el tipo no puede contradecir el único sentido que nombra un verbo explícito
          //    ("me yapearon 50" como gasto). Si lo contradice, no se adivina: se pregunta.
          if (parsed.ok && parsed.monto > 0 && !montoEscritoEnMensaje(parsed.monto, msg)) {
            abortoDetCat.abort();
            log.warn({ tag: 'PARSER_MONTO_NO_ESCRITO', monto: parsed.monto, msg: (msg || '').substring(0, 80) }, 'El monto del parser no está en el mensaje: se pide el número');
            return COPY_SIN_MONTO;
          }
          if (parsed.ok && tipoContradiceElMensaje(parsed.tipo, msg)) {
            abortoDetCat.abort();
            log.warn({ tag: 'PARSER_TIPO_CONTRADICE', tipo: parsed.tipo, msg: (msg || '').substring(0, 80) }, 'El tipo del parser contradice el verbo del mensaje: se pregunta');
            return preguntaTipoDudoso({ monto_dudoso: parsed.monto, moneda: parsed.moneda });
          }
          if (!parsed.ok || !parsed.monto || parsed.monto <= 0) {
            // OJO con `abortoDetCat`: hasta acá se cancelaba al ENTRAR a esta rama, porque
            // las dos salidas que había (redirect a query, rebote) no leen `detCat`. Ahora
            // hay una tercera que SÍ sigue al camino normal, así que la cancelación bajó a
            // estar pegada a cada `return`.
            //
            // Lo que se pierde cancelando arriba es la CATEGORÍA, no el gasto:
            // `detectarCategoriaIA` (services/categories.js) envuelve la llamada al modelo en
            // un try cuyo catch devuelve `{categoria:null}`, y el `AbortError` cae ahí
            // adentro, así que `pDetCat` NO rechaza por el abort. El rescate seguiría, pero
            // toda fila rescatada quedaría en 'Otros' aunque el clasificador supiera la
            // categoría.
            //
            // (Una versión anterior de este comentario decía que el gasto se perdía por el
            // catch genérico. Era falso, y el test que lo "probaba" mockeaba un rechazo que
            // la función real no produce. Lo encontró la revisión adversarial del arreglo.)
            const redirect = detectarQuerySinMonto(msg);
            if (redirect) {
              try {
                // Mismo motivo que el redirect pre-parser: el destino es LECTURA y el
                // origen LIBRE, así que el gate tiene que correr en el dispatch (M21).
                const { dispatchIntent } = require('../intent-registry');
                log.info({ tag: 'QUERY_REDIRECT', from: 'registrar_manual', to: redirect.intencion, msg: msg.substring(0, 80) }, 'Query disfrazada como register (post-parser-fail)');
                const dRedir = await dispatchIntent({ intencion: redirect.intencion, msg, datos: redirect.datos, usuario, from, ctx });
                if (dRedir.manejado) { abortoDetCat.abort(); ctx.redirigidoAQuery = true; return dRedir.respuesta; }
              } catch(eRedir) { log.warn({ tag: 'QUERY_REDIRECT', err: eRedir.message }, 'Fallback redirect falló'); }
            }

            // El parser dice POR QUÉ no registra (ver `DECISIONES_REGISTRO` en
            // services/parsers.js), y con dos de sus respuestas el rescate de abajo NO corre:
            // el modelo vio el monto y decidió bien no registrarlo. Hasta el 30-sep-2026 todo
            // rechazo se trataba como "no pude leer", y el rescate registraba como gasto
            // "Neto es 15800", un cupo de tarjeta y "preste 118".
            //
            // Se compara contra los valores EXPLÍCITOS: un parser que no devuelva `decision`
            // (el contrato viejo, o un mock) sigue por el camino de siempre.
            //
            // Los copys son fijos y no guardan estado. Nada de "¿lo anoto? responde sí": ese
            // "sí" con estado se retiró dos veces (ver la memoria del borrado); la persona
            // reescribe el mensaje con el verbo y entra por el camino normal.
            if (parsed.decision === 'tipo_dudoso') {
              abortoDetCat.abort();
              log.info({ tag: 'PARSER_DECISION', decision: 'tipo_dudoso', msg: (msg || '').substring(0, 80) }, 'Monto sin sentido: se pregunta en vez de adivinar el tipo');
              return preguntaTipoDudoso(parsed);
            }
            if (parsed.decision === 'no_es_movimiento') {
              abortoDetCat.abort();
              log.info({ tag: 'PARSER_DECISION', decision: 'no_es_movimiento', msg: (msg || '').substring(0, 80) }, 'No es un movimiento: no se registra ni se rescata');
              return COPY_NO_ES_MOVIMIENTO;
            }

            // Rescate determinístico. `parsearRegistroManual` le pregunta a gpt-4o-mini, y
            // medido el 2026-08-18 el modelo devuelve `{ok:false}` sobre mensajes donde el
            // monto está escrito en dígitos: "Gasté X en Movilidad" falla con 0.5 y con 20,
            // mientras "gasté X en taxi" entra con los dos. No es el monto, ni las mayúsculas,
            // ni la tilde, ni que el sustantivo sea categoría o comercio — se probaron las
            // cuatro. Es que a `temperature: 0` el modelo sigue siendo inestable en una banda
            // angosta de mensajes, y qué cae adentro no se deriva de ninguna regla: en una
            // batería de 24 sustantivos, 21 entraron 3/3, "Movilidad" 0/3 y "Snack" 2/3, y
            // "movilidad" dio 4/4 y 1/3 en dos corridas de la misma cadena.
            //
            // Por eso el arreglo NO es enseñarle al prompt (no hay familia que enseñar, y un
            // cambio de prompt no se puede matar por mutación) ni alargar un regex hasta que
            // pasen los casos conocidos. Es preguntarle a un extractor DETERMINÍSTICO si en
            // el texto hay un monto que el modelo descartó.
            //
            // (30-sep-2026: la premisa de "no hay familia" resultó falsa. La forma corta sin
            // verbo, "Almuerzo 10", rebotaba 4 de 4, y el prompt ahora la define. El rescate
            // queda para lo que el modelo sigue sin leer, y SÓLO cuando dijo `sin_monto`: con
            // `tipo_dudoso` y `no_es_movimiento` ya se salió arriba.)
            //
            // `extraerGastoSinIA` no es código nuevo: es el mismo rescate que ya corre en el
            // camino del 429, ya probado y ya en producción. Acá corre en una posición MÁS
            // segura que allá — allá no hay clasificador y tiene que bastarse solo; acá el
            // clasificador ya dijo `registrar_manual` y el redirect a query ya no lo quiso.
            //
            // Riesgo medido sobre `tests/nlp/pool.js` (510 casos reales): el extractor
            // responde en 20 mensajes cuyo intent NO es registro, y eso es la COTA. En esta
            // posición el rescate exige además que el clasificador haya mandado el mensaje
            // acá: los 20 se van a `eliminar_transaccion` / `editar_monto` / `abonar_deuda`,
            // o sea 0 llegan. Lo mide `qa-e2e/probe-parser-montos-rescate.mjs`.
            //
            // Se llena `parsed` y se sigue por el camino normal a propósito, en vez de
            // guardar acá: así el rescate hereda la categorización, el árbol de categorías,
            // los guards de fecha, `guardarTransaccion` (dueño de la validación, del USD→PEN
            // y del dedup), la alerta de presupuesto y la cola del trial. Un `guardarTransaccion`
            // propio en esta rama sería la lógica de plata paralela que este repo no quiere.
            // Con DOS O MÁS montos candidatos tampoco se rescata, y ésta es la guarda que
            // más daño evita. `detectarMultiGasto` exige verbo + preposición, así que
            // "15 taxi 40 cena" no le dispara y cae acá; el extractor entra por la rama del
            // número suelto, se queda con el PRIMER monto y mete el resto adentro del nombre
            // del comercio: se guardaba S/15 con comercio "taxi 40 cena" y la persona veía un
            // ✅ creyendo que entraron los dos. Es la misma falla que el docblock de
            // `primerMonto` declara inaceptable, entrando por otra puerta.
            //
            // Con más de un número no se puede saber cuál es el monto, y adivinar sobre plata
            // ajena no es una opción: rebota, y el copy nuevo dice justamente "va uno por
            // mensaje". Medido sobre `tests/nlp/pool.js`: cuesta CERO rescates legítimos
            // (68 antes, 68 después) y elimina 4 falsos positivos más.
            //
            // Y NO se rescata si `detectarQuerySinMonto` reconoció una consulta, aunque el
            // dispatch de arriba haya fallado. El `catch` de ese try es para un fallo
            // TRANSITORIO (el handler de lectura reventó), no para reinterpretar el mensaje:
            // si se cae ahí, lo que corresponde es no responder nada útil, no registrarle un
            // gasto a quien preguntó algo. Sin esta condición, un timeout convertía
            // "gasté 20 en movilidad, cuánto llevo hoy" en una transacción — apareció como un
            // test que tardó 28s y falló, o sea el escenario de red exacto.
            const rescate = (redirect || esSoloUnNumero(msg) || contarMontosCandidatos(msg) > 1)
              ? null : extraerGastoSinIA(msg);
            if (!rescate) {
              abortoDetCat.abort();
              // El texto viejo decía 'Dime algo como: "gasté S/50 en farmacia"' — o sea le
              // pedía a la persona exactamente lo que acababa de escribir. Con el rescate
              // puesto, lo que queda rebotando son otras dos cosas, y el copy nombra esas:
              // el monto dictado en palabras ("ciento diez punto setenta") y varios gastos
              // en un solo mensaje.
              //
              // El ejemplo tiene que ser una forma que el parser ACEPTE: hasta el 30-sep
              // enseñaba "110.70 carne", que el parser también rechazaba, así que quien
              // obedecía el rebote recibía el mismo rebote. Los dos ejemplos de hoy los mide
              // la batería `copy` de `qa-e2e/probe-parser-decision.mjs`.
              // Si no hubo rescate porque el monto venía en otra moneda, se dice eso: "no pude
              // leer el monto" sería falso y la persona reescribiría lo mismo.
              return mencionaMonedaNoSoportada(msg) ? COPY_MONEDA_NO_SOPORTADA : COPY_SIN_MONTO;
            }
            // El rescate también pasa por el invariante de sentido: su tipo sale de una lista de
            // verbos más corta que la del invariante ("me depositaron" no está), y sin esto
            // "me depositaron 1200 soles" se guardaba como GASTO (tercera revisión).
            if (tipoContradiceElMensaje(rescate.tipo, msg)) {
              abortoDetCat.abort();
              log.warn({ tag: 'RESCATE_TIPO_CONTRADICE', tipo: rescate.tipo, msg: (msg || '').substring(0, 80) }, 'El tipo del rescate contradice el verbo del mensaje: se pregunta');
              return preguntaTipoDudoso({ monto_dudoso: rescate.monto, moneda: rescate.moneda });
            }
            log.info({ tag: 'RESCATE_MONTO', monto: rescate.monto, tipo: rescate.tipo, msg: (msg || '').substring(0, 80) }, 'El parser no devolvió monto; rescate determinístico lo reconstruyó');
            parsed = {
              ok: true,
              monto: rescate.monto,
              moneda: rescate.moneda,
              tipo: rescate.tipo,
              comercio: rescate.comercio || 'Sin comercio',
              // Categoría de arranque: `detectarCategoriaIA` la pisa unas líneas más abajo
              // si tiene algo mejor. Los mismos defaults que usa `salvarGastoSinIA`.
              categoria: rescate.tipo === 'ingreso' ? 'Finanzas' : 'Otros',
              subcategoria: 'sin_categoria',
              // Hoy, y NO la fecha del modelo: acá no hay salida del modelo. Los guards de
              // fecha de abajo corrigen sobre esto si el mensaje dice "ayer" o un weekday.
              fecha: fechaHoy,
              // `parsearRegistroManual` NO devuelve este campo (no está en su schema), así
              // que hasta ahora toda fila de `registrar_manual` lo tenía en null y las
              // rescatadas son las primeras que lo llevan. Arrastra dos efectos, los dos
              // conocidos y aceptados: `guardarTransaccion` le corre `extraerLast4` (puede
              // poblar `tarjeta_last4` y afinar el dedup), y `eliminar_transaccion` upsertea
              // en `gmail_excluidos` toda fila con este campo. Se conserva igual porque es el
              // mismo contrato que ya tiene `salvarGastoSinIA` —el otro rescate, el del 429—
              // y que el import de Excel; hacerlo distinto acá partiría en dos el registro de
              // "qué escribió realmente la persona", que es lo único que permite diagnosticar
              // esta clase de bug.
              descripcion_original: (msg || '').trim().substring(0, 200),
            };
          }
          // Guard weekday: el clasificador a veces devuelve fecha cuyo día de la semana no
          // coincide con "el <weekday> pasado". Validador puro post-OpenAI, cero prompt.
          {
            const { resolverDiaSemanaPasado } = require('../../lib/dates');
            const _fechaCorregida = resolverDiaSemanaPasado(msg, parsed.fecha, fechaHoy);
            if (_fechaCorregida) {
              log.info({ tag: 'WEEKDAY_GUARD', fechaModelo: parsed.fecha, fechaCorregida: _fechaCorregida, msg: (msg || '').substring(0, 80) }, 'Ajuste post-OpenAI: weekday del msg no coincide con fecha del parser');
              parsed.fecha = _fechaCorregida;
            }
          }
          // Guard fechas relativas (ayer/anteayer/hace N días): mismo patrón que tmp-004.
          {
            const { resolverFechaRelativa } = require('../../lib/dates');
            const _fechaRel = resolverFechaRelativa(msg, parsed.fecha, fechaHoy);
            if (_fechaRel) {
              log.info({ tag: 'RELATIVE_DATE_GUARD', fechaModelo: parsed.fecha, fechaCorregida: _fechaRel, msg: (msg || '').substring(0, 80) }, 'Ajuste post-OpenAI: marcador relativo del msg no coincide con fecha del parser');
              parsed.fecha = _fechaRel;
            }
          }
          // Guard timezone: el modelo a veces aluciona una fecha pasada aunque el usuario no la mencione.
          // Solo respetamos parsed.fecha si el mensaje contiene una referencia explícita de fecha.
          const _msgL = (msg || '').toLowerCase();
          const _tieneFechaExplicita = /\bayer\b|\bantier\b|\banteayer\b|\bhoy\b|\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\bla\s+semana\s+pasada\b|hace\s+\d+\s*(d[ií]a|hora|semana|mes)|\bel\s+\d{1,2}(\s+de\s+\w+)?\b|\b\d{1,2}\s*\/\s*\d{1,2}\b|\b\d{1,2}-\d{1,2}\b/i.test(_msgL);
          if (parsed.fecha && parsed.fecha !== fechaHoy && !_tieneFechaExplicita) {
            log.warn({ tag: 'TZ_GUARD_REGISTRO', fechaModelo: parsed.fecha, fechaHoy, msg: (msg || '').substring(0, 80) }, 'Modelo extrajo fecha pasada sin mencion del usuario — forzando hoy');
            parsed.fecha = fechaHoy;
          }
          // Re-clasificar con categorías y subcategorías custom del usuario
          // (disparada arriba, en paralelo con el parser).
          const detCat = await pDetCat;
          if (detCat.categoria) {
            parsed.categoria = detCat.categoria;
            if (detCat.subcategoria) parsed.subcategoria = detCat.subcategoria;
          }
          // Override por keywords fuertes para mensajes largos (prosa) cuando el LLM
          // clasificó como sin_categoria. Conservador: msg.length > 150 + keyword inequívoco.
          if (msg && msg.length > 150 && (!parsed.categoria || esSubSinClasificar(parsed.categoria))) {
            const { categorizarPorKeywords } = require('../../services/categorizer-keywords');
            const _catKw = categorizarPorKeywords(msg);
            if (_catKw) {
              log.info({ tag: 'CATEGORY_KW_OVERRIDE', from: parsed.categoria || null, to: _catKw, msgLen: msg.length }, 'Override post-LLM por keywords fuertes en mensaje largo');
              parsed.categoria = _catKw;
            }
          }
          // Que la categoría exista en el árbol del usuario: libre si es nueva, canónica si le
          // falta y ya tiene árbol propio. El guard de canonicidad vive adentro (B26).
          //
          // Las dos van ENCADENADAS, no en paralelo, y no es estilo: `crearSubcategoriaLibreUsuario`
          // crea la raíz por su cuenta cuando no encuentra al padre, así que lanzadas a la vez las
          // dos insertan la misma categoría y queda DUPLICADA. Lo encontró `qa-categoria-encierro`
          // contra prod (salieron dos "Transporte"), no la suite.
          //
          // Sigue siendo fire-and-forget —sin `await` acá— para no devolverle al camino del gasto
          // los round-trips que le sacó la Ola 3: lo que se ordena es una respecto de la otra.
          if (parsed.categoria) {
            const _sub = subcategoriaUtil(parsed.subcategoria);
            asegurarCategoriaUsuario(usuario.id, parsed.categoria)
              .then(() => (_sub ? crearSubcategoriaLibreUsuario(usuario.id, parsed.categoria, _sub) : null))
              .catch(() => {});
          }
          const tx = await guardarTransaccion(usuario.id, parsed);
          // La fila `usuario` que viaja por el pipeline es de ANTES de este gasto, así que si
          // el gasto acaba de arrancar el trial, sigue diciendo plan='free' y para
          // `estaEnMuro` esta persona está amurallada cuando en realidad acaba de recibir 14
          // días de Pro. Eso no importaba mientras nadie más mirara esa fila después, pero la
          // continuación multi-intent SÍ la mira: sin esta señal, un mensaje mixto de alguien
          // nuevo respondía "🎁 Acabas de estrenar Neto Pro" e inmediatamente debajo
          // "🔒 necesitas Neto Pro", contradiciéndose en su primera interacción.
          // Se avisa por `ctx` en vez de mutar `usuario` acá para que la sincronización ocurra
          // en un solo lugar (message-processor), pegada a quien la necesita.
          if (tx && tx.trialIniciado) ctx.trialRecienIniciado = { vence: tx.trialVence || null };
          const esIngreso = parsed.tipo === 'ingreso';
          const montoStr = parsed.moneda === 'USD' ? '$' + parseFloat(parsed.monto).toFixed(2) : 'S/' + parseFloat(parsed.monto).toFixed(2);
          // Mostrar la categoría/subcategoría YA persistidas (normalizadas por guardarTransaccion),
          // no la salida cruda del parser, para que el mensaje coincida con la fila guardada.
          const catConf = (tx && tx.categoria) || parsed.categoria || 'Otros';
          // `tx.subcategoria` viene de la DB, o sea DESPUÉS del trigger que capitaliza: el
          // centinela vuelve como 'Sin_categoria' y una comparación literal no lo ve. Sin
          // `subcategoriaUtil` esta línea decía: ✅ S/20 en Otros > Sin_categoria.
          const subConf = subcategoriaUtil((tx && tx.subcategoria) || parsed.subcategoria);
          const destinoConf = subConf ? catConf + ' > ' + subConf : catConf;
          let respReg = '✅ ' + montoStr + ' en ' + (esIngreso ? 'Ingresos' : destinoConf) + ' · ' + formatFecha(parsed.fecha);
          if (!esIngreso && parsed.categoria) {
            const alerta = await verificarAlertaPresupuesto(usuario, parsed.categoria, parsed.subcategoria || null);
            if (alerta) respReg += '\n\n' + alerta;
          }
          // El conteo ya lo trae la fila (guardarTransaccion lo calcula para su
          // propio evento de primera-tx); no hace falta una segunda query.
          const txCount = tx && tx.conteoTx;
          // Cola de la confirmación: estreno del trial, muro, o el empujón a activar la
          // cuenta — la señal que más pesa en supervivencia (0 de 18 llegan al día 31
          // sin webapp). Las tres son excluyentes y las decide lib/trial.
          const nudge = await colaConfirmacionGasto(usuario, tx, txCount);
          if (nudge) respReg += nudge;
          else if (txCount && txCount % 5 === 0) {
            respReg += '\n\n💡 _Revisa tus gráficos en https://app.neto.pe_';
          }
          return respReg;
        } catch(e) {
          log.error({ tag: 'REGISTRAR_MANUAL', err: e.message }, 'Error registro manual');
          // **Deja fila en `errores`, y no es diagnóstico de más: es la única forma de contar
          // a cuánta gente le pasa.** Este `catch` es donde muere un gasto sin que nadie se
          // entere: el usuario recibe "No pude procesar eso" y la fila no entra. Hasta el
          // 07-sep-2026 solo había un `log.error` a stdout, o sea que la pregunta "¿esto le
          // pasa a un usuario al mes o a quince?" no tenía respuesta posible, y esa cifra es
          // justo la que decide el tamaño del arreglo del ítem 31 del backlog.
          //
          // El caso medido que lo motivó: con varios gastos en un mensaje el modelo devuelve
          // N objetos JSON separados por comas y `JSON.parse` lanza
          // (`SyntaxError: Unexpected non-whitespace character after JSON`). El modelo había
          // extraído los cinco gastos BIEN y se tiran los cinco. Ya le pasó a un usuario real
          // (hallazgo B27, citado en `services/multi-gasto-detector.js`), que recibió el mismo
          // mensaje dos veces y se rindió.
          //
          // `detalle` lleva el texto que la persona escribió, que es lo que hace la fila
          // accionable: sin él se sabe cuántas veces pasó y no QUÉ formas lo disparan. No
          // agrega exposición de datos — ese mismo texto ya está en `conversaciones`. Mismo
          // criterio que la fila de "mensaje entrante sin from" en `handlers/webhook.js`.
          //
          // El `mensaje` es FIJO a propósito: `registrarError` agrupa sus patrones por
          // `tag:mensaje`, así que meter ahí el error variable partiría el conteo en tantas
          // claves como variantes y el umbral de 5-en-una-hora no se alcanzaría nunca. La
          // causa concreta va en `stack`, que es donde se separa el `SyntaxError` del JSON de
          // cualquier otro fallo.
          //
          // **Los usuarios de prueba quedan fuera, y no es higiene: es que si no, el número
          // que esto viene a medir queda inservible.** El qa-agent manda por este mismo
          // webhook y sus escenarios de varios gastos caen justo en este `catch`, así que
          // cada corrida quincenal inflaría el conteo. Peor: `registrarError` alerta al admin
          // con 5 fallos iguales en una hora, y una corrida del agente llega sola a ese
          // umbral — o sea una "ALERTA CRITICA" por WhatsApp que no es de nadie real. La
          // tabla `errores` ya arrastra esa contaminación de otro camino (ver la sección del
          // BSUID en `app/CLAUDE.md`, donde hubo que separar las filas por prefijo después
          // del hecho); acá se evita desde el principio.
          //
          // Falla del lado de REGISTRAR: si un `select` acotado no trajera `is_test_user`,
          // esto queda `undefined`, la fila entra igual y a lo sumo hay que filtrarla después.
          // Al revés se perdería la medición sin que nadie se entere.
          //
          // Cómo se lee:
          //   select created_at, detalle, left(stack, 120)
          //   from errores where tag = 'REGISTRAR_MANUAL' order by created_at desc;
          if (!(usuario && usuario.is_test_user === true)) {
            registrarError('REGISTRAR_MANUAL', 'No se pudo registrar el gasto', {
              detalle: (msg || '').substring(0, 300),
              usuarioId: usuario && usuario.id ? usuario.id : null,
              stack: e && e.stack ? e.stack : String(e),
            });
          }
          return 'No pude procesar eso. Dime: "gasté S/50 en farmacia ayer" y lo anoto.';
        }
      }

      case 'corregir_categoria': {
        try {
          const catRaw = datos.categoria_nueva || datos.categoria || null;
          const _subRawTmp = datos.subcategoria_nueva || datos.subcategoria || null;
          const subRaw = (_subRawTmp && /^null$/i.test(String(_subRawTmp).trim())) ? null : _subRawTmp;
          const comercioRaw = datos.comercio || null;
          if (catRaw) {
            // B30: se resuelve UNA vez, acá arriba, y de acá sale todo lo demás — la fila que
            // se recategoriza, el árbol, la regla, la retroaplicación y el texto que lee el
            // usuario. `guardarReglaComercio` resuelve por su cuenta (es el chokepoint de la
            // tabla), pero si acá se dejara el nombre crudo, la regla guardaría el nombre
            // efectivo mientras `retroaplicarRegla` escribe el crudo en las filas viejas:
            // el pasado y el futuro del MISMO comercio partidos en dos categorías.
            // `resolverCategoriaPersistida` es pura y síncrona (no consulta el árbol).
            //
            // El `.trim()` no es de adorno: `normalizarDestinoRegla` recorta la categoría de la
            // REGLA y nada recortaba la que va a `transacciones`, así que con "Ahorro " la fila
            // quedaba con el espacio y la regla sin él. Son dos categorías distintas para todo
            // lo que agrupe por nombre, y hay cuatro nombres con espacio final en prod.
            const { resolverCategoriaPersistida } = require('../../services/categories');
            const _catRawT = catRaw.trim();
            const catLibre = resolverCategoriaPersistida(_catRawT.charAt(0).toUpperCase() + _catRawT.slice(1));
            const subLibre = subRaw ? subRaw.trim().charAt(0).toUpperCase() + subRaw.trim().slice(1) : null;
            let txActualizada = null;
            if (comercioRaw) {
              const res = await recategorizarTransaccion(usuario.id, comercioRaw, catLibre, subLibre);
              if (res.ok) txActualizada = res.tx || { comercio: comercioRaw, monto: null, moneda: 'PEN' };
              if (!res.ok) return res.msg;
            } else {
              txActualizada = await obtenerUltimaTransaccion(usuario.id);
              if (txActualizada) {
                const updFields = { categoria: catLibre };
                if (subLibre) updFields.subcategoria = subLibre;
                // **`.select('id')` no es simetria con el DELETE: es la otra causa.** postgrest no
                // devuelve `error` cuando el UPDATE no matchea ninguna fila, asi que "la escritura
                // fallo" y "la escritura no toco nada" llegan aca con la MISMA forma
                // (`error: null`) y producian la misma confirmacion falsa. 9A solo cerro la
                // primera. Pasa de verdad: `obtenerUltimaTransaccion` leyo la fila y el borrado
                // llego entre esa lectura y este update.
                const { data: filasMovidas, error: errMoverCat } = await supabase.from('transacciones').update(updFields).eq('id', txActualizada.id).select('id');
                // Se corta ACÁ y no después: la regla y la retroaplicación son la consecuencia de
                // este cambio. Guardarlas sobre una fila que no se movió parte el pasado y el
                // futuro del mismo comercio en dos categorías —el split que B30 vino a cerrar— y
                // encima el mensaje afirma "Apliqué el cambio a todos los pagos anteriores".
                if (errMoverCat) {
                  log.error({ tag: 'CORREGIR', err: errMoverCat.message, txId: txActualizada.id }, 'No se pudo mover el gasto de categoría');
                  return 'No pude mover ese gasto ahora mismo. Vuelve a intentarlo en un momento.';
                }
                // Corta en el MISMO punto que la rama de error —la regla y la retroaplicacion son
                // la consecuencia de un cambio que no ocurrio— pero el texto es OTRO: pedirle
                // "vuelve a intentarlo" sobre una fila que ya no existe lo manda a repetir algo
                // que no va a funcionar nunca.
                if (!filasMovidas || filasMovidas.length === 0) {
                  log.warn({ tag: 'CORREGIR', txId: txActualizada.id }, 'El update de categoría no afectó ninguna fila');
                  return 'Ese gasto ya no está. Puede que lo hayas eliminado hace un momento.';
                }
              } else {
                return '\u00bfDe qu\u00e9 gasto hablamos? D\u00edme el comercio y lo muevo.';
              }
            }
            // Que la categoría exista en el árbol del usuario (libre o canónica faltante).
            // ENCADENADAS, por el mismo motivo que en `registrar_manual`: en paralelo las dos
            // insertan la misma raíz y queda duplicada.
            {
              const _sub = subcategoriaUtil(subLibre);
              asegurarCategoriaUsuario(usuario.id, catLibre)
                .then(() => (_sub ? crearSubcategoriaLibreUsuario(usuario.id, catLibre, _sub) : null))
                .catch(() => {});
            }
            // Guardar regla y retroaplicar usando el comercio REAL de la DB (no el del usuario, que puede tener typos)
            // Un gasto sin nombre ('' o "Sin comercio") no tiene "pagos anteriores del mismo
            // comercio": la regla agarraría todos sus gastos sin nombre, y la respuesta afirmaba
            // haberlo aplicado (revisión adversarial del 01-oct). Se mueve sólo este gasto.
            const comercioReal = txActualizada?.comercio || comercioRaw;
            const conRegla = !!comercioReal && !esComercioCentinela(comercioReal);
            // La regla hacia ADELANTE se guarda siempre: es como Neto aprende, y la corrige la próxima
            // corrección. Reescribir el PASADO solo si el mensaje lo pide (02-oct-2026, decisión de
            // Favio): "Cambiar Plin de ricardo como taxi" movió ese pago y además todos los anteriores
            // a Ricardo, y `retroaplicarRegla` va por subcadena ("Uber" alcanza "Uber Eats"). Una
            // escritura más ancha que el pedido es la clase de lib/datos-dichos.js.
            const retroPedida = conRegla && pideAlcanceRetroactivo(msg);
            if (conRegla) {
              guardarReglaComercio(usuario.id, comercioReal, catLibre, subLibre);
              if (retroPedida) retroaplicarRegla(usuario.id, comercioReal, catLibre, subLibre);
            }
            // Respuesta con moneda correcta
            const monedaTxCorr = txActualizada.moneda || 'PEN';
            const montoMostrar = monedaTxCorr === 'USD'
              ? '$' + parseFloat(txActualizada.monto || 0).toFixed(2) + (txActualizada.monto_pen ? ' (~S/' + parseFloat(txActualizada.monto_pen).toFixed(2) + ')' : '')
              : 'S/ ' + parseFloat(txActualizada.monto_pen || txActualizada.monto || 0).toFixed(2);
            const nombreMovido = txActualizada.comercio && !esComercioCentinela(txActualizada.comercio) ? txActualizada.comercio : 'el gasto';
            return 'Listo! Movi *' + nombreMovido + '* (' + montoMostrar + ') a *' + catLibre + (subLibre ? ' > ' + subLibre : '') + '*.'
              + (retroPedida ? '\n\n_Aplique el cambio a todos los pagos anteriores de ' + comercioReal + '._'
                : conRegla ? '\n\n_Los próximos de ' + comercioReal + ' van a ' + catLibre + '. Si quieres mover también los anteriores, escríbeme "siempre pon ' + comercioReal + ' en ' + catLibre + '"._'
                : '');
          }
          // Con IA respondia "Listo" (no hizo nada) y afirmaba que el gasto no estaba
          // categorizado, dato que nunca estuvo en el contexto. Texto fijo con el ultimo gasto.
          const ultimaTx2 = await obtenerUltimaTransaccion(usuario.id);
          return ultimaTx2
            ? '\u00bfA qu\u00e9 categor\u00eda muevo *' + (ultimaTx2.comercio || 'ese gasto') + '* (' + (ultimaTx2.moneda === 'USD' ? '$' + parseFloat(ultimaTx2.monto || 0).toFixed(2) : 'S/ ' + parseFloat(ultimaTx2.monto_pen || ultimaTx2.monto || 0).toFixed(2)) + ')? Dime y lo cambio.'
            : '\u00bfA qu\u00e9 categor\u00eda lo muevo? Dime y lo cambio.';
        } catch(e) {
          log.error({ tag: 'CORREGIR', err: e.message }, 'Error corrigiendo categoría');
          return 'No pude procesar eso. Usa: /cambiar [comercio] [categoria]';
        }
      }
      case 'corregir_multiple': {
        try {
          const correcciones = await parsearCorreccionesMultiples(msg);
          if (!correcciones || correcciones.length === 0) {
            const { WEBAPP_URL } = require('../../lib/constants');
            return '💡 No pude procesar eso directamente. Para cambios múltiples te recomiendo usar el dashboard:\n\n'
              + '👉 ' + WEBAPP_URL + '/dashboard/transacciones\n\n'
              + 'Ahí puedes filtrar y editar varios gastos de una vez.\n'
              + '_O dime uno por uno y lo hago por acá._';
          }
          // Cada corrección es UN gasto, y ninguno se escribe dos veces en el mismo mensaje. Hasta el
          // 02-oct cada una guardaba además la regla comercio → categoría y la retroaplicaba a TODO el
          // comercio: "el taxi de 8.50 era salud" (fue a la clínica) movía todos los taxis, y los
          // futuros, mientras la línea decía uno. Tres revisiones adversariales seguidas encontraron
          // la misma clase —la línea afirma algo que la tabla no refleja— por la retroaplicación, por
          // el orden entre correcciones y por un fallo mudo de la retroaplicación, así que se sacó la
          // retroaplicación en vez de seguir parchándola. La regla por comercio tiene su acción
          // (`set_category_rule`: "todo lo de Rappi va en Delivery"). Esta rama tuvo 0 respuestas
          // en producción entre marzo y el 02-oct: el clasificador manda estas frases a
          // `corregir_categoria` (backlog, ítem 45).
          //
          // Antes de escribir nada se descarta lo que el LLM no mandó como texto: un `comercio: 7`
          // corregía un gasto y después hacía lanzar a la regla.
          const { leerPedidoCorreccion } = require('../../services/transactions');
          const esValida = (c) => c && typeof c.comercio === 'string' && c.comercio.trim()
            && typeof c.categoria_nueva === 'string' && c.categoria_nueva.trim();
          // El nombre más largo primero: cada corrección reclama UNA fila y la búsqueda es por
          // substring, así que "el uber de 15" iba antes y se llevaba el Uber Eats de 15 que la
          // corrección siguiente nombraba (cuarta revisión). Las líneas salen en este orden.
          const validas = correcciones.filter(esValida).map((c, i) => ({ c, i }))
            .sort((a, b) => (b.c.comercio.trim().length - a.c.comercio.trim().length) || (a.i - b.i))
            .map(({ c }) => c);
          const resultados = [];
          const corregidosIds = [];
          let corregidas = 0;
          let algunaSinDatos = false;
          for (const corr of validas) {
            // B30, mismo motivo que en `corregir_categoria`: una sola resolución alimenta la
            // fila corregida, el árbol y el resumen que se imprime.
            const { resolverCategoriaPersistida } = require('../../services/categories');
            const _catCorrT = corr.categoria_nueva.trim(); // ver el `.trim()` de `corregir_categoria`
            const catLibre = resolverCategoriaPersistida(_catCorrT.charAt(0).toUpperCase() + _catCorrT.slice(1));
            // `subcategoriaUtil` descarta los centinelas: "null" como texto se escribía como "Null".
            const _subCorrT = typeof corr.subcategoria_nueva === 'string' ? corr.subcategoria_nueva.trim() : '';
            const subCorr = subcategoriaUtil(_subCorrT ? _subCorrT.charAt(0).toUpperCase() + _subCorrT.slice(1) : null);
            const res = await corregirTransaccionEspecifica(usuario.id, corr.comercio, corr.monto, corr.fecha, catLibre, subCorr, corregidosIds);
            if (res.ok) {
              corregidas++;
              if (res.id) corregidosIds.push(res.id);
              // ENCADENADAS y AWAITEADAS: acá además el `for` recorre varias correcciones, y dos
              // que apunten a la misma categoría en un mismo mensaje se cruzarían entre iteraciones.
              // Este bucle ya es secuencial (hay un `await` arriba), así que esperar no cambia la
              // latencia percibida — la respuesta sale recién cuando termina el for. Sólo con una
              // corrección hecha: antes un "no encontré" dejaba igual la categoría nueva en el árbol.
              await asegurarCategoriaUsuario(usuario.id, catLibre)
                .then(() => (subCorr ? crearSubcategoriaLibreUsuario(usuario.id, catLibre, subCorr) : null))
                .catch(() => {});
              const montoStr = res.moneda === 'USD' ? '$' + parseFloat(res.monto).toFixed(2) : 'S/ ' + parseFloat(res.monto).toFixed(2);
              // La fecha va en la línea: con varios que calzan se eligió el más reciente, y así se ve cuál.
              resultados.push('✅ *' + res.comercio + '* (' + montoStr + (res.fecha ? ' · ' + res.fecha : '') + ') → ' + catLibre);
              const pedidoOk = leerPedidoCorreccion(corr.monto, corr.fecha);
              if (pedidoOk.monto === null && pedidoOk.fecha === null) algunaSinDatos = true;
            } else if (res.motivo === 'ilegible') {
              // No se buscó nada: "no encontré" sería afirmar una búsqueda que no ocurrió. Un comercio
              // que es solo un comodín ('*') no se nombra: rompería la negrita y pediría el dato equivocado.
              resultados.push(/[\p{L}\p{N}]/u.test(corr.comercio)
                ? '❓ No entendí qué gasto de *' + corr.comercio.trim() + '* es: dime el monto (ej. 8.50) o la fecha'
                : '❓ No entendí de qué comercio es una de las correcciones');
            } else if (res.motivo === 'error') {
              // `corregirTransaccionEspecifica` distingue "no hay gasto de ese comercio" de
              // "algo falló", y esta rama existe para que esa distinción llegue a la persona.
              // Sin ella, un fallo se anunciaba como un gasto inexistente y el usuario corregía
              // el nombre del comercio una y otra vez contra una caída.
              //
              // El texto NO dice "no pude buscarlo": el motivo cubre las dos mitades de la
              // función —la lectura que no encontró y el update que fue rechazado— y nombrar
              // sólo una sería mentir en la otra.
              resultados.push('⚠️ No pude corregir el gasto de *' + corr.comercio + '* ahora mismo');
            } else if (res.motivo === 'desaparecido') {
              // 9A-bis: el update entró y no tocó ninguna fila, o sea que el gasto se borró
              // entre la lectura y la escritura. NO es "no lo encontré" (se encontró) ni "no
              // pude ahora mismo" (reintentar no lo va a traer de vuelta).
              resultados.push('🚫 Ese gasto de *' + corr.comercio + '* ya no está');
            } else {
              // Desde el 02-oct "no encontré" también cubre un comercio que SÍ tiene gastos pero
              // ninguno con el monto o la fecha que se dijo (antes se corregía otro). Nombrar lo que
              // se buscó es lo que deja ver un typo en vez de "no tengo taxis", y se lee con la MISMA
              // función que la búsqueda, para no nombrar algo que no se buscó (un monto 0, por ejemplo).
              const pedido = leerPedidoCorreccion(corr.monto, corr.fecha);
              const buscado = [pedido.monto !== null ? pedido.monto.toFixed(2) : null, pedido.fecha].filter(Boolean).join(' · ');
              // Con filas ya movidas en este mensaje, la búsqueda las excluyó: "no encontré" a secas
              // negaba un gasto que existe (el LLM que duplica el pedido, "era salud, no, trabajo").
              resultados.push('❌ No encontré ' + (corregidosIds.length ? 'otro gasto' : 'gasto') + ' de *' + corr.comercio + '*'
                + (buscado ? ' (' + buscado + ')' : '') + (corregidosIds.length ? ' aparte de los que ya moví' : ''));
            }
          }
          // Lo que se descartó también deja línea: callarlo bajo un "Listo!" era el fallo mudo.
          resultados.push(...correcciones.filter((c) => !esValida(c)).map(() => '❓ Una de las correcciones no la entendí: dime el comercio y la categoría'));
          if (resultados.length === 0) return 'No pude aplicar ninguna corrección.';
          // La cabecera cuenta CORRECCIONES, no líneas: "Actualicé 2 gastos" con un ❌ adentro afirmaba
          // un cambio que no ocurrió. Cada corrección aplicada es una fila distinta (`corregidosIds`).
          const total = resultados.length;
          const cabecera = corregidas === 0 ? 'No pude aplicar ninguna:'
            : corregidas === total ? 'Listo! Apliqué ' + corregidas + (corregidas === 1 ? ' corrección:' : ' correcciones:')
              : 'Apliqué ' + corregidas + ' de ' + total + ' correcciones:';
          // Sin monto ni fecha antes se retroaplicaba a todo el comercio; ahora se mueve uno, y quien
          // quería todos tiene que saber cómo pedirlo (es la frase de `set_category_rule`).
          const pista = algunaSinDatos ? '\n\n_Moví solo el más reciente de ese comercio. Para que todos vayan ahí, escríbeme "todo lo de [comercio] va en [categoría]"._' : '';
          return cabecera + '\n\n' + resultados.join('\n') + pista;
        } catch(e) {
          log.error({ tag: 'MULT', err: e.message }, 'Error corrección múltiple');
          const { WEBAPP_URL } = require('../../lib/constants');
          return '💡 Hubo un error procesando eso. Para cambios múltiples usa el dashboard:\n\n'
            + '👉 ' + WEBAPP_URL + '/dashboard/transacciones\n\n'
            + '_O dime las correcciones de una en una._';
        }
      }

      case 'corregir_monto_moneda': {
        try {
          const ultimaTxM = await obtenerUltimaTransaccion(usuario.id);
          if (!ultimaTxM) return 'No encuentro el gasto al que te refieres. \u00bfDe cu\u00e1l se trata?';
          const updates = {};
          const nuevaMoneda = datos.moneda || 'USD'; // si mencionaron "dolares" sin especificar, asumimos USD
          // `validarMonto` y no `parseFloat`, igual que su hermano `editar_monto`: lo que llega
          // en `datos.monto` lo produjo el modelo, y un `parseFloat('mucho')` da NaN. `monto` es
          // NOT NULL, así que el NaN llegaba serializado como null y Postgres rechazaba la fila
          // entera — falla cerrado, sí, pero con "no pude corregir la moneda ahora mismo", que
          // manda a reintentar algo que no va a funcionar nunca. Ahora se le dice qué escribir.
          const nuevoMonto = datos.monto != null ? validarMonto(datos.monto) : validarMonto(ultimaTxM.monto);
          if (nuevoMonto === null) return 'Dime el monto. Ej: _"cámbialo a 25 dólares"_, _"cámbialo a S/120"_.';
          updates.moneda = nuevaMoneda;
          updates.monto = nuevoMonto;
          if (nuevaMoneda === 'USD') {
            // El ÚNICO de los tres que sale a la red, y con motivo: la fila era PEN, no hay
            // ningún tipo previo que preservar. Los otros dos reusan el de la fila.
            const tc = await obtenerTipoCambio();
            Object.assign(updates, convertirUsdAPen(nuevoMonto, tc, { usuarioId: usuario.id, sitio: 'corregir_monto_moneda', txId: ultimaTxM.id }));
          } else {
            updates.monto_pen = nuevoMonto;
            updates.tipo_cambio = null;
          }
          const { data: filasMoneda, error: errMoneda } = await supabase.from('transacciones').update(updates).eq('id', ultimaTxM.id).select('id');
          if (errMoneda) {
            log.error({ tag: 'CORREGIR_MONEDA', err: errMoneda.message, txId: ultimaTxM.id }, 'No se pudo corregir monto/moneda');
            return 'No pude corregir la moneda ahora mismo. Vuelve a intentarlo en un momento.';
          }
          if (!filasMoneda || filasMoneda.length === 0) {
            log.warn({ tag: 'CORREGIR_MONEDA', txId: ultimaTxM.id }, 'El update de moneda no afectó ninguna fila');
            return 'Ese gasto ya no está. Puede que lo hayas eliminado hace un momento.';
          }
          const comercioM = ultimaTxM.comercio || 'el gasto';
          // `monto_pen` puede venir null (conversión fuera de rango): el `.toFixed(2)` de antes
          // habría lanzado ahí mismo y el catch habría contestado "no pude corregir la moneda"
          // sobre un update que SÍ se aplicó. Sin equivalente en soles se omite el paréntesis.
          const montoStrM = nuevaMoneda !== 'USD'
            ? 'S/ ' + nuevoMonto.toFixed(2)
            : '$' + nuevoMonto.toFixed(2) + (updates.monto_pen != null ? ' (~S/ ' + updates.monto_pen.toFixed(2) + ')' : '');
          return 'Corregido. *' + comercioM + '*: ' + montoStrM + ' en ' + (ultimaTxM.categoria || 'Otros') + '.';
        } catch(e) {
          log.error({ tag: 'CORREGIR_MONEDA', err: e.message }, 'Error corrigiendo monto/moneda');
          return 'No pude corregir la moneda. Int\u00e9ntalo de nuevo.';
        }
      }

      case 'eliminar_transaccion': {
        // Fuera del `try` a propósito: el catch la necesita para compensar (ver abajo).
        let snapshotEliminarId = null;
        try {
          // El sujeto tiene que estar EN EL MENSAJE, no solo en los `datos` del modelo (14-sep-2026).
          // Contra prod, "empecemos de cero, cancela todo" llegó con `comercio: "taxi"`, sacado
          // del turno anterior ("gasté 12 en taxi"), y como con sujeto la guarda no se consulta,
          // borró el taxi. El control del commit anterior había dado el mismo texto y lo leí como
          // "la guarda vieja falla": era este camino. Un campo que el usuario no escribió se
          // descarta; si no queda ninguno, es un borrado SIN sujeto y pasa por `pideBorrarUnGasto`.
          const msgNormElim = normalizarOrden(msg);
          const numerosMsg = (String(msg || '').match(/\d+(?:[.,]\d+)?/g) || []).map((n) => parseFloat(n.replace(',', '.')));
          const comercioNorm = datos.comercio ? normalizarOrden(datos.comercio) : '';
          const comercioDicho = comercioNorm.length >= 2 && msgNormElim.includes(comercioNorm);
          const montoDicho = datos.monto != null && numerosMsg.some((n) => Math.abs(n - parseFloat(datos.monto)) < 0.01);
          const fechaDicha = !!datos.fecha && /\b(?:hoy|ayer|anteayer|antier|lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|mes|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b|\d/.test(msgNormElim);
          if ((datos.comercio && !comercioDicho) || (datos.monto != null && !montoDicho) || (datos.fecha && !fechaDicha)) {
            log.info({ tag: 'ELIMINAR_SUJETO_NO_DICHO', comercio: !!datos.comercio && !comercioDicho, monto: datos.monto != null && !montoDicho, fecha: !!datos.fecha && !fechaDicha }, 'delete con un sujeto que el mensaje no nombra: se descarta');
          }
          const comercioElim = comercioDicho ? datos.comercio : null;
          const montoElimReq = montoDicho ? parseFloat(datos.monto) : null;
          const fechaElimReq = fechaDicha ? datos.fecha : null;
          const TOPE_CANDIDATOS = 20;
          // El mismo centavo, en enteros: con `0.15 - 0.01` en float (0.13999999999999999) el
          // filtro dejaba entrar el gasto de 0.14, y "borra el de 0.15" borraba el vecino.
          const centavosElim = montoElimReq == null ? null : Math.round(montoElimReq * 100);

          // Build candidate query — más preciso si hay comercio+monto+fecha. El monto va EN LA
          // CONSULTA, antes del `.limit`: filtrado en JS sobre los 20 más recientes, un gasto más
          // viejo que esos 20 salía "no encontré" aunque existiera (02-oct-2026).
          let qElim = supabase.from('transacciones').select('*').eq('usuario_id', usuario.id);
          if (comercioElim) qElim = qElim.ilike('comercio', '%' + comercioElim + '%');
          if (fechaElimReq) qElim = qElim.eq('fecha', fechaElimReq);
          if (centavosElim != null) qElim = qElim.gt('monto', (centavosElim - 1) / 100).lt('monto', (centavosElim + 1) / 100);
          qElim = qElim.order('created_at', { ascending: false }).limit(TOPE_CANDIDATOS);
          const { data: candidatosElim } = await qElim;
          const candidatos = candidatosElim || [];

          // Si no hubo filtro alguno, caer al último registro
          let txElim = null;
          if (!comercioElim && montoElimReq == null && !fechaElimReq) {
            // MISMA puerta que `deshacer_ultimo`: sin comercio, monto ni fecha esto es un
            // borrado SIN SUJETO sobre lo último que haya. `delete` y `undo` salen del
            // mismo tool (`manage_transaction`) y quién de los dos sale lo elige el LLM,
            // así que guardar solo `undo` dejaba la puerta gemela abierta al mismo caso:
            // "Quiero reiniciar" clasificado como delete sin argumentos borraba igual.
            // Lo levantó la revisión adversarial; mi comentario de PIDE_BORRAR afirmaba
            // que undo era el único borrado sin sujeto y era falso.
            txElim = await obtenerUltimaTransaccion(usuario.id);
            if (txElim && !pideBorrarUnGasto(msg)) {
              log.info({ tag: 'ELIMINAR_AMBIGUO', msg: (msg || '').substring(0, 80) }, 'delete sin sujeto ni señal de borrado: se pide confirmación');
              // Lo lee `message-processor`: con la orden pedida, no se registra la otra mitad de
              // un mensaje compuesto en este turno (cambiaría cuál es "el último").
              ctx.borradoPidioOrden = true;
              return pedirOrdenDeBorrado(txElim, formatFecha);
            }
          } else if (candidatos.length === 1) {
            txElim = candidatos[0];
          } else if (candidatos.length === 0) {
            const detalle = [
              comercioElim ? '*' + comercioElim + '*' : null,
              montoElimReq != null ? 'S/ ' + montoElimReq.toFixed(2) : null,
              fechaElimReq || null,
            ].filter(Boolean).join(' · ');
            // Las tres respuestas que PREGUNTAN algo llevan la misma marca que la de la orden:
            // registrar la otra mitad en este turno cambia las filas sobre las que se pregunta
            // (con dos comidas listadas, una comida nueva de S/100 vuelve inútil "el monto").
            ctx.borradoPidioOrden = true;
            return 'No encontré ningún gasto que coincida' + (detalle ? ' con ' + detalle : '') + '. ¿Puedes darme más datos (monto exacto o fecha)?';
          } else {
            // Varios matches — listar para que el usuario elija, sin borrar nada
            const lista = candidatos.slice(0, 6).map((c, i) => {
              const m = c.moneda === 'USD' ? '$' + parseFloat(c.monto).toFixed(2) : 'S/ ' + parseFloat(c.monto).toFixed(2);
              return (i+1) + '. ' + (c.comercio || 'Sin comercio') + ' — ' + m + ' · ' + (c.fecha || '');
            }).join('\n');
            ctx.borradoPidioOrden = true;
            // Con el tope lleno puede haber más: "Encontré 20" afirmaba un total que no se contó.
            const cuantos = candidatos.length >= TOPE_CANDIDATOS ? 'al menos ' + TOPE_CANDIDATOS : String(candidatos.length);
            return 'Encontré ' + cuantos + ' gastos que coinciden. ¿A cuál te refieres?\n\n' + lista + '\n\n_Respóndeme con el monto o la fecha exacta._';
          }

          if (!txElim) { ctx.borradoPidioOrden = true; return '¿De qué gasto me hablas? Dime el comercio, monto o fecha y lo elimino.'; }

          // Snapshot para auditoría + restore. Va ANTES del delete y bloqueante: si no
          // queda escrito, borramos igual (es lo que pidió el usuario) pero sin prometer
          // una restauración que no podríamos cumplir.
          snapshotEliminarId = await guardarSnapshotEliminacion(supabase, usuario.id, txElim, 'ELIMINAR_AUDIT');

          // Si es transacción de Gmail, guardar en excluidos para evitar re-importación
          if (txElim.descripcion_original && !txElim.descripcion_original.startsWith('duplicado:')) {
            const { error: errExc } = await supabase.from('gmail_excluidos').upsert({ usuario_id: usuario.id, descripcion_original: txElim.descripcion_original }, { onConflict: 'usuario_id,descripcion_original' });
            if (errExc) log.warn({ tag: 'ELIMINAR_EXCLUIDO', err: errExc.message }, 'No se pudo excluir de Gmail');
          }
          // `.select('id')` no es decorativo: postgrest **no** devuelve error cuando el DELETE no
          // matchea ninguna fila, así que sin esto "la escritura no tocó nada" produce la misma
          // confirmación falsa que este ítem vino a cerrar. Pasa de verdad con un doble envío:
          // el segundo mensaje snapshotea, borra cero filas, confirma igual, y quedan dos copias
          // pendientes de la misma transacción — o sea el gasto duplicado al restaurar.
          const { data: filasBorradas, error: errBorrar } = await supabase.from('transacciones').delete().eq('id', txElim.id).select('id');
          if (!errBorrar && (!filasBorradas || filasBorradas.length === 0)) {
            if (snapshotEliminarId) await descartarSnapshot(supabase, snapshotEliminarId, 'ELIMINAR_AUDIT');
            log.warn({ tag: 'ELIMINAR', txId: txElim.id }, 'El delete no afectó ninguna fila');
            return 'Ese gasto ya no está. Puede que lo hayas eliminado hace un momento.';
          }
          if (errBorrar) {
            // El snapshot ya entró y la fila sigue viva: esas dos cosas juntas son la duplicación
            // descrita en `descartarSnapshot`. Sólo se compensa si hubo copia que descartar.
            if (snapshotEliminarId) await descartarSnapshot(supabase, snapshotEliminarId, 'ELIMINAR_AUDIT');
            log.error({ tag: 'ELIMINAR', err: errBorrar.message, txId: txElim.id }, 'No se pudo eliminar la transacción');
            return 'No pude eliminarlo ahora mismo. Vuelve a intentarlo en un momento.';
          }
          const montoElim = txElim.moneda === 'USD' ? '$' + parseFloat(txElim.monto).toFixed(2) : 'S/ ' + parseFloat(txElim.monto).toFixed(2);
          return 'Listo. Eliminé *' + (txElim.comercio || 'ese gasto') + '* (' + montoElim + ') del ' + txElim.fecha + '.' + avisoRestauracion(snapshotEliminarId);
        } catch(e) {
          // La compensación cuelga TAMBIÉN de acá y no sólo de la rama `error`: si el await
          // rechaza en vez de resolver, la copia queda igual de huérfana y el `if (errBorrar)`
          // nunca corre. Es defensa en profundidad y conviene decirlo así: postgrest-js no
          // rechaza por contrato (convierte el fallo de fetch en `error`), y entre el snapshot y
          // el `return` no queda ningún otro `await` que pueda tirar. El test que la cubre
          // fabrica el rechazo a mano, porque el cliente real no lo produce.
          //
          // Descarta por ID, así que el radio de daño es la copia que ESTE mensaje escribió.
          // Acá decía que filtraba por `tx_id` + `restored_at is null` y "no puede tocar nada
          // más": era falso — sin unique sobre `tx_id`, ese WHERE alcanzaba también la copia de
          // un borrado concurrente del mismo gasto.
          if (snapshotEliminarId) await descartarSnapshot(supabase, snapshotEliminarId, 'ELIMINAR_AUDIT');
          log.error({ tag: 'ELIMINAR', err: e.message }, 'Error eliminando transacción');
          return 'No pude eliminarlo. ¿De cuál gasto se trata?';
        }
      }

      case 'restaurar_eliminado': {
        try {
          // `comercio` y `monto` ya pasaron por la guarda de datos-dichos: si están, la persona los
          // dijo. Sin ninguno, "restaura" a secas restaura el último borrado (es un deshacer).
          const comercioRest = datos.comercio || null;
          const montoRest = datos.monto != null ? parseFloat(datos.monto) : null;
          const centavosRest = montoRest != null && Number.isFinite(montoRest) ? Math.round(montoRest * 100) : null;
          const TOPE_BORRADOS = 50;

          // Con un comercio dicho, el servidor trae solo los borrados que pueden coincidir (patrón
          // amplio, sin tildes): antes se miraban los 20 más recientes y un borrado más viejo no
          // existía. La decisión la toma `resolverNombre` acá abajo.
          let qPend = supabase.from('transacciones_eliminadas').select('*')
            .eq('usuario_id', usuario.id).is('restored_at', null);
          const patronRest = comercioRest ? patronAmplio(comercioRest) : null;
          if (patronRest) qPend = qPend.filter('snapshot->>comercio', 'imatch', patronRest);
          const { data: pendientes, error: errPend } = await qPend
            .order('deleted_at', { ascending: false }).limit(TOPE_BORRADOS);
          // "No tengo nada borrado" sobre una lectura caída le dice a la persona que perdió el gasto.
          if (errPend) {
            log.error({ tag: 'RESTAURAR', err: errPend.message }, 'No se pudo leer los borrados pendientes');
            return 'No pude revisar lo que borraste ahora mismo. Vuelve a intentarlo en un momento.';
          }

          // Un pedido que no coincide NO restaura otro gasto (backlog, ítem 43). Antes caía al último
          // borrado: "recupera el gasto de la pizza" devolvía el cine. El arreglo ingenuo rompía el
          // "restaura" pelado cuando el modelo rellenaba un comercio del turno anterior; hoy la guarda
          // de datos-dichos descarta ese comercio, y el caso tiene test.
          let candidatos = pendientes || [];
          let nombreRest = null;
          const delMonto = (p) => Math.round(parseFloat(p.snapshot?.monto) * 100) === centavosRest;
          if (comercioRest) {
            let res = resolverNombre(comercioRest, candidatos, { nombreDe: (p) => p.snapshot?.comercio || '' });
            // "recupera la pizza de 40" con Pizza Hut (40) y Pizza Raúl (22): el monto desempata
            // entre los nombres que coinciden (revisión de 469e728). Solo si deja UN nombre.
            if (res.estado === 'varios' && centavosRest != null) {
              const conMonto = filasQueNombra(comercioRest, candidatos, { nombreDe: (p) => p.snapshot?.comercio || '' }).filter(delMonto);
              const nombresMonto = [...new Set(conMonto.map((p) => String(p.snapshot?.comercio || '')))];
              if (nombresMonto.length === 1) res = { estado: 'uno', nombre: nombresMonto[0], filas: conMonto };
            }
            if (res.estado === 'varios') {
              return 'Borraste gastos de varios comercios que coinciden con *' + comercioRest + '*: ' + listaNombres(res.nombres)
                + '. ¿Cuál recupero? Dime el nombre completo.';
            }
            candidatos = res.estado === 'uno' ? res.filas : [];
            nombreRest = res.estado === 'uno' ? res.nombre : comercioRest;
          }
          if (centavosRest != null) {
            candidatos = candidatos.filter(delMonto);
          }
          if (!comercioRest && centavosRest != null) {
            // Solo el monto: dos comercios distintos con ese monto son dos gastos distintos.
            const nombres = [...new Set(candidatos.map((p) => String(p.snapshot?.comercio || 'Sin comercio')))];
            if (nombres.length > 1) {
              return 'Borraste varios gastos de S/ ' + montoRest.toFixed(2) + ': ' + listaNombres(nombres) + '. ¿Cuál recupero? Dime el comercio.';
            }
          }
          if (candidatos.length === 0) {
            if (!comercioRest && centavosRest == null) return 'No tengo ningún gasto eliminado reciente para restaurar.';
            const pedido = [nombreRest ? '*' + nombreRest + '*' : null, montoRest != null ? 'S/ ' + montoRest.toFixed(2) : null].filter(Boolean).join(' de ');
            return 'No encontré ' + pedido + ' entre lo que borraste, así que no restauré nada.\n\n_Escribe "restaura" para recuperar lo último que borraste._';
          }

          const objetivo = candidatos[0];
          const snap = objetivo.snapshot || {};
          // Re-insertar la fila preservando fecha/categoría/comercio original
          const payloadRestore = {
            usuario_id: usuario.id,
            monto: snap.monto,
            monto_pen: snap.monto_pen,
            moneda: snap.moneda,
            tipo_cambio: snap.tipo_cambio,
            comercio: snap.comercio,
            categoria: snap.categoria,
            subcategoria: snap.subcategoria,
            tipo: snap.tipo,
            banco: snap.banco,
            metodo_pago: snap.metodo_pago,
            fecha: snap.fecha,
            descripcion_original: snap.descripcion_original,
          };
          // **El ORDEN de estas dos escrituras es la decisión, no un detalle de estilo.**
          //
          // Antes: insert, y después marcar la copia como restaurada sin mirar su error. Si la
          // marca no entraba, la copia seguía PENDIENTE con la transacción ya re-insertada, así
          // que el siguiente "restaura" la insertaba otra vez: plata duplicada, en silencio, y el
          // mensaje decía "Restauré" las dos veces. Dos "restaura" seguidos duplicaban igual,
          // porque nada arbitraba entre ellos.
          //
          // Ahora se RECLAMA primero: el `.is('restored_at', null)` sobre el UPDATE es el mismo
          // claim atómico de `reclamarPagoPendiente` (WHERE condicional en Postgres), así que una
          // sola ejecución se lleva la copia. Y si el insert falla después, la copia vuelve a
          // pendiente para que el reintento funcione.
          //
          // **Lo que este orden NO cierra, y decirlo importa porque la primera versión de este
          // comentario afirmaba que sí.** Si el INSERT commitea en Postgres pero el cliente ve
          // error igual (timeout después del commit, corte de conexión), la devolución a
          // pendiente deja la copia reclamable con la transacción viva, y el "restaura"
          // siguiente duplica. Ese caso existía idéntico en el orden viejo —no lo introduce el
          // reorden— y no se puede cerrar acá: `payloadRestore` no lleva `dedup_hash` (ese
          // cálculo vive en `guardarTransaccion`, que este camino saltea) y no hay unique que
          // aplique. Queda anotado en el backlog, no tapado con un comentario que diga otra cosa.
          //
          // Lo que el reorden SÍ cambia es el caso frecuente —el error que el cliente ve porque
          // la escritura de verdad no entró— y la carrera de dos "restaura", que antes no tenía
          // árbitro y ahora lo tiene.
          const { data: copiaReclamada, error: errReclamoCopia } = await supabase.from('transacciones_eliminadas')
            .update({ restored_at: new Date().toISOString() })
            .eq('id', objetivo.id).is('restored_at', null)
            .select('id').maybeSingle();
          if (errReclamoCopia) {
            log.error({ tag: 'RESTAURAR', err: errReclamoCopia.message, snapshotId: objetivo.id }, 'No se pudo reclamar la copia');
            return 'No pude restaurar el gasto ahora mismo. Vuelve a intentarlo en un momento.';
          }
          if (!copiaReclamada) {
            // Otro mensaje se la llevó entre medio. Re-insertar acá es exactamente la duplicación.
            //
            // El texto NO afirma que esté restaurado: el ganador de la carrera todavía puede
            // fallar su insert y devolver la copia a pendiente, y entonces "ya lo restauré"
            // sería la mentira inversa a la que este ítem vino a cerrar.
            return 'Ese gasto ya lo estoy restaurando. Dame un momento y revisa tu historial.';
          }
          const { error: insErr } = await supabase.from('transacciones').insert(payloadRestore);
          if (insErr) {
            log.error({ tag: 'RESTAURAR', err: insErr.message, snapshotId: objetivo.id }, 'Error al re-insertar tx');
            // **Misma clase que los siete de arriba y NO el mismo arreglo.** Acá "0 filas" no es
            // un desenlace que el usuario deba conocer: el WHERE es sólo por `id` (nadie más pudo
            // perder este claim — lo ganamos con el `.is('restored_at', null)` de arriba), así que
            // cero filas significa que la copia ya no existe. Y si no existe, no hay nada que
            // devolver a pendiente ni duplicación posible después: el desenlace es benigno.
            //
            // Por eso la respuesta al usuario NO cambia —sigue siendo "no pude restaurarlo", que
            // es verdad en los dos casos— y lo único que se gana es el LOG. Sin `.select('id')`
            // los dos casos escribían la misma línea, y esa línea ("la copia quedó marcada sin
            // transacción: ya no se puede restaurar") es falsa cuando la copia no está: no quedó
            // marcada, no está. Un log que afirma un estado que no comprobó manda a buscar una
            // fila que no existe.
            const { data: copiaDevuelta, error: errDevolver } = await supabase.from('transacciones_eliminadas')
              .update({ restored_at: null }).eq('id', objetivo.id).select('id');
            if (errDevolver) log.error({ tag: 'RESTAURAR', err: errDevolver.message, snapshotId: objetivo.id }, 'La copia quedó marcada sin transacción: ya no se puede restaurar');
            else if (!copiaDevuelta || copiaDevuelta.length === 0) log.warn({ tag: 'RESTAURAR', snapshotId: objetivo.id }, 'La copia ya no existe: no hubo nada que devolver a pendiente');
            return 'No pude restaurar el gasto. Intenta registrarlo manualmente.';
          }

          // Si estaba en gmail_excluidos, quitarlo para que vuelva a poder importarse
          if (snap.descripcion_original && !String(snap.descripcion_original).startsWith('duplicado:')) {
            // ACCESORIA a propósito, y la única de las once que no cambia la respuesta: si esta
            // fila no se borra, el correo sigue excluido y la transacción —ya restaurada— sólo
            // deja de re-importarse. El fallo no le quita nada al usuario. Lo que se gana es el
            // log: el `.catch()` que había sólo veía errores de red, y postgrest no lanza.
            const { error: errExcRest } = await supabase.from('gmail_excluidos').delete()
              .eq('usuario_id', usuario.id)
              .eq('descripcion_original', snap.descripcion_original);
            if (errExcRest) log.warn({ tag: 'RESTAURAR', err: errExcRest.message }, 'No se pudo quitar de gmail_excluidos');
          }

          const montoStr = snap.moneda === 'USD' ? '$' + parseFloat(snap.monto).toFixed(2) : 'S/ ' + parseFloat(snap.monto).toFixed(2);
          return '↩️ Restauré *' + (snap.comercio || 'el gasto') + '* (' + montoStr + ') del ' + (snap.fecha || '') + '.';
        } catch(e) {
          log.error({ tag: 'RESTAURAR', err: e.message }, 'Error restaurando tx');
          return 'No pude restaurar el gasto. Intenta de nuevo.';
        }
      }

      case 'editar_monto': {
        try {
          // `validarMonto` y no `parseFloat` + `> 0`: es el gemelo por WhatsApp del bug ya
          // arreglado en la webapp (B18). El chequeo suelto deja pasar Infinity, montos de 15
          // dígitos y decimales infinitos, y acá la escritura es directa —no hay UI que los
          // frene—. El copy amable se conserva: el usuario que escribe "corrige a 50" y el que
          // escribe algo absurdo reciben el mismo empujón, que es lo que corresponde por chat.
          const montoNuevo = validarMonto(datos.monto_nuevo);
          if (!montoNuevo) return 'Dime el monto correcto. Ej: _"el monto es 50"_, _"corrige a S/120"_.';
          // Siempre el ÚLTIMO movimiento (chip 5, 01-oct-2026): `revisarEdicion` no deja pasar un
          // sujeto. La búsqueda por comercio (`ilike`) que vivía acá eligió la fila equivocada en prod
          // ("aby 143" buscó "aby", no lo halló y editó "traer tronco"); ver lib/orden-edicion.js.
          const txEditM = await obtenerUltimaTransaccion(usuario.id);
          if (!txEditM) return 'No encuentro un gasto reciente para corregir.';
          const monedaEdit = txEditM.moneda || 'PEN';
          const updates = { monto: montoNuevo };
          if (monedaEdit === 'USD') {
            // El tipo es el DE LA FILA, no el de hoy: corregir *"eran 30 y no 20"* no cambia
            // el tipo del día en que se gastó. Antes se pedía el de hoy y se escribía sólo
            // `monto_pen`, así que la fila quedaba con `monto * tipo_cambio ≠ monto_pen`.
            const tcEdit = await tipoCambioDeLaFila(txEditM, obtenerTipoCambio);
            Object.assign(updates, convertirUsdAPen(montoNuevo, tcEdit, { usuarioId: usuario.id, sitio: 'editar_monto', txId: txEditM.id }));
          } else {
            updates.monto_pen = montoNuevo;
          }
          const { data: filasMonto, error: errEditMonto } = await supabase.from('transacciones').update(updates).eq('id', txEditM.id).select('id');
          if (errEditMonto) {
            log.error({ tag: 'EDITAR_MONTO', err: errEditMonto.message, txId: txEditM.id }, 'No se pudo editar el monto');
            return 'No pude corregir el monto ahora mismo. Vuelve a intentarlo en un momento.';
          }
          if (!filasMonto || filasMonto.length === 0) {
            log.warn({ tag: 'EDITAR_MONTO', txId: txEditM.id }, 'El update del monto no afectó ninguna fila');
            return 'Ese gasto ya no está. Puede que lo hayas eliminado hace un momento.';
          }
          const montoViejo = monedaEdit === 'USD' ? '$' + parseFloat(txEditM.monto).toFixed(2) : 'S/ ' + parseFloat(txEditM.monto).toFixed(2);
          const montoNuevoStr = monedaEdit === 'USD' ? '$' + montoNuevo.toFixed(2) : 'S/ ' + montoNuevo.toFixed(2);
          return '✅ Monto corregido.\n*' + (txEditM.comercio || 'Gasto') + '*: ' + montoViejo + ' → ' + montoNuevoStr;
        } catch(e) {
          log.error({ tag: 'EDITAR_MONTO', err: e.message }, 'Error editando monto');
          return 'No pude corregir el monto. Intenta de nuevo.';
        }
      }

      case 'editar_fecha': {
        try {
          let fechaNueva = datos.fecha_nueva;
          if (!fechaNueva) return 'Dime la fecha correcta. Ej: _"cambia la fecha a ayer"_, _"cámbialo al 15 de marzo"_.';
          // Parsear "ayer"
          if (fechaNueva === 'ayer') {
            fechaNueva = fechaAyerPeru();
          } else if (/^\d{1,2}$/.test(fechaNueva)) {
            // Solo día → asumir mes/año actual
            fechaNueva = anioActual + '-' + String(mesActual).padStart(2,'0') + '-' + String(parseInt(fechaNueva)).padStart(2,'0');
          }
          // Siempre el ÚLTIMO movimiento (chip 5, 01-oct-2026): `revisarEdicion` no deja pasar un
          // sujeto. La búsqueda por comercio (`ilike`) que vivía acá eligió la fila equivocada en prod
          // ("aby 143" buscó "aby", no lo halló y editó "traer tronco"); ver lib/orden-edicion.js.
          const txEditF = await obtenerUltimaTransaccion(usuario.id);
          if (!txEditF) return 'No encuentro un gasto reciente para corregir.';
          const { data: filasFecha, error: errEditFecha } = await supabase.from('transacciones').update({ fecha: fechaNueva }).eq('id', txEditF.id).select('id');
          if (errEditFecha) {
            log.error({ tag: 'EDITAR_FECHA', err: errEditFecha.message, txId: txEditF.id }, 'No se pudo editar la fecha');
            return 'No pude corregir la fecha ahora mismo. Vuelve a intentarlo en un momento.';
          }
          if (!filasFecha || filasFecha.length === 0) {
            log.warn({ tag: 'EDITAR_FECHA', txId: txEditF.id }, 'El update de la fecha no afectó ninguna fila');
            return 'Ese gasto ya no está. Puede que lo hayas eliminado hace un momento.';
          }
          return '✅ Fecha corregida.\n*' + (txEditF.comercio || 'Gasto') + '*: ' + formatFecha(txEditF.fecha) + ' → ' + formatFecha(fechaNueva);
        } catch(e) {
          log.error({ tag: 'EDITAR_FECHA', err: e.message }, 'Error editando fecha');
          return 'No pude corregir la fecha. Intenta de nuevo.';
        }
      }

      case 'editar_comercio': {
        try {
          const comercioNuevo = datos.comercio_nuevo;
          if (!comercioNuevo) return 'Dime el nombre correcto. Ej: _"el comercio es Plaza Vea"_.';
          // Siempre el ÚLTIMO movimiento (chip 5, 01-oct-2026): `revisarEdicion` no deja pasar un
          // sujeto. La búsqueda por comercio (`ilike`) que vivía acá eligió la fila equivocada en prod
          // ("aby 143" buscó "aby", no lo halló y editó "traer tronco"); ver lib/orden-edicion.js.
          const txEditC = await obtenerUltimaTransaccion(usuario.id);
          if (!txEditC) return 'No encuentro un gasto reciente para corregir.';
          const comercioViejo = txEditC.comercio || 'Sin nombre';
          const { data: filasCom, error: errEditCom } = await supabase.from('transacciones').update({ comercio: comercioNuevo }).eq('id', txEditC.id).select('id');
          if (errEditCom) {
            log.error({ tag: 'EDITAR_COMERCIO', err: errEditCom.message, txId: txEditC.id }, 'No se pudo editar el comercio');
            return 'No pude corregir el comercio ahora mismo. Vuelve a intentarlo en un momento.';
          }
          if (!filasCom || filasCom.length === 0) {
            log.warn({ tag: 'EDITAR_COMERCIO', txId: txEditC.id }, 'El update del comercio no afectó ninguna fila');
            return 'Ese gasto ya no está. Puede que lo hayas eliminado hace un momento.';
          }
          return '✅ Comercio corregido.\n' + comercioViejo + ' → *' + comercioNuevo + '*';
        } catch(e) {
          log.error({ tag: 'EDITAR_COMERCIO', err: e.message }, 'Error editando comercio');
          return 'No pude corregir el comercio. Intenta de nuevo.';
        }
      }

      case 'dividir_gasto': {
        try {
          const partes = datos.partes ? parseInt(datos.partes) : null;
          if (!partes || partes < 2 || partes > 20) return 'Dime entre cuántos dividir. Ej: _"divídelo entre 3"_, _"divídelo a medias"_.';
          // Siempre el ÚLTIMO movimiento (chip 5, 01-oct-2026): `revisarEdicion` no deja pasar un
          // sujeto. La búsqueda por comercio (`ilike`) que vivía acá eligió la fila equivocada en prod
          // ("aby 143" buscó "aby", no lo halló y editó "traer tronco"); ver lib/orden-edicion.js.
          const txDiv = await obtenerUltimaTransaccion(usuario.id);
          if (!txDiv) return 'No encuentro un gasto reciente para dividir.';
          // Los DOS pasan por `validarMonto` (B18), y por motivos distintos:
          //  · el original, porque es un valor que salió de la DB y esta rama lo vuelve a
          //    escribir: si ya estaba envenenado, dividirlo lo propaga sin mirarlo.
          //  · el resultado, porque la división puede caer bajo el centavo (S/0.10 entre 20
          //    redondea a 0.00) y eso escribiría un gasto de cero, que no es un gasto.
          const montoOriginal = validarMonto(txDiv.monto);
          if (!montoOriginal) return 'Ese gasto tiene un monto que no puedo dividir. Corrígelo primero: _"el monto es 50"_.';
          const montoNuevoDiv = validarMonto((montoOriginal / partes).toFixed(2));
          if (!montoNuevoDiv) return 'Dividirlo entre ' + partes + ' deja menos de un centavo. Prueba con menos partes.';
          const updates = { monto: montoNuevoDiv };
          if (txDiv.moneda === 'USD') {
            // Mismo criterio que `editar_monto`: dividir la cuenta entre 3 no re-cotiza el
            // gasto a hoy. Con el tipo de la fila, `monto_pen` queda dividido por las mismas
            // partes que `monto`, que es lo único que puede querer decir "mi parte".
            const tcDiv = await tipoCambioDeLaFila(txDiv, obtenerTipoCambio);
            Object.assign(updates, convertirUsdAPen(montoNuevoDiv, tcDiv, { usuarioId: usuario.id, sitio: 'dividir_gasto', txId: txDiv.id }));
          } else {
            updates.monto_pen = montoNuevoDiv;
          }
          const { data: filasDiv, error: errDividir } = await supabase.from('transacciones').update(updates).eq('id', txDiv.id).select('id');
          if (errDividir) {
            log.error({ tag: 'DIVIDIR', err: errDividir.message, txId: txDiv.id }, 'No se pudo dividir el gasto');
            return 'No pude dividir el gasto ahora mismo. Vuelve a intentarlo en un momento.';
          }
          if (!filasDiv || filasDiv.length === 0) {
            log.warn({ tag: 'DIVIDIR', txId: txDiv.id }, 'El update de la división no afectó ninguna fila');
            return 'Ese gasto ya no está. Puede que lo hayas eliminado hace un momento.';
          }
          const monedaDiv = txDiv.moneda === 'USD' ? '$' : 'S/ ';
          return '✅ Gasto dividido entre ' + partes + '.\n*' + (txDiv.comercio || 'Gasto') + '*: ' + monedaDiv + montoOriginal.toFixed(2) + ' → ' + monedaDiv + montoNuevoDiv.toFixed(2) + ' (tu parte)';
        } catch(e) {
          log.error({ tag: 'DIVIDIR', err: e.message }, 'Error dividiendo gasto');
          return 'No pude dividir el gasto. Intenta de nuevo.';
        }
      }

      case 'duplicar_gasto': {
        try {
          const txDup = await obtenerUltimaTransaccion(usuario.id);
          if (!txDup) return 'No encuentro un gasto reciente para duplicar.';
          const fechaDup = datos.fecha || fechaHoyPeru();
          const datosDup = {
            monto: parseFloat(txDup.monto),
            moneda: txDup.moneda || 'PEN',
            comercio: txDup.comercio,
            categoria: txDup.categoria,
            subcategoria: txDup.subcategoria,
            tipo: txDup.tipo || 'gasto',
            banco: txDup.banco,
            metodo_pago: txDup.metodo_pago,
            fecha: fechaDup,
            descripcion_original: 'duplicado:' + txDup.id
          };
          await guardarTransaccion(usuario.id, datosDup);
          const monedaDup = txDup.moneda === 'USD' ? '$' : 'S/ ';
          return '✅ Gasto duplicado.\n*' + (txDup.comercio || 'Gasto') + '*: ' + monedaDup + parseFloat(txDup.monto).toFixed(2) + ' registrado para ' + formatFecha(fechaDup) + '.';
        } catch(e) {
          log.error({ tag: 'DUPLICAR', err: e.message }, 'Error duplicando gasto');
          return 'No pude duplicar el gasto. Intenta de nuevo.';
        }
      }

      case 'deshacer_ultimo': {
        // Ver `eliminar_transaccion`.
        let snapshotDeshacerId = null;
        try {
          const txDeshacer = await obtenerUltimaTransaccion(usuario.id);
          if (!txDeshacer) return 'No hay transacciones recientes para deshacer.';
          const montoDeshacer = txDeshacer.moneda === 'USD' ? '$' + parseFloat(txDeshacer.monto).toFixed(2) : 'S/ ' + parseFloat(txDeshacer.monto).toFixed(2);
          // El clasificador puede mandar acá una frase que no pidió borrar nada. Ver PIDE_BORRAR.
          if (!pideBorrarUnGasto(msg)) {
            log.info({ tag: 'DESHACER_AMBIGUO', msg: (msg || '').substring(0, 80) }, 'undo sin señal de borrado: se pide confirmación');
            ctx.borradoPidioOrden = true;   // ver la misma marca en `eliminar_transaccion`
            return pedirOrdenDeBorrado(txDeshacer, formatFecha);
          }
          // Snapshot bloqueante y verificado ANTES del delete: el mensaje solo ofrece
          // restaurar si la copia quedó guardada.
          snapshotDeshacerId = await guardarSnapshotEliminacion(supabase, usuario.id, txDeshacer, 'DESHACER_AUDIT');
          const { data: filasDeshechas, error: errDeshacer } = await supabase.from('transacciones').delete().eq('id', txDeshacer.id).select('id');
          if (!errDeshacer && (!filasDeshechas || filasDeshechas.length === 0)) {
            // Ver el mismo caso en `eliminar_transaccion`.
            if (snapshotDeshacerId) await descartarSnapshot(supabase, snapshotDeshacerId, 'DESHACER_AUDIT');
            log.warn({ tag: 'DESHACER', txId: txDeshacer.id }, 'El delete no afectó ninguna fila');
            return 'Ese registro ya no está. Puede que lo hayas eliminado hace un momento.';
          }
          if (errDeshacer) {
            // Mismo par ordenado que en `eliminar_transaccion`: copia escrita + fila viva.
            if (snapshotDeshacerId) await descartarSnapshot(supabase, snapshotDeshacerId, 'DESHACER_AUDIT');
            log.error({ tag: 'DESHACER', err: errDeshacer.message, txId: txDeshacer.id }, 'No se pudo deshacer');
            return 'No pude deshacerlo ahora mismo. Vuelve a intentarlo en un momento.';
          }
          return '↩️ *Deshecho:*\n\nEliminé *' + (txDeshacer.comercio || 'último registro') + '* — ' + montoDeshacer + ' del ' + (txDeshacer.fecha || '') + '.' + avisoRestauracion(snapshotDeshacerId);
        } catch(e) {
          // Mismo motivo que en `eliminar_transaccion`.
          if (snapshotDeshacerId) await descartarSnapshot(supabase, snapshotDeshacerId, 'DESHACER_AUDIT');
          log.error({ tag: 'DESHACER', err: e.message }, 'Error deshacer último');
          return 'No pude deshacer la última acción. Intenta de nuevo.';
        }
      }

      case 'editar_categoria_comercio': {
        try {
          const comercioRegla = datos.comercio;
          const catRegla = datos.categoria;
          const subRegla = datos.subcategoria || null;
          if (!comercioRegla || !catRegla) return 'Dime el comercio y la categoría. Ej: _"todo lo de Rappi siempre va en Delivery"_';
          // Recortar y capitalizar como los OTROS dos caminos de regla, y no es cosmético:
          // este era el único que pasaba `datos.categoria` crudo, así que la misma categoría
          // libre nacía con dos grafías según cómo la pidieras — "gastos hormiga" por acá y
          // "Gastos hormiga" por `corregir_categoria`. Un split de categoría producido por el
          // fix que existe para cerrar splits de categoría.
          //
          // El `.trim()` va acá arriba porque `normalizarDestinoRegla` recorta la categoría de
          // la REGLA y nada recortaba la que se escribe en `transacciones`: con "Ahorro " (hay
          // cuatro nombres así en prod) la fila quedaba con el espacio y la regla sin él.
          const catReglaLibre = catRegla.trim().charAt(0).toUpperCase() + catRegla.trim().slice(1);
          const subReglaLibre = subRegla ? subRegla.trim().charAt(0).toUpperCase() + subRegla.trim().slice(1) : null;
          // Defensa: si el "comercio" llega como una frase (con monto o demasiadas
          // palabras) el clasificador confundió un gasto puntual con una regla. No
          // creamos la regla basura y guiamos al usuario. Ej. "gasto de diez soles en taxi".
          if (/\d/.test(comercioRegla) || comercioRegla.trim().split(/\s+/).length > 4) {
            return 'Para registrar un gasto dime algo como _"gasté 10 en taxi"_.\n\nSi lo que quieres es una regla fija de categoría, dímelo sin monto: _"todo lo de taxi va en Transporte"_.';
          }
          // B30. Este era el ÚNICO de los tres caminos de regla que no tocaba el árbol del
          // usuario: guardaba la regla y retroaplicaba, así que "todo lo de Rappi va en
          // Delivery" dejaba filas en una categoría que `/categorias` no lista y que el
          // selector de presupuestos no ofrece. Va encadenada y fire-and-forget, igual que
          // en `corregir_categoria` (en paralelo las dos insertan la misma raíz).
          //
          // El destino EFECTIVO manda sobre lo que pidió el usuario, y sale de
          // `guardarReglaComercio` en vez de recalcularse acá: si esta función descartó la
          // regla, anunciar "Regla creada" era una mentira lisa (pasaba con "todo lo de X va
          // en Otros" sin subcategoría, y con cualquier categoría que colapse a 'Otros').
          //
          // El motivo del rechazo elige el mensaje, y no es un detalle: "no clasifica nada" le
          // pide al usuario que cambie lo que pidió, mientras que un fallo de escritura le pide
          // que reintente LO MISMO. Con un solo mensaje para los dos, un rechazo de la DB lo
          // mandaba a probar categorías distintas contra un problema que no era suyo.
          const resRegla = await guardarReglaComercio(usuario.id, comercioRegla, catReglaLibre, subReglaLibre);
          if (!resRegla.ok) {
            if (resRegla.motivo === 'error') {
              return 'No pude guardar la regla ahora mismo. Vuelve a intentarlo en un momento.';
            }
            // `comercioRegla` con solo espacios pasa los dos guards de arriba y muere en el
            // patrón vacío. Culpar a la categoría ahí sería mandarlo a corregir lo que no falla.
            if (resRegla.motivo === 'sin-comercio') {
              return 'Dime de qué comercio se trata. Ej: _"todo lo de Rappi siempre va en Delivery"_';
            }
            return 'Neto guarda eso dentro de *Otros*, y una regla a Otros no clasificaría nada: dejaría todos los gastos de *' + comercioRegla + '* sin categoría.\n\nDime una categoría más concreta, por ejemplo _"todo lo de ' + comercioRegla + ' va en Alimentación"_.';
          }
          const destinoRegla = resRegla.destino;
          {
            const _subR = destinoRegla.subcategoria;
            asegurarCategoriaUsuario(usuario.id, destinoRegla.categoria)
              .then(() => (_subR ? crearSubcategoriaLibreUsuario(usuario.id, destinoRegla.categoria, _subR) : null))
              .catch(() => {});
          }
          const retro = await retroaplicarRegla(usuario.id, comercioRegla, destinoRegla.categoria, destinoRegla.subcategoria);
          return '✅ *Regla creada:*\n\n' + comercioRegla + ' → *' + destinoRegla.categoria + (destinoRegla.subcategoria ? ' > ' + destinoRegla.subcategoria : '') + '* (siempre)\n\n' + (retro > 0 ? '🔄 Actualicé ' + retro + ' transacciones anteriores con esta regla.' : 'Se aplicará a las próximas transacciones.') + '\n\n_Puedes cambiarlo cuando quieras._';
        } catch(e) {
          log.error({ tag: 'REGLA_CAT', err: e.message }, 'Error editar categoría comercio');
          return 'No pude crear la regla. Intenta de nuevo.';
        }
      }

      case 'marcar_como_ingreso': {
        try {
          // Siempre el ÚLTIMO movimiento (chip 5, 01-oct-2026): `revisarEdicion` no deja pasar un
          // sujeto. La búsqueda por comercio (`ilike`) que vivía acá eligió la fila equivocada en prod
          // ("aby 143" buscó "aby", no lo halló y editó "traer tronco"); ver lib/orden-edicion.js.
          const txMarcar = await obtenerUltimaTransaccion(usuario.id);
          if (!txMarcar) return 'No hay transacciones recientes para modificar.';
          const tipoNuevo = datos.tipo_nuevo || 'ingreso';
          const { data: filasMarcar, error: errMarcar } = await supabase.from('transacciones').update({ tipo: tipoNuevo }).eq('id', txMarcar.id).select('id');
          if (errMarcar) {
            log.error({ tag: 'MARCAR_INGRESO', err: errMarcar.message, txId: txMarcar.id }, 'No se pudo cambiar el tipo');
            return 'No pude cambiar el tipo ahora mismo. Vuelve a intentarlo en un momento.';
          }
          if (!filasMarcar || filasMarcar.length === 0) {
            log.warn({ tag: 'MARCAR_INGRESO', txId: txMarcar.id }, 'El update del tipo no afectó ninguna fila');
            return 'Esa transacción ya no está. Puede que la hayas eliminado hace un momento.';
          }
          const montoMarcar = txMarcar.moneda === 'USD' ? '$' + parseFloat(txMarcar.monto).toFixed(2) : 'S/ ' + parseFloat(txMarcar.monto).toFixed(2);
          return '✅ *' + (txMarcar.comercio || 'Transacción') + '* (' + montoMarcar + ') ahora está marcado como *' + tipoNuevo + '*.\n\n_Tu balance se ha actualizado._';
        } catch(e) {
          log.error({ tag: 'MARCAR_INGRESO', err: e.message }, 'Error marcar como ingreso');
          return 'No pude cambiar el tipo. Intenta de nuevo.';
        }
      }

      default:
        return null;
    }
  }
};
module.exports.detectarQuerySinMonto = detectarQuerySinMonto;
