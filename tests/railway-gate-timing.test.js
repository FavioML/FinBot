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

  /**
   * **"No hay run" no prueba "nunca hubo run".** Hasta el 08-ago la rama sin run devolvía exit 1
   * con el detalle "se desplegó y NUNCA existió un run de CI para ese commit", que es una
   * afirmación sobre la historia sostenida por una sola observación del presente.
   *
   * Tres causas dejan el MISMO rastro (cero runs, cero check suites) y solo una es un fail-open:
   *
   *  1. el sha es un commit INTERMEDIO de un push en lote. GitHub crea UN run por evento de push,
   *     con `head_sha` en la PUNTA. Medido en este repo: `112734f` (mismo segundo que `89206ac`,
   *     que sí tiene run) y `373f82b` no tienen run ni check suite.
   *  2. la retención de Actions borró el run y el deployment de Railway le sobrevivió. El
   *     mecanismo existe; **en este repo no hay una sola observación de que haya pasado**.
   *  3. el deploy salió de verdad sin gate.
   *
   * **Ninguna se puede descartar desde acá**, y ese es el punto de estos tests. Se intentó
   * descartar la 2 con un "horizonte de retención" (el run más viejo que todavía existe) y hubo
   * que revertirlo entero: ese número es la fecha de NACIMIENTO del workflow, no una retención
   * — el run más viejo de `ci.yml` es 13 minutos posterior al commit que lo crea (`48155ca`). Ver
   * la nota larga en `qa-e2e/backend-deploy-gated.mjs`, donde vivía la función.
   *
   * Para la pregunta de este harness las tres son lo mismo igual: si el sha desplegado no tiene
   * run, Railway no tuvo ningún check suite que esperar. Siguen en exit 1 y lo que se corrigió es
   * el texto.
   */
  describe('sin run: se corrige el TEXTO, y no se ablanda el veredicto', () => {
    const SIN_RUN = {
      runCreadoAt: null,
      runTerminadoAt: null,
      runCompletado: false,
    };

    /**
     * **El guard que impide reconstruir lo revertido.** Ninguna fecha de build, ni la más antigua,
     * puede producir `ok: null` en la rama sin run. Cubre las dos fechas que importan —el
     * incidente real del 06-ago (`096593a`, build 17:27:36Z) y un build anterior a cualquier run
     * de CI, que es el que el horizonte ablandaba— y varias más, de una sola vez.
     *
     * Está escrito como barrido y no como tres `it` separados a propósito: los tres que había eran
     * subconjuntos literales de este, con las mismas dos aserciones sobre fechas ya incluidas acá.
     * Tres nombres para un test no son tres tests.
     */
    it('NINGUNA entrada sin run puede producir ok null, ni la más antigua', () => {
      const fechas = [
        '2020-01-01T00:00:00.000Z',   // muy anterior a cualquier run: lo que el horizonte ablandaba
        '2026-02-01T10:00:00.000Z',   // anterior al primer run de ci.yml (2026-03-21)
        '2026-08-06T17:27:36.000Z',   // el incidente real: 096593a
        '2026-08-07T07:24:10.000Z',
        '2026-08-08T12:00:00.000Z',
        new Date().toISOString(),
      ];
      for (const buildEmpezoAt of fechas) {
        const v = evaluarGate({ ...SIN_RUN, buildEmpezoAt });
        expect(v.ok, `buildEmpezoAt=${buildEmpezoAt}`).toBe(false);
        expect(v.clase).toBe('FAIL_OPEN_SIN_RUN');
      }
    });

    /**
     * Lo que SÍ cambió: el detalle decía "se desplegó y **NUNCA existió** un run de CI para ese
     * commit", una afirmación sobre la historia sostenida por una observación del presente.
     *
     * Las aserciones son sobre PROSA, y eso las hace frágiles (mueren si alguien reescribe el
     * mensaje aunque el comportamiento siga bien). Se dejan igual porque acá el mensaje **es** el
     * arreglo: el veredicto no cambió, solo el texto. Lo que NO se fija es que el mensaje nombre
     * la retención: esa causa no tiene una sola observación en este repo, y exigir que el texto la
     * mencione sería usar un test para perpetuar lo no medido.
     */
    it('el detalle reporta lo observado en vez de afirmar la causa', () => {
      const v = evaluarGate({ ...SIN_RUN, buildEmpezoAt: '2026-08-07T07:24:10.000Z' });
      expect(v.detalle, 'no se afirma lo que no se observó').not.toMatch(/NUNCA existió/);
      expect(v.detalle).toMatch(/no existe HOY/);
      expect(v.detalle).toMatch(/INTERMEDIO/);
      expect(v.detalle).toMatch(/ninguna se descarta/);
    });

    /** Y no queda un `horizonteRetencion` exportado al que alguien pueda volver a cablear. */
    it('el módulo no exporta ningún horizonte de retención', async () => {
      const mod = await import('../qa-e2e/backend-deploy-gated.mjs');
      expect(Object.keys(mod).filter((k) => /horizonte|retencion|retención/i.test(k))).toEqual([]);
    });
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
