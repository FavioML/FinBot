import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * P′3 de la auditoría del 10-ago: `obtenerCategoriasUsuario` hacía 1+N queries — las raíces,
 * y después UNA POR RAÍZ dentro de un `for`. Con 4.8 raíces de promedio (máx 21 en prod) eso
 * son 5-22 round-trips EN SERIE, y esta función cuelga del camino de cada gasto registrado
 * (la llama `detectarCategoriaIA`).
 *
 * Lo que estos tests fijan NO es "es rápido" sino el comportamiento observable: **una sola
 * query** y el mismo árbol agrupado, con el mismo orden. Revertir a la versión con `for`
 * mata el primero; equivocarse al agrupar mata los otros.
 */

// categories.js destructura `supabase` al cargar, así que hay que reemplazarlo ANTES de requerir.
const filas = { rows: [] };
const llamadas = { from: 0, filtros: [], inserts: [] };
// Lo que devuelve el próximo insert en `error`. Supabase NO lanza: reporta acá.
const errorInsert = { value: null };

// Una cadena NUEVA por `from()`, que aplica sus PROPIOS filtros sobre `filas.rows`. Hace falta
// que sea por-cadena y no compartida: `asegurarCategoriaUsuario` consulta dos veces con filtros
// distintos (el árbol entero, y después una raíz por nombre), y con una cadena única que
// devuelve todo siempre, la búsqueda por nombre encontraría cualquier fila y el insert nunca
// ocurriría — el test pasaría verde sin poder fallar.
function nuevaCadena() {
  const propios = [];
  const c = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit', 'neq', 'not', 'gte', 'lte', 'ilike']) {
    c[m] = vi.fn((...args) => { llamadas.filtros.push([m, ...args]); propios.push([m, ...args]); return c; });
  }
  let esInsert = false;
  c.insert = vi.fn((payload) => {
    const filasNuevas = Array.isArray(payload) ? payload : [payload];
    llamadas.inserts.push(...filasNuevas);
    esInsert = true;
    // Las filas insertadas quedan VISIBLES para las lecturas siguientes, como en la DB real.
    // Sin esto, `crearSubcategoriaLibreUsuario` —que crea el padre y después lo busca— no lo
    // encontraría nunca, y el test no podría distinguir ese bug de un mock incompleto.
    if (!errorInsert.value) {
      for (const f of filasNuevas) {
        filas.rows.push({ id: 'gen-' + (filas.rows.length + 1), padre_id: null, activa: true, ...f });
      }
    }
    return c;
  });
  c.then = (onF, onR) => {
    if (esInsert) return Promise.resolve({ data: null, error: errorInsert.value }).then(onF, onR);
    let data = filas.rows;
    for (const [m, col, val] of propios) {
      if (m === 'eq') data = data.filter(r => r[col] === val);
      else if (m === 'is' && val === null) data = data.filter(r => !r[col]);
    }
    return Promise.resolve({ data, error: null }).then(onF, onR);
  };
  return c;
}

require('../../lib/db').supabase = {
  from: vi.fn(() => { llamadas.from++; return nuevaCadena(); }),
};

const warn = vi.fn();
require('../../lib/logger').warn = warn;

const crearCompletion = vi.fn().mockResolvedValue({
  choices: [{ message: { content: '{"categoria":"Transporte","subcategoria":"taxi"}' } }],
});
require('../../lib/ai').openai = { chat: { completions: { create: crearCompletion } } };

const { obtenerCategoriasUsuario, detectarCategoriaIA, asegurarCategoriaUsuario, crearSubcategoriaLibreUsuario } = require('../../services/categories');
const { CATEGORIAS_SUGERIDAS } = require('../../lib/constants');

const raiz = (id, nombre) => ({ id, nombre, padre_id: null, activa: true, usuario_id: 'u1' });
const sub = (id, nombre, padreId) => ({ id, nombre, padre_id: padreId, activa: true, usuario_id: 'u1' });

// El prompt COMPLETO que se le mandó al modelo en la última llamada (system + user).
const promptEnviado = () => crearCompletion.mock.calls[0][0].messages.map(m => m.content).join('\n');

beforeEach(() => {
  llamadas.from = 0;
  llamadas.filtros.length = 0;
  llamadas.inserts.length = 0;
  errorInsert.value = null;
  filas.rows = [];
  warn.mockClear();
  crearCompletion.mockClear();
});

/**
 * B26: el árbol propio del usuario SUSTITUÍA al canónico en el prompt, así que quien eligió
 * pocas categorías en el onboarding quedaba encerrado — un taxi caía en "Finanzas" porque
 * "Transporte" no estaba en su lista.
 *
 * Estos tests afirman sobre el prompt que EFECTIVAMENTE viaja al SDK, no sobre una variable
 * intermedia. Hasta acá no había ni uno: `categorias-una-query.test.js` cubría el AbortSignal y
 * la forma de retorno, y por eso el bug pasó por delante de la suite sin despeinarla.
 */
describe('detectarCategoriaIA — qué lista viaja en el prompt', () => {
  const CANONICAS = CATEGORIAS_SUGERIDAS.map(c => c.nombre);

  it('con árbol propio de 2 raíces, las 11 canónicas viajan IGUAL', async () => {
    filas.rows = [raiz('r-ali', 'Alimentación'), raiz('r-fin', 'Finanzas')];
    await detectarCategoriaIA('gasté 10.5 en taxi', 'u1');

    const prompt = promptEnviado();
    // ⚠️ Esto muere si alguien vuelve a la bifurcación excluyente: el usuario encerrado.
    for (const nombre of CANONICAS) {
      expect(prompt, 'falta la canónica ' + nombre).toContain(nombre);
    }
    expect(prompt).toContain('Transporte');
  });

  it('las categorías propias siguen viajando, y con la regla de prioridad', async () => {
    filas.rows = [raiz('r-via', 'Viajes'), sub('s-1', 'vuelos', 'r-via')];
    await detectarCategoriaIA('gasté 300 en el vuelo a Cusco', 'u1');

    const prompt = promptEnviado();
    expect(prompt).toContain('CATEGORÍAS CUSTOM DEL USUARIO (PRIORIDAD SOBRE CANÓNICAS)');
    expect(prompt).toContain('- Viajes → vuelos');
    expect(prompt).toContain('Solo cae a categoría canónica si NINGUNA custom encaja');
    // El bloque se redacta para un GASTO, no para un correo: es el mismo helper con otro sujeto.
    expect(prompt).toContain('el contexto del gasto');
    expect(prompt).not.toContain('el contexto del correo');
    // ⚠️ Y NO trae la regla que CIERRA las subcategorías. El system prompt de este clasificador
    // dice lo contrario tres líneas antes ("usa ese nombre exacto aunque no esté en la lista");
    // como el bloque se concatena al final, la restrictiva ganaría y los usuarios con árbol
    // propio dejarían de poder estrenar subcategorías nombrándolas.
    expect(prompt).toContain('usa ese nombre exacto aunque no este en la lista');
    expect(prompt).not.toContain('si no hay match exacto, usar "sin_categoria"');
  });

  it('sin árbol propio no se inventa un bloque de custom vacío', async () => {
    filas.rows = [];
    await detectarCategoriaIA('gasté 10 en pan', 'u1');

    const prompt = promptEnviado();
    expect(prompt).not.toContain('CATEGORÍAS CUSTOM DEL USUARIO');
    for (const nombre of CANONICAS) expect(prompt).toContain(nombre);
  });
});

/**
 * La otra mitad de B26: que el árbol CREZCA. Sin esto el gasto se clasifica bien pero
 * "Transporte" no aparece en `/categorias` ni en el selector de presupuestos, que leen
 * `categorias_usuario`.
 */
describe('asegurarCategoriaUsuario', () => {
  it('agrega la canónica que le falta al usuario con árbol propio', async () => {
    filas.rows = [raiz('r-ali', 'Alimentación'), raiz('r-fin', 'Finanzas')];
    expect(await asegurarCategoriaUsuario('u1', 'Transporte')).toBe('creada');

    expect(llamadas.inserts).toHaveLength(1);
    expect(llamadas.inserts[0]).toMatchObject({ usuario_id: 'u1', nombre: 'Transporte', activa: true });
    // El emoji sale del árbol canónico, no de un fallback genérico.
    const esperado = CATEGORIAS_SUGERIDAS.find(c => c.nombre === 'Transporte').emoji;
    expect(llamadas.inserts[0].emoji).toBe(esperado);
  });

  it('NO toca al usuario sin árbol propio, para no romper el menú de /categorias', async () => {
    // `webhook.js:626` y `:773` ramifican por el `null` de `obtenerCategoriasUsuario` para
    // ofrecer el menú de onboarding. Crearle UNA fila lo convierte en una lista de un ítem.
    //
    // ⚠️ Se afirma el VEREDICTO, no solo el no-insert: sin la rama, `cats.some()` sobre `null`
    // lanza y el catch silencioso produce el mismo no-insert. Medido — con la aserción solo
    // sobre `inserts`, la mutación pasaba verde.
    filas.rows = [];
    expect(await asegurarCategoriaUsuario('u1', 'Transporte')).toBe('sin-arbol');
    expect(llamadas.inserts).toEqual([]);
  });

  it('no duplica una canónica que el usuario ya tiene', async () => {
    filas.rows = [raiz('r-tra', 'Transporte'), raiz('r-fin', 'Finanzas')];
    expect(await asegurarCategoriaUsuario('u1', 'Transporte')).toBe('ya-existe');
    expect(llamadas.inserts).toEqual([]);
  });

  it('resuelve el alias a la canónica antes de decidir (no crea "Alimentacion" sin tilde)', async () => {
    filas.rows = [raiz('r-ali', 'Alimentación')];
    expect(await asegurarCategoriaUsuario('u1', 'Alimentacion')).toBe('ya-existe');
    expect(llamadas.inserts).toEqual([]);
  });

  it('sigue creando las categorías libres cuando el usuario tiene árbol', async () => {
    filas.rows = [raiz('r-ali', 'Alimentación')];
    expect(await asegurarCategoriaUsuario('u1', 'Comida_Casera')).toBe('libre');
    expect(llamadas.inserts.some(i => i.nombre === 'Comida_Casera')).toBe(true);
  });

  it('la regla "sin árbol no se le inventa uno" vale también para las LIBRES', async () => {
    // Con la comprobación solo del lado canónico, un primer gasto en "Comida_Casera" le
    // estrenaba un árbol de UNA raíz: el usuario encerrado que este trabajo viene a evitar.
    filas.rows = [];
    expect(await asegurarCategoriaUsuario('u1', 'Comida_Casera')).toBe('sin-arbol');
    expect(llamadas.inserts).toEqual([]);
  });

  it('un colapso CON PÉRDIDA no se trata como canónico: "Viajes" no se convierte en "Otros"', async () => {
    // `CATEGORIA_MAP` mezcla alias ortográficos con colapsos semánticos. Quien pide "Viajes"
    // tenía su categoría Viajes; darle "Otros" es una regresión de producto.
    filas.rows = [raiz('r-ali', 'Alimentación')];
    expect(await asegurarCategoriaUsuario('u1', 'Viajes')).toBe('libre');
    expect(llamadas.inserts.some(i => i.nombre === 'Viajes')).toBe(true);
    expect(llamadas.inserts.some(i => i.nombre === 'Otros')).toBe(false);
  });

  it('un alias ORTOGRÁFICO sí se normaliza: "Alimentacion" no crea una segunda raíz', async () => {
    filas.rows = [raiz('r-tra', 'Transporte')];
    expect(await asegurarCategoriaUsuario('u1', 'Alimentacion')).toBe('creada');
    expect(llamadas.inserts).toHaveLength(1);
    expect(llamadas.inserts[0].nombre).toBe('Alimentación');
  });

  it('un 23505 del índice único de la 067 es "ya-existe", no un error', async () => {
    // Otro camino ganó la carrera y creó la misma raíz: es exactamente lo que se quería.
    filas.rows = [raiz('r-ali', 'Alimentación')];
    errorInsert.value = { code: '23505', message: 'duplicate key value' };
    expect(await asegurarCategoriaUsuario('u1', 'Transporte')).toBe('ya-existe');
  });

  it('un error de insert que NO es 23505 sí se reporta', async () => {
    filas.rows = [raiz('r-ali', 'Alimentación')];
    errorInsert.value = { code: '42501', message: 'permission denied' };
    expect(await asegurarCategoriaUsuario('u1', 'Transporte')).toBe('error');
  });

  it('no explota con argumentos vacíos', async () => {
    expect(await asegurarCategoriaUsuario(null, 'Transporte')).toBe('nada');
    expect(await asegurarCategoriaUsuario('u1', '')).toBe('nada');
    expect(llamadas.inserts).toEqual([]);
  });
});

describe('crearSubcategoriaLibreUsuario — el padre que se crea es el que después se busca', () => {
  it('con un alias ortográfico, la subcategoría NO se pierde', async () => {
    // El padre se crea normalizado ("Alimentación") y se buscaba con el nombre crudo
    // ("Alimentacion"): `buscarCategoriaRaiz` compara exacto, no lo encontraba, y la
    // subcategoría se descartaba sin un solo log.
    filas.rows = [raiz('r-tra', 'Transporte')];
    await crearSubcategoriaLibreUsuario('u1', 'Alimentacion', 'cafeteria');

    const padre = llamadas.inserts.find(i => i.nombre === 'Alimentación' && !i.padre_id);
    expect(padre, 'no se creó la raíz normalizada').toBeTruthy();
    // ⚠️ Lo que muere si el padre se busca con otro nombre del que se escribió.
    expect(llamadas.inserts.some(i => i.nombre === 'cafeteria' && i.padre_id)).toBe(true);
  });

  it('al usuario sin árbol no se le crea ni el padre ni la subcategoría', async () => {
    // Esta era la vía silenciosa que FABRICABA usuarios encerrados: un primer gasto con
    // subcategoría le estrenaba un árbol de una sola raíz.
    filas.rows = [];
    await crearSubcategoriaLibreUsuario('u1', 'Transporte', 'taxi');
    expect(llamadas.inserts).toEqual([]);
  });
});

describe('detectarCategoriaIA — el AbortSignal llega al SDK', () => {
  it('pasa el signal como request option de OpenAI', async () => {
    // Sin esto el `abort()` del llamador no cancela nada y la mitigación es decorativa: el
    // cliente seguiría reintentando (maxRetries 3) una respuesta que ya nadie espera.
    filas.rows = [raiz('r-1', 'Transporte')];
    const ac = new AbortController();
    await detectarCategoriaIA('gaste 20 en taxi', 'u1', { signal: ac.signal });

    expect(crearCompletion).toHaveBeenCalledOnce();
    expect(crearCompletion.mock.calls[0][1]).toEqual({ signal: ac.signal });
  });

  it('sin opts no le inventa request options al SDK', async () => {
    filas.rows = [raiz('r-1', 'Transporte')];
    await detectarCategoriaIA('gaste 20 en taxi', 'u1');
    expect(crearCompletion.mock.calls[0][1]).toBeUndefined();
  });

  it('un abort no rompe el flujo: devuelve la clasificación vacía de siempre', async () => {
    filas.rows = [raiz('r-1', 'Transporte')];
    crearCompletion.mockRejectedValueOnce(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }));
    const res = await detectarCategoriaIA('gaste 20 en taxi', 'u1', { signal: new AbortController().signal });
    expect(res).toEqual({ categoria: null, subcategoria: null });
  });
});

describe('obtenerCategoriasUsuario — una sola query', () => {
  it('no hace una query por raíz: 3 raíces con subs = 1 sola llamada a from()', async () => {
    // Orden global por `nombre`, que es lo que devuelve la query real.
    filas.rows = [
      raiz('r-ali', 'Alimentacion'),
      sub('s-cafe', 'cafeteria', 'r-ali'),
      sub('s-deli', 'delivery', 'r-ali'),
      raiz('r-tra', 'Transporte'),
      raiz('r-viv', 'Vivienda'),
      sub('s-taxi', 'taxi', 'r-tra'),
    ];
    const res = await obtenerCategoriasUsuario('u1');

    expect(llamadas.from).toBe(1);
    expect(res.map(c => c.nombre)).toEqual(['Alimentacion', 'Transporte', 'Vivienda']);
    expect(res[0].subcategorias.map(s => s.nombre)).toEqual(['cafeteria', 'delivery']);
    expect(res[1].subcategorias.map(s => s.nombre)).toEqual(['taxi']);
    expect(res[2].subcategorias).toEqual([]);
  });

  it('no filtra por padre_id en la query: agrupar es cosa de JS', async () => {
    filas.rows = [raiz('r-1', 'Otros')];
    await obtenerCategoriasUsuario('u1');
    // `.is('padre_id', null)` era lo que obligaba a la segunda vuelta de queries.
    expect(llamadas.filtros.some(([m, col]) => m === 'is' && col === 'padre_id')).toBe(false);
    expect(llamadas.filtros.some(([m, col]) => m === 'eq' && col === 'padre_id')).toBe(false);
    // Lo que sí tiene que seguir filtrando.
    expect(llamadas.filtros).toContainEqual(['eq', 'usuario_id', 'u1']);
    expect(llamadas.filtros).toContainEqual(['eq', 'activa', true]);
    expect(llamadas.filtros).toContainEqual(['order', 'nombre']);
  });

  it('preserva el orden por nombre dentro de cada grupo aunque la fila venga intercalada', async () => {
    filas.rows = [
      raiz('r-a', 'Alimentacion'),
      sub('s-1', 'aguacate', 'r-a'),
      sub('s-2', 'bebidas', 'r-b'),
      raiz('r-b', 'Bebidas'),
      sub('s-3', 'zumo', 'r-a'),
    ];
    const res = await obtenerCategoriasUsuario('u1');
    expect(res[0].subcategorias.map(s => s.nombre)).toEqual(['aguacate', 'zumo']);
    expect(res[1].subcategorias.map(s => s.nombre)).toEqual(['bebidas']);
  });

  it('devuelve null sin filas', async () => {
    filas.rows = [];
    expect(await obtenerCategoriasUsuario('u1')).toBe(null);
    expect(llamadas.from).toBe(1);
  });

  it('devuelve null cuando solo hay subcategorías huérfanas (la versión vieja tampoco las veía)', async () => {
    // La primera query filtraba `.is('padre_id', null)`, así que estas filas nunca llegaban.
    // Sin la guarda de raíces vacías esto devolvería [], que NO es lo mismo para el llamador:
    // `detectarCategoriaIA` ramifica con `cats && cats.length > 0` y caería al mismo lado,
    // pero webhook.js/presupuestos.js sí distinguen null de lista vacía.
    filas.rows = [sub('s-1', 'taxi', 'r-borrada'), sub('s-2', 'bus', 'r-borrada')];
    expect(await obtenerCategoriasUsuario('u1')).toBe(null);
  });

  it('avisa cuando la respuesta llega al techo de 1000 filas de PostgREST', async () => {
    // Traer raíces y subcategorías en la MISMA query las hace compartir el techo. PostgREST
    // corta sin señalizarlo (`error` sigue en null), así que un árbol truncado clasificaría mal
    // y en silencio. La versión 1+N no podía truncar así: cada query iba acotada por su padre.
    filas.rows = Array.from({ length: 1000 }, (_, i) => raiz('r-' + i, 'Cat' + String(i).padStart(4, '0')));
    const res = await obtenerCategoriasUsuario('u1');
    expect(res).toHaveLength(1000);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatchObject({ tag: 'CATEGORIAS', filas: 1000 });
  });

  it('no avisa con un árbol de tamaño normal', async () => {
    filas.rows = [raiz('r-1', 'Salud'), sub('s-1', 'farmacia', 'r-1')];
    await obtenerCategoriasUsuario('u1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('una raíz sin subs trae subcategorias: [] y no undefined', async () => {
    filas.rows = [raiz('r-1', 'Salud')];
    const res = await obtenerCategoriasUsuario('u1');
    expect(res).toHaveLength(1);
    expect(res[0].subcategorias).toEqual([]);
    // El consumidor hace `c.subcategorias.length > 0` sin guarda previa.
    expect(() => res[0].subcategorias.length).not.toThrow();
  });
});
