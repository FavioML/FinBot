const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = require('./constants');

function validarMonto(valor) {
  const n = parseFloat(valor);
  if (isNaN(n) || !isFinite(n) || n <= 0 || n > 999999.99) return null;
  return Math.round(n * 100) / 100;
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
