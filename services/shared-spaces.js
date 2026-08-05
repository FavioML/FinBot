const { supabase } = require('../lib/db');
const { notificarUsuario, CANALES } = require('../lib/notify-user');
const { generarCodigoInvitacion, ALFABETO_ESPACIO } = require('../lib/codigos-seguros');
const log = require('../lib/logger');
const {
  buildSplitSnapshot,
  computeBalancesFromSnapshots,
  DEFAULT_SPLIT_WEIGHT,
  effectiveSplitPercents,
  effectiveSplitPercentsFor,
  joinSplitWeight,
  resolveSplitPlan,
  shareCents,
  simplifyDebts,
} = require('./spaces-split');

/**
 * Contexto para dividir un gasto: miembros actuales y reglas que REALMENTE
 * aplican.
 *
 * Modelo "host paga": las reglas por categoria son Pro y dependen del plan del
 * OWNER del espacio, no del que registra el gasto. Si el owner no es Pro las
 * reglas quedan stale y manda el split por defecto. Espejo de
 * `getSpaceSplitContext` en la webapp; los dos tienen que decidir igual o un
 * mismo gasto se dividiria distinto segun por donde se registro.
 */
/**
 * ¿El OWNER del espacio tiene Pro? Espejo CJS de `getSpaceOwnerIsPro`
 * (webapp/src/lib/spaces-server.ts), con su mismo criterio estricto: una lectura caída
 * LANZA en vez de degradar a `false`. Degradar le apagaría la feature al owner que sí es
 * Pro por un hipo de Supabase.
 *
 * El tier de un espacio es el de su dueño ("host paga"): es lo que hace usable la feature
 * colaborativa, porque un Pro puede invitar a gente que no paga y todos usan lo que el
 * dueño configuró. El backend no tenía este helper — solo `obtenerContextoSplit`, que es
 * privada y hace dos queries de más —, así que `checkRecordatorioEspacios` mandaba balances
 * sin mirar el tier de nadie.
 *
 * @param {string} spaceId
 * @returns {Promise<boolean>}
 */
async function ownerEsPro(spaceId) {
  const { data: space, error: eSpace } = await supabase.from('shared_spaces')
    .select('created_by').eq('id', spaceId).maybeSingle();
  if (eSpace) throw new Error('No se pudo leer el espacio: ' + eSpace.message);
  if (!space || !space.created_by) return false;
  const { data: owner, error: eOwner } = await supabase.from('usuarios')
    .select('plan').eq('id', space.created_by).maybeSingle();
  if (eOwner) throw new Error('No se pudo verificar el plan del owner: ' + eOwner.message);
  return !!owner && owner.plan === 'premium';
}

async function obtenerContextoSplit(spaceId) {
  const [{ data: space, error: eSpace }, { data: members, error: eMembers }] = await Promise.all([
    supabase.from('shared_spaces').select('created_by, split_rules').eq('id', spaceId).single(),
    supabase.from('space_members').select('user_id, split_percentage').eq('space_id', spaceId),
  ]);
  // El snapshot que sale de acá se CONGELA en el gasto y ya nadie lo recalcula. Una
  // lectura caída no puede degradar a "sin reglas": un gasto de supermercado con regla
  // 70/30 se guardaría 50/50 para siempre, y al otro se le avisa una parte que no es.
  if (eSpace) {
    log.error({ tag: 'ESPACIO_SPLIT', err: eSpace.message, spaceId }, 'No se pudo leer el espacio');
    throw new Error('No se pudo leer el espacio: ' + eSpace.message);
  }
  if (eMembers) {
    log.error({ tag: 'ESPACIO_SPLIT', err: eMembers.message, spaceId }, 'No se pudieron leer los miembros');
    throw new Error('No se pudo leer los miembros del espacio: ' + eMembers.message);
  }

  let ownerIsPro = false;
  if (space && space.created_by) {
    const { data: owner, error: eOwner } = await supabase.from('usuarios').select('plan').eq('id', space.created_by).single();
    // Sin reglas configuradas el plan del owner da igual (todo cae al split por defecto),
    // así que no vale la pena bloquear el registro del gasto. Con reglas sí: no saber si
    // aplican es exactamente la diferencia entre 70/30 y 50/50.
    if (eOwner) {
      const hayReglas = Array.isArray(space.split_rules) && space.split_rules.length > 0;
      log.error({ tag: 'ESPACIO_SPLIT', err: eOwner.message, spaceId, hayReglas }, 'No se pudo leer el plan del owner');
      if (hayReglas) throw new Error('No se pudo verificar el plan del owner: ' + eOwner.message);
    }
    ownerIsPro = !!owner && owner.plan === 'premium';
  }

  return {
    members: members || [],
    effectiveRules: ownerIsPro ? (space && space.split_rules) || [] : [],
    ownerIsPro,
  };
}

/**
 * Codigo de invitacion de 8 chars. Sale de `lib/codigos-seguros`, que documenta por que
 * NO puede venir de `Math.random()` (es la credencial que da acceso a las finanzas
 * compartidas de otro) y por que el alfabeto pasa a mayusculas.
 */
function generarCodigoEspacio() {
  return generarCodigoInvitacion(ALFABETO_ESPACIO, 8);
}

/**
 * Create a shared space + add the creator as owner.
 * @param {string} userId
 * @param {string} name
 * @param {'pareja'|'roommates'|'custom'} type
 * @returns {object} the created space
 */
async function crearEspacio(userId, name, type = 'custom') {
  const inviteCode = generarCodigoEspacio();

  const { data: space, error } = await supabase.from('shared_spaces').insert({
    name,
    type,
    invite_code: inviteCode,
    created_by: userId,
  }).select().single();
  if (error) throw error;

  // Add creator as owner
  await supabase.from('space_members').insert({
    space_id: space.id,
    user_id: userId,
    role: 'owner',
    split_percentage: DEFAULT_SPLIT_WEIGHT,
  });

  return space;
}

/**
 * Join a space via invite code.
 * @param {string} userId
 * @param {string} inviteCode
 * @returns {{ space, member }}
 */
async function unirseEspacio(userId, inviteCode) {
  const { data: space, error: eSpace } = await supabase.from('shared_spaces')
    .select('*')
    .eq('invite_code', inviteCode)
    .single();
  if (eSpace || !space) return null;

  // Check if already a member. PGRST116 = no encontró fila, que es el caso normal.
  const { data: existing, error: eExisting } = await supabase.from('space_members')
    .select('id')
    .eq('space_id', space.id)
    .eq('user_id', userId)
    .single();
  if (eExisting && eExisting.code !== 'PGRST116') {
    log.error({ tag: 'ESPACIO_JOIN', err: eExisting.message, spaceId: space.id }, 'No se pudo verificar la membresía');
    throw new Error('No se pudo verificar si ya eres miembro: ' + eExisting.message);
  }
  if (existing) return { space, member: existing, alreadyMember: true };

  const { data: previos, error: ePrevios } = await supabase.from('space_members')
    .select('user_id, split_percentage')
    .eq('space_id', space.id);
  // `|| []` acá no es un fallback inocente: joinSplitWeight([]) devuelve el peso por
  // defecto (50), así que el que entra se queda con un porcentaje inventado en vez del
  // promedio real del espacio. Entrar es reintentable; un split equivocado no se nota.
  if (ePrevios) {
    log.error({ tag: 'ESPACIO_JOIN', err: ePrevios.message, spaceId: space.id }, 'No se pudieron leer los miembros previos');
    throw new Error('No se pudo calcular tu parte al entrar: ' + ePrevios.message);
  }
  const miembrosPrevios = previos || [];

  // El que entra toma el peso promedio y NADIE MAS se toca. Antes esto reescribia
  // el split de todo el espacio a 100/n: un 70/30 acordado moria en silencio
  // porque aparecio un tercero. Como los gastos congelan su division, eso no
  // reescribia el pasado, pero si cambiaba el futuro sin que nadie lo pidiera.
  const { data: member, error: eMember } = await supabase.from('space_members').insert({
    space_id: space.id,
    user_id: userId,
    role: 'member',
    split_percentage: joinSplitWeight(miembrosPrevios),
  }).select().single();
  if (eMember) throw eMember;

  return { space, member, alreadyMember: false, miembrosPrevios };
}

/**
 * Fontaneria comun de TODO aviso de reparto: a quien se le escribe, con que
 * encabezado y con que pie.
 *
 * Lo unico que cambia entre un aviso y otro es el cuerpo. `cuerpo(actuales)`
 * devuelve un mapa user_id -> texto (o null/'' para "a este no le cambio nada,
 * no lo molestes"); todo lo demas vive aca una sola vez. Escribir esta parte de
 * nuevo por cada aviso era garantizar que un dia anunciaran cosas distintas.
 *
 * La regla que sostienen estos avisos: la plata futura de alguien no se mueve sin
 * que esa persona se entere. Por eso el permiso importa menos que el aviso.
 *
 * Best-effort a proposito: nunca lanza. Y sale por los DOS canales: fuera de la
 * ventana de 24h de Meta el mensaje libre no se entrega, asi que si el aviso viviera
 * solo en WhatsApp, la garantia se caeria justo para el miembro que no esta mirando
 * el chat — que es exactamente a quien hay que avisarle.
 */
async function avisarAMiembros({ spaceId, actorId, emoji, accion, tag, tipo, cuerpo }) {
  try {
    const [{ data: space }, { data: actuales }] = await Promise.all([
      supabase.from('shared_spaces').select('name').eq('id', spaceId).single(),
      supabase.from('space_members')
        .select('user_id, split_percentage, usuarios(nombre, whatsapp)')
        .eq('space_id', spaceId),
    ]);
    if (!space || !actuales || actuales.length < 2) return;

    const actor = actuales.find((m) => m.user_id === actorId);
    const destinatarios = actuales.filter((m) => m.user_id !== actorId);
    if (destinatarios.length === 0) return;

    const nombreActor = actor?.usuarios?.nombre?.split(' ')[0] || 'Alguien';
    const cuerpos = (await cuerpo(actuales)) || {};

    let enviados = 0;
    let enApp = 0;
    let sinCambio = 0;
    for (const m of destinatarios) {
      const texto = cuerpos[m.user_id];
      // A quien no se le movio la parte no se le escribe. Un aviso que dice
      // "paso de 50% a 50%" entrena a ignorar los avisos que si importan.
      // Este filtro se queda ANTES del envio: es el unico freno de volumen que tiene
      // este camino (no dedupea por tiempo, a proposito).
      if (!texto) { sinCambio++; continue; }

      // Aca vivia un salto por numero de WhatsApp faltante. Dejaba al miembro web-only sin
      // enterarse de que su parte se movio, que es justo la garantia que estos avisos
      // existen para sostener. Se cayo: la in-app se escribe igual, y el envio con numero
      // nulo hace no-op y queda registrado como skipped_no_whatsapp.
      // El guard tests/notificaciones-duales.test.js impide que vuelva.
      const encabezado = nombreActor + ' ' + accion + ' ' + space.name;
      const msg = emoji + ' *' + encabezado + '*\n\n' +
        texto + '\n\n' +
        '_Si prefieren otro reparto, ajústenlo acá: https://app.neto.pe/dashboard/espacios_';

      // El titulo in-app no es un parametro: sale de las MISMAS piezas que el encabezado
      // de WhatsApp. Que los dos canales puedan decir cosas distintas es exactamente lo
      // que esta funcion existe para impedir.
      const { wa, inApp } = await notificarUsuario({
        canales: CANALES.AMBOS,
        usuarioId: m.user_id,
        whatsapp: m.usuarios?.whatsapp || null,
        tipo,
        mensaje: msg,
        titulo: encabezado,
        tipoInApp: 'espacio',
        link: '/dashboard/espacios',
        datos: { space_id: spaceId },
      });
      if (wa.ok && !wa.skipped) enviados++;
      if (inApp) enApp++;
    }

    // Se loguea el exito, no solo el error: estos avisos viajan webapp -> backend
    // con ADMIN_KEY, y sin una linea por corrida no hay forma de saber desde afuera
    // si el hop se esta haciendo o si se cae en silencio por una env var faltante.
    // `enApp` es la metrica que importa: es el canal que llega a todos.
    log.info({ tag, spaceId, destinatarios: destinatarios.length, enviados, enApp, sinCambio }, 'Aviso de cambio de reparto');
  } catch (e) {
    log.warn({ tag, err: e.message }, 'No se pudo avisar del cambio de reparto');
  }
}

/**
 * Le dice a cada miembro como quedo SU parte por defecto despues de que algo la
 * movio: alguien entro al espacio, o alguien edito el reparto.
 *
 * Los dos porcentajes salen del mismo motor que cobra, no de una formula aparte:
 * lo que se anuncia es exactamente lo que va a salir en el balance.
 */
async function avisarCambioDeParte({ spaceId, actorId, miembrosAntes, emoji, accion, tag, tipo }) {
  return avisarAMiembros({
    spaceId,
    actorId,
    emoji,
    accion,
    tag,
    tipo,
    cuerpo: (actuales) => {
      const antes = effectiveSplitPercents(miembrosAntes);
      const despues = effectiveSplitPercents(actuales);
      const out = {};
      for (const m of actuales) {
        const a = antes[m.user_id];
        const d = despues[m.user_id] ?? 0;
        if (a !== undefined && a === d) continue;
        out[m.user_id] = 'Tu parte por defecto pasó de ' + (a ?? 0) + '% a ' + d + '%.';
      }
      return out;
    },
  });
}

/**
 * Avisa a los que YA estaban que entro alguien y como quedo su parte.
 *
 * El reparto cambia al entrar un miembro no porque se reescriba el peso de nadie,
 * sino porque el peso se normaliza entre mas gente. Ese era el ultimo camino por
 * el que la parte de alguien se movia sin que se enterara.
 */
async function notificarNuevoMiembro(spaceId, nuevoUserId) {
  const { data: actuales, error } = await supabase.from('space_members')
    .select('user_id, split_percentage').eq('space_id', spaceId);
  // Aviso best-effort (ver avisarAMiembros), pero si esta lectura cae nadie se entera de
  // que su parte se renormalizó, que es justo la garantía que sostienen estos avisos.
  if (error) log.error({ tag: 'ESPACIO_AVISO', err: error.message, spaceId }, 'Nuevo miembro sin aviso de reparto');
  // El "antes" de un join es el espacio sin el que acaba de entrar: nadie mas
  // cambio de peso, lo que cambia es entre cuantos se normaliza.
  const miembrosAntes = (actuales || []).filter((m) => m.user_id !== nuevoUserId);
  return avisarCambioDeParte({
    spaceId,
    actorId: nuevoUserId,
    miembrosAntes,
    emoji: '👋',
    accion: 'se unió a',
    tag: 'ESPACIO_JOIN_AVISO',
    tipo: 'espacio_nuevo_miembro',
  });
}

/**
 * Avisa que alguien edito el reparto por defecto del espacio.
 *
 * Cualquier miembro puede editarlo, y eso es a proposito: el reparto es un
 * acuerdo entre las partes, no una configuracion de administrador. En un espacio
 * de pareja, gatearlo al que creo el espacio dejaria al otro sin poder ajustar su
 * propio porcentaje. Lo que hace que eso sea seguro no es el permiso, es que el
 * cambio se ANUNCIE: owner-only no cerraria el hueco, solo elegiria quien puede
 * abrirlo en silencio.
 *
 * `miembrosAntes` lo manda quien edito (los pesos leidos justo antes de escribir),
 * y solo alimenta el texto del "de X% a Y%". La plata no depende de el.
 */
async function notificarRepartoEditado(spaceId, actorId, miembrosAntes) {
  return avisarCambioDeParte({
    spaceId,
    actorId,
    miembrosAntes: Array.isArray(miembrosAntes) ? miembrosAntes : [],
    emoji: '⚖️',
    accion: 'cambió el reparto de',
    tag: 'ESPACIO_SPLIT_AVISO',
    tipo: 'espacio_reparto',
  });
}

/** Cuantas categorias se nombran antes de resumir el resto en una linea. */
const MAX_CATEGORIAS_EN_AVISO = 5;

/**
 * Avisa que alguien edito las reglas por categoria (feature Pro) del espacio.
 *
 * Mismo hueco que el reparto por defecto y misma respuesta: cualquier miembro
 * puede editarlas y lo que hace que eso sea seguro es el aviso, no el permiso.
 * Lo que cambia es la FORMA del cambio, y por eso no reusa `avisarCambioDeParte`:
 * ahi la parte de alguien es un numero, aca es uno por categoria. Un "tu parte
 * pasó de X% a Y%" sin nombrar la categoria seria falso — su parte en todo lo
 * demas no se movio.
 *
 * `reglasAntes` lo manda quien edito (las reglas leidas justo antes de escribir);
 * el "despues" se lee de la DB, ya persistido. Los miembros se leen frescos: no
 * cambian en esta operacion, asi que sirven para los dos lados de la resta.
 */
async function notificarReglasEditadas(spaceId, actorId, reglasAntes) {
  return avisarAMiembros({
    spaceId,
    actorId,
    emoji: '⚖️',
    accion: 'cambió el reparto por categoría de',
    tag: 'ESPACIO_REGLAS_AVISO',
    tipo: 'espacio_reglas',
    cuerpo: async (actuales) => {
      const { data: space } = await supabase
        .from('shared_spaces').select('split_rules').eq('id', spaceId).single();
      const antes = Array.isArray(reglasAntes) ? reglasAntes : [];
      const despues = Array.isArray(space?.split_rules) ? space.split_rules : [];

      // Union de categorias tocadas: una regla borrada tambien mueve plata (esa
      // categoria vuelve al reparto por defecto), asi que no basta con mirar las
      // que quedaron. Orden alfabetico para que el mensaje sea estable.
      const categorias = [...new Set(
        [...antes, ...despues].map((r) => r?.category).filter((c) => typeof c === 'string' && c)
      )].sort();

      const lineas = {};
      for (const categoria of categorias) {
        const pctAntes = effectiveSplitPercentsFor(categoria, actuales, antes);
        const pctDespues = effectiveSplitPercentsFor(categoria, actuales, despues);
        // Que la categoria haya quedado sin regla se dice explicito: si no, el
        // aviso anuncia un numero que aparenta ser una regla nueva.
        const volvioAlDefault =
          resolveSplitPlan(categoria, actuales, despues).source === 'default';

        for (const m of actuales) {
          const a = pctAntes[m.user_id] ?? 0;
          const d = pctDespues[m.user_id] ?? 0;
          if (a === d) continue;
          (lineas[m.user_id] || (lineas[m.user_id] = [])).push(
            'En ' + categoria + ' tu parte pasó de ' + a + '% a ' + d + '%' +
            (volvioAlDefault ? ' (vuelve al reparto por defecto)' : '') + '.'
          );
        }
      }

      const out = {};
      for (const userId of Object.keys(lineas)) {
        const todas = lineas[userId];
        const visibles = todas.slice(0, MAX_CATEGORIAS_EN_AVISO);
        // Un espacio con muchas categorias puede mover diez de golpe; un WhatsApp
        // de diez lineas no se lee. El detalle completo esta en la webapp.
        if (todas.length > visibles.length) {
          visibles.push('Y ' + (todas.length - visibles.length) + ' categorías más.');
        }
        out[userId] = visibles.join('\n');
      }
      return out;
    },
  });
}

/**
 * Register a shared expense + notify other members.
 *
 * La division se resuelve UNA vez, aca, y se congela en `split_snapshot`. Antes
 * este camino dividia siempre en partes iguales e ignoraba por completo las
 * reglas del espacio (`split_rules` no se leia en ningun lado del backend), asi
 * que un mismo gasto valia distinto en WhatsApp que en la webapp.
 *
 * @returns {{ expense, snapshot, members }}
 */
async function registrarGastoCompartido(userId, spaceId, amount, description, category = null) {
  const { members: splitMembers, effectiveRules } = await obtenerContextoSplit(spaceId);
  const snapshot = buildSplitSnapshot(amount, category, splitMembers, effectiveRules);
  if (!snapshot) {
    throw new Error('El espacio no tiene miembros a quienes dividir el gasto');
  }

  const { data: expense, error } = await supabase.from('space_expenses').insert({
    space_id: spaceId,
    paid_by: userId,
    amount,
    description,
    category,
    split_snapshot: snapshot,
  }).select().single();
  if (error) throw error;

  // Get members for notification. El gasto YA está guardado con su snapshot, así que un
  // fallo acá no mueve plata: solo deja a los demás sin aviso. Se loguea y sigue.
  const { data: members, error: eMembers } = await supabase.from('space_members')
    .select('user_id, split_percentage, usuarios(nombre, whatsapp)')
    .eq('space_id', spaceId);
  if (eMembers) log.error({ tag: 'ESPACIO_GASTO', err: eMembers.message, spaceId }, 'Gasto guardado pero nadie fue avisado');

  // Get payer name
  const payer = members?.find(m => m.user_id === userId);
  const payerName = payer?.usuarios?.nombre?.split(' ')[0] || 'Alguien';

  // Notify other members. La parte que se avisa es la MISMA que va al balance:
  // sale del snapshot, no de una formula aparte.
  const otherMembers = (members || []).filter(m => m.user_id !== userId);
  for (const m of otherMembers) {
    // Sin filtro por whatsapp: el miembro web-only tiene que ver en su bandeja el gasto
    // que le acaban de cargar. Es plata suya.
    const share = shareCents(snapshot, m.user_id) / 100;
    const msg = '💸 *Gasto compartido*\n\n' +
      payerName + ' pagó S/ ' + amount.toFixed(2) + (description ? ' — ' + description : '') + '\n' +
      'Tu parte: S/ ' + share.toFixed(2) + '\n\n' +
      '_Escribe "ver balance espacio" para ver tu saldo._';
    await notificarUsuario({
      canales: CANALES.AMBOS,
      usuarioId: m.user_id,
      whatsapp: m.usuarios?.whatsapp || null,
      tipo: 'espacio_gasto',
      mensaje: msg,
      // El titulo lleva el numero que importa, para que se lea sin abrir la notificacion.
      titulo: 'Gasto compartido — tu parte: S/ ' + share.toFixed(2),
      tipoInApp: 'espacio',
      link: '/dashboard/espacios',
      datos: { space_id: spaceId, expense_id: expense.id },
    });
  }

  return { expense, snapshot, members: members || [] };
}

/**
 * Calculate net balance for a space: who owes whom.
 * @returns {{ balances: [{ userId, nombre, balance }], debts: [{ from, to, amount }] }}
 */
async function obtenerBalanceEspacio(spaceId) {
  // Las tres lecturas son OBLIGATORIAS: el balance es una resta entre ellas y a cada
  // una le falta el signo contrario. Con `|| []` una query caida no daba un error,
  // daba un saldo creible y falso:
  //   - sin liquidaciones -> vuelve a cobrar lo que la otra persona YA pago
  //   - sin gastos        -> la deuda se INVIERTE de dueño
  //   - sin miembros      -> "estan al dia", identico a un espacio sano en cero
  // Por eso acá se corta: el intent (handlers/intents/espacios.js:159) responde
  // "No pude obtener el balance" y nadie le cobra de más a nadie.
  const { data: expenses, error: eGastos } = await supabase.from('space_expenses')
    .select('paid_by, amount, split_snapshot')
    .eq('space_id', spaceId);
  if (eGastos) {
    log.error({ tag: 'ESPACIO_BALANCE', err: eGastos.message, spaceId }, 'No se pudieron leer los gastos');
    throw new Error('No se pudo leer los gastos del espacio: ' + eGastos.message);
  }

  const { data: settlements, error: eLiq } = await supabase.from('space_settlements')
    .select('from_user, to_user, amount')
    .eq('space_id', spaceId);
  if (eLiq) {
    log.error({ tag: 'ESPACIO_BALANCE', err: eLiq.message, spaceId }, 'No se pudieron leer las liquidaciones');
    throw new Error('No se pudo leer las liquidaciones del espacio: ' + eLiq.message);
  }

  const { data: members, error: eMiembros } = await supabase.from('space_members')
    .select('user_id, usuarios(nombre)')
    .eq('space_id', spaceId);
  if (eMiembros) {
    log.error({ tag: 'ESPACIO_BALANCE', err: eMiembros.message, spaceId }, 'No se pudieron leer los miembros');
    throw new Error('No se pudo leer los miembros del espacio: ' + eMiembros.message);
  }

  if (!members || members.length === 0) return { balances: [], debts: [] };

  // El balance sale de las partes CONGELADAS de cada gasto, no de recalcular con
  // las reglas de hoy. Es literalmente la misma funcion que corre la webapp, asi
  // que el saldo que ve el usuario por WhatsApp y el del dashboard no pueden
  // discrepar.
  const netos = computeBalancesFromSnapshots(
    expenses || [],
    settlements || [],
    members.map(m => m.user_id)
  );

  const nombres = {};
  for (const m of members) nombres[m.user_id] = m.usuarios?.nombre || 'Usuario';

  const balances = Object.keys(netos).map(userId => ({
    userId,
    nombre: nombres[userId] || 'Usuario',
    balance: netos[userId],
  }));

  const debts = simplifyDebts(netos).map(t => ({
    from: t.from,
    fromNombre: nombres[t.from] || 'Usuario',
    to: t.to,
    toNombre: nombres[t.to] || 'Usuario',
    amount: Math.round(t.amount * 100) / 100,
  }));

  return { balances, debts };
}

/**
 * Record a settlement between two users.
 */
async function liquidarCuentas(spaceId, fromUser, toUser, amount) {
  const { data, error } = await supabase.from('space_settlements').insert({
    space_id: spaceId,
    from_user: fromUser,
    to_user: toUser,
    amount,
  }).select().single();
  if (error) throw error;

  // Notify the recipient. La liquidación ya está registrada: un fallo acá solo silencia
  // el aviso, el balance de los dos ya cambió.
  const { data: fromUsuario, error: eFrom } = await supabase.from('usuarios').select('nombre').eq('id', fromUser).single();
  const { data: toUsuario, error: eTo } = await supabase.from('usuarios').select('nombre, whatsapp').eq('id', toUser).single();
  if (eFrom || eTo) log.error({ tag: 'ESPACIO_LIQUIDACION', err: (eFrom || eTo).message, spaceId }, 'Liquidación registrada pero sin aviso');
  // Ya no se condiciona el aviso a tener numero: quien recibe el pago tiene que enterarse
  // aunque nunca haya vinculado WhatsApp — y aunque la lectura de arriba se haya caido,
  // porque `toUser` es el id y viene por parametro, no de ese select.
  const fromName = fromUsuario?.nombre?.split(' ')[0] || 'Alguien';
  const montoStr = 'S/ ' + parseFloat(amount).toFixed(2);
  const msg = '✅ *Pago registrado*\n\n' + fromName + ' te pagó ' + montoStr + '.\n\n_Escribe "ver balance espacio" para ver tu saldo actualizado._';
  await notificarUsuario({
    canales: CANALES.AMBOS,
    usuarioId: toUser,
    whatsapp: toUsuario?.whatsapp || null,
    tipo: 'espacio_liquidacion',
    mensaje: msg,
    titulo: fromName + ' te pagó ' + montoStr,
    tipoInApp: 'espacio',
    link: '/dashboard/espacios',
    datos: { space_id: spaceId, settlement_id: data.id },
  });

  return data;
}

/**
 * Get all spaces a user belongs to.
 */
async function obtenerEspaciosUsuario(userId) {
  const { data: memberships, error } = await supabase.from('space_members')
    .select('space_id, role, shared_spaces(id, name, type, invite_code, created_at)')
    .eq('user_id', userId);
  // Lista vacía se traduce arriba a "No tienes espacios compartidos", que sobre una
  // lectura caída es mentira: los espacios existen y el usuario deja de verlos.
  if (error) {
    log.error({ tag: 'ESPACIO', err: error.message, userId }, 'No se pudieron leer los espacios del usuario');
    throw new Error('No se pudo leer tus espacios: ' + error.message);
  }

  if (!memberships) return [];
  return memberships.map(m => ({
    ...m.shared_spaces,
    role: m.role,
  }));
}

/**
 * Get full detail of a space (members, recent expenses, balance).
 */
async function obtenerResumenEspacio(userId, spaceId) {
  // Verify membership. null se traduce arriba a "No tienes acceso a ese espacio": eso
  // solo puede decirse cuando la lectura funcionó y de verdad no hay fila (PGRST116).
  const { data: membership, error: eMembership } = await supabase.from('space_members')
    .select('id')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .single();
  if (eMembership && eMembership.code !== 'PGRST116') {
    log.error({ tag: 'ESPACIO', err: eMembership.message, spaceId, userId }, 'No se pudo verificar la membresía');
    throw new Error('No se pudo verificar tu acceso al espacio: ' + eMembership.message);
  }
  if (!membership) return null;

  // Estos tres son de presentación (encabezado y lista de últimos gastos). El número que
  // importa lo calcula obtenerBalanceEspacio, que sí corta si alguna lectura falla.
  const { data: space, error: eSpace } = await supabase.from('shared_spaces').select('*').eq('id', spaceId).single();
  if (eSpace) log.error({ tag: 'ESPACIO', err: eSpace.message, spaceId }, 'No se pudo leer el espacio');
  const { data: members, error: eMembers } = await supabase.from('space_members')
    .select('user_id, role, split_percentage, usuarios(nombre)')
    .eq('space_id', spaceId);
  if (eMembers) log.error({ tag: 'ESPACIO', err: eMembers.message, spaceId }, 'No se pudieron leer los miembros');
  const { data: recentExpenses, error: eRecientes } = await supabase.from('space_expenses')
    .select('*, usuarios(nombre)')
    .eq('space_id', spaceId)
    .order('created_at', { ascending: false })
    .limit(10);
  if (eRecientes) log.error({ tag: 'ESPACIO', err: eRecientes.message, spaceId }, 'No se pudieron leer los gastos recientes');

  const balance = await obtenerBalanceEspacio(spaceId);

  return { space, members, recentExpenses, balance };
}

module.exports = {
  crearEspacio,
  unirseEspacio,
  notificarNuevoMiembro,
  notificarRepartoEditado,
  notificarReglasEditadas,
  registrarGastoCompartido,
  obtenerBalanceEspacio,
  liquidarCuentas,
  obtenerEspaciosUsuario,
  obtenerResumenEspacio,
  ownerEsPro,
};
