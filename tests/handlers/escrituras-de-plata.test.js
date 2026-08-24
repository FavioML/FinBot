import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('../../handlers/intents/transacciones');

/**
 * CONFIRMACIÓN INCONDICIONAL — las 11 escrituras de plata de `handlers/intents/transacciones.js`
 * (ítem 9A del backlog de confiabilidad).
 *
 * La clase: un `update()`/`delete()` sobre plata seguido, sin ninguna condición, de un
 * `'✅ Fecha corregida'`, `'✅ Eliminé S/ 50'`, `'↩️ Deshecho'`. supabase-js no lanza —el fallo
 * viene en `error`— así que la escritura no entraba y al usuario se le afirmaba que sí. Y a
 * diferencia de un reporte que sale en S/ 0.00, **nadie vuelve a preguntar**.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE ARCHIVO NO USA EL MOCK DE `transacciones.test.js`
 *
 * Aquel mock falla por TABLA (`_setError('transacciones')`). Los once sitios LEEN y ESCRIBEN
 * la misma tabla, así que un fallo por tabla tumba las dos cosas a la vez y el test no puede
 * decir cuál de los dos arreglos se ejecutó: el mensaje de "no encuentro ese gasto" (que ya
 * existía, y es la clase 9B, que este commit NO toca) taparía al de "no pude guardar" sin que
 * nadie lo note. Es exactamente el defecto que el ítem 8 registró — *"el fixture no
 * discriminaba entre dos lecturas que comparten una columna, así que caía la lectura de al
 * lado y el caso salía verde sin ejercitar nunca la guarda que decía cubrir"*.
 *
 * Acá la clave del fallo es `(tabla, verbo)`, y **cada caso afirma las dos mitades**: que
 * aparece el mensaje que corresponde y que NO aparece el de la otra clase.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

// ─── Mock que discrimina lectura de escritura ────────────────────────────────

const MUTANTES = ['insert', 'update', 'delete', 'upsert'];

/**
 * `fallos['tabla:verbo']` acepta un string (falla siempre) o un ARRAY indexado por número de
 * llamada (`[null, 'db caída']` = la primera pasa, la segunda falla).
 *
 * El array hace falta de verdad, no es adorno: en `restaurar_eliminado` el claim de la copia y
 * su devolución a pendiente son las DOS un `transacciones_eliminadas:update`. Sin poder separar
 * la primera de la segunda, la guarda de la devolución es inalcanzable desde un test — la
 * misma clase de ceguera que la clave por tabla, un nivel más abajo.
 */
function makeSupabase({ filas = {}, fallos = {}, vacios = [], lanza = [] } = {}) {
  const llamadas = [];
  const nth = {};
  const fallo = (clave) => {
    const f = fallos[clave];
    if (f === undefined) return null;
    if (!Array.isArray(f)) return f;
    const i = (nth[clave] = (nth[clave] || 0) + 1) - 1;
    return f[i] || null;
  };
  const sb = {
    _llamadas: llamadas,
    // ¿se intentó esta operación? Sin esto, un verde puede venir de un `return` anterior y la
    // guarda que el caso dice cubrir nunca habría corrido (ver el negativo-que-rechaza-por-otra-
    // condición del backlog).
    intento: (tabla, verbo) => llamadas.some((c) => c.tabla === tabla && c.verbo === verbo),
    cuenta: (tabla, verbo) => llamadas.filter((c) => c.tabla === tabla && c.verbo === verbo).length,
    // **El WHERE, expuesto.** `intento()` sólo dice "se armó un delete", nunca "con este
    // WHERE" — y con eso, quitarle CUALQUIERA de sus filtros a un DELETE destructivo dejaba la
    // suite verde. Un borrado de plata no se prueba mirando que ocurrió: se prueba mirando a
    // qué apunta.
    filtros: (tabla, verbo, n = 0) => ((llamadas.filter((c) => c.tabla === tabla && c.verbo === verbo)[n]) || {}).filtros || null,
    from(tabla) {
      let verbo = 'select';
      const b = {};
      // Los filtros se REGISTRAN, no se tiran. Sobre una escritura, `.eq()`/`.is()` son el WHERE
      // condicional que la vuelve atómica, y un mock que los trata como passthrough no puede
      // ver su ausencia: medido, quitarle el `.is('restored_at', null)` al claim de la copia
      // dejaba 406 tests en verde. O sea que "25/25 mueren" certificaba el manejo de error
      // ALREDEDOR del claim y nada sobre lo que hace al claim un claim.
      //
      // **Límite declarado:** sólo se aplican a los verbos MUTANTES. Sobre un `select` el mock
      // sigue devolviendo `filas[tabla]` entero y el filtrado real lo hace Postgres. Modelarlo
      // también en la lectura significaría reimplementar PostgREST acá; lo que importa es que
      // esté escrito y no que alguien lea del mock una garantía que no da.
      const filtros = [];
      const passthrough = ['select', 'ilike', 'gte', 'lte', 'neq', 'not', 'order', 'limit'];
      for (const m of passthrough) b[m] = () => b;
      b.eq = (col, val) => { filtros.push([col, val]); return b; };
      b.is = (col, val) => { filtros.push([col, val]); return b; };
      const filaObjetivo = () => (filas[tabla] || []).find((f) => filtros.every(([c, v]) => f[c] === v)) || null;
      for (const m of MUTANTES) {
        b[m] = (payload) => {
          // El primer verbo mutante MANDA: en `update(...).select('id').maybeSingle()` el
          // `.select()` es la cláusula RETURNING de la escritura, no una lectura aparte.
          if (verbo === 'select') { verbo = m; llamadas.push({ tabla, verbo: m, payload, filtros }); }
          return b;
        };
      }
      const resolver = () => {
        if (verbo === 'select') llamadas.push({ tabla, verbo: 'select', filtros });
        // `lanza` fabrica un RECHAZO de la promesa, que es otra cosa que `{ data, error }`.
        // postgrest-js no lo produce (convierte el fallo de fetch en `error`), así que la rama
        // del `catch` es inalcanzable con el cliente real y sólo se puede ejercitar así. Está
        // separado de `fallos` a propósito: mezclarlos haría que un caso de "la DB rechazó"
        // pruebe el camino equivocado sin que se note.
        if (lanza.includes(tabla + ':' + verbo)) throw new Error('conexión cortada');
        const err = fallo(tabla + ':' + verbo);
        if (err) return { data: null, error: { message: err } };
        if (vacios.includes(tabla + ':' + verbo)) return { data: null, error: null };
        if (verbo !== 'select' && (filas[tabla] || []).length) {
          // Escritura condicional: si ninguna fila satisface el WHERE, Postgres no devuelve nada.
          const objetivo = filaObjetivo();
          return { data: objetivo ? [objetivo] : null, error: null };
        }
        const data = verbo === 'select' ? (filas[tabla] || []) : (filas[tabla + ':returning'] || [{ id: 'row-1' }]);
        return { data, error: null };
      };
      const uno = () => {
        const r = resolver();
        if (r.error) return r;
        return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: null };
      };
      // **Límite declarado:** los dos modelan `maybeSingle`. Con cero filas devuelven
      // `{data:null, error:null}`, y postgrest devuelve `{data:null, error:{code:'PGRST116'}}`
      // para `single()`. Hoy no muerde —el único `.single()` en juego es sobre un `insert`, que
      // siempre trae fila— pero un `.single()` nuevo sobre un camino de 0 filas saldría verde
      // acá y en producción entraría por `if (error)`.
      b.single = async () => uno();
      b.maybeSingle = async () => uno();
      b.then = (ok, ko) => Promise.resolve(resolver()).then(ok, ko);
      b.catch = (ko) => Promise.resolve(resolver()).catch(ko);
      return b;
    },
  };
  return sb;
}

const TX = {
  id: 'tx-001', usuario_id: 'user-001', monto: 45.5, monto_pen: 45.5, moneda: 'PEN',
  comercio: 'Starbucks', categoria: 'Alimentacion', subcategoria: 'cafeteria', tipo: 'gasto',
  fecha: '2026-04-01', created_at: new Date().toISOString(), descripcion_original: null,
};
const USUARIO = { id: 'user-001', plan: 'free' };

function buildCtx(sb, extras = {}) {
  return {
    supabase: sb, mesActual: 4, anioActual: 2026,
    obtenerUltimaTransaccion: vi.fn().mockResolvedValue(TX),
    recategorizarTransaccion: vi.fn().mockResolvedValue({ ok: true, tx: TX }),
    guardarReglaComercio: vi.fn().mockResolvedValue({ ok: true, destino: { categoria: 'Transporte', subcategoria: null } }),
    retroaplicarRegla: vi.fn().mockResolvedValue(0),
    corregirTransaccionEspecifica: vi.fn().mockResolvedValue({ ok: true }),
    guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-002', ...TX }),
    obtenerTipoCambio: vi.fn().mockResolvedValue({ venta: 3.75 }),
    verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null),
    asegurarCategoriaUsuario: vi.fn().mockResolvedValue('creada'),
    crearSubcategoriaLibreUsuario: vi.fn(),
    detectarCategoriaIA: vi.fn().mockResolvedValue({}),
    parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false, monto: 0 }),
    parsearCorreccionesMultiples: vi.fn().mockResolvedValue([]),
    fechaHoyPeru: () => '2026-04-05',
    fechaAyerPeru: () => '2026-04-04',
    formatFecha: (f) => f || '',
    ...extras,
  };
}

const correr = (sb, ctxExtras, intencion, datos = {}, msg = '') => {
  const ctx = buildCtx(sb, ctxExtras);
  return handler.handle({ intencion, msg, datos, usuario: USUARIO, from: '+51999', ctx })
    .then((res) => ({ res, ctx }));
};

// El marcador que separa las dos clases. Si algún día alguien unifica los dos copies, este
// archivo entero deja de discriminar — por eso está nombrado acá arriba y no inline.
const TEXTO_ESCRITURA = /ahora mismo\. Vuelve a intentarlo/i;
const TEXTO_NO_ENCUENTRO = /no encuentro|de qu[ée] gasto|no hay transacciones|no encontr[ée]/i;

/**
 * Los nueve sitios "planos": una sola escritura, sin nada que se ordene con ella.
 *
 * `escritura` es (tabla, verbo) del write que se rompe; `lectura` es cómo se simula que la
 * fila NO se encuentra, que es la clase 9B y tiene que seguir dando su mensaje viejo.
 */
const PLANOS = [
  {
    nombre: 'corregir_categoria (sin comercio)', intencion: 'corregir_categoria',
    datos: { categoria_nueva: 'Transporte' }, escritura: ['transacciones', 'update'],
    exito: /Listo! Mov/i, fallo: /No pude mover ese gasto ahora mismo/i,
    // Su búsqueda NO es un select de supabase: sale de `obtenerUltimaTransaccion` (ctx).
    lecturaEsCtx: true,
  },
  {
    nombre: 'corregir_monto_moneda', intencion: 'corregir_monto_moneda',
    datos: { moneda: 'USD', monto: 20 }, escritura: ['transacciones', 'update'],
    exito: /Corregido/i, fallo: /No pude corregir la moneda ahora mismo/i,
    lecturaEsCtx: true,
  },
  {
    nombre: 'editar_monto', intencion: 'editar_monto',
    datos: { monto_nuevo: 80 }, datosConLectura: { monto_nuevo: 80, comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /Monto corregido/i, fallo: /No pude corregir el monto ahora mismo/i,
  },
  {
    nombre: 'editar_fecha', intencion: 'editar_fecha',
    datos: { fecha_nueva: 'ayer' }, datosConLectura: { fecha_nueva: 'ayer', comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /Fecha corregida/i, fallo: /No pude corregir la fecha ahora mismo/i,
  },
  {
    nombre: 'editar_comercio', intencion: 'editar_comercio',
    datos: { comercio_nuevo: 'Plaza Vea' }, datosConLectura: { comercio_nuevo: 'Plaza Vea', comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /Comercio corregido/i, fallo: /No pude corregir el comercio ahora mismo/i,
  },
  {
    nombre: 'dividir_gasto', intencion: 'dividir_gasto',
    datos: { partes: 2 }, datosConLectura: { partes: 2, comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /Gasto dividido/i, fallo: /No pude dividir el gasto ahora mismo/i,
  },
  {
    nombre: 'marcar_como_ingreso', intencion: 'marcar_como_ingreso',
    datos: { tipo_nuevo: 'ingreso' }, datosConLectura: { tipo_nuevo: 'ingreso', comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /ahora est[áa] marcado como/i, fallo: /No pude cambiar el tipo ahora mismo/i,
  },
];

describe('9A · confirmación incondicional — los sitios planos', () => {
  for (const c of PLANOS) {
    const [tabla, verbo] = c.escritura;

    it(c.nombre + ': la escritura entra → confirma', async () => {
      const sb = makeSupabase({ filas: { transacciones: [TX] } });
      const { res } = await correr(sb, {}, c.intencion, c.datos);
      expect(res).toMatch(c.exito);
      expect(res).not.toMatch(TEXTO_ESCRITURA);
    });

    it(c.nombre + ': la escritura NO entra → lo dice, y no confirma', async () => {
      const sb = makeSupabase({ filas: { transacciones: [TX] }, fallos: { [tabla + ':' + verbo]: 'db caída' } });
      const { res } = await correr(sb, {}, c.intencion, c.datos);
      // se intentó de verdad: si no, el verde vendría de un return anterior
      expect(sb.intento(tabla, verbo)).toBe(true);
      expect(res).toMatch(c.fallo);
      expect(res).not.toMatch(c.exito);
      // y NO es el mensaje de la otra clase
      expect(res).not.toMatch(TEXTO_NO_ENCUENTRO);
    });

    it(c.nombre + ': la LECTURA falla → mensaje de fila no encontrada, no el de escritura', async () => {
      // La clase 9B (lecturas mudas) sigue como está a propósito: falla cerrado. Este caso
      // existe para probar que la guarda nueva NO se dispara acá — si algún día alguien la
      // sube de nivel y traga los dos casos, este test cae.
      //
      // **Este caso se arregló DOS veces y la primera fue cosmética.** Empezó con
      // `fallos: { transacciones: … }`, una clave muerta (`fallos` se consulta por
      // `tabla:verbo`). Se le puso el verbo… y seguía sin inyectar nada, porque sin
      // `datos.comercio` el handler no emite NINGÚN select: salta directo a
      // `obtenerUltimaTransaccion`. O sea que lo que hacía pasar el caso era una lectura VACÍA,
      // no una que falla, con la clave arreglada al lado para disimularlo. Lo midió la segunda
      // revisión adversarial exigiendo `intento(tabla,'select') === true`: fallaban los siete.
      //
      // Ahora los cinco que SÍ tienen select reciben el `comercio` que lo dispara y lo AFIRMAN;
      // los dos cuya búsqueda es una función del ctx lo declaran (`lecturaEsCtx`) en vez de
      // fingir un select que no existe.
      const sb = makeSupabase({ filas: {}, fallos: { 'transacciones:select': 'db caída' } });
      const { res, ctx } = await correr(
        sb,
        { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(null) },
        c.intencion,
        c.datosConLectura || c.datos,
      );
      if (c.lecturaEsCtx) {
        expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
        expect(sb.intento(tabla, 'select')).toBe(false);
      } else {
        expect(sb.intento(tabla, 'select'), 'el caso no ejercita ninguna lectura').toBe(true);
      }
      expect(res).toMatch(TEXTO_NO_ENCUENTRO);
      expect(res).not.toMatch(TEXTO_ESCRITURA);
      expect(sb.intento(tabla, 'update')).toBe(false);
    });
  }
});

describe('9A · corregir_categoria — la regla es consecuencia del cambio', () => {
  it('si la fila no se movió, no se guarda la regla ni se retroaplica', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] }, fallos: { 'transacciones:update': 'db caída' } });
    const { res, ctx } = await correr(sb, {}, 'corregir_categoria', { categoria_nueva: 'Transporte' });
    expect(res).toMatch(/No pude mover ese gasto ahora mismo/i);
    // Sin esto, la regla queda escrita sobre un cambio que no entró y el pasado y el futuro
    // del mismo comercio quedan en dos categorías distintas — el split que B30 cerró.
    expect(ctx.guardarReglaComercio).not.toHaveBeenCalled();
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
  });
});

/**
 * Los tres sitios donde DOS escrituras se ordenan entre sí. Acá el mensaje no alcanza como
 * aserción: lo que decide es qué queda escrito.
 */
describe('9A · eliminar_transaccion — la copia y el delete se ordenan', () => {
  const datos = { comercio: 'Starbucks' };

  it('borra y confirma cuando el delete entra', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] } });
    const { res } = await correr(sb, {}, 'eliminar_transaccion', datos, 'borra el de starbucks');
    expect(res).toMatch(/Elimin[ée]/);
    expect(sb.intento('transacciones', 'delete')).toBe(true);
  });

  it('si el delete NO entra: lo dice Y no deja copia pendiente que duplique la plata', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] }, fallos: { 'transacciones:delete': 'db caída' } });
    const { res } = await correr(sb, {}, 'eliminar_transaccion', datos, 'borra el de starbucks');
    expect(res).toMatch(/No pude eliminarlo ahora mismo/i);
    expect(res).not.toMatch(/Elimin[ée] \*/);
    // La copia entró (snapshot ok) y la fila sigue viva. Sin descartar la copia,
    // `restaurar_eliminado` la re-inserta después y el gasto queda DUPLICADO.
    expect(sb.intento('transacciones_eliminadas', 'insert')).toBe(true);
    expect(sb.intento('transacciones_eliminadas', 'delete')).toBe(true);
  });

  it('la compensación apunta a LA copia de este mensaje, por id', async () => {
    // **Sin esta aserción el DELETE no está probado, sólo observado.** La revisión adversarial
    // le quitó los tres filtros que tenía la primera versión, de a uno, y la suite quedó verde
    // con los tres: `intento()` dice que hubo un delete, nunca a qué apunta. Y no es teórico —
    // `transacciones_eliminadas` no tiene unique sobre `tx_id`, así que un WHERE por `tx_id`
    // alcanza también la copia de un borrado concurrente del mismo gasto, que ya borró la fila
    // y ya prometió la restauración.
    const sb = makeSupabase({ filas: { transacciones: [TX] }, fallos: { 'transacciones:delete': 'db caída' } });
    await correr(sb, {}, 'eliminar_transaccion', { comercio: 'Starbucks' }, 'borra el de starbucks');
    expect(sb.filtros('transacciones_eliminadas', 'delete')).toEqual([['id', 'row-1']]);
  });

  it('un delete que no afecta NINGUNA fila no se confirma como borrado', async () => {
    // postgrest no devuelve error cuando el DELETE no matchea nada, así que "la escritura no
    // tocó nada" producía exactamente la misma confirmación falsa que este ítem cierra. Pasa
    // con un doble envío, y ahí encima deja dos copias pendientes del mismo gasto.
    const sb = makeSupabase({ filas: { transacciones: [TX] }, vacios: ['transacciones:delete'] });
    const { res } = await correr(sb, {}, 'eliminar_transaccion', { comercio: 'Starbucks' }, 'borra el de starbucks');
    expect(res).toMatch(/ya no está/i);
    expect(res).not.toMatch(/Elimin[ée] \*/);
    // y la copia no queda pendiente, o el "restaura" siguiente duplica el gasto
    expect(sb.intento('transacciones_eliminadas', 'delete')).toBe(true);
  });

  it('si el await RECHAZA en vez de devolver error, la copia se descarta igual', async () => {
    // La rama del `catch`. postgrest-js no produce este rechazo, así que el mock lo fabrica:
    // es defensa en profundidad y sin este caso era código sin medir — la segunda revisión
    // borró la línea entera y la suite siguió verde.
    const sb = makeSupabase({ filas: { transacciones: [TX] }, lanza: ['transacciones:delete'] });
    const { res } = await correr(sb, {}, 'eliminar_transaccion', { comercio: 'Starbucks' }, 'borra el de starbucks');
    expect(res).toMatch(/No pude eliminarlo/i);
    expect(sb.filtros('transacciones_eliminadas', 'delete')).toEqual([['id', 'row-1']]);
  });

  it('si la copia tampoco entró, no intenta descartar una copia que no existe', async () => {
    const sb = makeSupabase({
      filas: { transacciones: [TX] },
      fallos: { 'transacciones:delete': 'db caída', 'transacciones_eliminadas:insert': 'rls' },
    });
    const { res } = await correr(sb, {}, 'eliminar_transaccion', datos, 'borra el de starbucks');
    expect(res).toMatch(/No pude eliminarlo ahora mismo/i);
    expect(sb.intento('transacciones_eliminadas', 'delete')).toBe(false);
  });
});

describe('9A · deshacer_ultimo — mismo par ordenado', () => {
  it('si el delete NO entra: lo dice y descarta la copia', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] }, fallos: { 'transacciones:delete': 'db caída' } });
    const { res } = await correr(sb, {}, 'deshacer_ultimo', {}, 'borra el último');
    expect(res).toMatch(/No pude deshacerlo ahora mismo/i);
    expect(res).not.toMatch(/Deshecho/);
    expect(sb.intento('transacciones_eliminadas', 'delete')).toBe(true);
  });

  it('deshacer: si el await RECHAZA, la copia se descarta igual', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] }, lanza: ['transacciones:delete'] });
    const { res } = await correr(sb, {}, 'deshacer_ultimo', {}, 'borra el último');
    expect(res).toMatch(/No pude deshacer/i);
    expect(sb.filtros('transacciones_eliminadas', 'delete')).toEqual([['id', 'row-1']]);
  });

  it('deshacer: un delete de 0 filas no se confirma', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] }, vacios: ['transacciones:delete'] });
    const { res } = await correr(sb, {}, 'deshacer_ultimo', {}, 'borra el último');
    expect(res).toMatch(/ya no está/i);
    expect(res).not.toMatch(/Deshecho/);
  });

  it('camino feliz intacto: borra y ofrece restaurar', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] } });
    const { res } = await correr(sb, {}, 'deshacer_ultimo', {}, 'borra el último');
    expect(res).toMatch(/Deshecho/);
    expect(res).toMatch(/restaura/i);
    expect(sb.intento('transacciones_eliminadas', 'delete')).toBe(false);
  });
});

describe('9A · restaurar_eliminado — el orden ES el arreglo', () => {
  const COPIA = { id: 'snap-1', usuario_id: 'user-001', tx_id: 'tx-001', restored_at: null, snapshot: { ...TX } };

  it('camino feliz: reclama la copia y luego inserta', async () => {
    const sb = makeSupabase({ filas: { transacciones_eliminadas: [COPIA] } });
    const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
    expect(res).toMatch(/Restaur[ée]/);
    const orden = sb._llamadas.filter((c) => MUTANTES.includes(c.verbo)).map((c) => c.tabla + ':' + c.verbo);
    // El claim va PRIMERO. Al revés, una marca fallida deja la copia pendiente con la
    // transacción ya insertada y el siguiente "restaura" duplica la plata en silencio.
    expect(orden).toEqual(['transacciones_eliminadas:update', 'transacciones:insert']);
  });

  it('si no se puede reclamar la copia, NO inserta nada', async () => {
    const sb = makeSupabase({
      filas: { transacciones_eliminadas: [COPIA] },
      fallos: { 'transacciones_eliminadas:update': 'db caída' },
    });
    const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
    expect(res).toMatch(/No pude restaurar el gasto ahora mismo/i);
    expect(sb.intento('transacciones', 'insert')).toBe(false);
  });

  it('si otro mensaje ya se llevó la copia, no la re-inserta (doble "restaura")', async () => {
    const sb = makeSupabase({
      filas: { transacciones_eliminadas: [COPIA] },
      vacios: ['transacciones_eliminadas:update'],
    });
    const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
    expect(res).toMatch(/ya lo estoy restaurando/i);
    expect(sb.intento('transacciones', 'insert')).toBe(false);
  });

  it('una copia YA restaurada no se puede volver a reclamar', async () => {
    // **Este es el caso que prueba el PREDICADO**, no el manejo de su resultado: acá el
    // `.is('restored_at', null)` es lo único que separa "no hay nada que restaurar" de
    // insertar el gasto por segunda vez. Sin él, el mock encuentra la fila igual y el insert
    // ocurre — que es exactamente la plata duplicada.
    const sb = makeSupabase({
      filas: { transacciones_eliminadas: [{ ...COPIA, restored_at: '2026-04-02T10:00:00Z' }] },
    });
    const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
    expect(sb.intento('transacciones', 'insert')).toBe(false);
    expect(res).toMatch(/ya lo estoy restaurando/i);
  });

  it('el claim y la devolución apuntan a LA copia, no a todas las del usuario', async () => {
    // Los dos UPDATE sobre `transacciones_eliminadas` llevan `.eq('id', objetivo.id)`, y sin esa
    // mitad reclaman —o devuelven a pendiente— TODAS las copias de la base. Las dos mutaciones
    // sobrevivían: `intento()` ve que hubo un update, nunca sobre qué. Es el mismo agujero que
    // el DELETE de la compensación, en la tabla que es la última línea de recuperación.
    const sb = makeSupabase({
      filas: { transacciones_eliminadas: [COPIA] },
      fallos: { 'transacciones:insert': 'db caída' },
    });
    await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
    expect(sb.filtros('transacciones_eliminadas', 'update', 0)).toEqual([['id', 'snap-1'], ['restored_at', null]]);
    expect(sb.filtros('transacciones_eliminadas', 'update', 1)).toEqual([['id', 'snap-1']]);
  });

  it('si el insert falla después del claim, devuelve la copia a pendiente', async () => {
    const sb = makeSupabase({
      filas: { transacciones_eliminadas: [COPIA] },
      fallos: { 'transacciones:insert': 'db caída' },
    });
    const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
    expect(res).toMatch(/No pude restaurar el gasto\. Intenta registrarlo manualmente/i);
    // dos updates sobre la copia: el claim y la devolución. Sin la segunda, la copia queda
    // quemada y el gasto es irrecuperable aunque el usuario reintente.
    expect(sb.cuenta('transacciones_eliminadas', 'update')).toBe(2);
  });

  it('el fallo de gmail_excluidos NO le cambia la respuesta al usuario (accesoria)', async () => {
    const sb = makeSupabase({
      filas: { transacciones_eliminadas: [{ ...COPIA, snapshot: { ...TX, descripcion_original: 'BCP compra' } }] },
      fallos: { 'gmail_excluidos:delete': 'db caída' },
    });
    const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
    expect(res).toMatch(/Restaur[ée]/);
    expect(res).not.toMatch(TEXTO_ESCRITURA);
    expect(sb.intento('gmail_excluidos', 'delete')).toBe(true);
  });
});

/**
 * Las guardas ACCESORIAS: las que sólo loguean. Lo único que hacen es dejar rastro, así que un
 * test que mire la respuesta del usuario pasa igual con la guarda neutralizada — y así salían
 * las cuatro en la mutación: SOBREVIVE, indistinguibles de una guarda sin cobertura.
 *
 * Acá se afirma lo que de verdad hacen: que el log sale, y que NO cortan. Las dos mitades. La
 * segunda es la que evita que alguien "arregle" un accesorio subiéndolo a mensaje de usuario.
 *
 * `log.error` se parchea sobre el objeto que devuelve `require('lib/logger')`: pino exporta un
 * singleton CJS, así que el handler mira la MISMA referencia y el spy lo ve.
 */
describe('9A · las guardas accesorias dejan rastro y no cortan', () => {
  const log = require('../../lib/logger');

  function espiar() {
    const errores = [];
    const warns = [];
    const origE = log.error.bind(log);
    const origW = log.warn.bind(log);
    log.error = (...a) => { errores.push(a); };
    log.warn = (...a) => { warns.push(a); };
    return { errores, warns, restaurar: () => { log.error = origE; log.warn = origW; } };
  }

  it('snapshot huérfano: si el delete de la copia también falla, queda escrito con el txId', async () => {
    const spy = espiar();
    try {
      const sb = makeSupabase({
        filas: { transacciones: [TX] },
        fallos: { 'transacciones:delete': 'db caída', 'transacciones_eliminadas:delete': 'rls' },
      });
      const { res } = await correr(sb, {}, 'eliminar_transaccion', { comercio: 'Starbucks' }, 'borra el de starbucks');
      // no corta: el usuario recibe el mismo mensaje que si la compensación hubiera entrado
      expect(res).toMatch(/No pude eliminarlo ahora mismo/i);
      const huerfano = spy.errores.find((a) => /Snapshot huérfano/.test(a[1]));
      expect(huerfano, 'la copia quedó restaurable y nadie lo anotó').toBeTruthy();
      expect(huerfano[0].snapshotId).toBe('row-1');
    } finally { spy.restaurar(); }
  });

  it('gmail_excluidos al eliminar: se anota y el borrado se confirma igual', async () => {
    const spy = espiar();
    try {
      const sb = makeSupabase({
        filas: { transacciones: [{ ...TX, descripcion_original: 'BCP compra en STARBUCKS' }] },
        fallos: { 'gmail_excluidos:upsert': 'db caída' },
      });
      const { res } = await correr(sb, {}, 'eliminar_transaccion', { comercio: 'Starbucks' }, 'borra el de starbucks');
      expect(res).toMatch(/Elimin[ée]/);
      expect(spy.warns.some((a) => /excluir de Gmail/i.test(a[1]))).toBe(true);
    } finally { spy.restaurar(); }
  });

  it('gmail_excluidos al restaurar: se anota y la restauración se confirma igual', async () => {
    const spy = espiar();
    try {
      const sb = makeSupabase({
        filas: { transacciones_eliminadas: [{ id: 'snap-1', restored_at: null, snapshot: { ...TX, descripcion_original: 'BCP compra' } }] },
        fallos: { 'gmail_excluidos:delete': 'db caída' },
      });
      const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
      expect(res).toMatch(/Restaur[ée]/);
      expect(spy.warns.some((a) => /gmail_excluidos/i.test(a[1]))).toBe(true);
    } finally { spy.restaurar(); }
  });

  it('la copia queda quemada si la devolución a pendiente falla, y eso se anota', async () => {
    const spy = espiar();
    try {
      const sb = makeSupabase({
        filas: { transacciones_eliminadas: [{ id: 'snap-1', restored_at: null, snapshot: { ...TX } }] },
        // el claim (1er update) entra, la devolución (2do) no. Sin el array esta guarda es
        // inalcanzable: las dos son `transacciones_eliminadas:update`.
        fallos: { 'transacciones_eliminadas:update': [null, 'db caída'], 'transacciones:insert': 'db caída' },
      });
      const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
      expect(res).toMatch(/Intenta registrarlo manualmente/i);
      expect(spy.errores.some((a) => /ya no se puede restaurar/i.test(a[1]))).toBe(true);
    } finally { spy.restaurar(); }
  });
});
