const log = require('../../lib/logger');
const { validarMonto } = require('../../lib/validators');
const { verificarEscritura, entro } = require('../../helpers/escritura-verificada');

module.exports = {
  intents: ['ver_presupuesto', 'configurar_presupuesto', 'eliminar_presupuesto', 'ver_balance', 'ver_categorias'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, mesActual, anioActual, mE, ultimoDiaMes,
      formatearEstadoPresupuesto, guardarPresupuesto, getEmojiCategoria,
      obtenerCategoriasUsuario, formatearCategoriasMsg
    } = ctx;

    switch (intencion) {

      // formatearEstadoPresupuesto ya devuelve el texto con barras de progreso y semaforos.
      // Pasarlo por la IA lo re-redactaba en prosa y destruia ese formato.
      case 'ver_presupuesto':
        return await formatearEstadoPresupuesto(usuario.id);

      case 'configurar_presupuesto': {
        if (datos.categoria && datos.monto) {
          // El monto del NLP entraba sin validar (guardarPresupuesto no lo checaba):
          // un "límite de -500" o un monto sobre el tope se persistía y rompía el
          // cálculo de % del presupuesto. Validar acá da un mensaje amigable; el
          // guard duro vive además en services/budget.js como defensa.
          const montoPres = validarMonto(datos.monto);
          if (montoPres === null) {
            return '⚠️ Ese monto no me cuadra. Dame un número entre S/0.01 y S/999,999.99.\n\nEj: _"límite de S/500 en Alimentación"_';
          }
          const alertaPct = datos.alerta_porcentaje || 80;
          const filaPres = await guardarPresupuesto(usuario.id, datos.categoria, montoPres);
          // **El WHERE cambió, y ese cambio es la mitad del arreglo.** Filtraba por
          // `(usuario_id, categoria)` sin `mes`/`anio`, así que "aviso al 70%" reescribía el
          // umbral de TODOS los meses de esa categoría, historia incluida — y de paso "cero
          // filas" no significaba nada, porque nunca se supo si apuntaba a la fila que se
          // acababa de escribir. `guardarPresupuesto` hace un upsert con `.select().single()`
          // sobre `(usuario_id, categoria, subcategoria, mes, anio)` y DEVUELVE esa fila, así
          // que su `id` es el objetivo exacto. `verificarAlertaPresupuesto` sólo lee el mes en
          // curso: los meses viejos no tenían por qué moverse nunca.
          //
          // Las dos mitades del mensaje se separan porque son dos escrituras: el presupuesto
          // ya está guardado (si no, `guardarPresupuesto` habría lanzado al catch de abajo), y
          // lo único que puede faltar es el umbral. Confirmar el monto sigue siendo verdad;
          // prometer el aviso "al 70%" cuando la columna quedó en lo que estaba, no.
          const vAlerta = filaPres && filaPres.id
            ? await verificarEscritura(
              supabase.from('presupuestos').update({ alerta_porcentaje: alertaPct }).eq('id', filaPres.id).select('id'),
              { sitio: 'configurar_presupuesto_alerta', userId: usuario.id, campos: ['alerta_porcentaje'] })
            : 'sin_fila';
          const emojiPres = getEmojiCategoria(datos.categoria) || '💰';
          const lineaAlerta = entro(vAlerta)
            ? '\n🔔 Te aviso cuando llegues al ' + alertaPct + '%.\n\n_Puedes cambiar el % de alerta: "alerta de Comida al 70%"_'
            : '\n🔔 El aviso quedó como estaba: no pude moverlo al ' + alertaPct + '%.\n\n_Vuelve a decírmelo completo para reintentarlo: "límite de S/' + montoPres.toFixed(0) + ' en ' + datos.categoria + ', aviso al ' + alertaPct + '%"_';
          return '✅ Presupuesto configurado:\n' + emojiPres + ' *' + datos.categoria + ':* S/ ' + montoPres.toFixed(2) + '/mes' + lineaAlerta;
        }
        return '💰 Dime la categoría y el monto.\n\nEj:\n• _"límite de S/500 en Alimentación"_\n• _"presupuesto S/200 en Transporte, aviso al 70%"_';
      }

      case 'ver_categorias':
        return formatearCategoriasMsg(await obtenerCategoriasUsuario(usuario.id));

      case 'ver_balance': {
        try {
          // Pre-check: el LLM clasifica "cuánto me queda del presupuesto de comida"
          // como manage_budget action=balance (general del mes), cuando el usuario
          // en realidad pide el saldo de UN presupuesto. Espejo del pre-check de
          // 'registrar_manual' en transacciones.js. Solo reroutea si el detector
          // resuelve a ver_presupuesto — el resto (saldo/balance directo, totales,
          // gasto mayor/menor) cae al flujo normal de ver_balance.
          try {
            const { detectarQuerySinMonto } = require('./transacciones');
            const redirectBal = detectarQuerySinMonto(msg);
            if (redirectBal && redirectBal.intencion === 'ver_presupuesto') {
              // Vía `dispatchIntent` como los otros tres redirects (M21). Acá el muro ya
              // cortó antes —`ver_balance` también es lectura— así que hoy no cambia nada;
              // pasa por el dispatch para que la regla sea una sola y no dependa de que el
              // origen siga clasificado como lectura mañana.
              const { dispatchIntent } = require('../intent-registry');
              log.info({ tag: 'QUERY_REDIRECT', from: 'ver_balance', to: 'ver_presupuesto', msg: (msg||'').substring(0, 80) }, 'Query de presupuesto disfrazada como balance');
              const dBal = await dispatchIntent({ intencion: 'ver_presupuesto', msg, datos: redirectBal.datos, usuario, from, ctx });
              if (dBal.manejado) return dBal.respuesta;
            }
          } catch(eRedirBal) { log.warn({ tag: 'QUERY_REDIRECT', err: eRedirBal.message }, 'Fallback redirect ver_balance falló'); }

          const mesBal = datos.mes || mesActual;
          const anioBal = datos.anio || anioActual;
          const desdeBal = anioBal + '-' + String(mesBal).padStart(2,'0') + '-01';
          const hastaBal = anioBal + '-' + String(mesBal).padStart(2,'0') + '-' + String(ultimoDiaMes(anioBal, mesBal)).padStart(2,'0');
          const [{ data: gastosBal, error: errG }, { data: ingresosBal, error: errI }] = await Promise.all([
            supabase.from('transacciones').select('monto_pen,monto').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desdeBal).lte('fecha', hastaBal),
            supabase.from('transacciones').select('monto_pen,monto').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', desdeBal).lte('fecha', hastaBal)
          ]);
          // **El peor de los dieciseis, y el que obliga a mirar las DOS mitades.** El balance
          // es ingresos menos gastos: si cae la mitad de los ingresos, la otra llega entera y
          // el resultado es `-gastos reales`. O sea un balance NEGATIVO, con los gastos de
          // verdad, presentado con el ⚠️ y el "Llevas gastado el 100% de tus ingresos".
          // Nada en la pantalla delata que faltó una consulta. `Promise.all` no ayuda: no
          // rechaza, porque supabase-js no lanza.
          if (errG || errI) {
            log.warn({ tag: 'LECTURA_CAIDA', intencion, usuarioId: usuario.id, mitad: [errG && 'gastos', errI && 'ingresos'].filter(Boolean).join('+'), err: (errG || errI).message }, 'ver_balance: una de las dos mitades no se pudo leer');
            throw (errG || errI);
          }
          const totalGBal = (gastosBal||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const totalIBal = (ingresosBal||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const balance = totalIBal - totalGBal;
          const pctGasto = totalIBal > 0 ? ((totalGBal / totalIBal) * 100).toFixed(0) : null;
          // El % de ingresos gastado se calculaba y solo llegaba a la IA; ahora se imprime.
          return (balance >= 0
            ? '✅ *Balance ' + mE[mesBal] + '*\n\n💰 Ingresos: S/ ' + totalIBal.toFixed(2) + '\n💸 Gastos: S/ ' + totalGBal.toFixed(2) + '\n📊 Balance: *+S/ ' + balance.toFixed(2) + '*'
            : '⚠️ *Balance ' + mE[mesBal] + '*\n\n💰 Ingresos: S/ ' + totalIBal.toFixed(2) + '\n💸 Gastos: S/ ' + totalGBal.toFixed(2) + '\n📊 Balance: *-S/ ' + Math.abs(balance).toFixed(2) + '*')
            + (pctGasto ? '\n\n_Llevas gastado el ' + pctGasto + '% de tus ingresos._' : '');
        } catch(e) {
          log.error({ tag: 'BALANCE', err: e.message }, 'Error calculando balance');
          return 'No pude calcular tu balance. Intenta de nuevo.';
        }
      }

      case 'eliminar_presupuesto': {
        try {
          const catElimP = datos.categoria;
          if (!catElimP) return '¿De qué categoría quieres eliminar el presupuesto? Ej: _"quita el límite de comida"_';
          const { data: presElim, error: errPresElim } = await supabase.from('presupuestos').select('*')
            .eq('usuario_id', usuario.id).ilike('categoria', '%' + catElimP + '%')
            .eq('mes', mesActual).eq('anio', anioActual);
          // "No tienes presupuesto de Alimentación este mes" sobre una lectura caída es el ejemplo
          // que da nombre a la clase: la persona se queda creyendo que no configuró nada.
          if (errPresElim) {
            log.warn({ tag: 'LECTURA_CAIDA', intencion, usuarioId: usuario.id, categoria: catElimP, err: errPresElim.message }, 'eliminar_presupuesto: no se pudo leer presupuestos');
            throw errPresElim;
          }
          if (!presElim || !presElim.length) return 'No tienes presupuesto de *' + catElimP + '* este mes.';
          // Gemelo exacto de `eliminar_meta`, y con el mismo motivo para separar los dos malos:
          // el éxito recita el monto que era (`S/ 500`) desde la fila que se leyó arriba. Sobre
          // una fila que ya no está, esa cifra es un recibo de algo que no ocurrió acá.
          const vDelPres = await verificarEscritura(
            supabase.from('presupuestos').delete().eq('id', presElim[0].id).select('id'),
            { sitio: 'eliminar_presupuesto', userId: usuario.id, campos: ['id'] });
          if (vDelPres === 'sin_fila') {
            return 'El presupuesto de *' + presElim[0].categoria + '* ya no está.\n\n_Mira los que te quedan con "mis presupuestos"._';
          }
          if (!entro(vDelPres)) {
            return 'No pude eliminar el presupuesto. Intenta de nuevo.';
          }
          return '✅ Eliminé el presupuesto de *' + presElim[0].categoria + '* (era S/ ' + parseFloat(presElim[0].monto_limite).toFixed(0) + ').\n\n_Ya no recibirás alertas de esa categoría._';
        } catch(e) {
          log.error({ tag: 'ELIM_PRES', err: e.message }, 'Error eliminar presupuesto');
          return 'No pude eliminar el presupuesto. Intenta de nuevo.';
        }
      }

    }
  }
};
