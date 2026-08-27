import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resumenNotificaciones } from './notificaciones-resumen';

/**
 * Dos perímetros, y el segundo es el que de verdad importa.
 *
 * El defecto que originó este archivo no vivía en un lugar: el panel de la campana se sirve
 * desde DOS rutas —`api/notifications/inbox` y el fast-path `api/dashboard`, que siembra la
 * misma clave de React Query— y las dos listaban con `.limit(20)`. Arreglar una y no la otra
 * deja la mitad de las aperturas midiendo censurado, y desde afuera se ve idéntico.
 *
 * Por eso el barrido de abajo NO lleva una lista de archivos: la deriva del árbol de rutas. Una
 * tercera ruta que lea `notificaciones` con un techo entra al perímetro sola.
 */

const API_DIR = join(process.cwd(), 'src', 'app', 'api');

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) return archivosTs(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

/**
 * Una LECTURA capada de `notificaciones`: la sentencia que arranca en `from('notificaciones')`
 * y que trae `.select(` y `.limit(`.
 *
 * **Dónde termina la sentencia importa, y la primera versión de esto se equivocaba.** Cortaba
 * en el siguiente `;`, y dentro de un `Promise.all([...])` el `;` recién aparece al cerrar el
 * arreglo entero — o sea que el "trozo" se comía las otras once queries de `api/dashboard`,
 * varias con su propio `.limit(`. El guard daba verde/rojo correcto por el motivo equivocado:
 * lo comprobó un control que des-capó la lista del dashboard y el barrido lo siguió contando
 * como capado. Por eso ahora corta también en una `,` a profundidad cero, que es como se
 * separan los elementos de un `Promise.all`.
 *
 * Se mira la sentencia y no el archivo entero por la razón opuesta: filtrando por archivo, el
 * guard acusaba a `api/debts/join/route.ts`, que solo INSERTA un aviso y tiene un `.limit(1)`
 * sin relación, sobre otra tabla, 80 líneas más arriba. Un guard que acusa a quien no puede
 * arreglarlo enseña a agregar excepciones.
 *
 * El conteo `select('id', { count: 'exact', head: true })` no entra, y está bien: no lleva
 * `.limit(`, o sea que ya es exacto por construcción. Es justamente la mitad que contaba bien.
 */
function sentenciasDeNotificaciones(src: string): string[] {
  const marca = "from('notificaciones')";
  const salida: string[] = [];
  for (let i = src.indexOf(marca); i !== -1; i = src.indexOf(marca, i + 1)) {
    let profundidad = 0;
    let fin = src.length;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (c === '(' || c === '[' || c === '{') profundidad++;
      else if (c === ')' || c === ']' || c === '}') profundidad--;
      else if (c === ';' || (c === ',' && profundidad === 0)) { fin = j; break; }
      // Profundidad negativa = se cerró el paréntesis que contenía a la sentencia.
      if (profundidad < 0) { fin = j; break; }
    }
    salida.push(src.slice(i, fin));
  }
  return salida;
}

function leeCapado(src: string): boolean {
  return sentenciasDeNotificaciones(src).some((s) => s.includes('.select(') && s.includes('.limit('));
}

/** Rutas que leen filas de `notificaciones` con un techo, o sea que NO ven el universo. */
const RUTAS_CAPADAS = archivosTs(API_DIR)
  .map((full) => ({
    rel: relative(join(process.cwd(), 'src', 'app'), full).replace(/\\/g, '/'),
    src: readFileSync(full, 'utf-8'),
  }))
  .filter(({ src }) => leeCapado(src));

describe('quién puede contar la campana', () => {
  it('el barrido encuentra las rutas capadas (no puede quedar vacío en silencio)', () => {
    // Si el `.filter` dejara de matchear —renombre de tabla, otra forma de capar— el caso de
    // abajo pasaría sobre cero archivos y el guard entero sería decorativo.
    const rels = RUTAS_CAPADAS.map((r) => r.rel).sort();
    expect(rels.length).toBeGreaterThanOrEqual(2);
    // Se exige que ESTEN, no que sean las unicas: una ruta capada nueva y BIEN hecha no tiene
    // por que poner rojo el build — de eso ya se encarga el caso por ruta de abajo, que la
    // barre sola. Lo que este caso delata es que el perimetro se encoja: si el barrido deja de
    // ver alguna de las dos, o el filtro se rompio o alguien des-capo una lista de 786 filas.
    expect(rels).toEqual(
      expect.arrayContaining(['api/dashboard/route.ts', 'api/notifications/inbox/route.ts']),
    );
  });

  it.each(RUTAS_CAPADAS.map((r) => r.rel))('%s no deriva los totales de su lista capada', (rel) => {
    const { src } = RUTAS_CAPADAS.find((r) => r.rel === rel)!;
    // La única fuente exacta es la función de Postgres. Una ruta que lista con techo y NO la
    // llama solo puede estar contando lo que le cabe en la página.
    expect(src, `${rel} lista con .limit() y no pide el resumen exacto`).toMatch(
      /\bresumenNotificaciones\s*\(/,
    );
  });
});

/** Cliente mínimo: solo `.rpc(...).maybeSingle()`, que es todo lo que usa el helper. */
function clienteQueDevuelve(respuesta: { data: unknown; error: unknown }) {
  return {
    rpc: () => ({ maybeSingle: async () => respuesta }),
  } as unknown as SupabaseClient;
}

describe('resumenNotificaciones', () => {
  it('devuelve el total y los tipos exactos', async () => {
    const r = await resumenNotificaciones(
      clienteQueDevuelve({ data: { total: 41, tipos: ['pro', 'sistema'] }, error: null }),
      'u1',
    );
    expect(r).toEqual({ total: 41, tipos: ['pro', 'sistema'] });
  });

  it('un `total` que vuelve como string sigue siendo número', async () => {
    // Hoy PostgREST devuelve el `bigint` como número JSON (medido contra prod el 27-ago), pero
    // el contrato del cliente no lo garantiza y `NUMERIC` sí vuelve string en este mismo
    // proyecto. Un `total` string se compara mal contra `listados` sin fallar en ningún lado.
    const r = await resumenNotificaciones(
      clienteQueDevuelve({ data: { total: '786', tipos: [] }, error: null }),
      'u1',
    );
    expect(r.total).toBe(786);
  });

  it('si la función falla devuelve null, no cero', async () => {
    // supabase-js NUNCA lanza. Sin este mapeo, un fallo se leería como "usuario sin avisos" y
    // el análisis quedaría sesgado hacia abajo sin ninguna señal de que faltó una medición.
    const r = await resumenNotificaciones(
      clienteQueDevuelve({ data: null, error: { message: 'boom' } }),
      'u1',
    );
    expect(r).toEqual({ total: null, tipos: null });
  });

  it('si la llamada REVIENTA tampoco tumba a quien la pidió', async () => {
    // `api/dashboard` corre todas sus queries en un `Promise.all`: una excepción acá no
    // devolvería un campo vacío, devolvería un 500 en el único request del que arranca toda
    // la app. Un dato de telemetría no puede tener ese poder.
    const revienta = { rpc: () => ({ maybeSingle: async () => { throw new Error('ECONNRESET'); } }) };
    const r = await resumenNotificaciones(revienta as unknown as SupabaseClient, 'u1');
    expect(r).toEqual({ total: null, tipos: null });
  });

  it('el usuario sin avisos da 0 y lista vacía', async () => {
    const r = await resumenNotificaciones(clienteQueDevuelve({ data: { total: 0, tipos: [] }, error: null }), 'u1');
    expect(r).toEqual({ total: 0, tipos: [] });
  });
});
