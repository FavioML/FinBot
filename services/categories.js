const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { CATEGORIAS_SUGERIDAS, CATEGORIAS_VALIDAS, CATEGORIA_MAP } = require('../lib/constants');
const { getEmojiCategoria } = require('../lib/formatters');
const { buildCategoriasCustomPrompt } = require('./parsers');

// UNA query, no 1+N. Antes traía las raíces y después una query por cada raíz dentro de un
// `for`: con 4.8 raíces de promedio (máx 21 en prod) eso son 5-22 round-trips en serie, y esta
// función está en el camino de CADA gasto registrado (la llama detectarCategoriaIA).
//
// El orden se preserva porque `.order('nombre')` es global: filtrar una lista ya ordenada deja
// cada grupo ordenado igual que la query por-padre que había antes.
async function obtenerCategoriasUsuario(usuarioId) {
  const { data: todas } = await supabase.from('categorias_usuario')
    .select('*').eq('usuario_id', usuarioId).eq('activa', true).order('nombre');
  if (!todas || todas.length === 0) return null;
  // PostgREST corta la respuesta en 1000 filas SIN señalizarlo: `data` vuelve corta y `error`
  // sigue en null (db-max-rows=1000, verificado en prod — ver migraciones 039/040). La versión
  // 1+N no podía truncar así, porque cada query estaba acotada por su padre; traer raíces y
  // subcategorías juntas hace que compartan el mismo techo. Hoy el máximo en prod son 21 raíces,
  // dos órdenes de magnitud abajo, pero un árbol truncado clasifica mal y en silencio: que al
  // menos quede el aviso.
  if (todas.length >= 1000) {
    log.warn({ tag: 'CATEGORIAS', usuarioId, filas: todas.length }, 'Posible truncado de PostgREST: el arbol de categorias puede venir incompleto');
  }
  const subsPorPadre = new Map();
  for (const c of todas) {
    if (!c.padre_id) continue;
    if (!subsPorPadre.has(c.padre_id)) subsPorPadre.set(c.padre_id, []);
    subsPorPadre.get(c.padre_id).push(c);
  }
  // Sin raíces activas devolvemos null igual que antes, aunque haya subcategorías huérfanas:
  // la primera query las filtraba con `.is('padre_id', null)` y nunca las veía.
  const raices = todas.filter(c => !c.padre_id);
  if (raices.length === 0) return null;
  return raices.map(c => ({ ...c, subcategorias: subsPorPadre.get(c.id) || [] }));
}

async function crearCategoriasDesdeIndices(usuarioId, indices) {
  const seleccionadas = indices.map(i => CATEGORIAS_SUGERIDAS[i-1]).filter(Boolean);
  for (const cat of seleccionadas) {
    const { data: catCreada } = await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: cat.nombre, emoji: cat.emoji }).select().single();
    if (!catCreada) continue;
    for (const sub of cat.subs) { await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: sub, padre_id: catCreada.id }); }
  }
}

/**
 * @param {{ signal?: AbortSignal }} [opts] — para cancelar cuando el llamador la disparó en
 *   paralelo y después tomó un camino donde el resultado ya no se usa. Sin esto, el cliente
 *   (`maxRetries: 3`, `timeout: 60000`) puede seguir reintentando durante minutos una respuesta
 *   que nadie va a leer, y el 429 de OpenAI ya mordió acá antes (ver `salvarGastoSinIA`).
 */
// El árbol canónico SIEMPRE viaja al modelo; las categorías propias del usuario se AGREGAN con
// prioridad, no lo reemplazan.
//
// Antes era excluyente: con árbol propio se mandaba solo ése, y con árbol vacío solo el canónico.
// Eso encerraba a quien eligió pocas categorías en el onboarding — un taxi de alguien que solo
// tiene "Alimentación" y "Finanzas" caía en Finanzas, porque Transporte no estaba en su lista. Y
// el encierro se sellaba solo: el parser proponía "Transporte", esto lo pisaba con "Finanzas", y
// como Finanzas ya existía el árbol nunca crecía (hallazgo B26; 23 de 45 usuarios con árbol
// propio tenían 1-2 raíces).
//
// La resolución por UNIÓN con prioridad no es nueva acá: es exactamente lo que hace
// `parsearCorreoBancario` con el MISMO insumo, y por eso se reusa su bloque en vez de escribir
// otro — dos prompts que deciden la misma columna divergen solos.
//
// Nota sobre lo que las custom logran de verdad en este camino: `guardarTransaccion` aplica
// `normalizarCategoria`, que manda a 'Otros' todo lo no canónico. O sea que restringir la lista
// nunca preservó la personalización en la fila; lo único que hacía era recortar las canónicas
// elegibles.
function construirContextoCategorias(cats) {
  const canonico = CATEGORIAS_SUGERIDAS
    .map(c => c.nombre + (c.subs.length > 0 ? ' (subs: ' + c.subs.join(',') + ')' : ''))
    .join('; ');
  // `subsCerradas: false` porque el system prompt de acá arriba dice justo lo contrario: que una
  // subcategoría nombrada explícitamente por el usuario se use aunque no esté en la lista.
  const bloqueCustom = buildCategoriasCustomPrompt(cats, { sustantivo: 'gasto', matiz: '', subsCerradas: false });
  return { canonico, bloqueCustom };
}

async function detectarCategoriaIA(texto, usuarioId, opts = {}) {
  const cats = await obtenerCategoriasUsuario(usuarioId);
  const { canonico, bloqueCustom } = construirContextoCategorias(cats);
  try {
    const res = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Eres un clasificador de gastos. Elige la categoria mas apropiada de la lista proporcionada. Si el usuario menciona explicitamente una subcategoria, usa ese nombre exacto aunque no este en la lista. Responde SOLO con JSON: {"categoria":"nombre exacto","subcategoria":"nombre exacto o null"}' + bloqueCustom }, { role: 'user', content: 'Categorias disponibles: '+canonico+'\n\nGasto a clasificar: '+texto }], temperature: 0 }, opts.signal ? { signal: opts.signal } : undefined);
    const raw = res.choices[0].message.content.trim();
    const result = JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
    if (result.subcategoria && /^null$/i.test(String(result.subcategoria).trim())) result.subcategoria = null;
    if (result.categoria && /^null$/i.test(String(result.categoria).trim())) result.categoria = null;
    return result;
  } catch(e) { return { categoria: null, subcategoria: null }; }
}

async function sugerirEmojiConIA(nombreCategoria) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Dame UN solo emoji que mejor represente la categoría de gastos llamada "' + nombreCategoria + '". Responde SOLO con el emoji, sin texto.' }],
      temperature: 0, max_tokens: 10
    });
    const emoji = res.choices[0].message.content.trim();
    return emoji.length <= 4 ? emoji : '📁';
  } catch(e) { return '📁'; }
}

// Devuelve la fila raíz existente (o null) SIN lanzar cuando hay duplicados.
// `.single()` lanzaba con >1 fila; el catch se lo tragaba y el flujo insertaba
// otra categoría igual, así que 2 duplicados se volvían 24. `.limit(1)` corta
// ese ciclo: si ya existe al menos una con ese nombre, nunca se inserta otra.
async function buscarCategoriaRaiz(usuarioId, nombre) {
  const { data } = await supabase.from('categorias_usuario')
    .select('id').eq('usuario_id', usuarioId).eq('nombre', nombre).is('padre_id', null)
    .order('created_at', { ascending: true }).limit(1);
  return (data && data[0]) || null;
}

async function crearCategoriaLibreUsuario(usuarioId, nombre) {
  try {
    if (await buscarCategoriaRaiz(usuarioId, nombre)) return;
    const emoji = getEmojiCategoria(nombre) || await sugerirEmojiConIA(nombre);
    await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre, emoji, activa: true });
  } catch(e) { /* silencioso */ }
}

/**
 * Con qué nombre va a quedar esta categoría en la DB, y si cuenta como canónica.
 *
 * **La regla es una sola: la raíz se llama como la categoría donde va a caer la transacción.**
 * `guardarTransaccion` aplica `normalizarCategoria`, que resuelve TODO `CATEGORIA_MAP` — así que
 * si acá se creara la raíz con el nombre crudo, quedaría una categoría que ninguna transacción
 * puede poblar nunca: visible en `/categorias` y en el selector de presupuestos, y siempre en
 * cero. Peor: `_normCat` de `services/budget.js` no aplica el mapa, así que un presupuesto sobre
 * esa raíz tampoco dispararía alerta.
 *
 * > Una versión anterior distinguía "alias ortográficos" (`Alimentacion`→`Alimentación`) de
 * > "colapsos con pérdida" (`Viajes`→`Otros`, `Comida`→`Alimentación`) y dejaba a los segundos
 * > como categoría libre, con el argumento de que quien pide "Viajes" merece su categoría
 * > Viajes. **Medido: eso creaba 14 raíces muertas.** El argumento estaba mal planteado — la
 * > transacción ya se guardaba en `Otros` de todos modos, así que mostrarle "Viajes" en el árbol
 * > era la mentira, no lo contrario. Si algún día se quiere respetar el nombre del usuario, lo
 * > que hay que cambiar es dónde se guarda la transacción (hallazgo B28), no dónde se crea la
 * > raíz; y hasta entonces las dos puntas tienen que coincidir.
 *
 * Devuelve `{ canonica, efectivo }`: `canonica` es null para las libres, y `efectivo` es el
 * nombre con el que se escribe y con el que hay que volver a BUSCARLA. Que sean el mismo dato
 * importa: `crearSubcategoriaLibreUsuario` crea el padre y después lo busca, y si busca por el
 * nombre crudo mientras se escribió el normalizado, no lo encuentra y descarta la subcategoría
 * en silencio.
 */
function resolverNombreCategoria(nombre) {
  if (CATEGORIAS_VALIDAS.has(nombre)) return { canonica: nombre, efectivo: nombre };
  const mapeada = CATEGORIA_MAP[nombre];
  if (mapeada) return { canonica: mapeada, efectivo: mapeada };
  return { canonica: null, efectivo: nombre }; // libre de verdad: no la resuelve el mapa
}

/**
 * Punto ÚNICO para "que esta categoría exista en el árbol del usuario". Unifica el guard de
 * canonicidad que estaba copiado en los tres call-sites de `handlers/intents/transacciones.js`.
 *
 * Tres ramas, y la tercera es la que evita una regresión:
 *
 * - **No canónica** → lo de siempre: se crea como categoría libre.
 * - **Canónica y el usuario YA tiene árbol propio** → se crea si le falta. Es lo que repara el
 *   encierro de B26: sin esto el gasto se clasifica bien pero `Transporte` no aparece en
 *   `/categorias` ni en el selector de presupuestos, que leen `categorias_usuario`.
 * - **Canónica y el usuario NO tiene árbol** (`obtenerCategoriasUsuario` → `null`) → NO se toca.
 *   `handlers/webhook.js:626` y `:773` ramifican por ese `null` para ofrecer el menú de
 *   onboarding (`formatearCategoriasMsg` hace lo mismo en `lib/formatters.js:41`), así que
 *   crearle UNA fila le cambiaría `/categorias` de menú a una lista de un ítem. Y no hace falta:
 *   quien no tiene árbol no está encerrado, ya recibe las 11 canónicas en el prompt.
 *
 * No duplica: las canónicas se crean con el nombre exacto de `CATEGORIAS_SUGERIDAS` y
 * `buscarCategoriaRaiz` compara exacto, así que la segunda vez la encuentra. Y desde la
 * migración 067 el índice parcial `(usuario_id, nombre) where padre_id is null` lo garantiza
 * también entre mensajes y entre procesos, que es lo que encadenar promesas no puede dar.
 *
 * **Devuelve qué decidió** (`'libre' | 'sin-arbol' | 'ya-existe' | 'creada' | 'nada' | 'error'`)
 * y no es decoración: el catch de abajo es silencioso a propósito —el gasto vale más que la fila
 * de categoría— pero eso hace que un fallo de programación sea indistinguible de una decisión
 * correcta. Medido: la mutación "quitar la rama de `sin-arbol`" dejaba el test en VERDE, porque
 * sin ella `cats.some()` sobre `null` lanza y el catch se lo traga hasta el mismo no-insert.
 * Con el veredicto explícito, la mutación se ve.
 */
async function asegurarCategoriaUsuario(usuarioId, nombre) {
  if (!usuarioId || !nombre) return 'nada';
  const { canonica, efectivo } = resolverNombreCategoria(nombre);
  try {
    const cats = await obtenerCategoriasUsuario(usuarioId);
    // Sin árbol propio no se le inventa uno, sea la categoría canónica o libre: la regla vale
    // para las DOS ramas o no vale para ninguna. Con la comprobación solo del lado canónico, un
    // primer gasto en "Comida_Casera" le estrenaba igual un árbol de UNA raíz — que es
    // exactamente el usuario encerrado que este trabajo viene a evitar.
    if (!cats) return 'sin-arbol';
    if (!canonica) {
      await crearCategoriaLibreUsuario(usuarioId, efectivo);
      return 'libre';
    }
    if (cats.some(c => c.nombre === efectivo)) return 'ya-existe';
    if (await buscarCategoriaRaiz(usuarioId, efectivo)) return 'ya-existe';
    const sugerida = CATEGORIAS_SUGERIDAS.find(c => c.nombre === efectivo);
    const { error } = await supabase.from('categorias_usuario').insert({
      usuario_id: usuarioId, nombre: efectivo,
      emoji: (sugerida && sugerida.emoji) || getEmojiCategoria(efectivo) || '📁',
      activa: true,
    });
    // 23505 = el índice único de la migración 067 ganó la carrera. No es un fallo: otro camino
    // acaba de crear la misma raíz, que es justo lo que queríamos que pasara.
    if (error) return error.code === '23505' ? 'ya-existe' : 'error';
    return 'creada';
  } catch(e) {
    log.warn({ tag: 'CATEGORIAS', usuarioId, nombre, err: e.message }, 'No se pudo asegurar la categoria en el arbol');
    return 'error';
  }
}

async function crearSubcategoriaLibreUsuario(usuarioId, categoriaNombre, subcategoriaNombre) {
  if (!categoriaNombre || !subcategoriaNombre) return;
  try {
    let padre = await buscarCategoriaRaiz(usuarioId, categoriaNombre);
    if (!padre) {
      // Crear el padre pasa por `asegurarCategoriaUsuario`, no por `crearCategoriaLibreUsuario`
      // directo, para que la política de creación de raíces sea UNA sola.
      //
      // Esta era la segunda vía —y la más silenciosa— por la que un usuario sin árbol propio
      // estrenaba uno de UNA sola raíz: registraba "gasté 10 en taxi", el LLM devolvía la
      // subcategoría "Taxi", y esto le creaba "Transporte" por su cuenta. O sea que este camino
      // FABRICABA el usuario encerrado del que trata B26. Medido con `qa-categoria-encierro`
      // contra el código viejo: falla igual, es preexistente.
      const veredicto = await asegurarCategoriaUsuario(usuarioId, categoriaNombre);
      if (veredicto === 'sin-arbol') return; // sin árbol no hay dónde colgarla, y no se le inventa uno
      // Se busca por el nombre EFECTIVO, que puede no ser el que llegó: con un alias ortográfico
      // ("Alimentacion") arriba se escribió la forma canónica ("Alimentación"), y buscar el crudo
      // no la encuentra — la subcategoría se perdería sin un solo log.
      padre = await buscarCategoriaRaiz(usuarioId, resolverNombreCategoria(categoriaNombre).efectivo);
      if (!padre) return;
    }
    const { data: existeSub } = await supabase.from('categorias_usuario')
      .select('id').eq('usuario_id', usuarioId).eq('padre_id', padre.id).ilike('nombre', subcategoriaNombre).limit(1);
    if (existeSub && existeSub.length) return;
    await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: subcategoriaNombre, padre_id: padre.id, activa: true });
  } catch(e) { /* silencioso */ }
}

module.exports = {
  obtenerCategoriasUsuario,
  crearCategoriasDesdeIndices,
  construirContextoCategorias,
  asegurarCategoriaUsuario,
  detectarCategoriaIA,
  sugerirEmojiConIA,
  crearCategoriaLibreUsuario,
  crearSubcategoriaLibreUsuario,
};
