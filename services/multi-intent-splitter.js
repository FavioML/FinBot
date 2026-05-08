// Detector de multi-intent heterogéneos (mlt-003/004/005).
// El detector multi-gasto cubre listas homogéneas de gastos (mlt-001/002).
// Este módulo cubre los compuestos mixtos:
//   (a) register + query   (mlt-003: "gasté 100 en comida y cuánto llevo este mes")
//   (b) register + edit    (mlt-004: "registra 50 en taxi hoy pero también edita el de ayer a 90")
//   (c) delete + register  (mlt-005: "borra el último y registra 100 en comida")
// Estrategia: post-handler hook. El primer intent ya fue clasificado y dispatched por
// OpenAI; detectamos si la parte después de la conjunción tiene un intent distinto y
// lo despachamos vía el intent-registry. Cero cambios al system prompt de OpenAI.

const CONJUNCION = /\s+(?:pero\s+tambi[eé]n|y\s+tambi[eé]n|pero|y|luego|despu[eé]s)\s+/i;

const RE_REGISTER_PART = /^\s*(?:registra|anota|gast[eé]|gaste|pagu[eé]|compr[eé])\s+(?:s\/)?\s*\d+/i;
const RE_EDIT_PART = /^(?:tambi[eé]n\s+)?(?:edita|corrige|cambia|cambialo|p[oó]nlo|m[oó]dificalo|act[uú]al[ií]za[lo]?)\s/i;
const RE_FECHA_REF = /\bel\s+de\s+(ayer|hoy|antier|anteayer)\b/i;
const RE_MONTO_NUEVO = /\sa\s+(?:s\/)?\s*(\d+(?:[.,]\d{1,2})?)\b/i;

function detectarContinuacion(msg, intencionPrimera) {
  if (!msg || typeof msg !== 'string') return null;
  if (!intencionPrimera) return null;

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
  }

  if (intencionPrimera === 'eliminar_transaccion' || intencionPrimera === 'deshacer_ultimo') {
    // (c) delete + register — el handler register parsea parte2 con parsearRegistroManual
    if (RE_REGISTER_PART.test(parte2)) {
      return { intencion: 'registrar_manual', datos: {}, parte2 };
    }
  }

  return null;
}

module.exports = { detectarContinuacion };
