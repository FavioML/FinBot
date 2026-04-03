const { supabase } = require('../lib/db');
const { barraProgreso } = require('../lib/formatters');
const { hoyPeru } = require('../lib/dates');

function _mesAnioPeru() {
  const parts = hoyPeru().split('-');
  return { mes: parseInt(parts[1], 10), anio: parseInt(parts[0], 10), primero: parts[0] + '-' + parts[1] + '-01' };
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

  // Fetch budget + transactions in parallel to minimize race window
  const [{ data: presCat }, { data: txsCat }] = await Promise.all([
    supabase.from('presupuestos').select('*')
      .eq('usuario_id', usuarioId).eq('categoria', categoria)
      .is('subcategoria', null).eq('mes', mes).eq('anio', anio).single(),
    supabase.from('transacciones').select('monto')
      .eq('usuario_id', usuarioId).eq('categoria', categoria).eq('tipo', 'gasto').gte('fecha', primero),
  ]);

  if (presCat) {
    const totalCat = (txsCat||[]).reduce((s,t)=>s+parseFloat(t.monto),0);
    const limiteCat = parseFloat(presCat.monto_limite);
    const pctCat = (totalCat/limiteCat)*100;
    if (pctCat>=100) alertas.push('🚨 Limite de *'+categoria+'* superado: S/ '+totalCat.toFixed(2)+' / S/ '+limiteCat.toFixed(2));
    else if (pctCat>=(presCat.alerta_porcentaje||80)) alertas.push('⚠️ *'+categoria+'*: llevas S/ '+totalCat.toFixed(2)+' de S/ '+limiteCat.toFixed(2)+' ('+pctCat.toFixed(0)+'%)');
  }

  if (subcategoria) {
    const [{ data: presSub }, { data: txsSub }] = await Promise.all([
      supabase.from('presupuestos').select('*')
        .eq('usuario_id', usuarioId).eq('categoria', categoria).eq('subcategoria', subcategoria)
        .eq('mes', mes).eq('anio', anio).single(),
      supabase.from('transacciones').select('monto')
        .eq('usuario_id', usuarioId).eq('categoria', categoria).eq('subcategoria', subcategoria).eq('tipo', 'gasto').gte('fecha', primero),
    ]);
    if (presSub) {
      const totalSub = (txsSub||[]).reduce((s,t)=>s+parseFloat(t.monto),0);
      const limiteSub = parseFloat(presSub.monto_limite);
      const pctSub = (totalSub/limiteSub)*100;
      if (pctSub>=100) alertas.push('🚨 Limite de *'+subcategoria+'* superado: S/ '+totalSub.toFixed(2)+' / S/ '+limiteSub.toFixed(2));
      else if (pctSub>=(presSub.alerta_porcentaje||80)) alertas.push('⚠️ *'+subcategoria+'*: llevas S/ '+totalSub.toFixed(2)+' de S/ '+limiteSub.toFixed(2)+' ('+pctSub.toFixed(0)+'%)');
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
  let msg = '*Tu presupuesto de ' + mesNombre + '*\n---------------\n\n';
  for (const p of presupuestos) {
    const { data: txs } = await supabase.from('transacciones').select('monto')
      .eq('usuario_id', usuarioId).eq('categoria', p.categoria).eq('tipo', 'gasto').gte('fecha', primero);
    const gastado = (txs || []).reduce((s, t) => s + parseFloat(t.monto), 0);
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
