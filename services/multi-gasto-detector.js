// Detector regex conservador de mensajes que listan 2+ gastos explícitos.
// Activa solo con verbo de gasto + 2+ pares (monto + en/de/por + sustantivo) + separador (y / coma).
// Bypass al OpenAI Function Calling para evitar el bug de tool_calls[0]-only.
// Cobertura objetivo: mlt-001 ('gasté 50 en taxi y 30 en almuerzo'), mlt-002 ('hoy 80 de luz, 50 de agua y 200 de internet').
//
// detectarIngresoMasGastos cubre el caso heterogéneo de un ingreso seguido de lista de gastos
// (str-006: "Ingresé 1000 lucas esta mañana, gasté 100 el almuerzo, 200 en ropa y 50 en taxi").

// \b en JS regex es ASCII-only: rompe cuando la palabra termina en char unicode (é/ó/etc).
// Usamos boundary manual: inicio-de-string|espacio antes, espacio|fin-de-string después.
const VERBO_GASTO = /(?:^|\s)(gast[eé]|gaste|pagu[eé]|compr[eé]|hoy|ayer)(?:\s|$|,)/i;
// Comercios deben ser 2+ chars para evitar capturar conectores como "y" como segunda palabra.
const RE_PAR = /(\d+(?:[.,]\d{1,2})?)\s+(?:soles?\s+)?(?:en|de|por)\s+([a-záéíóúñü]{2,}(?:\s+[a-záéíóúñü]{2,})?)/gi;

// Prefix de ingreso en posición inicial: cubre verbo (ingresé/gané/cobré/recibí) y sustantivo (ingreso).
// El "soles?|lucas|cocos|mangos|mortadelos" después del monto es opcional para tolerar jerga.
const RE_INCOME_PREFIX = /^\s*(ingres[eéo]|ingreso|gan[eé]|gano|cobr[eé]|cobro|recib[ií]|recibo)\s+(?:s\/)?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:soles?|lucas|cocos|mangos|mortadelos|d[oó]lares?|usd)?\b/i;
// Pares de gasto en el resto del msg, con conectores extendidos para tolerar artículo
// elidido ("100 el almuerzo"). Solo se usa en el path income+expenses.
const RE_PAR_HETERO = /(\d+(?:[.,]\d{1,2})?)\s+(?:soles?\s+)?(?:en|de|por|el|la|los|las|al)\s+([a-záéíóúñü]{2,}(?:\s+[a-záéíóúñü]{2,})?)/gi;
const VERBO_GASTO_HETERO = /(?:^|\s)(gast[eé]|gaste|pagu[eé]|compr[eé])(?:\s|$|,)/i;

function detectarMultiGasto(msg) {
  if (!msg || typeof msg !== 'string') return null;
  const m = msg.toLowerCase().trim();
  if (!VERBO_GASTO.test(m)) return null;
  if (!/,|\s+y\s+/.test(m)) return null;
  const items = [];
  let match;
  RE_PAR.lastIndex = 0;
  while ((match = RE_PAR.exec(m)) !== null) {
    const monto = parseFloat(match[1].replace(',', '.'));
    if (Number.isFinite(monto) && monto > 0 && monto < 1000000) {
      items.push({ monto, comercio: match[2].trim() });
    }
  }
  return items.length >= 2 ? items : null;
}

// Devuelve { income: { monto }, expenses: [{ monto, comercio }, ...] } cuando el msg comienza
// con un prefijo de ingreso seguido de 2+ gastos. Si solo hay 1 gasto (o ninguno), retorna null
// para que el flujo normal (clasificador OpenAI + splitter) maneje el caso single-intent.
function detectarIngresoMasGastos(msg) {
  if (!msg || typeof msg !== 'string') return null;
  const m = msg.toLowerCase().trim();
  const mPrefix = RE_INCOME_PREFIX.exec(m);
  if (!mPrefix) return null;
  const incomeMonto = parseFloat(mPrefix[2].replace(',', '.'));
  if (!Number.isFinite(incomeMonto) || incomeMonto <= 0 || incomeMonto >= 1000000) return null;
  const resto = m.slice(mPrefix[0].length).trim();
  if (!resto || resto.length < 4) return null;
  if (!VERBO_GASTO_HETERO.test(resto)) return null;
  const expenses = [];
  let mP;
  RE_PAR_HETERO.lastIndex = 0;
  while ((mP = RE_PAR_HETERO.exec(resto)) !== null) {
    const monto = parseFloat(mP[1].replace(',', '.'));
    if (Number.isFinite(monto) && monto > 0 && monto < 1000000) {
      expenses.push({ monto, comercio: mP[2].trim() });
    }
  }
  if (expenses.length < 2) return null;
  return { income: { monto: incomeMonto }, expenses };
}

module.exports = { detectarMultiGasto, detectarIngresoMasGastos };
