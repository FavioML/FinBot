import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

/**
 * UN NOMBRE DICHO ESCRIBE SOLO SOBRE LA FILA QUE NOMBRA (02-oct-2026, `lib/resolver-nombre.js`).
 *
 * La guarda de `lib/datos-dichos.js` cerró los datos que el mensaje no dice y declaró fuera la
 * RESOLUCIÓN de filas: con un nombre que sí está en el mensaje, el handler escribía igual sobre otra
 * fila. Medido ejecutando en la revisión de ese día: "elimina la meta moto" (con Laptop y Viaje Cusco)
 * borraba Laptop, "recupera el gasto de la pizza" restauraba otro, "salda todo con Luis" saldaba a
 * Luisa y la regla "lina" se retroaplicaba a "gasolina".
 *
 * La regla (Favio, 02-oct): exacto primero; si no, por palabra entera; un nombre → ese; varios →
 * pregunta; ninguno → no escribe; sin nombre con varias filas → pregunta.
 *
 * ── Por qué este archivo no usa los dobles de los demás ───────────────────────────────────────────
 * Los dobles de la suite IGNORAN `ilike` y devuelven la tabla entera: contra ellos "Luis" no alcanza
 * a "Luisa" porque el doble no filtra nada, y el bug de subcadena no existe. Acá el cliente es
 * supabase-js REAL contra un PostgREST falso que evalúa `ilike` (con `*` y `%` como comodín, como el
 * servidor), `imatch`, `in`, `is`, el orden y la paginación. Es el falso de
 * `tests/services/gasto-pedido-filtra-en-la-consulta.test.js` con esos operadores agregados; lo que
 * no modela lo anota en `sinModelar` y cada caso exige que quede vacío.
 */

// ─── El PostgREST falso ──────────────────────────────────────────────────────────────────────────

function postgrestFalso(filasIniciales) {
  const tablas = {};
  for (const [t, filas] of Object.entries(filasIniciales)) tablas[t] = filas.map((f) => JSON.parse(JSON.stringify(f)));
  const pedidos = [];
  const sinModelar = [];
  let secuencia = 0;

  // `snapshot->>comercio`: la columna JSON, como texto.
  const leer = (f, col) => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    if (m) { const v = f[m[1]] && f[m[1]][m[2]]; return v === undefined || v === null ? null : String(v); }
    return f[col];
  };
  /** `in.(a,"b, c")`: postgrest-js pone entre comillas los valores con caracteres reservados. */
  const leerLista = (s) => {
    const out = [];
    let cur = '', comillas = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') { comillas = !comillas; continue; }
      if (ch === '\\' && comillas) { cur += s[++i]; continue; }
      if (ch === ',' && !comillas) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (s.length) out.push(cur);
    return out;
  };

  const filtro = (col, op, valor) => {
    if (op === 'ilike' || op === 'like') {
      const re = new RegExp('^' + valor.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*').replace(/_/g, '.') + '$', op === 'ilike' ? 'i' : '');
      return (f) => leer(f, col) != null && re.test(String(leer(f, col)));
    }
    if (op === 'imatch' || op === 'match') {
      const re = new RegExp(valor, op === 'imatch' ? 'i' : '');
      return (f) => leer(f, col) != null && re.test(String(leer(f, col)));
    }
    if (op === 'in') {
      const m = /^\((.*)\)$/.exec(valor);
      const lista = leerLista(m ? m[1] : '');
      return (f) => leer(f, col) != null && lista.includes(String(leer(f, col)));
    }
    if (op === 'is') {
      if (valor !== 'null') { sinModelar.push(col + '=is.' + valor); return () => true; }
      return (f) => leer(f, col) == null;
    }
    const cmp = { eq: (a, b) => a === b, neq: (a, b) => a !== b, gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b }[op];
    if (!cmp) { sinModelar.push(col + '=' + op); return () => true; }
    const num = (v) => (typeof v === 'number' ? v : v);
    return (f) => {
      const a = leer(f, col);
      if (a === null || a === undefined) return false;
      if (typeof a === 'number') return cmp(a, Number(valor));
      if (typeof a === 'boolean') return cmp(String(a), valor);
      return cmp(num(String(a)), valor);
    };
  };

  const ordenar = (filas, orden) => [...filas].sort((x, y) => {
    for (const { col, desc } of orden) {
      const a = leer(x, col), b = leer(y, col);
      if (a === b) continue;
      if (a == null) return desc ? -1 : 1;
      if (b == null) return desc ? 1 : -1;
      return (a < b ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });

  const proyectar = (fila, columnas) => {
    if (columnas === '*') return { ...fila };
    const out = {};
    for (const c of columnas.split(',')) {
      if (c === '*') Object.assign(out, fila);
      else { const k = c.includes('(') ? c.slice(0, c.indexOf('(')) : c; out[k] = fila[k]; }
    }
    return out;
  };

  async function fetchFalso(url, init = {}) {
    const u = new URL(String(url));
    const tabla = u.pathname.replace(/^\/rest\/v1\//, '');
    const metodo = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const cuerpo = init.body ? JSON.parse(init.body) : null;
    const params = [...u.searchParams.entries()];
    pedidos.push({ metodo, tabla, params, cuerpo });
    const prefer = headers.get('prefer') || '';
    const responder = (status, body, extra = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (tabla.startsWith('rpc/')) return responder(200, null);
    let columnas = '*', orden = [], limite = null, desde = 0;
    const filtros = [];
    for (const [k, v] of params) {
      if (k === 'select') columnas = v;
      else if (k === 'order') orden = v.split(',').map((s) => { const [col, dir] = s.split('.'); return { col, desc: dir === 'desc' }; });
      else if (k === 'limit') limite = Number(v);
      else if (k === 'offset') desde = Number(v);
      else if (k === 'columns' || k === 'on_conflict') continue;
      else { const i = v.indexOf('.'); filtros.push(filtro(k, v.slice(0, i), v.slice(i + 1))); }
    }
    const filas = tablas[tabla] || (tablas[tabla] = []);
    const pasa = (f) => filtros.every((p) => p(f));
    const representacion = /return=representation/.test(prefer);
    const objeto = /vnd\.pgrst\.object/.test(headers.get('accept') || '');
    const conteo = (n, total) => (/count=exact/.test(prefer) ? { 'content-range': (n ? desde + '-' + (desde + n - 1) : '*') + '/' + total } : {});
    const entregar = (resultado, extra) => {
      if (!objeto) return responder(200, resultado, extra);
      if (resultado.length !== 1) return responder(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
      return responder(200, resultado[0], extra);
    };
    if (metodo === 'GET' || metodo === 'HEAD') {
      const todas = ordenar(filas.filter(pasa), orden);
      let res = todas.slice(desde);
      if (limite !== null) res = res.slice(0, limite);
      return entregar(res.map((f) => proyectar(f, columnas)), conteo(res.length, todas.length));
    }
    if (metodo === 'PATCH') {
      const tocadas = filas.filter(pasa);
      for (const f of tocadas) Object.assign(f, cuerpo);
      if (representacion) return entregar(tocadas.map((f) => proyectar(f, columnas)), conteo(tocadas.length, tocadas.length));
      return responder(204, undefined, conteo(tocadas.length, tocadas.length));
    }
    if (metodo === 'POST') {
      const escritas = (Array.isArray(cuerpo) ? cuerpo : [cuerpo]).map((f) => {
        const nueva = { id: tabla + '-' + (++secuencia), created_at: '2026-10-02T23:00:00', ...f };
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
  }

  return {
    fetch: fetchFalso, tablas, sinModelar,
    escrituras: (tabla) => pedidos.filter((p) => p.metodo !== 'GET' && p.metodo !== 'HEAD' && (!tabla || p.tabla === tabla)),
    fila: (tabla, id) => (tablas[tabla] || []).find((f) => f.id === id),
  };
}

// ─── Carga: servicios y handlers reales, con el cliente apuntado al falso ────────────────────────

require('../../lib/error-monitor').registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/analytics').capture = vi.fn();

const { createClient } = require('@supabase/supabase-js');
const r = (p) => require.resolve(path.join(projectRoot, p));
const dbPath = r('lib/db.js');
// Todo lo que captura `supabase` al cargar se recarga con el cliente nuevo.
const RECARGAR = [
  'services/debts.js', 'services/metas.js', 'services/transactions.js', 'services/budget.js',
  'handlers/intents/deudas.js', 'handlers/intents/metas.js', 'handlers/intents/espacios.js',
  'handlers/intents/presupuestos.js', 'handlers/intents/transacciones.js', 'handlers/intent-registry.js',
].map(r);

// Espacios: la resolución vive en el handler; los servicios de espacios se espían.
const spaces = require('../../services/shared-spaces');
const ESPACIO_DEPA = { id: 's-depa', name: 'Depa', invite_code: 'DEPA1234' };
const ESPACIO_VIAJE = { id: 's-viaje', name: 'Viaje Cusco', invite_code: 'VIAJE123' };
let espacios = [];
spaces.obtenerEspaciosUsuario = vi.fn(async () => espacios);
spaces.registrarGastoCompartido = vi.fn(async (_u, spaceId) => ({ snapshot: { source: 'default', shares: [{ user_id: 'u-1', cents: 10000 }] }, spaceId }));
spaces.liquidarCuentas = vi.fn(async () => ({ ok: true }));
spaces.obtenerResumenEspacio = vi.fn(async () => ({ balance: { debts: [] }, members: [], recentExpenses: [] }));
require('../../services/spaces-split').shareCents = vi.fn(() => 10000);

let pg;
let dispatchIntent;
let servicios;
function montar(filas) {
  pg = postgrestFalso(filas);
  const cliente = createClient('http://postgrest-falso.local', 'clave-falsa', { global: { fetch: pg.fetch } });
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: cliente } };
  for (const p of RECARGAR) delete require.cache[p];
  const debts = require(r('services/debts.js'));
  const metas = require(r('services/metas.js'));
  const tx = require(r('services/transactions.js'));
  servicios = { debts, metas, tx };
  ({ dispatchIntent } = require(r('handlers/intent-registry.js')));
  return cliente;
}

const USUARIO = { id: 'u-1', nombre: 'Rayza', plan: 'premium', trial_estado: 'activo', trial_vence: '2099-01-01' };
function ctx() {
  const { debts, metas, tx } = servicios;
  return {
    supabase: require(dbPath).supabase,
    log: require('../../lib/logger'),
    hoyPeru: () => '2026-10-02', formatFecha: (f) => f, mesActual: 10, anioActual: 2026,
    validarMonto: require('../../lib/validators').validarMonto,
    registrarDeuda: debts.registrarDeuda, abonarDeuda: debts.abonarDeuda, marcarDeudaPagada: debts.marcarDeudaPagada,
    formatearResumenDeudas: debts.formatearResumenDeudas, consolidarDeudasPorContraparte: debts.consolidarDeudasPorContraparte,
    saldarTodasDeudas: debts.saldarTodasDeudas,
    abonarMetaService: metas.abonarMeta, calcularRitmoAhorro: metas.calcularRitmoAhorro,
    registrarLogro: vi.fn(async () => null), verificarRachaAportes: vi.fn(async () => 0), barraProgreso: () => '',
    obtenerUltimaTransaccion: tx.obtenerUltimaTransaccion, recategorizarTransaccion: tx.recategorizarTransaccion,
    corregirTransaccionEspecifica: tx.corregirTransaccionEspecifica,
    guardarReglaComercio: vi.fn(async () => ({ ok: true, destino: { categoria: 'Transporte', subcategoria: null } })),
    retroaplicarRegla: vi.fn(async () => 0),
    asegurarCategoriaUsuario: vi.fn(async () => null), crearSubcategoriaLibreUsuario: vi.fn(async () => null),
  };
}
const decir = async (intencion, msg, datos = {}) => {
  const d = await dispatchIntent({ intencion, msg, datos, usuario: USUARIO, from: '51999', ctx: ctx() });
  return String(d.respuesta);
};

beforeEach(() => { pg = null; espacios = []; vi.clearAllMocks(); });
afterEach(() => { if (pg) expect(pg.sinModelar, 'el falso recibió algo que no modela').toEqual([]); });

// ─── Metas ───────────────────────────────────────────────────────────────────────────────────────

const meta = (id, nombre, created_at, extra = {}) => ({
  id, usuario_id: 'u-1', nombre, monto_objetivo: 2000, monto_actual: 100, completada: false,
  status: 'active', fecha_limite: null, monthly_quota: null, invite_code: null, colaborativa: false, created_at, ...extra,
});
// Laptop es la MÁS RECIENTE: es la que el fallback a `metas[0]` elegía.
const LAPTOP = meta('m-laptop', 'Laptop', '2026-09-20');
const VIAJE = meta('m-viaje', 'Viaje Cusco', '2026-09-01');
const AJENA = { ...meta('m-ajena', 'Moto', '2026-09-25'), usuario_id: 'u-2' };
const DOS_METAS = { metas_ahorro: [LAPTOP, VIAJE, AJENA], meta_aportes: [] };

describe('metas · un nombre dicho que no coincide no escribe sobre otra meta', () => {
  it('"elimina la meta moto" con Laptop y Viaje Cusco no borra nada', async () => {
    montar(DOS_METAS);
    const resp = await decir('eliminar_meta', 'elimina la meta moto', { nombre: 'moto' });
    expect(pg.escrituras('metas_ahorro'), 'borró otra meta').toEqual([]);
    expect(resp).toMatch(/No encontré ninguna meta \*moto\*/);
    expect(resp).toMatch(/Laptop/);
  });

  it('"sube la meta moto a 3000" no edita Laptop', async () => {
    montar(DOS_METAS);
    await decir('editar_meta', 'sube la meta moto a 3000', { nombre: 'moto', monto_nuevo: 3000 });
    expect(pg.escrituras('metas_ahorro')).toEqual([]);
    expect(pg.fila('metas_ahorro', 'm-laptop').monto_objetivo).toBe(2000);
  });

  it('"aboné 100 a la meta moto" no abona a Laptop', async () => {
    montar(DOS_METAS);
    const resp = await decir('abonar_meta', 'aboné 100 a la meta moto', { nombre_meta: 'moto', monto: 100 });
    expect(pg.escrituras(), 'abonó a otra meta').toEqual([]);
    expect(resp).toMatch(/No encontré ninguna meta \*moto\*/);
  });

  it('"abandona la meta moto" no abandona Laptop', async () => {
    montar(DOS_METAS);
    await decir('abandonar_plan', 'abandona la meta moto', { nombre: 'moto' });
    expect(pg.escrituras()).toEqual([]);
    expect(pg.fila('metas_ahorro', 'm-laptop').status).toBe('active');
  });

  it('con UNA sola meta, un nombre que no es el suyo tampoco escribe', async () => {
    montar({ metas_ahorro: [LAPTOP], meta_aportes: [] });
    await decir('eliminar_meta', 'elimina la meta moto', { nombre: 'moto' });
    expect(pg.escrituras()).toEqual([]);
  });

  it('dos metas que coinciden por palabra ("viaje") preguntan cuál', async () => {
    montar({ metas_ahorro: [meta('m-eu', 'Viaje Europa', '2026-09-22'), VIAJE], meta_aportes: [] });
    const resp = await decir('eliminar_meta', 'elimina la meta viaje', { nombre: 'viaje' });
    expect(pg.escrituras()).toEqual([]);
    expect(resp).toMatch(/Viaje Europa/);
    expect(resp).toMatch(/Viaje Cusco/);
  });

  it('el nombre exacto gana sobre el parecido: "viaje" con Viaje y Viaje Europa borra Viaje', async () => {
    montar({ metas_ahorro: [meta('m-eu', 'Viaje Europa', '2026-09-22'), meta('m-v', 'Viaje', '2026-09-01')], meta_aportes: [] });
    await decir('eliminar_meta', 'elimina la meta viaje', { nombre: 'viaje' });
    expect(pg.fila('metas_ahorro', 'm-v')).toBeUndefined();
    expect(pg.fila('metas_ahorro', 'm-eu')).toBeDefined();
  });

  it('sin nombre y con dos metas, "elimina mi meta" pregunta cuál', async () => {
    montar(DOS_METAS);
    const resp = await decir('eliminar_meta', 'elimina mi meta', {});
    expect(pg.escrituras()).toEqual([]);
    expect(resp).toMatch(/Cuál de tus metas/);
  });

  it('sin nombre y con dos metas, "aboné 100 a mi meta" pregunta cuál', async () => {
    montar(DOS_METAS);
    const resp = await decir('abonar_meta', 'aboné 100 a mi meta', { monto: 100 });
    expect(pg.escrituras()).toEqual([]);
    expect(resp).toMatch(/Cuál de tus metas/);
  });

  it('"comparte mi meta viaje con Ana" comparte Viaje Cusco, no Laptop', async () => {
    montar(DOS_METAS);
    const resp = await decir('compartir_meta', 'comparte mi meta viaje con Ana', {});
    const upd = pg.escrituras('metas_ahorro').filter((p) => p.metodo === 'PATCH');
    expect(upd).toHaveLength(1);
    expect(upd[0].params).toContainEqual(['id', 'eq.m-viaje']);
    expect(resp).toMatch(/Viaje Cusco/);
  });

  it('control: "elimina la meta viaje" borra Viaje Cusco y nada más', async () => {
    montar(DOS_METAS);
    const resp = await decir('eliminar_meta', 'elimina la meta viaje', { nombre: 'viaje' });
    expect(pg.fila('metas_ahorro', 'm-viaje')).toBeUndefined();
    expect(pg.fila('metas_ahorro', 'm-laptop')).toBeDefined();
    expect(resp).toMatch(/Eliminé la meta \*Viaje Cusco\*/);
  });

  it('control: con una sola meta, "aboné 100 a mi meta" abona sin preguntar', async () => {
    montar({ metas_ahorro: [VIAJE], meta_aportes: [] });
    const resp = await decir('abonar_meta', 'aboné 100 a mi meta', { monto: 100 });
    expect(resp).toMatch(/Abono registrado/);
    expect(pg.fila('metas_ahorro', 'm-viaje').monto_actual).toBe(200);
  });

  it('control: "aboné 100 a la meta laptop" abona a Laptop aunque el modelo diga "meta laptop"', async () => {
    montar(DOS_METAS);
    await decir('abonar_meta', 'aboné 100 a la meta laptop', { nombre_meta: 'meta laptop', monto: 100 });
    expect(pg.fila('metas_ahorro', 'm-laptop').monto_actual).toBe(200);
    expect(pg.fila('metas_ahorro', 'm-viaje').monto_actual).toBe(100);
  });
});

// ─── Deudas ──────────────────────────────────────────────────────────────────────────────────────

const deuda = (id, contraparte, pendiente, created_at, extra = {}) => ({
  id, usuario_id: 'u-1', tipo: 'me_deben', contraparte, monto_original: pendiente, monto_pendiente: pendiente,
  moneda: 'PEN', estado: 'activa', descripcion: null, created_at, ...extra,
});
// Luisa es la más reciente: el `ilike '%Luis%'` ordenado por recencia la elegía a ella.
const LUISA = deuda('d-luisa', 'Luisa', 100, '2026-09-20');
const LUIS = deuda('d-luis', 'Luis', 50, '2026-09-01');
const LUIS_Y_LUISA = { deudas: [LUISA, LUIS], deuda_abonos: [] };

describe('deudas · "Luis" no alcanza a "Luisa"', () => {
  it('"salda todo con Luis" salda a Luis y deja a Luisa', async () => {
    montar(LUIS_Y_LUISA);
    const resp = await decir('saldar_todo_contraparte', 'salda todo con Luis', { contraparte: 'Luis' });
    expect(pg.fila('deudas', 'd-luis').estado).toBe('pagada');
    expect(pg.fila('deudas', 'd-luisa').estado, 'saldó a Luisa').toBe('activa');
    expect(resp).toMatch(/1 deuda con \*Luis\*/);
  });

  it('"Luis me pagó 20" abona a Luis, no a Luisa', async () => {
    montar(LUIS_Y_LUISA);
    await decir('abonar_deuda', 'Luis me pagó 20', { contraparte: 'Luis', monto: 20 });
    expect(pg.fila('deudas', 'd-luis').monto_pendiente).toBe(30);
    expect(pg.fila('deudas', 'd-luisa').monto_pendiente).toBe(100);
  });

  it('"Luis ya me pagó todo" marca a Luis', async () => {
    montar(LUIS_Y_LUISA);
    await decir('marcar_deuda_pagada', 'Luis ya me pagó todo', { contraparte: 'Luis' });
    expect(pg.fila('deudas', 'd-luis').estado).toBe('pagada');
    expect(pg.fila('deudas', 'd-luisa').estado).toBe('activa');
  });

  it('"Luis me pagó la mitad" saca la mitad de lo de Luis (25), no de Luisa', async () => {
    montar(LUIS_Y_LUISA);
    await decir('abonar_deuda', 'Luis me pagó la mitad', { contraparte: 'Luis' });
    expect(pg.fila('deudas', 'd-luis').monto_pendiente).toBe(25);
    expect(pg.fila('deudas', 'd-luisa').monto_pendiente).toBe(100);
  });

  it('dos personas que se llaman Luis: "Luis me pagó 20" pregunta cuál', async () => {
    montar({ deudas: [deuda('d-lp', 'Luis Pérez', 80, '2026-09-20'), deuda('d-ls', 'Luis Soto', 60, '2026-09-01')], deuda_abonos: [] });
    const resp = await decir('abonar_deuda', 'Luis me pagó 20', { contraparte: 'Luis', monto: 20 });
    expect(pg.escrituras()).toEqual([]);
    expect(resp).toMatch(/Luis Pérez/);
    expect(resp).toMatch(/Luis Soto/);
  });

  it('"salda todo con Luis" con Luis Pérez y Luis Soto pregunta, no salda a los dos', async () => {
    montar({ deudas: [deuda('d-lp', 'Luis Pérez', 80, '2026-09-20'), deuda('d-ls', 'Luis Soto', 60, '2026-09-01')], deuda_abonos: [] });
    await decir('saldar_todo_contraparte', 'salda todo con Luis', { contraparte: 'Luis' });
    expect(pg.escrituras()).toEqual([]);
  });

  it('"Luis me debe 50" no borra como "opuesta" la deuda con Luisa', async () => {
    const reciente = new Date(Date.now() - 60 * 1000).toISOString();
    montar({ deudas: [deuda('d-luisa', 'Luisa', 50, reciente, { tipo: 'debo' })], deuda_abonos: [] });
    await decir('registrar_deuda', 'Luis me debe 50', { contraparte: 'Luis', monto: 50, tipo: 'me_deben' });
    expect(pg.fila('deudas', 'd-luisa'), 'borró la deuda con Luisa').toBeDefined();
  });

  it('control: la corrección de la opuesta sigue andando con la MISMA persona', async () => {
    const reciente = new Date(Date.now() - 60 * 1000).toISOString();
    montar({ deudas: [deuda('d-luis', 'luis ', 50, reciente, { tipo: 'debo' })], deuda_abonos: [] });
    await decir('registrar_deuda', 'Luis me debe 50', { contraparte: 'Luis', monto: 50, tipo: 'me_deben' });
    expect(pg.fila('deudas', 'd-luis')).toBeUndefined();
  });

  it('control: dos deudas con la MISMA persona, el abono va a la más reciente (como hoy)', async () => {
    montar({ deudas: [deuda('d-j2', 'Juan', 40, '2026-09-20'), deuda('d-j1', 'Juan', 70, '2026-09-01')], deuda_abonos: [] });
    await decir('abonar_deuda', 'Juan me pagó 10', { contraparte: 'Juan', monto: 10 });
    expect(pg.fila('deudas', 'd-j2').monto_pendiente).toBe(30);
    expect(pg.fila('deudas', 'd-j1').monto_pendiente).toBe(70);
  });

  it('control: "salda todo con Juan" salda TODAS las de Juan', async () => {
    montar({ deudas: [deuda('d-j2', 'Juan', 40, '2026-09-20'), deuda('d-j1', 'juan', 70, '2026-09-01'), LUISA], deuda_abonos: [] });
    const resp = await decir('saldar_todo_contraparte', 'salda todo con Juan', { contraparte: 'Juan' });
    expect(pg.fila('deudas', 'd-j2').estado).toBe('pagada');
    expect(pg.fila('deudas', 'd-j1').estado).toBe('pagada');
    expect(pg.fila('deudas', 'd-luisa').estado).toBe('activa');
    expect(resp).toMatch(/2 deudas/);
  });

  it('control: una persona que no existe sigue diciendo "No encontré deuda activa"', async () => {
    montar(LUIS_Y_LUISA);
    const resp = await decir('abonar_deuda', 'Pedro me pagó 20', { contraparte: 'Pedro', monto: 20 });
    expect(pg.escrituras()).toEqual([]);
    expect(resp).toMatch(/No encontré deuda activa con \*Pedro\*/);
  });

  it('"Luis" con solo Luis Pérez anotado: el apellido no hace falta', async () => {
    montar({ deudas: [deuda('d-lp', 'Luis Pérez', 80, '2026-09-20')], deuda_abonos: [] });
    await decir('abonar_deuda', 'Luis me pagó 20', { contraparte: 'Luis', monto: 20 });
    expect(pg.fila('deudas', 'd-lp').monto_pendiente).toBe(60);
  });

  it('las deudas de otra persona no entran en la resolución', async () => {
    montar({ deudas: [{ ...deuda('d-ajena', 'Luis', 50, '2026-09-25'), usuario_id: 'u-2' }, LUISA], deuda_abonos: [] });
    await decir('abonar_deuda', 'Luis me pagó 20', { contraparte: 'Luis', monto: 20 });
    expect(pg.fila('deudas', 'd-ajena').monto_pendiente).toBe(50);
    expect(pg.fila('deudas', 'd-luisa').monto_pendiente).toBe(100);
  });
});

// ─── Espacios ────────────────────────────────────────────────────────────────────────────────────

describe('espacios · el gasto compartido va al espacio que la persona nombra', () => {
  it('"pagué 200 del hotel en el espacio playa" con Depa y Viaje Cusco no anota en ninguno', async () => {
    montar({});
    espacios = [ESPACIO_DEPA, ESPACIO_VIAJE];
    const resp = await decir('registrar_gasto_espacio', 'pagué 200 del hotel en el espacio playa', { monto: 200, nombre_espacio: 'playa' });
    expect(spaces.registrarGastoCompartido, 'anotó en otro espacio').not.toHaveBeenCalled();
    expect(resp).toMatch(/No encontré ningún espacio \*playa\*/);
  });

  it('sin nombre y con dos espacios, "pagué 200 de luz" pregunta en cuál', async () => {
    montar({});
    espacios = [ESPACIO_DEPA, ESPACIO_VIAJE];
    const resp = await decir('registrar_gasto_espacio', 'pagué 200 de luz', { monto: 200 });
    expect(spaces.registrarGastoCompartido).not.toHaveBeenCalled();
    expect(resp).toMatch(/Cuál de tus espacios/);
  });

  it('"invita a alguien al espacio playa" no reparte el link de Depa', async () => {
    montar({ space_members: [] });
    espacios = [ESPACIO_DEPA, ESPACIO_VIAJE];
    const resp = await decir('invitar_espacio', 'invita a alguien al espacio playa', { nombre_espacio: 'playa' });
    expect(resp).not.toMatch(/DEPA1234/);
    expect(resp).not.toMatch(/VIAJE123/);
  });

  it('"le pagué 50 a Ana del depa" con Mariana y Ana Torres le paga a Ana Torres', async () => {
    montar({ space_members: [
      { id: 'sm-1', space_id: 's-depa', user_id: 'u-1', usuarios: { nombre: 'Rayza' } },
      { id: 'sm-2', space_id: 's-depa', user_id: 'u-mariana', usuarios: { nombre: 'Mariana' } },
      { id: 'sm-3', space_id: 's-depa', user_id: 'u-ana', usuarios: { nombre: 'Ana Torres' } },
    ] });
    espacios = [ESPACIO_DEPA];
    await decir('liquidar_espacio', 'le pagué 50 a Ana del depa', { monto: 50, contraparte: 'Ana', nombre_espacio: 'depa' });
    expect(spaces.liquidarCuentas).toHaveBeenCalledWith('s-depa', 'u-1', 'u-ana', 50);
  });

  it('control: con un solo espacio y sin nombre, anota ahí', async () => {
    montar({});
    espacios = [ESPACIO_DEPA];
    await decir('registrar_gasto_espacio', 'pagué 200 de luz', { monto: 200 });
    expect(spaces.registrarGastoCompartido).toHaveBeenCalledWith('u-1', 's-depa', 200, null, null);
  });

  it('control: "pagué 200 del hotel en viaje" anota en Viaje Cusco', async () => {
    montar({});
    espacios = [ESPACIO_DEPA, ESPACIO_VIAJE];
    await decir('registrar_gasto_espacio', 'pagué 200 del hotel en viaje', { monto: 200, nombre_espacio: 'viaje' });
    expect(spaces.registrarGastoCompartido).toHaveBeenCalledWith('u-1', 's-viaje', 200, null, null);
  });
});

// ─── Restaurar lo borrado (backlog, ítem 43) ─────────────────────────────────────────────────────

const borrado = (id, comercio, monto, deleted_at) => ({
  id, usuario_id: 'u-1', restored_at: null, deleted_at,
  snapshot: { comercio, monto, monto_pen: monto, moneda: 'PEN', fecha: deleted_at.slice(0, 10), categoria: 'Ocio', tipo: 'gasto' },
});
// El cine es el último borrado: el fallback lo restauraba con cualquier pedido que no coincidiera.
const CINE = borrado('e-cine', 'Cine', 30, '2026-10-01T10:00:00');
const KFC = borrado('e-kfc', 'KFC', 25, '2026-09-28T10:00:00');

describe('restaurar · un pedido que no coincide no restaura otro gasto', () => {
  it('"recupera el gasto de la pizza" no restaura el cine', async () => {
    montar({ transacciones_eliminadas: [CINE, KFC], transacciones: [] });
    const resp = await decir('restaurar_eliminado', 'recupera el gasto de la pizza', { comercio: 'pizza' });
    expect(pg.escrituras(), 'restauró otro gasto').toEqual([]);
    expect(resp).toMatch(/pizza/);
  });

  it('"recupera el de 99" no restaura nada si ninguno era de 99', async () => {
    montar({ transacciones_eliminadas: [CINE, KFC], transacciones: [] });
    await decir('restaurar_eliminado', 'recupera el de 99', { monto: 99 });
    expect(pg.escrituras()).toEqual([]);
  });

  it('"recupera el uber" con Uber y Uber Eats borrados restaura Uber, aunque Uber Eats sea el último', async () => {
    montar({ transacciones_eliminadas: [borrado('e-ue', 'Uber Eats', 40, '2026-10-01T12:00:00'), borrado('e-u', 'Uber', 12, '2026-09-30T12:00:00')], transacciones: [] });
    await decir('restaurar_eliminado', 'recupera el uber', { comercio: 'uber' });
    const ins = pg.escrituras('transacciones');
    expect(ins).toHaveLength(1);
    expect(ins[0].cuerpo.comercio).toBe('Uber');
  });

  it('dos comercios distintos que coinciden por palabra preguntan cuál', async () => {
    montar({ transacciones_eliminadas: [borrado('e-1', 'Pizza Hut', 40, '2026-10-01T12:00:00'), borrado('e-2', 'Pizza Raúl', 22, '2026-09-30T12:00:00')], transacciones: [] });
    const resp = await decir('restaurar_eliminado', 'recupera la pizza', { comercio: 'pizza' });
    expect(pg.escrituras()).toEqual([]);
    expect(resp).toMatch(/Pizza Hut/);
    expect(resp).toMatch(/Pizza Raúl/);
  });

  it('control: "restaura" a secas restaura el último borrado', async () => {
    montar({ transacciones_eliminadas: [CINE, KFC], transacciones: [] });
    await decir('restaurar_eliminado', 'restaura', {});
    expect(pg.escrituras('transacciones')[0].cuerpo.comercio).toBe('Cine');
  });

  it('control: "restaura" a secas con un comercio que el modelo sacó del historial restaura el último', async () => {
    // Es lo que hacía inseguro el arreglo ingenuo (DEFECTOS, 02-oct): la guarda de datos-dichos
    // descarta el comercio no dicho, así que "sin match no restaura" no rompe este caso.
    montar({ transacciones_eliminadas: [CINE, KFC], transacciones: [] });
    await decir('restaurar_eliminado', 'restaura', { comercio: 'pizza' });
    expect(pg.escrituras('transacciones')[0].cuerpo.comercio).toBe('Cine');
  });

  it('control: "recupera el kfc" restaura el KFC', async () => {
    montar({ transacciones_eliminadas: [CINE, KFC], transacciones: [] });
    await decir('restaurar_eliminado', 'recupera el kfc', { comercio: 'kfc' });
    expect(pg.escrituras('transacciones')[0].cuerpo.comercio).toBe('KFC');
  });

  it('"recupera lo de lina" no restaura la Gasolina (el servidor la trae por subcadena; decide la palabra)', async () => {
    montar({ transacciones_eliminadas: [borrado('e-g', 'Gasolina', 50, '2026-10-01T12:00:00'), KFC], transacciones: [] });
    const resp = await decir('restaurar_eliminado', 'recupera lo de lina', { comercio: 'lina' });
    expect(pg.escrituras(), 'restauró la gasolina').toEqual([]);
    expect(resp).toMatch(/no restauré nada/);
  });

  it('un borrado viejo, fuera del tope de los más recientes, se encuentra por nombre', async () => {
    // 55 > TOPE_BORRADOS (50): sin el filtro en la consulta, Cineplanet queda fuera del recorte.
    const recientes = Array.from({ length: 55 }, (_, i) => borrado('e-r' + i, 'Taxi', 10, new Date(Date.UTC(2026, 9, 1, 23, 0, 0) - i * 60000).toISOString().slice(0, 19)));
    montar({ transacciones_eliminadas: [...recientes, borrado('e-viejo', 'Cineplanet', 35, '2026-08-01T10:00:00')], transacciones: [] });
    await decir('restaurar_eliminado', 'recupera lo de cineplanet', { comercio: 'cineplanet' });
    expect(pg.escrituras('transacciones')[0]?.cuerpo.comercio).toBe('Cineplanet');
  });
});

// ─── Corregir la categoría de un comercio ────────────────────────────────────────────────────────

const tx = (id, comercio, created_at, extra = {}) => ({
  id, usuario_id: 'u-1', comercio, monto: 20, monto_pen: 20, moneda: 'PEN', categoria: 'Otros',
  subcategoria: null, tipo: 'gasto', fecha: created_at.slice(0, 10), created_at, ...extra,
});

describe('corregir_categoria · el comercio dicho, no el que lo contiene', () => {
  it('"el uber era transporte" mueve el Uber, no el Uber Eats más reciente', async () => {
    montar({ transacciones: [tx('t-ue', 'Uber Eats', '2026-10-01T12:00:00'), tx('t-u', 'Uber', '2026-09-30T12:00:00')] });
    await decir('corregir_categoria', 'el uber era transporte', { comercio: 'uber', categoria_nueva: 'Transporte' });
    expect(pg.fila('transacciones', 't-u').categoria).toBe('Transporte');
    expect(pg.fila('transacciones', 't-ue').categoria, 'movió el Uber Eats').toBe('Otros');
  });

  it('dos comercios que coinciden por palabra preguntan cuál', async () => {
    montar({ transacciones: [tx('t-1', 'Pedidosya Chifa', '2026-10-01T12:00:00'), tx('t-2', 'Pedidosya Kfc', '2026-09-30T12:00:00')] });
    const resp = await decir('corregir_categoria', 'lo de pedidosya era delivery', { comercio: 'pedidosya', categoria_nueva: 'Delivery' });
    expect(pg.escrituras('transacciones')).toEqual([]);
    expect(resp).toMatch(/Pedidosya Chifa/);
  });

  it('"starbucks coffee" con solo Starbucks anotado no mueve nada: ofrece Starbucks', async () => {
    montar({ transacciones: [tx('t-s', 'Starbucks', '2026-10-01T12:00:00')] });
    const resp = await decir('corregir_categoria', 'el starbucks coffee era comida', { comercio: 'starbucks coffee', categoria_nueva: 'Comida' });
    expect(pg.escrituras('transacciones')).toEqual([]);
    expect(resp).toMatch(/Starbucks/);
  });

  it('"lina" no mueve la gasolina', async () => {
    montar({ transacciones: [tx('t-g', 'Gasolina', '2026-10-01T12:00:00')] });
    await decir('corregir_categoria', 'lo de lina era belleza', { comercio: 'lina', categoria_nueva: 'Belleza' });
    expect(pg.escrituras('transacciones')).toEqual([]);
  });

  it('control: "el uber era transporte" con solo Uber Eats lo mueve (la palabra está entera)', async () => {
    montar({ transacciones: [tx('t-ue', 'Uber Eats', '2026-10-01T12:00:00')] });
    await decir('corregir_categoria', 'el uber era transporte', { comercio: 'uber', categoria_nueva: 'Transporte' });
    expect(pg.fila('transacciones', 't-ue').categoria).toBe('Transporte');
  });

  it('control: con varios del mismo comercio, mueve el más reciente', async () => {
    montar({ transacciones: [tx('t-2', 'Taxi', '2026-10-01T12:00:00'), tx('t-1', 'taxi', '2026-09-30T12:00:00')] });
    await decir('corregir_categoria', 'el taxi era transporte', { comercio: 'taxi', categoria_nueva: 'Transporte' });
    expect(pg.fila('transacciones', 't-2').categoria).toBe('Transporte');
    expect(pg.fila('transacciones', 't-1').categoria).toBe('Otros');
  });

  it('control: un comercio con tilde se encuentra sin ella ("cafe" → "Café Haití")', async () => {
    montar({ transacciones: [tx('t-c', 'Café Haití', '2026-10-01T12:00:00')] });
    await decir('corregir_categoria', 'el cafe haiti era salud', { comercio: 'cafe haiti', categoria_nueva: 'Salud' });
    expect(pg.fila('transacciones', 't-c').categoria).toBe('Salud');
  });

  it('un comercio con comodín (`*`) no alcanza a todos', async () => {
    montar({ transacciones: [tx('t-a', 'Wong', '2026-10-01T12:00:00'), tx('t-b', 'IZI*BARBANEGRA', '2026-09-30T12:00:00')] });
    await decir('corregir_categoria', 'lo de izi*barbanegra era belleza', { comercio: 'IZI*BARBANEGRA', categoria_nueva: 'Belleza' });
    expect(pg.fila('transacciones', 't-a').categoria).toBe('Otros');
    expect(pg.fila('transacciones', 't-b').categoria).toBe('Belleza');
  });
});

// ─── Retroaplicar una regla (en lote: por palabra entera, nunca por subcadena) ──────────────────

describe('retroaplicarRegla · "lina" no alcanza a "gasolina"', () => {
  const FILAS_LINA = [
    tx('t-1', 'Lina', '2026-10-01T12:00:00'), tx('t-2', 'Lina Salon', '2026-09-30T12:00:00'),
    tx('t-3', 'Gasolina', '2026-09-29T12:00:00'), tx('t-4', 'Medicina Catalina', '2026-09-28T12:00:00'),
    { ...tx('t-5', 'Lina', '2026-09-27T12:00:00'), usuario_id: 'u-2' },
  ];
  it('mueve Lina y Lina Salon; deja la gasolina, la medicina y lo de otra persona', async () => {
    montar({ transacciones: FILAS_LINA });
    const n = await servicios.tx.retroaplicarRegla('u-1', 'lina', 'Belleza', null);
    expect(n).toBe(2);
    expect(pg.fila('transacciones', 't-1').categoria).toBe('Belleza');
    expect(pg.fila('transacciones', 't-2').categoria).toBe('Belleza');
    expect(pg.fila('transacciones', 't-3').categoria).toBe('Otros');
    expect(pg.fila('transacciones', 't-4').categoria).toBe('Otros');
    expect(pg.fila('transacciones', 't-5').categoria).toBe('Otros');
  });

  it('control: "pedidosya" alcanza sus variantes ("todo lo de pedidosya" las quiere)', async () => {
    montar({ transacciones: [tx('t-1', 'Pedidosya Chifa Fong', '2026-10-01T12:00:00'), tx('t-2', 'PEDIDOSYA*PLUS', '2026-09-30T12:00:00'), tx('t-3', 'Rappi', '2026-09-29T12:00:00')] });
    const n = await servicios.tx.retroaplicarRegla('u-1', 'pedidosya', 'Delivery', null);
    expect(n).toBe(2);
    expect(pg.fila('transacciones', 't-3').categoria).toBe('Otros');
  });
});

// ─── Presupuestos ────────────────────────────────────────────────────────────────────────────────

const pres = (id, categoria) => ({ id, usuario_id: 'u-1', categoria, monto_limite: 300, mes: 10, anio: 2026 });

describe('eliminar_presupuesto · la categoría dicha, no la que la contiene', () => {
  it('"elimina el presupuesto de comida" con Comida rápida y Comida borra Comida', async () => {
    montar({ presupuestos: [pres('p-cr', 'Comida rápida'), pres('p-c', 'Comida')] });
    await decir('eliminar_presupuesto', 'elimina el presupuesto de comida', { categoria: 'comida' });
    expect(pg.fila('presupuestos', 'p-c')).toBeUndefined();
    expect(pg.fila('presupuestos', 'p-cr'), 'borró Comida rápida').toBeDefined();
  });

  it('dos categorías que coinciden por palabra preguntan cuál', async () => {
    montar({ presupuestos: [pres('p-cr', 'Comida rápida'), pres('p-cc', 'Comida china')] });
    const resp = await decir('eliminar_presupuesto', 'elimina el presupuesto de comida', { categoria: 'comida' });
    expect(pg.escrituras()).toEqual([]);
    expect(resp).toMatch(/Comida rápida/);
  });
});

// ─── Segunda ronda: lo que encontró la revisión adversarial de 469e728 ──────────────────────────

describe('revisión de 469e728 · la palabra corta y la "s" también distinguen', () => {
  it('"Carlos M me pagó 50" con solo Carlos R no abona a Carlos R', async () => {
    montar({ deudas: [deuda('d-cr', 'Carlos R', 100, '2026-09-20')], deuda_abonos: [] });
    await decir('abonar_deuda', 'Carlos M me pagó 50', { contraparte: 'Carlos M', monto: 50 });
    expect(pg.fila('deudas', 'd-cr').monto_pendiente).toBe(100);
  });

  it('"salda todo con Juan C" no salda a Juan P', async () => {
    montar({ deudas: [deuda('d-jp', 'Juan P', 80, '2026-09-20'), deuda('d-jp2', 'Juan P', 30, '2026-09-01')], deuda_abonos: [] });
    await decir('saldar_todo_contraparte', 'salda todo con Juan C', { contraparte: 'Juan C' });
    expect(pg.escrituras()).toEqual([]);
  });

  it('"Lucas me pagó 20" no abona a Luca, ni "salda todo con Marcos" salda a Marco', async () => {
    montar({ deudas: [deuda('d-luca', 'Luca', 80, '2026-09-20'), deuda('d-marco', 'Marco', 40, '2026-09-01')], deuda_abonos: [] });
    await decir('abonar_deuda', 'Lucas me pagó 20', { contraparte: 'Lucas', monto: 20 });
    await decir('saldar_todo_contraparte', 'salda todo con Marcos', { contraparte: 'Marcos' });
    expect(pg.escrituras()).toEqual([]);
  });

  it('el modelo no puede cambiar "Marco" por "Marcos" ni "Carlos" por "Carlos M"', async () => {
    montar({ deudas: [deuda('d-ms', 'Marcos', 80, '2026-09-20'), deuda('d-m', 'Marco', 40, '2026-09-01'),
      deuda('d-cm', 'Carlos M', 70, '2026-09-10'), deuda('d-cr', 'Carlos R', 60, '2026-09-05')], deuda_abonos: [] });
    await decir('abonar_deuda', 'Marco me pagó 20', { contraparte: 'Marcos', monto: 20 });
    await decir('abonar_deuda', 'Carlos me pagó 20', { contraparte: 'Carlos M', monto: 20 });
    expect(pg.fila('deudas', 'd-ms').monto_pendiente).toBe(80);
    expect(pg.fila('deudas', 'd-cm').monto_pendiente).toBe(70);
  });

  it('"aboné 200 a la meta viaje a NY" no abona a Viaje Cusco', async () => {
    montar(DOS_METAS);
    await decir('abonar_meta', 'aboné 200 a la meta viaje a NY', { nombre_meta: 'viaje a NY', monto: 200 });
    expect(pg.escrituras()).toEqual([]);
  });

  it('control: "Juan me pagó 20" con solo Juan Pérez sigue resolviendo', async () => {
    montar({ deudas: [deuda('d-jp', 'Juan Pérez', 80, '2026-09-20')], deuda_abonos: [] });
    await decir('abonar_deuda', 'Juan me pagó 20', { contraparte: 'Juan', monto: 20 });
    expect(pg.fila('deudas', 'd-jp').monto_pendiente).toBe(60);
  });
});

describe('revisión de 469e728 · el lote de una regla', () => {
  it('"Mi Banco" no alcanza a Banco Pichincha ni a Banco de la Nación', async () => {
    montar({ transacciones: [tx('t-mb', 'Mi Banco', '2026-10-01T12:00:00'), tx('t-bp', 'Banco Pichincha', '2026-09-30T12:00:00'), tx('t-bn', 'Banco de la Nacion', '2026-09-29T12:00:00')] });
    const n = await servicios.tx.retroaplicarRegla('u-1', 'Mi Banco', 'Prestamos', null);
    expect(n).toBe(1);
    expect(pg.fila('transacciones', 't-bp').categoria).toBe('Otros');
    expect(pg.fila('transacciones', 't-bn').categoria).toBe('Otros');
  });

  it('"lo de mi banco era salud" con solo Banco Pichincha no lo mueve', async () => {
    montar({ transacciones: [tx('t-bp', 'Banco Pichincha', '2026-09-30T12:00:00')] });
    await decir('corregir_categoria', 'lo de mi banco era salud', { comercio: 'mi banco', categoria_nueva: 'Salud' });
    expect(pg.fila('transacciones', 't-bp').categoria).toBe('Otros');
  });

  it('un comercio con comillas no inyecta otro valor en la lista del update', async () => {
    montar({ transacciones: [tx('t-w', 'Wong","Rappi', '2026-10-01T12:00:00'), tx('t-r', 'Rappi', '2026-09-30T12:00:00')] });
    await servicios.tx.retroaplicarRegla('u-1', 'Wong","Rappi', 'Super', null);
    expect(pg.fila('transacciones', 't-r').categoria, 'movió Rappi').toBe('Otros');
  });
});

describe('revisión de 469e728 · entidades distintas con el mismo nombre preguntan', () => {
  it('dos miembros que se llaman Ana: no le paga a una al azar', async () => {
    montar({ space_members: [
      { id: 'sm-1', space_id: 's-depa', user_id: 'u-1', usuarios: { nombre: 'Rayza' } },
      { id: 'sm-2', space_id: 's-depa', user_id: 'u-ana1', usuarios: { nombre: 'Ana' } },
      { id: 'sm-3', space_id: 's-depa', user_id: 'u-ana2', usuarios: { nombre: 'ana' } },
    ] });
    espacios = [ESPACIO_DEPA];
    await decir('liquidar_espacio', 'le pagué 50 a Ana del depa', { monto: 50, contraparte: 'Ana', nombre_espacio: 'depa' });
    expect(spaces.liquidarCuentas).not.toHaveBeenCalled();
  });

  it('dos espacios que se llaman Viaje: no anota en uno al azar', async () => {
    montar({});
    espacios = [{ id: 's-v1', name: 'Viaje', invite_code: 'V1' }, { id: 's-v2', name: 'Viaje', invite_code: 'V2' }];
    await decir('registrar_gasto_espacio', 'pagué 200 del hotel en viaje', { monto: 200, nombre_espacio: 'viaje' });
    expect(spaces.registrarGastoCompartido).not.toHaveBeenCalled();
  });
});

describe('revisión de 469e728 · lo que preguntaba de más', () => {
  it('"recupera la pizza de 40" con Pizza Hut (40) y Pizza Raúl (22) restaura Pizza Hut', async () => {
    montar({ transacciones_eliminadas: [borrado('e-1', 'Pizza Hut', 40, '2026-10-01T12:00:00'), borrado('e-2', 'Pizza Raúl', 22, '2026-09-30T12:00:00')], transacciones: [] });
    await decir('restaurar_eliminado', 'recupera la pizza de 40', { comercio: 'pizza', monto: 40 });
    expect(pg.escrituras('transacciones')[0]?.cuerpo.comercio).toBe('Pizza Hut');
  });

  it('la pregunta de "varios" usa la categoría pedida y no rompe la negrita con el `*` del nombre', async () => {
    montar({ transacciones: [tx('t-1', 'Rappi*Restaurante Kfc', '2026-10-01T12:00:00'), tx('t-2', 'Rappi*Farmacia', '2026-09-30T12:00:00')] });
    const res = await servicios.tx.recategorizarTransaccion('u-1', 'rappi', 'Delivery');
    expect(res.ok).toBe(false);
    expect(res.msg).not.toMatch(/transporte/i);
    expect(res.msg).not.toMatch(/Rappi\*Restaurante/);
  });

  it('la pregunta de "varios" no trae una orden de borrado lista para copiar', async () => {
    montar({ metas_ahorro: [meta('m-eu', 'Viaje Europa', '2026-09-22'), VIAJE], meta_aportes: [] });
    const resp = await decir('eliminar_meta', 'elimina la meta viaje', { nombre: 'viaje' });
    expect(resp).not.toMatch(/elimina la meta Viaje/);
  });
});
