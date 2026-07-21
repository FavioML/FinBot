const { supabase } = require('../lib/db');
const { enviarWhatsapp } = require('../lib/whatsapp');
const log = require('../lib/logger');
const {
  buildSplitSnapshot,
  computeBalancesFromSnapshots,
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
    split_percentage: 50,
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

  // Count current members
  const { data: members } = await supabase.from('space_members')
    .select('id')
    .eq('space_id', space.id);
  const memberCount = members ? members.length : 0;

  // Add member with equal split (recalculated)
  const newPct = Math.round(100 / (memberCount + 1) * 100) / 100;
  const { data: member, error: eMember } = await supabase.from('space_members').insert({
    space_id: space.id,
    user_id: userId,
    role: 'member',
    split_percentage: newPct,
  }).select().single();
  if (eMember) throw eMember;

  // Update all members to equal split
  if (memberCount > 0) {
    await supabase.from('space_members')
      .update({ split_percentage: newPct })
      .eq('space_id', space.id);
  }

  return { space, member, alreadyMember: false };
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
  registrarGastoCompartido,
  obtenerBalanceEspacio,
  liquidarCuentas,
  obtenerEspaciosUsuario,
  obtenerResumenEspacio,
};
