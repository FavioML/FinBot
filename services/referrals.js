const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru, sumarDias, sumarMeses } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');

// PostgREST devuelve PGRST116 cuando .single() no encuentra fila. Ese es el caso
// legítimo "todavía no existe"; cualquier otro código es una lectura que falló y NO
// puede interpretarse como ausencia.
const SIN_FILAS = 'PGRST116';
// unique_violation. En referidos significa que el par (referrer, referido) ya estaba
// registrado: lo esperable si dos mensajes con el mismo ref: llegan casi juntos.
const YA_EXISTE = '23505';

// Descuento del lado del referido: 50% off su primer mes de Pro, válido 7 días desde
// que se registra con el link. Vencido = precio normal (no rompe la invariante "conversión
// pagada dispara el premio": sigue siendo un pago real, solo que a tarifa completa).
const DSCTO_REFERIDO_PCT = 50;
const DSCTO_REFERIDO_DIAS = 7;

/**
 * Vincula un referido a su referrer (idempotente) y le siembra el 50% off de su primer mes.
 * Lo llama el webhook cuando llega "hola neto ref:CODE". NO premia a nadie: el premio al
 * referrer se dispara recién cuando el referido PAGA Pro (ver procesarConversionProReferido).
 */
async function registrarReferido(referrerId, referidoId) {
  try {
    const { data: existe, error: errExiste } = await supabase.from('referidos').select('id').eq('referrer_id', referrerId).eq('referido_id', referidoId).single();
    if (errExiste && errExiste.code !== SIN_FILAS) {
      log.error({ tag: 'REFERIDO', err: errExiste.message, referrerId }, 'No se pudo verificar si el referido ya existía');
      return;
    }
    if (existe) { await sembrarDescuentoReferido(referidoId); return; }
    const { data: referrer, error: errRef } = await supabase.from('usuarios').select('ref_code').eq('id', referrerId).single();
    if (errRef || !referrer) {
      log.error({ tag: 'REFERIDO', err: errRef && errRef.message, referrerId }, 'No se pudo leer el ref_code del referrer');
      return;
    }
    const { error: errIns } = await supabase.from('referidos').insert({ ref_code: referrer.ref_code, referrer_id: referrerId, referido_id: referidoId });
    if (errIns && errIns.code !== YA_EXISTE) {
      log.error({ tag: 'REFERIDO', err: errIns.message, referrerId }, 'No se pudo registrar el referido');
      return;
    }
    // El vínculo ya quedó; el descuento es un incentivo best-effort encima de él.
    await sembrarDescuentoReferido(referidoId);
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message }, 'Error registrando referido'); }
}

/**
 * Siembra (o refresca) el 50% off del primer mes Pro del referido, con ventana de 7 días.
 * No pisa un descuento aún vigente ni se lo da a quien ya es Pro PAGADO (no tiene
 * "primer mes").
 *
 * La ventana se ancla al FIN DEL TRIAL cuando el referido está probando. Anclarla a hoy
 * la haría vencer DENTRO del trial: nadie paga mientras Pro está gratis, así que los 7
 * días se quemarían sin que el descuento llegue a existir para el usuario. Anclado al
 * final, el 50% deja de ser un endulzante de registro y pasa a ser lo que está esperando
 * en el muro — justo donde ocurre la conversión.
 */
async function sembrarDescuentoReferido(referidoId) {
  try {
    const { data: u, error } = await supabase.from('usuarios')
      .select('plan, trial_estado, trial_vence, referido_dscto_vence').eq('id', referidoId).single();
    if (error || !u) return;
    // OJO: durante el trial `plan` vale 'premium' (así el trial entrega Pro sin tocar los
    // ~40 gates que miran esa columna). Cortar por plan a secas dejaría a TODO referido
    // nuevo sin descuento, en silencio. Lo que descalifica es ser Pro PAGADO.
    const esProPagado = u.plan === 'premium' && u.trial_estado !== 'activo';
    if (esProPagado) return;
    const hoy = hoyPeru();
    // Si ya tiene un descuento vigente, no reiniciar la ventana (evita farmear el link).
    if (u.referido_dscto_vence && String(u.referido_dscto_vence).slice(0, 10) >= hoy) return;
    const base = (u.trial_estado === 'activo' && u.trial_vence)
      ? String(u.trial_vence).slice(0, 10)
      : hoy;
    const vence = sumarDias(base, DSCTO_REFERIDO_DIAS);
    const { error: errUpd } = await supabase.from('usuarios')
      .update({ referido_dscto_pct: DSCTO_REFERIDO_PCT, referido_dscto_vence: vence })
      .eq('id', referidoId);
    if (errUpd) log.error({ tag: 'REFERIDO', err: errUpd.message, referidoId }, 'No se pudo sembrar el descuento de referido');
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message, referidoId }, 'Error sembrando descuento de referido'); }
}

/**
 * Re-ancla la ventana del descuento al fin del trial. La llama lib/trial.js cuando arranca
 * el trial de alguien que YA venía con descuento sembrado (entró por el link de referido y
 * recién después registró su primer gasto). Sin esto, ese usuario — el camino más común
 * del programa de referidos — tendría el descuento vencido antes de llegar al muro.
 *
 * @param {string} usuarioId
 * @param {string} trialVence  'YYYY-MM-DD'
 */
async function anclarDescuentoAFinDeTrial(usuarioId, trialVence) {
  if (!usuarioId || !trialVence) return;
  const vence = sumarDias(String(trialVence).slice(0, 10), DSCTO_REFERIDO_DIAS);
  const { error } = await supabase.from('usuarios')
    .update({ referido_dscto_vence: vence })
    .eq('id', usuarioId)
    .not('referido_dscto_pct', 'is', null);
  if (error) log.error({ tag: 'REFERIDO', err: error.message, usuarioId }, 'No se pudo anclar el descuento al fin del trial');
}

/**
 * Procesa la conversión a Pro PAGADO de un usuario que fue REFERIDO: premia a su referrer
 * con 1 mes de Pro. La llama activarPro (fuente única) SOLO en aprobaciones de pago real
 * (nunca comp/comodín): que "el referido paga" sea la única vía de premio corta el
 * encadenamiento — A refiere a B; que B se haga Pro por referir a C no puede re-premiar a A,
 * porque el grant del referrer se escribe aquí directo (plan:'premium') SIN pasar por activarPro.
 *
 * Idempotente por-referido: el claim atómico convertido_pro false->true garantiza 1 solo
 * premio por referido aunque la aprobación se dispare dos veces (doble-tap Telegram, reintento).
 * El otorgamiento del mes al referrer usa un CAS sobre usuarios.referidos_meses_otorgados para
 * serializar conversiones concurrentes de varios referidos del mismo referrer (sin él, dos
 * conversiones leerían el mismo premium_vence y el last-write-wins daría 1 mes en vez de 2).
 *
 * Sin clawback: si el referido cancela luego, el mes ya otorgado no se revierte.
 *
 * @param {string} referidoId  id del usuario que acaba de pagar Pro.
 */
async function procesarConversionProReferido(referidoId) {
  try {
    if (!referidoId) return;
    const { data: refRow, error: errRow } = await supabase.from('referidos')
      .select('referrer_id, convertido_pro').eq('referido_id', referidoId).maybeSingle();
    if (errRow) { log.error({ tag: 'REFERIDO', err: errRow.message, referidoId }, 'No se pudo leer la fila del referido'); return; }
    if (!refRow || !refRow.referrer_id) return;   // no fue referido: nada que premiar
    if (refRow.convertido_pro) return;             // ya premiado (fast path, evita el UPDATE)

    // Claim atómico por-referido: solo la primera ejecución que vea false->true gana la fila.
    const { data: claimed, error: errClaim } = await supabase.from('referidos')
      .update({ convertido_pro: true, convertido_pro_at: new Date().toISOString() })
      .eq('referido_id', referidoId).eq('convertido_pro', false)
      .select('referrer_id').maybeSingle();
    if (errClaim) { log.error({ tag: 'REFERIDO', err: errClaim.message, referidoId }, 'Falló el claim de conversión del referido'); return; }
    if (!claimed) return;   // otra ejecución concurrente ya lo tomó
    const referrerId = claimed.referrer_id;

    // Otorga 1 mes al referrer con CAS sobre referidos_meses_otorgados. Si el CAS pierde
    // (otra conversión del mismo referrer escribió primero), re-lee el vence fresco y
    // reintenta: un premio ya reclamado (convertido_pro=true) NO puede perderse.
    for (let intento = 0; intento < 6; intento++) {
      const { data: referrer, error: errUsr } = await supabase.from('usuarios')
        .select('whatsapp, nombre, premium_desde, premium_vence, referidos_meses_otorgados')
        .eq('id', referrerId).single();
      if (errUsr || !referrer) { log.error({ tag: 'REFERIDO', err: errUsr && errUsr.message, referrerId }, 'No se pudo leer al referrer para premiarlo'); return; }
      const ya = referrer.referidos_meses_otorgados || 0;
      const hoy = hoyPeru();
      // Todo en fechas 'YYYY-MM-DD' de Lima; se comparan lexicográfica = cronológicamente.
      const venceActual = referrer.premium_vence ? String(referrer.premium_vence).slice(0, 10) : null;
      const base = venceActual && venceActual > hoy ? venceActual : hoy;
      const venceStr = sumarMeses(base, 1);
      const { data: aplicado, error: errUpd } = await supabase.from('usuarios')
        .update({ plan: 'premium', premium_desde: referrer.premium_desde || hoy, premium_vence: venceStr, referidos_meses_otorgados: ya + 1 })
        .eq('id', referrerId).eq('referidos_meses_otorgados', ya)
        .select('id');
      if (errUpd) { log.error({ tag: 'REFERIDO', err: errUpd.message, referrerId }, 'No se pudo otorgar el mes al referrer'); return; }
      if (aplicado && aplicado.length) {
        await avisarReferrerPremio(referrer, venceStr, referrerId);
        return;
      }
      // CAS perdió: otra conversión del mismo referrer ganó. Reintentar con vence fresco.
    }
    log.warn({ tag: 'REFERIDO', referrerId }, 'No se pudo otorgar el mes tras varios reintentos de CAS');
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message, referidoId }, 'Error procesando conversión Pro del referido'); }
}

/** Aviso de WhatsApp al referrer cuando gana un mes. Best-effort; el mes ya está otorgado. */
async function avisarReferrerPremio(referrer, venceStr, referrerId) {
  // Referrer web-only (sin whatsapp): no hay canal de chat; verá el mes reflejado en la webapp.
  if (!referrer.whatsapp) return;
  let totalPro = null;
  try {
    const { count } = await supabase.from('referidos').select('*', { count: 'exact', head: true }).eq('referrer_id', referrerId).eq('convertido_pro', true);
    totalPro = count;
  } catch(e) { /* el conteo es solo para el copy */ }
  const pn = referrer.nombre ? referrer.nombre.split(' ')[0] : null;
  const linea = (totalPro && totalPro > 0)
    ? 'Ya llevas *' + totalPro + '* ' + (totalPro === 1 ? 'amigo' : 'amigos') + ' que se hicieron Pro por tu recomendación.\n\n'
    : '';
  const mensaje = '⭐ *' + (pn ? '¡' + pn + ', un' : '¡Un') + ' referido tuyo se hizo Pro!*\n\n' +
    'Te regalamos *1 mes de Neto Pro gratis*. 🎉\n\n' +
    linea +
    'Tu Pro ahora vence: ' + venceStr + '\n\n' +
    '_Cada amigo que invites y se haga Pro suma 1 mes más para ti._';
  try { await enviarWhatsapp(referrer.whatsapp, mensaje); } catch(e) { log.warn({ tag: 'REFERIDO', err: e.message }, 'No se pudo avisar el premio al referrer'); }
}

/**
 * Estadísticas de referidos de un usuario para mostrar (WhatsApp y webapp comparten la forma).
 *   invitados     = entraron con el link pero aún NO se hicieron Pro.
 *   referidosPro  = convirtieron a Pro pagado.
 *   meses         = meses ganados (1 conversión = 1 mes).
 */
async function obtenerEstadisticasReferidos(referrerId) {
  const vacio = { invitados: 0, referidosPro: 0, meses: 0 };
  try {
    const { data, error } = await supabase.from('referidos').select('convertido_pro').eq('referrer_id', referrerId);
    if (error) { log.error({ tag: 'REFERIDO', err: error.message, referrerId }, 'No se pudieron leer las estadísticas de referidos'); return vacio; }
    const total = (data || []).length;
    const pro = (data || []).filter(r => r.convertido_pro).length;
    return { invitados: total - pro, referidosPro: pro, meses: pro };
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message, referrerId }, 'Error leyendo estadísticas de referidos'); return vacio; }
}

// El link de referido apunta a la mini-landing de bienvenida (neto.pe/r/CODE), que muestra
// quién invita + la oferta y de ahí deep-linkea a WhatsApp. Antes iba directo a api.neto.pe/r.
const LANDING_URL = process.env.LANDING_URL || 'https://neto.pe';

/**
 * Mensaje único de "mis referidos" (WhatsApp): link + oferta dos-lados + progreso.
 * Compartido por el comando /referir (webhook) y el intent ver_referidos (premium.js) para
 * que el copy no derive entre ambos.
 */
function mensajeMisReferidos(refCode, stats) {
  const s = stats || { invitados: 0, referidosPro: 0, meses: 0 };
  const progreso = '_Invitados: ' + s.invitados + ' (aún no Pro) · Referidos Pro: ' + s.referidosPro + ' · Meses ganados: ' + s.meses + '_';
  return '🎁 *Tu link de referido:*\n\n' + LANDING_URL + '/r/' + refCode + '\n\n' +
    'Cuando un amigo se hace Pro con tu link, ganas *1 mes gratis* — y él estrena Pro a *mitad de precio* (S/5 su primer mes). 🎉\n\n' +
    progreso;
}

/**
 * Contexto de referido de un usuario para el aviso al admin (Telegram + panel): su descuento
 * vigente y quién lo refirió. Lo usa el aviso de comprobante para que el admin sepa, ANTES de
 * aprobar, que se espera S/5 (no S/10) y quién ganará el mes gratis.
 * @returns {Promise<{descuentoPct:number, referrerId:string|null, referrerNombre:string|null, yaPremiado:boolean}>}
 */
async function resumenReferidoParaAdmin(referidoId) {
  const out = { descuentoPct: 0, referrerId: null, referrerNombre: null, yaPremiado: false };
  try {
    const { data: u } = await supabase.from('usuarios').select('referido_dscto_pct, referido_dscto_vence').eq('id', referidoId).single();
    if (u && u.referido_dscto_pct) {
      const hoy = hoyPeru();
      const vence = u.referido_dscto_vence ? String(u.referido_dscto_vence).slice(0, 10) : null;
      if (vence && vence >= hoy) out.descuentoPct = u.referido_dscto_pct;
    }
    const { data: ref } = await supabase.from('referidos').select('referrer_id, convertido_pro').eq('referido_id', referidoId).maybeSingle();
    if (ref && ref.referrer_id) {
      out.referrerId = ref.referrer_id;
      out.yaPremiado = !!ref.convertido_pro;
      const { data: r } = await supabase.from('usuarios').select('nombre').eq('id', ref.referrer_id).single();
      out.referrerNombre = (r && r.nombre) || null;
    }
  } catch(e) { log.warn({ tag: 'REFERIDO', err: e.message, referidoId }, 'No se pudo armar el resumen de referido para el admin'); }
  return out;
}

module.exports = {
  registrarReferido,
  sembrarDescuentoReferido,
  anclarDescuentoAFinDeTrial,
  procesarConversionProReferido,
  obtenerEstadisticasReferidos,
  mensajeMisReferidos,
  resumenReferidoParaAdmin,
  DSCTO_REFERIDO_PCT,
  DSCTO_REFERIDO_DIAS,
};
