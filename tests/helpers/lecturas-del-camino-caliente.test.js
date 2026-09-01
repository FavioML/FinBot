import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * LA OTRA MITAD DEL ÍTEM 21, para `helpers/db-helpers.js`: el archivo que corre en el camino de
 * CADA mensaje entrante.
 *
 * Acá el reparto de la forma y el comportamiento importa más que en ningún otro perímetro,
 * porque la decisión no fue la misma en los diez sitios. Una guarda que propague rompe el
 * registro de gastos de todos, así que hubo que decidir **por sitio** si falla abierto o
 * cerrado — y este archivo es lo único que puede afirmar cuál eligió cada uno. El guard de
 * forma (`tests/lecturas-del-resto.test.js`) los da todos por iguales.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * EL DEFECTO QUE ESTE ARCHIVO EXISTE PARA VIGILAR, Y NO ERA COSMÉTICO
 *
 * `guardarMensaje` purga el historial viejo protegiendo los primeros `HEAD_PROTEGIDO` turnos
 * (el onboarding), y el comentario del archivo promete que **no se purgan nunca**. La promesa
 * dependía de una lectura muda: si la query del head fallaba, `head` llegaba `null`,
 * `protegidos` quedaba VACÍO y `aBorrar` pasaba a ser la lista COMPLETA de candidatos —
 * incluido el head. O sea que una caída transitoria de la base borraba de forma **permanente**
 * la única evidencia de cómo se dio de alta esa persona.
 *
 * Sus dos hermanas fallaban hacia el lado seguro (sin candidatos no se purga nada). Ésta no, y
 * la diferencia no se ve mirando la forma de las tres: se ven idénticas.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE HABÍA DEBAJO: TRES `catch` QUE NO SE ALCANZABAN
 *
 * Es el tercer caso de la clase que dejó el ítem 20. `obtenerOCrearUsuario` envolvía sus dos
 * lecturas en `try { … } catch (e) {}` **vacíos**, escritos creyendo que `.single()` LANZA
 * cuando no encuentra fila. No lanza: supabase-js devuelve `{ data: null, error: PGRST116 }`.
 * Los dos `catch` nunca corrieron una sola vez, y lo que de verdad hacía caer al INSERT era el
 * `if (data)` en falso.
 *
 * **Y por eso esas dos siguen fallando ABIERTO, apoyadas en un hecho de la base y no en un
 * gusto:** `usuarios_whatsapp_key` es un índice ÚNICO (verificado contra producción el
 * 31-ago-2026). Si la lectura se cae y se cae igual al INSERT, Postgres rechaza el alta
 * duplicada con 23505 en vez de partirle la identidad al usuario. Cortar ahí le costaría el
 * primer mensaje a alguien que se da de alta durante un parpadeo, sin comprar nada que el
 * índice no compre ya. Lo que sí se arregló es la MENTIRA del mensaje.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const CAIDA = { data: null, error: { message: 'connection terminated unexpectedly', code: '57P01' } };
// Lo que PostgREST devuelve cuando un `.single()` no encuentra fila. Ver el doble de abajo.
const SIN_FILAS = { code: 'PGRST116', details: 'The result contains 0 rows', message: 'JSON object requested, multiple (or no) rows returned' };

/**
 * El doble, indexado por (tabla, operación) y con COLA por clave: `guardarMensaje` hace DOS
 * selects sobre `conversaciones` y hay que poder tirar sólo el segundo. Una respuesta única por
 * tabla no distinguiría la lectura que falla hacia el lado seguro de la que borra datos, que es
 * justo la distinción que este archivo existe para afirmar.
 */
const db = { resp: {}, borrados: [], updates: [], inserts: [] };

function cadena(tabla) {
  const c = {};
  let op = 'select';
  let idsBorrados = null;
  const resultado = () => {
    if (op === 'delete') db.borrados.push({ tabla, ids: idsBorrados });
    const k = tabla + ':' + op;
    const v = db.resp[k];
    if (Array.isArray(v)) return v.length ? v.shift() : { data: null, error: null };
    if (v) return v;
    return { data: null, error: null };
  };
  for (const m of ['select', 'eq', 'order', 'limit', 'range', 'is', 'not']) c[m] = () => c;
  c.in = (_col, ids) => { if (op === 'delete') idsBorrados = ids; return c; };
  c.insert = (fila) => { op = 'insert'; db.inserts.push({ tabla, fila }); return c; };
  c.update = (patch) => { op = 'update'; db.updates.push({ tabla, patch }); return c; };
  c.delete = () => { op = 'delete'; return c; };
  c.maybeSingle = async () => resultado();
  // **`single()` NO es igual a `maybeSingle()`, y hacerlos iguales dejaba sin cobertura la
  // distinción que este trabajo declara load-bearing en cinco sitios.** PostgREST devuelve
  // PGRST116 cuando un `.single()` no encuentra fila; ése es todo el motivo por el que el
  // arreglo usa `maybeSingle` + `if (error)` separado del `if (!data)` en vez de un
  // `if (error)` a secas. Con los dos dobles idénticos, revertir un `.maybeSingle()` a
  // `.single()` dejaba la suite entera en verde — medido por la revisión adversarial — y en
  // producción esa mutación convierte cada 404 legítimo en un 500. Ahora la mata este doble.
  c.single = async () => {
    const r = resultado();
    return (r.data == null && !r.error) ? { data: null, error: SIN_FILAS } : r;
  };
  c.then = (res, rej) => Promise.resolve(resultado()).then(res, rej);
  return c;
}

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/db.js', { supabase: { from: (t) => cadena(t) } }],
  ['lib/analytics.js', { capture: vi.fn(), default: { capture: vi.fn() } }],
  ['lib/error-monitor.js', { registrarError: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const {
  guardarMensaje, obtenerHistorial, obtenerOCrearUsuario, buscarUsuarioPorBsuid,
} = require('../../helpers/db-helpers');

const filas = (n, prefijo) => Array.from({ length: n }, (_, i) => ({ id: prefijo + i }));

beforeEach(() => {
  db.resp = {};
  db.borrados = [];
  db.updates = [];
  db.inserts = [];
  vi.clearAllMocks();
});

describe('guardarMensaje: la purga no puede borrar lo que no pudo leer', () => {
  it('con el HEAD caído NO borra nada (antes se llevaba el onboarding entero)', async () => {
    // Primera lectura sana (hay candidatos), segunda caída (el head protegido).
    db.resp['conversaciones:select'] = [{ data: filas(5, 'viejo-'), error: null }, CAIDA];
    await guardarMensaje('u1', 'user', 'hola');
    expect(db.borrados, 'purgó con la lista de protegidos vacía: se lleva el onboarding').toEqual([]);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('CONTROL: con las dos lecturas sanas SÍ purga, y respeta el head', async () => {
    // Sin esto, el caso de arriba pasaría igual si `guardarMensaje` no purgara nunca — que es
    // la forma más barata de un verde vacío. Acá el head cubre 2 de los 5 candidatos.
    db.resp['conversaciones:select'] = [
      { data: filas(5, 'v'), error: null },
      { data: [{ id: 'v0' }, { id: 'v1' }], error: null },
    ];
    await guardarMensaje('u1', 'user', 'hola');
    expect(db.borrados.length, 'no purgó con las dos lecturas sanas').toBe(1);
    expect(db.borrados[0].ids, 'borró filas del head protegido').toEqual(['v2', 'v3', 'v4']);
  });

  it('con la lectura de CANDIDATOS caída tampoco purga, y ni siquiera pide el head', async () => {
    // Ésta ya fallaba hacia el lado seguro; el caso la fija para que el arreglo no la invierta.
    db.resp['conversaciones:select'] = [CAIDA];
    await guardarMensaje('u1', 'user', 'hola');
    expect(db.borrados).toEqual([]);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('el INSERT del turno falla ABIERTO pero DEVUELVE false: no corta, y no miente', async () => {
    // **Antes esto afirmaba `resolves.toBeUndefined()`, que lo cumple cualquier implementación
    // —incluida una que no haga nada— porque la función no devolvía valor en ninguna rama.** Lo
    // marcó la revisión adversarial, y no era sólo una aserción floja: era la que TAPABA el
    // defecto de al lado. `/admin/notify` deducía su `saved_in_history` de que no hubiera
    // excepción, y `guardarMensaje` no lanza nunca, así que informaba `true` sobre un INSERT
    // rechazado justo cuando la función ya sabía que había fallado.
    db.resp['conversaciones:insert'] = CAIDA;
    db.resp['conversaciones:select'] = [{ data: [], error: null }];
    expect(await guardarMensaje('u1', 'user', 'hola'), 'sigue sin decir si el turno se guardó').toBe(false);
    expect(logMock.error, 'un turno perdido no dejó ni un rastro').toHaveBeenCalled();
  });

  it('CONTROL: con el INSERT sano devuelve true, y una purga fallida NO lo baja', async () => {
    // Las dos mitades que le dan significado al `false` de arriba. La segunda importa aparte:
    // el turno YA está escrito, y que no se pueda podar el historial viejo no lo desescribe —
    // devolver `false` ahí haría que `/admin/notify` reportara como perdido un mensaje que sí
    // quedó guardado, o sea la mentira simétrica.
    db.resp['conversaciones:select'] = [{ data: [], error: null }];
    expect(await guardarMensaje('u1', 'user', 'hola')).toBe(true);

    db.resp['conversaciones:select'] = [CAIDA];
    expect(await guardarMensaje('u1', 'user', 'hola'), 'una purga caída se reportó como turno perdido').toBe(true);
  });
});

describe('obtenerHistorial: sin contexto se responde igual, pero se dice', () => {
  it('con la lectura caída devuelve [] Y loguea', async () => {
    db.resp['conversaciones:select'] = CAIDA;
    expect(await obtenerHistorial('u1')).toEqual([]);
    expect(logMock.error, 'no se distingue "sin turnos previos" de "no pude leerlos"').toHaveBeenCalled();
  });

  it('CONTROL: sin turnos devuelve [] y NO loguea un error', async () => {
    // La mitad que importa: si el arreglo logueara siempre, el log dejaría de significar algo.
    db.resp['conversaciones:select'] = { data: [], error: null };
    expect(await obtenerHistorial('u1')).toEqual([]);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('obtenerOCrearUsuario: falla ABIERTO, y el índice único es lo que lo hace seguro', () => {
  it('con la lectura caída cae al INSERT (no corta el alta) y lo loguea', async () => {
    db.resp['usuarios:select'] = [CAIDA, CAIDA];
    db.resp['usuarios:insert'] = { data: { id: 'nuevo', whatsapp: '51999888777' }, error: null };
    const u = await obtenerOCrearUsuario('51999888777');
    expect(u.id, 'cortó el alta de alguien que escribe durante un parpadeo de la base').toBe('nuevo');
    expect(logMock.error).toHaveBeenCalled();
  });

  it('el 23505 DESPUÉS de una lectura caída dice la verdad, no "Error creando usuario"', async () => {
    // El mensaje viejo mandaba a investigar el alta cuando lo que falló fue la lectura de al
    // lado. El índice `usuarios_whatsapp_key` es lo que convierte ese caso en un rechazo limpio.
    db.resp['usuarios:select'] = [CAIDA, CAIDA];
    db.resp['usuarios:insert'] = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "usuarios_whatsapp_key"' } };
    await expect(obtenerOCrearUsuario('51999888777')).rejects.toThrow(/No se pudo leer al usuario existente/);
  });

  it('CONTROL: un 23505 SIN lectura caída sigue diciendo "Error creando usuario"', async () => {
    // Sin este control, el caso de arriba pasaría igual si el mensaje nuevo fuera el único que
    // existe — y entonces no estaría distinguiendo nada.
    db.resp['usuarios:select'] = [{ data: null, error: null }, { data: null, error: null }];
    db.resp['usuarios:insert'] = { data: null, error: { code: '23505', message: 'duplicate key' } };
    await expect(obtenerOCrearUsuario('51999888777')).rejects.toThrow(/Error creando usuario/);
  });

  it('CONTROL: con la base sana devuelve la fila existente y no inserta', async () => {
    db.resp['usuarios:select'] = [{ data: { id: 'ya-estaba', whatsapp: '51999888777' }, error: null }];
    const u = await obtenerOCrearUsuario('51999888777');
    expect(u.id).toBe('ya-estaba');
    expect(db.inserts, 'insertó sobre un usuario que ya existía').toEqual([]);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('buscarUsuarioPorBsuid: el mensaje se descarta igual, pero deja de mentir', () => {
  it('con la lectura caída devuelve null Y loguea que NO es un desconocido', async () => {
    // El llamador (`handlers/webhook.js`) escribe "Mensaje entrante sin from — se descarta" y
    // una fila en `errores` que dice DESCONOCIDO. Con la lectura caída eso es falso, y esconde
    // el caso caro: el gasto de alguien IDENTIFICADO perdido por una caída.
    db.resp['usuarios:select'] = CAIDA;
    expect(await buscarUsuarioPorBsuid('PE.123')).toBe(null);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('CONTROL: un BSUID que de verdad no está devuelve null SIN log de error', async () => {
    db.resp['usuarios:select'] = { data: null, error: null };
    expect(await buscarUsuarioPorBsuid('PE.123')).toBe(null);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('CONTROL: un BSUID conocido devuelve su usuario', async () => {
    db.resp['usuarios:select'] = { data: { id: 'u9' }, error: null };
    expect((await buscarUsuarioPorBsuid('PE.123')).id).toBe('u9');
  });
});
