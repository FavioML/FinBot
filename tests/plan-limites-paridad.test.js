import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..');

// Paridad de los límites del MURO entre backend y webapp (auditoría 2026-08-03, hallazgo M8).
//
// Estaban divergentes en silencio: `FREE_LIMITS` de la webapp decía `budgets: Infinity,
// goals: 1` (el freemium de abril, derogado) mientras `PLAN_CONFIG.free` del backend decía
// 0 y 0. Hoy no se notaba porque el paywall tapa esas páginas antes, o sea que la webapp era
// una red de seguridad que regalaba justo lo que el backend cobra. La clase de bug que este
// repo ya conoce: dos fuentes para la misma decisión.
//
// Vive en la suite del BACKEND a propósito: es la única que corre en CI hoy (los 149 tests de
// la webapp no tienen job — hallazgo Q1, pendiente de la Ola 2). Un guard que solo corre
// cuando alguien se acuerda no es un guard.

const { PLAN_CONFIG } = require(path.join(projectRoot, 'lib/constants.js'));
const planTs = fs.readFileSync(path.join(projectRoot, 'webapp/src/lib/plan.ts'), 'utf8');

/** Lee un número (o Infinity) del literal FREE_LIMITS de plan.ts. */
function limiteWebapp(clave) {
  const bloque = planTs.slice(planTs.indexOf('export const FREE_LIMITS'));
  const m = bloque.slice(0, bloque.indexOf('}')).match(new RegExp(clave + '\\s*:\\s*([A-Za-z0-9_]+)'));
  if (!m) throw new Error('no encontré ' + clave + ' en FREE_LIMITS (¿se renombró?)');
  return m[1] === 'Infinity' ? Infinity : Number(m[1]);
}

describe('los límites del muro dicen lo mismo en las dos fuentes', () => {
  // Antivacuidad: si el literal se renombra o desaparece, el helper lanza y este test rompe
  // en vez de pasar por no encontrar nada.
  it('FREE_LIMITS existe y es legible', () => {
    expect(planTs).toContain('export const FREE_LIMITS');
    expect(() => limiteWebapp('budgets')).not.toThrow();
  });

  it('presupuestos: webapp == backend', () => {
    expect(limiteWebapp('budgets')).toBe(PLAN_CONFIG.free.maxPresupuestos);
  });

  it('metas: webapp == backend', () => {
    expect(limiteWebapp('goals')).toBe(PLAN_CONFIG.free.maxMetas);
  });

  it('cuentas de Gmail: webapp == backend', () => {
    expect(limiteWebapp('gmail_accounts')).toBe(PLAN_CONFIG.free.maxGmailAccounts);
  });

  it('consejo IA: webapp == backend', () => {
    expect(limiteWebapp('advice_per_week')).toBe(PLAN_CONFIG.free.consejoPerWeek);
  });

  // La regla que no se negocia: registrar por foto ES escribir, y escribir nunca se corta.
  // Si alguien "endurece" el muro poniendo un tope acá, rompe la promesa del producto.
  it('el OCR queda ilimitado en las dos: registrar por foto es ESCRIBIR', () => {
    expect(limiteWebapp('ocr_per_month')).toBe(Infinity);
    expect(PLAN_CONFIG.free.ocrPerMonth).toBe(Infinity);
  });

  // El muro no es un plan gratis: presupuestos y metas son lectura agregada y se cobran.
  it('y el muro efectivamente no regala presupuestos ni metas', () => {
    expect(PLAN_CONFIG.free.maxPresupuestos).toBe(0);
    expect(PLAN_CONFIG.free.maxMetas).toBe(0);
  });
});
