import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolverFechaRelativa, resolverDiaSemanaPasado } = require('../../lib/dates');

// Helper: dado fechaHoy YYYY-MM-DD, devuelve YYYY-MM-DD restando N días.
function diasAtras(fechaHoy, n) {
  const [y, m, d] = fechaHoy.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - n);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

describe('resolverFechaRelativa', () => {
  const HOY = '2026-05-09';
  const AYER = diasAtras(HOY, 1);
  const ANTEAYER = diasAtras(HOY, 2);
  const HACE_3 = diasAtras(HOY, 3);

  it('"ayer" → corrige fecha del parser', () => {
    expect(resolverFechaRelativa('ayer gasté 30 en almuerzo', HOY, HOY)).toBe(AYER);
  });

  it('"ayer" → no-op si parser ya tiene la fecha correcta', () => {
    expect(resolverFechaRelativa('ayer gasté 30 en almuerzo', AYER, HOY)).toBeNull();
  });

  it('"anteayer" → 2 días atrás', () => {
    expect(resolverFechaRelativa('anteayer pagué 40 de gas', HOY, HOY)).toBe(ANTEAYER);
  });

  it('"antier" → 2 días atrás', () => {
    expect(resolverFechaRelativa('antier compré 20 en pan', HOY, HOY)).toBe(ANTEAYER);
  });

  it('"hace 3 días" → 3 días atrás', () => {
    expect(resolverFechaRelativa('hace 3 días pagué 80 de luz', HOY, HOY)).toBe(HACE_3);
  });

  it('"hace tres días" (palabra) → 3 días atrás', () => {
    expect(resolverFechaRelativa('hace tres días pagué 80 de luz', HOY, HOY)).toBe(HACE_3);
  });

  it('"hace un día" → 1 día atrás', () => {
    expect(resolverFechaRelativa('hace un día gasté 50', HOY, HOY)).toBe(AYER);
  });

  it('"el lunes pasado" NO activa este guard (delegado a resolverDiaSemanaPasado)', () => {
    expect(resolverFechaRelativa('el lunes pasado gasté 50 en taxi', HOY, HOY)).toBeNull();
  });

  it('msg sin marcador relativo → null', () => {
    expect(resolverFechaRelativa('gasté 50 en farmacia', HOY, HOY)).toBeNull();
  });

  it('"ayer" dentro de "anteayer" no produce falso positivo', () => {
    // anteayer detecta primero; el resultado debe ser 2 días, no 1.
    expect(resolverFechaRelativa('anteayer gasté 30', HOY, HOY)).toBe(ANTEAYER);
  });
});
