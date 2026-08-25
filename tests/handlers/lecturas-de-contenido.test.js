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
 * **El perímetro son 36 sitios: los 16 de 9B, los 14 de 9B-quater** (deudas 2, espacios 2,
 * metas 8, moderación 1, presupuestos 1) **y los 6 de 9F**, cerrados abajo cada uno en su
 * sección.
 *
 * **Acá decía que las 8 de `transacciones.js` "fallan cerrado" y era FALSO para 6 de ellas.**
 * Es la misma afirmación que el backlog repitió tres veces sin medirla. Las seis que ENCUENTRAN
 * la fila a editar fallaban ABIERTO: con la búsqueda caída caían a la última transacción del
 * usuario y le escribían encima. Cerradas por 9F (sección de abajo).
 *
 * Las **2** que quedan mudas —`eliminar_transaccion` (757) y `restaurar_eliminado` (861)—
 * fallan cerrado **para la ESCRITURA**, verificado leyéndolas: con filtro caen en
 * `candidatos.length === 0` y devuelven "no encontré", y la rama sin filtro no consulta el
 * resultado de la query. Pero **siguen MINTIENDO sobre la causa**, o sea que por el criterio
 * con que 9B se definió a sí mismo ("no había datos" vs "no se pudo preguntar") todavía están
 * adentro. El de 861 tiene consecuencia de plata diferida: se le dice "no tengo nada para
 * restaurar", la persona vuelve a anotar el gasto a mano, y la copia sigue PENDIENTE — un
 * "restaura" posterior la re-inserta y queda duplicado. Quedan afuera de 9F por criterio de
 * escritura, no porque no haya nada que arreglar. El conteo se re-mide con
 * `node scripts/inventario-escrituras-intents.mjs`, que hoy da `lecturas mudas=2`.
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
      let verbo = 'select';
      let payload = null;
      let head = false;
      let conCount = false;
      // Los filtros se REGISTRAN sobre el `select`, no se tiran. Es lo que hace discriminable
      // una mitad de un `Promise.all` de la otra: las dos son `transacciones:select` y sólo
      // difieren en el WHERE (`tipo=gasto` vs `tipo=ingreso`, `fecha>=desde1` vs `desde2`).
      // `args` completo, no sólo los dos primeros: `.not('sent_at', 'is', null)` lleva TRES, y
      // con `{op,col,val}` el tercero se perdía. Ningún fixture de hoy lo mira; el que lo
      // mire mañana discriminaría mal sin enterarse.
      for (const op of ['eq', 'ilike', 'gte', 'lte', 'neq', 'is', 'not', 'or', 'in']) {
        b[op] = (...args) => { filtros.push({ op, col: args[0], val: args[1], args }); return b; };
      }
      // `order` y `limit` NO se registran, y eso acota lo que este mock puede discriminar: las
      // tres lecturas de `metas_ahorro` de viabilidad/abandonar/recortes arman una query
      // idéntica, así que se separan por la `intencion` con que corre el caso, no por el WHERE.
      for (const op of ['order', 'limit']) b[op] = () => b;
      // `head: true` se registra en vez de ignorarse. Es lo que hace medible el arreglo de
      // `crear_meta`: con `head` postgrest devuelve `data: null` POR CONTRATO y el número en
      // `count`, así que un mock que igual devolviera filas dejaría pasar el `.length` viejo —
      // el bug se vería arreglado sin estarlo.
      b.select = (_cols, opts) => { if (opts && opts.head) head = true; if (opts && opts.count) conCount = true; return b; };
      // Las escrituras existen acá porque tres de los catorce sitios siguen de largo hacia un
      // `verificarEscritura`, y sin ellas el caso "la lectura anduvo" ni siquiera llega al final.
      for (const op of ['insert', 'update', 'delete', 'upsert']) {
        b[op] = (p) => { verbo = op; payload = p || null; return b; };
      }
      const resolver = () => {
        const llamada = { tabla, filtros, verbo, payload };
        llamadas.push(llamada);
        for (const f of fallos) {
          const msg = f(llamada);
          // Un PostgrestError de verdad: los sitios que lanzan tiran ESTE objeto, y el
          // `catch` de arriba lee `e.message`. Si algún día se envuelve en `new Error`, este
          // fixture sigue siendo el contrato.
          if (msg) return { data: null, error: { message: msg, code: '57014', details: null } };
        }
        const data = filas(llamada);
        // Sin `{ count: 'exact' }` postgrest devuelve `count: null`. Devolverlo siempre hacía
        // que sacarle esa opción a la query saliera verde: el mock tapaba la mutación.
        return { data: head ? null : data, count: conCount && Array.isArray(data) ? data.length : null, error: null };
      };
      b.then = (ok, ko) => Promise.resolve().then(resolver).then(ok, ko);
      // **`single` y `maybeSingle` NO son sinónimos, y acá la diferencia decide un log.** Con
      // `single`, cero filas vuelve como error `PGRST116` — o sea que una guarda de `error`
      // puesta sobre un `.single()` grita "lectura caída" sobre el camino sano. El opt-out de
      // `moderacion.js` pasó a `maybeSingle` por eso, y esta asimetría es lo único que lo
      // sostiene: revertirlo pone rojo el caso de cero filas.
      b.single = async () => {
        const r = resolver();
        if (r.error) return r;
        const fila = (r.data || [])[0] || null;
        if (!fila) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: null } };
        return { data: fila, error: null };
      };
      b.maybeSingle = async () => { const r = resolver(); return r.error ? r : { data: (r.data || [])[0] || null, error: null }; };
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

// ═══════════════════════════════════════════════════════════════════════════════
// 9B-quater — las 14 lecturas mudas que 9B dejó abiertas a propósito
//
// Misma clase que las 16 de arriba y mismo mock, con dos diferencias que cambian cómo se
// escriben los casos:
//
//   · **Los 13 `case` de estos 14 sitios tienen `catch` propio** (verificado uno por uno, no
//     por archivo). Un `throw` desde la lectura no llega al catch general de
//     `procesarMensajeLibre` —o sea que NO escribe en `nlp_errors` ni avisa al admin, que es
//     el motivo por el que los cinco sitios de `gastos.js` devuelven en vez de lanzar—: lo
//     atrapa el catch de al lado y sale por su mensaje honesto. Por eso acá el arreglo es
//     `log.warn(LECTURA_CAIDA) + throw`.
//     **NO es una receta para el directorio**, y la revisión adversarial lo midió: `case`
//     vecinos SIN try/catch —`ver_presupuesto`, `configurar_presupuesto`, `ver_categorias`,
//     `desconectar_cuenta`, `cargar_excel`— mandarían el throw justo al catch que este patrón
//     existe para evitar. Antes de copiarlo, mirá si el `case` tiene el suyo.
//   · **No todas ramifican igual, y el arreglo lo refleja.** Once mienten y cortan; una mueve
//     PLATA (`abonar_deuda`) y corta sólo cuando la lectura hacía falta; una avisa sin cortar
//     (`registrar_deuda`); y una es telemetría pura y NO toca el copy (`silenciar`). Un
//     `return` uniforme en las catorce habría apagado de más — el error del ítem 1.
//
// **El camino feliz afirma CERO logs en todos los casos.** Sin eso, un `log.warn`
// incondicional puesto arriba de la guarda pasa los tres casos de cada sitio y la cobertura
// del rastro es aparente. `correrEspiando` devuelve los `LECTURA_CAIDA` para que cada test
// tenga que decir cuántos espera, en vez de mirarlos sólo cuando conviene.
// ═══════════════════════════════════════════════════════════════════════════════

const deudas = require('../../handlers/intents/deudas');
const espacios = require('../../handlers/intents/espacios');
const metas = require('../../handlers/intents/metas');
const moderacion = require('../../handlers/intents/moderacion');

/** Corre `fn` y devuelve su respuesta junto a los `LECTURA_CAIDA` que dejó. */
async function correrEspiando(fn) {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
  try {
    const r = await fn();
    return { r, logs: warn.mock.calls.filter((c) => c[0] && c[0].tag === 'LECTURA_CAIDA').map((c) => c[0]) };
  } finally { warn.mockRestore(); error.mockRestore(); }
}

/**
 * `espacios.js` y tres `case` de `metas.js` resuelven sus servicios con un `require` DENTRO
 * del handler, así que el módulo cargado se puede prestar por la duración de una llamada.
 * No es pisar el require-cache: es sustituir exports en el objeto que ya está en memoria, y
 * se restauran en el `finally` aunque el caso lance.
 */
async function conModulo(ruta, stubs, fn) {
  const mod = require(ruta);
  const previos = {};
  for (const k of Object.keys(stubs)) { previos[k] = mod[k]; mod[k] = stubs[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(stubs)) mod[k] = previos[k]; }
}

const FREE = { id: 'u-1', plan: 'free', nombre: 'Favio' };
const PREMIUM = { id: 'u-1', plan: 'premium', nombre: 'Favio' };
const esSelect = (c) => c.verbo === 'select';

const ctxMetas = (sb, extras = {}) => ({
  supabase: sb,
  barraProgreso: () => '▓▓▓░░░░░░░',
  formatFecha: (f) => f || '',
  calcularRitmoAhorro: () => ({ montoMensual: null, enRitmo: true }),
  abonarMetaService: vi.fn(),
  registrarLogro: vi.fn(),
  verificarRachaAportes: vi.fn().mockResolvedValue(0),
  ...extras,
});

const META = (over = {}) => ({
  id: 'meta-1', usuario_id: 'u-1', nombre: 'Viaje', icono: '✈️',
  monto_objetivo: 3000, monto_actual: 600, fecha_limite: null,
  status: 'active', completada: false, monthly_quota: null,
  invite_code: 'ABCD1234', colaborativa: true, ...over,
});

const correrMetas = (sb, intencion, datos = {}, { usuario = PREMIUM, msg = '', extras = {} } = {}) =>
  metas.handle({ intencion, msg, datos, usuario, from: '+51999', ctx: ctxMetas(sb, extras) });

// ─── metas.js — 8 sitios ─────────────────────────────────────────────────────

describe('metas.js — las ocho lecturas de metas_ahorro', () => {
  describe('ver_metas (sitio 20)', () => {
    it('con datos, lista los planes', async () => {
      const sb = makeSupabase({ filas: () => [META()] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'ver_metas'));
      expect(r).toMatch(/\*Viaje\*/);
      expect(logs).toHaveLength(0);
    });

    it('sin filas dice que no tiene planes — y eso es cierto', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'ver_metas'));
      expect(r).toMatch(/No tienes planes de ahorro/);
      expect(logs).toHaveLength(0);
    });

    it('con la lectura caída NO dice que no tiene planes', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'ver_metas'));
      expect(r).toBe('No pude consultar tus metas. Intenta de nuevo.');
      expect(r).not.toMatch(/No tienes planes de ahorro/);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ intencion: 'ver_metas', usuarioId: 'u-1' });
    });
  });

  describe('crear_meta, el conteo del muro (sitio 62) — el que INFORMA y no decide', () => {
    const datos = { nombre: 'Moto', monto: 5000 };
    // El fixture separa la LECTURA del insert: con `CAE_TODO` el insert también falla y devuelve
    // el mismo texto que devolvería la guarda, o sea que el caso queda verde por el motivo
    // equivocado y no puede distinguir "cortó" de "escribió y falló". Lo encontró la revisión
    // adversarial, y es el defecto `negativo-que-rechaza-por-otra-condicion`.
    const SOLO_EL_CONTEO = (c) => (esSelect(c) && c.tabla === 'metas_ahorro' ? 'statement timeout' : null);
    const INSERT_OK = (c) => (esSelect(c) ? [] : [{ id: 'meta-9' }]);

    it('sin planes previos, un premium lo crea', async () => {
      const sb = makeSupabase({ filas: INSERT_OK });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'crear_meta', datos));
      expect(r).toMatch(/Plan de ahorro creado/);
      expect(logs).toHaveLength(0);
    });

    it('con el conteo caído, un premium CREA IGUAL: ese número no decidía nada', async () => {
      // La regresión que introdujo la primera versión de 9B-quater. `maxMetas` es Infinity en
      // Pro, así que el veredicto del muro no depende del conteo — cortar acá le costaba el plan
      // a quien paga por una consulta accesoria.
      const sb = makeSupabase({ filas: INSERT_OK, fallos: [SOLO_EL_CONTEO] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'crear_meta', datos));
      expect(r).toMatch(/Plan de ahorro creado/);
      expect(sb.cuenta((c) => c.verbo === 'insert')).toBe(1);
      expect(logs).toHaveLength(1);      // pero el rastro queda
    });

    it('en el muro, el motivo es el plan y NO un conteo que no explica nada', async () => {
      // `maxMetas` vale 0 en el muro, o sea que bloquea con cualquier número. "Ya tienes 0 plan
      // de ahorro activo" —lo que salía siempre— no era el motivo de nada.
      const sb = makeSupabase({ filas: () => [] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'crear_meta', datos, { usuario: FREE }));
      expect(r).toMatch(/Los planes de ahorro son de \*Neto Pro\*/);
      expect(r).not.toMatch(/Ya tienes 0/);
      expect(logs).toHaveLength(0);
    });

    // Con una CUOTA finita el conteo pasa a decidir, y ahí el sitio cambia de clase. No es un
    // hipotético de adorno: es la línea que separa "informa" de "ramifica", y se ejercita
    // poniéndole la cuota al plan en vez de razonarla en un comentario.
    describe('con una cuota finita (maxMetas = 3), el conteo SÍ decide', () => {
      const conCuota = (fn) => {
        const { PLAN_CONFIG } = require('../../lib/constants');
        const previo = PLAN_CONFIG.free.maxMetas;
        PLAN_CONFIG.free.maxMetas = 3;
        return Promise.resolve().then(fn).finally(() => { PLAN_CONFIG.free.maxMetas = previo; });
      };

      it('recita el conteo REAL: el head:true lo dejaba en 0 SIEMPRE', async () => {
        const sb = makeSupabase({ filas: () => [META(), META({ id: 'm-2' }), META({ id: 'm-3' })] });
        const { r, logs } = await correrEspiando(() => conCuota(() => correrMetas(sb, 'crear_meta', datos, { usuario: FREE })));
        expect(r).toMatch(/Ya tienes 3 planes de ahorro activos \(máximo 3\)/);
        expect(r).not.toMatch(/Ya tienes 0/);
        expect(logs).toHaveLength(0);
      });

      it('bajo la cuota, crea', async () => {
        const sb = makeSupabase({ filas: (c) => (esSelect(c) ? [META()] : [{ id: 'meta-9' }]) });
        const { r } = await correrEspiando(() => conCuota(() => correrMetas(sb, 'crear_meta', datos, { usuario: FREE })));
        expect(r).toMatch(/Plan de ahorro creado/);
      });

      it('con el conteo caído NO crea a ciegas: un 0 por defecto abriría el muro', async () => {
        const sb = makeSupabase({ filas: INSERT_OK, fallos: [SOLO_EL_CONTEO] });
        const { r, logs } = await correrEspiando(() => conCuota(() => correrMetas(sb, 'crear_meta', datos, { usuario: FREE })));
        expect(r).toBe('No pude crear el plan. Intenta de nuevo.');
        expect(sb.cuenta((c) => c.verbo === 'insert')).toBe(0);
        expect(logs).toHaveLength(1);
      });
    });
  });

  describe('editar_meta (sitio 111)', () => {
    const datos = { monto_nuevo: '3000' };

    it('con datos, edita', async () => {
      const sb = makeSupabase({ filas: (c) => (esSelect(c) ? [META()] : [{ id: 'meta-1' }]) });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'editar_meta', datos));
      expect(r).toMatch(/actualizada/);
      expect(logs).toHaveLength(0);
    });

    it('sin filas dice que no tiene metas', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'editar_meta', datos));
      expect(r).toMatch(/No tienes metas de ahorro/);
      expect(logs).toHaveLength(0);
    });

    it('con la lectura caída NO dice que no tiene metas', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'editar_meta', datos));
      expect(r).toBe('No pude editar la meta. Intenta de nuevo.');
      expect(r).not.toMatch(/No tienes metas de ahorro/);
      expect(logs).toHaveLength(1);
      expect(sb.cuenta((c) => c.verbo === 'update')).toBe(0);
    });
  });

  describe('eliminar_meta (sitio 156)', () => {
    it('con datos, elimina', async () => {
      const sb = makeSupabase({ filas: (c) => (esSelect(c) ? [META()] : [{ id: 'meta-1' }]) });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'eliminar_meta'));
      expect(r).toMatch(/Eliminé la meta/);
      expect(logs).toHaveLength(0);
    });

    it('sin filas dice que no tiene metas para eliminar', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'eliminar_meta'));
      expect(r).toBe('No tienes metas de ahorro para eliminar.');
      expect(logs).toHaveLength(0);
    });

    it('con la lectura caída NO borra nada ni dice que no hay nada', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'eliminar_meta'));
      expect(r).toBe('No pude eliminar la meta. Intenta de nuevo.');
      expect(r).not.toMatch(/No tienes metas de ahorro/);
      expect(logs).toHaveLength(1);
      expect(sb.cuenta((c) => c.verbo === 'delete')).toBe(0);
    });
  });

  describe('compartir_meta (sitio 250)', () => {
    it('con datos, devuelve el link', async () => {
      const sb = makeSupabase({ filas: () => [META()] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'compartir_meta', {}, { msg: 'comparte mi meta' }));
      expect(r).toMatch(/app\.neto\.pe\/join\/meta\/ABCD1234/);
      expect(logs).toHaveLength(0);
    });

    it('sin filas dice que no tiene metas activas', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'compartir_meta', {}, { msg: 'comparte mi meta' }));
      expect(r).toMatch(/No tienes metas activas/);
      expect(logs).toHaveLength(0);
    });

    it('con la lectura caída NO dice que no tiene metas activas', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'compartir_meta', {}, { msg: 'comparte mi meta' }));
      expect(r).toBe('No pude generar el link. Intenta de nuevo.');
      expect(r).not.toMatch(/No tienes metas activas/);
      expect(logs).toHaveLength(1);
    });
  });

  // Los tres de abajo comparten la lectura carácter por carácter y NO comparten arreglo: cada
  // uno tiene su `case`, su catch y su copy. Un solo test sobre uno los daría por cubiertos.
  describe('viabilidad_plan (sitio 299)', () => {
    it('con datos, contesta sobre el plan', async () => {
      const sb = makeSupabase({ filas: () => [META()] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'viabilidad_plan'));
      expect(r).toMatch(/no tiene fecha límite/);
      expect(logs).toHaveLength(0);
    });

    it('sin filas dice que no tiene planes activos', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'viabilidad_plan'));
      expect(r).toBe('No tienes planes de ahorro activos.');
      expect(logs).toHaveLength(0);
    });

    it('con la lectura caída NO dice que no tiene planes activos', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'viabilidad_plan'));
      expect(r).toBe('No pude analizar la viabilidad. Intenta de nuevo.');
      expect(r).not.toMatch(/No tienes planes de ahorro activos/);
      expect(logs).toHaveLength(1);
    });
  });

  describe('abandonar_plan (sitio 327)', () => {
    const conAbandonar = (fn) => conModulo('../../services/metas', { abandonarPlan: vi.fn().mockResolvedValue(true) }, fn);

    it('con datos, abandona el plan', async () => {
      const sb = makeSupabase({ filas: () => [META()] });
      const { r, logs } = await correrEspiando(() => conAbandonar(() => correrMetas(sb, 'abandonar_plan')));
      expect(r).toMatch(/marcado como abandonado/);
      expect(logs).toHaveLength(0);
    });

    it('sin filas dice que no tiene planes activos', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const { r, logs } = await correrEspiando(() => conAbandonar(() => correrMetas(sb, 'abandonar_plan')));
      expect(r).toBe('No tienes planes de ahorro activos.');
      expect(logs).toHaveLength(0);
    });

    it('con la lectura caída NO dice que no tiene planes activos', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() => conAbandonar(() => correrMetas(sb, 'abandonar_plan')));
      expect(r).toBe('No pude procesar tu solicitud. Intenta de nuevo.');
      expect(r).not.toMatch(/No tienes planes de ahorro activos/);
      expect(logs).toHaveLength(1);
    });
  });

  describe('sugerir_recortes (sitio 357)', () => {
    it('con datos, contesta sobre el plan', async () => {
      const sb = makeSupabase({ filas: () => [META()] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'sugerir_recortes'));
      expect(r).toMatch(/no tiene cuota mensual definida/);
      expect(logs).toHaveLength(0);
    });

    it('sin filas dice que no tiene planes activos', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'sugerir_recortes'));
      expect(r).toBe('No tienes planes de ahorro activos.');
      expect(logs).toHaveLength(0);
    });

    it('con la lectura caída NO dice que no tiene planes activos', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() => correrMetas(sb, 'sugerir_recortes'));
      expect(r).toBe('No pude generar sugerencias. Intenta de nuevo.');
      expect(r).not.toMatch(/No tienes planes de ahorro activos/);
      expect(logs).toHaveLength(1);
    });
  });
});

// ─── espacios.js — 2 sitios ──────────────────────────────────────────────────

describe('espacios.js — las dos lecturas de space_members', () => {
  const ESPACIO = { id: 'sp-1', name: 'Depa', invite_code: 'DEPA1234' };
  const MIEMBROS = [
    { id: 'sm-1', user_id: 'u-1', usuarios: { nombre: 'Favio' } },
    { id: 'sm-2', user_id: 'u-2', usuarios: { nombre: 'Juan Pérez' } },
  ];

  const correrEspacios = (sb, intencion, datos, { usuario = PREMIUM, msg = '', stubs = {} } = {}) =>
    conModulo('../../services/shared-spaces', {
      obtenerEspaciosUsuario: vi.fn().mockResolvedValue([ESPACIO]),
      liquidarCuentas: vi.fn().mockResolvedValue(true),
      ...stubs,
    }, () => espacios.handle({ intencion, msg, datos, usuario, from: '+51999', ctx: { supabase: sb } }));

  describe('liquidar_espacio (sitio 185)', () => {
    const datos = { monto: 150, contraparte: 'Juan' };

    it('con miembros, registra el pago', async () => {
      const sb = makeSupabase({ filas: () => MIEMBROS });
      const { r, logs } = await correrEspiando(() => correrEspacios(sb, 'liquidar_espacio', datos));
      expect(r).toMatch(/Pago registrado/);
      expect(logs).toHaveLength(0);
    });

    it('si la contraparte no está en el espacio, lo dice — y es cierto', async () => {
      const sb = makeSupabase({ filas: () => [MIEMBROS[0]] });
      const { r, logs } = await correrEspiando(() => correrEspacios(sb, 'liquidar_espacio', datos));
      expect(r).toMatch(/No encontré a "Juan" en el espacio/);
      expect(logs).toHaveLength(0);
    });

    it('con la lectura caída NO afirma que la persona no está en el espacio', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() => correrEspacios(sb, 'liquidar_espacio', datos));
      expect(r).toBe('No pude registrar el pago. Intenta de nuevo.');
      expect(r).not.toMatch(/No encontré a/);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ intencion: 'liquidar_espacio', spaceId: 'sp-1' });
    });
  });

  describe('invitar_espacio (sitio 217) — el único que fallaba ABIERTO', () => {
    it('bajo el límite, entrega el link', async () => {
      const sb = makeSupabase({ filas: () => MIEMBROS });
      const { r, logs } = await correrEspiando(() => correrEspacios(sb, 'invitar_espacio', {}));
      expect(r).toMatch(/join\/space\/DEPA1234/);
      expect(logs).toHaveLength(0);
    });

    it('con el espacio lleno, bloquea', async () => {
      const llenos = Array.from({ length: 6 }, (_, i) => ({ id: 'sm-' + i, user_id: 'u-' + i }));
      const sb = makeSupabase({ filas: () => llenos });
      const { r, logs } = await correrEspiando(() => correrEspacios(sb, 'invitar_espacio', {}));
      expect(r).toMatch(/máximo 6/);
      expect(r).not.toMatch(/join\/space\//);
      expect(logs).toHaveLength(0);
    });

    it('con el conteo caído NO entrega el link: 0 miembros pasaba cualquier límite', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() => correrEspacios(sb, 'invitar_espacio', {}));
      expect(r).toBe('No pude generar la invitación. Intenta de nuevo.');
      expect(r).not.toMatch(/join\/space\//);
      expect(logs).toHaveLength(1);
    });
  });
});

// ─── deudas.js — 2 sitios ────────────────────────────────────────────────────

describe('deudas.js — las dos lecturas mudas', () => {
  const ctxDeudas = (sb, extras = {}) => ({
    supabase: sb,
    hoyPeru: () => '2026-04-15',
    registrarDeuda: vi.fn().mockResolvedValue({ id: 'd-1' }),
    formatearResumenDeudas: vi.fn().mockResolvedValue('resumen'),
    abonarDeuda: vi.fn().mockResolvedValue({ deuda: { contraparte: 'Juan', moneda: 'PEN', monto_original: 200, monto_pendiente: 100 }, completada: false }),
    marcarDeudaPagada: vi.fn(), consolidarDeudasPorContraparte: vi.fn(), saldarTodasDeudas: vi.fn(),
    ...extras,
  });
  const correrDeudas = (sb, intencion, datos, { msg = '', extras = {} } = {}) => {
    const ctx = ctxDeudas(sb, extras);
    return { ctx, p: deudas.handle({ intencion, msg, datos, usuario: PREMIUM, from: '+51999', ctx }) };
  };

  describe('registrar_deuda, la corrección de la opuesta (sitio 116) — AVISA, no corta', () => {
    const datos = { tipo: 'debo', contraparte: 'Juan', monto: 200 };
    const AVISO_NO_PUDE = /No pude revisar si te quedó la anotación opuesta/;

    it('sin opuesta reciente, anota la deuda y no avisa nada', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const { r, logs } = await correrEspiando(() => correrDeudas(sb, 'registrar_deuda', datos).p);
      expect(r).toMatch(/Le debes \*S\/ 200\.00\* a \*Juan\*/);
      expect(r).not.toMatch(AVISO_NO_PUDE);
      expect(r).not.toMatch(/te quedó también la anotación opuesta/);
      expect(logs).toHaveLength(0);
    });

    it('con opuesta reciente y el DELETE ok, tampoco avisa', async () => {
      const sb = makeSupabase({ filas: () => [{ id: 'dup-1' }] });
      const { r, logs } = await correrEspiando(() => correrDeudas(sb, 'registrar_deuda', datos).p);
      expect(r).not.toMatch(/⚠️/);
      expect(sb.cuenta((c) => c.verbo === 'delete')).toBe(1);
      expect(logs).toHaveLength(0);
    });

    it('con la lectura caída, la deuda entra IGUAL pero el aviso sale', async () => {
      // El desenlace malo es el mismo que el del DELETE fallido —quedan las dos anotaciones
      // opuestas vivas—, y antes de 9B-quater este camino no producía ningún aviso.
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { ctx, p } = correrDeudas(sb, 'registrar_deuda', datos);
      const { r, logs } = await correrEspiando(() => p);
      expect(r).toMatch(/Le debes \*S\/ 200\.00\* a \*Juan\*/);   // lo que vino a hacer, hecho
      expect(ctx.registrarDeuda).toHaveBeenCalled();
      expect(r).toMatch(AVISO_NO_PUDE);
      expect(logs).toHaveLength(1);
    });

    it('el texto del aviso NO afirma que la opuesta existe: no se pudo mirar', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r } = await correrEspiando(() => correrDeudas(sb, 'registrar_deuda', datos).p);
      expect(r).not.toMatch(/te quedó también la anotación opuesta/);
    });
  });

  describe('abonar_deuda, el pendiente para la fracción (sitio 199) — la de PLATA', () => {
    it('con el pendiente leído, "la mitad" abona la mitad', async () => {
      const sb = makeSupabase({ filas: () => [{ monto_pendiente: '200' }] });
      const { ctx, p } = correrDeudas(sb, 'abonar_deuda', { contraparte: 'Juan' }, { msg: 'le pagué la mitad a Juan' });
      const { logs } = await correrEspiando(() => p);
      expect(ctx.abonarDeuda).toHaveBeenCalledWith('u-1', 'Juan', 100);
      expect(logs).toHaveLength(0);
    });

    it('sin deuda activa con esa persona, lo dice — y no cae al fallback numérico', async () => {
      const sb = makeSupabase({ filas: () => [] });
      const { ctx, p } = correrDeudas(sb, 'abonar_deuda', { contraparte: 'Juan' }, { msg: 'le pagué la mitad de los 300 a Juan' });
      const { r, logs } = await correrEspiando(() => p);
      expect(r).toMatch(/no encontré una deuda activa con saldo pendiente con \*Juan\*/);
      expect(ctx.abonarDeuda).not.toHaveBeenCalled();   // el 300 del texto NO se abona
      expect(logs).toHaveLength(0);                     // no hubo caída: no había deuda, y punto
    });

    it('con la fila leída pero el pendiente en NULL, tampoco abona el número del texto', async () => {
      // `monto_pendiente` es nullable a propósito (migración 068). La fracción sale NaN,
      // `validarMonto` la anula, y hasta la revisión adversarial esto caía al fallback: "le pagué
      // la mitad de los 300 a Juan" abonaba 300. Misma plata mal registrada, otra causa.
      const sb = makeSupabase({ filas: () => [{ monto_pendiente: null }] });
      const { ctx, p } = correrDeudas(sb, 'abonar_deuda', { contraparte: 'Juan' }, { msg: 'le pagué la mitad de los 300 a Juan' });
      const { r } = await correrEspiando(() => p);
      expect(ctx.abonarDeuda).not.toHaveBeenCalled();
      expect(r).not.toMatch(/Abono anotado/);
    });

    it('el mensaje separa "no se pudo preguntar" de "no había deuda"', async () => {
      // Los dos desenlaces cortan igual, pero no dicen lo mismo: uno invita a reintentar y el
      // otro a revisar el nombre. Si se unifican, el corte deja de distinguir lo que este ítem
      // entero existe para distinguir.
      const caida = makeSupabase({ fallos: [CAE_TODO] });
      const vacia = makeSupabase({ filas: () => [] });
      const a = await correrEspiando(() => correrDeudas(caida, 'abonar_deuda', { contraparte: 'Juan' }, { msg: 'le pagué la mitad a Juan' }).p);
      const b = await correrEspiando(() => correrDeudas(vacia, 'abonar_deuda', { contraparte: 'Juan' }, { msg: 'le pagué la mitad a Juan' }).p);
      expect(a.r).not.toBe(b.r);
      expect(a.r).toMatch(/No pude consultar cuánto le debes/);
      expect(b.r).toMatch(/no encontré una deuda activa/);
    });

    it('con la lectura caída y un PORCENTAJE, no abona el número suelto del mensaje', async () => {
      // El daño concreto: "Annie me dio 50%" caía al fallback numérico, que agarra el primer
      // número del texto. Abonaba S/ 50 en vez del 50% del saldo — plata mal registrada, sin
      // que nada en la respuesta lo delatara.
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { ctx, p } = correrDeudas(sb, 'abonar_deuda', { contraparte: 'Annie' }, { msg: 'Annie me dio 50%' });
      const { r, logs } = await correrEspiando(() => p);
      expect(ctx.abonarDeuda).not.toHaveBeenCalled();
      expect(r).toMatch(/No pude consultar cuánto le debes/);
      expect(logs).toHaveLength(1);
    });

    it('con la lectura caída y "la mitad", no le echa la culpa a cómo escribió', async () => {
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { r, logs } = await correrEspiando(() =>
        correrDeudas(sb, 'abonar_deuda', { contraparte: 'Juan' }, { msg: 'le pagué la mitad a Juan' }).p);
      expect(r).toMatch(/No pude consultar cuánto le debes/);
      expect(r).not.toMatch(/¿A quién y cuánto\?/);
      expect(logs).toHaveLength(1);
    });

    it('con la lectura caída pero SIN fracción, sigue de largo: esa consulta no decidía nada', async () => {
      // Apagar acá sería apagar de más. El monto sale del texto y la respuesta es correcta;
      // lo único que queda es el rastro.
      const sb = makeSupabase({ fallos: [CAE_TODO] });
      const { ctx, p } = correrDeudas(sb, 'abonar_deuda', { contraparte: 'Juan' }, { msg: 'le pagué 80 a Juan' });
      const { r, logs } = await correrEspiando(() => p);
      expect(ctx.abonarDeuda).toHaveBeenCalledWith('u-1', 'Juan', 80);
      expect(r).toMatch(/Abono anotado/);
      expect(logs).toHaveLength(1);
    });
  });
});

// ─── moderacion.js — 1 sitio, y es el ACCESORIO ──────────────────────────────

describe('moderacion.js — el opt-out de survey_events (sitio 32)', () => {
  const correrMod = (sb) => moderacion.handle({
    intencion: 'silenciar', msg: 'silencia', datos: {}, usuario: PREMIUM, from: '+51999',
    ctx: { supabase: sb, obtenerCuentasGmail: vi.fn().mockResolvedValue([]) },
  });
  const CONFIRMA = /Recordatorios desactivados/;

  it('con un evento previo, lo marca — y confirma el silencio', async () => {
    const sb = makeSupabase({ filas: (c) => (c.tabla === 'usuarios' ? [{ id: 'u-1' }] : [{ id: 'ev-1' }]) });
    const { r, logs } = await correrEspiando(() => correrMod(sb));
    expect(r).toMatch(CONFIRMA);
    expect(sb.intento((c) => c.tabla === 'survey_events' && c.verbo === 'update')).toBe(true);
    expect(logs).toHaveLength(0);
  });

  it('sin evento previo NO grita: cero filas es el caso normal de quien nunca recibió encuesta', async () => {
    // El discriminador de `single` vs `maybeSingle`. Con `single`, cero filas vuelve como
    // PGRST116 —un `error`— y la guarda dispararía LECTURA_CAIDA todos los días sobre el
    // camino sano. Un warn que suena siempre es un warn que nadie lee.
    const sb = makeSupabase({ filas: (c) => (c.tabla === 'usuarios' ? [{ id: 'u-1' }] : []) });
    const { r, logs } = await correrEspiando(() => correrMod(sb));
    expect(r).toMatch(CONFIRMA);
    expect(sb.intento((c) => c.tabla === 'survey_events' && c.verbo === 'update')).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it('con la lectura caída deja rastro y NO toca el copy: el silencio ya está escrito', async () => {
    const sb = makeSupabase({ filas: () => [{ id: 'u-1' }], fallos: [(c) => (c.tabla === 'survey_events' ? 'statement timeout' : null)] });
    const { r, logs } = await correrEspiando(() => correrMod(sb));
    expect(r).toMatch(CONFIRMA);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ intencion: 'silenciar', usuarioId: 'u-1' });
  });
});

// ─── presupuestos.js — 1 sitio ───────────────────────────────────────────────

describe('presupuestos.js — eliminar_presupuesto (sitio 123)', () => {
  const datos = { categoria: 'Alimentación' };
  const PRES = { id: 'p-1', categoria: 'Alimentación', monto_limite: 500 };
  const NO_TIENES = /No tienes presupuesto de \*Alimentación\* este mes/;

  it('con presupuesto, lo elimina', async () => {
    const sb = makeSupabase({ filas: (c) => (esSelect(c) ? [PRES] : [{ id: 'p-1' }]) });
    const { r, logs } = await correrEspiando(() => correr(presupuestos, sb, 'eliminar_presupuesto', datos));
    expect(r).toMatch(/Eliminé el presupuesto/);
    expect(logs).toHaveLength(0);
  });

  it('sin presupuesto lo dice — y eso es cierto', async () => {
    const sb = makeSupabase({ filas: () => [] });
    const { r, logs } = await correrEspiando(() => correr(presupuestos, sb, 'eliminar_presupuesto', datos));
    expect(r).toMatch(NO_TIENES);
    expect(logs).toHaveLength(0);
  });

  it('con la lectura caída NO dice que no tiene presupuesto de esa categoría', async () => {
    const sb = makeSupabase({ fallos: [CAE_TODO] });
    const { r, logs } = await correrEspiando(() => correr(presupuestos, sb, 'eliminar_presupuesto', datos));
    expect(r).toBe('No pude eliminar el presupuesto. Intenta de nuevo.');
    expect(r).not.toMatch(NO_TIENES);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ intencion: 'eliminar_presupuesto', categoria: 'Alimentación' });
    expect(sb.cuenta((c) => c.verbo === 'delete')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9F — las 6 lecturas de `transacciones.js` que ENCUENTRAN la fila a editar
//
// **9B las declaró "fallan cerrado" tres veces y era FALSO para estas seis.** La forma es
// `if (!txEdit) txEdit = await obtenerUltimaTransaccion(usuario.id)` después de un lookup cuyo
// `{ error }` se descartaba: con la búsqueda caída el flujo no cortaba, caía a la ÚLTIMA
// transacción del usuario y le escribía encima. Con 38.4 transacciones por usuario esa casi
// nunca es la que la persona nombró — "el de Starbucks es 50" le ponía S/ 50 al taxi de hoy.
// (Las otras dos que siguen mudas —`eliminar_transaccion` y `restaurar_eliminado`— SÍ fallan
// cerrado: con filtro devuelven "no encontré nada" sin escribir, y sin filtro el camino no
// depende del resultado de la query. Se dejan mudas a propósito.)
//
// **El arreglo NO es cortar el fallback, y esa es la decisión del ítem.** Caer a la última es
// correcto cuando la búsqueda ANDUVO y no encontró nada: por chat "el último" es una heurística
// que la gente usa. Lo que se separa son los dos ceros. Por eso cada sitio se ejercita CUATRO
// veces y no tres: encuentra / no encuentra (fallback vivo) / no se pudo buscar (corta) / sin
// comercio (el fallback puro, que ninguna guarda puede tocar).
//
// **El discriminador que decide es a QUÉ FILA se le escribe**, no el copy: un arreglo que
// cortara de más saldría verde en "no escribió nada" y rompería la heurística en silencio. Por
// eso los casos afirman `update … eq('id', 'tx-buscada')` vs `eq('id', 'tx-ultima')`, y el caso
// caído afirma además que `obtenerUltimaTransaccion` NI SIQUIERA se consultó.
//
// El fallo se inyecta SÓLO sobre el select con `ilike` —no con `CAE_TODO`— para que el verde
// no pueda venir de que se cayó cualquier otra cosa: es la búsqueda la que no se pudo hacer.
// ═══════════════════════════════════════════════════════════════════════════════

const transacciones = require('../../handlers/intents/transacciones');

const BUSCADA = TX({ id: 'tx-buscada', comercio: 'Starbucks', monto: 12, fecha: '2026-04-10' });
const ULTIMA = TX({ id: 'tx-ultima', comercio: 'Taxi', monto: 8, fecha: '2026-04-15' });

const CAE_LA_BUSQUEDA = (c) =>
  (c.verbo === 'select' && c.filtros.some((f) => f.op === 'ilike') ? 'statement timeout' : null);
const CAE_LA_BUSQUEDA_POR_FECHA = (c) =>
  (c.verbo === 'select' && c.filtros.some((f) => f.op === 'eq' && f.col === 'fecha') ? 'statement timeout' : null);

const esBusqueda = (c) => c.verbo === 'select';
/** `filas` para los casos: qué devuelve el select y qué devuelve el update. */
const filasCon = (delSelect) => (c) => (esBusqueda(c) ? delSelect : [{ id: 'fila-tocada' }]);

function ctxTx(sb, extras = {}) {
  return {
    supabase: sb,
    mesActual: 4, anioActual: 2026,
    obtenerUltimaTransaccion: vi.fn().mockResolvedValue(ULTIMA),
    obtenerTipoCambio: vi.fn().mockResolvedValue({ venta: 3.75 }),
    fechaHoyPeru: () => '2026-04-15',
    fechaAyerPeru: () => '2026-04-14',
    formatFecha: (f) => f || '',
    ...extras,
  };
}

const correrTx = (sb, ctx, intencion, datos = {}, { usuario = USUARIO, msg = '' } = {}) =>
  transacciones.handle({ intencion, msg, datos, usuario, from: '+51999', ctx });

const SITIOS_9F = [
  { nombre: 'editar_monto (sitio 995)', intencion: 'editar_monto',
    datos: { comercio: 'Starbucks', monto_nuevo: '50' },
    ok: /Monto corregido/, caido: 'No pude corregir el monto. Intenta de nuevo.',
    sitio: 'editar_monto:comercio',
    vacio: 'No encuentro un gasto reciente para corregir.' },
  { nombre: 'editar_fecha (sitio 1054)', intencion: 'editar_fecha',
    datos: { comercio: 'Starbucks', fecha_nueva: 'ayer' },
    ok: /Fecha corregida/, caido: 'No pude corregir la fecha. Intenta de nuevo.',
    sitio: 'editar_fecha:comercio',
    vacio: 'No encuentro un gasto reciente para corregir.' },
  { nombre: 'editar_comercio (sitio 1083)', intencion: 'editar_comercio',
    datos: { comercio: 'Starbucks', comercio_nuevo: 'Plaza Vea' },
    ok: /Comercio corregido/, caido: 'No pude corregir el comercio. Intenta de nuevo.',
    sitio: 'editar_comercio:comercio',
    vacio: 'No encuentro un gasto reciente para corregir.' },
  { nombre: 'dividir_gasto (sitio 1113)', intencion: 'dividir_gasto',
    datos: { comercio: 'Starbucks', partes: '2' },
    ok: /Gasto dividido/, caido: 'No pude dividir el gasto. Intenta de nuevo.',
    sitio: 'dividir_gasto:comercio',
    vacio: 'No encuentro un gasto reciente para dividir.' },
  { nombre: 'marcar_como_ingreso (sitio 1287)', intencion: 'marcar_como_ingreso',
    datos: { comercio: 'Starbucks' },
    ok: /marcado como \*ingreso\*/, caido: 'No pude cambiar el tipo. Intenta de nuevo.',
    sitio: 'marcar_como_ingreso:comercio',
    vacio: 'No hay transacciones recientes para modificar.' },
];

describe('transacciones.js — las 6 lecturas que eligen la fila a editar (9F)', () => {
  for (const s of SITIOS_9F) {
    describe(s.nombre, () => {
      it('encuentra el comercio y edita ESA fila, sin consultar el fallback', async () => {
        const sb = makeSupabase({ filas: filasCon([BUSCADA]) });
        const ctx = ctxTx(sb);
        const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, s.intencion, s.datos));
        expect(r).toMatch(s.ok);
        // El WHERE del select, no sólo el del update: sin `usuario_id` la búsqueda alcanza
        // filas de OTRA persona, que es este mismo daño un escalón peor. Medido: quitarle ese
        // filtro dejaba la suite entera verde, acá y en HEAD.
        expect(sb.intento((c) => esBusqueda(c) && tiene(c, 'usuario_id', 'u-1'))).toBe(true);
        expect(sb.intento((c) => c.verbo === 'update' && tiene(c, 'id', 'tx-buscada'))).toBe(true);
        expect(ctx.obtenerUltimaTransaccion).not.toHaveBeenCalled();
        expect(logs).toHaveLength(0);
      });

      // El tercer desenlace, y lo trajo la revisión adversarial: la búsqueda anduvo, no
      // encontró nada, y el fallback TAMPOCO tiene nada — el usuario recién dado de alta.
      // No es cosmético: hasta esta vuelta esa rama la cubría UN caso de
      // `escrituras-de-plata.test.js` que llegaba ahí por accidente (con el select CAÍDO y el
      // fallback en `null`), y al arreglar ese caso la rama se quedó sin nada. Medido:
      // mutar los cinco `return` a 'ZZZ' sobrevivía a los 2398 tests.
      it('ni búsqueda ni fallback tienen nada: lo dice, sin logs de caída', async () => {
        const sb = makeSupabase({ filas: filasCon([]) });
        const ctx = ctxTx(sb, { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(null) });
        const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, s.intencion, s.datos));
        expect(r).toBe(s.vacio);
        expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
        expect(sb.cuenta((c) => c.verbo === 'update')).toBe(0);
        expect(logs).toHaveLength(0);
      });

      // LA aserción del ítem: el arreglo no puede apagar esta heurística. Si un día este caso
      // se pone rojo, el corte se comió el camino bueno.
      it('la búsqueda ANDUVO y no encontró nada: cae a la última, que es lo correcto', async () => {
        const sb = makeSupabase({ filas: filasCon([]) });
        const ctx = ctxTx(sb);
        const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, s.intencion, s.datos));
        expect(r).toMatch(s.ok);
        expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
        expect(sb.intento((c) => c.verbo === 'update' && tiene(c, 'id', 'tx-ultima'))).toBe(true);
        expect(logs).toHaveLength(0);
      });

      it('no se PUDO buscar: no cae a la última ni le escribe encima a nada', async () => {
        const sb = makeSupabase({ fallos: [CAE_LA_BUSQUEDA], filas: filasCon([BUSCADA]) });
        const ctx = ctxTx(sb);
        const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, s.intencion, s.datos));
        expect(r).toBe(s.caido);
        expect(ctx.obtenerUltimaTransaccion).not.toHaveBeenCalled();
        expect(sb.cuenta((c) => c.verbo === 'update')).toBe(0);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({ tag: 'LECTURA_CAIDA', intencion: s.intencion, usuarioId: 'u-1', sitio: s.sitio });
      });
    });
  }

  // El fallback puro: sin comercio no hay búsqueda que pueda caerse, así que ninguna guarda
  // nueva tiene derecho a tocar este camino. Sin este caso, un corte puesto un nivel más
  // arriba —antes del `if (datos.comercio)`— saldría verde en los tres de cada sitio.
  it('sin comercio ni fecha, va derecho a la última: ninguna guarda se mete', async () => {
    const sb = makeSupabase({ filas: filasCon([]) });
    const ctx = ctxTx(sb);
    const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, 'editar_monto', { monto_nuevo: '50' }));
    expect(r).toMatch(/Monto corregido/);
    expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
    expect(sb.intento((c) => c.verbo === 'update' && tiene(c, 'id', 'tx-ultima'))).toBe(true);
    expect(sb.cuenta(esBusqueda)).toBe(0);
    expect(logs).toHaveLength(0);
  });

  // La SEGUNDA lectura de `editar_monto`: el continuation que dice "el de ayer" sin comercio.
  // Comparte `case` y catch con la de arriba pero es una query distinta —`eq('fecha')` en vez
  // de `ilike`— y su propia guarda, así que necesita sus propios casos.
  describe('editar_monto por fecha_token (sitio 1007)', () => {
    const datos = { fecha_token: 'ayer', monto_nuevo: '50' };

    it('encuentra el de ayer y edita ESA fila', async () => {
      const sb = makeSupabase({ filas: filasCon([BUSCADA]) });
      const ctx = ctxTx(sb);
      const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, 'editar_monto', datos));
      expect(r).toMatch(/Monto corregido/);
      expect(sb.intento((c) => esBusqueda(c) && tiene(c, 'fecha', '2026-04-14'))).toBe(true);
      // **El SEXTO `usuario_id`, y la segunda revisión adversarial lo encontró justamente acá.**
      // La aserción de los otros cinco sitios se escribió dentro del loop de `SITIOS_9F`, que
      // cubre los que buscan por `ilike`. Este vive en su propio `describe`, así que quedó
      // afuera: quitarle el filtro al select sobrevivía a los 2405 tests. Y acá el daño es el
      // MISMO que el ítem viene a cerrar pero cross-user — "el de ayer es 50" sin comercio trae
      // la última fila con esa fecha de CUALQUIERA, y el update de abajo filtra sólo por `id`.
      expect(sb.intento((c) => esBusqueda(c) && tiene(c, 'usuario_id', 'u-1'))).toBe(true);
      expect(sb.intento((c) => c.verbo === 'update' && tiene(c, 'id', 'tx-buscada'))).toBe(true);
      expect(ctx.obtenerUltimaTransaccion).not.toHaveBeenCalled();
      expect(logs).toHaveLength(0);
    });

    it('no había nada ayer: cae a la última, que sigue siendo correcto', async () => {
      const sb = makeSupabase({ filas: filasCon([]) });
      const ctx = ctxTx(sb);
      const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, 'editar_monto', datos));
      expect(r).toMatch(/Monto corregido/);
      expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
      expect(sb.intento((c) => c.verbo === 'update' && tiene(c, 'id', 'tx-ultima'))).toBe(true);
      expect(logs).toHaveLength(0);
    });

    it('no se PUDO buscar por fecha: corta sin tocar nada', async () => {
      const sb = makeSupabase({ fallos: [CAE_LA_BUSQUEDA_POR_FECHA], filas: filasCon([BUSCADA]) });
      const ctx = ctxTx(sb);
      const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, 'editar_monto', datos));
      expect(r).toBe('No pude corregir el monto. Intenta de nuevo.');
      expect(ctx.obtenerUltimaTransaccion).not.toHaveBeenCalled();
      expect(sb.cuenta((c) => c.verbo === 'update')).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ tag: 'LECTURA_CAIDA', intencion: 'editar_monto', sitio: 'editar_monto:fecha_token' });
    });
  });

  // Las DOS guardas de `editar_monto` juntas, que es lo único que las prueba en interacción
  // (los tres casos de arriba corren sin `comercio`). Trae un cambio de comportamiento que hay
  // que declarar: **antes**, con el lookup por comercio caído, `found` quedaba `undefined`,
  // `txEditM` seguía `null` y el bloque de `fecha_token` corría igual, así que "el de
  // Starbucks de ayer" todavía se resolvía por fecha. **Ahora corta ahí.** Es deliberado: la
  // persona nombró un comercio, y resolver sólo por fecha elige una fila que no nombró — el
  // mismo daño que este ítem viene a cerrar, con otro disfraz. Mejor decirle que no se pudo.
  describe('editar_monto con comercio Y fecha_token (las dos guardas)', () => {
    const datos = { comercio: 'Starbucks', fecha_token: 'ayer', monto_nuevo: '50' };

    it('la búsqueda por comercio ANDUVO y no encontró: sigue al lookup por fecha', async () => {
      const sb = makeSupabase({ filas: (c) => (esBusqueda(c) && c.filtros.some((f) => f.op === 'ilike') ? [] : (esBusqueda(c) ? [BUSCADA] : [{ id: 'fila-tocada' }])) });
      const ctx = ctxTx(sb);
      const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, 'editar_monto', datos));
      expect(r).toMatch(/Monto corregido/);
      expect(sb.intento((c) => esBusqueda(c) && tiene(c, 'fecha', '2026-04-14'))).toBe(true);
      expect(sb.intento((c) => c.verbo === 'update' && tiene(c, 'id', 'tx-buscada'))).toBe(true);
      expect(logs).toHaveLength(0);
    });

    it('la búsqueda por comercio NO SE PUDO hacer: corta ahí, sin intentar por fecha', async () => {
      const sb = makeSupabase({ fallos: [CAE_LA_BUSQUEDA], filas: filasCon([BUSCADA]) });
      const ctx = ctxTx(sb);
      const { r, logs } = await correrEspiando(() => correrTx(sb, ctx, 'editar_monto', datos));
      expect(r).toBe('No pude corregir el monto. Intenta de nuevo.');
      expect(sb.cuenta((c) => esBusqueda(c) && tiene(c, 'fecha', '2026-04-14'))).toBe(0);
      expect(ctx.obtenerUltimaTransaccion).not.toHaveBeenCalled();
      expect(sb.cuenta((c) => c.verbo === 'update')).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ sitio: 'editar_monto:comercio' });
    });
  });

  // `marcar_como_ingreso` aparte: no cambia un monto, cambia el SIGNO de la fila. Un gasto de
  // S/ 8 marcado como ingreso mueve el balance del mes en S/ 16, y sobre la fila equivocada
  // eso no se nota — el usuario ve un balance mal y no sabe de dónde salió.
  //
  // **Este caso DOCUMENTA, no discrimina, y conviene decirlo** (lo midió la segunda revisión
  // adversarial): sus tres aserciones están implicadas por el `cuenta(update) === 0` del caso
  // "no se PUDO buscar" del mismo sitio — si no hubo ningún update, no hay payload con `tipo`
  // ni ningún `eq('id','tx-ultima')`. O sea que no puede ponerse rojo solo. Se queda porque
  // nombra el radio de daño, que es lo que hace que alguien lo piense dos veces antes de
  // ablandar la guarda; no porque agregue cobertura. Es la misma convención que el docblock de
  // arriba declara para los `not.toMatch` que van al lado de un `toBe`.
  it('marcar_como_ingreso con la búsqueda caída no le cambia el signo a la fila de al lado', async () => {
    const sb = makeSupabase({ fallos: [CAE_LA_BUSQUEDA], filas: filasCon([BUSCADA]) });
    const ctx = ctxTx(sb);
    const { r } = await correrEspiando(() =>
      correrTx(sb, ctx, 'marcar_como_ingreso', { comercio: 'Starbucks', tipo_nuevo: 'ingreso' }));
    expect(r).toBe('No pude cambiar el tipo. Intenta de nuevo.');
    expect(sb.cuenta((c) => c.payload && c.payload.tipo !== undefined)).toBe(0);
    expect(sb.intento((c) => tiene(c, 'id', 'tx-ultima'))).toBe(false);
  });
});
