import { describe, it, expect } from 'vitest';
import {
  ORIGEN_CTA_WEB,
  ORIGEN_DIRECTO,
  ORIGEN_INVITACION,
  WA_INVITACION,
  atribucionDelAlta,
  origenDeEntrada,
  origenDeLaUrl,
  sanearOrigen,
  waLogin,
} from './atribucion';

/**
 * Copia de la FORMA del corchete de `app/lib/atribucion.js` (`ETIQUETA`), duplicada a propósito por
 * la misma razón que `sanearOrigen`: son dos CI. Si el formato cambia allá, esto se tiene que tocar
 * a la vez; que el backend DESPLEGADO lo lea lo prueba `qa-e2e/qa-atribucion-wa.mjs`.
 */
const ETIQUETA_BACKEND = /\[([a-z][a-z0-9-]{1,23})(?:\|([a-z0-9][a-z0-9._-]{0,39}))?\]/i;
const etiquetaDe = (href: string) => {
  const u = new URL(href);
  const m = (u.searchParams.get('text') || '').match(ETIQUETA_BACKEND);
  return { numero: u.pathname, posicion: m?.[1] ?? null, origen: m?.[2] ?? null };
};

describe('los links de WhatsApp de la webapp llevan el corchete del contrato', () => {
  it('/login con origen: [login|ig], saneado', () => {
    expect(etiquetaDe(waLogin('IG'))).toEqual({ numero: '/51933014505', posicion: 'login', origen: 'ig' });
  });

  it('/login sin origen: [login], que el backend guarda como directo (no NULL)', () => {
    expect(etiquetaDe(waLogin())).toEqual({ numero: '/51933014505', posicion: 'login', origen: null });
  });

  it('/join: [invitacion|invitacion]', () => {
    expect(etiquetaDe(WA_INVITACION)).toEqual({ numero: '/51933014505', posicion: 'invitacion', origen: 'invitacion' });
  });

  it('los espacios van como %20, no como + (WhatsApp no garantiza leer el +)', () => {
    expect(waLogin('ig')).not.toContain('+');
  });
});

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

describe('origenDeEntrada — la invitación es un canal aunque el link no traiga UTM', () => {
  it('en /join/* sin UTM es invitacion, en las cuatro formas de invitación', () => {
    for (const r of ['/join/space/ABC', '/join/meta/ABC', '/join/deuda/ABC', '/join/gasto/ABC']) {
      expect(origenDeEntrada(r, new URLSearchParams())).toBe(ORIGEN_INVITACION);
    }
  });

  it('un utm_source explícito gana sobre la ruta', () => {
    expect(origenDeEntrada('/join/space/ABC', new URLSearchParams('utm_source=IG'))).toBe('ig');
  });

  it('fuera de /join/ sin UTM no inventa nada (el callback escribirá directo)', () => {
    // Contraprueba de vacuidad del primer caso: si devolviera 'invitacion' siempre, esto muere.
    expect(origenDeEntrada('/', new URLSearchParams())).toBe('');
    expect(origenDeEntrada('/login', new URLSearchParams())).toBe('');
    expect(origenDeEntrada('/joinx', new URLSearchParams())).toBe('');
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
