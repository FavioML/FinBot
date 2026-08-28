import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * NADIE clasifica comercialmente con `plan === 'premium'` en el panel admin.
 *
 * Bajo el modelo de trial, durante la prueba `plan` vale `'premium'` A PROPÓSITO (migración
 * 052): es lo que hace que los ~40 sitios que miran esa columna entreguen Pro sin tocarse. La
 * consecuencia es que **`plan === 'premium'` ya no significa "paga"**, y usarlo para etiquetar o
 * contar miente en las dos direcciones: los que prueban se ven idénticos a los que pagan, y
 * "Free" colapsa tres poblaciones cuyas acciones son OPUESTAS (activar / cobrar / recuperar).
 *
 * Esto se arregló en `/admin/users` el 27-ago-2026 (commit 1f02357) y **la corrección no llegó a
 * `/admin/operacion`**, porque el panel tiene DOS tablas de usuarios y sólo se tocó una. Durante
 * un día la misma app dijo 2 y ~30 pagadores en dos pantallas distintas, y la que se mira a
 * diario era la equivocada. Este archivo existe para que la tercera pantalla no repita la
 * historia.
 *
 * El guard es de CLASE y con lista NEGRA de carpetas: una pantalla admin nueva entra sola. Con
 * lista blanca, un directorio nuevo quedaría invisible — la misma lección que los
 * `watchPatterns` de `railway.json`.
 */

const ADMIN = path.join(process.cwd(), 'src', 'app', 'admin');

/**
 * Usos LEGÍTIMOS de `plan` en el panel, con su porqué. Cada entrada es una decisión, no una
 * excepción de trámite: si crece sin motivo, el guard deja de significar algo.
 *
 * La clave es `<archivo relativo>:<cantidad>` — el conteo va fijado a propósito, para que
 * agregar un uso nuevo al mismo archivo rompa el build en vez de heredar la exención.
 */
const EXENTOS = new Map<string, { usos: number; motivo: string }>([
  ['operacion/page.tsx', {
    usos: 2,
    motivo:
      'Los DOS son sobre la capability, no sobre quién paga. (1) El menú de acciones (`isPro`) ' +
      'decide qué ACCIÓN ofrecer, y `set_plan` prende o apaga justamente `plan`: a alguien en ' +
      'prueba no se le ofrece "Activar Pro" porque ya lo tiene. (2) El toast que confirma esa ' +
      'acción describe el flag que acaba de cambiar. Lo que NO puede usar `plan` es la ETIQUETA, ' +
      'el CONTEO y el FILTRO — los tres mentían acá hasta el 28-ago-2026.',
  }],
]);

/**
 * Quita comentarios y strings de JSX antes de barrer. Sin esto el guard cuenta las
 * EXPLICACIONES: los comentarios que dicen "decía `plan === 'premium'`" para justificar por
 * qué se dejó de usar. Es la forma más tonta de romper un guard — señala como culpable justo
 * al comentario que documenta el arreglo, y obliga a declarar exenciones fantasma.
 */
function sinComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // bloque, incluidos los {/* … */} de JSX
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // de línea, sin comerse el // de una URL
}

/** `plan === 'premium'` en cualquiera de sus formas de escritura habituales. */
const CLASIFICA_POR_PLAN = /\bplan\s*(?:===|!==|==|!=)\s*['"`]premium['"`]|['"`]premium['"`]\s*(?:===|!==|==|!=)\s*[\w.]*\bplan\b/g;

function archivos(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...archivos(p));
    else if (e.endsWith('.tsx') || (e.endsWith('.ts') && !e.endsWith('.test.ts'))) out.push(p);
  }
  return out;
}

const FUENTES = archivos(ADMIN).map((p) => ({
  rel: path.relative(ADMIN, p).split(path.sep).join('/'),
  src: sinComentarios(readFileSync(p, 'utf8')),
}));

describe('el panel admin no clasifica quién PAGA mirando `plan`', () => {
  it('el barrido ve las pantallas de verdad (antivacuidad)', () => {
    // Sin esto, un `archivos()` roto devuelve [] y todo el bloque pasa afirmando sobre nada.
    expect(FUENTES.length).toBeGreaterThan(3);
    expect(FUENTES.map((f) => f.rel)).toContain('operacion/page.tsx');
    expect(FUENTES.map((f) => f.rel)).toContain('users/page.tsx');
  });

  it('los comentarios NO cuentan, y el código SÍ (control del strip)', () => {
    // Un strip demasiado ancho es peor que ninguno: deja de ver el código real y el guard
    // pasa en verde. Se afirman las dos direcciones.
    const cuenta = (t: string) => (sinComentarios(t).match(CLASIFICA_POR_PLAN) || []).length;
    expect(cuenta("// antes decía plan === 'premium' y mentía")).toBe(0);
    expect(cuenta("/* plan === 'premium' */")).toBe(0);
    expect(cuenta("{/* plan === 'premium' en JSX */}")).toBe(0);
    expect(cuenta("const x = u.plan === 'premium';")).toBe(1);
    // Una URL no es un comentario de línea.
    expect(cuenta("const u = 'https://x.pe'; const y = p.plan === 'premium';")).toBe(1);
  });

  it('el detector reconoce las formas de escribirlo (control)', () => {
    // Sin este control, un regex roto pone en verde el test de abajo sin ver una sola línea.
    const cuenta = (t: string) => (t.match(CLASIFICA_POR_PLAN) || []).length;
    expect(cuenta("const isPro = user.plan === 'premium';")).toBe(1);
    expect(cuenta('{u.plan !== "premium" && <Free />}')).toBe(1);
    expect(cuenta("if ('premium' === u.plan) {}")).toBe(1);
    // Y no inventa: mirar el plan sin compararlo con premium es legítimo en todos lados.
    expect(cuenta('const p = u.plan;')).toBe(0);
    expect(cuenta("estadoComercial(u) === 'pro_pagado'")).toBe(0);
  });

  it('cada uso de `plan === premium` está declarado, con su conteo exacto', () => {
    const encontrados = FUENTES
      .map((f) => ({ rel: f.rel, usos: (f.src.match(CLASIFICA_POR_PLAN) || []).length }))
      .filter((f) => f.usos > 0);

    const problemas: string[] = [];
    for (const { rel, usos } of encontrados) {
      const dec = EXENTOS.get(rel);
      if (!dec) {
        problemas.push(
          `${rel}: ${usos} uso(s) de \`plan === 'premium'\` sin declarar. Durante el trial esa ` +
          'comparación vale true, así que como etiqueta o como conteo MIENTE. Usá ' +
          '`estadoComercial()` de @/lib/admin-user-segments, o declaralo en EXENTOS con el porqué.',
        );
      } else if (dec.usos !== usos) {
        problemas.push(
          `${rel}: declarados ${dec.usos} usos, encontrados ${usos}. Un uso nuevo NO hereda la ` +
          `exención del anterior — el motivo declarado es: "${dec.motivo}"`,
        );
      }
    }
    expect(problemas).toEqual([]);
  });

  it('no hay exenciones fantasma', () => {
    // Una exención que ya no corresponde a nada le dice a la próxima lectura que ahí hay una
    // decisión viva, y esconde que el problema se resolvió.
    const conUsos = new Set(
      FUENTES.filter((f) => (f.src.match(CLASIFICA_POR_PLAN) || []).length > 0).map((f) => f.rel),
    );
    expect([...EXENTOS.keys()].filter((k) => !conUsos.has(k))).toEqual([]);
  });

  it('las DOS tablas de usuarios clasifican por el mismo motor', () => {
    // El bug no fue escribir mal la regla: fue arreglarla en una pantalla y no en la otra. Lo
    // que impide que se separen de nuevo es que las dos importen la misma fuente.
    for (const rel of ['operacion/page.tsx', 'users/page.tsx']) {
      const f = FUENTES.find((x) => x.rel === rel)!;
      expect(f.src, `${rel} dejó de usar el motor compartido`).toMatch(/\bestadoComercial\s*\(/);
      expect(f.src, `${rel} no importa admin-user-segments`).toMatch(/from '@\/lib\/admin-user-segments'/);
    }
  });
});
