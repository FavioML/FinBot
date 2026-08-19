// Detector de multi-intent heterogéneos (mlt-003/004/005/006).
// El detector multi-gasto cubre listas homogéneas de gastos (mlt-001/002).
// Este módulo cubre los compuestos mixtos:
//   (a) register + query    (mlt-003: "gasté 100 en comida y cuánto llevo este mes")
//   (b) register + edit     (mlt-004: "registra 50 en taxi hoy pero también edita el de ayer a 90")
//   (c) delete + register   (mlt-005: "borra el último y registra 100 en comida")
//   (d) register + register (mlt-006: "Ingreso 1000 cocos el próximo viernes y gasto 1000 cocos el otro viernes")
// Estrategia: post-handler hook. El primer intent ya fue clasificado y dispatched por
// OpenAI; detectamos si la parte después de la conjunción tiene un intent distinto y
// lo despachamos vía el intent-registry. Cero cambios al system prompt de OpenAI.

const CONJUNCION = /\s+(?:pero\s+tambi[eé]n|y\s+tambi[eé]n|pero|y|luego|despu[eé]s)\s+/i;

// Igual que CONJUNCION pero admite además la COMA y el punto y coma, porque "Gasté 20 en
// Movilidad, cuánto llevo hoy" es exactamente la misma frase compuesta que "... y cuánto
// llevo hoy" y CONJUNCION no la ve. Se usa SOLO en `partirEscrituraLectura`, nunca en
// `detectarContinuacion` a secas: la coma aparece dentro de listas de compras ("compré 3
// panes, 2 leches"), así que como separador general produciría cortes absurdos.
//
// ⚠️ `(?<!\d),(?!\d)` — LA COMA DECIMAL NO SEPARA NADA, y esto no es una precaución teórica:
// sin los dos lookarounds, "Gasté 1,50 en pan, cuánto llevo hoy" se cortaba en la PRIMERA
// coma, que es la del decimal. La mitad de escritura quedaba en "Gasté 1" y se registraba
// **S/1.00 con un ✅ encima**, en vez de S/1.50. Medido también con "gasté 12,90 en menú"
// (→ S/12) y "Pagué 45,50 en farmacia" (→ S/45).
//
// Es estrictamente PEOR que el bug que este módulo viene a arreglar: perder el gasto es
// visible y la persona lo reescribe; cobrarle un tercio del monto con una confirmación
// arriba no lo es. Y no hacía falta que el parser fallara — el corte ocurre ANTES, así que
// `parsearRegistroManual` recibía "Gasté 1" y devolvía 1, correctamente.
//
// Lo encontró la revisión adversarial. Mis 18 controles no podían verlo: el negativo que
// decía cuidar este caso era "Gasté 1,50 en pan" SIN pregunta, o sea que la función lo
// rechazaba por no tener mitad de lectura y el motivo declarado en el test era falso. Y el
// pool de 510 casos tiene CERO mensajes con coma decimal, así que "0 se parten" tampoco
// podía medir esta clase.
const SEP_MIXTO = /\s*(?:(?<!\d),(?!\d)|;|\s+(?:pero\s+tambi[eé]n|y\s+tambi[eé]n|pero|y|luego|despu[eé]s)\s+)\s*/i;

const RE_REGISTER_PART = /^\s*(?:registra|anota|gast[eé]|gaste|pagu[eé]|compr[eé])\s+(?:s\/)?\s*\d+/i;
// Cubre verbos/sustantivos de registro de TX en cualquier dirección (gasto o ingreso).
// Usado en (d) cuando el primer intent ya fue un registrar_manual y parte2 es otro registro.
const RE_TX_PART = /^\s*(?:registra|anota|gast[eé]|gaste|gasto|pagu[eé]|compr[eé]|ingres[eéo]|ingreso|gan[eé]|gano|cobr[eé]|cobro|recib[ií]|recibo)\s+(?:s\/)?\s*\d+/i;
const RE_EDIT_PART = /^(?:tambi[eé]n\s+)?(?:edita|corrige|cambia|cambialo|p[oó]nlo|m[oó]dificalo|act[uú]al[ií]za[lo]?)\s/i;
const RE_FECHA_REF = /\bel\s+de\s+(ayer|hoy|antier|anteayer)\b/i;
const RE_MONTO_NUEVO = /\sa\s+(?:s\/)?\s*(\d+(?:[.,]\d{1,2})?)\b/i;

/**
 * ¿Este mensaje es un gasto Y una consulta pegados? Devuelve las dos mitades, o null.
 *
 * Existe porque `detectarQuerySinMonto` responde sobre el mensaje ENTERO, y ante
 * "Gasté 20 en Movilidad, cuánto llevo hoy" contesta "esto es una consulta" cuando la
 * respuesta verdadera es "esto CONTIENE una consulta, y también contiene un gasto". Con esa
 * respuesta, el redirect de `registrar_manual` se comía el mensaje completo: la persona
 * perdía el gasto y —si estaba en el muro— recibía un pedido de plata en su lugar. O sea que
 * se le cortaba una ESCRITURA, contra la única regla que no se negocia.
 *
 * NO alcanza con que el rescate determinístico corra antes del redirect, y esa idea hay que
 * descartarla por DOS razones, no una: además de abrir el agujero conocido (un fallo de red
 * del dispatch convertiría una consulta en un gasto, ver docs/DEFECTOS.md), no funcionaría.
 * Medido el 2026-08-18: `extraerGastoSinIA('Gasté 20 en Movilidad, cuánto llevo hoy')`
 * devuelve **null**, mientras que sobre la mitad sola devuelve el gasto. El extractor tampoco
 * sabe leer el compuesto. Hay que partir primero; no hay atajo.
 *
 * ── La regla, y por qué es esta ──────────────────────────────────────────────
 * Se exige que DOS reconocedores distintos e independientes estén de acuerdo:
 *   · la mitad de lectura la tiene que reconocer `detectarQuerySinMonto`,
 *   · la de escritura tiene que rendir un gasto en `extraerGastoSinIA`,
 *   · y la de escritura NO puede ser también una consulta.
 *
 * Una sola señal no alcanza porque acá se está decidiendo ESCRIBIR PLATA a partir de un
 * regex. La diferencia con el defecto que este repo ya pagó es el TIPO de evidencia: allá la
 * razón para registrar era que el dispatch de la consulta había fallado (o sea, ausencia de
 * evidencia contraria); acá es el reconocimiento POSITIVO de un gasto en un tramo que no es
 * la consulta, tomado ANTES de intentar ningún dispatch. Por eso este sí puede correr antes.
 *
 * Se heredan las guardas del rescate (`intents/transacciones.js`), pero OJO con dónde se
 * aplican: la del conteo de montos va sobre el mensaje entero, no sobre la mitad de escritura
 * — ver el comentario pegado a esa línea, que es donde se pagó el precio.
 *
 * Lo que NO cubre, y se deja escrito para que no se descubra dos veces: `extraerGastoSinIA` no
 * entiende la negación, así que "no gasté 20 en taxi, cuánto llevo hoy" parte y produciría un
 * gasto de S/20 con comercio "no taxi". Es la misma exposición que ya tiene el rescate sobre
 * ese texto, no una que abra este módulo; y agregarle un regex de negación sin haber medido
 * que a alguien le pasa es justo el tipo de guarda que después se come mensajes legítimos.
 *
 * Costo medido sobre `tests/nlp/pool.js` (510 casos reales): **0 mensajes se parten**, o sea
 * cero falsos positivos. Los controles positivos y negativos viven en
 * `tests/services/multi-intent-mixto.test.js`. Un cero sin control positivo al lado sería
 * verde por vacuidad: lo cumpliría igual una función que devuelve null siempre — y un
 * NEGATIVO sin verificar POR QUÉ rechaza también, que es exactamente cómo se coló la coma
 * decimal: el control existía, pasaba, y rechazaba por otra condición.
 *
 * @returns {{parte1: string, parte2: string, intencionLectura: string, datosLectura: object}|null}
 */
function partirEscrituraLectura(msg) {
  if (!msg || typeof msg !== 'string') return null;
  const m = msg.match(SEP_MIXTO);   // regex sin flag `g`: devuelve lo mismo que .exec(), con .index
  if (!m) return null;
  const parte1 = msg.slice(0, m.index).trim();
  const parte2 = msg.slice(m.index + m[0].length).trim();
  if (parte1.length < 4 || parte2.length < 4) return null;

  // Require perezoso porque los dos módulos se requieren mutuamente en tiempo de LLAMADA;
  // al tope acoplaría este módulo a la cadena entera de handlers al cargar. El `catch` NO
  // devuelve null en silencio: un fallo acá apaga la corrección ENTERA (se probó sin las env
  // vars y las 14 entradas volvieron null, positivos incluidos, sin una sola línea de log)
  // y eso degrada al bug original sin señal. Se loguea y recién ahí se sale.
  let detectarQuerySinMonto, extraerGastoSinIA, contarMontosCandidatos;
  try {
    ({ detectarQuerySinMonto } = require('../handlers/intents/transacciones'));
    ({ extraerGastoSinIA, contarMontosCandidatos } = require('../lib/nlp-guards'));
  } catch (e) {
    require('../lib/logger').warn({ tag: 'MSG_MIXTO', err: e.message },
      'No se pudieron cargar los reconocedores: el mensaje mixto queda sin partir');
    return null;
  }
  if (typeof detectarQuerySinMonto !== 'function') return null;

  const q = detectarQuerySinMonto(parte2);
  if (!q) return null;                             // la mitad 2 tiene que ser una consulta...
  if (detectarQuerySinMonto(parte1)) return null;  // ...y la mitad 1 NO puede serlo también

  // El conteo va sobre el mensaje ENTERO, NO sobre `parte1`, y ésta es la corrección que más
  // importa de todo el módulo: **el corte MUEVE los montos sobrantes a `parte2`, donde nadie
  // los estaba contando.** Con la guarda puesta sobre `parte1` alcanzaba con que el separador
  // cayera antes del segundo monto para que pasara:
  //
  //   "pagué 15 taxi, 40 cena, cuánto llevo hoy"  → parte1 "pagué 15 taxi": 1 monto, pasaba
  //                                                 → registraba S/15 y los 40 desaparecían
  //   "Compré 3 panes, 2 leches y una gaseosa, cuánto llevo hoy" → registraba S/3 en "panes"
  //
  // Sobre el mensaje entero los dos dan 2 y quedan afuera, mientras que los siete casos
  // legítimos dan 1 y siguen pasando. `detectarMultiGasto` no intercepta ninguno de los dos
  // (exige verbo + preposición), así que acá no hay red debajo.
  if (contarMontosCandidatos(msg) !== 1) return null;
  const gasto = extraerGastoSinIA(parte1);
  if (!gasto) return null;

  return { parte1, parte2, intencionLectura: q.intencion, datosLectura: q.datos || {} };
}

function detectarContinuacion(msg, intencionPrimera) {
  if (!msg || typeof msg !== 'string') return null;
  if (!intencionPrimera) return null;

  // (a-bis) gasto + consulta, incluida la separada por COMA, que CONJUNCION no ve y que por
  // eso nunca llegaba a (a). Va PRIMERO, y no rompe nada de lo de abajo: al exigir que las dos
  // mitades se reconozcan solas, `partirEscrituraLectura` es estrictamente más exigente que
  // (a), así que cuando dice que sí es el mismo caso con más evidencia, y cuando dice que no,
  // el camino de siempre sigue corriendo igual.
  if (intencionPrimera === 'registrar_manual') {
    const mixto = partirEscrituraLectura(msg);
    if (mixto) return { intencion: mixto.intencionLectura, datos: mixto.datosLectura, parte2: mixto.parte2 };
  }

  const conjMatch = CONJUNCION.exec(msg);
  if (!conjMatch) return null;
  const parte2 = msg.slice(conjMatch.index + conjMatch[0].length).trim();
  if (!parte2 || parte2.length < 4) return null;

  if (intencionPrimera === 'registrar_manual') {
    // (a) register + query — reusa detectarQuerySinMonto (cubre llev[oó]/he gastado/saldo/categoría/etc)
    try {
      const { detectarQuerySinMonto } = require('../handlers/intents/transacciones');
      if (typeof detectarQuerySinMonto === 'function') {
        const q = detectarQuerySinMonto(parte2);
        if (q) return { intencion: q.intencion, datos: q.datos || {}, parte2 };
      }
    } catch(_) { /* lazy require fail safe */ }

    // (b) register + edit — "edita/corrige/cambia ... a NUMBER" con referencia opcional "el de ayer/hoy"
    if (RE_EDIT_PART.test(parte2)) {
      const mNuevo = RE_MONTO_NUEVO.exec(parte2);
      if (mNuevo) {
        const monto_nuevo = parseFloat(mNuevo[1].replace(',', '.'));
        if (Number.isFinite(monto_nuevo) && monto_nuevo > 0) {
          const datos = { monto_nuevo };
          const fechaRef = RE_FECHA_REF.exec(parte2);
          if (fechaRef) datos.fecha_token = fechaRef[1].toLowerCase();
          return { intencion: 'editar_monto', datos, parte2 };
        }
      }
    }

    // (d) register + register — heterogéneo income+expense o expense+income en un solo msg
    // (mlt-006: "Ingreso 1000 cocos el próximo viernes y gasto 1000 cocos el otro viernes").
    // Reusamos el handler registrar_manual con parte2 como msg; el parser OpenAI infiere
    // tipo (gasto/ingreso) desde el verbo/sustantivo inicial.
    if (RE_TX_PART.test(parte2)) {
      return { intencion: 'registrar_manual', datos: {}, parte2 };
    }
  }

  if (intencionPrimera === 'eliminar_transaccion' || intencionPrimera === 'deshacer_ultimo') {
    // (c) delete + register — el handler register parsea parte2 con parsearRegistroManual
    if (RE_REGISTER_PART.test(parte2)) {
      return { intencion: 'registrar_manual', datos: {}, parte2 };
    }
  }

  return null;
}

module.exports = { detectarContinuacion, partirEscrituraLectura };
