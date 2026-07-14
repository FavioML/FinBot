const log = require('../../lib/logger');

module.exports = {
  intents: ['ver_tipo_cambio', 'convertir_moneda', 'calcular_cuotas', 'buscar_gasto', 'comparar_meses', 'ver_frecuencia_comercio', 'cambiar_nombre', 'consulta_financiera', 'recordatorio_pago'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, mesActual, anioActual, mE, netoPrompt, historialConv, ultimoDiaMes,
      obtenerTipoCambio, redactarConNETO, getEmojiCategoria, formatFecha,
      getUserPlanConfig
    } = ctx;

    switch (intencion) {

      case 'ver_tipo_cambio': {
        try {
          const tc = await obtenerTipoCambio();
          return '💵 *Tipo de cambio USD/PEN*\n\n🟢 Compra: S/ ' + tc.compra.toFixed(4) + '\n🔴 Venta: S/ ' + tc.venta.toFixed(4) + '\n\n_Fuente: dolar.pe_';
        } catch(e) {
          return '💵 No pude obtener el tipo de cambio actual. Intenta en unos minutos.';
        }
      }

      case 'convertir_moneda': {
        try {
          const montoConv = parseFloat(datos.monto);
          if (!montoConv || montoConv <= 0) return 'Dime cuánto quieres convertir. Ej: _"cuánto es 100 dólares en soles"_.';
          const tc = await obtenerTipoCambio();
          const origenConv = (datos.moneda_origen || 'USD').toUpperCase();
          let resultado, textoConv;
          if (origenConv === 'USD') {
            resultado = montoConv * tc.venta;
            textoConv = '$' + montoConv.toFixed(2) + ' = *S/ ' + resultado.toFixed(2) + '*';
          } else {
            resultado = montoConv / tc.compra;
            textoConv = 'S/ ' + montoConv.toFixed(2) + ' = *$' + resultado.toFixed(2) + '*';
          }
          return '💱 *Conversión:*\n\n' + textoConv + '\n\n📊 TC Compra: S/ ' + tc.compra.toFixed(4) + '\n📊 TC Venta: S/ ' + tc.venta.toFixed(4) + '\n\n_Fuente: dolar.pe_';
        } catch(e) {
          log.error({ tag: 'CONVERTIR', err: e.message }, 'Error convertir moneda');
          return 'No pude obtener el tipo de cambio. Intenta de nuevo.';
        }
      }

      case 'calcular_cuotas': {
        try {
          const montoCuota = parseFloat(datos.monto);
          if (!montoCuota || montoCuota <= 0) return 'Dime el monto y las cuotas. Ej: _"cuotas de 3000 en 12 meses"_.';
          const numCuotas = parseInt(datos.cuotas) || 12;
          const teaAnual = parseFloat(datos.tasa) || 45; // TEA promedio tarjetas Perú
          const temMensual = Math.pow(1 + teaAnual / 100, 1 / 12) - 1;
          const cuotaMensual = montoCuota * (temMensual * Math.pow(1 + temMensual, numCuotas)) / (Math.pow(1 + temMensual, numCuotas) - 1);
          const totalPagar = cuotaMensual * numCuotas;
          const totalInteres = totalPagar - montoCuota;
          return '🧮 *Cálculo de cuotas:*\n\n💰 Monto: S/ ' + montoCuota.toFixed(2) + '\n📅 Cuotas: ' + numCuotas + ' meses\n📊 TEA: ' + teaAnual + '%\n\n💳 Cuota mensual: *S/ ' + cuotaMensual.toFixed(2) + '*\n💸 Total a pagar: S/ ' + totalPagar.toFixed(2) + '\n⚠️ Total intereses: S/ ' + totalInteres.toFixed(2) + '\n\n_TEA estimada. Consulta con tu banco la tasa real._';
        } catch(e) {
          log.error({ tag: 'CUOTAS', err: e.message }, 'Error calcular cuotas');
          return 'No pude calcular las cuotas. Intenta con _"cuotas de 3000 en 12 meses"_.';
        }
      }

      case 'buscar_gasto': {
        try {
          const comercioBusq = datos.comercio;
          if (!comercioBusq) return 'Dime el comercio o servicio. Ej: _"cuánto gasté en Uber"_, _"pagos de Netflix"_.';
          const mesBusq = datos.mes || mesActual;
          const anioBusq = datos.anio || anioActual;
          const desdeBusq = anioBusq + '-' + String(mesBusq).padStart(2,'0') + '-01';
          const hastaBusq = anioBusq + '-' + String(mesBusq).padStart(2,'0') + '-' + String(ultimoDiaMes(anioBusq, mesBusq)).padStart(2,'0');
          const { data: txsBusq } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id).ilike('comercio', '%' + comercioBusq + '%')
            .gte('fecha', desdeBusq).lte('fecha', hastaBusq).order('fecha', { ascending: false });
          if (!txsBusq || txsBusq.length === 0) return 'No encontré gastos de *' + comercioBusq + '* en ' + mE[mesBusq] + ' ' + anioBusq + '.';
          const totalBusq = txsBusq.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          let msgBusq = '🔍 *Gastos en ' + comercioBusq + '* (' + mE[mesBusq] + ' ' + anioBusq + ')\n\nTotal: *S/ ' + totalBusq.toFixed(2) + '* en ' + txsBusq.length + ' pago' + (txsBusq.length > 1 ? 's' : '') + '\n\n';
          txsBusq.slice(0,8).forEach(t => {
            const montoB = t.moneda === 'USD' ? '$' + parseFloat(t.monto).toFixed(2) : 'S/ ' + parseFloat(t.monto_pen || t.monto).toFixed(2);
            msgBusq += '• ' + montoB + ' — ' + formatFecha(t.fecha) + ' [' + (t.categoria || 'Otros') + ']\n';
          });
          if (txsBusq.length > 8) msgBusq += '_...y ' + (txsBusq.length - 8) + ' más_';
          return msgBusq;
        } catch(e) {
          log.error({ tag: 'BUSCAR', err: e.message }, 'Error buscando gasto');
          return 'No pude buscar ese gasto. Intenta de nuevo.';
        }
      }

      case 'comparar_meses': {
        try {
          const mes1 = datos.mes1 || mesActual;
          const anio1 = datos.anio1 || anioActual;
          const mes2Raw = datos.mes2 || (mes1 === 1 ? 12 : mes1 - 1);
          const anio2 = datos.anio2 || (mes1 === 1 ? anioActual - 1 : anioActual);
          const desde1 = anio1 + '-' + String(mes1).padStart(2,'0') + '-01';
          const hasta1 = anio1 + '-' + String(mes1).padStart(2,'0') + '-' + String(ultimoDiaMes(anio1, mes1)).padStart(2,'0');
          const desde2 = anio2 + '-' + String(mes2Raw).padStart(2,'0') + '-01';
          const hasta2 = anio2 + '-' + String(mes2Raw).padStart(2,'0') + '-' + String(ultimoDiaMes(anio2, mes2Raw)).padStart(2,'0');
          const [{ data: txs1 }, { data: txs2 }] = await Promise.all([
            supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desde1).lte('fecha', hasta1),
            supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desde2).lte('fecha', hasta2)
          ]);
          const total1 = (txs1||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const total2 = (txs2||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const diff = total1 - total2;
          const pct = total2 > 0 ? ((diff / total2) * 100).toFixed(0) : 0;
          // Top categorías que cambiaron
          const porCat1 = {}; (txs1||[]).forEach(t => { const c = t.categoria || 'Otros'; porCat1[c] = (porCat1[c]||0) + parseFloat(t.monto_pen || t.monto || 0); });
          const porCat2 = {}; (txs2||[]).forEach(t => { const c = t.categoria || 'Otros'; porCat2[c] = (porCat2[c]||0) + parseFloat(t.monto_pen || t.monto || 0); });
          const allCats = [...new Set([...Object.keys(porCat1), ...Object.keys(porCat2)])];
          const cambios = allCats.map(c => ({ cat: c, m1: porCat1[c]||0, m2: porCat2[c]||0, diff: (porCat1[c]||0) - (porCat2[c]||0) }))
            .sort((a,b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0,4);
          const cambiosStr = cambios.map(c => (getEmojiCategoria(c.cat)||'') + c.cat + ': S/' + c.m1.toFixed(0) + ' vs S/' + c.m2.toFixed(0) + ' (' + (c.diff > 0 ? '+' : '') + c.diff.toFixed(0) + ')').join(', ');
          const ctxComp = mE[mes1] + ' ' + anio1 + ': S/' + total1.toFixed(2) + ' (' + (txs1||[]).length + ' gastos) vs ' + mE[mes2Raw] + ' ' + anio2 + ': S/' + total2.toFixed(2) + ' (' + (txs2||[]).length + ' gastos). Diferencia: ' + (diff > 0 ? '+' : '') + 'S/' + diff.toFixed(2) + ' (' + (diff > 0 ? '+' : '') + pct + '%). Categorias con mayor cambio: ' + cambiosStr;
          const respComp = await redactarConNETO(netoPrompt, ctxComp, msg, historialConv);
          return respComp || '📊 *' + mE[mes1] + ' vs ' + mE[mes2Raw] + '*\n\n' + mE[mes1] + ': S/ ' + total1.toFixed(2) + '\n' + mE[mes2Raw] + ': S/ ' + total2.toFixed(2) + '\nDiferencia: ' + (diff > 0 ? '+' : '') + 'S/ ' + diff.toFixed(2) + ' (' + (diff > 0 ? '+' : '') + pct + '%)';
        } catch(e) {
          log.error({ tag: 'COMPARAR', err: e.message }, 'Error comparando meses');
          return 'No pude comparar los meses. Intenta: "compara marzo con febrero".';
        }
      }

      case 'ver_frecuencia_comercio': {
        try {
          const comercioFreq = datos.comercio;
          if (!comercioFreq) return '¿De qué comercio quieres saber la frecuencia? Ej: _"cuántas veces fui a Rappi"_';
          const { data: txsFreq } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id).ilike('comercio', '%' + comercioFreq + '%')
            .order('fecha', { ascending: false });
          if (!txsFreq || !txsFreq.length) return 'No encontré pagos en *' + comercioFreq + '*. ¿Seguro que se llama así?';
          const totalFreq = txsFreq.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const promFreq = totalFreq / txsFreq.length;
          return '🔄 *Frecuencia en ' + comercioFreq + ':*\n\n📍 ' + txsFreq.length + ' pagos registrados\n💰 Total: S/ ' + totalFreq.toFixed(2) + '\n📊 Promedio por pago: S/ ' + promFreq.toFixed(2) + '\n📅 Último: ' + (txsFreq[0].fecha || 'N/D') + '\n\n_Datos de todo tu historial._';
        } catch(e) {
          log.error({ tag: 'FRECUENCIA', err: e.message }, 'Error frecuencia comercio');
          return 'No pude obtener la frecuencia. Intenta de nuevo.';
        }
      }

      case 'cambiar_nombre': {
        try {
          const nombreNuevo = datos.nombre_nuevo;
          if (!nombreNuevo || nombreNuevo.length < 2) return 'Dime tu nombre. Ej: _"mi nombre es Juan"_.';
          const nombreLimpio = nombreNuevo.trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          await supabase.from('usuarios').update({ nombre: nombreLimpio }).eq('id', usuario.id);
          return '✅ Listo, ahora te llamo *' + nombreLimpio + '*. ¡Mucho gusto! 👋';
        } catch(e) {
          log.error({ tag: 'NOMBRE', err: e.message }, 'Error cambiando nombre');
          return 'No pude actualizar tu nombre. Intenta de nuevo.';
        }
      }

      case 'consulta_financiera': {
        const ctxFinanciero = 'El usuario hace una pregunta sobre conceptos financieros. Responde como educador financiero peruano: breve, claro, con ejemplos locales (bancos peruanos, montos en soles). Máximo 6 líneas. Si es sobre CTS, AFP, ONP, gratificación, etc., explica el contexto peruano específico.';
        const respFinanciero = await redactarConNETO(netoPrompt, ctxFinanciero, msg, historialConv);
        return respFinanciero || 'Buena pregunta. Te recomiendo consultar con tu banco o la SBS (sbs.gob.pe) para información detallada.\n\n¿Necesitas algo más con tus finanzas?';
      }

      case 'recordatorio_pago': {
        const planConfigRem = getUserPlanConfig(usuario);
        if (planConfigRem.recordatorios === false || planConfigRem.resumenDiario === false) {
          return '⭐ *Recordatorios y resúmenes diarios son una función Pro.*\n\nCon NETO Pro recibes tu resumen diario a la hora que elijas y recordatorios de pagos automáticos.\n\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        return '⏰ *Recordatorios de pago*\n\nYa te aviso *automáticamente 3 días antes* de que se te cobre una suscripción que detecté (Netflix, Spotify, etc.), para que decidas si la mantienes o la cancelas.\n\nTambién te recuerdo tus deudas y compromisos con fecha.\n\n🔗 Revisa o ajusta tus recordatorios en app.neto.pe/dashboard/configuracion';
      }
    }
  }
};
