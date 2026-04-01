const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');

async function registrarReferido(referrerId, referidoId) {
  try {
    const { data: existe } = await supabase.from('referidos').select('id').eq('referrer_id', referrerId).eq('referido_id', referidoId).single();
    if (existe) return;
    const { data: referrer } = await supabase.from('usuarios').select('ref_code').eq('id', referrerId).single();
    if (!referrer) return;
    await supabase.from('referidos').insert({ ref_code: referrer.ref_code, referrer_id: referrerId, referido_id: referidoId });
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message }, 'Error registrando referido'); }
}

async function verificarProReferidos(referrerId) {
  try {
    const { data: refs } = await supabase.from('referidos').select('referido_id, activo').eq('referrer_id', referrerId);
    if (!refs || refs.length === 0) return;
    for (const ref of refs) {
      if (ref.activo) continue;
      const { count } = await supabase.from('transacciones').select('*', { count: 'exact', head: true }).eq('usuario_id', ref.referido_id);
      if ((count || 0) >= 3) {
        await supabase.from('referidos').update({ activo: true }).eq('referrer_id', referrerId).eq('referido_id', ref.referido_id);
      }
    }
    const { data: refsActualizados } = await supabase.from('referidos').select('activo').eq('referrer_id', referrerId);
    const totalActivos = (refsActualizados || []).filter(r => r.activo).length;
    const mesesGanados = Math.floor(totalActivos / 3);
    if (mesesGanados >= 1) {
      const { data: referrer } = await supabase.from('usuarios').select('plan, whatsapp, premium_vence').eq('id', referrerId).single();
      if (referrer) {
        const ahora = new Date();
        let base = ahora;
        if (referrer.premium_vence && new Date(referrer.premium_vence) > ahora) {
          base = new Date(referrer.premium_vence);
        }
        const vence = new Date(base);
        vence.setMonth(base.getMonth() + mesesGanados);
        const venceStr = vence.toISOString().split('T')[0];
        const venceActual = referrer.premium_vence || '';
        if (venceStr !== venceActual) {
          await supabase.from('usuarios').update({ plan: 'premium', premium_desde: hoyPeru(), premium_vence: venceStr }).eq('id', referrerId);
          const msgMeses = mesesGanados === 1 ? '1 mes' : mesesGanados + ' meses';
          await enviarWhatsapp(referrer.whatsapp, '⭐ *¡Referidos que funcionan!*\n\n' + totalActivos + ' de tus amigos ya usan Neto activamente.\n\nTe hemos dado *' + msgMeses + ' gratis*. 🎉\n\nVence: ' + venceStr + '\n\n_Sigue invitando — cada 3 referidos activos sumas 1 mes más._');
        }
      }
    }
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message }, 'Error verificando Pro por referidos'); }
}

module.exports = { registrarReferido, verificarProReferidos };
