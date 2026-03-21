const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = require('./constants');

function validarMonto(valor) {
  const n = parseFloat(valor);
  if (isNaN(n) || !isFinite(n) || n < 0 || n > 999999.99) return null;
  return Math.round(n * 100) / 100;
}

function normalizarCategoria(cat) {
  if (!cat) return 'Otros';
  const mapped = CATEGORIA_MAP[cat];
  if (mapped) return mapped;
  if (CATEGORIAS_VALIDAS.has(cat)) return cat;
  const cap = cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
  if (CATEGORIAS_VALIDAS.has(cap)) return cap;
  return 'Otros';
}

module.exports = { validarMonto, normalizarCategoria };
