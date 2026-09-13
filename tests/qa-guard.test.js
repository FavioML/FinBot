// Tests de la barrera de qa-e2e (qa-e2e/lib/qa-guard.mjs).
//
// El caso 1 es el incidente del 01-ago-2026: un cleanup de harness borrando
// `transacciones` de un usuario real que paga. Si ese test se pone verde por el
// motivo equivocado (por ejemplo porque la barrera dejó de inspeccionar el
// builder), el resto de los casos lo delata: hay tanto bloqueos esperados como
// escrituras que TIENEN que pasar.
//
// Hermético: levanta un PostgREST de mentira en 127.0.0.1. No toca la DB real.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

const QA = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const REAL = 'ef9be664-b6f7-4fab-affb-6b8bd3005490'; // el usuario del incidente
const FILA_QA = '11111111-1111-4111-8111-111111111111';

let servidor;
let base;
let recibidas = [];
let guard;
let db;
// Id que el falso PostgREST devuelve al insertar. Cada test que dependa de la
// adopción de una fila nueva lo cambia, para no heredar lo que adoptó otro test.
let proximoId = FILA_QA;

// Falso PostgREST: responde una fila con id conocido a cualquier GET y 204 al resto.
beforeAll(async () => {
  process.env.NETO_QA_EXTRA_IDS = QA;
  servidor = http.createServer((req, res) => {
    recibidas.push({ method: req.method, url: req.url });
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: FILA_QA, usuario_id: QA }]));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: proximoId }]));
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + servidor.address().port;
  guard = await import('../qa-e2e/lib/qa-guard.mjs');
  db = guard.clienteGuardado(base, 'anon-de-mentira');
});

afterAll(() => new Promise((r) => servidor.close(r)));

// Ejecuta la operación y dice si la barrera la dejó pasar.
async function corre(fn) {
  try {
    await fn();
    return { paso: true, error: null };
  } catch (e) {
    if (e instanceof guard.QaGuardError) return { paso: false, error: e.message };
    throw e; // cualquier otro error es un bug del test, no un bloqueo
  }
}

describe('qa-guard: lo que tiene que bloquear', () => {
  it('el borrado del incidente: DELETE transacciones por usuario_id de un usuario real', async () => {
    const antes = recibidas.length;
    const r = await corre(() => db.from('transacciones').delete().eq('usuario_id', REAL));
    expect(r.paso).toBe(false);
    expect(r.error).toContain('NO es un usuario de QA');
    // Lo importante: ni siquiera salió el request.
    expect(recibidas.length).toBe(antes);
  });

  it('DELETE deudas por usuario_id de un usuario real', async () => {
    const r = await corre(() => db.from('deudas').delete().eq('usuario_id', REAL));
    expect(r.paso).toBe(false);
  });

  it('DELETE sin ningún filtro que fije el sujeto', async () => {
    const r = await corre(() => db.from('transacciones').delete().eq('tipo', 'gasto'));
    expect(r.paso).toBe(false);
    expect(r.error).toContain('sin ningún filtro que fije el sujeto');
  });

  it('UPDATE sobre usuarios apuntando a un id real', async () => {
    const r = await corre(() => db.from('usuarios').update({ plan: 'free' }).eq('id', REAL));
    expect(r.paso).toBe(false);
  });

  it('un operador abierto sobre la columna de dueño no fija nada', async () => {
    const r = await corre(() => db.from('transacciones').delete().neq('usuario_id', QA));
    expect(r.paso).toBe(false);
  });

  it('in.(...) con un solo id ajeno mezclado entre los de QA', async () => {
    const r = await corre(() => db.from('transacciones').delete().in('usuario_id', [QA, REAL]));
    expect(r.paso).toBe(false);
    expect(r.error).toContain(REAL);
  });

  it('DELETE por id de una fila que esta corrida nunca vio', async () => {
    const r = await corre(() => db.from('transacciones').delete().eq('id', '99999999-9999-4999-8999-999999999999'));
    expect(r.paso).toBe(false);
  });

  it('INSERT en usuarios sin is_test_user', async () => {
    const r = await corre(() => db.from('usuarios').insert({ whatsapp: '51999', nombre: 'X' }));
    expect(r.paso).toBe(false);
    expect(r.error).toContain('is_test_user');
  });

  it('INSERT de una fila colgada de un usuario real', async () => {
    const r = await corre(() => db.from('transacciones').insert({ usuario_id: REAL, monto: 10 }));
    expect(r.paso).toBe(false);
  });

  it('rpc merge_and_link con un usuario real', async () => {
    const r = await corre(() => db.rpc('merge_and_link', { p_survivor: QA, p_loser: REAL }));
    expect(r.paso).toBe(false);
  });

  it('permitirUsuarioDePrueba rechaza un uuid que no es uuid', async () => {
    await expect(guard.permitirUsuarioDePrueba('user-001')).rejects.toThrow(guard.QaGuardError);
  });
});

describe('qa-guard: lo que tiene que dejar pasar', () => {
  it('DELETE por usuario_id del usuario QA', async () => {
    const r = await corre(() => db.from('transacciones').delete().eq('usuario_id', QA));
    expect(r.paso).toBe(true);
  });

  it('la cadena de filtros no se escapa del proxy', async () => {
    const r = await corre(() => db.from('transacciones').delete()
      .eq('usuario_id', QA).eq('tipo', 'gasto').gte('fecha', '2026-01-01'));
    expect(r.paso).toBe(true);
    const ultima = recibidas[recibidas.length - 1];
    expect(ultima.method).toBe('DELETE');
    expect(ultima.url).toContain('tipo=eq.gasto');
  });

  it('UPDATE sobre el propio usuario QA', async () => {
    const r = await corre(() => db.from('usuarios').update({ onboarding_paso: 0 }).eq('id', QA));
    expect(r.paso).toBe(true);
  });

  it('las lecturas pasan siempre, incluso sin filtro', async () => {
    const r = await corre(() => db.from('transacciones').select('*'));
    expect(r.paso).toBe(true);
  });

  it('leer las filas de QA y después borrarlas por id (el patrón normal del cleanup)', async () => {
    const { data } = await db.from('transacciones').select('id').eq('usuario_id', QA);
    expect(data[0].id).toBe(FILA_QA);
    const r = await corre(() => db.from('transacciones').delete().eq('id', FILA_QA));
    expect(r.paso).toBe(true);
  });

  it('permitirFila habilita lo que se creó por fuera del cliente (ej. vía la API HTTP)', async () => {
    const sp = '22222222-2222-4222-8222-222222222222';
    const antes = await corre(() => db.from('space_members').delete().eq('space_id', sp));
    expect(antes.paso).toBe(false);
    guard.permitirFila(sp);
    const despues = await corre(() => db.from('space_members').delete().eq('space_id', sp));
    expect(despues.paso).toBe(true);
  });

  it('INSERT de un throwaway marcado como de prueba', async () => {
    const r = await corre(() => db.from('usuarios').insert({ whatsapp: '51900123', is_test_user: true }));
    expect(r.paso).toBe(true);
  });

  it('el throwaway creado en la corrida queda habilitado para su propia limpieza', async () => {
    const throwaway = '33333333-3333-4333-8333-333333333333';
    // Antes de crearlo, escribir sobre él está bloqueado.
    const antes = await corre(() => db.from('transacciones').delete().eq('usuario_id', throwaway));
    expect(antes.paso).toBe(false);
    // Ahora el INSERT en `usuarios` con is_test_user lo "crea" y la barrera lo adopta.
    proximoId = throwaway;
    await db.from('usuarios').insert({ whatsapp: '51900999', is_test_user: true }).select('id');
    const despues = await corre(() => db.from('transacciones').delete().eq('usuario_id', throwaway));
    expect(despues.paso).toBe(true);
  });

  it('un id devuelto por un INSERT en otra tabla NO se adopta como usuario', async () => {
    const ajeno = '44444444-4444-4444-8444-444444444444';
    proximoId = ajeno;
    await db.from('transacciones').insert({ usuario_id: QA, monto: 5 }).select('id');
    // Se puede borrar esa fila por id (la creó la corrida), pero no usarlo como dueño.
    expect((await corre(() => db.from('transacciones').delete().eq('id', ajeno))).paso).toBe(true);
    expect((await corre(() => db.from('deudas').delete().eq('usuario_id', ajeno))).paso).toBe(false);
  });
});

describe('qa-guard: falla cerrado', () => {
  // Si una versión de postgrest-js renombra `method` o `url`, la barrera deja de
  // ver lo que filtra la query. El modo de fallo aceptable es negarse a arrancar,
  // no dejar pasar todo en silencio.
  it('se niega a envolver un cliente cuyo builder no puede inspeccionar', () => {
    const sinMethod = { from: () => ({ delete: () => ({ eq: () => ({ url: new URL('http://x/') }) }) }), rpc: () => {} };
    expect(() => guard.envolverCliente(sinMethod)).toThrow(guard.QaGuardError);

    const sinUrl = { from: () => ({ delete: () => ({ eq: () => ({ method: 'DELETE' }) }) }), rpc: () => {} };
    expect(() => guard.envolverCliente(sinUrl)).toThrow();
  });

  // Lo mismo para el upsert: si postgrest-js deja de marcarlo en `Prefer` o en la URL, `esUpsert`
  // diría false y el upsert volvería a validarse como un INSERT, que es el hueco del 12-sep.
  it('se niega a envolver un cliente cuyo upsert no puede reconocer', () => {
    const cliente = (headers) => ({
      from: () => ({
        delete: () => ({ eq: () => ({ method: 'DELETE', url: new URL('http://x/?usuario_id=eq.sonda') }) }),
        upsert: () => ({ method: 'POST', url: new URL('http://x/'), headers }),
      }),
      rpc: () => {},
    });
    expect(() => guard.envolverCliente(cliente(new Headers()))).toThrow(/upsert/);
    // Control: con la marca que pone postgrest-js hoy, envuelve sin quejarse.
    expect(() => guard.envolverCliente(cliente(new Headers({ Prefer: 'resolution=merge-duplicates' })))).not.toThrow();
  });

  it('envolver dos veces el mismo cliente es idempotente', () => {
    expect(db.__qaGuard).toBe(true);
    expect(guard.envolverCliente(db)).toBe(db);
  });
});

describe('qa-guard: ningún harness se salta la barrera', () => {
  // Una barrera que se puede evitar creando otro cliente no es una barrera. Esto
  // rompe el build si alguien agrega un harness con su propio createClient o con
  // el cliente crudo de lib/db.
  it('todo harness de qa-e2e que toque la DB pasa por qa-guard', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '..', 'qa-e2e');
    const infractores = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      const tocaDb = /createClient\(|require\((?:.*)lib\/db/.test(src);
      if (tocaDb && !src.includes("qa-guard.mjs")) infractores.push(f);
    }
    expect(infractores, 'harness sin barrera: ' + infractores.join(', ')).toEqual([]);
  });

  it('el propio módulo del guard es el único que puede usar createClient', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '..', 'qa-e2e', 'lib', 'qa-guard.mjs'), 'utf8');
    expect(src).toContain("from '@supabase/supabase-js'");
  });
});

// ── El spy de enviarWhatsapp en los harnesses de crons ──────────────────────
//
// Un harness de cron NO invoca el cron sobre su usuario throwaway: invoca la
// función exportada de `cron/checks.js`, y esa función barre a TODOS los que
// cumplen la condición. Contra la Supabase de PRODUCCIÓN eso significa que un
// `checkTrialExpiry` sin spy le manda WhatsApps REALES a usuarios reales — un
// "tu prueba venció" a alguien que no lo pidió, disparado por una corrida de QA.
//
// Los cinco harnesses que existen hoy lo hacen bien, y lo hacen todos igual:
// pisan `require.cache` de `lib/whatsapp.js` ANTES de requerir el cron. El orden
// no es estilo, es la mecánica: `lib/notify-user.js` DESESTRUCTURA
// `enviarWhatsapp` al cargarse, así que si el require del cron ocurre primero se
// queda con la función real para siempre y el spy llega tarde.
//
// Eso era convención: vivía en un comentario de cada archivo y en que quien
// escribiera el siguiente se acordara. Esto lo convierte en build rojo.
const RE_CRON = /require\([^)]*cron\/(?:checks|index)/;
// La variable que sostiene la ruta RESUELTA de lib/whatsapp. Se exige esta forma
// exacta —`const X = require.resolve(<algo con lib/whatsapp>)`— y que `X` sea la
// clave que se pisa. Mirar "¿aparece lib/whatsapp en el archivo?" y "¿hay algún
// require.cache[...]?" por separado NO alcanza: un harness que pisa `lib/db` y
// nombra lib/whatsapp en un comentario pasaba el guard mandando WhatsApps reales.
const RE_RESOLVE_WA = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\.resolve\([^)]*lib\/whatsapp[^)]*\)/g;

/** La variable con la ruta de lib/whatsapp que además se usa como clave del cache. */
function claveDelStubDeWhatsapp(src) {
  for (const m of src.matchAll(RE_RESOLVE_WA)) {
    const v = m[1];
    const usa = new RegExp(`require\\.cache\\[\\s*${v}\\s*\\]\\s*(?:\\.exports\\s*)?=`);
    const uso = src.match(usa);
    if (uso) return { nombre: v, pos: uso.index };
  }
  return null;
}

/** null si está bien; el motivo si el harness puede escaparse a Meta. */
function auditarSpyDeCron(src) {
  const mCron = src.match(RE_CRON);
  if (!mCron) return null; // no es un harness de crons: no aplica
  const stub = claveDelStubDeWhatsapp(src);
  if (!stub) {
    return 'requiere un cron y no pisa require.cache de lib/whatsapp: los envíos salen a Meta. '
      + "Forma esperada: `const waPath = require.resolve('../lib/whatsapp.js')` + `require.cache[waPath].exports = {...}`";
  }
  if (!/enviarWhatsapp\s*:/.test(src)) {
    return 'pisa el módulo de whatsapp pero el reemplazo no define enviarWhatsapp: el cron va a llamar undefined o la real';
  }
  if (stub.pos > mCron.index) {
    return 'instala el spy DESPUÉS de requerir el cron: notify-user ya se quedó con la función real';
  }
  return null;
}

describe('qa-guard: ningún harness de cron puede escaparse a Meta', () => {
  it('todo harness que invoca un cron instala el spy de enviarWhatsapp antes', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '..', 'qa-e2e');
    const infractores = [];
    let harnessesDeCron = 0;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      if (!RE_CRON.test(src)) continue;
      harnessesDeCron++;
      const motivo = auditarSpyDeCron(src);
      if (motivo) infractores.push(`${f}: ${motivo}`);
    }
    // Antivacuidad: si el patrón deja de reconocer los harnesses de cron, el
    // test quedaría verde revisando cero archivos. Hoy son 4 (qa-cron-deudas,
    // qa-trial-flujo, qa-trial-gate, qa-trial-integridad). Ojo que
    // qa-referido-premio-trial NO cuenta: nombra `cron/checks.js` en comentarios
    // pero no lo requiere — reimplementa su query como oráculo, y stubea igual.
    expect(harnessesDeCron, 'no se reconoció NINGÚN harness de cron').toBeGreaterThanOrEqual(4);
    expect(infractores, 'harness de cron sin spy:\n' + infractores.join('\n')).toEqual([]);
  });

  it('el auditor reconoce las formas de romperlo', () => {
    const cron = "const { checkTrialExpiry } = require('../cron/checks');";
    const spy = "const waPath = require.resolve('../lib/whatsapp.js');\n"
      + 'require.cache[waPath].exports = { enviarWhatsapp: async () => ({}) };';

    // El caso bueno, y la variante con path.join que usa qa-cron-deudas.
    expect(auditarSpyDeCron(spy + '\n' + cron)).toBeNull();
    expect(auditarSpyDeCron(
      "const waPath = require.resolve(path.join(appRoot, 'lib/whatsapp.js'));\n"
      + 'require.cache[waPath].exports = { enviarWhatsapp: async () => ({}) };\n'
      + "const { x } = require(path.join(appRoot, 'cron/checks.js'));"
    )).toBeNull();

    // Orden invertido: el spy llega tarde.
    expect(auditarSpyDeCron(cron + '\n' + spy)).toMatch(/DESPUÉS/);
    // Sin spy.
    expect(auditarSpyDeCron(cron)).toMatch(/no pisa require\.cache de lib\/whatsapp/);
    // Requiere el módulo real sin pisarlo.
    expect(auditarSpyDeCron("const wa = require('../lib/whatsapp.js');\n" + cron)).toMatch(/no pisa require\.cache/);
    // Pisa el módulo correcto pero el reemplazo no trae la función.
    expect(auditarSpyDeCron(
      "const waPath = require.resolve('../lib/whatsapp.js');\nrequire.cache[waPath].exports = {};\n" + cron
    )).toMatch(/no define enviarWhatsapp/);
    // Un harness que no toca crons no es asunto de este guard.
    expect(auditarSpyDeCron("const x = require('../lib/db');")).toBeNull();

    // EL FALSO NEGATIVO QUE TENÍA LA PRIMERA VERSIÓN de este guard, fijado acá
    // para que no vuelva: pisar OTRO módulo y nombrar lib/whatsapp en prosa daba
    // veredicto "aprobado" sobre un harness que manda WhatsApps reales.
    expect(auditarSpyDeCron(
      '// no hace falta pisar lib/whatsapp, este cron casi no envia\n'
      + "const dbPath = require.resolve('../lib/db.js');\n"
      + 'require.cache[dbPath].exports = { supabase: fake };\n'
      + cron
    )).toMatch(/los envíos salen a Meta/);
  });
});

// ── El alta que hace el CÓDIGO BAJO PRUEBA ───────────────────────────────────
//
// `qa-bsuid-alta.mjs` necesita que `altaPorBsuid` inserte `{ whatsapp: null, bsuid }` SIN la
// marca, porque esa es la forma que se prueba. La excepción es angosta a propósito, y cada caso
// de acá fija uno de sus bordes: si alguno se afloja, un harness podría sembrar una fila sin
// marca que SÍ parezca de una persona (con número, con email), que es lo que la regla de
// `is_test_user` existe para impedir.
describe('qa-guard: el alta que hace el código bajo prueba (esperarAltaPorBsuid)', () => {
  const B = 'PE.qaaltatest0001';
  const NUEVO = '55555555-5555-4555-8555-555555555555';

  it('sin declarar, el INSERT sin marca sigue bloqueado aunque tenga forma de alta por BSUID', async () => {
    const antes = recibidas.length;
    const r = await corre(() => db.from('usuarios').insert({ whatsapp: null, bsuid: 'PE.qaaltanodeclarado' }));
    expect(r.paso).toBe(false);
    expect(r.error).toContain('is_test_user');
    expect(recibidas.length).toBe(antes);
  });

  it('no deja declarar un BSUID con forma real, ni uno demasiado corto', () => {
    expect(() => guard.esperarAltaPorBsuid('PE.1049206861029395')).toThrow(guard.QaGuardError);
    expect(() => guard.esperarAltaPorBsuid('PE.qa123')).toThrow(guard.QaGuardError);
    expect(() => guard.esperarAltaPorBsuid('pe.qaaltatest0001')).toThrow(guard.QaGuardError);
    expect(() => guard.esperarAltaPorBsuid(null)).toThrow(guard.QaGuardError);
  });

  it('declarado, deja pasar la forma exacta de altaPorBsuid y adopta la fila nueva', async () => {
    guard.esperarAltaPorBsuid(B);
    // Antes de nacer, escribir sobre esa fila está bloqueado.
    expect((await corre(() => db.from('usuarios').update({ onboarding_paso: 100 }).eq('id', NUEVO))).paso).toBe(false);
    proximoId = NUEVO;
    const antes = recibidas.length;
    const r = await corre(() => db.from('usuarios').insert({ whatsapp: null, bsuid: B }).select('id'));
    expect(r.paso).toBe(true);
    // Dos requests: el INSERT del código, y la marca que pone la barrera antes de devolverle la fila.
    expect(recibidas.length).toBe(antes + 2);
    expect(recibidas[recibidas.length - 2].method).toBe('POST');
    const marca = recibidas[recibidas.length - 1];
    expect(marca.method).toBe('PATCH');
    expect(decodeURIComponent(marca.url)).toContain('id=eq.' + NUEVO);
    expect(decodeURIComponent(marca.url)).toContain('bsuid=eq.' + B);
    expect(guard.altasRegistradas(B)).toEqual({ intentos: 1, ids: [NUEVO], cuerpos: [{ whatsapp: null, bsuid: B }] });
    // Y el alta puede seguir escribiendo sobre su fila (el paso del onboarding, el origen).
    expect((await corre(() => db.from('usuarios').update({ onboarding_paso: 100 }).eq('id', NUEVO))).paso).toBe(true);
  });

  it('declarado, pero con algo que identifica a una persona: bloquea', async () => {
    for (const extra of [{ whatsapp: '51999888777' }, { email: 'x@y.pe' }, { supabase_auth_id: NUEVO }]) {
      const r = await corre(() => db.from('usuarios').insert({ whatsapp: null, bsuid: B, ...extra }));
      expect(r.paso, JSON.stringify(extra)).toBe(false);
    }
    // Ninguno de los rechazados cuenta como intento de alta.
    expect(guard.altasRegistradas(B).intentos).toBe(1);
  });

  it('declarado, pero dos filas en el mismo INSERT: bloquea', async () => {
    const r = await corre(() => db.from('usuarios').insert([{ whatsapp: null, bsuid: B }, { whatsapp: null, bsuid: B }]));
    expect(r.paso).toBe(false);
  });

  it('la adopción de `errores` pasa con la forma exacta de adoptarErroresPrevios', async () => {
    const antes = recibidas.length;
    const r = await corre(() => db.from('errores').update({ usuario_id: NUEVO }).eq('bsuid', B).is('usuario_id', null));
    expect(r.paso).toBe(true);
    const ultima = recibidas[recibidas.length - 1];
    expect(recibidas.length).toBe(antes + 1);
    expect(ultima.method).toBe('PATCH');
    expect(decodeURIComponent(ultima.url)).toContain('bsuid=eq.' + B);
  });

  it('la adopción de `errores` bloquea cada desvío de esa forma', async () => {
    const desvios = {
      'le asigna las filas a OTRO usuario': () => db.from('errores').update({ usuario_id: REAL }).eq('bsuid', B).is('usuario_id', null),
      'un BSUID que no se declaró': () => db.from('errores').update({ usuario_id: NUEVO }).eq('bsuid', 'PE.qaotrobsuid01').is('usuario_id', null),
      'sin el `is.null` (tomaría filas que ya tienen dueño)': () => db.from('errores').update({ usuario_id: NUEVO }).eq('bsuid', B),
      'un filtro de más': () => db.from('errores').update({ usuario_id: NUEVO }).eq('bsuid', B).is('usuario_id', null).eq('tag', 'X'),
      'escribe algo más que usuario_id': () => db.from('errores').update({ usuario_id: NUEVO, mensaje: 'x' }).eq('bsuid', B).is('usuario_id', null),
      'otra tabla con la misma forma': () => db.from('conversaciones').update({ usuario_id: NUEVO }).eq('bsuid', B).is('usuario_id', null),
      'un DELETE con la misma forma': () => db.from('errores').delete().eq('bsuid', B).is('usuario_id', null),
    };
    for (const [motivo, fn] of Object.entries(desvios)) {
      const antes = recibidas.length;
      const r = await corre(fn);
      expect(r.paso, motivo).toBe(false);
      expect(recibidas.length, motivo + ': salió el request').toBe(antes);
    }
  });
});

// Los ataques de la revisión adversarial del 12-sep, uno por caso. Todos pasaban la primera
// versión de la excepción; los tres primeros bloques además la dejaban adoptar a un usuario real.
describe('qa-guard: los huecos que encontró la revisión adversarial del alta por BSUID', () => {
  const B2 = 'PE.qaaltatest0002';
  const NUEVO2 = '66666666-6666-4666-8666-666666666666';

  async function bloqueados(casos) {
    for (const [motivo, fn] of Object.entries(casos)) {
      const antes = recibidas.length;
      const r = await corre(fn);
      expect(r.paso, motivo).toBe(false);
      expect(recibidas.length, motivo + ': salió el request').toBe(antes);
    }
  }

  // El título original decía "ningún upsert pasa, en ninguna tabla": fue la primera respuesta, y
  // rompía al backend. La regla que quedó está en el bloque de la segunda vuelta, más abajo.
  it('los upserts que podían adoptar a un usuario real no pasan', async () => {
    guard.esperarAltaPorBsuid(B2);
    await bloqueados({
      'upsert con la forma del alta y el id de un real': () => db.from('usuarios').upsert({ id: REAL, bsuid: B2, whatsapp: null }).select('id'),
      'upsert por otra columna única, sin id': () => db.from('usuarios').upsert({ bsuid: B2, ref_code: 'CODIGOREAL' }, { onConflict: 'ref_code' }).select('id'),
      'upsert marcado como de prueba sobre un real (hueco de la regla del throwaway)': () => db.from('usuarios').upsert({ id: REAL, is_test_user: true }).select('id'),
      'upsert que ignora duplicados': () => db.from('usuarios').upsert({ id: REAL, is_test_user: true }, { ignoreDuplicates: true }),
      'upsert en otra tabla, con un id ajeno y un dueño de QA': () => db.from('errores').upsert({ id: 999, usuario_id: QA }).select('id'),
    });
    expect(guard.altasRegistradas(B2)).toEqual({ intentos: 0, ids: [], cuerpos: [] });
  });

  it('la fila del alta es EXACTAMENTE { whatsapp: null, bsuid }', async () => {
    await bloqueados(Object.fromEntries(
      [{ nombre: 'María Quispe' }, { plan: 'premium' }, { gmail_access_token: 'x' }, { ref_code: 'X' }, { is_test_user: false }]
        .map((extra) => [JSON.stringify(extra), () => db.from('usuarios').insert({ whatsapp: null, bsuid: B2, ...extra })]),
    ));
  });

  it('una sola alta por declaración', async () => {
    proximoId = NUEVO2;
    expect((await corre(() => db.from('usuarios').insert({ whatsapp: null, bsuid: B2 }).select('id'))).paso).toBe(true);
    await bloqueados({ 'segunda alta con el mismo BSUID': () => db.from('usuarios').insert({ whatsapp: null, bsuid: B2 }).select('id') });
    expect(guard.altasRegistradas(B2).ids).toEqual([NUEVO2]);
  });

  it('después de nacer, un UPDATE no le puede dar número, email ni cuenta Google', async () => {
    await bloqueados({
      'le pone número': () => db.from('usuarios').update({ whatsapp: '51987654321' }).eq('id', NUEVO2),
      'le pone email': () => db.from('usuarios').update({ email: 'maria@gmail.com', recordatorios_activos: true }).eq('id', NUEVO2),
      'le pone cuenta Google': () => db.from('usuarios').update({ supabase_auth_id: REAL }).eq('id', NUEVO2),
    });
    // Lo que el alta sí escribe sigue pasando: si no, el harness bloquearía al código bajo prueba.
    expect((await corre(() => db.from('usuarios').update({ onboarding_paso: 100, nombre: 'Ana' }).eq('id', NUEVO2))).paso).toBe(true);
  });

  it('la adopción de `errores` no acepta otro operador sobre el BSUID ni otro destino', async () => {
    await bloqueados({
      '.lt sobre el BSUID (alcanza a todos los PE.<dígitos> reales)': () => db.from('errores').update({ usuario_id: NUEVO2 }).lt('bsuid', B2).is('usuario_id', null),
      '.gt sobre el BSUID': () => db.from('errores').update({ usuario_id: NUEVO2 }).gt('bsuid', B2).is('usuario_id', null),
      '.neq sobre el BSUID': () => db.from('errores').update({ usuario_id: NUEVO2 }).neq('bsuid', B2).is('usuario_id', null),
      'toma filas que ya tienen dueño (not.is.null)': () => db.from('errores').update({ usuario_id: NUEVO2 }).eq('bsuid', B2).not('usuario_id', 'is', null),
      'toma las filas de un real': () => db.from('errores').update({ usuario_id: NUEVO2 }).eq('bsuid', B2).eq('usuario_id', REAL),
      'se las da al usuario QA fijo y no a la fila de esa alta': () => db.from('errores').update({ usuario_id: QA }).eq('bsuid', B2).is('usuario_id', null),
    });
  });

  it('no deja declarar un BSUID con caracteres que viajan mal en una query', () => {
    for (const b of ['PE.qaXXXXXXXX&x', 'PE.qa.XXXXXXXX', 'PE.qaaltatest0001 ', 'PE.qaaltatest0001,x', 'PE.qaaltatest0001*']) {
      expect(() => guard.esperarAltaPorBsuid(b), b).toThrow(guard.QaGuardError);
    }
  });
});

// La segunda revisión adversarial del 12-sep, sobre el ARREGLO de la primera. Dos cosas que el
// arreglo había roto o dejado abiertas: prohibir todo upsert rompía al backend bajo prueba, y la
// fila sin marca se podía completar por las columnas que la barrera no enumeraba. Lo segundo se
// cerró invirtiendo la regla: la barrera marca la fila al nacer.
describe('qa-guard: la segunda vuelta (upsert del backend, marca al nacer, cuerpo que sale)', () => {
  const B3 = 'PE.qaaltatest0003';
  const NUEVO3 = '77777777-7777-4777-8777-777777777777';

  async function bloqueados(casos) {
    for (const [motivo, fn] of Object.entries(casos)) {
      const antes = recibidas.length;
      const r = await corre(fn);
      expect(r.paso, motivo).toBe(false);
      expect(recibidas.length, motivo + ': salió el request').toBe(antes);
    }
  }

  it('el upsert que usa el backend PASA: conflicto por columna de dueño, dueño de QA', async () => {
    // Las formas reales: services/budget.js, services/transactions.js, services/metas.js (logros).
    const casos = [
      () => db.from('presupuestos').upsert({ usuario_id: QA, categoria: 'X', monto_limite: 1 }, { onConflict: 'usuario_id,categoria,subcategoria,mes,anio' }).select().single(),
      () => db.from('reglas_comercio').upsert({ usuario_id: QA, comercio_pattern: 'tambo' }, { onConflict: 'usuario_id,comercio_pattern' }),
      () => db.from('logros').upsert({ usuario_id: QA, tipo: 't', meta_id: null }, { onConflict: 'usuario_id,tipo,meta_id', ignoreDuplicates: true }).select().single(),
      () => db.from('neto_scores').upsert({ user_id: QA, period: '2026-09' }, { onConflict: 'user_id,period' }),
    ];
    for (const fn of casos) {
      const antes = recibidas.length;
      expect((await corre(fn)).paso).toBe(true);
      expect(recibidas.length).toBe(antes + 1);
    }
  });

  it('el upsert que puede alcanzar una fila ajena sigue bloqueado', async () => {
    await bloqueados({
      'dueño real en la fila': () => db.from('presupuestos').upsert({ usuario_id: REAL, categoria: 'X' }, { onConflict: 'usuario_id,categoria' }),
      'conflicto por una columna que no es de dueño': () => db.from('presupuestos').upsert({ usuario_id: QA, categoria: 'X' }, { onConflict: 'categoria' }),
      'fila sin dueño': () => db.from('presupuestos').upsert({ categoria: 'X' }, { onConflict: 'usuario_id,categoria' }),
      // Sin on_conflict ni id no hay fila vieja que alcanzar, así que solo lo frena la exigencia de
      // dueño. Sin este caso, sacar esa exigencia dejaba la suite en verde (mutación G2).
      'fila sin dueño, sin on_conflict y sin id': () => db.from('presupuestos').upsert({ categoria: 'X' }),
      'sin on_conflict pero con id (conflicto por la clave primaria)': () => db.from('presupuestos').upsert({ id: 5, usuario_id: QA }),
      'dueño de QA en la fila y OTRO dueño en el conflicto': () => db.from('presupuestos').upsert({ usuario_id: QA, user_id: REAL }, { onConflict: 'user_id' }),
    });
  });

  it('un upsert se reconoce aunque solo lo delate el on_conflict (sin Prefer)', async () => {
    const antes = recibidas.length;
    const r = await corre(() => {
      const b = db.from('usuarios').upsert({ id: REAL, is_test_user: true }, { onConflict: 'id' });
      b.headers.delete('Prefer');
      return b;
    });
    expect(r.paso).toBe(false);
    expect(recibidas.length).toBe(antes);
  });

  it('la fila del alta no puede tomar una identidad, tampoco por `in.(…)` ni por el bsuid', async () => {
    guard.esperarAltaPorBsuid(B3);
    proximoId = NUEVO3;
    expect((await corre(() => db.from('usuarios').insert({ whatsapp: null, bsuid: B3 }).select('id'))).paso).toBe(true);
    await bloqueados({
      'le cambia el bsuid por uno real': () => db.from('usuarios').update({ bsuid: 'PE.1049206861029395' }).eq('id', NUEVO3),
      'número por in.(…)': () => db.from('usuarios').update({ whatsapp: '51987654321' }).in('id', [NUEVO3, QA]),
      'email por in.(…)': () => db.from('usuarios').update({ email: 'x@y.pe' }).in('id', [QA, NUEVO3]),
    });
    // Un throwaway que no nació por el alta sigue pudiendo recibir número: es lo que hacen los
    // harness que siembran con `whatsapp`. La regla es de la fila del alta, no de todos.
    expect((await corre(() => db.from('usuarios').update({ whatsapp: '51900000001' }).eq('id', QA))).paso).toBe(true);
  });

  it('si la marca no entra, el alta falla en vez de devolver una fila sin marca', async () => {
    const mudo = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // El INSERT devuelve la fila; la marca (PATCH) no toca ninguna.
      res.end(JSON.stringify(req.method === 'PATCH' ? [] : [{ id: '88888888-8888-4888-8888-888888888888' }]));
    });
    await new Promise((r) => mudo.listen(0, '127.0.0.1', r));
    try {
      const otro = guard.clienteGuardado('http://127.0.0.1:' + mudo.address().port, 'anon-de-mentira');
      const B4 = 'PE.qaaltatest0004';
      guard.esperarAltaPorBsuid(B4);
      const r = await corre(() => otro.from('usuarios').insert({ whatsapp: null, bsuid: B4 }).select('id'));
      expect(r.paso).toBe(false);
      expect(r.error).toMatch(/NO se pudo marcar/);
    } finally {
      await new Promise((r) => mudo.close(r));
    }
  });

  it('se valida el cuerpo que SALE: un getter o un toJSON no cambian lo que la barrera miró', async () => {
    const B5 = 'PE.qaaltatest0005';
    guard.esperarAltaPorBsuid(B5);
    let lecturas = 0;
    const tramposo = { bsuid: B5, get whatsapp() { lecturas += 1; return lecturas === 1 ? null : '51987654321'; } };
    // Con el snapshot, lo validado y lo enviado son el mismo objeto: la primera lectura (null) es
    // la que viaja, y el número no sale nunca.
    proximoId = '99999999-9999-4999-8999-999999999990';
    expect((await corre(() => db.from('usuarios').insert(tramposo).select('id'))).paso).toBe(true);
    expect(lecturas).toBe(1);
    const conToJSON = { whatsapp: null, bsuid: 'PE.qaaltatest0006' };
    guard.esperarAltaPorBsuid('PE.qaaltatest0006');
    Object.defineProperty(conToJSON, 'toJSON', { enumerable: false, value: () => ({ bsuid: 'PE.qaaltatest0006', nombre: 'María', plan: 'premium' }) });
    await bloqueados({ 'toJSON que agrega columnas': () => db.from('usuarios').insert(conToJSON) });
  });

  it('`schema()` devuelve un cliente que también pasa por la barrera', async () => {
    await bloqueados({
      'update sobre un real por schema': () => db.schema('public').from('usuarios').update({ plan: 'free' }).eq('id', REAL),
      'upsert sobre usuarios por schema': () => db.schema('public').from('usuarios').upsert({ id: REAL, is_test_user: true }),
    });
  });
});

// La tercera revisión adversarial del 12-sep. Nada de esto se dispara hoy por el backend: son
// puertas latentes que un harness nuevo podría abrir sin querer.
describe('qa-guard: la tercera vuelta (puertas latentes)', () => {
  async function bloqueados(casos) {
    for (const [motivo, fn] of Object.entries(casos)) {
      const antes = recibidas.length;
      const r = await corre(fn);
      expect(r.paso, motivo).toBe(false);
      expect(recibidas.length, motivo + ': salió el request').toBe(antes);
    }
  }

  it('un nombre de tabla con "/" no llega a un RPC destructivo por la puerta de las tablas', async () => {
    await bloqueados({
      'rpc/borrar_cuenta_total como tabla': () => db.from('rpc/borrar_cuenta_total').insert({ p_usuario_id: REAL }),
      'rpc/merge_and_link como tabla': () => db.from('rpc/merge_and_link').insert({ p_survivor: QA, p_loser: REAL }),
    });
  });

  it('`client.rest` (el PostgrestClient de abajo) también pasa por la barrera', async () => {
    await bloqueados({
      'update sobre un real por rest': () => db.rest.from('usuarios').update({ plan: 'premium', is_test_user: true }).eq('id', REAL),
      'delete de las transacciones de un real por rest': () => db.rest.from('transacciones').delete().eq('usuario_id', REAL),
    });
    // Y `client.from` sigue funcionando: delega en el `rest` envuelto, sin validar dos veces.
    const antes = recibidas.length;
    expect((await corre(() => db.from('transacciones').delete().eq('usuario_id', QA))).paso).toBe(true);
    expect(recibidas.length).toBe(antes + 1);
  });

  it('un alta cuyo INSERT no devuelve la fila se marca igual, por la forma', async () => {
    // Servidor propio que se porta como PostgREST con `return=minimal`: el INSERT vuelve VACÍO. El
    // falso de arriba devuelve una fila a todo POST, y con él este caso pasaba por la rama normal
    // (marca por id) sin tocar nunca la rama sin id: la mutación que la apaga sobrevivía.
    const NUEVO7 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7';
    const vistas = [];
    const minimo = http.createServer((req, res) => {
      vistas.push({ method: req.method, url: req.url });
      if (req.method === 'POST') { res.writeHead(201); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: NUEVO7 }]));
    });
    await new Promise((r) => minimo.listen(0, '127.0.0.1', r));
    try {
      const otro = guard.clienteGuardado('http://127.0.0.1:' + minimo.address().port, 'anon-de-mentira');
      const B7 = 'PE.qaaltatest0007';
      guard.esperarAltaPorBsuid(B7);
      const { data, error } = await otro.from('usuarios').insert({ whatsapp: null, bsuid: B7 });
      expect(error).toBeNull();
      expect(data).toBeNull(); // el INSERT de verdad no devolvió la fila
      expect(vistas.map((v) => v.method)).toEqual(['POST', 'PATCH']);
      const marca = decodeURIComponent(vistas[1].url);
      expect(marca).toContain('bsuid=eq.' + B7);
      expect(marca).toContain('whatsapp=is.null');
      // El parámetro `id`, no la subcadena: "bsuid=eq." también contiene "id=eq.".
      expect(marca).not.toMatch(/[?&]id=eq\./);
      expect(guard.altasRegistradas(B7)).toEqual({ intentos: 1, ids: [NUEVO7], cuerpos: [{ whatsapp: null, bsuid: B7 }] });
    } finally {
      await new Promise((r) => minimo.close(r));
    }
  });

  it('ningún UPDATE le quita la marca a una fila de prueba', async () => {
    await bloqueados({
      'is_test_user: false': () => db.from('usuarios').update({ is_test_user: false }).eq('id', QA),
      'is_test_user: null con plan': () => db.from('usuarios').update({ is_test_user: null, plan: 'premium' }).eq('id', QA),
    });
    expect((await corre(() => db.from('usuarios').update({ is_test_user: true }).eq('id', QA))).paso).toBe(true);
  });

  it('un upsert sin on_conflict no pasa, aunque la fila tenga dueño de QA y no traiga id', async () => {
    await bloqueados({ 'sin on_conflict': () => db.from('invite_codes').upsert({ code: 'X', creador_id: QA }) });
  });

  it('un INSERT de alta que falla (23505) no deja cuerpo ni fila registrada', async () => {
    const choque = http.createServer((req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "usuarios_bsuid_key"' }));
    });
    await new Promise((r) => choque.listen(0, '127.0.0.1', r));
    try {
      const otro = guard.clienteGuardado('http://127.0.0.1:' + choque.address().port, 'anon-de-mentira');
      const B8 = 'PE.qaaltatest0008';
      guard.esperarAltaPorBsuid(B8);
      const { error } = await otro.from('usuarios').insert({ whatsapp: null, bsuid: B8 }).select('id');
      expect(error && error.code).toBe('23505');
      expect(guard.altasRegistradas(B8)).toEqual({ intentos: 1, ids: [], cuerpos: [] });
    } finally {
      await new Promise((r) => choque.close(r));
    }
  });
});

describe('qa-guard: el test detecta la regresión', () => {
  // Contraprueba: sin la barrera, exactamente la misma llamada SÍ sale a la red.
  // Sin esto, el test de arriba podría estar verde porque la operación nunca se
  // ejecuta por cualquier otro motivo.
  it('sin guard, el DELETE del incidente llega al servidor', async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const crudo = createClient(base, 'anon-de-mentira', { auth: { persistSession: false } });
    const antes = recibidas.length;
    await crudo.from('transacciones').delete().eq('usuario_id', REAL);
    expect(recibidas.length).toBe(antes + 1);
    expect(recibidas[recibidas.length - 1].url).toContain('usuario_id=eq.' + REAL);
  });
});
