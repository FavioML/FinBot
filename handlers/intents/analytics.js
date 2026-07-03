const log = require('../../lib/logger');

module.exports = {
  intents: ['ver_gasto_mayor', 'ver_gasto_menor', 'ver_promedio_diario', 'ver_historial_cambios', 'ver_ultima_transaccion', 'ver_ingresos', 'ver_suscripciones'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, mesActual, anioActual, mE, netoPrompt, historialConv, ultimoDiaMes,
      obtenerGastosMes, obtenerUltimaTransaccion, redactarConNETO, formatFecha
    } = ctx;

    switch (intencion) {

      // "el último movimiento", "mi último gasto", "qué registré último" → SOLO mostrar.
      // Nunca borrar: este intent existe justamente porque antes "último movimiento" se
      // clasificaba como deshacer_ultimo y borraba la transacción (caso Edgar, 23-jun).
      case 'ver_ultima_transaccion': {
        try {
          const ultima = await obtenerUltimaTransaccion(usuario.id);
          if (!ultima) return 'Todavía no tienes movimientos registrados. Escribe algo como _"gasté 20 en taxi"_ y arrancamos.';
          const signo = ultima.tipo === 'ingreso' ? '📥 Ingreso' : '📤 Gasto';
          const monto = ultima.moneda === 'USD' ? '$' + parseFloat(ultima.monto).toFixed(2) : 'S/ ' + parseFloat(ultima.monto).toFixed(2);
          return '🧾 *Tu último movimiento:*\n\n' + signo + ': ' + monto + '\n🏪 ' + (ultima.comercio || 'Sin comercio') +
            '\n📁 ' + (ultima.categoria || 'Sin categoría') + (ultima.subcategoria && ultima.subcategoria !== 'sin_categoria' ? ' > ' + ultima.subcategoria : '') +
            '\n📅 ' + (ultima.fecha ? formatFecha(ultima.fecha) : '') +
            '\n\n_Si querés corregirlo escribe qué cambiar; para borrarlo, "elimina el de ' + monto + '"._';
        } catch(e) {
          log.error({ tag: 'ULTIMA_TX', err: e.message }, 'Error ver última transacción');
          return 'No pude traer tu último movimiento. Intenta de nuevo.';
        }
      }

      case 'ver_gasto_mayor': {
        try {
          const txsMayor = await obtenerGastosMes(usuario.id);
          const gastosMayor = txsMayor.filter(t => t.tipo !== 'ingreso');
          if (!gastosMayor.length) return 'No tienes gastos registrados este mes.';
          gastosMayor.sort((a, b) => parseFloat(b.monto_pen || b.monto || 0) - parseFloat(a.monto_pen || a.monto || 0));
          const top = gastosMayor[0];
          const montoMayor = top.moneda === 'USD' ? '$' + parseFloat(top.monto).toFixed(2) : 'S/ ' + parseFloat(top.monto).toFixed(2);
          return '🔝 *Tu gasto más grande del mes:*\n\n' + (top.comercio || 'Sin comercio') + ' — ' + montoMayor + '\n📁 ' + (top.categoria || 'Sin categoría') + '\n📅 ' + (top.fecha || '') + '\n\n_De un total de ' + gastosMayor.length + ' gastos este mes._';
        } catch(e) {
          log.error({ tag: 'GASTO_MAYOR', err: e.message }, 'Error ver gasto mayor');
          return 'No pude obtener el dato. Intenta de nuevo.';
        }
      }

      case 'ver_gasto_menor': {
        try {
          const txsMenor = await obtenerGastosMes(usuario.id);
          const gastosMenor = txsMenor.filter(t => t.tipo !== 'ingreso' && parseFloat(t.monto_pen || t.monto || 0) > 0);
          if (!gastosMenor.length) return 'No tienes gastos registrados este mes.';
          gastosMenor.sort((a, b) => parseFloat(a.monto_pen || a.monto || 0) - parseFloat(b.monto_pen || b.monto || 0));
          const bottom = gastosMenor[0];
          const montoMenor = bottom.moneda === 'USD' ? '$' + parseFloat(bottom.monto).toFixed(2) : 'S/ ' + parseFloat(bottom.monto).toFixed(2);
          return '🔻 *Tu gasto más pequeño del mes:*\n\n' + (bottom.comercio || 'Sin comercio') + ' — ' + montoMenor + '\n📁 ' + (bottom.categoria || 'Sin categoría') + '\n📅 ' + (bottom.fecha || '') + '\n\n_De un total de ' + gastosMenor.length + ' gastos este mes._';
        } catch(e) {
          log.error({ tag: 'GASTO_MENOR', err: e.message }, 'Error ver gasto menor');
          return 'No pude obtener el dato. Intenta de nuevo.';
        }
      }

      case 'ver_promedio_diario': {
        try {
          const txsProm = await obtenerGastosMes(usuario.id);
          const gastosProm = txsProm.filter(t => t.tipo !== 'ingreso');
          if (!gastosProm.length) return 'No tienes gastos registrados este mes para calcular el promedio.';
          const totalProm = gastosProm.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const hoyDia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getDate();
          const promDiario = totalProm / hoyDia;
          const diasMes = new Date(anioActual, mesActual, 0).getDate();
          const proyeccion = promDiario * diasMes;
          return '📊 *Promedio diario de gasto:*\n\n💰 S/ ' + promDiario.toFixed(2) + ' por día\n📅 Basado en ' + hoyDia + ' días transcurridos\n💸 Total acumulado: S/ ' + totalProm.toFixed(2) + '\n📈 Proyección a fin de mes: S/ ' + proyeccion.toFixed(0) + '\n\n_Llevas ' + gastosProm.length + ' gastos en ' + hoyDia + ' días._';
        } catch(e) {
          log.error({ tag: 'PROMEDIO', err: e.message }, 'Error promedio diario');
          return 'No pude calcular el promedio. Intenta de nuevo.';
        }
      }

      case 'ver_historial_cambios': {
        try {
          const hoyStr = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).toISOString().split('T')[0];
          const { data: txsModif } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id)
            .gte('updated_at', hoyStr + 'T00:00:00')
            .order('updated_at', { ascending: false }).limit(10);
          if (!txsModif || !txsModif.length) return 'No hiciste cambios hoy. Todo está igual que ayer. 👍';
          let respHist = '📝 *Cambios recientes (hoy):*\n\n';
          txsModif.forEach(t => {
            const m = t.moneda === 'USD' ? '$' + parseFloat(t.monto).toFixed(2) : 'S/ ' + parseFloat(t.monto).toFixed(2);
            respHist += '• ' + (t.comercio || 'N/D') + ' — ' + m + ' (' + (t.categoria || 'S/C') + ')\n';
          });
          return respHist + '\n_Mostrando las últimas ' + txsModif.length + ' transacciones modificadas hoy._';
        } catch(e) {
          log.error({ tag: 'HISTORIAL', err: e.message }, 'Error historial cambios');
          return 'No pude consultar los cambios recientes. Intenta de nuevo.';
        }
      }

      case 'ver_ingresos': {
        try {
          const mesIng = datos.mes || mesActual;
          const anioIng = datos.anio || anioActual;
          const periodoIng = datos.periodo || 'mes';
          let txsIng;
          if (periodoIng === 'semana') {
            const hace7 = new Date(); hace7.setDate(hace7.getDate() - 7);
            const desdeIng = hace7.toISOString().split('T')[0];
            const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', desdeIng).order('fecha', { ascending: false });
            txsIng = data || [];
          } else {
            const desdeIng = anioIng + '-' + String(mesIng).padStart(2,'0') + '-01';
            const hastaIng = anioIng + '-' + String(mesIng).padStart(2,'0') + '-' + String(ultimoDiaMes(anioIng, mesIng)).padStart(2,'0');
            const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', desdeIng).lte('fecha', hastaIng).order('fecha', { ascending: false });
            txsIng = data || [];
          }
          if (txsIng.length === 0) return 'No tienes ingresos registrados ' + (periodoIng === 'semana' ? 'esta semana' : 'en ' + mE[mesIng]) + '.\n\n_Registra ingresos: "mi sueldo fue S/4500"_';
          const totalIng = txsIng.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const detalleIng = txsIng.slice(0,6).map(t => '💰 ' + (t.comercio || t.banco || 'Ingreso') + ' — ' + (t.moneda === 'USD' ? '$' : 'S/ ') + parseFloat(t.monto).toFixed(2) + ' (' + formatFecha(t.fecha) + ')').join('\n');
          const ctxIng = 'Ingresos ' + (periodoIng === 'semana' ? 'de la semana' : 'de ' + mE[mesIng] + ' ' + anioIng) + ': S/ ' + totalIng.toFixed(2) + ' en ' + txsIng.length + ' movimientos. Detalle: ' + detalleIng.replace(/\n/g, ', ');
          const respIng = await redactarConNETO(netoPrompt, ctxIng, msg, historialConv);
          return respIng || '💰 *Ingresos ' + (periodoIng === 'semana' ? 'de la semana' : 'de ' + mE[mesIng]) + '*\n\nTotal: *S/ ' + totalIng.toFixed(2) + '*\n\n' + detalleIng;
        } catch(e) {
          log.error({ tag: 'INGRESOS', err: e.message }, 'Error consultando ingresos');
          return 'No pude consultar tus ingresos. Intenta de nuevo.';
        }
      }

      case 'ver_suscripciones': {
        try {
          // Buscar comercios que aparecen en al menos 2 meses distintos
          const hace90 = new Date(); hace90.setDate(hace90.getDate() - 90);
          const desdeSub = hace90.toISOString().split('T')[0];
          const { data: txsSub } = await supabase.from('transacciones').select('comercio,monto,monto_pen,fecha,categoria')
            .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desdeSub).order('fecha', { ascending: false });
          if (!txsSub || txsSub.length === 0) return 'No tengo suficiente historial para detectar suscripciones. Sigue registrando y en unas semanas te muestro tus pagos recurrentes.';
          const porComercio = {};
          (txsSub||[]).forEach(t => {
            const c = (t.comercio||'').toLowerCase().trim();
            if (!c || c.length < 3) return;
            const mesKey = t.fecha.substring(0,7);
            if (!porComercio[c]) porComercio[c] = { nombre: t.comercio, meses: new Set(), montos: [], cat: t.categoria };
            porComercio[c].meses.add(mesKey);
            porComercio[c].montos.push(parseFloat(t.monto_pen || t.monto || 0));
          });
          const recurrentes = Object.values(porComercio)
            .filter(c => c.meses.size >= 2)
            .map(c => ({ nombre: c.nombre, meses: c.meses.size, promedio: c.montos.reduce((s,m)=>s+m,0)/c.montos.length, cat: c.cat }))
            .sort((a,b) => b.promedio - a.promedio);
          if (recurrentes.length === 0) return 'No detecté pagos recurrentes en tus últimos 3 meses. Si tienes suscripciones, regístralas y las rastreo automáticamente.';
          const totalSub = recurrentes.reduce((s,r) => s + r.promedio, 0);
          let msgSub = '🔄 *Pagos recurrentes detectados*\n\nTotal estimado mensual: *S/ ' + totalSub.toFixed(2) + '*\n\n';
          recurrentes.slice(0,10).forEach(r => {
            msgSub += '• ' + (r.nombre || 'Sin nombre') + ' — ~S/ ' + r.promedio.toFixed(2) + '/mes [' + (r.cat || 'Otros') + ']\n';
          });
          msgSub += '\n_Basado en pagos de los últimos 3 meses._';
          return msgSub;
        } catch(e) {
          log.error({ tag: 'SUBS', err: e.message }, 'Error detectando suscripciones');
          return 'No pude detectar tus suscripciones. Intenta de nuevo.';
        }
      }
    }
  }
};
