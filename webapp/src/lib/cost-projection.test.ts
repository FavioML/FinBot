import { describe, it, expect } from 'vitest';
import { projectOutflows, sumWithinDays, type ProjectionCost } from './cost-projection';

const TODAY = '2026-07-30';

function cost(o: Partial<ProjectionCost> = {}): ProjectionCost {
  return {
    label: o.label ?? 'Railway',
    amount_pen: o.amount_pen ?? 20,
    currency: o.currency ?? 'PEN',
    amount_original: o.amount_original ?? null,
    frequency: o.frequency ?? 'monthly',
    next_due_date: 'next_due_date' in o ? (o.next_due_date as string | null) : '2026-08-05',
    active: o.active ?? true,
  };
}

describe('projectOutflows', () => {
  it('ignora costos inactivos y sin fecha', () => {
    const out = projectOutflows(
      [cost({ active: false }), cost({ next_due_date: null })],
      TODAY,
      90,
    );
    expect(out).toHaveLength(0);
  });

  it('mensual genera varias ocurrencias dentro del horizonte de 90 días', () => {
    // 05-ago, 05-sep, 05-oct caen en [30-jul .. 28-oct]. 05-nov queda fuera.
    const out = projectOutflows([cost({ next_due_date: '2026-08-05', frequency: 'monthly' })], TODAY, 90);
    expect(out.map((o) => o.date)).toEqual(['2026-08-05', '2026-09-05', '2026-10-05']);
    expect(out.every((o) => !o.overdue)).toBe(true);
  });

  it('marca overdue las ocurrencias vencidas y las incluye', () => {
    // Vencido el 15-may, mensual: 15-may (overdue) + 15-jun..15-oct dentro de 90d desde hoy.
    const out = projectOutflows([cost({ next_due_date: '2026-05-15', frequency: 'monthly' })], TODAY, 90);
    expect(out[0]).toMatchObject({ date: '2026-05-15', overdue: true });
    expect(out.some((o) => o.date === '2026-10-15' && !o.overdue)).toBe(true);
  });

  it('one_time genera a lo más una ocurrencia', () => {
    expect(projectOutflows([cost({ next_due_date: '2026-08-10', frequency: 'one_time' })], TODAY, 90)).toHaveLength(1);
    // Fuera del horizonte → nada.
    expect(projectOutflows([cost({ next_due_date: '2027-01-10', frequency: 'one_time' })], TODAY, 90)).toHaveLength(0);
  });

  it('anual genera a lo más una ocurrencia en 90 días', () => {
    expect(projectOutflows([cost({ next_due_date: '2026-09-01', frequency: 'yearly' })], TODAY, 90)).toHaveLength(1);
    expect(projectOutflows([cost({ next_due_date: '2027-03-17', frequency: 'yearly' })], TODAY, 90)).toHaveLength(0);
  });

  it('ordena por fecha ascendente entre costos distintos', () => {
    const out = projectOutflows(
      [
        cost({ label: 'B', next_due_date: '2026-09-01', frequency: 'one_time' }),
        cost({ label: 'A', next_due_date: '2026-08-01', frequency: 'one_time' }),
      ],
      TODAY,
      90,
    );
    expect(out.map((o) => o.label)).toEqual(['A', 'B']);
  });
});

describe('sumWithinDays', () => {
  it('acumula por ventana (30 ⊆ 60 ⊆ 90)', () => {
    const out = projectOutflows([cost({ amount_pen: 10, next_due_date: '2026-08-05', frequency: 'monthly' })], TODAY, 90);
    const d30 = sumWithinDays(out, TODAY, 30); // solo 05-ago
    const d60 = sumWithinDays(out, TODAY, 60); // 05-ago + 05-sep
    const d90 = sumWithinDays(out, TODAY, 90); // + 05-oct
    expect(d30).toBe(10);
    expect(d60).toBe(20);
    expect(d90).toBe(30);
  });
});
