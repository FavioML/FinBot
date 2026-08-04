const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru, sumarDias, sumarMeses } = require('../lib/dates');
const { notificarUsuario, CANALES } = require('../lib/notify-user');
const { enTrial } = require('../lib/trial');

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
    // require diferido: lib/trial arrastra la cadena de envío (activacion → whatsapp) y
    // cargarlo arriba acopla referrals a algo que no necesita para esto.
    const { esProPagado } = require('../lib/trial');
    if (esProPagado(u)) return;
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
 * ── Qué pasa cuando algo falla DESPUÉS del claim ────────────────────────────────
 * Son dos escrituras en dos tablas y no hay transacción entre ellas, así que existe
 * una ventana donde el claim está puesto y el mes no. Antes esa ventana perdía el
 * premio para siempre y en silencio (el aviso también sale después del grant). Ahora
 * se trata según lo que se sepa, que es lo único honesto:
 *
 * | Falla                    | ¿Se escribió en usuarios? | Qué hacemos |
 * |--------------------------|---------------------------|-------------|
 * | lectura del referrer     | NO, seguro                | revertir el claim → el próximo intento reintenta limpio |
 * | UPDATE del referrer      | NO SE SABE                | NO revertir (revertir arriesga pagar 2 meses) + avisar |
 * | CAS agotado (6 vueltas)  | NO                        | avisar; la fila queda pendiente y visible |
 *
 * `premio_otorgado_at` (migración 062) es lo que hace visible el estado intermedio:
 * `convertido_pro AND premio_otorgado_at IS NULL` = mes debido y no pagado. El aviso
 * al admin va sin cooldown a propósito: es plata, y es raro.
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
    // Desde acá el claim está consumido: todo camino de salida sin premio tiene que
    // devolverlo (si es seguro) o gritar. Ver la tabla del docstring.

    // Otorga 1 mes al referrer con CAS sobre referidos_meses_otorgados. Si el CAS pierde
    // (otra conversión del mismo referrer escribió primero), re-lee el vence fresco y
    // reintenta: un premio ya reclamado (convertido_pro=true) NO puede perderse.
    for (let intento = 0; intento < 6; intento++) {
      const { data: referrer, error: errUsr } = await supabase.from('usuarios')
        .select('whatsapp, nombre, plan, trial_estado, trial_vence, premium_desde, premium_vence, referidos_meses_otorgados')
        .eq('id', referrerId).single();
      if (errUsr || !referrer) {
        // Todavía NO se tocó `usuarios`: devolver el claim es seguro y deja el
        // reintento abierto (la aprobación se puede volver a disparar).
        log.error({ tag: 'REFERIDO', err: errUsr && errUsr.message, referrerId }, 'No se pudo leer al referrer para premiarlo');
        await devolverClaim(referidoId, referrerId,
          'no se pudo leer al referrer (' + ((errUsr && errUsr.message) || 'fila ausente') + ').');
        return;
      }
      const ya = referrer.referidos_meses_otorgados || 0;
      const hoy = hoyPeru();
      // Todo en fechas 'YYYY-MM-DD' de Lima; se comparan lexicográfica = cronológicamente.
      const venceActual = referrer.premium_vence ? String(referrer.premium_vence).slice(0, 10) : null;
      // Un referrer EN TRIAL tiene premium_vence NULL y su Pro vigente vive en trial_vence:
      // el mes se apila sobre lo que le queda de prueba (como hace activarPro) y el grant lo
      // sella 'convertido'. Sin el sello, checkTrialExpiry —que no mira premium_vence— lo
      // bajaba al muro el día 15 y el mes ya anunciado por WhatsApp se evaporaba.
      const referrerEnTrial = enTrial(referrer);
      const trialVence = referrerEnTrial && referrer.trial_vence ? String(referrer.trial_vence).slice(0, 10) : null;
      let base = venceActual && venceActual > hoy ? venceActual : hoy;
      if (trialVence && trialVence > base) base = trialVence;
      const venceStr = sumarMeses(base, 1);
      const cambios = { plan: 'premium', premium_desde: referrer.premium_desde || hoy, premium_vence: venceStr, referidos_meses_otorgados: ya + 1 };
      if (referrerEnTrial) cambios.trial_estado = 'convertido';
      const { data: aplicado, error: errUpd } = await supabase.from('usuarios')
        .update(cambios)
        .eq('id', referrerId).eq('referidos_meses_otorgados', ya)
        .select('id');
      if (errUpd) {
        // Acá NO se sabe si el UPDATE entró (puede haber fallado la respuesta y no
        // la escritura). Devolver el claim arriesga otorgar DOS meses por un solo
        // referido, así que se deja pendiente y visible, y se avisa en el acto.
        log.error({ tag: 'REFERIDO', err: errUpd.message, referrerId }, 'No se pudo otorgar el mes al referrer');
        await avisarPremioPendiente(referidoId, referrerId, 'falló el UPDATE del referrer: ' + errUpd.message);
        return;
      }
      if (aplicado && aplicado.length) {
        // El mes ya está acreditado. Sellar el premio cierra la ventana: a partir de
        // acá la fila deja de figurar como "debido y no pagado".
        const { error: errSello } = await supabase.from('referidos')
          .update({ premio_otorgado_at: new Date().toISOString() })
          .eq('referido_id', referidoId);
        if (errSello) {
          // El referrer YA tiene su mes; lo único roto es el sello. No se reintenta
          // el grant por eso (sería el doble pago), pero sí se avisa: si no, la
          // consulta de premios pendientes lo muestra para siempre como pendiente.
          log.error({ tag: 'REFERIDO', err: errSello.message, referidoId }, 'Mes otorgado pero no se pudo sellar premio_otorgado_at');
          await avisarPremioPendiente(referidoId, referrerId,
            'el mes SÍ se acreditó (vence ' + venceStr + ') pero no se pudo sellar premio_otorgado_at: ' + errSello.message);
        }
        await avisarReferrerPremio(referrer, venceStr, referrerId);
        return;
      }
      // CAS perdió: otra conversión del mismo referrer ganó. Reintentar con vence fresco.
    }
    log.warn({ tag: 'REFERIDO', referrerId }, 'No se pudo otorgar el mes tras varios reintentos de CAS');
    await avisarPremioPendiente(referidoId, referrerId, 'el CAS sobre referidos_meses_otorgados se agotó tras 6 intentos');
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message, referidoId }, 'Error procesando conversión Pro del referido'); }
}

/**
 * Devuelve el claim, y avisa pase lo que pase.
 *
 * SOLO se llama desde la rama donde se sabe que `usuarios` no se tocó.
 *
 * Devolver el claim NO recupera el premio por sí solo, y conviene no engañarse
 * con eso: `procesarConversionProReferido` la dispara `activarPro`, o sea la
 * aprobación de un pago, y volver a apretar "aprobar" **no vuelve a entrar acá**
 * — `reclamarPagoPendiente` exige `pagos.estado='pendiente'` y después de la
 * primera aprobación la fila ya está en `'aprobado'`, así que el panel responde
 * `already:true` y ni llega a `activarPro`. El rollback sirve para que el estado
 * no quede mintiendo (`convertido_pro` sin premio) y para que un reintento
 * deliberado sea posible; quien de verdad recupera la plata es el aviso.
 *
 * El UPDATE lleva `.select()`: sin él, supabase-js devuelve `{data:null,
 * error:null}` tanto si tocó una fila como si no tocó ninguna, y el aviso al
 * admin afirmaría "el claim se devolvió" sin haberlo devuelto.
 */
async function devolverClaim(referidoId, referrerId, causa) {
  const { data, error } = await supabase.from('referidos')
    .update({ convertido_pro: false, convertido_pro_at: null })
    .eq('referido_id', referidoId).eq('convertido_pro', true)
    .is('premio_otorgado_at', null)   // jamás desarmar un claim ya premiado
    .select('referido_id');
  const devuelto = !error && Array.isArray(data) && data.length > 0;
  if (error) log.error({ tag: 'REFERIDO', err: error.message, referidoId }, 'No se pudo devolver el claim del referido');
  await avisarPremioPendiente(referidoId, referrerId, causa, devuelto);
}

/**
 * Grita cuando un premio quedó debido y no pagado.
 *
 * Va por `notificarAdmin` y no por `notificarErrorAdmin` a propósito: el segundo
 * tiene un cooldown de 5 minutos compartido con TODOS los errores del backend, o
 * sea que un pico de errores no relacionados se comería justo este aviso. Esto es
 * plata de un usuario y pasa como mucho un puñado de veces al año.
 *
 * El mensaje trae el SQL exacto porque las dos alternativas mienten: re-aprobar
 * el pago no vuelve a entrar al premio (ver `devolverClaim`), y el botón de
 * "activar Pro" del panel escribe `estado_pago='pagado'` — marcaría como pagador
 * al referrer, que no pagó nada, y encima dejaría la fila igual de pendiente.
 *
 * Nunca lanza: el estado ya quedó consistente y visible en la DB; el aviso es lo
 * que acelera el arreglo, no lo que lo garantiza. Ojo que `notificarAdmin` no
 * informa si entregó (intenta Telegram, cae a WhatsApp y traga su excepción), así
 * que este aviso NO es el detector: es el atajo. El detector que no se puede
 * perder corre todos los días — `qa-e2e/qa-referidos-pendientes.mjs`, enganchado
 * al canary en `webapp/.claude/deploy-config.json`.
 */
async function avisarPremioPendiente(referidoId, referrerId, motivo, claimDevuelto) {
  log.error({ tag: 'REFERIDO_PENDIENTE', referidoId, referrerId, motivo, claimDevuelto },
    'Premio de referido DEBIDO y no otorgado');
  try {
    const { notificarAdmin } = require('../lib/admin-notify');
    await notificarAdmin(
      '⚠️ *Premio de referido pendiente*\n\n'
      + 'Un referido pagó Pro y el mes gratis del referrer NO se pudo otorgar.\n\n'
      + '👤 referrer: `' + referrerId + '`\n'
      + '👤 referido: `' + referidoId + '`\n'
      + '📋 ' + motivo + '\n'
      + (claimDevuelto === undefined ? ''
        : claimDevuelto
          ? '↩️ El claim se devolvió (la fila quedó sin marcar como convertida).\n'
          : '⛔ NO se pudo devolver el claim: la fila sigue marcada como convertida.\n')
      + '\n*Otorgar a mano* (el botón de activar Pro NO sirve acá: marca al referrer como pagador):\n'
      + '```\n'
      + "update usuarios set plan='premium',\n"
      + "  premium_vence = (greatest(coalesce(premium_vence, current_date), current_date) + interval '1 month')::date,\n"
      + '  referidos_meses_otorgados = coalesce(referidos_meses_otorgados,0)+1\n'
      + " where id = '" + referrerId + "';\n"
      + "update referidos set convertido_pro=true, premio_otorgado_at=now()\n"
      + " where referido_id = '" + referidoId + "';\n"
      + '```\n'
      + '_Si el referrer está EN TRIAL, la base es `trial_vence` y hay que sellar `trial_estado=\'convertido\'` (ver lib/trial.js)._\n\n'
      + '_Todos los pendientes:_ `select * from referidos where convertido_pro and premio_otorgado_at is null;`'
    );
  } catch (e) {
    log.error({ tag: 'REFERIDO', err: e.message }, 'No se pudo avisar del premio pendiente');
  }
}

/**
 * Aviso al referrer cuando gana un mes. Best-effort; el mes ya está otorgado.
 *
 * Sale por los dos canales. Es el aviso de un beneficio económico ya otorgado e
 * irreversible (no hay clawback), o sea el peor candidato posible para depender de la
 * ventana de 24h de Meta: quien invitó a un amigo hace semanas probablemente no escribió
 * hoy. Antes, el referrer web-only "vería el mes reflejado en la webapp" — pero eso era
 * un `premium_vence` que cambiaba solo, sin una línea que dijera por qué.
 */
async function avisarReferrerPremio(referrer, venceStr, referrerId) {
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
  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: referrerId,
    whatsapp: referrer.whatsapp || null,
    tipo: 'referido_premio',
    mensaje,
    titulo: 'Ganaste 1 mes de Neto Pro gratis',
    cuerpo: 'Un referido tuyo se hizo Pro. Tu Pro ahora vence: ' + venceStr + '.',
    link: '/dashboard/pro',
  });
}

/**
 * Estadísticas de referidos de un usuario para mostrar (WhatsApp y webapp comparten la forma).
 *   invitados     = entraron con el link pero aún NO se hicieron Pro.
 *   referidosPro  = convirtieron a Pro pagado.
 *   meses         = meses REALMENTE acreditados.
 *
 * `meses` sale de `premio_otorgado_at` y no de `convertido_pro`: desde la migración
 * 062 son dos hechos distintos, y en el hueco entre los dos (premio debido y no
 * otorgado) contar conversiones le mostraría al usuario un mes que no tiene. Es
 * mejor que el contador vaya un paso atrás de la realidad y no un paso adelante.
 */
async function obtenerEstadisticasReferidos(referrerId) {
  const vacio = { invitados: 0, referidosPro: 0, meses: 0 };
  try {
    const { data, error } = await supabase.from('referidos').select('convertido_pro, premio_otorgado_at').eq('referrer_id', referrerId);
    if (error) { log.error({ tag: 'REFERIDO', err: error.message, referrerId }, 'No se pudieron leer las estadísticas de referidos'); return vacio; }
    const total = (data || []).length;
    const pro = (data || []).filter(r => r.convertido_pro).length;
    const meses = (data || []).filter(r => r.premio_otorgado_at).length;
    return { invitados: total - pro, referidosPro: pro, meses };
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
    const { data: ref } = await supabase.from('referidos').select('referrer_id, convertido_pro, premio_otorgado_at').eq('referido_id', referidoId).maybeSingle();
    if (ref && ref.referrer_id) {
      out.referrerId = ref.referrer_id;
      // `convertido_pro` significa "el referido pagó", NO "al referrer se le pagó
      // el mes" — desde la migración 062 son dos hechos distintos y pueden diferir
      // (premio debido y no otorgado). Mirar solo el primero le decía al admin "ya
      // premiado" justo en el único caso donde el mes NO se acreditó.
      out.yaPremiado = !!ref.premio_otorgado_at;
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
