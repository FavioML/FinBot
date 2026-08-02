/**
 * El piso del prune es lo unico que separa "retencion" de "borrar el ultimo
 * backup bueno". Si el backup deja de subir por cualquier razon, un prune sin
 * piso vacia el bucket por antiguedad justo cuando hace falta restaurar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prune } from '../scripts/backup/r2.mjs';

const DIA = 86400000;
const AHORA = Date.UTC(2026, 7, 2);

/** Objetos con antiguedad expresada en dias. */
function objetos(dias) {
  return dias.map((d) => ({
    key: `daily/neto-backup-${d}d.tar.gz.age`,
    size: 1000,
    lastModified: new Date(AHORA - d * DIA).toISOString(),
  }));
}

/** deps inyectables: el prune real pega a R2, aca solo registramos. */
function escenario(items) {
  const borrados = [];
  return {
    borrados,
    deps: {
      list: async () => items,
      del: async (k) => { borrados.push(k); },
    },
  };
}

describe('prune de backups en R2', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AHORA));
  });
  afterEach(() => vi.useRealTimers());

  it('borra lo mas viejo primero, hasta donde el piso lo permite', async () => {
    // 10 backups: 4 dentro de 30 dias, 6 fuera. Con piso 7 solo puede borrar 3.
    const { deps, borrados } = escenario(objetos([1, 2, 3, 4, 40, 50, 60, 70, 80, 90]));
    const r = await prune('daily/', 30, 7, deps);
    expect(r.borrados).toEqual([
      'daily/neto-backup-90d.tar.gz.age',
      'daily/neto-backup-80d.tar.gz.age',
      'daily/neto-backup-70d.tar.gz.age',
    ]);
    expect(r.retenidosPorPiso).toBe(3);
    expect(borrados).toHaveLength(3);
  });

  it('no borra NADA si todo es viejo y el piso ya no se cumple', async () => {
    // El escenario del desastre: el backup dejo de correr hace meses. Sin piso
    // esto vaciaria el bucket por antiguedad.
    const { deps, borrados } = escenario(objetos([100, 120, 140, 160, 200]));
    const r = await prune('daily/', 30, 7, deps);
    expect(r.borrados).toEqual([]);
    expect(r.retenidosPorPiso).toBe(5);
    expect(borrados).toEqual([]);
  });

  it('deja intacto lo que esta dentro de la ventana de retencion', async () => {
    const { deps } = escenario(objetos([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const r = await prune('daily/', 30, 7, deps);
    expect(r.borrados).toEqual([]);
    expect(r.total).toBe(10);
  });

  it('nunca deja menos de 7 aunque todo este fuera de retencion', async () => {
    const items = objetos([31, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const { deps } = escenario(items);
    const r = await prune('daily/', 30, 7, deps);
    expect(items.length - r.borrados.length).toBe(7);
  });

  it('con exactamente el piso no borra nada', async () => {
    const { deps } = escenario(objetos([31, 40, 50, 60, 70, 80, 90]));
    const r = await prune('daily/', 30, 7, deps);
    expect(r.borrados).toEqual([]);
  });
});
