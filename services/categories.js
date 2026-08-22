const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { CATEGORIAS_SUGERIDAS, CATEGORIAS_VALIDAS, CATEGORIA_MAP } = require('../lib/constants');
const { getEmojiCategoria } = require('../lib/formatters');
const { normalizarCategoria } = require('../lib/validators');
const { buildCategoriasCustomPrompt } = require('./parsers');

// UNA query, no 1+N. Antes traía las raíces y después una query por cada raíz dentro de un
// `for`: con 4.8 raíces de promedio (máx 21 en prod) eso son 5-22 round-trips en serie, y esta
// función está en el camino de CADA gasto registrado (la llama detectarCategoriaIA).
//
// El orden se preserva porque `.order('nombre')` es global: filtrar una lista ya ordenada deja
// cada grupo ordenado igual que la query por-padre que había antes.
async function obtenerCategoriasUsuario(usuarioId) {
  const { data: todas, error } = await supabase.from('categorias_usuario')
    .select('*').eq('usuario_id', usuarioId).eq('activa', true).order('nombre');
  // **El `null` de esta funcion significa "este usuario no tiene arbol propio", y eso NO es
  // una respuesta que se pueda dar sin haber podido preguntar.** `webhook.js` ramifica por ese
  // null para ofrecer el MENU de onboarding, y el de `/categorias` ademas escribe
  // `onboarding_paso: 10`. O sea que una lectura caida no daba un mensaje pobre: le ofrecia
  // volver a elegir sus categorias a alguien que ya las tiene, y el siguiente numero que
  // escribiera entraba a `crearCategoriasDesdeIndices` sobre un arbol lleno. Raices duplicadas
  // por esa puerta ya pasaron antes (ver el `.single()` de `buscarCategoriaRaiz`), y borrar una
  // raiz cascadea a `reglas_comercio` y `presupuestos`.
  //
  // Por eso lanza. Los call-sites donde el arbol es ACCESORIO —el tip del saludo, el prompt
  // del clasificador— atrapan el throw ahi mismo y degradan; los que lo usan para DECIDIR no
  // pueden.
  if (error) throw error;
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
    const { data: catCreada, error } = await supabase.from('categorias_usuario')
      .insert({ usuario_id: usuarioId, nombre: cat.nombre, emoji: cat.emoji }).select().single();
    // El insert puede fallar con 23505 desde la migración 067, que puso índice único sobre
    // las raíces. Antes se ignoraba `error` y `catCreada` venía null: el `continue` salteaba
    // las subcategorías EN SILENCIO, así que el usuario elegía "Alimentación" en el
    // onboarding y se quedaba con la raíz que ya tenía y sin una sola subcategoría —
    // indistinguible de haberla elegido vacía.
    let padreId = catCreada && catCreada.id;
    if (!padreId) {
      if (error && error.code === '23505') {
        // La raíz ya existía (otra corrida, o el usuario la eligió dos veces). No es un
        // fallo: se cuelgan las subcategorías de la que está.
        //
        // El try es por ITERACION y no envuelve el bucle: `buscarCategoriaRaiz` lanza desde
        // este mismo commit, y este bucle corre en el onboarding, donde el llamador
        // (`handlers/onboarding.js`) no tiene catch. Un throw que suba dejaria al usuario sin
        // respuesta y clavado en el paso 10; cortando aca, las otras categorias que eligio se
        // crean igual y la que fallo queda con nombre en el log.
        let raiz = null;
        try { raiz = await buscarCategoriaRaiz(usuarioId, cat.nombre); }
        catch (eRaiz) {
          log.warn({ tag: 'CATEGORIAS', usuarioId, categoria: cat.nombre, err: eRaiz.message },
            'No se pudo buscar la raiz existente: esta categoria se queda sin subcategorias');
        }
        padreId = raiz && raiz.id;
      } else if (error) {
        log.warn({ tag: 'CATEGORIAS', usuarioId, categoria: cat.nombre, err: error.message },
          'No se pudo crear la categoria del onboarding');
      }
    }
    if (!padreId) continue;
    // Escritura accesoria, pero no muda: si el insert de una subcategoria es rechazado, el
    // usuario termina con la raiz y sin nada colgando — indistinguible de haberla elegido
    // vacia, que es exactamente el sintoma que el comentario de arriba describe para la raiz.
    // No corta el bucle (las otras subcategorias no tienen la culpa) pero deja el rastro.
    for (const sub of cat.subs) {
      const { error: errSub } = await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: sub, padre_id: padreId });
      if (errSub) log.warn({ tag: 'CATEGORIAS', usuarioId, categoria: cat.nombre, sub, err: errSub.message }, 'No se pudo crear la subcategoria del onboarding');
    }
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
  // El arbol propio AGREGA categorias al prompt, no lo reemplaza (ver `construirContextoCategorias`),
  // asi que sin el la clasificacion sale peor pero sale. Y este es el camino de CADA gasto:
  // `handlers/intents/transacciones.js` la dispara como promesa suelta con su AbortSignal, o
  // sea que un rechazo aca se lleva puesto el registro del gasto para salvar su etiqueta.
  // Degrada a `null` y lo dice.
  let cats = null;
  try { cats = await obtenerCategoriasUsuario(usuarioId); }
  catch (eCats) {
    log.warn({ tag: 'CATEGORIAS', usuarioId, err: eCats.message }, 'No se pudo leer el arbol del usuario: se clasifica solo con las canonicas');
  }
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
  const { data, error } = await supabase.from('categorias_usuario')
    .select('id, nombre, activa').eq('usuario_id', usuarioId).eq('nombre', nombre).is('padre_id', null)
    .order('created_at', { ascending: true }).limit(1);
  // El `null` de esta funcion se lee de dos maneras opuestas segun quien pregunta, y una
  // lectura caida las rompe las dos: para `crearCategoriaLibreUsuario` significa "no existe,
  // creala" (y el 23505 del indice de la migracion 067 tapa el intento en silencio, porque es
  // el codigo que esa rama trata como exito), y para `crearSubcategoriaLibreUsuario` significa
  // "no hay donde colgarla" y la subcategoria se pierde sin una linea.
  //
  // No lleva excepcion de `PGRST116`: es `.limit(1)`, no `.single()`. Cero filas vuelven como
  // `data: []` con `error: null`.
  if (error) throw error;
  return (data && data[0]) || null;
}

async function crearCategoriaLibreUsuario(usuarioId, nombre) {
  try {
    if (await buscarCategoriaRaiz(usuarioId, nombre)) return;
    const emoji = getEmojiCategoria(nombre) || await sugerirEmojiConIA(nombre);
    const { error } = await supabase.from('categorias_usuario')
      .insert({ usuario_id: usuarioId, nombre, emoji, activa: true });
    // Cuarto borde del 23505 tras la migración 067. Esto es check-then-act: entre el
    // `buscarCategoriaRaiz` de arriba y este insert hay un await a OpenAI
    // (`sugerirEmojiConIA`), o sea cientos de ms en los que otro mensaje del mismo usuario
    // puede crear la misma raíz. El índice único es justo lo que cierra esa carrera, y el
    // `catch` mudo hacía indistinguible ese caso —que es CORRECTO— de un fallo real.
    if (error && error.code !== '23505') {
      log.warn({ tag: 'CATEGORIAS', usuarioId, nombre, err: error.message },
        'No se pudo crear la categoria libre');
    }
  } catch(e) {
    // El catch sigue existiendo (la lectura o la llamada al modelo pueden lanzar) pero ya
    // no es mudo: un fallo acá deja al usuario sin su categoría en `/categorias`.
    log.warn({ tag: 'CATEGORIAS', usuarioId, nombre, err: e.message },
      'Excepcion creando la categoria libre');
  }
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
    const raizExistente = await buscarCategoriaRaiz(usuarioId, efectivo);
    if (raizExistente) {
      // La raíz existe pero está INACTIVA: el usuario la borró. `obtenerCategoriasUsuario`
      // filtra por `activa`, así que no aparece en `cats` y sin esta rama esto devolvía
      // 'ya-existe' — indistinguible de la raíz sana, sin log ni rastro (B26(b)).
      //
      // No se reactiva, y es una decisión, no un olvido (Favio, 2026-08-11): el usuario la
      // borró a propósito, y desde B26 el prompt del clasificador lleva las canónicas
      // SIEMPRE, así que su gasto igual cae en la categoría correcta. Lo único que se
      // pierde es que no reaparece en /categorias ni en el selector de presupuestos.
      // Devolver un veredicto propio es lo que permite MEDIR a cuántos les pasa antes de
      // cambiar el comportamiento.
      if (raizExistente.activa === false) {
        log.info({ tag: 'CATEGORIAS_INACTIVA', usuarioId, categoria: efectivo },
          'La raiz existe pero el usuario la borro: no se reactiva');
        return 'inactiva';
      }
      return 'ya-existe';
    }
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

/**
 * Con qué nombre se PERSISTE una categoría en `transacciones` (hallazgo B28).
 *
 * El problema que cierra: `guardarTransaccion` aplicaba `normalizarCategoria` a secas, que
 * manda a `'Otros'` todo lo que no resuelve el mapa canónico. La webapp NO normaliza. Así
 * que el usuario se creaba "Comida casera", la veía en `/categorias`, la usaba desde la app
 * — y sus gastos por WhatsApp caían en Otros. Los dos canales divergían sobre la MISMA
 * columna, que es la que alimenta reportes, presupuestos y score.
 *
 * La regla: **lo que el mapa canónico resuelve se normaliza; lo que no, se persiste tal
 * cual.** Eso incluye los colapsos con pérdida (`Viajes`→`Otros`, `Hogar`→`Vivienda`), que
 * siguen aplicándose — esa decisión se tomó en B26 midiendo y no se reabre acá.
 *
 * ⚠️ **Esta función NO consulta el árbol del usuario, y la primera versión sí lo hacía.**
 * La idea era "solo respeto el nombre crudo si el usuario ya tiene esa raíz", y una revisión
 * adversarial la tiró abajo por dos motivos, los dos medidos:
 *
 *  1. **Carrera.** Quien crea la raíz es `asegurarCategoriaUsuario`, y sus tres call-sites la
 *     lanzan FIRE-AND-FORGET justo antes de `guardarTransaccion` (para no devolverle al
 *     camino del gasto los round-trips que le sacó la Ola 3). Así que el PRIMER gasto de una
 *     categoría custom no encontraba la raíz y persistía `'Otros'`, y el segundo persistía el
 *     nombre. El mismo concepto partido en dos buckets, y un presupuesto sobre esa categoría
 *     sub-contando para siempre.
 *  2. **El árbol no es un oráculo independiente.** Se alimenta del MISMO string que se está
 *     validando: `asegurarCategoriaUsuario` crea como categoría libre cualquier nombre no
 *     canónico. O sea que el guard no filtraba alucinaciones del clasificador — solo
 *     retrasaba una vuelta el momento en que las aceptaba.
 *
 * Sin consulta no hay carrera, el resultado es determinístico y coincide con lo que la
 * webapp ya hacía. Lo que de verdad acota qué nombres pueden aparecer es el prompt del
 * clasificador (canónicas ∪ árbol del usuario), no una re-lectura después.
 */
function resolverCategoriaPersistida(cruda) {
  const normalizada = normalizarCategoria(cruda);
  // Si la normalización llegó a una canónica, esa manda — venga escrita como venga.
  //
  // ⚠️ Esta línea NO es redundante y la primera versión de este fix la tenía y la perdió al
  // reescribirlo: `resolverNombreCategoria` compara EXACTO (`CATEGORIAS_VALIDAS.has` y
  // `CATEGORIA_MAP[nombre]`), mientras `normalizarCategoria` tiene además el camino difuso
  // (capitalizar, minúsculas, sin tildes). Sin ella, `"ALIMENTACION"` y `"TRANSPORTE"` —que
  // el clasificador devuelve a veces— caían por el `return cruda` de abajo y se persistían
  // en mayúsculas: la MISMA categoría partida en dos grafías, que es justo el síntoma que
  // B28 vino a cerrar. Lo encontró un test de B34, no la mutación de B28.
  if (normalizada !== 'Otros') return normalizada;
  if (!cruda) return normalizada;
  const { canonica } = resolverNombreCategoria(cruda);
  // `canonica` no nula acá = el mapa la resolvió a un COLAPSO CON PÉRDIDA (`Viajes`→`Otros`).
  // Esa decisión se tomó en B26 midiendo y no se reabre.
  if (canonica) return normalizada;
  return cruda;
}

/**
 * Resuelve un nombre que el usuario escribió a `{ categoria, subcategoria }` mirando SU árbol
 * (hallazgo B34).
 *
 * El caso: `/categorias` imprime las raíces **y sus subcategorías en línea**, así que el
 * usuario ve "Delivery" ahí y escribe *"ponme límite en Delivery"* — y el intent solo
 * matcheaba raíces, así que le respondía *"no reconozco la categoría 'Delivery'"* mientras se
 * la estaba mostrando. La tabla `presupuestos` ya tiene la columna `subcategoria` (está en el
 * `onConflict` del upsert); lo único que faltaba era resolverla.
 *
 * Devuelve `null` cuando el nombre no es ni raíz ni subcategoría del usuario. La comparación
 * es case-insensitive y sin tildes: acá el usuario está TIPEANDO, no eligiendo de un menú.
 */
async function resolverCategoriaOSub(usuarioId, nombre) {
  const buscado = normalizarParaComparar(nombre);
  if (!buscado) return null;
  const cats = await obtenerCategoriasUsuario(usuarioId);
  if (!cats) return null;
  for (const raiz of cats) {
    if (normalizarParaComparar(raiz.nombre) === buscado) {
      return { categoria: raiz.nombre, subcategoria: null };
    }
  }
  for (const raiz of cats) {
    for (const sub of raiz.subcategorias || []) {
      if (normalizarParaComparar(sub.nombre) === buscado) {
        return { categoria: raiz.nombre, subcategoria: sub.nombre };
      }
    }
  }
  return null;
}

/** Sin tildes, sin mayúsculas, sin espacios de sobra: para comparar lo que alguien TIPEÓ. */
function normalizarParaComparar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

async function crearSubcategoriaLibreUsuario(usuarioId, categoriaNombre, subcategoriaNombre) {
  if (!categoriaNombre || !subcategoriaNombre) return;
  try {
    let padre = await buscarCategoriaRaiz(usuarioId, categoriaNombre);
    // Una raíz INACTIVA no sirve de padre y hay que tratarla como si no estuviera (B33):
    // `buscarCategoriaRaiz` no filtra por `activa` —a propósito, porque
    // `asegurarCategoriaUsuario` necesita esa columna para distinguir "existe borrada" de "no
    // existe"— así que sin este `null` el flujo la encontraba, salteaba el bloque de abajo
    // entero, y colgaba una subcategoría ACTIVA de un padre borrado. Esa fila no aparece ni
    // en `/categorias` ni en `obtenerCategoriasUsuario`, o sea que el usuario no la ve ni la
    // puede borrar. Al caer a `null` entra al bloque, `asegurarCategoriaUsuario` devuelve
    // `'inactiva'` y se corta ahí.
    if (padre && padre.activa === false) padre = null;
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
      // `'inactiva'` = la raíz existe pero el usuario la BORRÓ (B33). Sin esta rama se
      // insertaba una subcategoría ACTIVA colgando de un padre inactivo: una fila que no
      // aparece ni en `/categorias` ni en `obtenerCategoriasUsuario` —las dos filtran por
      // `activa` de la raíz— o sea data huérfana que nadie va a ver ni a poder borrar.
      //
      // No se reactiva la raíz, que es la decisión de B26(b) (Favio, 11-ago): el usuario la
      // borró a propósito. Lo que cambia es que ahora no se le cuelga nada encima.
      if (veredicto === 'inactiva') return;
      // Se busca por el nombre EFECTIVO, que puede no ser el que llegó: con un alias ortográfico
      // ("Alimentacion") arriba se escribió la forma canónica ("Alimentación"), y buscar el crudo
      // no la encuentra — la subcategoría se perdería sin un solo log.
      padre = await buscarCategoriaRaiz(usuarioId, resolverNombreCategoria(categoriaNombre).efectivo);
      if (!padre) return;
    }
    const { data: existeSub, error: errExiste } = await supabase.from('categorias_usuario')
      .select('id').eq('usuario_id', usuarioId).eq('padre_id', padre.id).ilike('nombre', subcategoriaNombre).limit(1);
    // Dedup de subcategorias, y este SI corta: al reves que el dedup de `guardarTransaccion`,
    // lo que sigue no es el gasto de nadie sino una fila de taxonomia. Sin indice unico sobre
    // (usuario_id, padre_id, nombre) —el de la migracion 067 cubre solo las raices— seguir de
    // largo con `existeSub` en null inserta la subcategoria duplicada, y duplicados en este
    // arbol es de donde salio el ciclo de 2 a 24 filas que documenta `buscarCategoriaRaiz`.
    if (errExiste) throw errExiste;
    if (existeSub && existeSub.length) return;
    const { error: errInsert } = await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: subcategoriaNombre, padre_id: padre.id, activa: true });
    if (errInsert) throw errInsert;
  } catch(e) {
    // **Este catch era `/* silencioso */`, y eso convertia en decorativo cualquier arreglo de
    // las lineas de arriba.** Un `throw` cuyo destino es un catch mudo compra el mismo silencio
    // que el `return` que se saco — la leccion de `verificarRachaAportes`, ítem 7.
    //
    // Sigue sin propagar a proposito: los tres call-sites la disparan encadenada y
    // fire-and-forget al lado del gasto, y el gasto vale mas que la fila de subcategoria.
    log.warn({ tag: 'CATEGORIAS', usuarioId, categoria: categoriaNombre, sub: subcategoriaNombre, err: e.message },
      'No se pudo crear la subcategoria libre');
  }
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
  resolverCategoriaPersistida,
  resolverCategoriaOSub,
};
