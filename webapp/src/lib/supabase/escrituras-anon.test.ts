import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Ninguna API route ESCRIBE con el cliente anon. Hermano de `auth-callsites` y
 * `lectura-callsites`, y nace del mismo modo de falla que los tres vigilan: la ruta que se
 * escribió copiando el patrón equivocado.
 *
 * EL DEFECTO (D7, auditoría 10-ago-2026). `POST /api/goals/[id]/abandon` era la única ruta de
 * /api/goals que escribía con `createClient()` (anon, RLS aplica). `metas_ahorro` tiene policy
 * de SELECT y nada más —igual que casi todas las tablas de este proyecto, donde la autorización
 * vive en el código y no en RLS— así que el UPDATE matcheaba 0 filas y la ruta devolvía 400
 * SIEMPRE. Medido contra prod antes del fix: la meta quedaba en `active`.
 *
 * Lo que hace peligroso a este bug es que se ve como "nadie usa esa función": prod tenía 0 de
 * 13 metas en `abandoned`, que es consistente tanto con el bug como con el desuso. Un guard
 * estático lo dice sin depender de que alguien mire una métrica.
 *
 * OJO CON EL COROLARIO: escribir con service-role NO es gratis. `getServiceClient` ignora RLS,
 * así que la ruta tiene que filtrar por dueño EN EL MISMO STATEMENT (`.eq('usuario_id', ...)`).
 * Eso lo vigila el barrido de IDOR (`qa-e2e/qa-idor-cross-user.mjs`), no este test.
 */

const API = join(import.meta.dirname, '..', '..', 'app', 'api');
const ESCRITURAS = /\.(update|insert|upsert|delete)\(/;

function rutas(dir: string, out: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const p = join(dir, entrada);
    if (statSync(p).isDirectory()) rutas(p, out);
    else if (/\.tsx?$/.test(entrada) && !/\.test\.tsx?$/.test(entrada)) out.push(p);
  }
  return out;
}

/**
 * Los identificadores ligados a `await createClient()` en un archivo. Es el cliente anon: el
 * de `@/lib/supabase/server`, que respeta RLS con la sesión del usuario.
 */
function clientesAnon(src: string): string[] {
  if (!/from\s+'@\/lib\/supabase\/server'/.test(src)) return [];
  return [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+createClient\(\)/g)].map((m) => m[1]);
}

/**
 * Las sentencias que arrancan en `<ident>.from(` — el encadenado de PostgREST vive en una sola
 * sentencia, así que cortar en el `;` alcanza para no mezclar dos queries. El tope de 800
 * chars es una cota de seguridad por si falta el `;`, no la forma de cortar.
 */
function sentenciasDe(src: string, ident: string): string[] {
  const re = new RegExp(ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\r?\\n?\\s*\\.from\\(', 'g');
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    const resto = src.slice(m.index, m.index + 800);
    const fin = resto.indexOf(';');
    out.push(fin >= 0 ? resto.slice(0, fin) : resto);
  }
  return out;
}

describe('el cliente anon no escribe en ninguna API route', () => {
  const archivos = rutas(API);

  it('el barrido ve las rutas y encuentra clientes anon (anti-vacuidad)', () => {
    // Las dos cotas se sostienen solas y no dependen de que el defecto exista: si el walk se
    // rompe, o si nadie usa ya `createClient` en `api/`, este test dejaría de significar algo
    // y hay que enterarse acá y no en producción.
    expect(archivos.length, 'el barrido no encontró rutas bajo app/api').toBeGreaterThan(40);
    const conAnon = archivos.filter((f) => clientesAnon(readFileSync(f, 'utf8')).length > 0);
    expect(conAnon.length, 'ninguna ruta usa createClient: el guard vigila el vacío')
      .toBeGreaterThan(0);
  });

  it('ninguna ruta hace update/insert/upsert/delete sobre el cliente anon', () => {
    const infractores: string[] = [];
    for (const f of archivos) {
      const src = readFileSync(f, 'utf8');
      for (const ident of clientesAnon(src)) {
        for (const s of sentenciasDe(src, ident)) {
          if (ESCRITURAS.test(s)) {
            infractores.push(relative(API, f).replace(/\\/g, '/') + ' → ' + s.replace(/\s+/g, ' ').slice(0, 120));
          }
        }
      }
    }

    expect(
      infractores,
      'Estas rutas escriben con el cliente anon:\n' + infractores.map((i) => '  - ' + i).join('\n') +
      '\n\nEn este proyecto la autorización vive en el código, no en RLS: la mayoría de las ' +
      'tablas solo tienen policy de SELECT (o deny-all a propósito, migración 033), así que un ' +
      'UPDATE con el cliente anon matchea 0 filas y la ruta falla SIEMPRE — sin ruido, porque ' +
      'se ve igual que una feature que nadie usa (D7).\n' +
      'Usá `getServiceClient()` y filtrá por dueño EN EL MISMO statement: sin RLS debajo, ese ' +
      '`.eq(\'usuario_id\', ...)` es toda la autorización que hay.',
    ).toEqual([]);
  });
});
