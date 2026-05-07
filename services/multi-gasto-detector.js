// Detector regex conservador de mensajes que listan 2+ gastos explícitos.
// Activa solo con verbo de gasto + 2+ pares (monto + en/de/por + sustantivo) + separador (y / coma).
// Bypass al OpenAI Function Calling para evitar el bug de tool_calls[0]-only.
// Cobertura objetivo: mlt-001 ('gasté 50 en taxi y 30 en almuerzo'), mlt-002 ('hoy 80 de luz, 50 de agua y 200 de internet').

const VERBO_GASTO = /\b(gast[eé]|gaste|pagu[eé]|compr[eé]|hoy|ayer)\b/i;
const RE_PAR = /(\d+(?:[.,]\d{1,2})?)\s+(?:soles?\s+)?(?:en|de|por)\s+([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+)?)/gi;

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

module.exports = { detectarMultiGasto };
