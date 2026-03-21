const { MESES_CORTOS, CATEGORIAS_SUGERIDAS } = require('./constants');

function formatFecha(fecha) {
  if (!fecha) return '';
  const p = String(fecha).split('-');
  if (p.length < 3) return fecha;
  const anio = p[0].length === 4 ? p[0].slice(2) : p[0];
  const mes = MESES_CORTOS[parseInt(p[1], 10) - 1] || p[1];
  return p[2] + '-' + mes + '-' + anio;
}

function barraProgreso(pct) {
  const llenos = Math.min(Math.round(pct / 10), 10);
  const vacios = 10 - llenos;
  const emoji = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
  return emoji + ' ' + '▓'.repeat(llenos) + '░'.repeat(vacios) + ' ' + Math.round(pct) + '%';
}

function getEmojiCategoria(nombre) {
  const cat = CATEGORIAS_SUGERIDAS.find(c => c.nombre.toLowerCase() === (nombre||'').toLowerCase());
  return cat ? cat.emoji : null;
}

function formatearResumen(txs, periodo) {
  if (!txs || !txs.length) return 'No hay gastos registrados ' + periodo + '.';
  const total = txs.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
  const porCat = {};
  txs.forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || t.monto || 0); });
  const txsUsd = txs.filter(t => t.moneda === 'USD');
  const totalUsd = txsUsd.reduce((s, t) => s + parseFloat(t.monto || 0), 0);
  const notaUsd = txsUsd.length > 0 ? ' (incl. USD ' + totalUsd.toFixed(2) + ')' : '';
  let msg = '📊 *' + periodo + '*\nTotal: *S/ ' + total.toFixed(2) + '*' + notaUsd + ' • ' + txs.length + ' movimientos\n\n';
  Object.entries(porCat).sort((a, b) => b[1] - a[1]).forEach(([cat, monto]) => {
    const em = getEmojiCategoria(cat) || '📋';
    msg += em + ' ' + cat + ': *S/ ' + monto.toFixed(2) + '* (' + ((monto / total) * 100).toFixed(0) + '%)\n';
  });
  return msg;
}

function formatearPendientes(consultas) {
  var ahora = Date.now();
  var items = consultas.map(function(c, i) {
    var ms = ahora - new Date(c.created_at).getTime(), horas = Math.round(ms/3600000);
    return (i+1) + '. *' + (c.banco||'Pago') + '* S/ ' + parseFloat(c.monto||0).toFixed(2) + ' (' + (c.fecha||'') + ') -- ' + (ms<3600000?'hace menos de 1h':horas<24?horas+'h atras':Math.round(horas/24)+'d atras');
  });
  return '*Tienes ' + consultas.length + ' gasto(s) sin identificar:*\n\n' + items.join('\n') + '\n\nPara categorizar responde:\n_"El 1 fue para almuerzo"_ o _"/cambiar Yape Comida"_';
}

function formatearCategoriasMsg(categorias) {
  if (!categorias || categorias.length === 0) {
    return '*No tienes categorias personalizadas.*\n\nResponde con los numeros para activar:\n\n' + CATEGORIAS_SUGERIDAS.map(function(c,i){ return (i+1)+'. '+c.emoji+' '+c.nombre; }).join('\n') + '\n\n_(ej: 1 3 5 o "todas")_';
  }
  var msg = '*Tus categorias activas:*\n\n';
  for (var ci = 0; ci < categorias.length; ci++) {
    var cat = categorias[ci];
    msg += cat.emoji + ' *' + cat.nombre + '*';
    if (cat.subcategorias && cat.subcategorias.length > 0) msg += '\n   -> ' + cat.subcategorias.map(function(s){ return s.nombre; }).join(', ');
    msg += '\n';
  }
  msg += '\n*/categorias agregar* -- activar mas categorias';
  return msg;
}

function parsearIndicesRespuesta(texto, max) {
  const t = texto.trim().toLowerCase();
  if (t === 'todas' || t === 'all') return Array.from({length: max}, (_,i) => i+1);
  const nums = t.split(/\s+/).map(Number).filter(n => n >= 1 && n <= max && !isNaN(n));
  return [...new Set(nums)];
}

function generarRefCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

module.exports = {
  formatFecha, barraProgreso, getEmojiCategoria,
  formatearResumen, formatearPendientes, formatearCategoriasMsg,
  parsearIndicesRespuesta, generarRefCode,
};
