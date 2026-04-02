const log = require('../../lib/logger');

module.exports = {
  intents: ['ver_presupuesto', 'configurar_presupuesto', 'eliminar_presupuesto', 'ver_balance', 'ver_categorias'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, mesActual, anioActual, mE, netoPrompt, historialConv, ultimoDiaMes,
      formatearEstadoPresupuesto, guardarPresupuesto, getEmojiCategoria,
      obtenerCategoriasUsuario, formatearCategoriasMsg, redactarConNETO
    } = ctx;

    switch (intencion) {

      case 'ver_presupuesto': {
        const presupStr = await formatearEstadoPresupuesto(usuario.id);
        const ctxVp = 'Estado del presupuesto del usuario: ' + presupStr.replace(/[*_]/g, '');
        const respVp = await redactarConNETO(netoPrompt, ctxVp, msg, historialConv);
        return respVp || presupStr;
      }

      case 'configurar_presupuesto': {
        if (datos.categoria && datos.monto) {
          const alertaPct = datos.alerta_porcentaje || 80;
          await guardarPresupuesto(usuario.id, datos.categoria, datos.monto);
          await supabase.from('presupuestos').update({ alerta_porcentaje: alertaPct }).eq('usuario_id', usuario.id).eq('categoria', datos.categoria);
          const emojiPres = getEmojiCategoria(datos.categoria) || '💰';
          return '✅ Presupuesto configurado:\n' + emojiPres + ' *' + datos.categoria + ':* S/ ' + parseFloat(datos.monto).toFixed(2) + '/mes\n🔔 Te aviso cuando llegues al ' + alertaPct + '%.\n\n_Puedes cambiar el % de alerta: "alerta de Comida al 70%"_';
        }
        return '💰 Dime la categoría y el monto.\n\nEj:\n• _"límite de S/500 en Alimentación"_\n• _"presupuesto S/200 en Transporte, aviso al 70%"_';
      }

      case 'ver_categorias':
        return formatearCategoriasMsg(await obtenerCategoriasUsuario(usuario.id));

      case 'ver_balance': {
        try {
          const mesBal = datos.mes || mesActual;
          const anioBal = datos.anio || anioActual;
          const desdeBal = anioBal + '-' + String(mesBal).padStart(2,'0') + '-01';
          const hastaBal = anioBal + '-' + String(mesBal).padStart(2,'0') + '-' + String(ultimoDiaMes(anioBal, mesBal)).padStart(2,'0');
          const [{ data: gastosBal }, { data: ingresosBal }] = await Promise.all([
            supabase.from('transacciones').select('monto_pen,monto').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desdeBal).lte('fecha', hastaBal),
            supabase.from('transacciones').select('monto_pen,monto').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', desdeBal).lte('fecha', hastaBal)
          ]);
          const totalGBal = (gastosBal||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const totalIBal = (ingresosBal||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const balance = totalIBal - totalGBal;
          const pctGasto = totalIBal > 0 ? ((totalGBal / totalIBal) * 100).toFixed(0) : null;
          const ctxBal = 'Balance de ' + mE[mesBal] + ' ' + anioBal + ': Ingresos S/' + totalIBal.toFixed(2) + ', Gastos S/' + totalGBal.toFixed(2) + ', Balance ' + (balance >= 0 ? '+' : '') + 'S/' + balance.toFixed(2) + (pctGasto ? '. Ha gastado ' + pctGasto + '% de sus ingresos.' : '. Sin ingresos registrados — solo se muestran gastos.');
          const respBal = await redactarConNETO(netoPrompt, ctxBal, msg, historialConv);
          return respBal || (balance >= 0
            ? '✅ *Balance ' + mE[mesBal] + '*\n\n💰 Ingresos: S/ ' + totalIBal.toFixed(2) + '\n💸 Gastos: S/ ' + totalGBal.toFixed(2) + '\n📊 Balance: *+S/ ' + balance.toFixed(2) + '*'
            : '⚠️ *Balance ' + mE[mesBal] + '*\n\n💰 Ingresos: S/ ' + totalIBal.toFixed(2) + '\n💸 Gastos: S/ ' + totalGBal.toFixed(2) + '\n📊 Balance: *-S/ ' + Math.abs(balance).toFixed(2) + '*');
        } catch(e) {
          log.error({ tag: 'BALANCE', err: e.message }, 'Error calculando balance');
          return 'No pude calcular tu balance. Intenta de nuevo.';
        }
      }

      case 'eliminar_presupuesto': {
        try {
          const catElimP = datos.categoria;
          if (!catElimP) return '¿De qué categoría quieres eliminar el presupuesto? Ej: _"quita el límite de comida"_';
          const { data: presElim } = await supabase.from('presupuestos').select('*')
            .eq('usuario_id', usuario.id).ilike('categoria', '%' + catElimP + '%')
            .eq('mes', mesActual).eq('anio', anioActual);
          if (!presElim || !presElim.length) return 'No tienes presupuesto de *' + catElimP + '* este mes.';
          await supabase.from('presupuestos').delete().eq('id', presElim[0].id);
          return '✅ Eliminé el presupuesto de *' + presElim[0].categoria + '* (era S/ ' + parseFloat(presElim[0].monto_limite).toFixed(0) + ').\n\n_Ya no recibirás alertas de esa categoría._';
        } catch(e) {
          log.error({ tag: 'ELIM_PRES', err: e.message }, 'Error eliminar presupuesto');
          return 'No pude eliminar el presupuesto. Intenta de nuevo.';
        }
      }

    }
  }
};
