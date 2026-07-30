const { sumarMeses } = require('./dates');

/**
 * Lógica pura de recordatorios de costos operativos (admin). Sin I/O: recibe las filas de
 * admin_costs y el día Lima de hoy, devuelve qué notificar y qué auto-procesar. El cron
 * (cron/checks.js) aplica los efectos (Telegram + updates en DB). Se aísla acá para poder
 * testearlo con vitest, igual que money.js / budget-status.
 *
 * Dos buckets, según el flag auto_debit:
 *
 *  - MANUAL (auto_debit=false): Favio lo paga. Se le recuerda por Telegram el día del
 *    vencimiento y cada día que siga atrasado (nag diario), con dedup por-día vía
 *    last_reminder_sent_at para no repetir dentro del mismo día (el cron corre varias veces
 *    entre 9:00 y 9:14). NO avanza next_due_date: eso lo hace el admin al marcar pagado.
 *
 *  - AUTO (auto_debit=true): se cobra solo (ej. Railway con tarjeta). No se molesta con
 *    "págalo"; el día del cobro se manda una línea informativa, se registra el pago en
 *    paid_history (para que el P&L lo cuente) y se avanza next_due_date por frecuencia. El
 *    propio avance de la fecha es el guard de idempotencia (la 2da pasada del cron ya no
 *    matchea next_due <= hoy). Self-healing: si el cron estuvo caído y la fecha quedó varios
 *    períodos atrás, se avanza UN período por pasada; el cron del día siguiente recoge el
 *    resto. (Caso raro: requiere cron caído >1 período; los costos son mensuales y Railway es
 *    always-on.)
 */

/** Días entre dos fechas ISO 'YYYY-MM-DD' (b - a), robusto a timezone (ancla UTC). */
function diffDaysIso(fromIso, toIso) {
  const a = new Date(fromIso + 'T00:00:00Z').getTime();
  const b = new Date(toIso + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

/** Día Lima (YYYY-MM-DD) de un timestamp ISO, o null si no hay. */
function limaDayOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}

/** Avanza next_due_date por frecuencia. one_time → no avanza (lo desactiva el caller). */
function advanceDueDate(referenceIso, frequency) {
  if (frequency === 'monthly') return sumarMeses(referenceIso, 1);
  if (frequency === 'yearly') return sumarMeses(referenceIso, 12);
  return null;
}

/**
 * @param {Array<Object>} costs - filas de admin_costs (id, label, amount_pen, currency,
 *   amount_original, frequency, next_due_date, active, auto_debit, last_reminder_sent_at).
 * @param {string} todayLima - 'YYYY-MM-DD' del día Lima de hoy.
 * @returns {{ toNotify: Array<Object>, toAutoProcess: Array<Object> }}
 */
function planCostReminders(costs, todayLima) {
  const toNotify = [];
  const toAutoProcess = [];

  for (const c of costs || []) {
    if (!c || !c.active) continue;
    if (!c.next_due_date || c.next_due_date > todayLima) continue; // vence hoy o atrasado

    const amount = Number(c.amount_pen) || 0;

    if (c.auto_debit) {
      const reference = c.next_due_date;
      const newNextDue = advanceDueDate(reference, c.frequency);
      toAutoProcess.push({
        id: c.id,
        label: c.label,
        amount_pen: amount,
        currency: c.currency,
        amount_original: c.amount_original != null ? Number(c.amount_original) : null,
        frequency: c.frequency,
        paidEntry: { paid_at: reference, amount_pen: amount, marked_by: 'auto-debit' },
        newNextDue,
        newActive: c.frequency === 'one_time' ? false : c.active,
      });
      continue;
    }

    // Manual: dedup por-día. Si ya se avisó hoy (en día Lima), saltar.
    if (limaDayOf(c.last_reminder_sent_at) === todayLima) continue;

    const diasAtraso = diffDaysIso(c.next_due_date, todayLima); // 0 = vence hoy, >0 = atrasado
    toNotify.push({
      id: c.id,
      label: c.label,
      amount_pen: amount,
      currency: c.currency,
      amount_original: c.amount_original != null ? Number(c.amount_original) : null,
      frequency: c.frequency,
      estado: diasAtraso > 0 ? 'atrasado' : 'vence_hoy',
      dias_atraso: diasAtraso,
    });
  }

  return { toNotify, toAutoProcess };
}

module.exports = { planCostReminders, advanceDueDate, diffDaysIso, limaDayOf };
