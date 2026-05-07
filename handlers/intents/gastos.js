const log = require('../../lib/logger');

module.exports = {
  intents: ['listar_gastos_mes', 'listar_gastos_semana', 'listar_gastos_dia', 'listar_gastos_categoria', 'ver_total_gastado', 'ver_gastos_rango_fecha', 'ver_gastos_fin_de_semana', 'gastos_hormiga'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, mesActual, anioActual, mE, netoPrompt, historialConv, ultimoDiaMes,
      getHistoryDateLimit, getEmojiCategoria, formatearResumen, redactarConNETO,
      obtenerGastosMes, obtenerGastosSemana, obtenerCuentasGmail,
      fechaHoyPeru, fechaAyerPeru, formatFecha,
      getUserPlanConfig
    } = ctx;

    const ADVICE_REGEX = /\b(anali[sz]a(?:r|me)?|consejo|recomienda(?:me|ción)?|recomendaci[oó]n|aconsej(?:a|ar|ame)|c[oó]mo\s+(?:ahorr|reduc|gast|mejorar|optimiz)|qu[eé]\s+(?:hago|deber[ií]a)|d[ií]me\s+qu[eé])\b/i;
    const isAdviceRequest = typeof msg === 'string' && ADVICE_REGEX.test(msg);
    if (isAdviceRequest) {
      const planConfigAdv = getUserPlanConfig(usuario);
      if (planConfigAdv.consejoPerWeek === 0) {
        return '⭐ *Análisis y consejos personalizados son una función Pro.*\n\nCon NETO Pro recibes consejos financieros con IA cada semana, basados en tus gastos reales.\n\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
      }
    }

    switch (intencion) {

      case 'listar_gastos_mes': {
        const fechaMinLgm = getHistoryDateLimit(usuario);
        // Si tiene 2+ cuentas Gmail y modo separado, mostrar por cuenta
        const cuentasGm = await obtenerCuentasGmail(usuario.id);
        if (cuentasGm.length >= 2 && usuario.reporte_gmail_modo === 'separado') {
          const mes2 = datos.mes || mesActual; const anio2 = datos.anio || anioActual;
          const desde2 = anio2+'-'+String(mes2).padStart(2,'0')+'-01';
          if (fechaMinLgm && desde2 < fechaMinLgm) return '🔒 Tu plan gratuito solo muestra el último mes de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
          const hasta2 = anio2+'-'+String(mes2).padStart(2,'0')+'-'+String(ultimoDiaMes(anio2,mes2)).padStart(2,'0');
          const { data: txsTodas } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde2).lte('fecha', hasta2);
          // Agrupar por cuenta_email (campo que se agrega en futuros registros)
          let respSep = '📊 *' + mE[mes2] + ' ' + anio2 + ' — por cuenta*\n\n';
          for (const c of cuentasGm) {
            const txsCuenta = (txsTodas||[]).filter(t => t.cuenta_email === c.email || (!t.cuenta_email && cuentasGm.indexOf(c) === 0));
            const totalC = txsCuenta.reduce((s,t) => s + parseFloat(t.monto_pen||t.monto||0), 0);
            respSep += '📧 *' + c.email + '*: S/ ' + totalC.toFixed(2) + ' (' + txsCuenta.length + ' movs)\n';
          }
          return respSep;
        }
        const mes = datos.mes || mesActual;
        const anio = datos.anio || anioActual;
        let txsMes;
        if (mes === mesActual && anio === anioActual) {
          txsMes = await obtenerGastosMes(usuario.id, fechaMinLgm);
        } else {
          const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
          if (fechaMinLgm && desde < fechaMinLgm) return '🔒 Tu plan gratuito solo muestra el último mes de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
          const hasta = anio + '-' + String(mes).padStart(2,'0') + '-' + String(ultimoDiaMes(anio, mes)).padStart(2,'0');
          const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
          txsMes = data || [];
        }
        const totalMesN = txsMes.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const porCatMes = {};
        const porSubMes = {};
        txsMes.forEach(t => {
          const cat = t.categoria || 'Otros'; const sub = t.subcategoria || 'sin_categoria';
          porCatMes[cat] = (porCatMes[cat]||0) + parseFloat(t.monto_pen || t.monto || 0);
          if (!porSubMes[cat]) porSubMes[cat] = {};
          porSubMes[cat][sub] = (porSubMes[cat][sub]||0) + parseFloat(t.monto_pen || t.monto || 0);
        });
        const catMesStr = Object.entries(porCatMes).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([c,m]) => (getEmojiCategoria(c)||'') + ' ' + c + ': S/ ' + m.toFixed(2)).join(', ');
        const subMesStr = Object.entries(porCatMes).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([c]) => {
          const subs = Object.entries(porSubMes[c]||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,m])=>s+' S/'+m.toFixed(2)).join(', ');
          return (getEmojiCategoria(c)||'') + c + ': ' + subs;
        }).join(' | ');
        const ctxMes = mE[mes] + ' ' + anio + ': ' + txsMes.length + ' movimientos. Total: S/ ' + totalMesN.toFixed(2) + '. Categorias con emoji: ' + (catMesStr || 'sin datos') + '. Subcategorias: ' + (subMesStr || 'sin datos') + '.';
        const respMes = await redactarConNETO(netoPrompt, ctxMes, msg, historialConv);
        return respMes || formatearResumen(txsMes, 'en ' + mE[mes]);
      }

      case 'listar_gastos_semana': {
        const txsSem = await obtenerGastosSemana(usuario.id);
        const totalSemN = txsSem.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const porCatSem = {};
        const porSubSem = {};
        txsSem.forEach(t => {
          const cat = t.categoria || 'Otros'; const sub = t.subcategoria || 'sin_categoria';
          porCatSem[cat] = (porCatSem[cat]||0) + parseFloat(t.monto_pen || t.monto || 0);
          if (!porSubSem[cat]) porSubSem[cat] = {};
          porSubSem[cat][sub] = (porSubSem[cat][sub]||0) + parseFloat(t.monto_pen || t.monto || 0);
        });
        const catSemStr = Object.entries(porCatSem).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([c,m]) => (getEmojiCategoria(c)||'') + ' ' + c + ': S/ ' + m.toFixed(2)).join(', ');
        // Comparativa semana anterior (usar fechaHoyPeru para evitar off-by-one con UTC)
        const hoyStr = fechaHoyPeru();
        const hoyD = new Date(hoyStr + 'T12:00:00');
        const hace14 = new Date(hoyD); hace14.setDate(hoyD.getDate()-14);
        const hace7 = new Date(hoyD); hace7.setDate(hoyD.getDate()-7);
        const { data: txsAnt } = await supabase.from('transacciones').select('monto,monto_pen').eq('usuario_id', usuario.id).eq('tipo','gasto').gte('fecha', hace14.toISOString().split('T')[0]).lte('fecha', hace7.toISOString().split('T')[0]);
        const totalAnt = (txsAnt||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const diffSem = totalSemN - totalAnt;
        const subSemStr = Object.entries(porCatSem).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c]) => {
          const subs = Object.entries(porSubSem[c]||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,m])=>s+' S/'+m.toFixed(2)).join(', ');
          return (getEmojiCategoria(c)||'') + c + ': ' + subs;
        }).join(' | ');
        const ctxSem = 'Semana: ' + txsSem.length + ' movimientos. Total: S/ ' + totalSemN.toFixed(2) + '. ' +
          (totalAnt > 0 ? 'Semana anterior: S/ ' + totalAnt.toFixed(2) + '. Diferencia: ' + (diffSem >= 0 ? '+' : '') + 'S/ ' + diffSem.toFixed(2) + '. ' : '') +
          'Top categorias con emoji: ' + (catSemStr || 'sin datos') + '. Subcategorias: ' + (subSemStr || 'sin datos') + '. ' +
          'Dia mas caro: ' + (txsSem.length > 0 ? txsSem.reduce((max,t) => parseFloat(t.monto_pen||t.monto||0) > parseFloat(max.monto_pen||max.monto||0) ? t : max, txsSem[0]).fecha : 'sin datos') +
          '.';
        const respSem = await redactarConNETO(netoPrompt, ctxSem, msg, historialConv);
        return respSem || formatearResumen(txsSem, 'esta semana');
      }

      case 'listar_gastos_dia': {
        // Usar fecha real de Perú; solo respetar datos.fecha si es una fecha explícita distinta a hoy/ayer
        const msgLDia = msg.toLowerCase();
        let fechaDia;
        if (msgLDia.includes('ayer')) {
          fechaDia = fechaAyerPeru();
        } else if (datos.fecha && !msgLDia.includes('hoy') && !msgLDia.includes('dia') && !msgLDia.includes('día')) {
          fechaDia = datos.fecha;
        } else {
          fechaDia = fechaHoyPeru();
        }
        const { data: txsDia } = await supabase.from('transacciones').select('*')
          .eq('usuario_id', usuario.id).eq('fecha', fechaDia).order('created_at', { ascending: false });
        if (!txsDia || txsDia.length === 0) return 'No tienes movimientos registrados el ' + formatFecha(fechaDia) + '.';
        const gastosDia = txsDia.filter(t => t.tipo !== 'ingreso');
        const ingresosDia = txsDia.filter(t => t.tipo === 'ingreso');
        const totalGDia = gastosDia.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const totalIDia = ingresosDia.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const porCatDia = {};
        gastosDia.forEach(t => { const c = t.categoria || 'Otros'; porCatDia[c] = (porCatDia[c]||0) + parseFloat(t.monto_pen || t.monto || 0); });
        const catDiaStr = Object.entries(porCatDia).sort((a,b)=>b[1]-a[1]).map(([c,m]) => (getEmojiCategoria(c)||'') + ' ' + c + ': S/ ' + m.toFixed(2)).join(', ');
        let ctxDia = formatFecha(fechaDia) + ': ' + txsDia.length + ' movimientos. ';
        if (gastosDia.length > 0) ctxDia += 'Gastos: S/ ' + totalGDia.toFixed(2) + ' en ' + gastosDia.length + ' transacciones. Categorias: ' + (catDiaStr || 'sin datos') + '. ';
        if (ingresosDia.length > 0) ctxDia += 'Ingresos: S/ ' + totalIDia.toFixed(2) + '. ';
        ctxDia += 'Detalle: ' + txsDia.slice(0,8).map(t => (t.tipo === 'ingreso' ? '💰' : '💸') + ' ' + (t.comercio||t.banco||'Pago') + ' ' + (t.moneda === 'USD' ? '$' : 'S/') + parseFloat(t.monto).toFixed(2) + ' [' + (t.categoria||'Otros') + ']').join(', ');
        const respDia = await redactarConNETO(netoPrompt, ctxDia, msg, historialConv);
        return respDia || '📊 *' + formatFecha(fechaDia) + '*\nGastos: S/ ' + totalGDia.toFixed(2) + ' (' + gastosDia.length + ' movimientos)\n\n' + catDiaStr;
      }

      case 'listar_gastos_categoria': {
        const fechaMinLgc = getHistoryDateLimit(usuario);
        const cat = datos.categoria;
        if (!cat) return 'Dime la categoria. Ej: _"gastos de Alimentación"_, _"que hay en Transporte"_';
        const mes = datos.mes || mesActual;
        const anio = datos.anio || anioActual;
        const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
        if (fechaMinLgc && desde < fechaMinLgc) return '🔒 Tu plan gratuito solo muestra el último mes de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
        const hasta = anio + '-' + String(mes).padStart(2,'0') + '-' + String(ultimoDiaMes(anio, mes)).padStart(2,'0');
        const { data: txs } = await supabase.from('transacciones').select('*')
          .eq('usuario_id', usuario.id).ilike('categoria', '%' + cat + '%')
          .gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
        if (!txs || txs.length === 0) return 'No encontre gastos en *' + cat + '* para ' + mE[mes] + ' ' + anio + '.';
        const total = txs.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto), 0);
        const emojiCat = getEmojiCategoria(cat) || '';
        let msgCat = emojiCat + ' *Gastos en ' + cat + '* (' + mE[mes] + ' ' + anio + ')\n\nTotal: *S/ ' + total.toFixed(2) + '*\n' + txs.length + ' transacciones\n\n';
        // Agrupar por subcategoria
        const porSub = {};
        txs.forEach(t => { const s = t.subcategoria || 'sin_categoria'; if (!porSub[s]) porSub[s] = []; porSub[s].push(t); });
        const subs = Object.keys(porSub);
        if (subs.length > 1 && subs.some(s => s !== 'sin_categoria')) {
          // Mostrar agrupado por subcategoria
          Object.entries(porSub).forEach(([sub, txsSub]) => {
            const totalSub = txsSub.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto), 0);
            msgCat += '*' + sub + '* — S/ ' + totalSub.toFixed(2) + '\n';
            txsSub.slice(0,4).forEach(t => { msgCat += '  • ' + (t.comercio || t.banco || 'Sin nombre') + ' S/ ' + parseFloat(t.monto_pen || t.monto).toFixed(2) + ' (' + formatFecha(t.fecha) + ')\n'; });
          });
        } else {
          txs.slice(0,10).forEach(t => { msgCat += '• ' + (t.comercio || t.banco || 'Sin nombre') + ' — S/ ' + parseFloat(t.monto_pen || t.monto).toFixed(2) + ' (' + formatFecha(t.fecha) + ')\n'; });
        }
        if (txs.length > 10) msgCat += '_...y ' + (txs.length-10) + ' mas_';
        return msgCat;
      }

      case 'ver_total_gastado': {
        const fechaMinVt = getHistoryDateLimit(usuario);
        const periodoVt = datos.periodo || 'mes';
        const catVt = datos.categoria;
        let txsVt = periodoVt === 'semana' ? await obtenerGastosSemana(usuario.id, fechaMinVt) : await obtenerGastosMes(usuario.id, fechaMinVt);
        if (catVt) txsVt = txsVt.filter(t => (t.categoria||'').toLowerCase().includes(catVt.toLowerCase()));
        const totalVt = txsVt.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const ctxVt = (catVt ? 'Categoria ' + catVt + ' en ' : 'Total ') + periodoVt + ': S/ ' + totalVt.toFixed(2) + ' en ' + txsVt.length + ' movimientos.';
        const respVt = await redactarConNETO(netoPrompt, ctxVt, msg, historialConv);
        return respVt || 'Llevas *S/ ' + totalVt.toFixed(2) + '* ' + (catVt ? 'en ' + catVt + ' ' : '') + 'esta ' + periodoVt + ' (' + txsVt.length + ' movimientos).';
      }

      case 'ver_gastos_rango_fecha': {
        try {
          const fechaIni = datos.fecha_inicio;
          const fechaFin = datos.fecha_fin;
          if (!fechaIni || !fechaFin) return 'Dime el rango de fechas. Ej: _"gastos del 1 al 15"_ o _"gastos del 5 al 20 de marzo"_';
          const { data: txsRango } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id).gte('fecha', fechaIni).lte('fecha', fechaFin)
            .eq('tipo', 'gasto').order('fecha', { ascending: false });
          if (!txsRango || !txsRango.length) return 'No hay gastos entre ' + fechaIni + ' y ' + fechaFin + '.';
          const totalRango = txsRango.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          let respRango = '📅 *Gastos del ' + fechaIni + ' al ' + fechaFin + ':*\n\n';
          respRango += '💰 Total: S/ ' + totalRango.toFixed(2) + ' (' + txsRango.length + ' gastos)\n\n';
          const topRango = txsRango.slice(0, 5);
          topRango.forEach(t => {
            const m = t.moneda === 'USD' ? '$' + parseFloat(t.monto).toFixed(2) : 'S/ ' + parseFloat(t.monto).toFixed(2);
            respRango += '• ' + (t.comercio || 'N/D') + ' — ' + m + ' (' + t.fecha + ')\n';
          });
          if (txsRango.length > 5) respRango += '\n_...y ' + (txsRango.length - 5) + ' más._';
          return respRango;
        } catch(e) {
          log.error({ tag: 'RANGO_FECHA', err: e.message }, 'Error gastos rango fecha');
          return 'No pude consultar ese rango. Intenta de nuevo.';
        }
      }

      case 'ver_gastos_fin_de_semana': {
        try {
          const txsFds = await obtenerGastosMes(usuario.id);
          const gastosFds = txsFds.filter(t => t.tipo !== 'ingreso');
          if (!gastosFds.length) return 'No tienes gastos registrados este mes.';
          const finDeSemana = gastosFds.filter(t => {
            const d = new Date(t.fecha + 'T12:00:00');
            return d.getDay() === 0 || d.getDay() === 6;
          });
          const entreSemana = gastosFds.filter(t => {
            const d = new Date(t.fecha + 'T12:00:00');
            return d.getDay() !== 0 && d.getDay() !== 6;
          });
          const totalFds = finDeSemana.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const totalEs = entreSemana.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const pctFds = gastosFds.length > 0 ? ((finDeSemana.length / gastosFds.length) * 100).toFixed(0) : 0;
          return '🗓️ *Gastos de fin de semana (sáb-dom):*\n\n🎉 Fin de semana: S/ ' + totalFds.toFixed(2) + ' (' + finDeSemana.length + ' gastos)\n💼 Entre semana: S/ ' + totalEs.toFixed(2) + ' (' + entreSemana.length + ' gastos)\n📊 ' + pctFds + '% de tus gastos son en finde\n\n_Los fines de semana gastas en promedio S/ ' + (finDeSemana.length > 0 ? (totalFds / finDeSemana.length).toFixed(2) : '0') + ' por compra._';
        } catch(e) {
          log.error({ tag: 'FDS', err: e.message }, 'Error gastos fin de semana');
          return 'No pude calcular los gastos del finde. Intenta de nuevo.';
        }
      }

      case 'gastos_hormiga': {
        // Buscar gastos pequeños (≤S/20) del mes actual
        const hoyGH = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
        const mesInicioGH = hoyGH.getFullYear() + '-' + String(hoyGH.getMonth() + 1).padStart(2, '0') + '-01';
        const { data: gastosGH } = await supabase.from('transacciones').select('monto, monto_pen, comercio, categoria')
          .eq('usuario_id', usuario.id).eq('tipo', 'gasto')
          .gte('fecha', mesInicioGH).lte('monto', 20).order('fecha', { ascending: false });

        if (!gastosGH || gastosGH.length < 3) {
          // Usuario nuevo o con pocos datos → guiarlo a registrar
          return '🐜 *¡Buena decisión! Los gastos hormiga son los que más duelen.*\n\n' +
            'Son esos gastos chiquitos (café, delivery, taxi, snacks) que parecen nada pero suman S/200-400 al mes.\n\n' +
            'Para calcular los tuyos necesito que registres tus gastos:\n\n' +
            '1️⃣ *Registra manual* → _"gasté 8 en café"_\n' +
            '2️⃣ *Envía foto* de tu comprobante Yape/Plin\n' +
            '3️⃣ *Plan Pro:* conecto tu Gmail y leo tus notificaciones bancarias automáticamente\n\n' +
            'Con una semana de datos ya puedo decirte exactamente cuánto pierdes en gastos hormiga. 📊\n\n' +
            '_¿Empezamos? Dime tu primer gasto del día._';
        }

        // Usuario con datos → mostrar análisis real
        const totalGH = gastosGH.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
        const porCatGH = {};
        gastosGH.forEach(t => { const c = t.categoria || 'Otros'; porCatGH[c] = (porCatGH[c] || 0) + parseFloat(t.monto_pen || t.monto); });
        const topCatsGH = Object.entries(porCatGH).sort((a, b) => b[1] - a[1]).slice(0, 3);
        const proyAnualGH = (totalGH / hoyGH.getDate()) * 365;

        let respGH = '🐜 *Tus gastos hormiga este mes:*\n\n';
        respGH += '💸 *' + gastosGH.length + ' gastos* menores a S/20 = *S/ ' + totalGH.toFixed(2) + '*\n\n';
        if (topCatsGH.length > 0) {
          respGH += '*¿En qué se van?*\n';
          topCatsGH.forEach(([cat, monto]) => { respGH += '• ' + cat + ': S/ ' + monto.toFixed(2) + '\n'; });
          respGH += '\n';
        }
        respGH += '📈 A ese ritmo serían ~*S/ ' + proyAnualGH.toFixed(0) + ' al año* en gastos hormiga.\n\n';
        respGH += '_Tip: Pon un presupuesto para controlarlos → "pon límite de 200 en ' + (topCatsGH[0] ? topCatsGH[0][0] : 'Delivery') + '"_';
        return respGH;
      }

      default:
        return null;
    }
  }
};
