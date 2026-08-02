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
