import { describe, it, expect } from 'vitest';
import { TRIAL_DIAS, diasRestantesTrial } from './plan';

/**
 * La prueba dura 7 días desde el 04-nov-2026, y las que arrancaron con 14 terminan con sus 14.
 *
 * `TRIAL_DIAS` es solo copy en la webapp (lo que se le promete a quien no la estrenó). Lo que
 * cuenta los días que le quedan a alguien lee `trial_vence`, la fecha que el backend escribió al
 * arrancar. Si este archivo cayera a derivar el vencimiento de la constante, una prueba de 14 en
 * su día 10 vería "termina hoy" en el banner. Espejo del caso de `tests/cron/trial-7-dias.test.js`.
 */
describe('la duración de la prueba en la webapp', () => {
  it('el copy promete 7 días, igual que el backend', () => {
    expect(TRIAL_DIAS).toBe(7);
  });

  it('a una prueba de 14 en curso le quedan los días de su trial_vence, no de TRIAL_DIAS', () => {
    expect(diasRestantesTrial('premium', 'activo', '2026-11-14', '2026-11-10')).toBe(4);
  });

  it('una prueba nueva cuenta igual, desde su trial_vence', () => {
    expect(diasRestantesTrial('premium', 'activo', '2026-11-15', '2026-11-10')).toBe(5);
    expect(diasRestantesTrial('premium', 'activo', '2026-11-10', '2026-11-10')).toBe(0);
  });
});
