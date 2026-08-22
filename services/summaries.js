const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { ahoraPeru, ultimoDiaMes, hoyPeru } = require('../lib/dates');
const { MESES } = require('../lib/constants');
const { obtenerGastosSemana } = require('./transactions');
const { obtenerPresupuestosMes } = require('./budget');
const { generarRecomendaciones, construirDatosUsuario, generarMiniRecomendacion } = require('./recommendations');
const { obtenerDeudas } = require('./debts');
const { calcularRitmoAhorro } = require('./metas');

async function generarResumenSemanal(usuario) {
  const hoy = ahoraPeru();
  const gastosSemana = await obtenerGastosSemana(usuario.id);
  if (!gastosSemana.length) return null;

  const hace14 = new Date(hoy.getTime() - 14 * 24 * 60 * 60 * 1000);
  const hace7 = new Date(hoy.getTime() - 7 * 24 * 60 * 60 * 1000);
  const { data: gastosAnt, error: errGastosAnt } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuario.id).eq('tipo', 'gasto')
    .gte('fecha', hace14.toISOString().split('T')[0])
    .lt('fecha', hace7.toISOString().split('T')[0]);
  if (errGastosAnt) log.error({ tag: 'RESUMEN_SEM', usuarioId: usuario.id, err: errGastosAnt.message }, 'Query semana anterior fallo: el resumen sale sin comparativa');
  const gastosAnteriores = gastosAnt || [];

  const totalSemana = gastosSemana.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const totalAnterior = gastosAnteriores.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);

  const porCat = {};
  gastosSemana.forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || t.monto); });
  const top3 = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const porComercio = {};
  gastosSemana.forEach(t => { const c = t.comercio || t.banco || 'Sin nombre'; porComercio[c] = (porComercio[c] || 0) + 1; });
  const comercioTop = Object.entries(porComercio).sort((a, b) => b[1] - a[1])[0];

  const porDia = {};
  gastosSemana.forEach(t => { porDia[t.fecha] = (porDia[t.fecha] || 0) + parseFloat(t.monto_pen || t.monto); });
  const diaMasCaro = Object.entries(porDia).sort((a, b) => b[1] - a[1])[0];

  const hormiga = gastosSemana.filter(t => parseFloat(t.monto_pen || t.monto) <= 20);
  const totalHormiga = hormiga.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);

  const diasMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  const diaActual = hoy.getDate();
  const { data: gastosMesData, error: errGastosMes } = await supabase.from('transacciones').select('monto')
    .eq('usuario_id', usuario.id).eq('tipo', 'gasto')
    .gte('fecha', hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-01');
  if (errGastosMes) log.error({ tag: 'RESUMEN_SEM', usuarioId: usuario.id, err: errGastosMes.message }, 'Query gastos del mes fallo: el resumen sale sin proyeccion');
  const totalMes = (gastosMesData || []).reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const proyeccionMes = diaActual > 0 ? (totalMes / diaActual) * diasMes : 0;

  const presupuestos = await obtenerPresupuestosMes(usuario.id);
  const limiteTotal = presupuestos.reduce((s, p) => s + parseFloat(p.monto_limite), 0);

  let comparativa = '';
  if (totalAnterior > 0) {
    const diff = totalSemana - totalAnterior;
    const pct = Math.abs((diff / totalAnterior) * 100).toFixed(0);
    if (diff > 0) comparativa = '\u2197\uFE0F *' + pct + '% mas* que la semana pasada (S/ ' + totalAnterior.toFixed(2) + ')';
    else if (diff < 0) comparativa = '\u2198\uFE0F *' + pct + '% menos* que la semana pasada (S/ ' + totalAnterior.toFixed(2) + ') \uD83D\uDC4F';
    else comparativa = '\u27A1\uFE0F Igual que la semana pasada';
  }

  let insight = '';
  try {
    const ctx = {
      totalSemana: totalSemana.toFixed(2),
      totalAnterior: totalAnterior > 0 ? totalAnterior.toFixed(2) : null,
      top1: top3[0] ? top3[0][0] + ' S/ ' + top3[0][1].toFixed(2) : null,
      top2: top3[1] ? top3[1][0] + ' S/ ' + top3[1][1].toFixed(2) : null,
      hormigaTotal: totalHormiga > 10 ? totalHormiga.toFixed(2) : null,
      proyeccionMes: proyeccionMes > 0 ? proyeccionMes.toFixed(2) : null,
      limiteTotal: limiteTotal > 0 ? limiteTotal.toFixed(2) : null,
      numTransacciones: gastosSemana.length
    };
    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'Eres el asistente financiero de NETO. Con los datos de gastos semanales genera UN insight accionable en 1-2 oraciones. Especifico, util, tono amigable. En espanol sin emojis al inicio.'
      }, {
        role: 'user',
        content: 'Datos: ' + JSON.stringify(ctx)
      }],
      temperature: 0.7,
      max_tokens: 100
    });
    insight = aiRes.choices[0].message.content.trim();
  } catch(e) {
    if (totalSemana > totalAnterior && totalAnterior > 0) insight = 'Esta semana gastaste mas que la anterior. Revisa tu categoria ' + (top3[0] ? top3[0][0] : 'principal') + ' para encontrar oportunidades de ahorro.';
    else if (totalHormiga > 30) insight = 'Tus gastos pequenos suman S/ ' + totalHormiga.toFixed(2) + '. Son los mas faciles de reducir.';
    else insight = 'Buen trabajo controlando tus gastos esta semana.';
  }

  const fechaDesde = hace7.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
  const fechaHasta = hoy.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
  const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const emojis = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];

  let msg = '\uD83D\uDCCA *Resumen semanal' + (primerNombre ? ', ' + primerNombre : '') + '*\n';
  msg += '_' + fechaDesde + ' \u2014 ' + fechaHasta + '_\n';
  msg += '---------------\n\n';
  msg += '\uD83D\uDCB0 *Total gastado:* S/ ' + totalSemana.toFixed(2) + '\n';
  if (comparativa) msg += comparativa + '\n';
  msg += '\n';
  msg += '\uD83D\uDD25 *Top categorias:*\n';
  top3.forEach(([cat, monto], i) => {
    const pct = ((monto / totalSemana) * 100).toFixed(0);
    msg += emojis[i] + ' ' + cat + ': *S/ ' + monto.toFixed(2) + '* (' + pct + '%)\n';
  });
  msg += '\n';
  if (comercioTop && comercioTop[1] >= 2) msg += '\uD83D\uDECD\uFE0F *Lugar favorito:* ' + comercioTop[0] + ' (' + comercioTop[1] + ' veces)\n';
  if (diaMasCaro) {
    const nombreDia = new Date(diaMasCaro[0] + 'T12:00:00').toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'short' });
    msg += '\uD83D\uDCC5 *Dia mas caro:* ' + nombreDia + ' (S/ ' + diaMasCaro[1].toFixed(2) + ')\n';
  }
  if (totalHormiga > 20 && hormiga.length >= 3) msg += '\uD83D\uDC1C *Gastos hormiga:* ' + hormiga.length + ' transacciones = S/ ' + totalHormiga.toFixed(2) + '\n';
  msg += '\n';
  if (proyeccionMes > 0) {
    msg += '\uD83D\uDCC8 *Proyeccion del mes:* S/ ' + proyeccionMes.toFixed(2);
    if (limiteTotal > 0) {
      const sobra = limiteTotal - proyeccionMes;
      msg += sobra > 0 ? ' \u2705 (dentro del presupuesto)' : ' \u26A0\uFE0F (superaria tu presupuesto en S/ ' + Math.abs(sobra).toFixed(2) + ')';
    }
    msg += '\n';
  }
  msg += '\n\uD83D\uDCA1 *Consejo:* ' + insight + '\n';

  try {
    const datosRecom = await construirDatosUsuario(usuario.id);
    const miniRecom = generarMiniRecomendacion(datosRecom, usuario.nombre);
    if (miniRecom) msg += '\n' + miniRecom + '\n';
  } catch (e) { log.error({ tag: 'RECOM_SEM', err: e.message }, 'Error mini-recom semanal'); }

  try {
    const deudasUsuario = await obtenerDeudas(usuario.id, true);
    const deudasConVenc = deudasUsuario.filter(d => d.fecha_vencimiento);
    const proximas = deudasConVenc.filter(d => {
      const venc = new Date(d.fecha_vencimiento + 'T12:00:00');
      const diff = (venc - hoy) / 86400000;
      return diff >= -3 && diff <= 7;
    });
    if (proximas.length > 0) {
      msg += '\n⏰ *Deudas esta semana:*\n';
      for (const d of proximas.slice(0, 3)) {
        const sym = d.moneda === 'USD' ? '$' : 'S/';
        const venc = new Date(d.fecha_vencimiento + 'T12:00:00');
        const diff = Math.round((venc - hoy) / 86400000);
        const estado = diff < 0 ? '🔴 Vencida' : diff === 0 ? '🔴 Hoy' : '📅 en ' + diff + ' días';
        msg += '• ' + (d.tipo === 'me_deben' ? d.contraparte + ' te debe' : 'Le debes a ' + d.contraparte) + ': ' + sym + ' ' + parseFloat(d.monto_pendiente).toFixed(2) + ' (' + estado + ')\n';
      }
    }
  } catch (e) { log.error({ tag: 'RESUMEN_SEM', usuarioId: usuario.id, err: e.message }, 'Bloque deudas fallo: el resumen sale sin vencimientos'); }

  try {
    const { data: metasActivas, error: errMetas } = await supabase.from('metas_ahorro').select('*')
      .eq('usuario_id', usuario.id).eq('completada', false);
    if (errMetas) log.error({ tag: 'RESUMEN_SEM', usuarioId: usuario.id, err: errMetas.message }, 'Query metas_ahorro fallo: el resumen sale sin la seccion de metas');
    if (metasActivas && metasActivas.length > 0) {
      msg += '\n🎯 *Metas de ahorro:*\n';
      for (const m of metasActivas.slice(0, 3)) {
        const pctM = m.monto_objetivo > 0 ? ((m.monto_actual / m.monto_objetivo) * 100).toFixed(0) : 0;
        msg += '• ' + m.nombre + ': ' + pctM + '% (S/ ' + parseFloat(m.monto_actual || 0).toFixed(0) + '/' + parseFloat(m.monto_objetivo).toFixed(0) + ')';
        if (m.fecha_limite) {
          const ritmo = calcularRitmoAhorro(m);
          if (ritmo.montoMensual !== null) {
            msg += ritmo.enRitmo ? ' ✅' : ' ⚠️ necesitas S/ ' + ritmo.montoMensual.toFixed(0) + '/mes';
          }
        }
        msg += '\n';
      }
    }
  } catch (e) { log.error({ tag: 'RESUMEN_SEM', usuarioId: usuario.id, err: e.message }, 'Bloque metas fallo: el resumen sale sin la seccion de metas'); }

  try {
    const { data: metasSugg, error: errSugg } = await supabase.from('metas_ahorro').select('nombre')
      .eq('usuario_id', usuario.id).eq('completada', false).limit(1);
    if (errSugg) log.error({ tag: 'RESUMEN_SEM', usuarioId: usuario.id, err: errSugg.message }, 'Query metas_ahorro (sugerencia) fallo: el resumen sale sin sugerencia de ahorro');
    if (metasSugg && metasSugg.length > 0 && totalSemana < totalAnterior && totalAnterior > 0) {
      const ahorro = totalAnterior - totalSemana;
      msg += '\n💡 _Gastaste S/ ' + ahorro.toFixed(0) + ' menos que la semana pasada. ¿Lo pones en tu meta de ' + metasSugg[0].nombre + '?_\n';
    }
  } catch (e) { log.error({ tag: 'RESUMEN_SEM', usuarioId: usuario.id, err: e.message }, 'Bloque sugerencia de meta fallo'); }

  msg += '\n_Escribe /mes para el detalle o /reporte para tu PDF._';
  return msg;
}

async function generarResumenMensual(usuario) {
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const mesAnt = ahora.getMonth() === 0 ? 12 : ahora.getMonth();
  const anioAnt = ahora.getMonth() === 0 ? ahora.getFullYear() - 1 : ahora.getFullYear();
  const desde = anioAnt + '-' + String(mesAnt).padStart(2, '0') + '-01';
  const hasta = anioAnt + '-' + String(mesAnt).padStart(2, '0') + '-' + String(ultimoDiaMes(anioAnt, mesAnt)).padStart(2, '0');

  const { data: txsMes, error: errTxs } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desde).lte('fecha', hasta);
  if (errTxs) { log.error({ tag: 'RESUMEN', usuarioId: usuario.id, err: errTxs.message }, 'No se pudo leer las transacciones del resumen: no se envia'); throw errTxs; }
  if (!txsMes || txsMes.length === 0) return null;

  const { data: ingresos, error: errIng } = await supabase.from('transacciones').select('monto,monto_pen')
    .eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', desde).lte('fecha', hasta);
  // Esta es la que mas dano hace callada: `(ingresos || [])` da total 0, y el resumen anuncia
  // un ahorro negativo igual a todo el gasto del mes.
  if (errIng) { log.error({ tag: 'RESUMEN', usuarioId: usuario.id, err: errIng.message }, 'No se pudo leer las transacciones del resumen: no se envia'); throw errIng; }

  const totalGastos = txsMes.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const totalIngresos = (ingresos || []).reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const ahorro = totalIngresos - totalGastos;

  const mesAntAnt = mesAnt === 1 ? 12 : mesAnt - 1;
  const anioAntAnt = mesAnt === 1 ? anioAnt - 1 : anioAnt;
  const desdeAntAnt = anioAntAnt + '-' + String(mesAntAnt).padStart(2, '0') + '-01';
  const hastaAntAnt = anioAntAnt + '-' + String(mesAntAnt).padStart(2, '0') + '-' + String(ultimoDiaMes(anioAntAnt, mesAntAnt)).padStart(2, '0');
  const { data: txsAntAnt, error: errAntAnt } = await supabase.from('transacciones').select('monto,monto_pen')
    .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desdeAntAnt).lte('fecha', hastaAntAnt);
  // El mes de comparacion: en cero, el resumen anuncia una subida de gasto contra un mes que
  // no se pudo leer.
  if (errAntAnt) { log.error({ tag: 'RESUMEN', usuarioId: usuario.id, err: errAntAnt.message }, 'No se pudo leer las transacciones del resumen: no se envia'); throw errAntAnt; }
  const totalAntAnt = (txsAntAnt || []).reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);

  const porCat = {};
  txsMes.forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || t.monto); });
  const top5 = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const nombreMes = MESES[mesAnt];
  const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;

  let msg = '📊 *Resumen de ' + nombreMes + (primerNombre ? ', ' + primerNombre : '') + '*\n';
  msg += '===============\n\n';
  msg += '💰 *Total gastado:* S/ ' + totalGastos.toFixed(2) + '\n';
  if (totalIngresos > 0) {
    msg += '💵 *Ingresos:* S/ ' + totalIngresos.toFixed(2) + '\n';
    msg += (ahorro >= 0 ? '✅' : '⚠️') + ' *Balance:* S/ ' + ahorro.toFixed(2) + (ahorro >= 0 ? ' (ahorraste!)' : ' (gastaste más de lo que ganaste)') + '\n';
  }
  msg += '📋 *Transacciones:* ' + txsMes.length + '\n';

  if (totalAntAnt > 0) {
    const diff = totalGastos - totalAntAnt;
    const pct = Math.abs((diff / totalAntAnt) * 100).toFixed(0);
    if (diff > 0) msg += '\n↗️ *' + pct + '% más* que ' + MESES[mesAntAnt] + ' (S/ ' + totalAntAnt.toFixed(2) + ')';
    else if (diff < 0) msg += '\n↘️ *' + pct + '% menos* que ' + MESES[mesAntAnt] + ' (S/ ' + totalAntAnt.toFixed(2) + ') 👏';
  }

  msg += '\n\n🏆 *Top categorías:*\n';
  const medallas = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  top5.forEach(([cat, monto], i) => {
    const pct = ((monto / totalGastos) * 100).toFixed(0);
    msg += medallas[i] + ' ' + cat + ': *S/ ' + monto.toFixed(2) + '* (' + pct + '%)\n';
  });

  try {
    const recom = await generarRecomendaciones(usuario.id, usuario.nombre, 'mensual');
    if (recom && recom.mensaje) {
      msg += '\n\n─────────────\n' + recom.mensaje;
    }
  } catch (e) { log.error({ tag: 'RECOM_MENS', err: e.message }, 'Error recomendación mensual'); }

  msg += '\n\n_Escribe /reporte para tu dashboard detallado._';
  return msg;
}

/**
 * Resumen diario para el Modo Manos Libres. Corto a propósito (cadencia diaria):
 * total del día, top categorías y el mayor gasto. Devuelve null si no hubo gastos
 * hoy (no mandar "gastaste S/0" a diario — respeta la política anti-fatiga).
 */
async function generarResumenDiario(usuario) {
  const hoyStr = hoyPeru();
  const { data: txsHoy, error: errHoy } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuario.id).eq('tipo', 'gasto').eq('fecha', hoyStr);
  if (errHoy) { log.error({ tag: 'RESUMEN', usuarioId: usuario.id, err: errHoy.message }, 'No se pudo leer las transacciones del resumen: no se envia'); throw errHoy; }
  if (!txsHoy || txsHoy.length === 0) return null;

  const total = txsHoy.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);

  const porCat = {};
  txsHoy.forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || t.monto); });
  const top3 = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const { data: ingHoy, error: errIngHoy } = await supabase.from('transacciones').select('monto,monto_pen')
    .eq('usuario_id', usuario.id).eq('tipo', 'ingreso').eq('fecha', hoyStr);
  if (errIngHoy) { log.error({ tag: 'RESUMEN', usuarioId: usuario.id, err: errIngHoy.message }, 'No se pudo leer las transacciones del resumen: no se envia'); throw errIngHoy; }
  const totalIng = (ingHoy || []).reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);

  const mayor = txsHoy.slice().sort((a, b) => parseFloat(b.monto_pen || b.monto) - parseFloat(a.monto_pen || a.monto))[0];

  const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const emojis = ['🥇', '🥈', '🥉'];
  const fechaLarga = new Date(hoyStr + 'T12:00:00').toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'short' });

  let msg = '🌙 *Resumen de hoy' + (primerNombre ? ', ' + primerNombre : '') + '*\n';
  msg += '_' + fechaLarga + '_\n';
  msg += '---------------\n\n';
  msg += '💸 *Gastaste:* S/ ' + total.toFixed(2) + ' en ' + txsHoy.length + (txsHoy.length === 1 ? ' movimiento' : ' movimientos') + '\n';
  if (totalIng > 0) msg += '💵 *Ingresos:* S/ ' + totalIng.toFixed(2) + '\n';
  msg += '\n';
  top3.forEach(([cat, monto], i) => {
    msg += emojis[i] + ' ' + cat + ': *S/ ' + monto.toFixed(2) + '*\n';
  });
  if (mayor && mayor.comercio) {
    msg += '\n🔝 *Mayor gasto:* ' + mayor.comercio + ' (S/ ' + parseFloat(mayor.monto_pen || mayor.monto).toFixed(2) + ')\n';
  }
  msg += '\n_Si algo está mal, dime "cambia ' + (mayor && mayor.comercio ? mayor.comercio : '[comercio]') + ' a [categoría]"._\n';
  msg += '_Para pausar el resumen diario escribe /manoslibres._';
  return msg;
}

module.exports = { generarResumenSemanal, generarResumenMensual, generarResumenDiario };
