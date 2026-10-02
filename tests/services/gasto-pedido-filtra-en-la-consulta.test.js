import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

/**
 * EL GASTO QUE LA PERSONA DESCRIBE SE BUSCA EN LA CONSULTA, NO EN JS SOBRE UN RECORTE (02-oct-2026).
 *
 * `corregirTransaccionEspecifica` (el flujo `corregir_multiple`: "el taxi de 8.50 era salud") leía
 * los 10 gastos más recientes del comercio, filtraba monto y fecha en JS sobre esos 10 y, sin match,
 * corregía `txs[0]`. Con el pedido fuera de los 10, o con un monto que no calza con ninguno, el
 * UPDATE iba a OTRO gasto. `qElim` (`eliminar_transaccion`) tenía la misma forma con 20, pero fallaba
 * segura: contestaba "no encontré".
 *
 * ── Por qué este archivo NO usa los dobles de los demás ────────────────────────────────────────────
 * Los dobles de `transacciones-cero-filas`, `escrituras-de-plata` y `transacciones.test.js` devuelven
 * la tabla ENTERA en un `select` e ignoran `.limit`. Contra ellos el bug no existe: el código viejo
 * ve los 25 taxis, el filtro en JS encuentra el de S/ 8.50 y el caso sale verde. Lo que separa "filtra
 * antes del corte" de "filtra después" es que el corte ocurra, así que acá el cliente es supabase-js
 * REAL y el `fetch` es un PostgREST falso que evalúa filtros, orden y `limit` sobre una tabla en
 * memoria, con los tipos de la tabla real (`fecha` es `date`, `monto` es `numeric(10,2)`): un valor
 * que Postgres rechaza vuelve 400, como en producción.
 *
 * Lo que el falso no modela lo ANOTA en `sinModelar` y cada caso exige que esté vacío: un operador
 * nuevo en el código no puede pasar ignorado y dejar el caso verde por el motivo equivocado.
 */

// ─── El PostgREST falso ──────────────────────────────────────────────────────────────────────────

const TIPOS = { monto: 'numeric', monto_pen: 'numeric', fecha: 'date' };
const NUMERO = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

function esFecha(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function postgrestFalso(filasIniciales) {
  const tablas = {};
  for (const [t, filas] of Object.entries(filasIniciales)) tablas[t] = filas.map((f) => ({ ...f }));
  const pedidos = [];
  const sinModelar = [];
  let secuencia = 0;

  /** Valor de la fila contra el valor del filtro, con el tipo de la columna. Lanza 400 como Postgres. */
  const comparable = (col, valor) => {
    if (TIPOS[col] === 'numeric') {
      if (!NUMERO.test(valor) && valor !== 'NaN') throw { status: 400, code: '22P02', message: `invalid input syntax for type numeric: "${valor}"` };
      return Number(valor);
    }
    if (TIPOS[col] === 'date') {
      if (!esFecha(valor)) throw { status: 400, code: '22007', message: `invalid input syntax for type date: "${valor}"` };
    }
    return valor;
  };
  const deFila = (col, v) => (v === null || v === undefined ? null : TIPOS[col] === 'numeric' ? Number(v) : String(v));

  const filtro = (col, op, valor) => {
    if (op === 'ilike') {
      const re = new RegExp('^' + valor.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*').replace(/_/g, '.') + '$', 'i');
      return (f) => f[col] != null && re.test(String(f[col]));
    }
    if (op === 'not') {
      // Solo `not.in.(…)`, y la lista vacía no filtra nada (medido contra producción el 02-oct).
      const m = /^in\.\((.*)\)$/.exec(valor);
      if (!m) { sinModelar.push(col + '=not.' + valor.split('.')[0]); return () => true; }
      const lista = m[1] === '' ? [] : m[1].split(',');
      return (f) => !lista.includes(String(f[col]));
    }
    const cmp = { eq: (a, b) => a === b, gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b }[op];
    if (!cmp) { sinModelar.push(col + '=' + op); return () => true; }
    const b = comparable(col, valor);
    return (f) => { const a = deFila(col, f[col]); return a !== null && cmp(a, b); };
  };

  const ordenar = (filas, orden) => [...filas].sort((x, y) => {
    for (const { col, desc, nullsPrimero } of orden) {
      const a = deFila(col, x[col]), b = deFila(col, y[col]);
      if (a === b) continue;
      if (a === null) return nullsPrimero ? -1 : 1;
      if (b === null) return nullsPrimero ? 1 : -1;
      return (a < b ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
  /** `fecha.desc.nullslast`. Sin el tercer token, Postgres pone los NULL primero en DESC y al final en ASC. */
  const leerOrden = (s) => {
    const [col, dir, nulls] = s.split('.');
    if (nulls && nulls !== 'nullsfirst' && nulls !== 'nullslast') sinModelar.push('order ' + s);
    const desc = dir === 'desc';
    return { col, desc, nullsPrimero: nulls ? nulls === 'nullsfirst' : desc };
  };
  // Lo que el falso sabe hacer con `Prefer`. Otro valor (p. ej. `resolution=ignore-duplicates`, que
  // en Postgres es DO NOTHING) se anota: si no, el upsert lo pisaría igual y el caso saldría verde.
  const PREFER_MODELADO = new Set(['return=representation', 'return=minimal', 'count=exact', 'resolution=merge-duplicates', 'missing=default']);

  // `numeric` sale como NÚMERO JSON, como en producción (medido el 02-oct: `monto` 15 y 12.5, no
  // '15.00'). Con strings, un call-site que concatenara el monto crudo ("S/ 8.5") pasaba verde.
  const salida = (c, v) => (TIPOS[c] === 'numeric' && v != null ? Number(v) : v);
  const proyectar = (fila, columnas) => Object.fromEntries((columnas === '*' ? Object.keys(fila) : columnas.split(',')).map((c) => [c, salida(c, fila[c])]));

  async function fetchFalso(url, init = {}) {
    const u = new URL(String(url));
    const tabla = u.pathname.replace(/^\/rest\/v1\//, '');
    const metodo = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const cuerpo = init.body ? JSON.parse(init.body) : null;
    const params = [...u.searchParams.entries()];
    pedidos.push({ metodo, tabla, params, cuerpo });
    for (const p of (headers.get('prefer') || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!PREFER_MODELADO.has(p)) sinModelar.push('Prefer ' + p);
    }
    const responder = (status, body, extra = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
    try {
      let columnas = '*';
      let orden = [];
      let limite = null;
      let conflicto = null;
      const filtros = [];
      for (const [k, v] of params) {
        if (k === 'select') columnas = v;
        else if (k === 'order') orden = v.split(',').map(leerOrden);
        else if (k === 'limit') limite = Number(v);
        else if (k === 'on_conflict' && metodo === 'POST') conflicto = v.split(',');
        else if (k === 'columns' && metodo === 'POST') continue;
        else { const i = v.indexOf('.'); filtros.push(filtro(k, v.slice(0, i), v.slice(i + 1))); }
      }
      const filas = tablas[tabla] || (tablas[tabla] = []);
      const pasa = (f) => filtros.every((p) => p(f));
      const representacion = /return=representation/.test(headers.get('prefer') || '');
      const objeto = /vnd\.pgrst\.object/.test(headers.get('accept') || '');
      const entregar = (resultado) => {
        if (!objeto) return responder(200, resultado);
        if (resultado.length !== 1) return responder(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
        return responder(200, resultado[0]);
      };
      if (metodo === 'GET') {
        let res = ordenar(filas.filter(pasa), orden);
        if (limite !== null) res = res.slice(0, limite);
        return entregar(res.map((f) => proyectar(f, columnas)));
      }
      if (metodo === 'PATCH') {
        const tocadas = filas.filter(pasa);
        for (const f of tocadas) Object.assign(f, cuerpo);
        if (representacion) return entregar(tocadas.map((f) => proyectar(f, columnas)));
        // `update(…, { count: 'exact' })`: el conteo viaja en `content-range`, como en PostgREST.
        const conteo = /count=exact/.test(headers.get('prefer') || '')
          ? { 'content-range': (tocadas.length ? '0-' + (tocadas.length - 1) : '*') + '/' + tocadas.length } : {};
        return responder(204, undefined, conteo);
      }
      if (metodo === 'POST') {
        // Un upsert (`on_conflict`) pisa la fila que coincide en esas columnas; si no hay, inserta.
        const escritas = (Array.isArray(cuerpo) ? cuerpo : [cuerpo]).map((f) => {
          const previa = conflicto && filas.find((p) => conflicto.every((c) => p[c] === f[c]));
          if (previa) return Object.assign(previa, f);
          const nueva = { id: tabla + '-' + (++secuencia), ...f };
          filas.push(nueva);
          return nueva;
        });
        return representacion ? entregar(escritas.map((f) => proyectar(f, columnas))) : responder(201);
      }
      if (metodo === 'DELETE') {
        const borradas = filas.filter(pasa);
        tablas[tabla] = filas.filter((f) => !pasa(f));
        return representacion ? entregar(borradas.map((f) => proyectar(f, columnas))) : responder(204);
      }
      sinModelar.push('metodo ' + metodo);
      return responder(405, { message: 'no modelado' });
    } catch (e) {
      if (e && e.status) return responder(e.status, { code: e.code, message: e.message });
      throw e;
    }
  }

  return {
    fetch: fetchFalso,
    tablas,
    sinModelar,
    pedidos: (metodo, tabla) => pedidos.filter((p) => p.metodo === metodo && p.tabla === tabla),
    fila: (tabla, id) => (tablas[tabla] || []).find((f) => f.id === id),
  };
}

// ─── Carga: el servicio y el handler con un cliente real apuntado al falso ───────────────────────

const { createClient } = require('@supabase/supabase-js');
const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
const servicioPath = require.resolve(path.join(projectRoot, 'services/transactions.js'));
const handlerPath = require.resolve(path.join(projectRoot, 'handlers/intents/transacciones.js'));
// `transacciones.js` DESTRUCTURA `registrarError` al cargar: el espía va antes del require, o un
// catch del handler le pegaría a la tabla `errores` (ver `tests/handlers/transacciones.test.js`).
require('../../lib/error-monitor').registrarError = vi.fn();

let pg;
let servicio;
let handler;
function montar(filas) {
  pg = postgrestFalso(filas);
  const cliente = createClient('http://postgrest-falso.local', 'clave-falsa', { global: { fetch: pg.fetch } });
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: cliente } };
  delete require.cache[servicioPath];
  delete require.cache[handlerPath];
  servicio = require(servicioPath);
  handler = require(handlerPath);
  return cliente;
}

beforeEach(() => { pg = null; });
// Un operador que el falso no modela se ignora (pasa todo): sin esta guarda, un caso podría salir
// verde por eso y no por el código.
afterEach(() => { if (pg) expect(pg.sinModelar, 'el falso recibió algo que no modela').toEqual([]); });

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const diaAntes = (n) => new Date(Date.UTC(2026, 8, 30 - n)).toISOString().slice(0, 10);

/**
 * 25 taxis, uno por día hacia atrás desde el 30-sep. Todos de S/ 15 salvo el del puesto 11
 * (`taxi-10`), de S/ 8.50: exactamente el caso medido por la revisión adversarial del 01-oct.
 */
const VEINTICINCO_TAXIS = Array.from({ length: 25 }, (_, i) => ({
  id: 'taxi-' + i, usuario_id: 'u-1', comercio: 'Taxi', categoria: 'Transporte',
  monto: i === 10 ? '8.50' : '15.00', monto_pen: i === 10 ? '8.50' : '15.00', moneda: 'PEN',
  fecha: diaAntes(i), created_at: diaAntes(i) + 'T20:00:00',
}));
// De OTRA persona, más reciente que todos y del mismo monto: el control del `usuario_id`.
const TAXI_AJENO = { id: 'ajeno-850', usuario_id: 'u-2', comercio: 'Taxi', categoria: 'Transporte', monto: '8.50', monto_pen: '8.50', moneda: 'PEN', fecha: '2026-10-01', created_at: '2026-10-01T08:00:00' };

const actualizados = () => pg.pedidos('PATCH', 'transacciones');
const idDelPatch = (n = 0) => {
  const p = actualizados()[n];
  return p ? (p.params.find(([k]) => k === 'id') || [])[1] : undefined;
};

// ─── corregirTransaccionEspecifica ──────────────────────────────────────────────────────────────

describe('corregirTransaccionEspecifica · el gasto pedido se busca en la consulta', () => {
  it('el gasto pedido está FUERA de los 10 más recientes del comercio: corrige ESE, no el último', async () => {
    montar({ transacciones: [...VEINTICINCO_TAXIS, TAXI_AJENO] });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 8.5, null, 'Salud', null);
    expect(idDelPatch(), 'el UPDATE fue a otro gasto').toBe('eq.taxi-10');
    expect(actualizados()).toHaveLength(1);
    expect(res).toEqual({ ok: true, id: 'taxi-10', fecha: '2026-09-20', comercio: 'Taxi', monto: 8.5, moneda: 'PEN' });
    expect(pg.fila('transacciones', 'taxi-10').categoria).toBe('Salud');
    expect(pg.fila('transacciones', 'taxi-0').categoria, 'el taxi de S/ 15 no se pidió').toBe('Transporte');
    expect(pg.fila('transacciones', 'ajeno-850').categoria, 'el gasto de otra persona').toBe('Transporte');
    expect(pg.sinModelar).toEqual([]);
  });

  it('un monto que no calza con NINGUNO no corrige nada: "no encontré", sin motivo', async () => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 9.9, null, 'Salud', null);
    expect(res).toEqual({ ok: false, comercio: 'taxi' });
    expect(actualizados(), 'escribió sobre otro gasto').toHaveLength(0);
    expect(pg.sinModelar).toEqual([]);
  });

  it('una fecha que no calza con ninguno tampoco corrige nada', async () => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', null, '2026-01-15', 'Salud', null);
    expect(res).toEqual({ ok: false, comercio: 'taxi' });
    expect(actualizados()).toHaveLength(0);
  });

  it('la fecha también se busca fuera de los 10: corrige el del día pedido', async () => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', null, diaAntes(15), 'Salud', null);
    expect(res.ok).toBe(true);
    expect(idDelPatch()).toBe('eq.taxi-15');
  });

  it('monto Y fecha juntos tienen que calzar los dos', async () => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    // el de S/ 8.50 existe, pero no ese día
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 8.5, diaAntes(3), 'Salud', null);
    expect(res).toEqual({ ok: false, comercio: 'taxi' });
    expect(actualizados()).toHaveLength(0);
  });

  it('con varios que calzan corrige el más reciente POR FECHA, aunque otro se haya anotado después', async () => {
    // `taxi-14` es de una fecha más vieja pero se anotó hoy (un gasto atrasado): si el orden fuera
    // por `created_at`, o no hubiera orden por fecha, ganaría él.
    const filas = VEINTICINCO_TAXIS.map((f) => (f.id === 'taxi-14' ? { ...f, monto: '8.50', monto_pen: '8.50', created_at: '2026-10-01T09:00:00' } : f));
    montar({ transacciones: filas });
    await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 8.5, null, 'Salud', null);
    expect(idDelPatch()).toBe('eq.taxi-10');
  });

  it('la tolerancia es de medio sol, estricta: 8.20 encuentra el de 8.50 y 9.00 no', async () => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    const cerca = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 8.2, null, 'Salud', null);
    expect(cerca.ok).toBe(true);
    expect(idDelPatch()).toBe('eq.taxi-10');
    const borde = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 9, null, 'Salud', null);
    expect(borde).toEqual({ ok: false, comercio: 'taxi' });
    expect(actualizados()).toHaveLength(1);
  });

  it('y entre dos del MISMO día, el último anotado', async () => {
    // El anotado primero va primero en la tabla: sin el desempate por `created_at`, el orden
    // estable del falso devolvería ese, así que el caso muere si se quita el desempate.
    const temprano = { id: 'menu-mediodia', usuario_id: 'u-1', comercio: 'Menú', categoria: 'Otros', monto: '12.00', monto_pen: '12.00', moneda: 'PEN', fecha: '2026-09-29', created_at: '2026-09-29T13:00:00' };
    const tarde = { ...temprano, id: 'menu-noche', created_at: '2026-09-29T20:30:00' };
    montar({ transacciones: [temprano, tarde] });
    await servicio.corregirTransaccionEspecifica('u-1', 'menú', null, '2026-09-29', 'Comida', null);
    expect(idDelPatch()).toBe('eq.menu-noche');
  });

  it('control: sin monto ni fecha sigue corrigiendo el más reciente del comercio', async () => {
    montar({ transacciones: [...VEINTICINCO_TAXIS, TAXI_AJENO] });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', null, null, 'Salud', null);
    expect(res.ok).toBe(true);
    expect(idDelPatch()).toBe('eq.taxi-0');
  });

  it('el monto como texto ("8.50") se lee igual que el número', async () => {
    // Sin normalizar, `'8.50' + 0.5` es '8.500.5' y Postgres rechaza el filtro: la corrección
    // salía "no pude corregirlo ahora mismo" sobre un gasto que existe.
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', '8.50', null, 'Salud', null);
    expect(res.ok).toBe(true);
    expect(idDelPatch()).toBe('eq.taxi-10');
  });

  it.each([
    ['una fecha que no existe', null, '2026-02-30'],
    ['un mes 13 (que hace lanzar a toISOString)', null, '2026-13-45'],
    ['una fecha en palabras', null, 'ayer'],
    ['un monto en palabras', 'ocho', null],
  ])('%s: no corrige nada, no consulta y no lanza', async (_n, monto, fecha) => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', monto, fecha, 'Salud', null);
    expect(res).toEqual({ ok: false, comercio: 'taxi', motivo: 'ilegible' });
    expect(actualizados()).toHaveLength(0);
    // Ni siquiera se lee: descartar el dato y buscar sin él es corregir el último, o sea otro.
    expect(pg.pedidos('GET', 'transacciones')).toHaveLength(0);
  });

  it('en USD devuelve el monto de la fila, no el equivalente en soles', async () => {
    montar({ transacciones: [{ id: 'nf-1', usuario_id: 'u-1', comercio: 'Netflix', categoria: 'Otros', monto: '15.99', monto_pen: '59.96', moneda: 'USD', fecha: '2026-09-20', created_at: '2026-09-20T09:00:00' }] });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'netflix', 15.99, null, 'Entretenimiento', null);
    expect(res).toEqual({ ok: true, id: 'nf-1', fecha: '2026-09-20', comercio: 'Netflix', monto: 15.99, moneda: 'USD' });
  });

  it('el monto EXACTO le gana a uno más reciente dentro de la tolerancia', async () => {
    // Con Cabify de 15.01 a 15.21, "el de 15.03" corregía el de 15.01: más reciente y a dos
    // centavos. Lo encontró el E2E contra la base real; acá, 8.30 reciente contra 8.50 exacto.
    const cerca = { ...VEINTICINCO_TAXIS[0], id: 'taxi-830', monto: '8.30', monto_pen: '8.30', fecha: '2026-10-01', created_at: '2026-10-01T10:00:00' };
    montar({ transacciones: [cerca, ...VEINTICINCO_TAXIS] });
    await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 8.5, null, 'Salud', null);
    expect(idDelPatch()).toBe('eq.taxi-10');
    // y sin exacto, la tolerancia sigue: "el de 8.40" encuentra el más reciente a menos de 50 céntimos
    await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 8.4, null, 'Salud', null);
    expect(idDelPatch(1)).toBe('eq.taxi-830');
  });

  it('el borde de la tolerancia no depende del float: 8.20 no alcanza al de 7.70', async () => {
    // `8.2 - 0.5` en float es 7.699999999999999, y el de 7.70 (más reciente) entraba.
    const casi = { ...VEINTICINCO_TAXIS[0], id: 'taxi-770', monto: '7.70', monto_pen: '7.70', fecha: '2026-10-01', created_at: '2026-10-01T10:00:00' };
    montar({ transacciones: [casi, ...VEINTICINCO_TAXIS] });
    await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 8.2, null, 'Salud', null);
    expect(idDelPatch()).toBe('eq.taxi-10');
  });

  it('un monto legible con una fecha ilegible tampoco busca solo por monto', async () => {
    // Descartar la fecha y quedarse con "el de 15" es corregir el último de S/ 15, o sea otro.
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 15, '2026-09-31', 'Salud', null);
    expect(res).toEqual({ ok: false, comercio: 'taxi', motivo: 'ilegible' });
    expect(pg.pedidos('GET', 'transacciones')).toHaveLength(0);
    expect(actualizados()).toHaveLength(0);
  });

  it('monto 0 es "no lo dijo", como antes: corrige el más reciente del comercio', async () => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 0, null, 'Salud', null);
    expect(res.ok).toBe(true);
    expect(idDelPatch()).toBe('eq.taxi-0');
  });

  it.each(['*', '%', '_', ' % '])('un comercio que es solo un comodín (%j) no corrige nada ni consulta', async (comercio) => {
    montar({ transacciones: [...VEINTICINCO_TAXIS, TAXI_AJENO] });
    const res = await servicio.corregirTransaccionEspecifica('u-1', comercio, 8.5, null, 'Salud', null);
    expect(res).toEqual({ ok: false, comercio, motivo: 'ilegible' });
    expect(pg.pedidos('GET', 'transacciones')).toHaveLength(0);
  });

  it('un monto ENTERO es un redondeo: va directo a la tolerancia y gana el más reciente', async () => {
    // Tercera revisión: con el exacto primero, "el uber de 20" corregía un 20.00 de mayo sobre el
    // 20.40 de ayer. Con céntimos escritos el exacto sigue primero (ver el caso del 8.30/8.50).
    const uber = (id, monto, fecha) => ({ id, usuario_id: 'u-1', comercio: 'Uber', categoria: 'Otros', monto, monto_pen: monto, moneda: 'PEN', fecha, created_at: fecha + 'T12:00:00' });
    montar({ transacciones: [uber('u-mayo', '20.00', '2026-05-10'), uber('u-1890', '18.90', '2026-09-25'), uber('u-ayer', '20.40', '2026-10-01')] });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'uber', 20, null, 'Trabajo', null);
    expect(res.id).toBe('u-ayer');
  });

  it.each([['S/ 8.50'], ['8,50'], [' 8.5 ']])('el monto como lo escribe la gente (%j) se lee', async (monto) => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', monto, null, 'Salud', null);
    expect(res.id).toBe('taxi-10');
  });

  it('"null" como texto en monto o fecha es "no lo dijo"', async () => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 'null', 'null', 'Salud', null);
    expect(res.id).toBe('taxi-0');
  });

  it('los ids ya corregidos en el mensaje quedan fuera: la segunda corrección toma el siguiente', async () => {
    const t = (id, created_at) => ({ id, usuario_id: 'u-1', comercio: 'Taxi', categoria: 'Transporte', monto: '15.00', monto_pen: '15.00', moneda: 'PEN', fecha: '2026-10-01', created_at });
    montar({ transacciones: [t('t-a', '2026-10-01T08:00:00'), t('t-b', '2026-10-01T19:00:00')] });
    const primera = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 15, '2026-10-01', 'Salud', null, []);
    const segunda = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 15, '2026-10-01', 'Trabajo', null, [primera.id]);
    expect([primera.id, segunda.id]).toEqual(['t-b', 't-a']);
    const tercera = await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 15, '2026-10-01', 'Ocio', null, [primera.id, segunda.id]);
    expect(tercera).toEqual({ ok: false, comercio: 'taxi' });
  });

  it('el comercio con espacios de más se busca como se guarda', async () => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    const res = await servicio.corregirTransaccionEspecifica('u-1', '  taxi ', 8.5, null, 'Salud', null);
    expect(res.id).toBe('taxi-10');
  });
});

// ─── corregir_multiple: lo que lee la persona ───────────────────────────────────────────────────

describe('corregir_multiple · cada línea es UNA fila, y la tabla lo confirma', () => {
  /**
   * La regla y la retroaplicación van REALES aunque esta rama ya no las llame: si alguien las vuelve a
   * cablear, los casos que afirman "una fila" y "sin regla" se ponen rojos. Mockeadas (como la primera
   * versión de este archivo) escondían que "el taxi de 8.50 era salud" movía los 25 taxis.
   */
  const correr = async (filas, correcciones, extras = {}) => {
    montar({ transacciones: filas, reglas_comercio: [] });
    const ctx = {
      supabase: null, // el handler no lee por acá en este flujo; si lo hiciera, revienta y se ve
      parsearCorreccionesMultiples: vi.fn().mockResolvedValue(correcciones),
      corregirTransaccionEspecifica: servicio.corregirTransaccionEspecifica,
      asegurarCategoriaUsuario: vi.fn().mockResolvedValue('creada'),
      crearSubcategoriaLibreUsuario: vi.fn(),
      guardarReglaComercio: vi.fn(servicio.guardarReglaComercio),
      retroaplicarRegla: vi.fn(servicio.retroaplicarRegla),
      historialConv: [],
      ...extras,
    };
    const res = await handler.handle({ intencion: 'corregir_multiple', msg: 'el taxi de 8.50 era salud', datos: {}, usuario: { id: 'u-1', plan: 'premium' }, from: '+51999', ctx });
    return { res, ctx };
  };
  const enCategoria = (cat) => pg.tablas.transacciones.filter((f) => f.usuario_id === 'u-1' && f.categoria === cat).map((f) => f.id);

  it('con monto: corrige EL gasto pedido, con su fecha en la línea, y nada más', async () => {
    const { res, ctx } = await correr(VEINTICINCO_TAXIS, [{ comercio: 'taxi', monto: 8.5, fecha: null, categoria_nueva: 'Salud' }]);
    expect(res).toBe('Listo! Apliqué 1 corrección:\n\n✅ *Taxi* (S/ 8.50 · 2026-09-20) → Salud');
    expect(enCategoria('Salud'), 'la línea dice uno: la tabla tiene que tener uno').toEqual(['taxi-10']);
    expect(pg.tablas.reglas_comercio).toEqual([]);
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
    expect(ctx.asegurarCategoriaUsuario).toHaveBeenCalledWith('u-1', 'Salud');
  });

  it('sin monto ni fecha: corrige el más reciente del comercio y SOLO ese (sin regla ni retroaplicación)', async () => {
    const { res, ctx } = await correr(VEINTICINCO_TAXIS, [{ comercio: 'taxi', monto: null, fecha: null, categoria_nueva: 'Salud' }]);
    expect(res).toBe('Listo! Apliqué 1 corrección:\n\n✅ *Taxi* (S/ 15.00 · 2026-09-30) → Salud\n\n_Moví solo el más reciente de ese comercio. Para que todos vayan ahí, escríbeme "todo lo de [comercio] va en [categoría]"._');
    expect(enCategoria('Salud')).toEqual(['taxi-0']);
    expect(pg.tablas.reglas_comercio).toEqual([]);
    expect(ctx.guardarReglaComercio).not.toHaveBeenCalled();
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
  });

  it('dos correcciones que calzan con la MISMA fila: la segunda toma otra, y la tabla tiene las dos', async () => {
    // "Los dos taxis de 15 de ayer, uno salud y el otro trabajo": antes los dos UPDATE iban al mismo.
    const t = (id, created_at) => ({ id, usuario_id: 'u-1', comercio: 'Taxi', categoria: 'Transporte', monto: '15.00', monto_pen: '15.00', moneda: 'PEN', fecha: '2026-10-01', created_at });
    const { res } = await correr([t('t-a', '2026-10-01T08:00:00'), t('t-b', '2026-10-01T19:00:00')], [
      { comercio: 'taxi', monto: 15, fecha: '2026-10-01', categoria_nueva: 'Salud' },
      { comercio: 'taxi', monto: 15, fecha: '2026-10-01', categoria_nueva: 'Entretenimiento' },
    ]);
    expect(res).toBe('Listo! Apliqué 2 correcciones:\n\n✅ *Taxi* (S/ 15.00 · 2026-10-01) → Salud\n✅ *Taxi* (S/ 15.00 · 2026-10-01) → Entretenimiento');
    expect(enCategoria('Salud')).toEqual(['t-b']);
    expect(enCategoria('Entretenimiento')).toEqual(['t-a']);
  });

  it('por tolerancia tampoco vuelve a la misma: "el de 8.50 a salud y el de 8.40 a ocio" toca dos filas', async () => {
    const otro = { ...VEINTICINCO_TAXIS[0], id: 'taxi-830', monto: '8.30', monto_pen: '8.30', fecha: '2026-09-19', created_at: '2026-09-19T12:00:00' };
    const { res } = await correr([...VEINTICINCO_TAXIS, otro], [
      { comercio: 'taxi', monto: 8.5, fecha: null, categoria_nueva: 'Salud' },
      { comercio: 'taxi', monto: 8.4, fecha: null, categoria_nueva: 'Entretenimiento' },
    ]);
    expect(res).toBe('Listo! Apliqué 2 correcciones:\n\n✅ *Taxi* (S/ 8.50 · 2026-09-20) → Salud\n✅ *Taxi* (S/ 8.30 · 2026-09-19) → Entretenimiento');
    expect(enCategoria('Salud')).toEqual(['taxi-10']);
    expect(enCategoria('Entretenimiento')).toEqual(['taxi-830']);
  });

  it('sin match: "no encontré" con lo que se buscó, sin categoría nueva, y la cabecera no afirma un cambio', async () => {
    const { res, ctx } = await correr(VEINTICINCO_TAXIS, [{ comercio: 'taxi', monto: 9.9, fecha: '2026-09-28', categoria_nueva: 'Mascotas' }]);
    expect(res).toBe('No pude aplicar ninguna:\n\n❌ No encontré gasto de *taxi* (9.90 · 2026-09-28)');
    expect(actualizados()).toHaveLength(0);
    expect(ctx.asegurarCategoriaUsuario, 'creaba "Mascotas" en el árbol sin haber movido nada').not.toHaveBeenCalled();
  });

  it('mezcla: la cabecera cuenta las aplicadas, no las líneas', async () => {
    const { res } = await correr(VEINTICINCO_TAXIS, [
      { comercio: 'taxi', monto: 8.5, fecha: null, categoria_nueva: 'Salud' },
      { comercio: 'taxi', monto: 9.9, fecha: null, categoria_nueva: 'Salud' },
    ]);
    expect(res).toBe('Apliqué 1 de 2 correcciones:\n\n✅ *Taxi* (S/ 8.50 · 2026-09-20) → Salud\n❌ No encontré otro gasto de *taxi* (9.90) aparte de los que ya moví');
  });

  it.each([
    ['error', '⚠️ No pude corregir el gasto de *Starbucks* ahora mismo'],
    ['desaparecido', '🚫 Ese gasto de *Starbucks* ya no está'],
  ])('motivo %s: la cabecera tampoco afirma un cambio', async (motivo, linea) => {
    const { res } = await correr([], [{ comercio: 'Starbucks', monto: null, fecha: null, categoria_nueva: 'Transporte' }], {
      corregirTransaccionEspecifica: vi.fn().mockResolvedValue({ ok: false, comercio: 'Starbucks', motivo }),
    });
    expect(res).toBe('No pude aplicar ninguna:\n\n' + linea);
  });

  it('un monto ilegible no dice "no encontré": no se buscó nada', async () => {
    const { res } = await correr(VEINTICINCO_TAXIS, [{ comercio: 'taxi', monto: 'ocho cincuenta', fecha: null, categoria_nueva: 'Salud' }]);
    expect(res).toBe('No pude aplicar ninguna:\n\n❓ No entendí qué gasto de *taxi* es: dime el monto (ej. 8.50) o la fecha');
    expect(pg.pedidos('GET', 'transacciones')).toHaveLength(0);
  });

  it('un monto 0 no se nombra en el "no encontré": no se buscó', async () => {
    const { res } = await correr(VEINTICINCO_TAXIS, [{ comercio: 'netflix', monto: 0, fecha: null, categoria_nueva: 'Entretenimiento' }]);
    expect(res).toBe('No pude aplicar ninguna:\n\n❌ No encontré gasto de *netflix*');
  });

  it('en USD la línea muestra los dólares de la fila', async () => {
    const netflix = { id: 'nf-1', usuario_id: 'u-1', comercio: 'Netflix', categoria: 'Otros', monto: '15.99', monto_pen: '59.96', moneda: 'USD', fecha: '2026-09-20', created_at: '2026-09-20T09:00:00' };
    const { res } = await correr([netflix], [{ comercio: 'netflix', monto: 15.99, fecha: null, categoria_nueva: 'Entretenimiento' }]);
    expect(res).toBe('Listo! Apliqué 1 corrección:\n\n✅ *Netflix* ($15.99 · 2026-09-20) → Entretenimiento');
  });

  it('un comercio que no es texto se descarta ANTES de escribir, y las demás correcciones corren', async () => {
    // `comercio: 7` corregía el 7-Eleven y después hacía lanzar a la regla: "hubo un error" sobre
    // un cambio hecho, y la corrección del taxi nunca corría.
    const siete = { id: 'siete', usuario_id: 'u-1', comercio: '7-Eleven', categoria: 'Otros', monto: '5.00', monto_pen: '5.00', moneda: 'PEN', fecha: '2026-09-30', created_at: '2026-09-30T23:00:00' };
    const { res } = await correr([...VEINTICINCO_TAXIS, siete], [
      { comercio: 7, monto: null, fecha: null, categoria_nueva: 'Comida' },
      { comercio: 'taxi', monto: 8.5, fecha: null, categoria_nueva: 'Salud' },
    ]);
    expect(res).toBe('Apliqué 1 de 2 correcciones:\n\n✅ *Taxi* (S/ 8.50 · 2026-09-20) → Salud\n❓ Una de las correcciones no la entendí: dime el comercio y la categoría');
    expect(pg.fila('transacciones', 'siete').categoria).toBe('Otros');
  });

  it('nombres que se contienen: "uber" no se lleva el Uber Eats que nombra la corrección siguiente', async () => {
    const fila = (id, comercio, fecha) => ({ id, usuario_id: 'u-1', comercio, categoria: 'Otros', monto: '15.00', monto_pen: '15.00', moneda: 'PEN', fecha, created_at: fecha + 'T12:00:00' });
    const { res } = await correr([fila('ue', 'Uber Eats', '2026-10-01'), fila('ub', 'Uber', '2026-09-30')], [
      { comercio: 'uber', monto: 15, fecha: null, categoria_nueva: 'Transporte' },
      { comercio: 'uber eats', monto: 15, fecha: null, categoria_nueva: 'Alimentación' },
    ]);
    expect(res).toBe('Listo! Apliqué 2 correcciones:\n\n✅ *Uber Eats* (S/ 15.00 · 2026-10-01) → Alimentación\n✅ *Uber* (S/ 15.00 · 2026-09-30) → Transporte');
    expect(pg.fila('transacciones', 'ue').categoria).toBe('Alimentación');
    expect(pg.fila('transacciones', 'ub').categoria).toBe('Transporte');
  });

  it('el mismo gasto pedido dos veces: la segunda no niega que exista, dice "otro"', async () => {
    const { res } = await correr(VEINTICINCO_TAXIS, [
      { comercio: 'taxi', monto: 8.5, fecha: null, categoria_nueva: 'Salud' },
      { comercio: 'taxi', monto: 8.5, fecha: null, categoria_nueva: 'Entretenimiento' },
    ]);
    expect(res).toBe('Apliqué 1 de 2 correcciones:\n\n✅ *Taxi* (S/ 8.50 · 2026-09-20) → Salud\n❌ No encontré otro gasto de *taxi* (8.50) aparte de los que ya moví');
    expect(enCategoria('Salud')).toEqual(['taxi-10']);
  });

  it('un comercio que es solo un comodín no se nombra (rompía la negrita) ni se busca', async () => {
    const { res } = await correr(VEINTICINCO_TAXIS, [{ comercio: '*', monto: 8.5, fecha: null, categoria_nueva: 'Salud' }]);
    expect(res).toBe('No pude aplicar ninguna:\n\n❓ No entendí de qué comercio es una de las correcciones');
    expect(pg.pedidos('GET', 'transacciones')).toHaveLength(0);
  });

  it('una subcategoría "null" como texto no se escribe', async () => {
    const { ctx } = await correr(VEINTICINCO_TAXIS, [{ comercio: 'taxi', monto: 8.5, fecha: null, categoria_nueva: 'Salud', subcategoria_nueva: 'null' }]);
    expect(pg.fila('transacciones', 'taxi-10').subcategoria).toBeUndefined();
    expect(ctx.crearSubcategoriaLibreUsuario).not.toHaveBeenCalled();
  });
});

describe('leerPedidoCorreccion · lo que pidió la persona, leído una vez', () => {
  // Pura: no toca la base. Se carga del módulo real sin montar nada.
  const leer = (m, f) => require(servicioPath).leerPedidoCorreccion(m, f);
  it.each([
    [8.5, 8.5], ['8.50', 8.5], ['S/ 8.50', 8.5], ['s/.8,50', 8.5], ['1,234.50', 1234.5], [0, null], ['', null], ['null', null], [null, null],
    [0.015, 0.02], // a centavos UNA vez: la etiqueta y la búsqueda dicen lo mismo
  ])('%j → %j', (monto, esperado) => {
    const r = leer(monto, null);
    expect(r.legible).toBe(true);
    expect(r.monto).toBe(esperado);
  });
  it.each([['0x10'], ['1e1'], ['ocho'], [true], [{}], [NaN]])('%j no es un monto: ilegible, no otro número', (monto) => {
    expect(leer(monto, null).legible).toBe(false);
  });
  it('fecha: "NULL" es "no lo dijo"; una que no existe es ilegible', () => {
    expect(leer(null, 'NULL')).toEqual({ monto: null, fecha: null, legible: true });
    expect(leer(null, '2026-02-30').legible).toBe(false);
  });
});

describe('el instrumento', () => {
  it('una fila con fecha NULL no le gana al más reciente con fecha', async () => {
    // En DESC Postgres pone los NULL primero; la consulta pide `nullslast`.
    const sinFecha = { ...VEINTICINCO_TAXIS[10], id: 'taxi-sin-fecha', fecha: null, created_at: '2025-01-01T00:00:00' };
    montar({ transacciones: [sinFecha, ...VEINTICINCO_TAXIS] });
    await servicio.corregirTransaccionEspecifica('u-1', 'taxi', 8.5, null, 'Salud', null);
    expect(idDelPatch()).toBe('eq.taxi-10');
  });

  it('el falso ANOTA lo que no modela (un operador, un Prefer, un orden), en vez de dejarlo pasar', async () => {
    montar({ transacciones: VEINTICINCO_TAXIS });
    await pg.fetch('http://x/rest/v1/transacciones?monto=in.(1,2)&order=fecha.desc.raro', {});
    await pg.fetch('http://x/rest/v1/reglas_comercio', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: '{}' });
    expect(pg.sinModelar).toEqual(['monto=in', 'order fecha.desc.raro', 'Prefer resolution=ignore-duplicates']);
    pg.sinModelar.length = 0; // el afterEach exige vacío: este caso es justo el que lo llena a propósito
  });
});

// ─── eliminar_transaccion (`qElim`): el mismo patrón ───────────────────────────────────────────

describe('eliminar_transaccion · el monto se busca en la consulta', () => {
  /** 30 taxis, el más reciente primero por `created_at`; `objetivo` es el índice del de S/ 8.50. */
  const treintaTaxis = (objetivo) => Array.from({ length: 30 }, (_, i) => ({
    id: 'taxi-' + i, usuario_id: 'u-1', comercio: 'Taxi', categoria: 'Transporte', descripcion_original: null,
    monto: i === objetivo ? '8.50' : '15.00', monto_pen: i === objetivo ? '8.50' : '15.00', moneda: 'PEN',
    fecha: diaAntes(i), created_at: diaAntes(i) + 'T20:00:00',
  }));
  const borrar = async (filas, msg, datos) => {
    const cliente = montar({ transacciones: filas, transacciones_eliminadas: [] });
    const ctx = { supabase: cliente, obtenerUltimaTransaccion: vi.fn(), formatFecha: (f) => f, historialConv: [] };
    return handler.handle({ intencion: 'eliminar_transaccion', msg, datos, usuario: { id: 'u-1', plan: 'premium' }, from: '+51999', ctx });
  };

  it('el gasto pedido está más atrás que los 20 más recientes: lo encuentra y borra ESE', async () => {
    const res = await borrar(treintaTaxis(25), 'borra el taxi de 8.50', { comercio: 'taxi', monto: 8.5 });
    expect(res).toMatch(/^Listo\. Eliminé \*Taxi\* \(S\/ 8\.50\)/);
    const borrados = pg.pedidos('DELETE', 'transacciones');
    expect(borrados).toHaveLength(1);
    expect(borrados[0].params).toContainEqual(['id', 'eq.taxi-25']);
    expect(pg.sinModelar).toEqual([]);
  });

  it('con el tope lleno no afirma un total: "al menos 20"', async () => {
    const res = await borrar(treintaTaxis(-1), 'borra el taxi de 15', { comercio: 'taxi', monto: 15 });
    expect(res).toMatch(/^Encontré al menos 20 gastos que coinciden/);
    expect(pg.pedidos('DELETE', 'transacciones')).toHaveLength(0);
  });

  it('control: por debajo del tope dice cuántos son', async () => {
    const res = await borrar(treintaTaxis(-1).slice(0, 3), 'borra el taxi de 15', { comercio: 'taxi', monto: 15 });
    expect(res).toMatch(/^Encontré 3 gastos que coinciden/);
  });

  it('el monto es el mismo centavo: "borra el de 0.15" no alcanza al de 0.14', async () => {
    // `0.15 - 0.01` en float es 0.13999999999999999: el filtro viejo dejaba entrar el vecino.
    const kiosko = (id, monto) => ({ id, usuario_id: 'u-1', comercio: 'Kiosko', categoria: 'Otros', descripcion_original: null, monto, monto_pen: monto, moneda: 'PEN', fecha: '2026-09-30', created_at: '2026-09-30T10:00:00' });
    const solo014 = await borrar([kiosko('k-14', '0.14')], 'borra el kiosko de 0.15', { comercio: 'kiosko', monto: 0.15 });
    expect(solo014).toMatch(/^No encontré ningún gasto que coincida/);
    expect(pg.pedidos('DELETE', 'transacciones')).toHaveLength(0);
    const tres = await borrar([kiosko('k-14', '0.14'), kiosko('k-15', '0.15'), kiosko('k-16', '0.16')], 'borra el kiosko de 0.15', { comercio: 'kiosko', monto: 0.15 });
    expect(tres).toMatch(/^Listo\. Eliminé \*Kiosko\* \(S\/ 0\.15\)/);
    expect(pg.pedidos('DELETE', 'transacciones')[0].params).toContainEqual(['id', 'eq.k-15']);
  });

  it('control: un monto que no existe sigue siendo "no encontré" y no borra nada', async () => {
    const res = await borrar(treintaTaxis(25), 'borra el taxi de 9.90', { comercio: 'taxi', monto: 9.9 });
    expect(res).toMatch(/^No encontré ningún gasto que coincida/);
    expect(pg.pedidos('DELETE', 'transacciones')).toHaveLength(0);
  });
});
