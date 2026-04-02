const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { verificarAlertaPresupuesto } = require('./budget');
const { crearNotificacion } = require('../lib/notifications-db');

async function enviarAlertaTransaccion(usuario, tx, resultado) {
  if (!tx || !resultado || !resultado.monto) return;
  const monto = parseFloat(resultado.monto);
  const comercio = resultado.comercio || resultado.banco || 'Sin nombre';
  const categoria = resultado.categoria || 'Otros';
  const tipo = resultado.tipo || 'gasto';
  const emoji = tipo === 'ingreso' ? '\uD83D\uDCB5' : '\uD83D\uDCB8';
  const tipoStr = tipo === 'ingreso' ? 'Ingreso recibido' : 'Nuevo gasto';

  const monedaTx = resultado.moneda || 'PEN';
  let montoStr;
  if (monedaTx === 'USD') {
    const montoPen = tx.monto_pen ? parseFloat(tx.monto_pen) : null;
    montoStr = '*$' + monto.toFixed(2) + '*' + (montoPen ? ' (~S/' + montoPen.toFixed(2) + ')' : '');
  } else {
    montoStr = '*S/' + monto.toFixed(2) + '*';
  }

  let msg = emoji + ' *' + tipoStr + '*\n';
  msg += '\uD83C\uDFEA ' + comercio + '\n';
  msg += '\uD83D\uDCB0 ' + montoStr + '\n';
  msg += '\uD83C\uDFF7\uFE0F ' + categoria + (resultado.subcategoria && resultado.subcategoria !== 'sin_categoria' ? ' > ' + resultado.subcategoria : '') + '\n';
  msg += '\uD83D\uDCC5 ' + (resultado.fecha || hoyPeru());

  if (tipo === 'gasto') {
    const alertaPres = await verificarAlertaPresupuesto(usuario.id, categoria, resultado.subcategoria || null);
    if (alertaPres) msg += '\n\n' + alertaPres;
  }

  if (tipo === 'gasto') {
    try {
      const hace28 = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const { data: historial } = await supabase.from('transacciones')
        .select('monto')
        .eq('usuario_id', usuario.id)
        .eq('tipo', 'gasto')
        .ilike('categoria', '%' + categoria + '%')
        .gte('fecha', hace28)
        .neq('id', tx.id);
      if (historial && historial.length >= 3) {
        const promedio = historial.reduce((s, t) => s + parseFloat(t.monto), 0) / historial.length;
        const factor = monto / promedio;
        if (factor >= 2.5 && monto > 30) {
          msg += '\n\n\u26A0\uFE0F *Gasto inusual:* Este gasto es ' + factor.toFixed(1) + 'x tu promedio en ' + categoria + ' (S/ ' + promedio.toFixed(2) + ')';
          await crearNotificacion(usuario.id, 'alerta', 'Gasto inusual detectado',
            comercio + ': S/' + monto.toFixed(2) + ' es ' + factor.toFixed(1) + 'x tu promedio en ' + categoria,
            { link: '/dashboard/transacciones' });
        }
      }
    } catch(e) { log.error({ tag: 'INUSUAL', err: e.message }, 'Error alerta inusual'); }
  }

  if (tipo === 'ingreso') {
    try {
      const { data: metasSugg } = await supabase.from('metas_ahorro').select('nombre, monto_objetivo, monto_actual')
        .eq('usuario_id', usuario.id).eq('completada', false).limit(1);
      if (metasSugg && metasSugg.length > 0) {
        const metaSugg = metasSugg[0];
        const faltaSugg = parseFloat(metaSugg.monto_objetivo) - parseFloat(metaSugg.monto_actual || 0);
        if (faltaSugg > 0) {
          msg += '\n\n💡 _¿Quieres destinar algo a tu meta de ' + metaSugg.nombre + '? (te faltan S/ ' + faltaSugg.toFixed(0) + '). Escribe: "ahorré X para ' + metaSugg.nombre + '"_';
        }
      }
    } catch(e) { /* silent */ }
  }

  await enviarWhatsapp(usuario.whatsapp, msg);
}

module.exports = { enviarAlertaTransaccion };
