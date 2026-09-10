import { describe, it, expect } from 'vitest';
import {
  ORIGEN_CTA_WEB,
  ORIGEN_DIRECTO,
  atribucionDelAlta,
  origenDeLaUrl,
  sanearOrigen,
} from './atribucion';

/**
 * El saneado es la mitad que protege la CUENTA, no solo la atribución: lo que sale de acá va a un
 * INSERT sobre `usuarios` con `usuarios_origen_largo_chk (<= 40)`, y si ese CHECK falla no se
 * pierde un dato de marketing, se pierde el alta entera (el callback cae a /onboarding).
 */
describe('sanearOrigen — la misma regla que la landing', () => {
  it.each([
    ['Instagram', 'instagram'],
    ['  chatgpt.com  ', 'chatgpt.com'],
    ['ig_bio-2026', 'ig_bio-2026'],
    ['face book', 'facebook'],
    ['[hero|ig]', 'heroig'],
    ['ñandú', 'and'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('%j → %j', (entrada, salida) => {
    expect(sanearOrigen(entrada)).toBe(salida);
  });

  it('nunca pasa de 40, que es lo que exige el CHECK', () => {
    expect(sanearOrigen('a'.repeat(500))).toHaveLength(40);
  });
});

describe('origenDeLaUrl', () => {
  it('lee solo utm_source', () => {
    expect(origenDeLaUrl(new URLSearchParams('utm_source=IG&utm_medium=bio'))).toBe('ig');
    expect(origenDeLaUrl(new URLSearchParams('utm_medium=bio&ref=ABCD1234'))).toBe('');
  });
});

describe('atribucionDelAlta — el par que se escribe en la fila nueva', () => {
  it('con cookie: el canal de la cookie, y la puerta web', () => {
    expect(atribucionDelAlta('ig')).toEqual({ origen: 'ig', origen_cta: ORIGEN_CTA_WEB });
  });

  it('sin cookie es DIRECTO, nunca null: esta alta sí se midió', () => {
    // NULL en `origen` significa "alta anterior a la medición" (migración 084). Colapsar las dos
    // cosas es justo lo que haría ilegible el número que esto existe para mover.
    expect(atribucionDelAlta(undefined)).toEqual({ origen: ORIGEN_DIRECTO, origen_cta: 'web' });
    expect(atribucionDelAlta(null).origen).toBe('directo');
    expect(atribucionDelAlta('').origen).toBe('directo');
  });

  it('re-sanea la cookie: la puede escribir cualquiera', () => {
    expect(atribucionDelAlta('IG; drop table').origen).toBe('igdroptable');
    expect(atribucionDelAlta('x'.repeat(200)).origen).toHaveLength(40);
    // Una cookie que no deja nada utilizable es lo mismo que no tenerla.
    expect(atribucionDelAlta('!!!').origen).toBe('directo');
  });
});
