import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const gastos = require('../../handlers/intents/gastos');
const utilidades = require('../../handlers/intents/utilidades');
const analytics = require('../../handlers/intents/analytics');
const presupuestos = require('../../handlers/intents/presupuestos');
const { formatearResumen, getEmojiCategoria } = require('../../lib/formatters');
const logger = require('../../lib/logger');
// Los dos se cargan ACA y no dentro del test: `intent-registry` levanta los quince
// handlers y sus servicios (~28s la primera vez), y pagarlo adentro de un `it` lo mata por
// timeout — que se ve igual que un cuelgue de verdad.
const { dispatchIntent } = require('../../handlers/intent-registry');
const { detectarQuerySinMonto } = require('../../handlers/intents/transacciones');

/**
 * LECTURAS MUDAS DE CONTENIDO — las 16 de `handlers/intents/` (ítem 9B del backlog).
 *
 * La clase: `const { data } = await supabase…` seguido de `data || []`. supabase-js no lanza,
 * así que un fallo de lectura salía por la MISMA puerta que "no anotaste nada": un reporte en
 * S/ 0.00, un "No encontré gastos de Netflix", un "No hiciste cambios hoy 👍".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE ARCHIVO TIENE QUE PODER DISTINGUIR, Y POR QUÉ EL MOCK NO ES EL DE 9A
 *
 * La pregunta entera del ítem es **"no había datos" vs "no se pudo preguntar"**, que hoy son
 * el mismo `data || []`. Así que cada sitio se ejercita TRES veces: con datos, con cero filas
 * y `error:null`, y con error.
 *
 * **Qué afirma de verdad el caso de error, que no es lo que decía acá.** Donde la aserción
 * principal es un `toBe(...)` sobre la respuesta entera, el `not.toMatch` que va al lado está
 * IMPLICADO y no puede fallar nunca: no discrimina nada, documenta. El `toBe` es más fuerte
 * que el par, así que la cobertura está —lo que estaba mal era la descripción, y lo encontró
 * la revisión adversarial. La única que discrimina de verdad por sí sola es la de
 * `listar_gastos_semana`, que no puede usar `toBe` porque su respuesta sigue siendo la buena.
 *
 * **Lo que este archivo NO cubre, declarado:** que el cliente RECHACE la promesa en vez de
 * devolver `{data, error}`. `makeSupabase` nunca lanza, y con el cliente real esa rama es
 * inalcanzable (postgrest-js convierte el fallo de fetch en `error` — medido y anotado en el
 * mock de `escrituras-de-plata.test.js`). Si algún día rechazara, los cinco sitios que hoy
 * devuelven lanzarían igual.
 *
 * **Y el perímetro son estos 16 sitios, NO el directorio.** `handlers/intents/` tiene más
 * lecturas de la misma forma sin dueño —`presupuestos.js:102`, `metas.js`, `espacios.js`,
 * `deudas.js`, `moderacion.js`—; están anotadas en el backlog, no cerradas acá.
 *
 * El mock de `escrituras-de-plata.test.js` falla por `(tabla, verbo)` porque allá leer y
 * escribir compartían tabla. Acá eso NO alcanza: los dieciséis son `transacciones:select`,
 * o sea que una clave por (tabla, verbo) tumba todas las lecturas del caso a la vez y no puede
 * decir cuál guarda corrió — exactamente el defecto que ya se pagó en los ítems 8 y 9A, un
 * nivel más abajo. Acá el discriminador es el **WHERE realmente enviado**: `fallos` es una
 * lista de predicados sobre la llamada, y los filtros se registran también en los `select`
 * (que es justo lo que el mock de 9A declara no hacer).
 *
 * Eso es lo único que permite ejercitar los dos `Promise.all` —`comparar_meses` y
 * `ver_balance`— con UNA sola mitad caída, que es su caso interesante: la otra mitad llega
 * entera y el cálculo sigue corriendo. Sin esa asimetría el fixture tapa una con la otra y el
 * caso sale verde sin haber ejercitado nada.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

// ─── Mock que discrimina por llamada ─────────────────────────────────────────

/**
 * `fallos` es una lista de predicados `(llamada) => mensajeDeError | null`. `filas` es una
 * función `(llamada) => Array`, no un objeto por tabla: los dieciséis leen `transacciones`,
 * así que la tabla no distingue nada y las filas también hay que elegirlas por el WHERE.
 */
function makeSupabase({ filas = () => [], fallos = [] } = {}) {
  const llamadas = [];
  const sb = {
    _llamadas: llamadas,
    // ¿se armó una query que cumple esto? Sin afirmarlo, un verde puede venir de un `return`
    // anterior y la guarda que el caso dice cubrir nunca habría corrido.
    intento: (pred) => llamadas.some(pred),
    cuenta: (pred) => llamadas.filter(pred).length,
    from(tabla) {
      const filtros = [];
      const b = {};
      // Los filtros se REGISTRAN sobre el `select`, no se tiran. Es lo que hace discriminable
      // una mitad de un `Promise.all` de la otra: las dos son `transacciones:select` y sólo
      // difieren en el WHERE (`tipo=gasto` vs `tipo=ingreso`, `fecha>=desde1` vs `desde2`).
      for (const op of ['eq', 'ilike', 'gte', 'lte', 'neq', 'is', 'not', 'or', 'in']) {
        b[op] = (col, val) => { filtros.push({ op, col, val }); return b; };
      }
      for (const op of ['select', 'order', 'limit']) b[op] = () => b;
      const resolver = () => {
        const llamada = { tabla, filtros };
        llamadas.push(llamada);
        for (const f of fallos) {
          const msg = f(llamada);
          // Un PostgrestError de verdad: los sitios que lanzan tiran ESTE objeto, y el
          // `catch` de arriba lee `e.message`. Si algún día se envuelve en `new Error`, este
          // fixture sigue siendo el contrato.
          if (msg) return { data: null, error: { message: msg, code: '57014', details: null } };
        }
        return { data: filas(llamada), error: null };
      };
      b.then = (ok, ko) => Promise.resolve().then(resolver).then(ok, ko);
      b.single = async () => { const r = resolver(); return r.error ? r : { data: (r.data || [])[0] || null, error: null }; };
      b.maybeSingle = b.single;
      return b;
    },
  };
  return sb;
}

const tiene = (c, col, val) => c.filtros.some((f) => f.col === col && f.val === val);
const desde = (c, val) => c.filtros.some((f) => f.op === 'gte' && f.col === 'fecha' && f.val === val);
const CAE_TODO = () => 'statement timeout';

const TX = (over = {}) => ({
  id: 'tx-1', usuario_id: 'u-1', monto: 45.5, monto_pen: 45.5, moneda: 'PEN',
  comercio: 'Starbucks', categoria: 'Alimentación', subcategoria: 'cafeteria',
  tipo: 'gasto', fecha: '2026-04-10', created_at: '2026-04-10T12:00:00Z',
  updated_at: '2026-04-10T12:00:00Z', ...over,
});

const USUARIO = { id: 'u-1', plan: 'premium', nombre: 'Favio' };
const LIBRE = { id: 'u-1', plan: 'premium', nombre: 'Favio' };
// El del muro: `getHistoryDateLimit` devuelve fecha, o sea que el gate de historial aplica.
const AMURALLADO = { id: 'u-1', plan: 'free', nombre: 'Favio' };

const mE = { 1: 'Enero', 2: 'Febrero', 3: 'Marzo', 4: 'Abril', 5: 'Mayo', 6: 'Junio' };

function ctxBase(sb, extras = {}) {
  return {
    supabase: sb,
    mesActual: 4, anioActual: 2026, mE,
    ultimoDiaMes: (a, m) => new Date(a, m, 0).getDate(),
    // Puro y sin DB (helpers/db-helpers.js): free ve un mes de historial, premium todo.
    getHistoryDateLimit: (u) => (u.plan === 'free' ? '2026-04-01' : null),
    getUserPlanConfig: () => ({ consejoPerWeek: 5, recordatorios: true, resumenDiario: true }),
    getEmojiCategoria, formatearResumen,
    obtenerCuentasGmail: vi.fn().mockResolvedValue([]),
    obtenerGastosMes: vi.fn().mockResolvedValue([]),
    obtenerGastosSemana: vi.fn().mockResolvedValue([]),
    obtenerUltimaTransaccion: vi.fn().mockResolvedValue(null),
    fechaHoyPeru: () => '2026-04-15',
    fechaAyerPeru: () => '2026-04-14',
    formatFecha: (f) => f || '',
    ...extras,
  };
}

const correr = (mod, sb, intencion, datos = {}, { usuario = USUARIO, msg = '', extras = {} } = {}) =>
  mod.handle({ intencion, msg, datos, usuario, from: '+51999', ctx: ctxBase(sb, extras) });

/**
 * El copy de "no se pudo preguntar" de los cinco sitios de `gastos.js` sin catch propio.
 *
 * Está COPIADO a mano y no importado a propósito: la constante no se exporta, y aunque se
 * exportara, un guard que se compara contra la declaración del código no puede ver un cambio
 * de copy — se mueven los dos juntos. Acá lo que se afirma es lo que LEE el usuario.
 */
const MSG_LECTURA_CAIDA = 'No pude consultar tus movimientos en este momento. Intenta de nuevo en unos segundos.';

// ═══════════════════════════════════════════════════════════════════════════════
// gastos.js — 7 sitios
// ═══════════════════════════════════════════════════════════════════════════════

describe('gastos.js — las siete lecturas de contenido', () => {
  describe('listar_gastos_mes, rama Gmail separado (sitio 37)', () => {
    const CUENTAS = [{ email: 'a@gmail.com' }, { email: 'b@gmail.com' }];
    const usuario = { ...USUARIO, reporte_gmail_modo: 'separado' };
    const extras = { obtenerCuentasGmail: vi.fn().mockResolvedValue(CUENTAS) };

    it('con datos, arma el desglose por cuenta', async () => {
      const sb = makeSupabase({ filas: () => [TX({ cuenta_email: 'a@gmail.com' })] });
      const r = await correr(gastos, sb, 'listar_gastos_mes', {}, { usuario, extras });
      expect(r).toMatch(/a@gmail\.com\*: S\/ 45\.50/);
    });

    it('sin filas dice S/ 0.00 por cuenta — y eso sigue siendo la verdad', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(gastos, sb, 'listar_gastos_mes', {}, { usuario, extras });
      expect(r).toMatch(/S\/ 0\.00/);
      expect(r).not.toContain(MSG_LECTURA_CAIDA);
    });

    it('con la lectura caída NO dice S/ 0.00: dice que no pudo preguntar', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(gastos, sb, 'listar_gastos_mes', {}, { usuario, extras });
      expect(r).toBe(MSG_LECTURA_CAIDA);
      expect(r).not.toMatch(/S\/ 0\.00/);
      expect(sb.intento((c) => c.tabla === 'transacciones')).toBe(true);
    });
  });

  describe('listar_gastos_mes, mes histórico (sitio 56)', () => {
    const datos = { mes: 3, anio: 2026 };

    it('con datos, resume el mes pedido', async () => {
      const sb = makeSupabase({ filas: () => [TX({ fecha: '2026-03-10' })] });
      const r = await correr(gastos, sb, 'listar_gastos_mes', datos);
      expect(r).toMatch(/Total: \*S\/ 45\.50\*/);
    });

    it('sin filas dice "No hay gastos registrados en Marzo"', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(gastos, sb, 'listar_gastos_mes', datos);
      expect(r).toBe('No hay gastos registrados en Marzo.');
    });

    it('con la lectura caída NO dice que no hay gastos', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(gastos, sb, 'listar_gastos_mes', datos);
      expect(r).toBe(MSG_LECTURA_CAIDA);
      expect(r).not.toMatch(/No hay gastos registrados/);
    });
  });

  describe('listar_gastos_semana, comparativa (sitio 72) — la ACCESORIA', () => {
    const extras = { obtenerGastosSemana: vi.fn().mockResolvedValue([TX()]) };
    const anterior = (c) => desde(c, '2026-04-01'); // la ventana [hoy-14, hoy-7]

    it('con datos de la semana anterior, imprime la comparativa', async () => {
      const sb = makeSupabase({ filas: () => [TX({ monto_pen: 100 })] });
      const r = await correr(gastos, sb, 'listar_gastos_semana', {}, { extras });
      expect(r).toMatch(/Semana pasada/);
    });

    it('sin filas, omite la comparativa y el resumen de la semana sigue entero', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(gastos, sb, 'listar_gastos_semana', {}, { extras });
      expect(r).not.toMatch(/Semana pasada/);
      expect(r).toMatch(/Total: \*S\/ 45\.50\*/);
    });

    it('con la lectura caída NO corta la respuesta — pero deja rastro', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const sb = makeSupabase({ fallos: [(c) => (anterior(c) ? 'statement timeout' : null)] });
        const r = await correr(gastos, sb, 'listar_gastos_semana', {}, { extras });
        // Lo que el usuario ve es correcto y completo: esta semana no salió de esta query.
        expect(r).toMatch(/Total: \*S\/ 45\.50\*/);
        expect(r).not.toContain(MSG_LECTURA_CAIDA);
        expect(r).not.toMatch(/Semana pasada/);
        // Y acá está la diferencia con "no gastó nada la semana pasada", que desde afuera se
        // ve idéntica —sin línea—: la única forma de separarlas es el log.
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ tag: 'LECTURA_CAIDA', intencion: 'listar_gastos_semana' }),
          expect.stringMatching(/comparativa/i),
        );
      } finally { warn.mockRestore(); }
    });

    it('sin filas NO loguea: "no había datos" no es un fallo', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const sb = makeSupabase({ filas: () => [] });
        await correr(gastos, sb, 'listar_gastos_semana', {}, { extras });
        const deLectura = warn.mock.calls.filter((c) => c[0] && c[0].tag === 'LECTURA_CAIDA');
        expect(deLectura).toHaveLength(0);
      } finally { warn.mockRestore(); }
    });
  });

  describe('listar_gastos_dia (sitio 99)', () => {
    it('con datos, lista el día', async () => {
      const sb = makeSupabase({ filas: () => [TX({ fecha: '2026-04-15' })] });
      const r = await correr(gastos, sb, 'listar_gastos_dia', {}, { msg: 'cuanto gaste hoy' });
      expect(r).toMatch(/Gastos: \*S\/ 45\.50\*/);
    });

    it('sin filas dice "No tienes movimientos registrados"', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(gastos, sb, 'listar_gastos_dia', {}, { msg: 'cuanto gaste hoy' });
      expect(r).toMatch(/No tienes movimientos registrados/);
    });

    it('con la lectura caída NO dice que no tiene movimientos', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(gastos, sb, 'listar_gastos_dia', {}, { msg: 'cuanto gaste hoy' });
      expect(r).toBe(MSG_LECTURA_CAIDA);
      expect(r).not.toMatch(/No tienes movimientos registrados/);
    });
  });

  describe('listar_gastos_categoria (sitio 130)', () => {
    const datos = { categoria: 'Alimentación' };

    it('con datos, lista la categoría', async () => {
      const sb = makeSupabase({ filas: () => [TX()] });
      const r = await correr(gastos, sb, 'listar_gastos_categoria', datos);
      expect(r).toMatch(/Total: \*S\/ 45\.50\*/);
    });

    it('sin filas dice "No encontre gastos en Alimentación"', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(gastos, sb, 'listar_gastos_categoria', datos);
      expect(r).toMatch(/No encontre gastos en \*Alimentación\*/);
    });

    it('con la lectura caída NO afirma sobre esa categoría', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(gastos, sb, 'listar_gastos_categoria', datos);
      expect(r).toBe(MSG_LECTURA_CAIDA);
      expect(r).not.toMatch(/No encontre gastos/);
    });
  });

  describe('ver_gastos_rango_fecha (sitio 172) — tiene catch propio', () => {
    const datos = { fecha_inicio: '2026-04-01', fecha_fin: '2026-04-15' };

    it('con datos, lista el rango', async () => {
      const sb = makeSupabase({ filas: () => [TX()] });
      const r = await correr(gastos, sb, 'ver_gastos_rango_fecha', datos);
      expect(r).toMatch(/Total: S\/ 45\.50/);
    });

    it('sin filas dice "No hay gastos entre…"', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(gastos, sb, 'ver_gastos_rango_fecha', datos);
      expect(r).toMatch(/No hay gastos entre 2026-04-01 y 2026-04-15/);
    });

    it('con la lectura caída cae en SU catch, no en el genérico', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(gastos, sb, 'ver_gastos_rango_fecha', datos);
      expect(r).toBe('No pude consultar ese rango. Intenta de nuevo.');
      expect(r).not.toMatch(/No hay gastos entre/);
    });
  });

  describe('gastos_hormiga (sitio 219)', () => {
    const TRES = [TX({ monto: 5 }), TX({ monto: 8 }), TX({ monto: 12 })];

    it('con 3+ gastos, calcula el análisis', async () => {
      const sb = makeSupabase({ filas: () => TRES });
      const r = await correr(gastos, sb, 'gastos_hormiga');
      expect(r).toMatch(/Tus gastos hormiga este mes/);
    });

    it('con menos de 3 suelta el discurso de bienvenida — y ahí está bien', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(gastos, sb, 'gastos_hormiga');
      expect(r).toMatch(/necesito que registres tus gastos/);
    });

    it('con la lectura caída NO le explica a un usuario viejo cómo registrar', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(gastos, sb, 'gastos_hormiga');
      expect(r).toBe(MSG_LECTURA_CAIDA);
      expect(r).not.toMatch(/necesito que registres tus gastos/);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// El gate de historial del plan free — las tres pegadas a él
// ═══════════════════════════════════════════════════════════════════════════════

describe('el gate de historial decide ANTES de la query, así que ninguna lectura lo abre', () => {
  /**
   * `getHistoryDateLimit` es puro (no toca la DB), y en los tres sitios el `return` del muro
   * está ARRIBA de la query. O sea que un fallo de lectura no puede filtrar historial pagado:
   * cuando el gate aplica, la query ni se arma. Lo que cambia con 9B es qué se le dice al que
   * SÍ pasa el gate.
   *
   * El caso al revés —el gate aplica y la lectura caería— es el que importa: si alguien
   * moviera la guarda nueva arriba del gate, acá saldría el mensaje de lectura caída y el
   * amurallado se enteraría de que su mes existe.
   */
  const casos = [
    { nombre: 'listar_gastos_mes histórico', intencion: 'listar_gastos_mes', datos: { mes: 1, anio: 2026 } },
    { nombre: 'listar_gastos_categoria', intencion: 'listar_gastos_categoria', datos: { categoria: 'Alimentación', mes: 1, anio: 2026 } },
  ];

  for (const c of casos) {
    it(c.nombre + ': con el gate puesto responde el muro y NO consulta', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(gastos, sb, c.intencion, c.datos, { usuario: AMURALLADO });
      expect(r).toMatch(/Tu plan gratuito solo muestra el último mes de historial/);
      expect(r).not.toContain(MSG_LECTURA_CAIDA);
      // Si esto deja de ser 0, la guarda nueva se movió arriba del gate.
      expect(sb._llamadas).toHaveLength(0);
    });
  }

  it('rama Gmail separado: mismo gate, misma ausencia de query', async () => {
    const sb = makeSupabase({ fallos: [CAE_TODO] });
    const r = await correr(gastos, sb, 'listar_gastos_mes', { mes: 1, anio: 2026 }, {
      usuario: { ...AMURALLADO, reporte_gmail_modo: 'separado' },
      extras: { obtenerCuentasGmail: vi.fn().mockResolvedValue([{ email: 'a@x.com' }, { email: 'b@x.com' }]) },
    });
    expect(r).toMatch(/Tu plan gratuito solo muestra el último mes de historial/);
    expect(sb._llamadas).toHaveLength(0);
  });

  it('al mismo usuario free, DENTRO del rango permitido, la lectura caída sí le contesta', async () => {
    // El control que separa "el gate cortó" de "la guarda no existe": mismo plan, mes actual.
    const sb = makeSupabase({ fallos: [CAE_TODO] });
    const r = await correr(gastos, sb, 'listar_gastos_categoria', { categoria: 'Alimentación' }, { usuario: AMURALLADO });
    expect(r).toBe(MSG_LECTURA_CAIDA);
    expect(sb._llamadas.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// El radio de explosión: por qué los cinco DEVUELVEN en vez de lanzar
// ═══════════════════════════════════════════════════════════════════════════════

describe('los cinco sitios sin catch propio no pueden lanzar', () => {
  /**
   * Encima de ellos hay dos `catch` que se tragan el throw y SIGUEN hacia la rama que
   * registra (`intents/transacciones.js`, los dos redirects de `registrar_manual`), y
   * `detectarQuerySinMonto` manda ahí justo a `listar_gastos_dia`. O sea que un throw acá no
   * es "un error honesto": es una consulta convertida en un intento de registrar plata.
   *
   * Mutación que mata a este bloque: cambiar cualquiera de los cinco `return MSG_LECTURA_CAIDA`
   * por un `throw`.
   */
  const CINCO = [
    ['listar_gastos_mes por cuenta', 'listar_gastos_mes', {}, { usuario: { ...USUARIO, reporte_gmail_modo: 'separado' }, extras: { obtenerCuentasGmail: vi.fn().mockResolvedValue([{ email: 'a@x.com' }, { email: 'b@x.com' }]) } }],
    ['listar_gastos_mes histórico', 'listar_gastos_mes', { mes: 3, anio: 2026 }, {}],
    ['listar_gastos_dia', 'listar_gastos_dia', {}, { msg: 'cuanto gaste hoy' }],
    ['listar_gastos_categoria', 'listar_gastos_categoria', { categoria: 'Alimentación' }, {}],
    ['gastos_hormiga', 'gastos_hormiga', {}, {}],
  ];

  for (const [nombre, intencion, datos, opts] of CINCO) {
    it(nombre + ' resuelve con mensaje en vez de rechazar', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      await expect(correr(gastos, sb, intencion, datos, opts)).resolves.toBe(MSG_LECTURA_CAIDA);
    });
  }

  it('el redirect de "cuanto gaste hoy" apunta de verdad a uno de los cinco', () => {
    // Sin esto, el bloque de arriba defiende contra un peligro hipotético. `detectarQuerySinMonto`
    // es el que elige el destino, y si algún día deja de mandar a `listar_gastos_dia` la
    // justificación del `return` cambia y hay que volver a decidirla.
    expect(detectarQuerySinMonto('cuanto gaste hoy')).toEqual({ intencion: 'listar_gastos_dia', datos: {} });
  });

  it('y el dispatch real lo entrega sin lanzar', async () => {
    const sb = makeSupabase({ fallos: [CAE_TODO] });
    const d = await dispatchIntent({
      intencion: 'listar_gastos_dia', msg: 'cuanto gaste hoy', datos: {},
      usuario: LIBRE, from: '+51999', ctx: ctxBase(sb),
    });
    expect(d.manejado).toBe(true);
    expect(d.respuesta).toBe(MSG_LECTURA_CAIDA);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// utilidades.js — 4 sitios (dos son el par de comparar_meses)
// ═══════════════════════════════════════════════════════════════════════════════

describe('utilidades.js', () => {
  describe('buscar_gasto (sitio 71)', () => {
    const datos = { comercio: 'Netflix' };

    it('con datos, suma los pagos', async () => {
      const sb = makeSupabase({ filas: () => [TX({ comercio: 'Netflix' })] });
      const r = await correr(utilidades, sb, 'buscar_gasto', datos);
      expect(r).toMatch(/Total: \*S\/ 45\.50\*/);
    });

    it('sin filas dice "No encontré gastos de Netflix"', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(utilidades, sb, 'buscar_gasto', datos);
      expect(r).toMatch(/No encontré gastos de \*Netflix\*/);
    });

    it('con la lectura caída NO afirma sobre Netflix', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(utilidades, sb, 'buscar_gasto', datos);
      expect(r).toBe('No pude buscar ese gasto. Intenta de nuevo.');
      expect(r).not.toMatch(/No encontré gastos/);
    });
  });

  describe('comparar_meses (sitios 100 y 101) — el Promise.all', () => {
    const datos = { mes1: 4, anio1: 2026, mes2: 3, anio2: 2026 };
    const abril = (c) => desde(c, '2026-04-01');
    const marzo = (c) => desde(c, '2026-03-01');
    const filasPorMes = (c) => (abril(c) ? [TX({ monto_pen: 300 })] : [TX({ monto_pen: 100 })]);

    it('con las dos mitades, compara', async () => {
      const sb = makeSupabase({ filas: filasPorMes });
      const r = await correr(utilidades, sb, 'comparar_meses', datos);
      expect(r).toMatch(/Diferencia: \*\+S\/ 200\.00\*/);
    });

    it('con las dos vacías, compara ceros — y eso es cierto', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(utilidades, sb, 'comparar_meses', datos);
      expect(r).toMatch(/Diferencia: \*\+S\/ 0\.00\*/);
    });

    // Las dos mitades, una por vez. El fixture tiene que poder tirar UNA sola: si tirara las
    // dos, este caso saldría verde sin haber ejercitado nunca la mitad que llega entera, que
    // es justo la que fabrica el número falso.
    for (const [nombre, cae, sobrevive] of [['mes1', abril, marzo], ['mes2', marzo, abril]]) {
      it('si cae SOLO ' + nombre + ', no imprime una diferencia inventada', async () => {
        const sb = makeSupabase({ filas: filasPorMes, fallos: [(c) => (cae(c) ? 'statement timeout' : null)] });
        const r = await correr(utilidades, sb, 'comparar_meses', datos);
        expect(r).toBe('No pude comparar los meses. Intenta: "compara marzo con febrero".');
        expect(r).not.toMatch(/Diferencia/);
        // La otra mitad SÍ corrió: sin esto el verde podría venir de que no se consultó nada.
        expect(sb.intento(sobrevive)).toBe(true);
      });
    }
  });

  describe('ver_frecuencia_comercio (sitio 132)', () => {
    const datos = { comercio: 'Rappi' };

    it('con datos, cuenta los pagos', async () => {
      const sb = makeSupabase({ filas: () => [TX({ comercio: 'Rappi' })] });
      const r = await correr(utilidades, sb, 'ver_frecuencia_comercio', datos);
      expect(r).toMatch(/1 pagos registrados/);
    });

    it('sin filas duda del nombre — ahí está bien', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(utilidades, sb, 'ver_frecuencia_comercio', datos);
      expect(r).toMatch(/¿Seguro que se llama así\?/);
    });

    it('con la lectura caída NO le manda a dudar del nombre', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(utilidades, sb, 'ver_frecuencia_comercio', datos);
      expect(r).toBe('No pude obtener la frecuencia. Intenta de nuevo.');
      expect(r).not.toMatch(/¿Seguro que se llama así\?/);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// analytics.js — 3 sitios
// ═══════════════════════════════════════════════════════════════════════════════

describe('analytics.js', () => {
  describe('ver_historial_cambios (sitio 84)', () => {
    it('con datos, lista los cambios', async () => {
      const sb = makeSupabase({ filas: () => [TX()] });
      const r = await correr(analytics, sb, 'ver_historial_cambios');
      expect(r).toMatch(/Cambios recientes/);
    });

    it('sin filas da el visto bueno', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const r = await correr(analytics, sb, 'ver_historial_cambios');
      expect(r).toMatch(/No hiciste cambios hoy/);
    });

    it('con la lectura caída NO da un visto bueno que no puede sostener', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const r = await correr(analytics, sb, 'ver_historial_cambios');
      expect(r).toBe('No pude consultar los cambios recientes. Intenta de nuevo.');
      expect(r).not.toMatch(/No hiciste cambios hoy/);
    });
  });

  // Las dos ramas son EXCLUSIVAS, no un par: cada una necesita su propia guarda porque la
  // otra ni se arma. Un solo caso dejaría la otra rama sin cubrir y la mutación sobreviviría.
  for (const [nombre, periodo, vacio] of [
    ['rama semana (sitio 110)', 'semana', /No tienes ingresos registrados esta semana/],
    ['rama mes (sitio 115)', 'mes', /No tienes ingresos registrados en Abril/],
  ]) {
    describe('ver_ingresos, ' + nombre, () => {
      const datos = { periodo };

      it('con datos, suma los ingresos', async () => {
        const sb = makeSupabase({ filas: () => [TX({ tipo: 'ingreso', monto: 4500, monto_pen: 4500 })] });
        const r = await correr(analytics, sb, 'ver_ingresos', datos);
        expect(r).toMatch(/Total: \*S\/ 4500\.00\*/);
      });

      it('sin filas dice que no tiene ingresos', async () => {
        const sb = makeSupabase({ filas: () => [] });
        const r = await correr(analytics, sb, 'ver_ingresos', datos);
        expect(r).toMatch(vacio);
      });

      it('con la lectura caída NO niega el sueldo que la persona anotó', async () => {
        const sb = makeSupabase({ fallos: [CAE_TODO] });
        const r = await correr(analytics, sb, 'ver_ingresos', datos);
        expect(r).toBe('No pude consultar tus ingresos. Intenta de nuevo.');
        expect(r).not.toMatch(/No tienes ingresos registrados/);
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// presupuestos.js — el par de ver_balance
// ═══════════════════════════════════════════════════════════════════════════════

describe('presupuestos.js — ver_balance (sitios 70 y 71), el Promise.all que miente peor', () => {
  const gasto = (c) => tiene(c, 'tipo', 'gasto');
  const ingreso = (c) => tiene(c, 'tipo', 'ingreso');
  const filasPorTipo = (c) => (gasto(c) ? [TX({ monto_pen: 800 })] : [TX({ tipo: 'ingreso', monto_pen: 2000 })]);

  it('con las dos mitades, calcula el balance', async () => {
    const sb = makeSupabase({ filas: filasPorTipo });
    const r = await correr(presupuestos, sb, 'ver_balance', {}, { msg: 'cual es mi balance' });
    expect(r).toMatch(/Balance: \*\+S\/ 1200\.00\*/);
  });

  it('con las dos vacías, balance cero — y eso es cierto', async () => {
    const sb = makeSupabase({ filas: () => [] });
    const r = await correr(presupuestos, sb, 'ver_balance', {}, { msg: 'cual es mi balance' });
    expect(r).toMatch(/Balance: \*\+S\/ 0\.00\*/);
  });

  it('si caen SOLO los ingresos, no reporta un balance negativo inventado', async () => {
    // El caso que da nombre al ítem: la mitad de gastos llega entera, así que
    // `balance = 0 − 800` sale −S/ 800.00 con el ⚠️ y un "gastaste el 100% de tus ingresos".
    // Nada en la pantalla delataba que faltó una consulta.
    const sb = makeSupabase({ filas: filasPorTipo, fallos: [(c) => (ingreso(c) ? 'statement timeout' : null)] });
    const r = await correr(presupuestos, sb, 'ver_balance', {}, { msg: 'cual es mi balance' });
    expect(r).toBe('No pude calcular tu balance. Intenta de nuevo.');
    expect(r).not.toMatch(/Balance:/);
    expect(r).not.toMatch(/-S\/ 800\.00/);
    expect(sb.intento(gasto)).toBe(true);   // la mitad que sobrevive corrió de verdad
  });

  it('si caen SOLO los gastos, tampoco', async () => {
    const sb = makeSupabase({ filas: filasPorTipo, fallos: [(c) => (gasto(c) ? 'statement timeout' : null)] });
    const r = await correr(presupuestos, sb, 'ver_balance', {}, { msg: 'cual es mi balance' });
    expect(r).toBe('No pude calcular tu balance. Intenta de nuevo.');
    expect(r).not.toMatch(/Balance:/);
    expect(sb.intento(ingreso)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Los tres sitios cuya lectura vive en el helper (no son de los 16 — ver el docblock
// de `leerOMensaje` en gastos.js)
// ═══════════════════════════════════════════════════════════════════════════════

describe('los tres call-sites de obtenerGastosMes/Semana contestan igual que sus hermanos', () => {
  /**
   * `obtenerGastosMes`/`obtenerGastosSemana` LANZAN desde el ítem 8. Sin estas tres guardas,
   * `listar_gastos_mes` contestaba de dos formas opuestas según la rama: mensaje honesto para
   * un mes pasado, y `throw` —o sea "Tuve un problema" + fila en `nlp_errors` + aviso al
   * admin— para el mes actual, que es el caso por defecto (`datos.mes || mesActual`).
   */
  const CAE = () => { throw new Error('statement timeout'); };

  const CASOS = [
    ['listar_gastos_mes, mes actual', 'listar_gastos_mes', {}, { obtenerGastosMes: CAE }],
    ['listar_gastos_semana', 'listar_gastos_semana', {}, { obtenerGastosSemana: CAE }],
    ['ver_total_gastado, mes', 'ver_total_gastado', {}, { obtenerGastosMes: CAE }],
    ['ver_total_gastado, semana', 'ver_total_gastado', { periodo: 'semana' }, { obtenerGastosSemana: CAE }],
  ];

  for (const [nombre, intencion, datos, extras] of CASOS) {
    it(nombre + ': con el helper caído devuelve mensaje, no lanza', async () => {
      const sb = makeSupabase({ filas: () => [] });
      await expect(correr(gastos, sb, intencion, datos, { extras })).resolves.toBe(MSG_LECTURA_CAIDA);
    });
  }

  it('el camino feliz sigue intacto: con datos, responde con datos', async () => {
    const sb = makeSupabase({ filas: () => [] });
    const r = await correr(gastos, sb, 'ver_total_gastado', {}, { extras: { obtenerGastosMes: async () => [TX({ monto_pen: 120 })] } });
    expect(r).toMatch(/Llevas \*S\/ 120\.00\*/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// El rastro en producción: `tag: LECTURA_CAIDA`
// ═══════════════════════════════════════════════════════════════════════════════

describe('cada caída deja su rastro con el tag que se busca en producción', () => {
  /**
   * El mensaje al usuario no distingue una caída de otra, así que el `tag` es lo ÚNICO que
   * permite saber si esto pasa y con qué frecuencia. Hasta la revisión adversarial, 7 de los 8
   * `log.warn` del diff no estaban afirmados por ningún test ni tocados por ninguna mutación:
   * borrarlos o renombrarles el tag salía verde en la suite entera.
   */
  const CAE = () => { throw new Error('statement timeout'); };
  const CASOS = [
    ['gastos:37 por cuenta', gastos, 'listar_gastos_mes', {}, { usuario: { ...USUARIO, reporte_gmail_modo: 'separado' }, extras: { obtenerCuentasGmail: vi.fn().mockResolvedValue([{ email: 'a@x.com' }, { email: 'b@x.com' }]) } }],
    ['gastos:56 histórico', gastos, 'listar_gastos_mes', { mes: 3, anio: 2026 }, {}],
    ['gastos:99 día', gastos, 'listar_gastos_dia', {}, { msg: 'cuanto gaste hoy' }],
    ['gastos:130 categoría', gastos, 'listar_gastos_categoria', { categoria: 'Alimentación' }, {}],
    ['gastos:219 hormiga', gastos, 'gastos_hormiga', {}, {}],
    ['utilidades comparar_meses', utilidades, 'comparar_meses', { mes1: 4, anio1: 2026, mes2: 3, anio2: 2026 }, {}],
    ['presupuestos ver_balance', presupuestos, 'ver_balance', {}, { msg: 'cual es mi balance' }],
    ['helper mes actual', gastos, 'listar_gastos_mes', {}, { extras: { obtenerGastosMes: CAE } }],
    ['helper semana', gastos, 'listar_gastos_semana', {}, { extras: { obtenerGastosSemana: CAE } }],
    ['helper total gastado', gastos, 'ver_total_gastado', {}, { extras: { obtenerGastosMes: CAE } }],
  ];

  for (const [nombre, mod, intencion, datos, opts] of CASOS) {
    it(nombre + ' loguea LECTURA_CAIDA', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const sb = makeSupabase({ fallos: [CAE_TODO] });
        await correr(mod, sb, intencion, datos, opts);
        const deLectura = warn.mock.calls.filter((c) => c[0] && c[0].tag === 'LECTURA_CAIDA');
        expect(deLectura.length).toBeGreaterThan(0);
        expect(deLectura[0][0]).toMatchObject({ intencion, usuarioId: (opts.usuario || USUARIO).id });
      } finally { warn.mockRestore(); }
    });
  }

  it('cuando caen las DOS mitades, el diagnóstico las nombra a las dos', async () => {
    // Antes decía `mitad: errG ? 'gastos' : 'ingresos'`, o sea que con las dos caídas
    // reportaba sólo la primera: el log afirmaba de más sobre un caso que no había mirado.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      await correr(presupuestos, sb, 'ver_balance', {}, { msg: 'cual es mi balance' });
      const l = warn.mock.calls.filter((c) => c[0] && c[0].tag === 'LECTURA_CAIDA')[0][0];
      expect(l.mitad).toBe('gastos+ingresos');
    } finally { warn.mockRestore(); }
  });

  // Los MISMOS dos casos sobre `comparar_meses`. No es simetría decorativa: la mutación que
  // revierte su `mitad` a la forma vieja SOBREVIVIÓ mientras sólo estaba cubierto `ver_balance`,
  // o sea que los dos pares comparten forma y no comparten cobertura.
  it('comparar_meses: con las dos mitades caídas las nombra a las dos', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      await correr(utilidades, sb, 'comparar_meses', { mes1: 4, anio1: 2026, mes2: 3, anio2: 2026 });
      const l = warn.mock.calls.filter((c) => c[0] && c[0].tag === 'LECTURA_CAIDA')[0][0];
      expect(l.mitad).toBe('mes1+mes2');
    } finally { warn.mockRestore(); }
  });

  it('comparar_meses: con UNA sola nombra sólo esa', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const sb = makeSupabase({ fallos: [(c) => (desde(c, '2026-03-01') ? 'statement timeout' : null)] });
      await correr(utilidades, sb, 'comparar_meses', { mes1: 4, anio1: 2026, mes2: 3, anio2: 2026 });
      const l = warn.mock.calls.filter((c) => c[0] && c[0].tag === 'LECTURA_CAIDA')[0][0];
      expect(l.mitad).toBe('mes2');
    } finally { warn.mockRestore(); }
  });

  it('y con UNA sola caída nombra sólo esa', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const sb = makeSupabase({ fallos: [(c) => (tiene(c, 'tipo', 'ingreso') ? 'statement timeout' : null)] });
      await correr(presupuestos, sb, 'ver_balance', {}, { msg: 'cual es mi balance' });
      const l = warn.mock.calls.filter((c) => c[0] && c[0].tag === 'LECTURA_CAIDA')[0][0];
      expect(l.mitad).toBe('ingresos');
    } finally { warn.mockRestore(); }
  });
});
