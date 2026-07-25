import { describe, it, expect } from 'vitest';
import { budgetStatus } from './budget-status';

describe('budgetStatus', () => {
  it('is ok (green) below 80%', () => {
    const s = budgetStatus(79, 100);
    expect(s.estado).toBe('ok');
    expect(s.color).toBe('#1D9E75');
  });

  it('is warning (amber) at exactly 80%', () => {
    expect(budgetStatus(80, 100).estado).toBe('warning');
  });

  it('is warning (amber) at exactly 100% — hitting the limit is NOT exceeded', () => {
    const s = budgetStatus(100, 100);
    expect(s.estado).toBe('warning');
    expect(s.color).toBe('#EF9F27');
    expect(s.pct).toBe(100);
  });

  it('is exceeded (red) only when strictly over the limit', () => {
    const s = budgetStatus(100.01, 100);
    expect(s.estado).toBe('exceeded');
    expect(s.color).toBe('#D85A30');
  });

  it('clamps the bar width to 100 while keeping the raw pct', () => {
    const s = budgetStatus(250, 100);
    expect(s.clampedPct).toBe(100);
    expect(s.pct).toBe(250);
  });

  it('treats a zero/absent limit as ok with 0%', () => {
    const s = budgetStatus(50, 0);
    expect(s.estado).toBe('ok');
    expect(s.pct).toBe(0);
    expect(s.clampedPct).toBe(0);
  });

  it('is ok at 0 spent', () => {
    expect(budgetStatus(0, 100).estado).toBe('ok');
  });
});
