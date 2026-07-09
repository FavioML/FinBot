const { supabase } = require('../lib/db');
const { barraProgreso } = require('../lib/formatters');
const { hoyPeru } = require('../lib/dates');

function _mesAnioPeru() {
  const parts = hoyPeru().split('-');
  return { mes: parseInt(parts[1], 10), anio: parseInt(parts[0], 10), primero: parts[0] + '-' + parts[1] + '-01' };
}

// Las categorías a veces se guardan con tilde ('Alimentación') y otras sin ('Alimentacion').
// Para filtros y matching usamos versión normalizada (sin tildes, lowercase).
function _normCat(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

async function guardarPresupuesto(usuarioId, categoria, monto) {
  const { mes, anio } = _mesAnioPeru();
  const { data, error } = await supabase.from('presupuestos').upsert({
    usuario_id: usuarioId, categoria, monto_limite: monto,
    mes, anio
  }, { onConflict: 'usuario_id,categoria,subcategoria,mes,anio' }).select().single();
  if (error) throw error;
  return data;
}

async function obtenerPresupuestosMes(usuarioId) {
  const { mes, anio } = _mesAnioPeru();
  const { data } = await supabase.from('presupuestos').select('*').eq('usuario_id', usuarioId)
    .eq('mes', mes).eq('anio', anio);
  return data || [];
}

async function verificarAlertaPresupuesto(usuarioId, categoria, subcategoria) {
  const { mes, anio, primero } = _mesAnioPeru();
  const alertas = [];
  const catNorm = _normCat(categoria);

  // Buscar presupuesto y transacciones tolerando mismatch de tilde entre Alimentación / Alimentacion
  const [{ data: presupuestosMes }, { data: gastosMes }] = await Promise.all([
    supabase.from('presupuestos').select('*')
      .eq('usuario_id', usuarioId).eq('mes', mes).eq('anio', anio),
    supabase.from('transacciones').select('monto,monto_pen,categoria,subcategoria')
      .eq('usuario_id', usuarioId).eq('tipo', 'gasto').gte('fecha', primero),
  ]);

  const presCat = (presupuestosMes || []).find(p => _normCat(p.categoria) === catNorm && !p.subcategoria);
  if (presCat) {
    const totalCat = (gastosMes || [])
      .filter(t => _normCat(t.categoria) === catNorm)
      .reduce((s, t) => s + parseFloat(t.monto_pen ?? t.monto), 0);
    const limiteCat = parseFloat(presCat.monto_limite);
    const pctCat = (totalCat / limiteCat) * 100;
    if (pctCat >= 100) alertas.push('🚨 Limite de *' + categoria + '* superado: S/ ' + totalCat.toFixed(2) + ' / S/ ' + limiteCat.toFixed(2));
    else if (pctCat >= (presCat.alerta_porcentaje || 80)) alertas.push('⚠️ *' + categoria + '*: llevas S/ ' + totalCat.toFixed(2) + ' de S/ ' + limiteCat.toFixed(2) + ' (' + pctCat.toFixed(0) + '%)');
  }

  if (subcategoria) {
    const subNorm = _normCat(subcategoria);
    const presSub = (presupuestosMes || []).find(p => _normCat(p.categoria) === catNorm && _normCat(p.subcategoria) === subNorm);
    if (presSub) {
      const totalSub = (gastosMes || [])
        .filter(t => _normCat(t.categoria) === catNorm && _normCat(t.subcategoria) === subNorm)
        .reduce((s, t) => s + parseFloat(t.monto_pen ?? t.monto), 0);
      const limiteSub = parseFloat(presSub.monto_limite);
      const pctSub = (totalSub / limiteSub) * 100;
      if (pctSub >= 100) alertas.push('🚨 Limite de *' + subcategoria + '* superado: S/ ' + totalSub.toFixed(2) + ' / S/ ' + limiteSub.toFixed(2));
      else if (pctSub >= (presSub.alerta_porcentaje || 80)) alertas.push('⚠️ *' + subcategoria + '*: llevas S/ ' + totalSub.toFixed(2) + ' de S/ ' + limiteSub.toFixed(2) + ' (' + pctSub.toFixed(0) + '%)');
    }
  }
  return alertas.length > 0 ? alertas.join('\n') : null;
}

async function formatearEstadoPresupuesto(usuarioId) {
  const presupuestos = await obtenerPresupuestosMes(usuarioId);
  if (!presupuestos.length) return 'No tienes presupuestos configurados.\n\nEj: _"pon limite de 500 en Comida"_';
  const { primero } = _mesAnioPeru();
  const MESES_LARGO = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const mesNombre = MESES_LARGO[parseInt(primero.split('-')[1], 10) - 1];
  // Una sola query del mes; filtrado por categoría se hace en JS con normalización tilde-insensible
  const { data: allTxs } = await supabase.from('transacciones').select('monto,monto_pen,categoria')
    .eq('usuario_id', usuarioId).eq('tipo', 'gasto').gte('fecha', primero);
  let msg = '*Tu presupuesto de ' + mesNombre + '*\n---------------\n\n';
  for (const p of presupuestos) {
    const catNorm = _normCat(p.categoria);
    const gastado = (allTxs || [])
      .filter(t => _normCat(t.categoria) === catNorm)
      .reduce((s, t) => s + parseFloat(t.monto_pen ?? t.monto), 0);
    const limite = parseFloat(p.monto_limite);
    const pct = (gastado / limite) * 100;
    msg += '*' + p.categoria + '*\n' + barraProgreso(pct) + '\nS/ ' + gastado.toFixed(2) + ' / S/ ' + limite.toFixed(2) + ' (resta S/ ' + Math.max(limite - gastado, 0).toFixed(2) + ')\n\n';
  }
  return msg;
}

module.exports = {
  guardarPresupuesto, obtenerPresupuestosMes,
  verificarAlertaPresupuesto, formatearEstadoPresupuesto,
};
