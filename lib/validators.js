const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = require('./constants');

/**
 * Monto de dinero válido, o null.
 *
 * `permitirCero` existe para los saldos y las cortesías: `pagos.monto` guarda S/0
 * cuando se concede Pro sin cobrar, y ese 0 es un dato real, no un monto inválido. Es
 * el mismo parámetro que el espejo de la webapp (`webapp/src/lib/money.ts`,
 * `allowZero`) ya tenía; acá faltaba, y sin él la única forma de escribir un 0
 * legítimo era saltarse el validador — que es exactamente lo que estaba pasando.
 *
 * El default sigue siendo estricto (`> 0`): un movimiento de S/0 no es un movimiento.
 */
function validarMonto(valor, { permitirCero = false } = {}) {
  const crudo = parseFloat(valor);
  if (isNaN(crudo) || !isFinite(crudo) || crudo > 999999.99) return null;
  // Se REDONDEA antes de decidir el signo, y el orden importa: al revés, todo lo que
  // caía en (0, 0.005) pasaba el `> 0` y salía redondeado a **0**, o sea que esta
  // función devolvía exactamente el valor que su contrato dice que rechaza. Con eso
  // `POST /api/transactions {"monto": 0.001}` insertaba una transacción de S/0, y en
  // deudas el MISMO valor daba dos respuestas distintas (el handler lo aceptaba como 0
  // y el servicio lo rechazaba, saliendo como caída de backend). Lo encontró la segunda
  // revisión adversarial; `qa-money-edge` no podía verlo porque prueba el literal `0`.
  const redondeado = Math.round(crudo * 100) / 100;
  // `-0.001` redondea a `-0`, que pasa el `< 0` pero NO es `0` para `Object.is` ni para
  // un test estricto. Se normaliza acá para que la función tenga una sola representación
  // del cero y nadie tenga que acordarse río abajo.
  const n = redondeado === 0 ? 0 : redondeado;
  if (permitirCero ? n < 0 : n <= 0) return null;
  return n;
}

function normalizarCategoria(cat) {
  if (!cat) return 'Otros';
  // Búsqueda exacta en mapa
  const mapped = CATEGORIA_MAP[cat];
  if (mapped) return mapped;
  if (CATEGORIAS_VALIDAS.has(cat)) return cat;
  // Capitalizado
  const cap = cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
  const mappedCap = CATEGORIA_MAP[cap];
  if (mappedCap) return mappedCap;
  if (CATEGORIAS_VALIDAS.has(cap)) return cap;
  // Lowercase (cubre "ALIMENTACION" → "alimentacion" → mapa)
  const lower = cat.toLowerCase();
  const mappedLower = CATEGORIA_MAP[lower];
  if (mappedLower) return mappedLower;
  // Accent-insensitive: quitar acentos y buscar en el set
  const sinAcentos = cap.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const valida of CATEGORIAS_VALIDAS) {
    if (valida.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === sinAcentos) return valida;
  }
  return 'Otros';
}

module.exports = { validarMonto, normalizarCategoria };
