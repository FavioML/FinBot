const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { generarReporteJSON } = require('../reporte_html');
const { ultimoDiaMes } = require('../lib/dates');

async function generarYEnviarReporte(usuario, mes, anio) {
  const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
  const hasta = anio + '-' + String(mes).padStart(2,'0') + '-' + String(ultimoDiaMes(anio, mes)).padStart(2,'0');
  const { data: txs } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
  if (!txs || txs.length === 0) return { ok: false, msg: 'No hay transacciones registradas para ese mes.' };
  const { data: presupData } = await supabase.from('presupuestos').select('*').eq('usuario_id', usuario.id).eq('mes', mes).eq('anio', anio);
  const presupuestos = {};
  if (presupData) presupData.forEach(p => { presupuestos[p.categoria] = parseFloat(p.monto_limite); });
  const historial = [];
  for (let i = 3; i >= 1; i--) {
    const d = new Date(anio, mes - 1 - i, 1); const hm = d.getMonth()+1; const ha = d.getFullYear();
    const { data: ht } = await supabase.from('transacciones').select('monto,monto_pen,tipo').eq('usuario_id', usuario.id).gte('fecha', ha+'-'+String(hm).padStart(2,'0')+'-01').lte('fecha', ha+'-'+String(hm).padStart(2,'0')+'-'+String(ultimoDiaMes(ha,hm)).padStart(2,'0'));
    const gastos = (ht||[]).filter(t => t.tipo === 'gasto');
    const ingr = (ht||[]).filter(t => t.tipo === 'ingreso');
    const totG = gastos.reduce((s,t) => s+parseFloat(t.monto_pen||t.monto||0), 0);
    const totI = ingr.reduce((s,t) => s+parseFloat(t.monto_pen||t.monto||0), 0);
    if (totG > 0 || totI > 0) historial.push({ mes: hm, anio: ha, total: totG, totalIngresos: totI });
  }
  const { data: allMonths } = await supabase.from('transacciones').select('fecha').eq('usuario_id', usuario.id);
  const todosMeses = [];
  if (allMonths) {
    const mSet = new Set();
    allMonths.forEach(t => { const p = (t.fecha||'').split('-'); if (p.length>=2) mSet.add(p[0]+'-'+p[1]); });
    mSet.forEach(s => { const [a,m] = s.split('-').map(Number); todosMeses.push({ mes: m, anio: a }); });
  }
  const jsonData = generarReporteJSON({ nombre: usuario.nombre || 'Usuario', mes, anio, transacciones: txs, presupuestos, historialMeses: historial, todosMeses });
  const reporteId = crypto.randomUUID();
  const isPremium = usuario.plan === 'premium';
  const expiresAt = new Date(Date.now() + (isPremium ? 24 : 1) * 60 * 60 * 1000).toISOString();
  const { error: cacheErr } = await supabase.from('reporte_cache').upsert({
    id: reporteId, usuario_id: usuario.id, html: JSON.stringify(jsonData), expires_at: expiresAt
  });
  if (cacheErr) { log.error({ tag: 'REPORTE', err: cacheErr.message }, 'Error guardando cache'); }
  supabase.from('reporte_cache').delete().eq('usuario_id', usuario.id).lt('expires_at', new Date().toISOString()).then(() => {}).catch(() => {});
  return { ok: true, reporteId, txCount: txs.length };
}

module.exports = { generarYEnviarReporte };
