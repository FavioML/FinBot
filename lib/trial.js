// Trial de 14 días y el muro que viene después. Fuente única de las dos preguntas:
// "¿este usuario está en prueba?" y "¿este usuario puede LEER?".
//
// Contexto (baseline 2026-07-31, 82 usuarios): 5 de los últimos 6 pagos ocurrieron
// el mismo día del registro, con 40% de churn. La gente compraba la promesa, no el
// producto. El trial existe para que la decisión se tome con la data propia delante,
// no para forzar upgrades que hoy no existen.
//
// ── El modelo, y por qué es así ──────────────────────────────────────────────
// `plan` sigue teniendo dos valores y durante el trial vale 'premium', así que los
// ~40 sitios que chequean `plan === 'premium'` entregan Pro al usuario en prueba sin
// tocarse. Un tercer valor ('trial') habría roto todos, y un gate olvidado le daría
// Free EN SILENCIO — el peor modo de falla posible.
//
// Lo que cambió es qué significa 'free': ya no es un plan gratuito para siempre,
// es el MURO. Y el muro es de LECTURA, nunca de escritura: Neto sigue registrando
// gastos siempre, para siempre, gratis. Eso no se negocia — es la promesa del sprint
// de activación (commits 3c992bb..232e7f6) y matarla mataría al usuario que solo
// quiere WhatsApp. Lo que se cobra es ver: el desglose, el historial, el dashboard.
//
// El estado comercial vive aparte en `trial_estado` (migración 052), que es lo que
// distingue un 'premium' que paga de uno que está probando (importa para el MRR).

const { supabase } = require('./db');
const log = require('./logger');
const { hoyPeru, sumarDias } = require('./dates');
const { WEBAPP_URL } = require('./constants');
const { PRO_PRECIOS } = require('./config');
const { formatFecha } = require('./formatters');
const { nudgeActivacion, construirLinkActivacion } = require('./activacion');
const analytics = require('./analytics');

// 14 días desde el PRIMER GASTO (no desde el alta). Con el alta reordenada alguien
// puede tardar días en registrar algo, y un trial que corre sobre una cuenta vacía
// no produce un pago informado: produce un aviso de vencimiento a quien nunca vio
// nada. Ver iniciarTrialSiCorresponde.
const TRIAL_DIAS = 14;

// El primer aviso sale cuando faltan 3 días (día 11 de 14). El segundo, el día 14.
const AVISO_DIAS_ANTES = 3;

/** ¿El usuario está corriendo su prueba ahora mismo? */
function enTrial(usuario) {
  return !!usuario && usuario.trial_estado === 'activo';
}

/**
 * ¿El usuario está en el muro? Es decir: ¿puede escribir pero NO leer?
 * Es el complemento exacto del entitlement Pro, a propósito: una sola condición,
 * imposible de desincronizar con el resto del código.
 */
function estaEnMuro(usuario) {
  if (!usuario) return true;
  return usuario.plan !== 'premium';
}

/** Días que le quedan de prueba, en fecha Lima. 0 = vence hoy. null si no está en trial. */
function diasRestantesTrial(usuario, hoyStr) {
  if (!enTrial(usuario) || !usuario.trial_vence) return null;
  const hoy = hoyStr || hoyPeru();
  const vence = String(usuario.trial_vence).slice(0, 10);
  if (vence < hoy) return 0;
  const ms = new Date(vence + 'T12:00:00-05:00').getTime() - new Date(hoy + 'T12:00:00-05:00').getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

/**
 * Arranca el trial si al usuario le corresponde uno. Lo llama TODA escritura de
 * transacción (services/transactions.js para el backend; POST /internal/trial-iniciar
 * para la webapp), así que la invariante es fuerte:
 *
 *   cualquier usuario sin trial que registre una transacción arranca sus 14 días.
 *
 * O sea que nadie puede terminar en el muro sin haber tenido su prueba, y el estado
 * se auto-repara: si una fila quedó rara, el siguiente gasto la endereza.
 *
 * El UPDATE es un CAS: `WHERE trial_estado IS NULL AND plan <> 'premium'` es atómico
 * en Postgres, así que solo UNA ejecución gana la fila aunque lleguen dos gastos a la
 * vez. Las demás reciben null y no re-emiten el evento ni re-anclan el descuento.
 *
 * El `plan <> 'premium'` protege al que ya paga: a un Pro no se le pisa el plan ni se
 * le regala una prueba. Su trial_estado queda NULL y lo sella activarPro (si convierte)
 * o checkPremiumExpiry (si churnea).
 *
 * @param {string} usuarioId
 * @param {object} [opts]
 * @param {number} [opts.dias=TRIAL_DIAS]  duración (la cortesía a usuarios viejos usa 30)
 * @param {string} [opts.via='primer_gasto']  para el embudo de PostHog
 * @returns {Promise<{iniciado: boolean, trialVence: string|null}>}
 */
async function iniciarTrialSiCorresponde(usuarioId, opts = {}) {
  const vacio = { iniciado: false, trialVence: null };
  if (!usuarioId) return vacio;
  const dias = opts.dias || TRIAL_DIAS;
  const via = opts.via || 'primer_gasto';
  try {
    const trialVence = sumarDias(hoyPeru(), dias);
    const { data, error } = await supabase.from('usuarios')
      .update({
        trial_estado: 'activo',
        trial_inicio: new Date().toISOString(),
        trial_vence: trialVence,
        plan: 'premium',
      })
      .eq('id', usuarioId)
      .is('trial_estado', null)
      .neq('plan', 'premium')
      .select('id, referido_dscto_pct, referido_dscto_vence')
      .maybeSingle();

    // supabase-js NO lanza: el error viene en {error}. Sin leerlo, un fallo de red
    // sería indistinguible de "ya tenía trial" y el usuario se quedaría sin su prueba
    // sin que ningún log lo delate.
    if (error) {
      log.error({ tag: 'TRIAL', err: error.message, usuarioId }, 'No se pudo arrancar el trial');
      return vacio;
    }
    if (!data) return vacio;   // ya tenía trial, o ya es Pro pagado: nada que hacer

    // Referidos: el 50% off se ancla al FIN del trial, no al registro. Si corriera en
    // paralelo, sus 7 días se queman dentro del trial (nadie paga mientras Pro está
    // gratis) y el incentivo aterriza en cero. Anclado al final, el descuento es lo que
    // está esperando en el muro — justo donde ocurre la conversión.
    // require diferido: services/referrals arrastra lib/whatsapp, y cargarlo acá arriba
    // acopla el módulo de trial a la cadena de envío sin necesidad.
    if (data.referido_dscto_pct) {
      try {
        const { anclarDescuentoAFinDeTrial } = require('../services/referrals');
        await anclarDescuentoAFinDeTrial(usuarioId, trialVence);
      } catch (e) {
        log.warn({ tag: 'TRIAL', err: e.message, usuarioId }, 'No se pudo anclar el descuento de referido al fin del trial');
      }
    }

    // Paso 300 del MISMO embudo que el alta (100) y la activación (200), emitido desde
    // el backend sobre usuarios.id: la webapp usa posthog-js con otro distinct_id y
    // emitir desde allá partiría el embudo en dos mitades que no se pueden unir.
    analytics.capture(usuarioId, 'wa_onboarding_step_ok', { paso: 300, siguiente: 400, via, dias });
    log.info({ tag: 'TRIAL', usuarioId, trialVence, via }, 'Trial iniciado');
    return { iniciado: true, trialVence };
  } catch (e) {
    log.error({ tag: 'TRIAL', err: e.message, usuarioId }, 'Excepción arrancando el trial');
    return vacio;
  }
}

/** Suma de gastos del mes en curso (fecha Lima), en soles. Query mínima, sin joins. */
async function totalGastadoMes(usuarioId) {
  try {
    const hoy = hoyPeru();
    const desde = hoy.slice(0, 8) + '01';
    const { data, error } = await supabase.from('transacciones')
      .select('monto, monto_pen')
      .eq('usuario_id', usuarioId)
      .eq('tipo', 'gasto')
      .gte('fecha', desde)
      .lte('fecha', hoy);
    if (error || !data) return null;
    // monto_pen es NULLABLE a propósito (la rama USD fuera de rango deja null honesto),
    // así que se lee con coalesce, igual que el resto del código.
    return data.reduce((acc, t) => acc + Number(t.monto_pen != null ? t.monto_pen : t.monto || 0), 0);
  } catch (e) {
    return null;
  }
}

/**
 * Respuesta única del muro cuando alguien pide una LECTURA sin tener derecho.
 * Nombra qué pasó, confirma que su data sigue ahí, y recuerda que escribir sigue
 * siendo gratis. Sin esa última línea el mensaje se lee como "Neto dejó de funcionar",
 * que es exactamente lo que no queremos que crea.
 *
 * Dos versiones, y la distinción NO es cosmética:
 *  · Ya tuvo su prueba (`trial_estado` = vencido/convertido) → se le nombra qué terminó.
 *  · NUNCA tuvo prueba (`trial_estado` null) → decirle "tu prueba terminó" sería mentirle.
 *    Es el caso de los usuarios dormidos que existían antes del trial: su prueba arranca
 *    con su próximo gasto, así que el mensaje correcto es una invitación a anotar uno.
 *    Sale gratis y es mejor gancho de reactivación que un cobro.
 */
function mensajeMuro(usuario, conteoTx) {
  const pn = usuario && usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const cuantos = conteoTx ? '*' + conteoTx + ' gastos*' : 'tus gastos';

  if (!usuario || !usuario.trial_estado) {
    // NO se menciona la tarjeta acá. "Sin tarjeta" tranquiliza a quien YA está dentro, pero
    // en el mismo mensaje que pide registrar un gasto introduce una tarjeta que nunca
    // existió, y se puede leer como que anotar el gasto dispara un cobro. Se nombra la
    // condición real y nada más: el gasto activa la prueba.
    return '🔒 ' + (pn ? pn + ', p' : 'P') + 'ara ver tus gastos en gráficos necesitas *Neto Pro*.\n\n' +
      'Y tienes *' + TRIAL_DIAS + ' días gratis* esperándote: se activan cuando registres tu próximo gasto.\n\n' +
      '📝 Anótame uno: _"gasté 20 en taxi"_';
  }

  // Fecha legible, no ISO: "terminó el 2026-07-26" en un mensaje al usuario se lee como
  // un log, no como algo que le habla a una persona.
  const cuando = usuario.trial_vence ? formatFecha(String(usuario.trial_vence).slice(0, 10)) : null;
  return '🔒 ' + (pn ? pn + ', t' : 'T') + 'u prueba de *Neto Pro*' + (cuando ? ' terminó el ' + cuando : ' terminó') + '.\n\n' +
    'Sigo anotando todo lo que me mandes y ' + cuantos + ' siguen guardados — no se borra nada.\n\n' +
    'Para volver a verlos (gráficos, categorías, reportes e historial completo):\n' +
    '💰 *S/' + PRO_PRECIOS.mensual + '/mes* o *S/' + PRO_PRECIOS.anual + '/año*\n' +
    '👉 ' + WEBAPP_URL + '/dashboard/pro';
}

/**
 * Cola de la confirmación de un gasto para el usuario en el muro. Deja UN número —
 * el total del mes — y nada más.
 *
 * Ese número se queda a propósito: es la señal barata de que sus datos siguen
 * creciendo, y lo que genera la comezón que el desglose cobra. Quitarlo también
 * (muro duro) le saca al usuario el único motivo para seguir anotando, y sin
 * anotaciones el paywall termina vendiendo un dashboard sobre data muerta.
 *
 * @returns {Promise<string|null>} bloque a concatenar, o null si no está en el muro
 */
async function nudgeMuro(usuario) {
  if (!usuario || !estaEnMuro(usuario)) return null;
  const total = await totalGastadoMes(usuario.id);
  if (total == null) return null;
  return '\n\nVan *S/' + total.toFixed(2) + '* este mes.\n' +
    '👉 Mira en qué se te fue: ' + WEBAPP_URL + '/dashboard/pro';
}

/**
 * Lo que va al pie de CUALQUIER confirmación de gasto por WhatsApp. Reemplaza la llamada
 * directa a `nudgeActivacion` en los cuatro sitios que confirman un registro, porque las
 * tres colas posibles son mutuamente excluyentes y decidir cuál toca es una sola decisión:
 *
 *   1. Acaba de arrancar su trial  → se lo anunciamos (primer toque de comunicación del
 *      trial, y el único que ve el usuario WhatsApp-only que nunca abrirá el dashboard).
 *      Va acá y no en /activar a propósito: esa página tiene un solo trabajo — que toquen
 *      el botón — y meterle un segundo frame ("¿gratis? ¿o sea que después pago?") ante
 *      alguien que todavía no vio nada es justo lo que se le sacó cuando se rediseñó.
 *   2. Está en el muro            → el total del mes y nada más (ver nudgeMuro).
 *   3. Ninguna de las dos          → el empujón a activar la cuenta de siempre.
 *
 * @param {object} usuario   fila de usuarios (puede estar desactualizada respecto al trial)
 * @param {object|null} tx   fila devuelta por guardarTransaccion (trae `trialIniciado`)
 * @param {number} conteoTx  transacciones que lleva el usuario
 * @returns {Promise<string|null>}
 */
async function colaConfirmacionGasto(usuario, tx, conteoTx) {
  if (!usuario) return null;

  if (tx && tx.trialIniciado) {
    const base = '\n\n─────\n🎁 Acabas de estrenar *Neto Pro*: ' + TRIAL_DIAS +
      ' días con todo abierto — gráficos, categorías, reportes e historial completo.';
    const link = !usuario.supabase_auth_id ? construirLinkActivacion(usuario.id) : null;
    if (link) {
      return base + '\n\nActívalo con un toque, sin contraseñas:\n' + link;
    }
    return base + '\n\nMíralo en ' + WEBAPP_URL + '/dashboard';
  }

  const muro = await nudgeMuro(usuario);
  if (muro) return muro;

  return nudgeActivacion(usuario, conteoTx);
}

module.exports = {
  TRIAL_DIAS,
  AVISO_DIAS_ANTES,
  enTrial,
  estaEnMuro,
  diasRestantesTrial,
  iniciarTrialSiCorresponde,
  totalGastadoMes,
  mensajeMuro,
  nudgeMuro,
  colaConfirmacionGasto,
};
