const log = require('../../lib/logger');
// La línea de precios sale de PRO_PRECIOS: nunca se escribe a mano (ver lib/config).
const { lineaPrecioPro } = require('../../lib/config');
const { subcategoriaUtil } = require('../../lib/subcategoria');

/**
 * Las CINCO lecturas de este archivo que deciden la respuesta entera y no tienen `catch`
 * propio (37, 56, 99, 130 y 219 en el arbol viejo). supabase-js no lanza: sin mirar `error`,
 * un fallo de lectura salia por la misma puerta que "no anotaste nada" — un reporte en
 * S/ 0.00, un "No tienes movimientos registrados el 5 de abril", o el discurso de bienvenida
 * de gastos hormiga a alguien con 300 transacciones.
 *
 * **Devuelven este mensaje, NO lanzan, y eso es la decision del sitio, no estilo.** El motivo
 * es el catch general de `procesarMensajeLibre` (message-processor.js), que es donde termina
 * un throw desde aca: escribe una fila en `nlp_errors` con `error_tipo:"error"` —atribuyendole
 * a la NLP un fallo que fue de la DB, sobre el camino mas caliente por volumen—, notifica al
 * admin, y le contesta al usuario "Tuve un problema" en vez de decirle que no se pudo leer.
 *
 * Y ademas se pierde por el camino: los dos redirects de `registrar_manual`
 * (`transacciones.js:289` y `:356`) envuelven el `dispatchIntent` en un catch que solo
 * loguea, y `detectarQuerySinMonto` manda `listar_gastos_dia` justo por ahi. Un throw se
 * traga y el mensaje sigue hacia la rama de registro.
 *
 * **Ojo con la version anterior de este parrafo, que decia que ese camino REGISTRA un gasto.
 * Es falso y lo encontro la revision adversarial.** El de `:356` no puede: `transacciones.js:411`
 * corta el rescate con `redirect || …`, y el comentario de ahi arriba documenta ese caso
 * exacto ("un timeout convertia 'gaste 20 en movilidad, cuanto llevo hoy' en una transaccion").
 * El de `:289` solo podria si `parsearRegistroManual` inventara un monto sobre una pregunta.
 * Medido: con el parser devolviendo `ok:false` —el caso normal— salen CERO registros en las
 * cuatro combinaciones probadas, y el usuario recibe "No pude leer el monto de ahi". O sea que
 * el dano medido hoy es una respuesta equivocada, no plata fantasma. Alcanza igual para
 * decidir: ninguna de las dos salidas del throw le dice la verdad a quien pregunto.
 *
 * El texto es distinto A PROPOSITO del de "no hay datos" y del de las escrituras de 9A
 * ("...ahora mismo. Vuelve a intentarlo"): si alguien los unifica, los tests dejan de poder
 * distinguir "no habia datos" de "no se pudo preguntar", que es todo el punto del arreglo.
 */
const MSG_LECTURA_CAIDA = 'No pude consultar tus movimientos en este momento. Intenta de nuevo en unos segundos.';
// El tag va en una constante y no repetido nueve veces: es el UNICO rastro de que esto pasa
// en produccion (el mensaje al usuario no distingue una caida de otra), asi que un literal
// mal escrito lo saca de la busqueda sin romper nada.
const LECTURA_CAIDA_TAG = 'LECTURA_CAIDA';

/**
 * Los tres sitios de este archivo cuya lectura vive UNA funcion mas abajo, en
 * `obtenerGastosMes` / `obtenerGastosSemana`, que desde el item 8 LANZAN cuando la lectura
 * cae. No son de los dieciseis y se agregan igual, por una razon puntual: sin esto
 * `listar_gastos_mes` quedaba contestando de DOS formas opuestas segun la rama —mensaje
 * honesto si preguntas por marzo, "Tuve un problema" + fila en `nlp_errors` + aviso al admin
 * si preguntas por el mes actual—, y un intent que se contradice consigo mismo es peor que
 * cualquiera de las dos politicas. Lo encontro la revision adversarial.
 *
 * `obtenerGastosSemana` y `ver_total_gastado` entran por lo mismo: son los otros dos destinos
 * de `detectarQuerySinMonto`, o sea que comparten exactamente el camino que motivo la
 * decision, y dejarlos lanzando invitaba a unificar los cinco al reves.
 *
 * NO se toca el helper: sigue lanzando, y sus otros consumidores (analytics, los crons) ya
 * tienen su propio catch con su propio mensaje. Lo que se decide aca es que hace ESTE
 * archivo con el throw, que es la pregunta del item.
 */
async function leerOMensaje(fn, ctxLog) {
  try {
    return { txs: await fn() };
  } catch (e) {
    log.warn({ tag: LECTURA_CAIDA_TAG, ...ctxLog, err: e && e.message }, 'no se pudo leer transacciones (helper)');
    return { caida: true };
  }
}

module.exports = {
  intents: ['listar_gastos_mes', 'listar_gastos_semana', 'listar_gastos_dia', 'listar_gastos_categoria', 'ver_total_gastado', 'ver_gastos_rango_fecha', 'ver_gastos_fin_de_semana', 'gastos_hormiga'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, mesActual, anioActual, mE, ultimoDiaMes,
      getHistoryDateLimit, getEmojiCategoria, formatearResumen,
      obtenerGastosMes, obtenerGastosSemana, obtenerCuentasGmail,
      fechaHoyPeru, fechaAyerPeru, formatFecha,
      getUserPlanConfig
    } = ctx;

    const ADVICE_REGEX = /\b(anali[sz]a(?:r|me)?|consejo|recomienda(?:me|ción)?|recomendaci[oó]n|aconsej(?:a|ar|ame)|c[oó]mo\s+(?:ahorr|reduc|gast|mejorar|optimiz)|qu[eé]\s+(?:hago|deber[ií]a)|d[ií]me\s+qu[eé])\b/i;
    const isAdviceRequest = typeof msg === 'string' && ADVICE_REGEX.test(msg);
    if (isAdviceRequest) {
      const planConfigAdv = getUserPlanConfig(usuario);
      if (planConfigAdv.consejoPerWeek === 0) {
        return '⭐ *Análisis y consejos personalizados son una función Pro.*\n\nCon NETO Pro recibes consejos financieros con IA cada semana, basados en tus gastos reales.\n\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
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
          const { data: txsTodas, error: errTodas } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde2).lte('fecha', hasta2);
          // Sin esto el desglose sale con S/ 0.00 en CADA cuenta, que es peor que un total
          // faltante: parece un mes sin gastar y encima parece que Gmail dejo de traer nada.
          if (errTodas) {
            log.warn({ tag: LECTURA_CAIDA_TAG, intencion, usuarioId: usuario.id, err: errTodas.message }, 'listar_gastos_mes por cuenta: no se pudo leer transacciones');
            return MSG_LECTURA_CAIDA;
          }
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
          // La rama de al lado devuelve mensaje; esta lanzaba. Mismo intent, misma pregunta.
          const r = await leerOMensaje(() => obtenerGastosMes(usuario.id, fechaMinLgm), { intencion, usuarioId: usuario.id });
          if (r.caida) return MSG_LECTURA_CAIDA;
          txsMes = r.txs;
        } else {
          const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
          if (fechaMinLgm && desde < fechaMinLgm) return '🔒 Tu plan gratuito solo muestra el último mes de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
          const hasta = anio + '-' + String(mes).padStart(2,'0') + '-' + String(ultimoDiaMes(anio, mes)).padStart(2,'0');
          const { data, error: errMes } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
          // La rama del mes ACTUAL usa `obtenerGastosMes`, que ya lanza (item 8). Esta rama
          // —el historial, o sea justo lo que compra el plan Pro— se quedaba muda:
          // `formatearResumen([])` responde "Sin movimientos" sobre el mes que el usuario
          // acaba de pagar por poder ver.
          if (errMes) {
            log.warn({ tag: LECTURA_CAIDA_TAG, intencion, usuarioId: usuario.id, mes, anio, err: errMes.message }, 'listar_gastos_mes historico: no se pudo leer transacciones');
            return MSG_LECTURA_CAIDA;
          }
          txsMes = data || [];
        }
        // formatearResumen ya ordena por monto, calcula el % de cada categoria y aplica las
        // negritas de WhatsApp. La IA reordenaba mal las categorias y perdia los porcentajes.
        return formatearResumen(txsMes, 'en ' + mE[mes]);
      }

      case 'listar_gastos_semana': {
        const rSem = await leerOMensaje(() => obtenerGastosSemana(usuario.id), { intencion, usuarioId: usuario.id });
        if (rSem.caida) return MSG_LECTURA_CAIDA;
        const txsSem = rSem.txs;
        const totalSemN = txsSem.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        // Comparativa semana anterior (usar fechaHoyPeru para evitar off-by-one con UTC)
        const hoyStr = fechaHoyPeru();
        const hoyD = new Date(hoyStr + 'T12:00:00');
        const hace14 = new Date(hoyD); hace14.setDate(hoyD.getDate()-14);
        const hace7 = new Date(hoyD); hace7.setDate(hoyD.getDate()-7);
        const { data: txsAnt, error: errAnt } = await supabase.from('transacciones').select('monto,monto_pen').eq('usuario_id', usuario.id).eq('tipo','gasto').gte('fecha', hace14.toISOString().split('T')[0]).lte('fecha', hace7.toISOString().split('T')[0]);
        // ACCESORIA, y por eso es la unica de las siete que no corta: `txsSem` sale de
        // `obtenerGastosSemana`, que lanza si la lectura cae, asi que si llegamos aca el
        // resumen de ESTA semana es correcto y completo. Lo que se pierde es la linea
        // comparativa. Lo que no puede seguir pasando es que se pierda MUDA: "gastaste 0 la
        // semana pasada" y "no se pudo preguntar" se ven identicos desde afuera —sin linea—
        // y sin nadie enterado.
        if (errAnt) log.warn({ tag: LECTURA_CAIDA_TAG, intencion, usuarioId: usuario.id, err: errAnt.message }, 'listar_gastos_semana: va sin comparativa, la semana anterior no se pudo leer');
        const totalAnt = (txsAnt||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const diffSem = totalSemN - totalAnt;
        // El resumen base mas los dos datos que ya se calculan aca y el texto fijo anterior
        // descartaba: comparativa contra la semana pasada y cual fue el gasto mas alto.
        let respSem = formatearResumen(txsSem, 'esta semana');
        if (totalAnt > 0) {
          respSem += '\n' + (diffSem >= 0 ? '📈' : '📉') + ' Semana pasada: *S/ ' + totalAnt.toFixed(2) + '* (' + (diffSem >= 0 ? '+' : '-') + 'S/ ' + Math.abs(diffSem).toFixed(2) + ')';
        }
        if (txsSem.length > 0) {
          const txMasCara = txsSem.reduce((max,t) => parseFloat(t.monto_pen||t.monto||0) > parseFloat(max.monto_pen||max.monto||0) ? t : max, txsSem[0]);
          respSem += '\n🔝 Mayor gasto: ' + (txMasCara.comercio || txMasCara.banco || 'Sin nombre') + ' *S/ ' + parseFloat(txMasCara.monto_pen || txMasCara.monto || 0).toFixed(2) + '* (' + formatFecha(txMasCara.fecha) + ')';
        }
        return respSem;
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
        const { data: txsDia, error: errDia } = await supabase.from('transacciones').select('*')
          .eq('usuario_id', usuario.id).eq('fecha', fechaDia).order('created_at', { ascending: false });
        // El destino mas caliente de `detectarQuerySinMonto` ("cuanto gaste hoy"): la lectura
        // caida contestaba "No tienes movimientos registrados el 5 de abril" a alguien que
        // acababa de anotar tres. Se lo cree, y no vuelve a preguntar.
        if (errDia) {
          log.warn({ tag: LECTURA_CAIDA_TAG, intencion, usuarioId: usuario.id, fecha: fechaDia, err: errDia.message }, 'listar_gastos_dia: no se pudo leer transacciones');
          return MSG_LECTURA_CAIDA;
        }
        if (!txsDia || txsDia.length === 0) return 'No tienes movimientos registrados el ' + formatFecha(fechaDia) + '.';
        const gastosDia = txsDia.filter(t => t.tipo !== 'ingreso');
        const ingresosDia = txsDia.filter(t => t.tipo === 'ingreso');
        const totalGDia = gastosDia.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const totalIDia = ingresosDia.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const porCatDia = {};
        gastosDia.forEach(t => { const c = t.categoria || 'Otros'; porCatDia[c] = (porCatDia[c]||0) + parseFloat(t.monto_pen || t.monto || 0); });
        const catDiaStr = Object.entries(porCatDia).sort((a,b)=>b[1]-a[1]).map(([c,m]) => (getEmojiCategoria(c)||'') + ' ' + c + ': S/ ' + m.toFixed(2)).join(', ');
        // "Que gaste hoy" pide el detalle, no solo el total: el texto fijo anterior se quedaba
        // en el agregado por categoria y la lista movimiento a movimiento solo la veia la IA.
        let respDia = '📊 *' + formatFecha(fechaDia) + '*\n';
        if (gastosDia.length > 0) respDia += 'Gastos: *S/ ' + totalGDia.toFixed(2) + '* (' + gastosDia.length + ' movimiento' + (gastosDia.length === 1 ? '' : 's') + ')\n';
        if (ingresosDia.length > 0) respDia += 'Ingresos: *S/ ' + totalIDia.toFixed(2) + '* (' + ingresosDia.length + ')\n';
        // Con un solo gasto el desglose por categoria repite la linea de detalle.
        if (catDiaStr && gastosDia.length > 1) respDia += '\n' + catDiaStr + '\n';
        respDia += '\n' + txsDia.slice(0,8).map(t => (t.tipo === 'ingreso' ? '💰' : '💸') + ' ' + (t.comercio||t.banco||'Pago') + ' ' + (t.moneda === 'USD' ? '$' : 'S/ ') + parseFloat(t.monto).toFixed(2)).join('\n');
        if (txsDia.length > 8) respDia += '\n_...y ' + (txsDia.length - 8) + ' mas_';
        return respDia;
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
        const { data: txs, error: errCat } = await supabase.from('transacciones').select('*')
          .eq('usuario_id', usuario.id).ilike('categoria', '%' + cat + '%')
          .gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
        // "No encontre gastos en Alimentacion" sobre una lectura caida no es un vacio: es una
        // afirmacion sobre una categoria concreta, y de las que llevan a la gente a
        // re-registrar lo que ya estaba.
        if (errCat) {
          log.warn({ tag: LECTURA_CAIDA_TAG, intencion, usuarioId: usuario.id, categoria: cat, err: errCat.message }, 'listar_gastos_categoria: no se pudo leer transacciones');
          return MSG_LECTURA_CAIDA;
        }
        if (!txs || txs.length === 0) return 'No encontre gastos en *' + cat + '* para ' + mE[mes] + ' ' + anio + '.';
        const total = txs.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto), 0);
        const emojiCat = getEmojiCategoria(cat) || '';
        let msgCat = emojiCat + ' *Gastos en ' + cat + '* (' + mE[mes] + ' ' + anio + ')\n\nTotal: *S/ ' + total.toFixed(2) + '*\n' + txs.length + ' transacciones\n\n';
        // Agrupar por subcategoria
        const porSub = {};
        // La clave es la sub MOSTRABLE o '(General)': agrupar por el centinela crudo pintaba
        // un encabezado *Sin_categoria* (la DB lo capitaliza, ver lib/subcategoria).
        txs.forEach(t => { const s = subcategoriaUtil(t.subcategoria) || '(General)'; if (!porSub[s]) porSub[s] = []; porSub[s].push(t); });
        const subs = Object.keys(porSub);
        if (subs.length > 1 && subs.some(s => s !== '(General)')) {
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
        const rVt = await leerOMensaje(() => (periodoVt === 'semana' ? obtenerGastosSemana(usuario.id, fechaMinVt) : obtenerGastosMes(usuario.id, fechaMinVt)), { intencion, usuarioId: usuario.id, periodo: periodoVt });
        if (rVt.caida) return MSG_LECTURA_CAIDA;
        let txsVt = rVt.txs;
        if (catVt) txsVt = txsVt.filter(t => (t.categoria||'').toLowerCase().includes(catVt.toLowerCase()));
        const totalVt = txsVt.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        return 'Llevas *S/ ' + totalVt.toFixed(2) + '* ' + (catVt ? 'en ' + catVt + ' ' : '') + (periodoVt === 'semana' ? 'esta semana' : 'este mes') + ' (' + txsVt.length + ' movimientos).';
      }

      case 'ver_gastos_rango_fecha': {
        try {
          const fechaIni = datos.fecha_inicio;
          const fechaFin = datos.fecha_fin;
          if (!fechaIni || !fechaFin) return 'Dime el rango de fechas. Ej: _"gastos del 1 al 15"_ o _"gastos del 5 al 20 de marzo"_';
          const { data: txsRango, error: errRango } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id).gte('fecha', fechaIni).lte('fecha', fechaFin)
            .eq('tipo', 'gasto').order('fecha', { ascending: false });
          // Este SI lanza, al reves que los cinco de arriba: el `catch` de doce lineas mas
          // abajo ya devuelve "No pude consultar ese rango", que es la verdad, y vive DENTRO
          // del handler — el throw no sale a los catch que lo tragan y siguen registrando.
          if (errRango) throw errRango;
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
        const { data: gastosGH, error: errGH } = await supabase.from('transacciones').select('monto, monto_pen, comercio, categoria')
          .eq('usuario_id', usuario.id).eq('tipo', 'gasto')
          .gte('fecha', mesInicioGH).lte('monto', 20).order('fecha', { ascending: false });
        // El vacio de este sitio no es un "no hay datos" neutro: dispara el discurso de
        // bienvenida ("necesito que registres tus gastos", "con una semana de datos ya puedo
        // decirte..."). Sobre una lectura caida se lo come alguien con 300 transacciones.
        if (errGH) {
          log.warn({ tag: LECTURA_CAIDA_TAG, intencion, usuarioId: usuario.id, err: errGH.message }, 'gastos_hormiga: no se pudo leer transacciones');
          return MSG_LECTURA_CAIDA;
        }

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
