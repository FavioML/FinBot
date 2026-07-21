/**
 * ESPEJO CommonJS de `webapp/src/lib/spaces-split.ts`.
 *
 * La fuente de verdad es el modulo TS. Este archivo existe porque el backend es
 * CommonJS y la webapp TS/ESM: no pueden importar el mismo modulo (mismo caso que
 * `services/import-parser.js` <-> `webapp/src/lib/import-parser.ts`).
 *
 * Lo que evita que los dos se separen NO es la disciplina: es
 * `tests/services/spaces-split-parity.test.js`, que importa las DOS
 * implementaciones y afirma salida identica sobre una matriz de casos mas cientos
 * de casos aleatorios con semilla fija. Si tocas una, toca la otra o el CI se pone
 * rojo. No relajes ese test para que pase.
 *
 * Invariante que protege este modulo: para cualquier lista de miembros no vacia
 * las fracciones suman 1, y la suma de las partes en centavos da el total exacto.
 * Romperlo genera dinero fantasma que ningun settlement reconcilia.
 */

/** Pesos no finitos, negativos o cero colapsan a 0 para que una regla corrupta no envenene un balance. */
function weight(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * La unica rama que decide como se divide un gasto. Todo lo demas delega aca,
 * asi la decision regla-vs-default no queda escrita dos veces.
 */
function resolveSplitPlan(category, members, splitRules) {
  const fractions = {};
  if (members.length === 0) return { fractions, source: 'default' };

  const rule = category ? (splitRules || []).find((r) => r.category === category) : undefined;
  if (rule) {
    // Solo cuentan los miembros ACTUALES en el denominador: remover a alguien no
    // limpia su id de split_rules, y contar ese peso rancio haria que las
    // fracciones sumen < 1 (el pagador acreditado por plata que nadie debe).
    const total = members.reduce((s, m) => s + weight(rule.splits[m.user_id]), 0);
    if (total > 0) {
      for (const m of members) fractions[m.user_id] = weight(rule.splits[m.user_id]) / total;
      return { fractions, source: 'rule', rule_id: rule.id };
    }
    // La regla no nombra a ningun miembro vigente: cae al split por defecto.
  }

  const totalPct = members.reduce((s, m) => s + weight(m.split_percentage), 0);
  for (const m of members) {
    fractions[m.user_id] = totalPct > 0 ? weight(m.split_percentage) / totalPct : 1 / members.length;
  }
  return { fractions, source: 'default' };
}

/** Fraccion (0-1) del gasto que le corresponde a cada miembro actual. */
function splitFractions(category, members, splitRules) {
  return resolveSplitPlan(category, members, splitRules).fractions;
}

/** Fraccion (0-1) del gasto que le corresponde a un usuario. */
function resolveSplit(category, userId, members, splitRules) {
  const f = splitFractions(category, members, splitRules)[userId];
  return f === undefined ? 0 : f;
}

/**
 * Porcentaje efectivo (0-100) que paga cada miembro con el split por defecto.
 *
 * `split_percentage` es un PESO, no un porcentaje: se normaliza dividiendo entre
 * la suma. Mostrar la columna cruda con un "%" pegado es mentira apenas los pesos
 * dejan de sumar 100 (pesos 70/30/50 son en realidad 46.7/20/33.3). La UI y el
 * aviso de nuevo miembro leen de aca, asi el numero que se muestra es el que se
 * cobra.
 */
function effectiveSplitPercents(members) {
  const fractions = splitFractions(null, members, []);
  const out = {};
  for (const userId of Object.keys(fractions)) out[userId] = Math.round(fractions[userId] * 1000) / 10;
  return out;
}

/**
 * Peso con el que se crea un espacio, y con el que entra alguien a uno vacio. El
 * valor exacto da igual (los pesos se normalizan); lo que importa es que los dos
 * caminos de alta usen el mismo.
 */
const DEFAULT_SPLIT_WEIGHT = 50;

/**
 * Peso con el que entra un miembro nuevo: el promedio de los pesos vigentes.
 *
 * Una sola regla cubre los dos comportamientos que la gente espera, justamente
 * porque el peso se normaliza al dividir:
 *  - Espacio que nadie personalizo (todos en 50): el nuevo entra en 50 y el
 *    espacio queda en partes iguales. Equitativo sin haberle reescrito el peso a
 *    nadie.
 *  - Espacio con un 70/30 acordado: el nuevo entra en 50 y queda 46.7/20/33.3.
 *    Asume un tercio y los dos originales conservan la proporcion que pactaron.
 *
 * Lo que NO hace es tocar a los que ya estaban. Reescribir a todos a 100/n (lo
 * que hacia este backend) mataba un reparto acordado porque aparecio un tercero,
 * y entrar con un 50 fijo sin mirar al resto (lo que hacia la webapp) desordenaba
 * el acuerdo de OTRA forma, asi que el mismo espacio dividia distinto segun por
 * que puerta se hubiera entrado.
 *
 * Los pesos en 0 no promedian: son miembros excluidos del reparto a proposito, y
 * arrastrarlos bajaria la parte del que entra por gente que no paga.
 */
function joinSplitWeight(members) {
  if (members.length === 0) return DEFAULT_SPLIT_WEIGHT;

  const pesos = members.map((m) => weight(m.split_percentage)).filter((w) => w > 0);
  // Nadie con peso util: el espacio ya cae a partes iguales solo (`resolveSplitPlan`
  // con totalPct 0). Entrar con peso lo romperia y dejaria al recien llegado
  // pagandolo todo.
  if (pesos.length === 0) return 0;

  const promedio = pesos.reduce((s, w) => s + w, 0) / pesos.length;
  // 2 decimales: lo que aguanta la columna NUMERIC(5,2), y redondear igual en los
  // dos runtimes es lo que evita que el mismo join guarde numeros distintos.
  return Math.min(100, Math.round(promedio * 100) / 100);
}

/** Soles -> centavos enteros. Unico punto donde un float de dinero se vuelve entero. */
function toCents(amount) {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Reparte un monto en centavos por usuario que suman el total EXACTO.
 *
 * Metodo del resto mayor: cada uno recibe el piso de su parte exacta y los
 * centavos sobrantes van de a uno a los restos mas grandes, desempatando por
 * user_id. Determinista, asi backend y webapp caen siempre en el mismo reparto
 * (un `monto * fraccion` redondeado por cada lector no lo es: S/100 en tres
 * partes da 33.33 x 3 = 99.99 y el centavo perdido reaparece como fantasma).
 */
function allocateShares(totalCents, fractions) {
  const out = {};
  const userIds = Object.keys(fractions).sort();
  if (userIds.length === 0) return out;

  const remainders = [];
  let assigned = 0;

  for (const user_id of userIds) {
    const f = Number(fractions[user_id]);
    const exact = Number.isFinite(f) && f > 0 ? totalCents * f : 0;
    const base = Math.floor(exact);
    out[user_id] = base;
    assigned += base;
    remainders.push({ user_id, rest: exact - base });
  }

  // Acotado a proposito: con fracciones que suman 1 el sobrante es 0..n-1, pero
  // un mapa de fracciones corrupto no debe poder crear ni quemar centavos aca.
  let leftover = Math.max(0, Math.min(userIds.length, totalCents - assigned));
  remainders.sort((a, b) => b.rest - a.rest || (a.user_id < b.user_id ? -1 : 1));
  for (let i = 0; leftover > 0; i = (i + 1) % remainders.length) {
    out[remainders[i].user_id] += 1;
    leftover -= 1;
  }

  return out;
}

/**
 * Congela como se divide un gasto en el momento en que se registra.
 *
 * Ese es el punto entero del snapshot: las reglas aplican SOLO a gastos futuros.
 * Antes, editar una regla reescribia lo que cada quien debia en gastos de hace
 * meses, o sea que un cambio de regla movia plata real entre personas en silencio.
 *
 * Devuelve null si no hay a quien cobrarle (sin miembros): el llamador debe
 * tratarlo como error, no persistir un gasto que nadie debe.
 */
function buildSplitSnapshot(amount, category, members, splitRules) {
  if (members.length === 0) return null;

  const plan = resolveSplitPlan(category, members, splitRules);
  const cents = allocateShares(toCents(amount), plan.fractions);

  const snapshot = {
    v: 1,
    source: plan.source,
    shares: Object.keys(cents)
      .sort()
      .map((user_id) => ({ user_id, cents: cents[user_id] })),
  };
  if (plan.rule_id) snapshot.rule_id = plan.rule_id;
  return snapshot;
}

/** Centavos que le tocan a un usuario en un gasto segun su snapshot congelado. */
function shareCents(snapshot, userId) {
  if (!snapshot || !Array.isArray(snapshot.shares)) return 0;
  const found = snapshot.shares.find((s) => s.user_id === userId);
  return found && Number.isFinite(found.cents) ? Math.round(found.cents) : 0;
}

/**
 * Balance neto por usuario, en soles. Positivo = le deben.
 *
 * Lee las partes congeladas; no re-deriva nada de las reglas actuales. Eso es lo
 * que lo hace identico en la webapp y en el backend de WhatsApp: no queda
 * matematica sobre la cual discrepar, solo sumas.
 *
 * Cubre la UNION de `seedUserIds` (los miembros actuales) y todo el que aparezca
 * en un snapshot o una liquidacion. Limitarlo a los miembros actuales haria que
 * la deuda de un miembro removido se evapore mientras el pagador conserva el
 * credito: dinero fantasma, la misma falla que el snapshot existe para evitar.
 */
function computeBalancesFromSnapshots(expenses, settlements, seedUserIds = []) {
  const cents = {};
  const touch = (userId) => {
    if (!(userId in cents)) cents[userId] = 0;
  };
  for (const userId of seedUserIds) touch(userId);

  for (const exp of expenses || []) {
    const total = toCents(exp.amount);
    touch(exp.paid_by);
    cents[exp.paid_by] += total;

    const shares = exp.split_snapshot && exp.split_snapshot.shares;
    if (!Array.isArray(shares) || shares.length === 0) {
      // Defensivo: un gasto sin snapshot es anterior al congelamiento o lo escribio
      // un camino que se lo salto. Cobrarselo entero al pagador mantiene el balance
      // del grupo conservado (credito y debito se cancelan) en vez de filtrar el
      // monto al balance de los demas.
      cents[exp.paid_by] -= total;
      continue;
    }
    for (const s of shares) {
      touch(s.user_id);
      cents[s.user_id] -= Number.isFinite(s.cents) ? Math.round(s.cents) : 0;
    }
  }

  for (const s of settlements || []) {
    const amount = toCents(s.amount);
    touch(s.from_user);
    touch(s.to_user);
    cents[s.from_user] += amount;
    cents[s.to_user] -= amount;
  }

  const balances = {};
  for (const userId of Object.keys(cents)) balances[userId] = cents[userId] / 100;
  return balances;
}

/**
 * Convierte una hoja de balances en una lista minima y bien atribuida de
 * transferencias. Greedy: salda al mayor deudor contra el mayor acreedor y
 * repite. Como maximo (miembros - 1) transferencias.
 *
 * La alternativa ingenua -- emparejar a cada deudor con el PRIMER acreedor y
 * cobrarle su saldo entero -- funciona de casualidad para dos personas y miente
 * en silencio con tres o mas: nombra al acreedor equivocado y puede imputarle
 * mucho mas de lo que realmente se le debe.
 */
function simplifyDebts(balances, epsilon = 0.01) {
  const debtors = Object.entries(balances)
    .filter(([, v]) => v < -epsilon)
    .map(([user_id, v]) => ({ user_id, amount: -v }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = Object.entries(balances)
    .filter(([, v]) => v > epsilon)
    .map(([user_id, v]) => ({ user_id, amount: v }))
    .sort((a, b) => b.amount - a.amount);

  const transfers = [];
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
 * Normaliza las reglas antes de persistirlas: descarta pesos de usuarios que no
 * son miembros y acota cada peso a 0-100.
 */
function sanitizeSplitRules(rules, memberIds) {
  if (!Array.isArray(rules)) return [];
  const clean = [];

  for (const raw of rules) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.category !== 'string' || !raw.category) continue;

    const splits = {};
    for (const [userId, value] of Object.entries(raw.splits || {})) {
      if (!memberIds.has(userId)) continue;
      const w = Math.min(100, weight(value));
      if (w > 0) splits[userId] = w;
    }

    // Una regla cuyos pesos colapsan todos a 0 caeria en silencio al split por
    // defecto; se descarta en vez de persistir un no-op que parece activo.
    if (Object.keys(splits).length === 0) continue;

    clean.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : raw.category,
      category: raw.category,
      splits,
    });
  }

  return clean;
}

module.exports = {
  resolveSplitPlan,
  splitFractions,
  resolveSplit,
  effectiveSplitPercents,
  DEFAULT_SPLIT_WEIGHT,
  joinSplitWeight,
  toCents,
  allocateShares,
  buildSplitSnapshot,
  shareCents,
  computeBalancesFromSnapshots,
  simplifyDebts,
  sanitizeSplitRules,
};
