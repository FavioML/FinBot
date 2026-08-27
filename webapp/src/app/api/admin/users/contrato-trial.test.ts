import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El bug que este archivo existe para que no vuelva (27-ago-2026).
 *
 * `route.ts` traía `trial_estado` y `trial_vence` en su `.select(...)` desde que se creó el
 * trial, y las TIRABA al armar la respuesta. O sea que el panel admin no tenía con qué
 * distinguir a quien está probando de quien paga, y pintaba `plan === 'premium' ? 'Pro' :
 * 'Free'` sobre un modelo donde durante la prueba `plan` vale 'premium' a propósito.
 *
 * Ningún tipo puede atrapar eso: la ruta arma un objeto literal, no un `AdminUser`. Y ningún
 * test de `estadoComercial` tampoco — con el campo ausente, `esProPagado('premium', undefined)`
 * da true y los 28 usuarios en prueba vuelven a contarse como pagadores, **en silencio y hacia
 * el lado optimista**, que es la peor dirección para un número de negocio.
 *
 * Por eso se verifican las DOS regiones por separado: leerlas de la base no sirve de nada si no
 * salen, y devolverlas no compila si no se leyeron.
 */
describe('GET /api/admin/users devuelve el estado comercial', () => {
  const src = readFileSync(join(__dirname, 'route.ts'), 'utf8');
  const CAMPOS = ['trial_estado', 'trial_vence'] as const;

  // El corte entre "lo que se le pide a Postgres" y "lo que se le devuelve al panel".
  const iMap = src.indexOf('const result = (usuarios || []).map');
  const seleccion = src.slice(0, iMap);
  const respuesta = src.slice(iMap);

  it('el corte entre select y map existe (si no, este guard estaría midiendo el aire)', () => {
    // Sin esta comprobación, un refactor que renombre el `map` deja las dos regiones en
    // "todo el archivo" y "nada", y las aserciones de abajo pasarían mirando el select dos
    // veces. Un guard que no sabe dónde está partiendo no está partiendo.
    expect(iMap).toBeGreaterThan(0);
    expect(respuesta).toContain('return NextResponse.json');
  });

  for (const campo of CAMPOS) {
    it(`${campo} se lee de la base`, () => {
      expect(seleccion).toContain(campo);
    });

    it(`${campo} sale en la respuesta, no solo en el select`, () => {
      // La forma que decide es la propiedad del objeto que se devuelve (`campo:`), no la
      // mención suelta: `trial_estado` dentro del string del `.select()` ya estaba ahí el día
      // del bug, y el panel seguía ciego.
      expect(respuesta).toContain(campo + ': u.' + campo);
    });
  }
});
