import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guard contra el copy-paste que creo este bug.
 *
 * El lookup `usuarios` por `supabase_auth_id` estaba duplicado a mano en ~30
 * rutas y NINGUNA capturaba el `error`, asi que una lectura caida se le mostraba
 * al usuario como 401 "no eres tu" o 404 "no existes". El fix no es solo haber
 * arreglado las 30: es que la 31 no pueda nacer igual. Ahora todas pasan por
 * `requireNetoUser`, y este test falla si alguien vuelve a escribir el lookup a
 * mano en una ruta.
 *
 * Si este test falla en una ruta nueva, la respuesta casi siempre es usar
 * `requireNetoUser` (o `findNetoUser` si no tener fila es un caso valido), no
 * agregar la ruta a la lista de abajo.
 */

const LOOKUP = /\.eq\(\s*['"]supabase_auth_id['"]/;

/**
 * Unica excepcion, y con motivo: en el onboarding "no hay fila en `usuarios`" es
 * el caso NORMAL (el usuario todavia no vinculo su WhatsApp), asi que no puede
 * responder 404 y no encaja en `requireNetoUser`. Hace sus lecturas a mano pero
 * SI captura el `error` — lo que este test exige mas abajo.
 *
 * `src/app/auth/callback/route.ts` tampoco puede usar el helper (la cookie de
 * sesion todavia vive en la respuesta, no en `cookies()`), pero esta fuera de
 * `src/app/api/` y por eso no lo alcanza este barrido; su manejo de error esta
 * comentado en el propio archivo.
 */
const EXCEPCIONES = new Set(['api/onboarding/route.ts']);

const API_DIR = join(process.cwd(), 'src', 'app', 'api');

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) return archivosTs(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const rutas = archivosTs(API_DIR).map((full) => ({
  rel: relative(join(process.cwd(), 'src', 'app'), full).replace(/\\/g, '/'),
  contenido: readFileSync(full, 'utf-8'),
}));

describe('lookups de `usuarios` en las rutas de API', () => {
  it('encuentra rutas para revisar (el barrido no puede quedar vacio en silencio)', () => {
    expect(rutas.length).toBeGreaterThan(30);
  });

  it('ninguna ruta hace el lookup a mano — todas pasan por requireNetoUser', () => {
    const aMano = rutas
      .filter((r) => LOOKUP.test(r.contenido))
      .map((r) => r.rel)
      .filter((rel) => !EXCEPCIONES.has(rel));

    expect(aMano).toEqual([]);
  });

  it('las excepciones capturan el `error` de cada lectura que hacen', () => {
    for (const rel of EXCEPCIONES) {
      const ruta = rutas.find((r) => r.rel === rel);
      expect(ruta, `${rel} ya no existe: actualiza la lista de excepciones`).toBeDefined();
      // Toda lectura que termina en `.maybeSingle()` tiene que desestructurar
      // `error`. Sin eso, "la lectura se cayo" se ve igual que "no hay fila" —
      // que es exactamente el bug que esta sesion cerro.
      const sinCapturar = [
        ...ruta!.contenido.matchAll(/const \{([^}]*)\} = await[\s\S]*?\.maybeSingle\(\);/g),
      ]
        .filter((m) => !/\berror\b/.test(m[1]))
        .map((m) => m[1].trim());

      expect(sinCapturar, `${rel} tiene lecturas que se comen el error`).toEqual([]);
    }
  });
});
