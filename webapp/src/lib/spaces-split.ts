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

/** What governed a division, alongside the fractions it produced. */
export interface SplitPlan {
  fractions: Record<string, number>;
  source: 'rule' | 'default';
  rule_id?: string;
}

/**
 * The single branch that decides how an expense is divided. Everything else --
 * `splitFractions`, `resolveSplit`, `buildSplitSnapshot` -- delegates here, so
 * the rule-vs-default decision cannot be stated twice and drift.
 */
export function resolveSplitPlan(
  category: string | null,
  members: SplitMember[],
  splitRules: SplitRule[]
): SplitPlan {
  const fractions: Record<string, number> = {};
  if (members.length === 0) return { fractions, source: 'default' };

  const rule = category ? splitRules.find((r) => r.category === category) : undefined;
  if (rule) {
    // Only CURRENT members count toward the denominator. Removing a member does
    // not clean their id out of split_rules, and counting that stale weight
    // would make the fractions sum to < 1 -- crediting the payer in full while
    // debiting the group for less than the expense.
    const total = members.reduce((s, m) => s + weight(rule.splits[m.user_id]), 0);
    if (total > 0) {
      for (const m of members) fractions[m.user_id] = weight(rule.splits[m.user_id]) / total;
      return { fractions, source: 'rule', rule_id: rule.id };
    }
    // The rule names nobody who is still in the space: fall through to the default split.
  }

  const totalPct = members.reduce((s, m) => s + weight(m.split_percentage), 0);
  for (const m of members) {
    fractions[m.user_id] = totalPct > 0 ? weight(m.split_percentage) / totalPct : 1 / members.length;
  }
  return { fractions, source: 'default' };
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
  return resolveSplitPlan(category, members, splitRules).fractions;
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

/* -------------------------------------------------------------------------- */
/*  Snapshot: the division an expense was registered with, frozen in cents.    */
/* -------------------------------------------------------------------------- */

export interface SplitShare {
  user_id: string;
  /** Integer cents. Money is only exact in integers. */
  cents: number;
}

export interface SplitSnapshot {
  v: 1;
  source: 'rule' | 'default';
  rule_id?: string;
  shares: SplitShare[];
}

/** Soles -> integer cents. The only place a monetary float becomes an integer. */
export function toCents(amount: number | string): number {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Splits an amount into per-user cents that add up to the total EXACTLY.
 *
 * Largest-remainder method: everyone gets the floor of their exact share, and
 * the leftover cents go one by one to the largest remainders, ties broken by
 * user_id. Deterministic, so the backend and the webapp always land on the same
 * distribution -- a plain `amount * fraction` rounded per reader does not
 * (S/100 in three ways is 33.33 x 3 = 99.99, and the missing cent shows up as
 * phantom money in the group balance).
 */
export function allocateShares(
  totalCents: number,
  fractions: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  const userIds = Object.keys(fractions).sort();
  if (userIds.length === 0) return out;

  const remainders: { user_id: string; rest: number }[] = [];
  let assigned = 0;

  for (const user_id of userIds) {
    const f = Number(fractions[user_id]);
    const exact = Number.isFinite(f) && f > 0 ? totalCents * f : 0;
    const base = Math.floor(exact);
    out[user_id] = base;
    assigned += base;
    remainders.push({ user_id, rest: exact - base });
  }

  // Clamped defensively: with fractions summing to 1 the leftover is 0..n-1,
  // but a corrupt fraction map must never mint or burn cents here.
  let leftover = Math.max(0, Math.min(userIds.length, totalCents - assigned));
  remainders.sort((a, b) => b.rest - a.rest || (a.user_id < b.user_id ? -1 : 1));
  for (let i = 0; leftover > 0; i = (i + 1) % remainders.length) {
    out[remainders[i].user_id] += 1;
    leftover -= 1;
  }

  return out;
}

/**
 * Freezes how an expense is divided at the moment it is registered.
 *
 * This is the whole point of the snapshot: split rules apply to FUTURE expenses
 * only. Editing a rule used to rewrite what everyone owed on months-old
 * expenses, which is how a rule change silently moved real money between
 * people.
 *
 * Returns null when there is nobody to charge (no members): the caller must
 * treat that as an error rather than persist an expense nobody owes.
 */
export function buildSplitSnapshot(
  amount: number | string,
  category: string | null,
  members: SplitMember[],
  splitRules: SplitRule[]
): SplitSnapshot | null {
  if (members.length === 0) return null;

  const plan = resolveSplitPlan(category, members, splitRules);
  const cents = allocateShares(toCents(amount), plan.fractions);

  const snapshot: SplitSnapshot = {
    v: 1,
    source: plan.source,
    shares: Object.keys(cents)
      .sort()
      .map((user_id) => ({ user_id, cents: cents[user_id] })),
  };
  if (plan.rule_id) snapshot.rule_id = plan.rule_id;
  return snapshot;
}

/** Cents a user owes on an expense according to its frozen snapshot. */
export function shareCents(snapshot: SplitSnapshot | null | undefined, userId: string): number {
  if (!snapshot || !Array.isArray(snapshot.shares)) return 0;
  const found = snapshot.shares.find((s) => s.user_id === userId);
  return found && Number.isFinite(found.cents) ? Math.round(found.cents) : 0;
}

export interface SnapshotExpense {
  paid_by: string;
  amount: number | string;
  split_snapshot?: SplitSnapshot | null;
}

export interface SnapshotSettlement {
  from_user: string;
  to_user: string;
  amount: number | string;
}

/**
 * Net balance per user, in soles. Positive = others owe them.
 *
 * Reads the frozen shares; it does not re-derive anything from the current
 * rules. That is what makes this identical in the webapp and in the WhatsApp
 * backend: there is no math left to disagree about, only addition.
 *
 * Balances cover the UNION of `seedUserIds` (the current members) and everyone
 * appearing in a snapshot or settlement. Scoping to current members only would
 * make a removed member's debt evaporate while the payer keeps the credit --
 * phantom money, the same failure the snapshot exists to prevent.
 */
export function computeBalancesFromSnapshots(
  expenses: SnapshotExpense[],
  settlements: SnapshotSettlement[],
  seedUserIds: string[] = []
): Record<string, number> {
  const cents: Record<string, number> = {};
  const touch = (userId: string) => {
    if (!(userId in cents)) cents[userId] = 0;
  };
  for (const userId of seedUserIds) touch(userId);

  for (const exp of expenses) {
    const total = toCents(exp.amount);
    touch(exp.paid_by);
    cents[exp.paid_by] += total;

    const shares = exp.split_snapshot?.shares;
    if (!Array.isArray(shares) || shares.length === 0) {
      // Defensive: an expense with no snapshot predates the freeze or was written
      // by a path that skipped it. Charging it entirely to the payer keeps the
      // group balance conserved (their credit and debit cancel) instead of
      // leaking the amount into everyone else's balance.
      cents[exp.paid_by] -= total;
      continue;
    }
    for (const s of shares) {
      touch(s.user_id);
      cents[s.user_id] -= Number.isFinite(s.cents) ? Math.round(s.cents) : 0;
    }
  }

  for (const s of settlements) {
    const amount = toCents(s.amount);
    touch(s.from_user);
    touch(s.to_user);
    cents[s.from_user] += amount;
    cents[s.to_user] -= amount;
  }

  const balances: Record<string, number> = {};
  for (const [userId, c] of Object.entries(cents)) balances[userId] = c / 100;
  return balances;
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
