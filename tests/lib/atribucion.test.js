import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * EL PARSER QUE CONVIERTE "SESIONES POR CANAL" EN "ALTAS POR CANAL".
 *
 * Lo que estos tests protegen no es un formato: es el único empalme que existe entre una visita a
 * neto.pe y un alta de Neto. El alta ocurre en WhatsApp, así que el primer mensaje —con la etiqueta
 * que los CTA de la landing ya inyectaban y nadie leía— es el único punto donde las dos mitades se
 * tocan. Si esto deja de parsear, las altas vuelven a no tener origen y nada más se rompe: ninguna
 * respuesta cambia, ningún usuario se queja. Por eso hace falta un test y no la observación.
 *
 * TRES GRUPOS, y el del medio es el que suele faltar:
 *
 *   1. la forma parsea lo que tiene que parsear (incluidos los links viejos, sin origen)
 *   2. la forma RECHAZA lo que no es una etiqueta — y acá importa por qué rechaza, no sólo que
 *      rechace: un negativo verde no es cobertura hasta saber que no pasa por otra condición
 *   3. las tres guardas de escritura, contra un doble de Supabase que registra lo que se le pide
 */

// ── Doble de Supabase ────────────────────────────────────────────────────────────────────────
// Registra la cadena completa, no sólo el patch: dos de las guardas de `registrarOrigenDelAlta`
// viven en los FILTROS (`.eq('id')` y `.is('origen', null)`), así que un doble que sólo capturara
// el `update()` daría verde con la carrera abierta. Es el hallazgo del ítem 23: un doble que
// devuelve lo mismo mire lo que mire hace pasar el bug que el arreglo existe para evitar.
const llamadas = [];
let respuesta = { data: [{ id: 'u-1' }], error: null };

// Se inyecta en `require.cache` en vez de `vi.mock` porque el módulo bajo prueba es CJS y se carga
// con `createRequire`, que no pasa por el interceptor de vitest. Es el mismo patrón que usan los
// tests de `tests/cron/`.
const dbMock = {
  supabase: {
    from(tabla) {
      const reg = { tabla, filtros: [] };
      llamadas.push(reg);
      const cadena = {
        update(patch) { reg.patch = patch; return cadena; },
        eq(col, val) { reg.filtros.push(['eq', col, val]); return cadena; },
        is(col, val) { reg.filtros.push(['is', col, val]); return cadena; },
        select(cols) { reg.select = cols; return Promise.resolve(respuesta); },
      };
      return cadena;
    },
  },
};
// Los especificadores son RELATIVOS y se resuelven con `require.resolve`, sin aritmética de rutas.
// La primera versión derivaba la raíz del repo con `new URL(import.meta.url).pathname.slice(1)`:
// en Windows eso saca el `/` de `/C:/...` y queda bien, en Linux saca el `/` de `/home/...` y deja
// una ruta RELATIVA que `path.resolve` convierte en `<cwd>/home/runner/...`. Pasaba local y moría
// en CI, que es la forma más cara de equivocarse. Un `require.resolve('../../lib/db.js')` no tiene
// esa superficie: lo resuelve Node contra este archivo, igual en los dos sistemas.
for (const [rel, exports] of [
  ['../../lib/db.js', dbMock],
  ['../../lib/logger.js', { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }],
  ['../../lib/analytics.js', { capture: vi.fn() }],
  ['../../lib/error-monitor.js', { registrarError: vi.fn() }],
]) {
  const f = require.resolve(rel);
  require.cache[f] = { id: f, filename: f, loaded: true, exports };
}

const { parsearEtiquetaCta, registrarOrigenDelAlta } = require('../../lib/atribucion');

// **Antivacuidad del doble.** Si la inyección dejara de funcionar (un rename de `lib/db.js`, un
// cambio de forma en sus exports), el módulo hablaría con el cliente REAL, las llamadas no se
// registrarían y los tests de escritura fallarían con "undefined" en vez de decir por qué. Esto lo
// dice de frente.
it('el doble de Supabase está enganchado (si no, todo lo de abajo mide otra cosa)', async () => {
  llamadas.length = 0;
  await registrarOrigenDelAlta({ id: 'probe', origen: null, onboarding_completado: false }, '[hero|ig]');
  expect(llamadas, 'el mock de lib/db no se inyectó: revisá require.cache').toHaveLength(1);
});

beforeEach(() => {
  llamadas.length = 0;
  respuesta = { data: [{ id: 'u-1' }], error: null };
});

const nuevo = (extra = {}) => ({ id: 'u-1', origen: null, onboarding_completado: false, ...extra });

describe('parsearEtiquetaCta: lo que la landing manda', () => {
  it('lee posición y origen del CTA del hero', () => {
    expect(parsearEtiquetaCta('Hola Neto, quiero empezar [hero|ig] 👋'))
      .toEqual({ posicion: 'hero', origen: 'ig' });
  });

  it('un origen con punto (un hostname) entra entero', () => {
    // El caso real y el que más importa: ChatGPT es el canal que mejor convierte a CTA (47%) y
    // su `utm_source` es `chatgpt.com`. Un patrón sin el punto lo dejaría afuera justo a él.
    expect(parsearEtiquetaCta('Hola Neto, quiero activar Pro [pricing-pro|chatgpt.com] ⭐'))
      .toEqual({ posicion: 'pricing-pro', origen: 'chatgpt.com' });
  });

  it('RETROCOMPATIBLE: un link viejo sin origen sigue dando la posición', () => {
    // No es un caso hipotético: hay links con `[hero]` publicados en captions de Instagram y en
    // el cuerpo del blog, y `WA_LINK` (la constante que usan esos links) no pasa por el hook de
    // atribución. Si este caso devolviera null, esas altas quedarían sin NI la posición.
    expect(parsearEtiquetaCta('Hola Neto, quiero empezar [hero] 👋'))
      .toEqual({ posicion: 'hero', origen: null });
  });

  it('normaliza a minúsculas las dos mitades', () => {
    expect(parsearEtiquetaCta('[Hero|IG]')).toEqual({ posicion: 'hero', origen: 'ig' });
  });

  it('las seis posiciones que la landing publica hoy parsean', () => {
    // Antivacuidad del grupo: si el patrón se volviera más estricto (por ejemplo exigiendo que la
    // posición no tenga guiones), los dos `pricing-*` morirían y los otros cuatro lo taparían.
    for (const p of ['hero', 'navbar', 'sticky', 'final', 'pricing-free', 'pricing-pro']) {
      expect(parsearEtiquetaCta(`Hola Neto, quiero empezar [${p}|ig] 👋`))
        .toEqual({ posicion: p, origen: 'ig' });
    }
  });
});

describe('parsearEtiquetaCta: lo que NO es una etiqueta', () => {
  // Cada caso dice QUÉ lo rechaza. Sin eso un negativo verde no prueba cobertura: podría estar
  // cayendo por una condición distinta de la que se cree estar midiendo.
  const rechazos = [
    ['gasté 50 en [el mercado]',        'tiene un espacio adentro'],
    ['[Hola mundo]',                    'tiene un espacio adentro'],
    ['[2gastos]',                       'empieza con dígito: la posición exige letra inicial'],
    ['[]',                              'vacío'],
    ['[a]',                             'un solo carácter: el mínimo es 2'],
    ['sin corchetes de ningún tipo',    'no hay corchetes'],
    ['[hero|]',                         'el separador sin origen detrás'],
    ['[hero|ÑAM]',                      'el origen tiene caracteres fuera del juego permitido'],
  ];

  for (const [msg, porque] of rechazos) {
    it(`rechaza ${JSON.stringify(msg)} — ${porque}`, () => {
      expect(parsearEtiquetaCta(msg)).toBeNull();
    });
  }

  it('no lanza con entradas que no son texto', () => {
    for (const v of [null, undefined, '', 42, {}, []]) expect(parsearEtiquetaCta(v)).toBeNull();
  });

  /**
   * **EL LÍMITE DEL PARSER, ESCRITO EN VEZ DE DISIMULADO.** `[alquiler]` tiene exactamente la forma
   * de una posición válida, así que el parser lo ACEPTA. No se arregla endureciendo el patrón —una
   * lista blanca de posiciones viviría acá y la verdad vive en el repo de la landing, que es la
   * divergencia que este workspace persigue— sino en la capa de arriba: `registrarOrigenDelAlta`
   * sólo escribe sobre un alta ABIERTA y sin origen previo, o sea que para que esto haga daño hace
   * falta que el PRIMER mensaje de un usuario nuevo sea una palabra sola entre corchetes. Y el daño
   * sería una etiqueta mal puesta en una fila, no una pérdida.
   */
  it('ACEPTA una palabra común en corchetes, y lo que acota el daño es la capa de arriba', () => {
    expect(parsearEtiquetaCta('pagué el [alquiler] ayer')).toEqual({ posicion: 'alquiler', origen: null });
  });
});

describe('registrarOrigenDelAlta: las tres guardas', () => {
  it('escribe origen y posición en un alta abierta', async () => {
    const u = nuevo();
    const r = await registrarOrigenDelAlta(u, 'Hola Neto, quiero empezar [hero|ig] 👋');

    expect(r).toEqual({ posicion: 'hero', origen: 'ig' });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].tabla).toBe('usuarios');
    expect(llamadas[0].patch).toEqual({ origen: 'ig', origen_cta: 'hero' });
    // Los dos filtros son parte del contrato: el `eq` acota el sujeto y el `is` cierra la carrera.
    expect(llamadas[0].filtros).toEqual([['eq', 'id', 'u-1'], ['is', 'origen', null]]);
    // Y se refleja en la fila en memoria, que es lo que lee el resto de este mismo mensaje.
    expect(u.origen).toBe('ig');
    expect(u.origen_cta).toBe('hero');
  });

  it('un link viejo sin origen se guarda como "directo", NO como null', async () => {
    // NULL significa "alta anterior a la medición". Esta alta SÍ se midió y el link no decía de
    // dónde. Colapsarlas haría ilegible el número que todo esto existe para mover.
    await registrarOrigenDelAlta(nuevo(), 'Hola Neto, quiero empezar [hero] 👋');
    expect(llamadas[0].patch).toEqual({ origen: 'directo', origen_cta: 'hero' });
  });

  it('NO toca un alta ya cerrada: un veterano que hoy clickea un CTA no se reetiqueta', async () => {
    // Ésta es la guarda que protege la serie. Las 100+ filas que ya existen tienen origen NULL; sin
    // ella, el primer clic de cualquiera de ellas las etiquetaría con la fecha de hoy y el número
    // de "altas con origen" quedaría contaminado justo cuando se empieza a leer.
    const r = await registrarOrigenDelAlta(nuevo({ onboarding_completado: true }), '[hero|ig]');
    expect(r).toBeNull();
    expect(llamadas).toHaveLength(0);
  });

  it('NO pisa un origen ya escrito: primer toque, no último', async () => {
    const r = await registrarOrigenDelAlta(nuevo({ origen: 'tiktok' }), '[hero|ig]');
    expect(r).toBeNull();
    expect(llamadas).toHaveLength(0);
  });

  it('sin etiqueta NO consulta nada: el camino caliente no paga una query', async () => {
    // Es la propiedad de costo, y es la que hace aceptable llamar a esto en cada mensaje de texto
    // de cada usuario. Si alguien invierte el orden de las guardas, esto se pone rojo.
    const r = await registrarOrigenDelAlta(nuevo(), 'gasté 50 soles en el almuerzo');
    expect(r).toBeNull();
    expect(llamadas).toHaveLength(0);
  });

  it('un UPDATE que no afectó filas (carrera) no es un éxito ni un fallo', async () => {
    respuesta = { data: [], error: null };
    const u = nuevo();
    expect(await registrarOrigenDelAlta(u, '[hero|ig]')).toBeNull();
    expect(u.origen).toBeNull();
  });

  it('un error de la base NO lanza y NO miente: devuelve null', async () => {
    // supabase-js nunca lanza: devuelve `{ error }`. Si este código no lo leyera, la atribución se
    // perdería en silencio y la fila en memoria quedaría diciendo que sí se guardó.
    respuesta = { data: null, error: { message: 'timeout' } };
    const u = nuevo();
    expect(await registrarOrigenDelAlta(u, '[hero|ig]')).toBeNull();
    expect(u.origen).toBeNull();
  });

  it('una excepción tampoco se escapa: el primer mensaje del usuario es más importante', async () => {
    // El call-site (`handlers/webhook.js`) hace `await` sin try/catch porque esta función se traga
    // sus propios fallos. Este test es lo que hace cierta esa afirmación.
    const u = nuevo();
    Object.defineProperty(u, 'onboarding_completado', { get() { throw new Error('boom'); } });
    await expect(registrarOrigenDelAlta(u, '[hero|ig]')).resolves.toBeNull();
  });

  it('no hace nada con un usuario sin id', async () => {
    expect(await registrarOrigenDelAlta(null, '[hero|ig]')).toBeNull();
    expect(await registrarOrigenDelAlta({}, '[hero|ig]')).toBeNull();
    expect(llamadas).toHaveLength(0);
  });
});

describe('los valores que salen caben en la columna', () => {
  // `usuarios.origen` y `origen_cta` tienen `CHECK (char_length <= 40)` (migración 084). Un valor
  // más largo no lanzaría: haría fallar el UPDATE, que es un fallo silencioso del lado de Postgres.
  // El patrón lo impide por construcción y esto lo fija.
  it('el patrón no puede producir un valor de más de 40 caracteres', () => {
    const largo = 'a'.repeat(200);
    expect(parsearEtiquetaCta(`[${largo}|${largo}]`)).toBeNull();
    const r = parsearEtiquetaCta(`[${'a'.repeat(24)}|${'b'.repeat(40)}]`);
    expect(r.posicion).toHaveLength(24);
    expect(r.origen).toHaveLength(40);
  });
});
