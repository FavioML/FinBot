/**
 * Single source of truth for how a shared-space expense is divided.
 *
 * Both the balance engine (api/spaces/[id]/route.ts) and the "tu parte" shown in
 * the UI (dashboard/espacios/[id]) resolve splits through here. Keeping two
 * copies in sync by hand is exactly what let them drift: the client fell back to
 * the default split for a member missing from a rule while the server gave that
 * member 0, so the share a user saw never matched the balance they were charged.
 *
 * Invariant: for a non-empty member list the fractions always sum to 1. Breaking
 * it leaks phantom money into the group balance (a payer credited for an amount
 * nobody is debited for), which no settlement can reconcile.
 */

export interface SplitMember {
  user_id: string;
  split_percentage?: number | null;
}

export interface SplitRule {
  id: string;
  category: string;
  /** user_id -> weight (0-100). May still hold ids of removed members. */
  splits: Record<string, number>;
}

/** Non-finite, negative or zero weights collapse to 0 so a corrupt rule can't poison a balance. */
function weight(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Fraction (0-1) of an expense that belongs to each current member.
 * A custom rule for the expense's category drives the split when it applies;
 * otherwise each member's default split_percentage does.
 */
export function splitFractions(
  category: string | null,
  members: SplitMember[],
  splitRules: SplitRule[]
): Record<string, number> {
  const out: Record<string, number> = {};
  if (members.length === 0) return out;

  const rule = category ? splitRules.find((r) => r.category === category) : undefined;
  if (rule) {
    // Only CURRENT members count toward the denominator. Removing a member does
    // not clean their id out of split_rules, and counting that stale weight
    // would make the fractions sum to < 1 -- crediting the payer in full while
    // debiting the group for less than the expense.
    const total = members.reduce((s, m) => s + weight(rule.splits[m.user_id]), 0);
    if (total > 0) {
      for (const m of members) out[m.user_id] = weight(rule.splits[m.user_id]) / total;
      return out;
    }
    // The rule names nobody who is still in the space: fall through to the default split.
  }

  const totalPct = members.reduce((s, m) => s + weight(m.split_percentage), 0);
  for (const m of members) {
    out[m.user_id] = totalPct > 0 ? weight(m.split_percentage) / totalPct : 1 / members.length;
  }
  return out;
}

/** Fraction (0-1) of an expense that belongs to a single user. */
export function resolveSplit(
  category: string | null,
  userId: string,
  members: SplitMember[],
  splitRules: SplitRule[]
): number {
  return splitFractions(category, members, splitRules)[userId] ?? 0;
}

export interface SettlementTransfer {
  /** user_id que debe pagar */
  from: string;
  /** user_id que debe cobrar */
  to: string;
  amount: number;
}

/**
 * Turns a balance sheet into a minimal, correctly attributed list of transfers.
 *
 * Greedy: settle the largest debtor against the largest creditor, repeat. Yields
 * at most (members - 1) transfers.
 *
 * The naive alternative -- pair every debtor with the first creditor found and
 * charge them their whole balance -- happens to work for two people and silently
 * lies for three or more: it names the wrong creditor and can attribute to them
 * far more than they are actually owed.
 */
export function simplifyDebts(
  balances: Record<string, number>,
  epsilon = 0.01
): SettlementTransfer[] {
  const debtors = Object.entries(balances)
    .filter(([, v]) => v < -epsilon)
    .map(([user_id, v]) => ({ user_id, amount: -v }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = Object.entries(balances)
    .filter(([, v]) => v > epsilon)
    .map(([user_id, v]) => ({ user_id, amount: v }))
    .sort((a, b) => b.amount - a.amount);

  const transfers: SettlementTransfer[] = [];
  let i = 0;
  let j = 0;

  // Cada vuelta salda al menos a uno de los dos extremos, asi que siempre avanza.
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    if (pay > epsilon) {
      transfers.push({ from: debtors[i].user_id, to: creditors[j].user_id, amount: pay });
    }
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount <= epsilon) i++;
    if (creditors[j].amount <= epsilon) j++;
  }

  return transfers;
}

/**
 * Normalizes split rules before they are persisted: drops weights keyed to users
 * who are not members of the space and clamps each weight to a sane 0-100.
 *
 * Without this a member can persist a rule keyed to a non-member (inflating the
 * denominator so their own share drops to ~0 across every past expense, since
 * rules apply retroactively) or an Infinity/NaN weight that breaks the whole
 * group's balance computation.
 */
export function sanitizeSplitRules(rules: unknown, memberIds: Set<string>): SplitRule[] {
  if (!Array.isArray(rules)) return [];
  const clean: SplitRule[] = [];

  for (const raw of rules) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<SplitRule>;
    if (typeof r.category !== 'string' || !r.category) continue;

    const splits: Record<string, number> = {};
    for (const [userId, value] of Object.entries(r.splits ?? {})) {
      if (!memberIds.has(userId)) continue;
      const w = Math.min(100, weight(value));
      if (w > 0) splits[userId] = w;
    }

    // A rule whose weights all collapse to 0 would silently fall back to the
    // default split; drop it rather than persist a no-op that looks active.
    if (Object.keys(splits).length === 0) continue;

    clean.push({
      id: typeof r.id === 'string' && r.id ? r.id : r.category,
      category: r.category,
      splits,
    });
  }

  return clean;
}
