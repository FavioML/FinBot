const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { construirDatosUsuario } = require('./recommendations');
const { obtenerMetas, calcularRitmoAhorro } = require('./metas');
const { indexarGmail } = require('../lib/gmail-conectado');

// ═══════════════════════════════════════════════════════════════
// FACTOR WEIGHTS
// ═══════════════════════════════════════════════════════════════
const WEIGHTS = {
  consistency: 0.20,
  budget: 0.25,
  savings: 0.20,
  goals: 0.15,
  debts: 0.10,
  visibility: 0.10,
};

// ═══════════════════════════════════════════════════════════════
// FACTOR CALCULATORS (each returns 0-100)
// ═══════════════════════════════════════════════════════════════

/**
 * Consistency: How regularly does the user track expenses?
 * 5+ distinct days/week in last 30 days = 100
 */
async function calcFactorConsistency(usuarioId) {
  const hace30 = new Date();
  hace30.setDate(hace30.getDate() - 30);
  const desde = hace30.toISOString().split('T')[0];

  // Cota superior = hoy (Lima). Consistency mide días ÚNICOS con registro en los
  // últimos 30 días; una tx con fecha futura (un prepago legítimo registrado para el
  // mes que cubre) no es "haber registrado ese día futuro", así que no debe contar como
  // día activo. El webapp (api/score/route.ts) aplica el mismo `.lte(hoy)` para no
  // divergir. Espejo del criterio de la cota de mes en construirDatosUsuario.
  const { data, error } = await supabase
    .from('transacciones')
    .select('fecha')
    .eq('usuario_id', usuarioId)
    .gte('fecha', desde)
    .lte('fecha', hoyPeru());

  // Un factor es un sumando de una media ponderada: si la lectura cae y devolvemos el
  // default, el score no falla, se MUEVE. Acá el default es 0 con peso 0.20, o sea -20
  // puntos y un "tu punto más débil: Consistencia de registro" sobre alguien que registra
  // todos los días. Se corta y no se persiste nada (upsertScore devuelve null y el usuario
  // sigue viendo el score de ayer, que es verdad).
  if (error) {
    log.error({ tag: 'SCORE', err: error.message, usuarioId }, 'No se pudieron leer las transacciones');
    throw new Error('No se pudo leer las transacciones: ' + error.message);
  }
  if (!data || data.length === 0) return 0;

  const diasUnicos = new Set(data.map(t => t.fecha)).size;
  const diasPorSemana = diasUnicos / 4.3; // ~4.3 weeks in 30 days

  if (diasPorSemana >= 5) return 100;
  if (diasPorSemana >= 4) return 85;
  if (diasPorSemana >= 3) return 70;
  if (diasPorSemana >= 2) return 50;
  if (diasPorSemana >= 1) return 30;
  return 10;
}

/**
 * Budget Control: Are they within budgets?
 * <=100% = 100, 101-120% = linear 80->40, >120% = linear 40->0
 */
function calcFactorBudget(datosUsuario) {
  const presupuestos = datosUsuario.presupuestos || [];
  if (presupuestos.length === 0) return 50; // Neutral — no budgets set

  let totalScore = 0;
  for (const p of presupuestos) {
    const pct = p.porcentaje_usado;
    if (pct <= 100) {
      totalScore += 100;
    } else if (pct <= 120) {
      // Linear: 100->120 maps to 80->40
      totalScore += 80 - ((pct - 100) / 20) * 40;
    } else {
      // >120%: linear 40->0 (capped at 200%)
      const excess = Math.min(pct - 120, 80);
      totalScore += Math.max(0, 40 - (excess / 80) * 40);
    }
  }

  return Math.round(totalScore / presupuestos.length);
}

/**
 * Savings Capacity: (ingresos - gastos) / ingresos
 * >20% = 100, linear down to 0%
 */
function calcFactorSavings(datosUsuario) {
  const ingresos = datosUsuario.mes_actual.ingresos;
  const gastos = datosUsuario.mes_actual.gastos;

  if (ingresos <= 0) return 50; // Neutral — no income data

  const ratio = (ingresos - gastos) / ingresos;
  if (ratio >= 0.20) return 100;
  if (ratio >= 0.10) return 75;
  if (ratio >= 0.05) return 55;
  if (ratio >= 0) return 35;
  // Negative savings (spending more than earning)
  return Math.max(0, 20 + ratio * 100);
}

/**
 * Goal Progress: Are active savings plans on track?
 */
async function calcFactorGoals(usuarioId) {
  const metas = await obtenerMetas(usuarioId, true);
  if (metas.length === 0) return 50; // Neutral

  let totalScore = 0;
  let counted = 0;

  for (const meta of metas) {
    const ritmo = calcularRitmoAhorro(meta);
    if (ritmo.enRitmo === null) {
      // No deadline — just check if any progress
      totalScore += ritmo.pctProgreso > 0 ? 70 : 40;
    } else if (ritmo.enRitmo) {
      totalScore += 100;
    } else {
      // Behind schedule — score based on how far behind
      const behindRatio = ritmo.pctProgreso / Math.max(1, ritmo.pctProgreso + 20);
      totalScore += Math.max(20, Math.round(behindRatio * 80));
    }
    counted++;
  }

  return Math.round(totalScore / counted);
}

/**
 * Debt Management: Are debts decreasing? Payments on time?
 */
async function calcFactorDebts(usuarioId) {
  const { data: debts, error } = await supabase
    .from('deudas')
    .select('id, tipo, monto_original, monto_pendiente, estado, fecha_vencimiento')
    .eq('usuario_id', usuarioId)
    .eq('tipo', 'debo');

  // Este es el único factor que falla HACIA ARRIBA: sin datos el default es 80 ("no
  // tiene deudas = bien"), así que una lectura caída le sube el score a alguien con una
  // deuda vencida sin pagar, que es justo a quien el factor debería castigar.
  if (error) {
    log.error({ tag: 'SCORE', err: error.message, usuarioId }, 'No se pudieron leer las deudas');
    throw new Error('No se pudo leer las deudas: ' + error.message);
  }
  if (!debts || debts.length === 0) return 80; // No debts = good

  const activas = debts.filter(d => d.estado === 'activa');
  const pagadas = debts.filter(d => d.estado === 'pagada');

  if (activas.length === 0) return 100; // All paid

  // Check payment progress
  let progressScore = 0;
  let overdueCount = 0;
  // `fecha_vencimiento` es DATE (sin hora): la comparacion va a granularidad de
  // dia con strings ISO, igual que el espejo del webapp (lib/score-factors.ts).
  // Comparar Dates metia la hora en el medio y hacia que una deuda que vence HOY
  // contara como vencida en un lado y no en el otro.
  const hoy = hoyPeru();

  for (const d of activas) {
    const pendiente = parseFloat(d.monto_pendiente);
    const original = parseFloat(d.monto_original);
    const paidRatio = 1 - (pendiente / original);
    progressScore += paidRatio * 100;

    if (d.fecha_vencimiento && String(d.fecha_vencimiento).slice(0, 10) < hoy) {
      overdueCount++;
    }
  }

  const avgProgress = progressScore / activas.length;
  const overduePenalty = overdueCount * 15;
  const paidBonus = pagadas.length > 0 ? 10 : 0;

  return Math.max(0, Math.min(100, Math.round(avgProgress + paidBonus - overduePenalty)));
}

/**
 * Financial Visibility: How many tools is the user actively using?
 */
async function calcFactorVisibility(usuarioId) {
  const [
    { count: presCount, error: ePres },
    { count: metasCount, error: eMetas },
    { data: usuario, error: eUsuario },
    { data: cuentasGmail, error: eGmail },
  ] = await Promise.all([
    supabase.from('presupuestos').select('*', { count: 'exact', head: true }).eq('usuario_id', usuarioId),
    supabase.from('metas_ahorro').select('*', { count: 'exact', head: true }).eq('usuario_id', usuarioId).eq('completada', false),
    supabase.from('usuarios').select('gmail_access_token, recordatorios_activos').eq('id', usuarioId).single(),
    // La OTRA fuente de "tiene Gmail". `usuarios.gmail_access_token` es el almacen legacy y
    // hoy casi nadie lo tiene: las conexiones vivas viven en `gmail_cuentas`. Con solo la
    // columna, este factor le negaba sus 25 puntos a quien SI tiene Gmail conectado, y el
    // efecto es un score mas bajo del que corresponde. Ver `lib/gmail-conectado.js`.
    supabase.from('gmail_cuentas').select('usuario_id, activa, auth_error_at').eq('usuario_id', usuarioId),
  ]);

  // Las tres suman puntos por separado, así que una caída no anula el factor: lo deja a
  // medias. Y la de `usuarios` además engaña al alza: con `usuario` en null,
  // `usuario?.recordatorios_activos !== false` es true y regala los 20 puntos de
  // recordatorios activos sin haber podido comprobar que lo estén.
  const error = ePres || eMetas || eUsuario || eGmail;
  if (error) {
    log.error({ tag: 'SCORE', err: error.message, usuarioId }, 'No se pudo leer la visibilidad financiera');
    throw new Error('No se pudo leer la visibilidad financiera: ' + error.message);
  }

  let score = 0;
  if (presCount > 0) score += 30;        // Has budgets
  if (metasCount > 0) score += 25;       // Has active goals
  // Union de las dos fuentes. `usuario` puede ser null si la lectura fallo, pero eso ya
  // aborto arriba; el `|| []` cubre la fila sin cuentas.
  const gmail = indexarGmail(usuario ? [{ ...usuario, id: usuarioId }] : [], cuentasGmail || []);
  if (gmail.conectados.has(usuarioId)) score += 25; // Gmail connected
  if (usuario?.recordatorios_activos !== false) score += 20; // Reminders active

  return score;
}

// ═══════════════════════════════════════════════════════════════
// MAIN CALCULATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate the full Neto Score for a user.
 * @param {string} usuarioId
 * @returns {{ score, factors: { consistency, budget, savings, goals, debts, visibility } }}
 */
async function calcularNetoScore(usuarioId) {
  // Reuse construirDatosUsuario for budget/savings data (avoids duplicate queries)
  const datosUsuario = await construirDatosUsuario(usuarioId);

  // Calculate all factors in parallel where possible
  const [consistency, goals, debts, visibility] = await Promise.all([
    calcFactorConsistency(usuarioId),
    calcFactorGoals(usuarioId),
    calcFactorDebts(usuarioId),
    calcFactorVisibility(usuarioId),
  ]);

  const budget = calcFactorBudget(datosUsuario);
  const savings = calcFactorSavings(datosUsuario);

  const factors = { consistency, budget, savings, goals, debts, visibility };

  const score = Math.round(
    factors.consistency * WEIGHTS.consistency +
    factors.budget * WEIGHTS.budget +
    factors.savings * WEIGHTS.savings +
    factors.goals * WEIGHTS.goals +
    factors.debts * WEIGHTS.debts +
    factors.visibility * WEIGHTS.visibility
  );

  return { score: Math.max(0, Math.min(100, score)), factors };
}

/**
 * Calculate and persist score for a user.
 */
async function upsertScore(usuarioId) {
  try {
    const { score, factors } = await calcularNetoScore(usuarioId);
    const period = hoyPeru();

    const { data, error } = await supabase.from('neto_scores').upsert({
      user_id: usuarioId,
      score,
      factor_consistency: factors.consistency,
      factor_budget: factors.budget,
      factor_savings: factors.savings,
      factor_goals: factors.goals,
      factor_debts: factors.debts,
      factor_visibility: factors.visibility,
      period,
    }, { onConflict: 'user_id,period' }).select().single();

    if (error) {
      log.error({ tag: 'SCORE', err: error.message }, 'Error upserting score');
      return null;
    }
    return data;
  } catch (e) {
    log.error({ tag: 'SCORE', err: e.message }, 'Error calculating score');
    return null;
  }
}

/**
 * Get the user's most recent score.
 */
async function obtenerScoreActual(usuarioId) {
  const { data, error } = await supabase
    .from('neto_scores')
    .select('*')
    .eq('user_id', usuarioId)
    .order('period', { ascending: false })
    .limit(1)
    .single();
  // PGRST116 = todavía no tiene ningún score, que es normal en un usuario nuevo.
  if (error && error.code !== 'PGRST116') {
    log.error({ tag: 'SCORE', err: error.message, usuarioId }, 'No se pudo leer el score actual');
    throw new Error('No se pudo leer tu score: ' + error.message);
  }
  return data;
}

/**
 * Get score history for the last N months.
 */
async function obtenerHistorialScore(usuarioId, months = 6) {
  const desde = new Date();
  desde.setMonth(desde.getMonth() - months);
  const desdeStr = desde.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('neto_scores')
    .select('score, period, factor_consistency, factor_budget, factor_savings, factor_goals, factor_debts, factor_visibility')
    .eq('user_id', usuarioId)
    .gte('period', desdeStr)
    .order('period', { ascending: true });

  // Lista vacía se presenta como "todavía no tienes historial". Sobre una lectura caída
  // eso es falso: el historial existe y el usuario lo da por perdido.
  if (error) {
    log.error({ tag: 'SCORE', err: error.message, usuarioId }, 'No se pudo leer el historial de score');
    throw new Error('No se pudo leer tu historial: ' + error.message);
  }

  return data || [];
}

/**
 * Get score trend: current vs 7 days ago.
 * @returns {{ current, previous, diff, trend: 'up'|'down'|'stable' }}
 */
async function obtenerTendenciaScore(usuarioId) {
  const { data, error } = await supabase
    .from('neto_scores')
    .select('score, period')
    .eq('user_id', usuarioId)
    .order('period', { ascending: false })
    .limit(8);

  // null es una respuesta legítima (aún no hay con qué comparar) y los dos callers la
  // manejan omitiendo la tendencia, así que acá no se corta: no se muestra ningún número
  // falso. Pero se loguea, porque si no el aviso semanal deja de salir sin dejar rastro.
  if (error) {
    log.error({ tag: 'SCORE', err: error.message, usuarioId }, 'No se pudo leer la tendencia del score');
    return null;
  }
  if (!data || data.length === 0) return null;

  const current = data[0].score;
  // Find score from ~7 days ago
  const previous = data.length >= 7 ? data[6].score : data[data.length - 1].score;
  const diff = current - previous;
  const trend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'stable';

  return { current, previous, diff, trend };
}

/**
 * Get the label for a score range.
 */
function scoreLabel(score) {
  if (score >= 80) return 'Excelente';
  if (score >= 60) return 'En camino';
  if (score >= 40) return 'Puede mejorar';
  return 'Atención';
}

/**
 * Get the weakest factor name (in Spanish).
 */
function factorMasDebil(factors) {
  const labels = {
    consistency: 'Consistencia de registro',
    budget: 'Control de presupuesto',
    savings: 'Capacidad de ahorro',
    goals: 'Progreso en planes de ahorro',
    debts: 'Gestión de deudas',
    visibility: 'Visibilidad financiera',
  };

  let min = Infinity;
  let weakest = 'consistency';
  for (const [key, val] of Object.entries(factors)) {
    if (val < min) { min = val; weakest = key; }
  }
  return { key: weakest, label: labels[weakest], score: min };
}

module.exports = {
  calcularNetoScore,
  upsertScore,
  obtenerScoreActual,
  obtenerHistorialScore,
  obtenerTendenciaScore,
  scoreLabel,
  factorMasDebil,
  WEIGHTS,
  // Exposed for testing
  calcFactorBudget,
  calcFactorSavings,
};
