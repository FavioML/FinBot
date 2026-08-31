const log = require('../../lib/logger');
// La línea de precios sale de PRO_PRECIOS: nunca se escribe a mano (ver lib/config).
const { lineaPrecioPro } = require('../../lib/config');
const { verificarEscritura, entro } = require('../../helpers/escritura-verificada');

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
          // Firmar *"Fuente: dolar.pe"* debajo de una constante hardcodeada es la mentira más
          // barata de todo el ítem 13: a alguien que PREGUNTA el tipo de cambio se le contesta
          // un número inventado con la fuente de al lado dando fe. Una caché vencida sí se
          // muestra — es real, sólo que de ayer — y se dice que es referencial.
          if (tc.fuente === 'fallback') return '💵 No pude obtener el tipo de cambio actual. Intenta en unos minutos.';
          const pieTC = tc.fuente === 'cache_vencida' ? '_Última cotización disponible (dolar.pe)_' : '_Fuente: dolar.pe_';
          return '💵 *Tipo de cambio USD/PEN*\n\n🟢 Compra: S/ ' + tc.compra.toFixed(4) + '\n🔴 Venta: S/ ' + tc.venta.toFixed(4) + '\n\n' + pieTC;
        } catch(e) {
          return '💵 No pude obtener el tipo de cambio actual. Intenta en unos minutos.';
        }
      }

      case 'convertir_moneda': {
        try {
          const montoConv = parseFloat(datos.monto);
          if (!montoConv || montoConv <= 0) return 'Dime cuánto quieres convertir. Ej: _"cuánto es 100 dólares en soles"_.';
          const tc = await obtenerTipoCambio();
          // Mismo criterio que `ver_tipo_cambio`: no se convierte con un tipo inventado.
          if (tc.fuente === 'fallback') return '💱 No pude obtener el tipo de cambio actual. Intenta en unos minutos.';
          const origenConv = (datos.moneda_origen || 'USD').toUpperCase();
          let resultado, textoConv;
          if (origenConv === 'USD') {
            resultado = montoConv * tc.venta;
            textoConv = '$' + montoConv.toFixed(2) + ' = *S/ ' + resultado.toFixed(2) + '*';
          } else {
            resultado = montoConv / tc.compra;
            textoConv = 'S/ ' + montoConv.toFixed(2) + ' = *$' + resultado.toFixed(2) + '*';
          }
          return '💱 *Conversión:*\n\n' + textoConv + '\n\n📊 TC Compra: S/ ' + tc.compra.toFixed(4) + '\n📊 TC Venta: S/ ' + tc.venta.toFixed(4) + '\n\n' + (tc.fuente === 'cache_vencida' ? '_Última cotización disponible (dolar.pe)_' : '_Fuente: dolar.pe_');
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
          const { data: txsBusq, error: errBusq } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id).ilike('comercio', '%' + comercioBusq + '%')
            .gte('fecha', desdeBusq).lte('fecha', hastaBusq).order('fecha', { ascending: false });
          // Al `catch` de abajo, que ya dice "No pude buscar ese gasto". Sin esto, una lectura
          // caida contestaba "No encontre gastos de Netflix en abril" — una afirmacion sobre
          // un comercio concreto, no un vacio.
          if (errBusq) throw errBusq;
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
          const [{ data: txs1, error: err1 }, { data: txs2, error: err2 }] = await Promise.all([
            supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desde1).lte('fecha', hasta1),
            supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desde2).lte('fecha', hasta2)
          ]);
          // **Las DOS mitades, y por eso este sitio no comparte arreglo con los otros.**
          // `Promise.all` no rechaza —supabase-js no lanza— asi que si cae UNA sola query la
          // otra llega entera y el calculo sigue corriendo: la diferencia y el porcentaje se
          // imprimen con un mes en cero. Eso no es "no hay datos": es "abril: S/ 0.00,
          // diferencia -S/ 1,240 (-100%)" sobre un mes que existio. Un numero plausible y
          // falso es peor que un cero, porque nadie sospecha de el.
          if (err1 || err2) {
            log.warn({ tag: 'LECTURA_CAIDA', intencion, usuarioId: usuario.id, mitad: [err1 && 'mes1', err2 && 'mes2'].filter(Boolean).join('+'), err: (err1 || err2).message }, 'comparar_meses: una de las dos mitades no se pudo leer');
            throw (err1 || err2);
          }
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
          // El desglose por categoria ya estaba calculado y solo llegaba a la IA: el texto fijo
          // se quedaba en los dos totales y obligaba al usuario a restar de memoria.
          // El signo va antes del simbolo de moneda: "-S/ 374.20", nunca "S/ -374.20".
          const conSigno = (n, dec) => (n >= 0 ? '+' : '-') + 'S/ ' + Math.abs(n).toFixed(dec);
          let respComp = '📊 *' + mE[mes1] + ' vs ' + mE[mes2Raw] + '*\n\n' + mE[mes1] + ': *S/ ' + total1.toFixed(2) + '*\n' + mE[mes2Raw] + ': *S/ ' + total2.toFixed(2) + '*\nDiferencia: *' + conSigno(diff, 2) + '* (' + (diff > 0 ? '+' : '') + pct + '%)';
          if (cambios.length) {
            respComp += '\n\n' + cambios.map(c => (getEmojiCategoria(c.cat)||'📋') + ' ' + c.cat + ': S/ ' + c.m1.toFixed(0) + ' vs S/ ' + c.m2.toFixed(0) + ' (' + conSigno(c.diff, 0) + ')').join('\n');
          }
          return respComp;
        } catch(e) {
          log.error({ tag: 'COMPARAR', err: e.message }, 'Error comparando meses');
          return 'No pude comparar los meses. Intenta: "compara marzo con febrero".';
        }
      }

      case 'ver_frecuencia_comercio': {
        try {
          const comercioFreq = datos.comercio;
          if (!comercioFreq) return '¿De qué comercio quieres saber la frecuencia? Ej: _"cuántas veces fui a Rappi"_';
          const { data: txsFreq, error: errFreq } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id).ilike('comercio', '%' + comercioFreq + '%')
            .order('fecha', { ascending: false });
          // El vacio de este sitio no es neutro, ACUSA: "No encontre pagos en Rappi. ¿Seguro
          // que se llama asi?". Sobre una lectura caida le manda a dudar del nombre a alguien
          // que lo escribio bien.
          if (errFreq) throw errFreq;
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
          // **Gemelo del sitio del alta que cerró 9D, y la decisión es la OPUESTA a propósito.**
          // Allá el mismo update perdido no corta nada: el alta se cierra igual y sólo se saluda
          // sin nombre (`mensajePrimerGasto(null)`), porque había un objetivo más valioso del
          // otro lado —meter a la persona adentro— y son dos escrituras distintas. Acá el
          // nombre ES el intent entero: no queda nada que salvar degradando, así que el único
          // desenlace honesto es decir que no se guardó. Confirmarlo deja a alguien creyendo
          // que se corrigió cómo lo llamamos, y Neto usa el nombre en el saludo cada mañana.
          const vNombre = await verificarEscritura(
            supabase.from('usuarios').update({ nombre: nombreLimpio }).eq('id', usuario.id).select('id'),
            { sitio: 'cambiar_nombre', userId: usuario.id, campos: ['nombre'] });
          if (!entro(vNombre)) {
            return 'No pude actualizar tu nombre. Intenta de nuevo.';
          }
          return '✅ Listo, ahora te llamo *' + nombreLimpio + '*. ¡Mucho gusto! 👋';
        } catch(e) {
          log.error({ tag: 'NOMBRE', err: e.message }, 'Error cambiando nombre');
          return 'No pude actualizar tu nombre. Intenta de nuevo.';
        }
      }

      // Unico intent que sigue redactando con IA junto a chiste_finanzas: la pregunta es
      // abierta y el handler no tiene ningun dato precalculado que formatear. El contexto
      // prohibe cifras porque ahi es donde el modelo falla (ejemplo de calculo de CTS mal
      // explicado en la corrida del 2026-07-21); la definicion en si salia correcta.
      case 'consulta_financiera': {
        const ctxFinanciero = 'El usuario hace una pregunta sobre conceptos financieros. Responde como educador financiero peruano: breve y claro, máximo 6 líneas. Define el concepto y su contexto peruano específico (CTS, AFP, ONP, gratificación, etc.). PROHIBIDO hacer cálculos o dar ejemplos con montos ("si ganas S/X recibirías S/Y"): nunca cites cifras de dinero ni tasas de interés. Sí puedes mencionar plazos y porcentajes fijados por ley. Si el usuario necesita un monto exacto, dile que lo confirme con su banco o en la SBS (sbs.gob.pe).';
        // gpt-4o y no el mini por defecto: es el unico intent donde una respuesta equivocada
        // es informacion financiera falsa para el usuario, y el volumen es bajo.
        const respFinanciero = await redactarConNETO(netoPrompt, ctxFinanciero, msg, historialConv, { model: 'gpt-4o' });
        return respFinanciero || 'Buena pregunta. Te recomiendo consultar con tu banco o la SBS (sbs.gob.pe) para información detallada.\n\n¿Necesitas algo más con tus finanzas?';
      }

      case 'recordatorio_pago': {
        const planConfigRem = getUserPlanConfig(usuario);
        if (planConfigRem.recordatorios === false || planConfigRem.resumenDiario === false) {
          return '⭐ *Recordatorios y resúmenes diarios son una función Pro.*\n\nCon NETO Pro recibes tu resumen diario a la hora que elijas y recordatorios de pagos automáticos.\n\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        return '⏰ *Recordatorios de pago*\n\nYa te aviso *automáticamente 3 días antes* de que se te cobre una suscripción que detecté (Netflix, Spotify, etc.), para que decidas si la mantienes o la cancelas.\n\nTambién te recuerdo tus deudas y compromisos con fecha.\n\n🔗 Revisa o ajusta tus recordatorios en app.neto.pe/dashboard/configuracion';
      }
    }
  }
};
