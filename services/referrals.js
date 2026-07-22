const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru, sumarMeses } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');

// PostgREST devuelve PGRST116 cuando .single() no encuentra fila. Ese es el caso
// legítimo "todavía no existe"; cualquier otro código es una lectura que falló y NO
// puede interpretarse como ausencia.
const SIN_FILAS = 'PGRST116';
// unique_violation. En referidos significa que el par (referrer, referido) ya estaba
// registrado: lo esperable si dos mensajes con el mismo ref: llegan casi juntos.
const YA_EXISTE = '23505';

async function registrarReferido(referrerId, referidoId) {
  try {
    const { data: existe, error: errExiste } = await supabase.from('referidos').select('id').eq('referrer_id', referrerId).eq('referido_id', referidoId).single();
    if (errExiste && errExiste.code !== SIN_FILAS) {
      log.error({ tag: 'REFERIDO', err: errExiste.message, referrerId }, 'No se pudo verificar si el referido ya existía');
      return;
    }
    if (existe) return;
    const { data: referrer, error: errRef } = await supabase.from('usuarios').select('ref_code').eq('id', referrerId).single();
    if (errRef || !referrer) {
      log.error({ tag: 'REFERIDO', err: errRef && errRef.message, referrerId }, 'No se pudo leer el ref_code del referrer');
      return;
    }
    const { error: errIns } = await supabase.from('referidos').insert({ ref_code: referrer.ref_code, referrer_id: referrerId, referido_id: referidoId });
    if (errIns && errIns.code !== YA_EXISTE) {
      log.error({ tag: 'REFERIDO', err: errIns.message, referrerId }, 'No se pudo registrar el referido');
    }
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message }, 'Error registrando referido'); }
}

async function verificarProReferidos(referrerId) {
  try {
    const { data: refs, error: errRefs } = await supabase.from('referidos').select('referido_id, activo').eq('referrer_id', referrerId);
    if (errRefs) {
      log.error({ tag: 'REFERIDO', err: errRefs.message, referrerId }, 'No se pudieron leer los referidos');
      return;
    }
    if (!refs || refs.length === 0) return;
    for (const ref of refs) {
      if (ref.activo) continue;
      const { count, error: errCount } = await supabase.from('transacciones').select('*', { count: 'exact', head: true }).eq('usuario_id', ref.referido_id);
      // Sin count no se sabe si llegó a 3 transacciones: no se activa a ciegas.
      if (errCount) {
        log.error({ tag: 'REFERIDO', err: errCount.message, referidoId: ref.referido_id }, 'No se pudo contar transacciones del referido');
        continue;
      }
      if ((count || 0) >= 3) {
        const { error: errAct } = await supabase.from('referidos').update({ activo: true }).eq('referrer_id', referrerId).eq('referido_id', ref.referido_id);
        if (errAct) log.error({ tag: 'REFERIDO', err: errAct.message, referidoId: ref.referido_id }, 'No se pudo activar el referido');
      }
    }
    const { data: refsActualizados, error: errRefs2 } = await supabase.from('referidos').select('activo').eq('referrer_id', referrerId);
    if (errRefs2) {
      log.error({ tag: 'REFERIDO', err: errRefs2.message, referrerId }, 'No se pudo releer los referidos tras activar');
      return;
    }
    const totalActivos = (refsActualizados || []).filter(r => r.activo).length;
    const mesesGanados = Math.floor(totalActivos / 3);
    if (mesesGanados < 1) return;
    const { data: referrer, error: errUsr } = await supabase.from('usuarios').select('plan, whatsapp, premium_vence, referidos_meses_otorgados').eq('id', referrerId).single();
    if (errUsr || !referrer) {
      log.error({ tag: 'REFERIDO', err: errUsr && errUsr.message, referrerId }, 'No se pudo leer el plan del referrer');
      return;
    }
    // El otorgamiento es un DELTA contra lo ya pagado, no un recálculo. Esta función se
    // invoca por cada correo bancario de un referido (gmail-scanner) y por cada mensaje
    // "hola neto ref:CODE" (webhook): sin este contador, cada invocación sumaba otro mes.
    const yaOtorgados = referrer.referidos_meses_otorgados || 0;
    const nuevos = mesesGanados - yaOtorgados;
    if (nuevos < 1) return;
    // Todo en fechas 'YYYY-MM-DD' de Lima. Antes esto mezclaba un Date local con
    // `toISOString()` (UTC): a partir de las 19:00 hora peruana el vencimiento salía un día
    // más adelante. Las cadenas ISO se comparan lexicográficamente igual que cronológicamente.
    const hoy = hoyPeru();
    const venceActual = referrer.premium_vence ? String(referrer.premium_vence).slice(0, 10) : null;
    const base = venceActual && venceActual > hoy ? venceActual : hoy;
    const venceStr = sumarMeses(base, nuevos);
    // Claim atómico sobre el contador: solo gana la primera ejecución que vea este valor.
    // Dos correos procesados a la vez (el scanner dispara con setTimeout) no pueden
    // otorgar dos veces, y el aviso de WhatsApp sale solo si la escritura aterrizó.
    const { data: aplicado, error: errUpd } = await supabase.from('usuarios')
      .update({ plan: 'premium', premium_desde: hoyPeru(), premium_vence: venceStr, referidos_meses_otorgados: mesesGanados })
      .eq('id', referrerId)
      .eq('referidos_meses_otorgados', yaOtorgados)
      .select('id');
    if (errUpd) {
      log.error({ tag: 'REFERIDO', err: errUpd.message, referrerId }, 'No se pudo otorgar Pro por referidos');
      return;
    }
    if (!aplicado || aplicado.length === 0) {
      log.warn({ tag: 'REFERIDO', referrerId }, 'Otorgamiento ya aplicado por otra ejecución');
      return;
    }
    const msgMeses = nuevos === 1 ? '1 mes' : nuevos + ' meses';
    await enviarWhatsapp(referrer.whatsapp, '⭐ *¡Referidos que funcionan!*\n\n' + totalActivos + ' de tus amigos ya usan Neto activamente.\n\nTe hemos dado *' + msgMeses + ' gratis*. 🎉\n\nVence: ' + venceStr + '\n\n_Sigue invitando — cada 3 referidos activos sumas 1 mes más._');
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message }, 'Error verificando Pro por referidos'); }
}

module.exports = { registrarReferido, verificarProReferidos };
