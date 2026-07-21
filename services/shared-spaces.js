const { supabase } = require('../lib/db');
const { enviarWhatsapp } = require('../lib/whatsapp');
const log = require('../lib/logger');
const {
  buildSplitSnapshot,
  computeBalancesFromSnapshots,
  DEFAULT_SPLIT_WEIGHT,
  effectiveSplitPercents,
  joinSplitWeight,
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
async function obtenerContextoSplit(spaceId) {
  const [{ data: space }, { data: members }] = await Promise.all([
    supabase.from('shared_spaces').select('created_by, split_rules').eq('id', spaceId).single(),
    supabase.from('space_members').select('user_id, split_percentage').eq('space_id', spaceId),
  ]);

  let ownerIsPro = false;
  if (space && space.created_by) {
    const { data: owner } = await supabase.from('usuarios').select('plan').eq('id', space.created_by).single();
    ownerIsPro = owner && owner.plan === 'premium';
  }

  return {
    members: members || [],
    effectiveRules: ownerIsPro ? (space && space.split_rules) || [] : [],
    ownerIsPro,
  };
}

/**
 * Generate a random 8-char invite code (alphanumeric, no ambiguous chars).
 */
function generarCodigoInvitacion() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/**
 * Create a shared space + add the creator as owner.
 * @param {string} userId
 * @param {string} name
 * @param {'pareja'|'roommates'|'custom'} type
 * @returns {object} the created space
 */
async function crearEspacio(userId, name, type = 'custom') {
  const inviteCode = generarCodigoInvitacion();

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

  // Check if already a member
  const { data: existing } = await supabase.from('space_members')
    .select('id')
    .eq('space_id', space.id)
    .eq('user_id', userId)
    .single();
  if (existing) return { space, member: existing, alreadyMember: true };

  const { data: previos } = await supabase.from('space_members')
    .select('user_id, split_percentage')
    .eq('space_id', space.id);
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
 * Avisa a los que YA estaban que entro alguien y como quedo su parte.
 *
 * El reparto del espacio cambia al entrar un miembro (no porque se reescriba el
 * peso de nadie, sino porque el peso se normaliza entre mas gente). Ese es el
 * ultimo camino por el que la parte de alguien se movia sin que se enterara, y
 * este aviso es lo que lo cierra.
 *
 * Best-effort a proposito: nunca lanza. Fuera de la ventana de 24h de Meta el
 * mensaje libre no se entrega, asi que la garantia real es la webapp (que muestra
 * el porcentaje efectivo) y esto es el extra.
 */
async function notificarNuevoMiembro(spaceId, nuevoUserId) {
  try {
    const [{ data: space }, { data: actuales }] = await Promise.all([
      supabase.from('shared_spaces').select('name').eq('id', spaceId).single(),
      supabase.from('space_members')
        .select('user_id, split_percentage, usuarios(nombre, whatsapp)')
        .eq('space_id', spaceId),
    ]);
    if (!space || !actuales || actuales.length < 2) return;

    const nuevo = actuales.find((m) => m.user_id === nuevoUserId);
    const previos = actuales.filter((m) => m.user_id !== nuevoUserId);
    if (!nuevo || previos.length === 0) return;

    // Los dos porcentajes salen del mismo motor que cobra: el "antes" es el
    // espacio sin el que acaba de entrar, el "despues" es el espacio de ahora.
    const antes = effectiveSplitPercents(previos);
    const despues = effectiveSplitPercents(actuales);
    const nombreNuevo = nuevo.usuarios?.nombre?.split(' ')[0] || 'Alguien';

    let enviados = 0;
    for (const m of previos) {
      if (!m.usuarios?.whatsapp) continue;
      const msg = '👋 *' + nombreNuevo + ' se unió a ' + space.name + '*\n\n' +
        'Tu parte por defecto pasó de ' + (antes[m.user_id] ?? 0) + '% a ' + (despues[m.user_id] ?? 0) + '%.\n\n' +
        '_Si prefieren otro reparto, ajústenlo acá: https://app.neto.pe/dashboard/espacios_';
      try { await enviarWhatsapp(m.usuarios.whatsapp, msg); enviados++; } catch (e) { /* silent */ }
    }

    // Se loguea el exito, no solo el error: este aviso viaja webapp -> backend con
    // ADMIN_KEY, y sin una linea por corrida no hay forma de saber desde afuera si
    // el hop se esta haciendo o si se cae en silencio por una env var faltante.
    log.info({ tag: 'ESPACIO_JOIN_AVISO', spaceId, previos: previos.length, enviados }, 'Aviso de nuevo miembro');
  } catch (e) {
    log.warn({ tag: 'ESPACIO_JOIN_AVISO', err: e.message }, 'No se pudo avisar del nuevo miembro');
  }
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

  // Get members for notification
  const { data: members } = await supabase.from('space_members')
    .select('user_id, split_percentage, usuarios(nombre, whatsapp)')
    .eq('space_id', spaceId);

  // Get payer name
  const payer = members?.find(m => m.user_id === userId);
  const payerName = payer?.usuarios?.nombre?.split(' ')[0] || 'Alguien';

  // Notify other members. La parte que se avisa es la MISMA que va al balance:
  // sale del snapshot, no de una formula aparte.
  const otherMembers = (members || []).filter(m => m.user_id !== userId);
  for (const m of otherMembers) {
    if (!m.usuarios?.whatsapp) continue;
    const share = shareCents(snapshot, m.user_id) / 100;
    const msg = '💸 *Gasto compartido*\n\n' +
      payerName + ' pagó S/ ' + amount.toFixed(2) + (description ? ' — ' + description : '') + '\n' +
      'Tu parte: S/ ' + share.toFixed(2) + '\n\n' +
      '_Escribe "ver balance espacio" para ver tu saldo._';
    try { await enviarWhatsapp(m.usuarios.whatsapp, msg); } catch (e) { /* silent */ }
  }

  return { expense, snapshot, members: members || [] };
}

/**
 * Calculate net balance for a space: who owes whom.
 * @returns {{ balances: [{ userId, nombre, balance }], debts: [{ from, to, amount }] }}
 */
async function obtenerBalanceEspacio(spaceId) {
  // Get all expenses (con su division congelada)
  const { data: expenses } = await supabase.from('space_expenses')
    .select('paid_by, amount, split_snapshot')
    .eq('space_id', spaceId);

  // Get all settlements
  const { data: settlements } = await supabase.from('space_settlements')
    .select('from_user, to_user, amount')
    .eq('space_id', spaceId);

  // Get members
  const { data: members } = await supabase.from('space_members')
    .select('user_id, usuarios(nombre)')
    .eq('space_id', spaceId);

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

  // Notify the recipient
  const { data: fromUsuario } = await supabase.from('usuarios').select('nombre').eq('id', fromUser).single();
  const { data: toUsuario } = await supabase.from('usuarios').select('nombre, whatsapp').eq('id', toUser).single();
  if (toUsuario?.whatsapp) {
    const fromName = fromUsuario?.nombre?.split(' ')[0] || 'Alguien';
    const msg = '✅ *Pago registrado*\n\n' + fromName + ' te pagó S/ ' + parseFloat(amount).toFixed(2) + '.\n\n_Escribe "ver balance espacio" para ver tu saldo actualizado._';
    try { await enviarWhatsapp(toUsuario.whatsapp, msg); } catch (e) { /* silent */ }
  }

  return data;
}

/**
 * Get all spaces a user belongs to.
 */
async function obtenerEspaciosUsuario(userId) {
  const { data: memberships } = await supabase.from('space_members')
    .select('space_id, role, shared_spaces(id, name, type, invite_code, created_at)')
    .eq('user_id', userId);

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
  // Verify membership
  const { data: membership } = await supabase.from('space_members')
    .select('id')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .single();
  if (!membership) return null;

  const { data: space } = await supabase.from('shared_spaces').select('*').eq('id', spaceId).single();
  const { data: members } = await supabase.from('space_members')
    .select('user_id, role, split_percentage, usuarios(nombre)')
    .eq('space_id', spaceId);
  const { data: recentExpenses } = await supabase.from('space_expenses')
    .select('*, usuarios(nombre)')
    .eq('space_id', spaceId)
    .order('created_at', { ascending: false })
    .limit(10);

  const balance = await obtenerBalanceEspacio(spaceId);

  return { space, members, recentExpenses, balance };
}

module.exports = {
  crearEspacio,
  unirseEspacio,
  notificarNuevoMiembro,
  registrarGastoCompartido,
  obtenerBalanceEspacio,
  liquidarCuentas,
  obtenerEspaciosUsuario,
  obtenerResumenEspacio,
};
