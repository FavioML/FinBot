import { describe, it, expect } from 'vitest';

import { evaluarGate, TOLERANCIA_MS } from '../qa-e2e/backend-deploy-gated.mjs';

/**
 * ¿El build de Railway arrancó DESPUÉS de que su suite de CI terminó?
 *
 * La primera versión de esto comparaba el FIN del deploy contra el fin de la suite, y esa
 * resta es `duraciónBuild − duraciónSuite`: cuando el build tarda más que la suite, un deploy
 * SIN gate igual termina después y salía "esperó". Medido sobre el historial real del
 * servicio, detectaba el **16%** de los deploys sin gate, y 0% en los dos días donde el gate
 * demostrablemente no existía. Lo encontró una revisión adversarial, no esta suite.
 *
 * Los fixtures de abajo son las DOS POBLACIONES REALES, medidas el 07-ago-2026 cruzando los
 * logs de build de Railway con los runs de `ci.yml`. No se solapan ni de cerca, y esa es la
 * propiedad que estos tests protegen: si alguien vuelve a mover la comparación al fin del
 * deploy, o afloja la tolerancia, las dos poblaciones se mezclan y se rompe algo de acá.
 */

// ---- CON GATE: el build arranca 5-6s después de que la suite termina. ----
// Ese +5/+6 es el intervalo con que Railway mira el check suite, no ruido.
const CON_GATE = {
  b6e44e8: { buildEmpezoAt: '2026-08-07T21:16:04.090Z', runCreadoAt: '2026-08-07T21:12:55.000Z', runTerminadoAt: '2026-08-07T21:15:58.000Z', runCompletado: true, margen: 6 },
  '0c55f6b': { buildEmpezoAt: '2026-08-07T20:51:22.484Z', runCreadoAt: '2026-08-07T20:48:56.000Z', runTerminadoAt: '2026-08-07T20:51:16.000Z', runCompletado: true, margen: 6 },
  '89206ac': { buildEmpezoAt: '2026-08-07T07:27:20.467Z', runCreadoAt: '2026-08-07T07:24:53.000Z', runTerminadoAt: '2026-08-07T07:27:15.000Z', runCompletado: true, margen: 5 },
  '52241cd': { buildEmpezoAt: '2026-08-06T00:04:43.744Z', runCreadoAt: '2026-08-06T00:02:10.000Z', runTerminadoAt: '2026-08-06T00:04:39.000Z', runCompletado: true, margen: 5 },
};

// ---- SIN GATE: 05-ago, antes de que el toggle existiera. El build arranca junto al push. ----
const SIN_GATE = {
  a9c5bdf: { buildEmpezoAt: '2026-08-05T20:41:08.864Z', runCreadoAt: '2026-08-05T20:41:05.000Z', runTerminadoAt: '2026-08-05T20:43:48.000Z', runCompletado: true, margen: 159 },
  '3611f9b': { buildEmpezoAt: '2026-08-05T20:35:45.315Z', runCreadoAt: '2026-08-05T20:35:35.000Z', runTerminadoAt: '2026-08-05T20:38:13.000Z', runCompletado: true, margen: 148 },
  '9728433': { buildEmpezoAt: '2026-08-05T19:53:38.909Z', runCreadoAt: '2026-08-05T19:53:40.000Z', runTerminadoAt: '2026-08-05T19:54:55.000Z', runCompletado: true, margen: 76 },
  '0b697e0': { buildEmpezoAt: '2026-08-05T19:51:16.556Z', runCreadoAt: '2026-08-05T19:51:16.000Z', runTerminadoAt: '2026-08-05T19:52:23.000Z', runCompletado: true, margen: 66 },
  '87f3682': { buildEmpezoAt: '2026-08-05T19:21:34.662Z', runCreadoAt: '2026-08-05T19:21:25.000Z', runTerminadoAt: '2026-08-05T19:22:23.000Z', runCompletado: true, margen: 48 },
  e92e2d8: { buildEmpezoAt: '2026-08-05T05:46:23.320Z', runCreadoAt: '2026-08-05T05:46:23.000Z', runTerminadoAt: '2026-08-05T05:47:07.000Z', runCompletado: true, margen: 44 },
};

// 06-ago, el incidente: Actions tardó 3 min en crear el run y Railway construyó sin nada que esperar.
const INCIDENTE_096593A = {
  buildEmpezoAt: '2026-08-06T17:28:03.972Z',
  runCreadoAt: '2026-08-06T17:30:48.000Z',
  runTerminadoAt: '2026-08-06T17:45:52.000Z',
  runCompletado: true,
};

describe('evaluarGate: ¿el build esperó a su suite?', () => {
  for (const [sha, f] of Object.entries(CON_GATE)) {
    it(`${sha} tuvo gate: el build arrancó +${f.margen}s después de la suite`, () => {
      const v = evaluarGate(f);
      expect(v.ok, 'un deploy gateado no puede dar alarma: un guard ruidoso se ignora').toBe(true);
      expect(v.clase).toBe('ESPERO');
      expect(v.margenSeg).toBe(f.margen);
    });
  }

  /**
   * Sin gate el build arranca junto al push, o sea al mismo tiempo que GitHub crea el run, y
   * cuál de los dos queda primero es cuestión de menos de un segundo: `9728433` arrancó 1.1s
   * ANTES del run y cae en `FAIL_OPEN`, sus vecinos medio segundo después y caen en
   * `NO_ESPERO`. Ese reparto cerca del cero es arbitrario y no importa: **las dos clases
   * significan que no hubo gate.** Lo que se fija acá es `ok === false`.
   */
  for (const [sha, f] of Object.entries(SIN_GATE)) {
    it(`${sha} NO tuvo gate: el build arrancó junto al push, no después de la suite`, () => {
      const v = evaluarGate(f);
      expect(v.ok, 'deploy del 05-ago, antes de que "Wait for CI" existiera').toBe(false);
      expect(['NO_ESPERO', 'FAIL_OPEN']).toContain(v.clase);
    });
  }

  it('atrapa el fail-open del 06-ago (096593a): construyó antes de que el run existiera', () => {
    const v = evaluarGate(INCIDENTE_096593A);
    expect(v.ok).toBe(false);
    expect(v.clase).toBe('FAIL_OPEN');
    expect(v.margenSeg).toBe(164);
  });

  /**
   * La propiedad de fondo. El peor caso sin gate es −44s y el mejor con gate es +5s, así que
   * la tolerancia tiene que vivir dentro de esa banda. Si alguien la sube a 60s "por las
   * dudas", los seis deploys sin gate de arriba pasan a verde.
   */
  it('la tolerancia cae entre las dos poblaciones y no las mezcla', () => {
    const peorConGate = Math.min(...Object.values(CON_GATE).map((f) => f.margen));   // +5s
    const mejorSinGate = Math.min(...Object.values(SIN_GATE).map((f) => f.margen));  // 44s
    expect(TOLERANCIA_MS / 1000).toBeGreaterThan(peorConGate);
    expect(TOLERANCIA_MS / 1000).toBeLessThan(mejorSinGate);
  });

  it('el deploy con la suite todavía corriendo es "no esperó", no un transitorio benigno', () => {
    const v = evaluarGate({ ...CON_GATE.b6e44e8, runTerminadoAt: '2026-08-07T21:16:10.000Z', runCompletado: false });
    expect(v.ok).toBe(false);
    expect(v.clase).toBe('NO_ESPERO');
  });

  /**
   * Un redeploy o rollback desde el dashboard de Railway NO consulta "Wait for CI", y crea un
   * deployment nuevo con el mismo sha cuyo build arranca días después del run. Sin cota
   * superior eso salía PASS con margen de 355.833s, o sea el guard certificando como gateada
   * la vía humana más común de saltarse el gate.
   */
  it('un margen absurdo es indeterminado, no PASS: huele a redeploy manual', () => {
    const v = evaluarGate({ ...CON_GATE.b6e44e8, buildEmpezoAt: '2026-08-11T12:00:00.000Z' });
    expect(v.ok, 'no se puede afirmar que hubo gate').toBe(null);
    expect(v.clase).toBe('INDETERMINADO');
  });

  /** Nunca `ok: true` por falta de datos. Es la regla de `validCheckSuites` otra vez. */
  it('con datos ilegibles devuelve indeterminado, nunca PASS', () => {
    expect(evaluarGate({ ...CON_GATE.b6e44e8, buildEmpezoAt: null }).ok).toBe(null);
    expect(evaluarGate({ ...CON_GATE.b6e44e8, runTerminadoAt: 'no-es-una-fecha' }).ok).toBe(null);
    // `runCreadoAt` corrupto se tragaba en silencio y salía ESPERO: la guarda estaba detrás
    // de un `Number.isFinite(creado)` que dejaba pasar el caso en vez de frenarlo.
    expect(evaluarGate({ ...CON_GATE.b6e44e8, runCreadoAt: 'no-es-una-fecha' }).ok).toBe(null);
    expect(evaluarGate({ ...CON_GATE.b6e44e8, runCreadoAt: 1754600000000 }).ok).toBe(null);
  });
});
