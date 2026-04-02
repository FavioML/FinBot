const log = require('../../lib/logger');
const { generarRefCode } = require('../../lib/formatters');
const { obtenerCuentasGmail } = require('../../gmail');

module.exports = {
  intents: ['ver_premium', 'ver_referidos', 'estado_cuenta'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const { supabase } = ctx;
    switch (intencion) {
      case 'ver_premium': {
        if (usuario.plan === 'premium') {
          const tipoPlanVp = usuario.tipo_plan || 'mensual';
          const venceVp = (usuario.premium_vence || usuario.fecha_vencimiento) ? new Date(usuario.premium_vence || usuario.fecha_vencimiento).toLocaleDateString('es-PE') : null;
          return '⭐ *Tu plan NETO Pro*\n\nPlan: *' + (tipoPlanVp === 'anual' ? 'Anual' : 'Mensual') + '*' + (venceVp ? '\nVence: ' + venceVp : '') + '\n\n✅ Historial ilimitado\n✅ Lectura automática de correos\n✅ Reportes PDF + CSV export\n✅ Recordatorios diarios\n✅ Consejos IA ilimitados';
        }
        return '⭐ *NETO Pro*\n\nDesbloquea todo el potencial de Neto:\n\n✅ Historial completo (no solo 1 mes)\n✅ Lectura automática de correos bancarios\n✅ Reportes PDF + exportar datos\n✅ Recordatorios diarios\n✅ Consejos IA ilimitados\n\n💰 *S/10/mes* o *S/99/año* (2 meses gratis)\n\n📲 Yapea al *970398192* (Favio Mendoza) y envíame la captura aquí.\n\n_¿Dudas? Escríbeme._';
      }

      case 'ver_referidos': {
        let refCode = usuario.ref_code;
        if (!refCode) {
          refCode = generarRefCode();
          await supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id);
        }
        const { data: misRefsNlp } = await supabase.from('referidos').select('activo').eq('referrer_id', usuario.id);
        const totalRefsNlp = (misRefsNlp || []).length;
        const activosNlp = (misRefsNlp || []).filter(r => r.activo).length;
        const railwayUrlRef = process.env.RAILWAY_URL || 'https://api.neto.pe';
        const mesesAcumNlp = Math.floor(activosNlp / 3);
        const progresoNlp = activosNlp % 3;
        let estadoRefNlp = '_Referidos: ' + totalRefsNlp + ' | Activos: ' + activosNlp + '_';
        if (mesesAcumNlp > 0) {
          estadoRefNlp += '\n✅ *' + (mesesAcumNlp === 1 ? '1 mes' : mesesAcumNlp + ' meses') + ' gratis ganado' + (mesesAcumNlp > 1 ? 's' : '') + '*';
          if (progresoNlp > 0) estadoRefNlp += ' | ' + progresoNlp + '/3 para el siguiente';
        } else {
          estadoRefNlp += ' | ' + progresoNlp + '/3 para tu primer mes gratis';
        }
        return '🎁 *Tu link de referido:*\n\n' + railwayUrlRef + '/r/' + refCode + '\n\nComparte con amigos. Cada *3 referidos* te dan *1 mes gratis* de Neto. 🎉\n\n' + estadoRefNlp;
      }

      case 'estado_cuenta': {
        try {
          const cuentasEst = await obtenerCuentasGmail(usuario.id);
          const esPremium = usuario.plan === 'premium';
          const vencimiento = usuario.premium_vence || usuario.fecha_vencimiento || null;
          const nombre = usuario.nombre || 'Usuario';
          let resp = '👤 *Tu cuenta, ' + nombre + ':*\n\n';
          resp += '📋 Plan: *' + (esPremium ? 'Pro ⭐' : 'Free') + '*\n';
          if (esPremium && vencimiento) resp += '📅 Vence: ' + new Date(vencimiento).toLocaleDateString('es-PE') + '\n';
          if (!esPremium) resp += '\n💡 _Escribe /premium para ver los beneficios Pro._\n';
          resp += '📧 Gmail: ' + (cuentasEst.length > 0 ? cuentasEst.map(c => c.email).join(', ') : 'No conectado') + '\n';
          resp += '🔔 Recordatorios: ' + (usuario.recordatorios_activos !== false ? 'Activos ✅' : 'Silenciados 🔇') + '\n';
          resp += '\n🔗 Más detalles en https://app.neto.pe/dashboard/configuracion';
          return resp;
        } catch(e) {
          log.error({ tag: 'ESTADO_CUENTA', err: e.message }, 'Error estado cuenta');
          return 'No pude consultar tu cuenta. Intenta de nuevo.';
        }
      }
    }
  }
};
