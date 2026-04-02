const { supabase } = require('../lib/db');
const { enviarWhatsapp } = require('../lib/whatsapp');
const log = require('../lib/logger');

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
 * @returns {{ expense, splits }}
 */
async function registrarGastoCompartido(userId, spaceId, amount, description, category = null, splitType = 'equal') {
  const { data: expense, error } = await supabase.from('space_expenses').insert({
    space_id: spaceId,
    paid_by: userId,
    amount,
    description,
    category,
    split_type: splitType,
  }).select().single();
  if (error) throw error;

  // Get members for notification
  const { data: members } = await supabase.from('space_members')
    .select('user_id, split_percentage, usuarios(nombre, whatsapp)')
    .eq('space_id', spaceId);

  // Get payer name
  const payer = members?.find(m => m.user_id === userId);
  const payerName = payer?.usuarios?.nombre?.split(' ')[0] || 'Alguien';

  // Notify other members
  const otherMembers = (members || []).filter(m => m.user_id !== userId);
  for (const m of otherMembers) {
    if (!m.usuarios?.whatsapp) continue;
    const share = splitType === 'equal'
      ? Math.round(amount / (members?.length || 2) * 100) / 100
      : Math.round(amount * (m.split_percentage / 100) * 100) / 100;
    const msg = '💸 *Gasto compartido*\n\n' +
      payerName + ' pagó S/ ' + amount.toFixed(2) + (description ? ' — ' + description : '') + '\n' +
      'Tu parte: S/ ' + share.toFixed(2) + '\n\n' +
      '_Escribe "ver balance espacio" para ver tu saldo._';
    try { await enviarWhatsapp(m.usuarios.whatsapp, msg); } catch (e) { /* silent */ }
  }

  return { expense, memberCount: members?.length || 1 };
}

/**
 * Calculate net balance for a space: who owes whom.
 * @returns {{ balances: [{ userId, nombre, balance }], debts: [{ from, to, amount }] }}
 */
async function obtenerBalanceEspacio(spaceId) {
  // Get all expenses
  const { data: expenses } = await supabase.from('space_expenses')
    .select('paid_by, amount, split_type')
    .eq('space_id', spaceId);

  // Get all settlements
  const { data: settlements } = await supabase.from('space_settlements')
    .select('from_user, to_user, amount')
    .eq('space_id', spaceId);

  // Get members
  const { data: members } = await supabase.from('space_members')
    .select('user_id, split_percentage, usuarios(nombre)')
    .eq('space_id', spaceId);

  if (!members || members.length === 0) return { balances: [], debts: [] };

  const memberCount = members.length;
  // Net balance per user: positive = others owe you, negative = you owe others
  const net = {};
  for (const m of members) {
    net[m.user_id] = { userId: m.user_id, nombre: m.usuarios?.nombre || 'Usuario', balance: 0 };
  }

  // Process expenses
  for (const exp of (expenses || [])) {
    const totalAmount = parseFloat(exp.amount);
    const payer = exp.paid_by;
    if (!net[payer]) continue;

    // Payer is owed by others
    net[payer].balance += totalAmount;

    // Each member owes their share
    for (const m of members) {
      const share = exp.split_type === 'equal'
        ? totalAmount / memberCount
        : totalAmount * (m.split_percentage / 100);
      net[m.user_id].balance -= share;
    }
  }

  // Process settlements
  for (const s of (settlements || [])) {
    const amount = parseFloat(s.amount);
    if (net[s.from_user]) net[s.from_user].balance += amount; // paid off debt
    if (net[s.to_user]) net[s.to_user].balance -= amount; // received payment
  }

  // Round balances
  const balances = Object.values(net).map(b => ({
    ...b,
    balance: Math.round(b.balance * 100) / 100,
  }));

  // Calculate simplified debts (who owes whom)
  const debtors = balances.filter(b => b.balance < 0).map(b => ({ ...b, balance: Math.abs(b.balance) }));
  const creditors = balances.filter(b => b.balance > 0).sort((a, b) => b.balance - a.balance);
  const debts = [];

  // Greedy algorithm for simplifying debts
  for (const debtor of debtors) {
    let remaining = debtor.balance;
    for (const creditor of creditors) {
      if (remaining <= 0.01 || creditor.balance <= 0.01) continue;
      const payment = Math.min(remaining, creditor.balance);
      debts.push({
        from: debtor.userId,
        fromNombre: debtor.nombre,
        to: creditor.userId,
        toNombre: creditor.nombre,
        amount: Math.round(payment * 100) / 100,
      });
      remaining -= payment;
      creditor.balance -= payment;
    }
  }

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
