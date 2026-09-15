import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * El cierre del día de la prueba, pieza por pieza (plan día 0→1, paso 2, 14-sep-2026):
 *
 *   · `armarCierreDiaPrueba` — qué lleva el mensaje según el día y la cuenta web. El día 2 ofrece
 *     seguir con `/manoslibres`: el "sí" suelto se retiró después de que dos revisiones
 *     adversariales le encontraran la misma clase de defecto en direcciones opuestas.
 *   · `diaDePrueba` y la promesa del primer gasto (`colaConfirmacionGasto`), que tienen que exigir
 *     lo mismo que el cron para que no se prometa un cierre que no sale.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

const dbMock = { supabase: { from: () => { throw new Error('este test no lee la base'); } } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
logMock.child = () => logMock;
for (const [rel, exports] of [['lib/db.js', dbMock], ['lib/logger.js', logMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const cierre = require('../../lib/cierre-dia-prueba');
const trial = require('../../lib/trial');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

beforeEach(() => { delete process.env.CIERRE_DIA_PRUEBA; });

// ═════════════════════════════════════════════════════════════════════════════
describe('armarCierreDiaPrueba', () => {
  const RESUMEN = '🌙 *Tu cierre de hoy, Ana*\n\nHoy anotaste 1 gasto: *S/ 12.00* en Transporte (taxi).';
  const OFERTA = '¿Quieres que siga cada noche a las 9? Escribe */manoslibres*.';

  it('sin resumen no hay cierre', () => {
    expect(cierre.armarCierreDiaPrueba({ dia: 0, resumen: null })).toBeNull();
  });

  it('día 0: el resumen, la pregunta de hoy y la salida; sin oferta', () => {
    const r = cierre.armarCierreDiaPrueba({ dia: 0, resumen: RESUMEN });
    expect(r.mensaje.startsWith(RESUMEN)).toBe(true);
    expect(r.mensaje).toContain('¿Se te pasó alguno? Mándamelo ahora y queda en el día.');
    expect(r.mensaje).toContain('/silenciar');
    expect(r.mensaje).not.toContain(OFERTA);
  });

  // `/manoslibres` es un toggle: fuera del día 2 no aparece, y nunca como SALIDA.
  it('días 0 y 1 no nombran /manoslibres', () => {
    for (const dia of [0, 1]) {
      expect(cierre.armarCierreDiaPrueba({ dia, resumen: RESUMEN }).mensaje).not.toContain('/manoslibres');
    }
  });

  it('día 2 ofrece seguir cada noche con el comando que ya existe', () => {
    const r = cierre.armarCierreDiaPrueba({ dia: 2, resumen: RESUMEN });
    expect(r.mensaje).toContain('Mañana ya no te lo mando solo. ' + OFERTA);
    // La salida sigue siendo /silenciar, y va DESPUÉS de la oferta.
    expect(r.mensaje.indexOf('/silenciar')).toBeGreaterThan(r.mensaje.indexOf(OFERTA));
  });

  it('sin cuenta web lleva el link de activación; la campana no', () => {
    const link = 'https://app.neto.pe/activar?t=abc.def';
    const r = cierre.armarCierreDiaPrueba({ dia: 0, resumen: RESUMEN, linkActivacion: link });
    expect(r.mensaje).toContain(link);
    expect(r.cuerpo).not.toContain(link);
  });

  it('la campana no pide contestar por chat ni ofrece comandos', () => {
    const r = cierre.armarCierreDiaPrueba({ dia: 2, resumen: RESUMEN });
    expect(r.cuerpo).not.toMatch(/Mándamelo|\/silenciar|\/manoslibres|Escribe/);
    expect(r.cuerpo).not.toMatch(/[*_]/);
    expect(r.cuerpo).toContain('Anótalo aquí o por WhatsApp');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('diaDePrueba: días de calendario en Lima', () => {
  const enPrueba = (trial_inicio) => ({ plan: 'premium', trial_estado: 'activo', trial_inicio });

  // 20:30 Lima del 13-sep = 01:30 UTC del 14-sep. Un `slice(0,10)` lo leería como día 14.
  it('un primer gasto de noche cuenta desde la fecha LIMA, no la UTC', () => {
    const u = enPrueba('2026-09-14T01:30:00.000Z');
    expect(trial.diaDePrueba(u, '2026-09-13')).toBe(0);
    expect(trial.diaDePrueba(u, '2026-09-14')).toBe(1);
    expect(trial.diaDePrueba(u, '2026-09-15')).toBe(2);
    expect(trial.diaDePrueba(u, '2026-09-16')).toBe(3);
  });

  it('00:01 Lima es el mismo día', () => {
    expect(trial.diaDePrueba(enPrueba('2026-09-13T05:01:00.000Z'), '2026-09-13')).toBe(0);
  });

  it('23:59 Lima del día anterior es día 1 al minuto siguiente', () => {
    expect(trial.diaDePrueba(enPrueba('2026-09-13T04:59:00.000Z'), '2026-09-13')).toBe(1);
  });

  it('fuera de prueba, sin trial_inicio o con fecha rota: null', () => {
    expect(trial.diaDePrueba({ plan: 'premium', trial_estado: 'convertido', trial_inicio: '2026-09-13T15:00:00Z' }, '2026-09-13')).toBeNull();
    expect(trial.diaDePrueba({ plan: 'free', trial_estado: 'activo', trial_inicio: '2026-09-13T15:00:00Z' }, '2026-09-13')).toBeNull();
    expect(trial.diaDePrueba(enPrueba(null), '2026-09-13')).toBeNull();
    expect(trial.diaDePrueba(enPrueba('no-es-fecha'), '2026-09-13')).toBeNull();
    expect(trial.diaDePrueba(enPrueba('2026-09-15T15:00:00Z'), '2026-09-13')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('la promesa del cierre en la respuesta al primer gasto', () => {
  const HOY = '2026-09-14';
  const DIEZ_AM = '2026-09-14T15:00:00Z';     // 10:00 Lima
  const NUEVE_Y_CINCO_PM = '2026-09-15T02:05:00Z'; // 21:05 Lima del 14
  const PROMESA = 'Esta noche a las 9 te mando el cierre de tu día';
  const nuevo = (extra = {}) => ({
    id: 'u1', plan: 'free', trial_estado: null, supabase_auth_id: 'auth-1',
    recordatorios_activos: true, manos_libres: false, ...extra,
  });
  const txHoy = { trialIniciado: true, fecha: HOY, tipo: 'gasto' };

  afterEach(() => { delete process.env.CIERRE_DIA_PRUEBA; });

  it('antes de las 21h, con un gasto de hoy: promete', async () => {
    vi.setSystemTime(new Date(DIEZ_AM));
    expect(await trial.colaConfirmacionGasto(nuevo(), txHoy, 1)).toContain(PROMESA);
  });

  it('después de las 21h no promete (hoy ya no hay cierre)', async () => {
    vi.setSystemTime(new Date(NUEVE_Y_CINCO_PM));
    const r = await trial.colaConfirmacionGasto(nuevo(), txHoy, 1);
    expect(r).toContain('Acabas de estrenar');
    expect(r).not.toContain(PROMESA);
  });

  it('un gasto con fecha pasada no promete: el cierre resume la fecha de hoy', async () => {
    vi.setSystemTime(new Date(DIEZ_AM));
    expect(await trial.colaConfirmacionGasto(nuevo(), { ...txHoy, fecha: '2026-09-13' }, 1)).not.toContain(PROMESA);
  });

  // La prueba arranca con cualquier movimiento, y el cierre solo lee gastos: "me pagaron 1500"
  // prometía un cierre que a las 21h salía null (revisión adversarial, 14-sep).
  it('un primer movimiento que es un ingreso no promete', async () => {
    vi.setSystemTime(new Date(DIEZ_AM));
    const r = await trial.colaConfirmacionGasto(nuevo(), { ...txHoy, tipo: 'ingreso' }, 1);
    expect(r).toContain('Acabas de estrenar');
    expect(r).not.toContain(PROMESA);
  });

  it('silenciado o con Manos Libres no promete (el cron los excluye)', async () => {
    vi.setSystemTime(new Date(DIEZ_AM));
    expect(await trial.colaConfirmacionGasto(nuevo({ recordatorios_activos: false }), txHoy, 1)).not.toContain(PROMESA);
    expect(await trial.colaConfirmacionGasto(nuevo({ manos_libres: true }), txHoy, 1)).not.toContain(PROMESA);
  });

  it('la foto no promete (no deja turno en conversaciones)', async () => {
    vi.setSystemTime(new Date(DIEZ_AM));
    expect(await trial.colaConfirmacionGasto(nuevo(), txHoy, 1, { prometeCierre: false })).not.toContain(PROMESA);
  });

  it('con el freno puesto no promete', async () => {
    vi.setSystemTime(new Date(DIEZ_AM));
    process.env.CIERRE_DIA_PRUEBA = 'off';
    expect(await trial.colaConfirmacionGasto(nuevo(), txHoy, 1)).not.toContain(PROMESA);
  });

  it('el link de activación se queda, después de la promesa', async () => {
    vi.setSystemTime(new Date(DIEZ_AM));
    const previo = process.env.ACTIVATION_TOKEN_SECRET;
    process.env.ACTIVATION_TOKEN_SECRET = 'secreto-de-test';
    try {
      const r = await trial.colaConfirmacionGasto(nuevo({ supabase_auth_id: null }), txHoy, 1);
      expect(r).toContain(PROMESA);
      expect(r).toContain('/activar?t=');
      expect(r.indexOf(PROMESA)).toBeLessThan(r.indexOf('/activar?t='));
    } finally {
      if (previo === undefined) delete process.env.ACTIVATION_TOKEN_SECRET; else process.env.ACTIVATION_TOKEN_SECRET = previo;
    }
  });
});
