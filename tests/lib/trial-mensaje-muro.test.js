import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// El mensaje del muro es el único texto que ve un usuario cuando pierde el acceso, y el
// día 15 es el momento en que todo el rediseño del trial se juega. Este archivo existe
// porque ese mensaje salía MAL y ningún test lo miraba:
//
// `cron/checks.js` seleccionaba `id, whatsapp, nombre, trial_vence` — sin `trial_estado` —
// y `mensajeMuro` ramifica justo por esa columna. Llegaba `undefined`, caía en la rama de
// "nunca tuviste prueba" y le prometía 14 días gratis a quien acababa de gastarlos y que,
// por `trial_estado='vencido'`, no iba a recibir otro nunca.
//
// La lección que codifica este archivo: una fila PARCIAL no puede elegir una rama por
// accidente. `undefined` (la columna no se pidió) y `null` (de verdad nunca tuvo trial)
// son cosas distintas y tienen que responder distinto.

// Mismo patrón que el resto de tests del backend (ver pro-payment-fallos.test.js): se
// inyectan los módulos en require.cache antes de cargar el que se prueba. mensajeMuro es
// puro, así que solo hacen falta los que lib/trial.js requiere al importarse.
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
for (const [rel, exports] of [
  ['lib/db.js', { supabase: {} }],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { mensajeMuro, TRIAL_DIAS } = require('../../lib/trial');

const BASE = { id: 'u1', nombre: 'Favio Mendoza' };

beforeEach(() => { logMock.error.mockClear(); });

describe('mensajeMuro — la rama la decide trial_estado', () => {
  it('NUNCA tuvo prueba (null): la invita, sin afirmar que algo terminó', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: null }, 12);
    expect(msg).toContain(TRIAL_DIAS + ' días gratis');
    expect(msg).not.toMatch(/terminó|venció/);
  });

  it('sin transacciones dice "primer gasto", con transacciones dice "próximo"', () => {
    expect(mensajeMuro({ ...BASE, trial_estado: null }, 0)).toContain('tu primer gasto');
    expect(mensajeMuro({ ...BASE, trial_estado: null }, 7)).toContain('tu próximo gasto');
  });

  /**
   * El TERCER valor de `conteoTx`, que hasta el 31-ago no existía y por eso el defecto era
   * posible: `undefined` es "no se pudo contar", `null`/`0` es "de verdad no anotó nada".
   * Con `count` de PostgREST volviendo `null` al fallar, quien lea un `{ error }` y pase ese
   * `null` tal cual le afirma a alguien con decenas de gastos que le falta el primero.
   * Alcanzable: 19 usuarios reales free con `trial_estado` NULL y transacciones (máx. 63).
   */
  it('sin poder contar (undefined) no afirma NI primero NI próximo', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: null }, undefined);
    expect(msg).toContain('registres un gasto');
    expect(msg).not.toContain('primer gasto');
    expect(msg).not.toContain('próximo gasto');
    // Y el resto del cartel sale igual: degradar no es callarse.
    expect(msg).toContain(TRIAL_DIAS + ' días gratis');
  });

  it('`undefined` y `null` NO dicen lo mismo (si convergen, el contrato se perdió)', () => {
    const sinDatos = mensajeMuro({ ...BASE, trial_estado: null }, null);
    const sinPoder = mensajeMuro({ ...BASE, trial_estado: null }, undefined);
    expect(sinPoder).not.toBe(sinDatos);
  });

  it('terminó su prueba (vencido): la nombra con fecha y NO le ofrece otra', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: 'vencido', trial_vence: '2026-08-31' }, 40);
    expect(msg).toContain('prueba de *Neto Pro* terminó el');
    // La regresión exacta que motivó este archivo.
    expect(msg).not.toContain('días gratis');
  });

  it('ex-pagador (convertido con historial de pago): le habla de su Pro, no de una prueba', () => {
    const msg = mensajeMuro(
      { ...BASE, trial_estado: 'convertido', premium_desde: '2026-06-03', premium_vence: '2026-07-03' },
      87,
    );
    expect(msg).toContain('*Neto Pro* venció el');
    // Fue cliente. Decirle que se le acabó una prueba le borra eso, y es el segmento más
    // valioso que hay para recuperar.
    expect(msg).not.toContain('prueba');
    expect(msg).not.toContain('días gratis');
  });

  it('convertido SIN historial de pago cae en el texto de prueba, no en el de cliente', () => {
    const msg = mensajeMuro({ ...BASE, trial_estado: 'convertido', trial_vence: '2026-08-31' }, 3);
    expect(msg).toContain('prueba de *Neto Pro*');
  });
});

describe('mensajeMuro — una fila incompleta no puede elegir rama', () => {
  it('sin trial_estado (columna no pedida) NO promete un trial: usa el texto genérico', () => {
    const msg = mensajeMuro({ ...BASE, trial_vence: '2026-08-31' }, 40);
    expect(msg).not.toContain('días gratis');   // ← el bug
    expect(msg).not.toMatch(/terminó|venció/);  // tampoco afirma lo contrario
    expect(msg).toContain('necesitas *Neto Pro*');
  });

  it('y lo loguea como error, porque es un bug del llamador y no un estado del usuario', () => {
    mensajeMuro({ ...BASE }, 1);
    expect(logMock.error).toHaveBeenCalledOnce();
    expect(logMock.error.mock.calls[0][1]).toMatch(/trial_estado/);
  });

  it('usuario null (sin fila) sigue devolviendo texto, no revienta', () => {
    expect(typeof mensajeMuro(null, 0)).toBe('string');
  });
});

describe('mensajeMuro — lo que las tres ramas comparten', () => {
  const casos = [
    ['nunca tuvo', { trial_estado: null }],
    ['vencido', { trial_estado: 'vencido', trial_vence: '2026-08-31' }],
    ['ex-pagador', { trial_estado: 'convertido', premium_vence: '2026-07-03' }],
  ];

  it.each(casos)('%s: nunca dice que Neto dejó de anotar', (_, extra) => {
    const msg = mensajeMuro({ ...BASE, ...extra }, 20);
    // La promesa que no se negocia: escribir nunca se corta. Un muro que se lee como
    // "Neto se rompió" no vende, hace que la persona se vaya.
    expect(msg.toLowerCase()).toMatch(/anot|gasto/);
  });

  it.each(casos.slice(1))('%s: nombra el precio y el camino de pago', (_, extra) => {
    const msg = mensajeMuro({ ...BASE, ...extra }, 20);
    expect(msg).toContain('/dashboard/pro');
    expect(msg).toMatch(/S\/\d+/);
  });
});
