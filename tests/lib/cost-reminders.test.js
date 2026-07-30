import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const APP = path.join(import.meta.dirname, '..', '..');
const { planCostReminders, advanceDueDate } = require(path.join(APP, 'lib', 'cost-reminders.js'));

const TODAY = '2026-07-30';

function cost(overrides = {}) {
  return {
    id: overrides.id || 'c1',
    label: overrides.label || 'Railway',
    amount_pen: overrides.amount_pen ?? 50,
    currency: overrides.currency || 'PEN',
    amount_original: overrides.amount_original ?? null,
    frequency: overrides.frequency || 'monthly',
    next_due_date: 'next_due_date' in overrides ? overrides.next_due_date : TODAY,
    active: overrides.active ?? true,
    auto_debit: overrides.auto_debit ?? false,
    last_reminder_sent_at: overrides.last_reminder_sent_at ?? null,
  };
}

describe('planCostReminders — manual', () => {
  it('notifica un costo manual que vence hoy', () => {
    const { toNotify, toAutoProcess } = planCostReminders([cost()], TODAY);
    expect(toAutoProcess).toHaveLength(0);
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0].estado).toBe('vence_hoy');
    expect(toNotify[0].dias_atraso).toBe(0);
  });

  it('marca atrasado y calcula los días de atraso', () => {
    const { toNotify } = planCostReminders([cost({ next_due_date: '2026-07-27' })], TODAY);
    expect(toNotify[0].estado).toBe('atrasado');
    expect(toNotify[0].dias_atraso).toBe(3);
  });

  it('ignora costos con vencimiento futuro', () => {
    const { toNotify } = planCostReminders([cost({ next_due_date: '2026-08-05' })], TODAY);
    expect(toNotify).toHaveLength(0);
  });

  it('ignora costos pausados y sin fecha', () => {
    const rows = [
      cost({ id: 'a', active: false }),
      cost({ id: 'b', next_due_date: null }),
    ];
    const { toNotify, toAutoProcess } = planCostReminders(rows, TODAY);
    expect(toNotify).toHaveLength(0);
    expect(toAutoProcess).toHaveLength(0);
  });

  it('dedup por-día: no repite si ya se avisó hoy (día Lima)', () => {
    // 2026-07-30 15:00Z == 2026-07-30 10:00 Lima → mismo día, se salta.
    const sent = cost({ last_reminder_sent_at: '2026-07-30T15:00:00Z' });
    expect(planCostReminders([sent], TODAY).toNotify).toHaveLength(0);
    // Aviso de ayer → sí notifica de nuevo (nag diario).
    const old = cost({ last_reminder_sent_at: '2026-07-29T15:00:00Z' });
    expect(planCostReminders([old], TODAY).toNotify).toHaveLength(1);
  });

  it('respeta el borde de día Lima (UTC-5) para el dedup', () => {
    // 2026-07-31 03:00Z == 2026-07-30 22:00 Lima → todavía es "hoy" en Lima, se salta.
    const sent = cost({ last_reminder_sent_at: '2026-07-31T03:00:00Z' });
    expect(planCostReminders([sent], TODAY).toNotify).toHaveLength(0);
  });
});

describe('planCostReminders — auto débito', () => {
  it('auto-procesa un costo automático que vence hoy: registra pago y avanza mensual', () => {
    const { toNotify, toAutoProcess } = planCostReminders(
      [cost({ auto_debit: true, amount_pen: 80 })],
      TODAY,
    );
    expect(toNotify).toHaveLength(0);
    expect(toAutoProcess).toHaveLength(1);
    const p = toAutoProcess[0];
    expect(p.paidEntry).toEqual({ paid_at: TODAY, amount_pen: 80, marked_by: 'auto-debit' });
    expect(p.newNextDue).toBe('2026-08-30');
    expect(p.newActive).toBe(true);
  });

  it('registra el pago en la fecha de vencimiento, no en hoy, si venía atrasado', () => {
    const { toAutoProcess } = planCostReminders(
      [cost({ auto_debit: true, next_due_date: '2026-07-15' })],
      TODAY,
    );
    // paid_at = fecha real del cobro (next_due), y avanza UN período desde ahí (self-healing).
    expect(toAutoProcess[0].paidEntry.paid_at).toBe('2026-07-15');
    expect(toAutoProcess[0].newNextDue).toBe('2026-08-15');
  });

  it('avanza anual y desactiva one_time', () => {
    const yearly = planCostReminders(
      [cost({ id: 'y', auto_debit: true, frequency: 'yearly', next_due_date: '2026-07-30' })],
      TODAY,
    ).toAutoProcess[0];
    expect(yearly.newNextDue).toBe('2027-07-30');
    expect(yearly.newActive).toBe(true);

    const once = planCostReminders(
      [cost({ id: 'o', auto_debit: true, frequency: 'one_time' })],
      TODAY,
    ).toAutoProcess[0];
    expect(once.newNextDue).toBeNull();
    expect(once.newActive).toBe(false);
  });
});

describe('advanceDueDate', () => {
  it('clampea fin de mes (31 ene + 1 mes = 28 feb)', () => {
    expect(advanceDueDate('2026-01-31', 'monthly')).toBe('2026-02-28');
  });
  it('one_time no avanza', () => {
    expect(advanceDueDate('2026-07-30', 'one_time')).toBeNull();
  });
});
