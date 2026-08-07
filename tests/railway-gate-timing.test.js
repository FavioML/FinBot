import { describe, it, expect } from 'vitest';

import { evaluarGate } from '../qa-e2e/backend-deploy-gated.mjs';

/**
 * El detector de `backend-deploy-gated.mjs` compara dos relojes: cuándo terminó el deploy de
 * Railway y cuándo existió/terminó el run de CI de ese mismo commit. La regla es corta, así
 * que la tentación es darla por obvia. No lo es: hay un caso real donde falló abierto y el
 * resto de los guards dijeron PASS.
 *
 * Por eso los fixtures son los TIMESTAMPS DEL INCIDENTE, no números inventados. Si mañana
 * alguien ablanda la comparación o mueve la tolerancia, el caso que se rompe es el que ya
 * pasó de verdad, no uno que a mí me pareció representativo.
 */

// 06-ago-2026. Railway desplegó `096593a` sin gate durante el outage de Actions.
// Fin del deploy: registrado en CLAUDE.md al investigarlo. Horas del run: leídas de la API
// de GitHub el 07-ago (created 17:30:48Z, updated 17:45:52Z, conclusion `failure`).
const INCIDENTE_096593A = {
  deployTerminadoAt: '2026-08-06T17:28:42.000Z',
  runCreadoAt: '2026-08-06T17:30:48.000Z',
  runTerminadoAt: '2026-08-06T17:45:52.000Z',
  runCompletado: true,
};

// 07-ago-2026, el mismo día, con el gate sano: `89206ac`. Leído de las dos APIs.
// El margen fue de apenas 38.7 segundos, y por eso la tolerancia no puede ser generosa.
const SANO_89206AC = {
  deployTerminadoAt: '2026-08-07T07:27:53.658Z',
  runCreadoAt: '2026-08-07T07:24:53.000Z',
  runTerminadoAt: '2026-08-07T07:27:15.000Z',
  runCompletado: true,
};

describe('evaluarGate: ¿el deploy esperó a su suite?', () => {
  it('atrapa el fail-open real del 06-ago (096593a): el deploy terminó antes de que el run existiera', () => {
    const v = evaluarGate(INCIDENTE_096593A);
    expect(v.ok, 'el caso que motivó todo este trabajo tiene que dar NO').toBe(false);
    expect(v.clase).toBe('FAIL_OPEN');
    expect(v.margenSeg).toBe(126); // 17:28:42 → 17:30:48
  });

  it('deja pasar el deploy gateado sano del 07-ago (89206ac), con ~39s de margen', () => {
    const v = evaluarGate(SANO_89206AC);
    expect(v.ok, 'un deploy que SÍ esperó no puede dar alarma: un guard ruidoso se ignora').toBe(true);
    expect(v.clase).toBe('ESPERO');
    expect(v.margenSeg).toBe(39); // 38.658s reales
  });

  /**
   * El margen sano medido es de 38.7s. Si la tolerancia creciera por encima de eso, el detector
   * empezaría a tragarse bypasses cortos. Este test fija ese techo explícitamente en vez de
   * dejarlo escrito solo en un comentario.
   */
  it('la tolerancia por desfase de reloj no se come el margen real de un deploy sano', async () => {
    const { TOLERANCIA_MS } = await import('../qa-e2e/backend-deploy-gated.mjs');
    expect(TOLERANCIA_MS).toBeLessThan(38_000);
  });

  it('un commit desplegado sin NINGÚN run de CI es el fail-open puro', () => {
    const v = evaluarGate({ ...INCIDENTE_096593A, runCreadoAt: null, runTerminadoAt: null });
    expect(v.ok).toBe(false);
    expect(v.clase).toBe('FAIL_OPEN_SIN_RUN');
  });

  it('el deploy terminado con la suite todavía corriendo es "no esperó", no un transitorio benigno', () => {
    const v = evaluarGate({
      deployTerminadoAt: '2026-08-07T10:01:30.000Z',
      runCreadoAt: '2026-08-07T10:00:01.000Z',
      runTerminadoAt: '2026-08-07T10:01:00.000Z', // último latido, no fin
      runCompletado: false,
    });
    expect(v.ok).toBe(false);
    expect(v.clase).toBe('NO_ESPERO');
  });

  it('atrapa el toggle apagado: el run existe, el deploy termina en el medio', () => {
    const v = evaluarGate({
      deployTerminadoAt: '2026-08-07T10:01:30.000Z',
      runCreadoAt: '2026-08-07T10:00:01.000Z',
      runTerminadoAt: '2026-08-07T10:03:00.000Z',
      runCompletado: true,
    });
    expect(v.ok).toBe(false);
    expect(v.clase).toBe('NO_ESPERO');
    expect(v.margenSeg).toBe(90);
  });

  it('un desfase de relojes de pocos segundos NO dispara alarma', () => {
    const v = evaluarGate({
      deployTerminadoAt: '2026-08-07T10:02:57.000Z',
      runCreadoAt: '2026-08-07T10:00:01.000Z',
      runTerminadoAt: '2026-08-07T10:03:00.000Z', // el deploy figura 3s antes
      runCompletado: true,
    });
    expect(v.ok, 'tres segundos de desfase no son un bypass').toBe(true);
  });

  /**
   * Nunca `ok: true` por falta de datos. Es la regla de `validCheckSuites` otra vez: un guard
   * que no puede responder tiene que decirlo, no dar verde.
   */
  it('con datos ilegibles devuelve indeterminado, nunca PASS', () => {
    expect(evaluarGate({ ...SANO_89206AC, deployTerminadoAt: null }).ok).toBe(null);
    expect(evaluarGate({ ...SANO_89206AC, runTerminadoAt: 'no-es-una-fecha' }).ok).toBe(null);
  });
});
