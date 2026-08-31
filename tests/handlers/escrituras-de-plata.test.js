import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// La regla de conversion USD->PEN se toma del MODULO REAL, no se re-implementa aca: un
// duplicado en el test convierte el guard en una copia que puede divergir del codigo.
const realTx = require('../../services/transactions');
const handler = require('../../handlers/intents/transacciones');

/**
 * CONFIRMACIÓN INCONDICIONAL — las escrituras de plata de `handlers/intents/transacciones.js`
 * (ítems 9A y 9A-bis del backlog de confiabilidad).
 *
 * 9A cerró las 11 sobre la causa "la escritura FALLÓ". 9A-bis cierra la segunda causa, que
 * produce la misma confirmación falsa por otro camino: "la escritura no tocó NINGUNA fila".
 * Las secciones están separadas y etiquetadas para que un rojo diga cuál de las dos se rompió.
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
  const nthVacio = {};
  const fallo = (clave) => {
    const f = fallos[clave];
    if (f === undefined) return null;
    if (!Array.isArray(f)) return f;
    const i = (nth[clave] = (nth[clave] || 0) + 1) - 1;
    return f[i] || null;
  };
  /**
   * `vacios` acepta `'tabla:verbo'` (siempre devuelve cero filas) y `'tabla:verbo#N'` (sólo la
   * N-ésima llamada, 1-based). El sufijo `#N` es la contraparte del array de `fallos` y hace
   * falta por lo mismo: en `restaurar_eliminado` el claim de la copia y su devolución a
   * pendiente son los DOS un `transacciones_eliminadas:update`, así que sin poder separarlos la
   * guarda de la devolución es inalcanzable desde un test.
   */
  const vacio = (clave) => {
    const n = (nthVacio[clave] = (nthVacio[clave] || 0) + 1);
    return vacios.includes(clave) || vacios.includes(clave + '#' + n);
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
      const passthrough = ['ilike', 'gte', 'lte', 'neq', 'not', 'order', 'limit'];
      for (const m of passthrough) b[m] = () => b;
      // **`.select()` sobre una escritura es su cláusula RETURNING, y sin modelarla el mock
      // MIENTE en la dirección peligrosa.** Antes devolvía la fila igual, así que quitarle el
      // `.select('id')` a un update no cambiaba nada acá — y en producción lo cambia todo:
      // postgrest devuelve `data: null` siempre, o sea que la guarda de "0 filas" dispararía en
      // TODAS las escrituras y ninguna confirmación volvería a salir. La suite entera habría
      // seguido verde sobre un backend que le dice "ese gasto ya no está" a todo el mundo.
      let retorno = false;
      b.select = () => { if (verbo !== 'select') retorno = true; return b; };
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
        if (vacio(tabla + ':' + verbo)) return { data: null, error: null };
        // Una escritura que no pidió RETURNING no trae filas, pase lo que pase con el WHERE.
        if (verbo !== 'select' && !retorno) return { data: null, error: null };
        if (verbo !== 'select' && (filas[tabla] || []).length) {
          // Escritura condicional: si ninguna fila satisface el WHERE, Postgres no devuelve nada.
          const objetivo = filaObjetivo();
          return { data: objetivo ? [objetivo] : null, error: null };
        }
        // **Límite declarado, y es el opuesto del que se acaba de cerrar:** con la tabla SIN
        // sembrar, una escritura con RETURNING devuelve `[{id:'row-1'}]`, o sea "una fila
        // afectada" sobre una tabla vacía. Es lo que mantiene verdes los casos viejos, que no
        // siembran nada y sólo miran el mensaje. Un caso NUEVO que quiera probar 0 filas tiene
        // que sembrar la tabla (con la fila que sea) o el mock le va a decir que sí se afectó.
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
// La fila DE AL LADO: lo que `obtenerUltimaTransaccion` devolvería si el flujo cayera al
// fallback con la búsqueda caída (ítem 9F). Que sea distinta de `TX` es lo que hace legible
// el daño: no es "escribió algo", es "le escribió encima al taxi de hoy".
const TX_DE_AL_LADO = { ...TX, id: 'tx-002', comercio: 'Taxi', monto: 8 };
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
    // Los helpers de conversion van REALES, no mockeados: son la regla que el item 13
    // unifico (validar como el alta, y escribir monto_pen y tipo_cambio juntos). Un
    // `vi.fn()` aca dejaria los tres sitios de edicion sin ejercitar justo lo que cambio.
    convertirUsdAPen: realTx.convertirUsdAPen,
    tipoCambioDeLaFila: realTx.tipoCambioDeLaFila,
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
    exito: /Listo! Mov/i, fallo: /No pude mover ese gasto ahora mismo/i, tag: 'CORREGIR',
    // Su búsqueda NO es un select de supabase: sale de `obtenerUltimaTransaccion` (ctx).
    lecturaEsCtx: true,
  },
  {
    nombre: 'corregir_monto_moneda', intencion: 'corregir_monto_moneda',
    datos: { moneda: 'USD', monto: 20 }, escritura: ['transacciones', 'update'],
    exito: /Corregido/i, fallo: /No pude corregir la moneda ahora mismo/i, tag: 'CORREGIR_MONEDA',
    lecturaEsCtx: true,
  },
  {
    nombre: 'editar_monto', intencion: 'editar_monto',
    datos: { monto_nuevo: 80 }, datosConLectura: { monto_nuevo: 80, comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /Monto corregido/i, fallo: /No pude corregir el monto ahora mismo/i, tag: 'EDITAR_MONTO',
    lecturaCaida: /No pude corregir el monto\. Intenta de nuevo/i,
  },
  {
    nombre: 'editar_fecha', intencion: 'editar_fecha',
    datos: { fecha_nueva: 'ayer' }, datosConLectura: { fecha_nueva: 'ayer', comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /Fecha corregida/i, fallo: /No pude corregir la fecha ahora mismo/i, tag: 'EDITAR_FECHA',
    lecturaCaida: /No pude corregir la fecha\. Intenta de nuevo/i,
  },
  {
    nombre: 'editar_comercio', intencion: 'editar_comercio',
    datos: { comercio_nuevo: 'Plaza Vea' }, datosConLectura: { comercio_nuevo: 'Plaza Vea', comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /Comercio corregido/i, fallo: /No pude corregir el comercio ahora mismo/i, tag: 'EDITAR_COMERCIO',
    lecturaCaida: /No pude corregir el comercio\. Intenta de nuevo/i,
  },
  {
    nombre: 'dividir_gasto', intencion: 'dividir_gasto',
    datos: { partes: 2 }, datosConLectura: { partes: 2, comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /Gasto dividido/i, fallo: /No pude dividir el gasto ahora mismo/i, tag: 'DIVIDIR',
    lecturaCaida: /No pude dividir el gasto\. Intenta de nuevo/i,
  },
  {
    nombre: 'marcar_como_ingreso', intencion: 'marcar_como_ingreso',
    datos: { tipo_nuevo: 'ingreso' }, datosConLectura: { tipo_nuevo: 'ingreso', comercio: 'Starbucks' }, escritura: ['transacciones', 'update'],
    exito: /ahora est[áa] marcado como/i, fallo: /No pude cambiar el tipo ahora mismo/i, tag: 'MARCAR_INGRESO',
    lecturaCaida: /No pude cambiar el tipo\. Intenta de nuevo/i,
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

    it(c.nombre + ': la LECTURA falla → corta sin escribir y NO cae al fallback', async () => {
      // **Este caso afirmaba lo contrario hasta el 25-ago, y pasaba porque su fixture hacía
      // inalcanzable el camino peligroso.** Decía: *"la clase 9B sigue como está a propósito:
      // falla cerrado. Este caso existe para probar que la guarda nueva NO se dispara acá"*.
      // La premisa era falsa (ítem 9F): con la búsqueda caída el handler caía a
      // `obtenerUltimaTransaccion` y le escribía encima a esa fila. Lo que tapaba el bug era
      // el mock, que devolvía `null`: sin fila que editar, la respuesta salía "no encuentro"
      // y el `update` nunca se intentaba. O sea que el verde venía de una condición que no
      // era la que el caso decía probar.
      //
      // Ahora el mock devuelve una fila REAL y distinta (`TX_DE_AL_LADO`) y se afirma que el
      // fallback ni siquiera se CONSULTA — un corte puesto después de llamarlo pasaría el
      // resto igual.
      //
      // **Qué mata al mutante, dicho sin inflar**: las tres aserciones nuevas
      // (`lecturaCaida`, `not.toHaveBeenCalled`, `update === false`); con `null` en el mock
      // también moriría. Lo que `TX_DE_AL_LADO` aporta es que el mutante falle por la
      // ESCRITURA a la fila de al lado y no sólo por un copy distinto, que es el daño real.
      // Y tiene un costo que hay que saber: saca a este caso de la rama "no encuentro un gasto
      // reciente", que **pasó a cubrirse en `lecturas-de-contenido.test.js`** (9F, el caso
      // "ni búsqueda ni fallback tienen nada"). Sin ese traslado, arreglar acá habría dejado
      // esa rama sin nada — y de hecho la dejó durante una vuelta.
      //
      // Los dos `lecturaEsCtx` no cambiaron: su búsqueda ES `obtenerUltimaTransaccion`, así
      // que ahí no hay dos ceros que separar y siguen dando su mensaje viejo.
      //
      // **Este caso se arregló DOS veces antes, y las dos fueron cosméticas.** Empezó con
      // `fallos: { transacciones: … }`, una clave muerta (`fallos` se consulta por
      // `tabla:verbo`). Se le puso el verbo… y seguía sin inyectar nada, porque sin
      // `datos.comercio` el handler no emite NINGÚN select. Lo midió la segunda revisión
      // adversarial exigiendo `intento(tabla,'select') === true`.
      const esCtx = !!c.lecturaEsCtx;
      const sb = makeSupabase({ filas: {}, fallos: { 'transacciones:select': 'db caída' } });
      const { res, ctx } = await correr(
        sb,
        { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(esCtx ? null : TX_DE_AL_LADO) },
        c.intencion,
        c.datosConLectura || c.datos,
      );
      if (esCtx) {
        expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
        expect(sb.intento(tabla, 'select')).toBe(false);
        expect(res).toMatch(TEXTO_NO_ENCUENTRO);
      } else {
        expect(sb.intento(tabla, 'select'), 'el caso no ejercita ninguna lectura').toBe(true);
        expect(ctx.obtenerUltimaTransaccion).not.toHaveBeenCalled();
        expect(res).toMatch(c.lecturaCaida);
        // Y NO el de la otra clase: "no encuentro" afirmaría que la búsqueda anduvo.
        expect(res).not.toMatch(TEXTO_NO_ENCUENTRO);
      }
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

/**
 * ══ 9A-bis · "0 filas" — la MISMA confirmación falsa, la otra causa ═══════════════════════
 *
 * postgrest no devuelve `error` cuando un UPDATE no matchea ninguna fila. Así que "la escritura
 * fue rechazada" y "la escritura no tocó nada" llegan al call-site con la MISMA forma
 * (`error: null`) y hasta 9A-bis producían la misma respuesta: `'✅ Monto corregido'` sobre un
 * gasto que no se movió. 9A cerró la primera causa —y sólo la nombraba a ella—, así que los
 * ocho UPDATE quedaron abiertos con la suite en verde.
 *
 * **Cómo se construye el caso, y por qué NO con `vacios`.** `vacios: ['transacciones:update']`
 * ya existía en este mock y habría sido más corto, pero es un stub declarado: le dice al mock
 * "acá devolvé nada" sin que nada de la escritura lo cause. Los casos de abajo apuntan a un
 * **id que no existe** —la fila que el handler leyó ya no está en `filas`— y dejan que el WHERE
 * del propio update produzca las cero filas, que es el mecanismo de producción: entre la
 * lectura (`obtenerUltimaTransaccion`) y la escritura, un borrado se llevó la fila. Un caso
 * construido así también muere si alguien le quita el `.eq('id', …)` al update; el stub no.
 *
 * Cada caso afirma CUATRO cosas: que el update se intentó, con qué WHERE, que sale el mensaje
 * de su clase, y que NO sale ninguno de los otros tres (el éxito, el de escritura-fallida de
 * 9A, y el de lectura-vacía de 9B). Sin la última mitad, unificar dos copies dejaría el archivo
 * entero sin discriminar y nadie se enteraría.
 */
const TEXTO_CERO_FILAS = /ya no está/i;

// La fila que el handler cree tener (id `tx-001`, la que devuelve `obtenerUltimaTransaccion`)
// ya no está en la tabla: lo único que queda es OTRA. El `.eq('id', 'tx-001')` no matchea.
const OTRA_FILA = { ...TX, id: 'tx-999' };

/**
 * El espía de logs, compartido. **El mensaje al usuario NO distingue una causa de la otra en
 * producción** —las dos clases tienen su copy, pero nadie las cuenta—, así que el `log.warn`
 * con su `tag` es lo único que permite saber si esto pasa y con qué frecuencia. Sin afirmarlo,
 * borrarlo o renombrarle el tag sale verde: es el mismo hueco que el ítem 9B pagó con sus
 * `LECTURA_CAIDA`, en el commit de al lado.
 */
function espiarLog() {
  const log = require('../../lib/logger');
  const errores = [];
  const warns = [];
  const origE = log.error.bind(log);
  const origW = log.warn.bind(log);
  log.error = (...a) => { errores.push(a); };
  log.warn = (...a) => { warns.push(a); };
  return { errores, warns, restaurar: () => { log.error = origE; log.warn = origW; } };
}

describe('9A-bis · un UPDATE que no afecta ninguna fila no se confirma', () => {
  for (const c of PLANOS) {
    it(c.nombre + ': 0 filas → lo dice, y no confirma', async () => {
      const sb = makeSupabase({ filas: { transacciones: [OTRA_FILA] } });
      const spy = espiarLog();
      let res;
      try { ({ res } = await correr(sb, {}, c.intencion, c.datos)); } finally { spy.restaurar(); }
      // 0) queda rastro, con SU tag y el id de la fila: es lo único observable en producción
      const anotado = spy.warns.find((a) => /no afectó ninguna fila/i.test(String(a[1])));
      expect(anotado, 'no quedó rastro de que la escritura no tocó nada').toBeTruthy();
      expect(anotado[0].tag).toBe(c.tag);
      expect(anotado[0].txId).toBe(TX.id);
      // 1) se intentó de verdad — si no, el verde vendría de un return anterior
      expect(sb.intento('transacciones', 'update')).toBe(true);
      // 2) apuntando a la fila que el handler leyó (y que ya no está)
      expect(sb.filtros('transacciones', 'update')).toEqual([['id', TX.id]]);
      // 3) el mensaje de ESTA clase
      expect(res).toMatch(TEXTO_CERO_FILAS);
      // 4) y ninguno de los otros tres
      expect(res).not.toMatch(c.exito);
      expect(res).not.toMatch(TEXTO_ESCRITURA);
      expect(res).not.toMatch(TEXTO_NO_ENCUENTRO);
    });

    it(c.nombre + ': la fila SÍ está → confirma (control del caso de arriba)', async () => {
      // Sin este control, el caso anterior podría estar verde porque el handler contesta "ya no
      // está" siempre. Mismo mock, misma llamada: lo único que cambia es que el id existe.
      const sb = makeSupabase({ filas: { transacciones: [TX] } });
      const { res } = await correr(sb, {}, c.intencion, c.datos);
      expect(res).toMatch(c.exito);
      expect(res).not.toMatch(TEXTO_CERO_FILAS);
    });
  }
});

/**
 * `corregir_multiple` — el call-site del motivo nuevo.
 *
 * **Lo encontró la mutación, no la revisión ni la suite.** Escribí `motivo: 'desaparecido'` en
 * `services/transactions.js` y su rama acá, y no cubrí ninguno de los dos extremos juntos:
 * neutralizar el `else if` dejaba los 2036 tests en verde, o sea que el usuario volvía a leer
 * *"❌ No encontré gasto de Starbucks"* sobre un gasto que la función acababa de leer — la
 * mentira que el `motivo` vino a cerrar, con la causa nueva.
 *
 * Los tres desenlaces se afirman juntos a propósito: lo que hace útil al tercer valor es que
 * los otros dos digan otra cosa.
 */
describe('9A-bis · corregir_multiple distingue los TRES desenlaces', () => {
  const conCorreccion = (resultado) => ({
    parsearCorreccionesMultiples: vi.fn().mockResolvedValue([{ comercio: 'Starbucks', categoria_nueva: 'Transporte' }]),
    corregirTransaccionEspecifica: vi.fn().mockResolvedValue(resultado),
  });

  it('desaparecido → "ya no está", y NO el de fallo ni el de inexistente', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] } });
    const { res } = await correr(sb, conCorreccion({ ok: false, comercio: 'Starbucks', motivo: 'desaparecido' }), 'corregir_multiple', {}, 'starbucks a transporte y wong a comida');
    expect(res).toMatch(TEXTO_CERO_FILAS);
    expect(res).not.toMatch(/No pude corregir el gasto/i);
    expect(res).not.toMatch(/No encontré gasto/i);
  });

  it('error → "no pude corregirlo ahora mismo" (control)', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] } });
    const { res } = await correr(sb, conCorreccion({ ok: false, comercio: 'Starbucks', motivo: 'error' }), 'corregir_multiple', {}, 'starbucks a transporte');
    expect(res).toMatch(/No pude corregir el gasto/i);
    expect(res).not.toMatch(TEXTO_CERO_FILAS);
  });

  it('sin motivo → "no encontré gasto" (control)', async () => {
    const sb = makeSupabase({ filas: { transacciones: [TX] } });
    const { res } = await correr(sb, conCorreccion({ ok: false, comercio: 'Starbucks' }), 'corregir_multiple', {}, 'starbucks a transporte');
    expect(res).toMatch(/No encontré gasto/i);
    expect(res).not.toMatch(TEXTO_CERO_FILAS);
  });
});

describe('9A-bis · corregir_categoria: 0 filas corta ANTES de la regla', () => {
  it('no guarda la regla ni retroaplica sobre un cambio que no ocurrió', async () => {
    // El gemelo del caso 9A de más arriba, con la otra causa. Acá el corte ES el arreglo y el
    // texto es lo secundario: escribir la regla sobre una fila que no se movió deja el pasado y
    // el futuro del mismo comercio en dos categorías — el split que B30 cerró.
    const sb = makeSupabase({ filas: { transacciones: [OTRA_FILA] } });
    const { res, ctx } = await correr(sb, {}, 'corregir_categoria', { categoria_nueva: 'Transporte' });
    expect(res).toMatch(TEXTO_CERO_FILAS);
    expect(ctx.guardarReglaComercio).not.toHaveBeenCalled();
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
  });
});

/**
 * El octavo UPDATE: la devolución de la copia a pendiente en `restaurar_eliminado`.
 *
 * **Misma clase y a propósito NO el mismo arreglo.** Es una compensación: su WHERE es sólo por
 * `id`, y el claim de arriba ya garantiza que nadie más se llevó esta copia, así que cero filas
 * significa que la copia no existe. Sin copia no hay nada que devolver ni duplicación posible
 * después: el desenlace es benigno y la respuesta al usuario no cambia. Lo único que distingue
 * los dos casos es el LOG, así que probarlo por el mensaje sería un negativo que pasa por otra
 * condición. Se prueba por el diagnóstico que queda escrito.
 *
 * Acá SÍ se usa el stub (`vacios` con `#2`) y no el id-que-no-existe: el mecanismo real es un
 * borrado concurrente ENTRE las dos escrituras, y eso no se puede expresar con una tabla
 * estática. Declararlo es la diferencia entre un stub y un stub disimulado.
 */
describe('9A-bis · la compensación de restaurar_eliminado: cambia el diagnóstico, no la respuesta', () => {
  const log = require('../../lib/logger');
  const COPIA = { id: 'snap-1', usuario_id: 'user-001', tx_id: 'tx-001', restored_at: null, snapshot: { ...TX } };

  function espiar() {
    const errores = [];
    const warns = [];
    const origE = log.error.bind(log);
    const origW = log.warn.bind(log);
    log.error = (...a) => { errores.push(a); };
    log.warn = (...a) => { warns.push(a); };
    return { errores, warns, restaurar: () => { log.error = origE; log.warn = origW; } };
  }

  it('la copia YA NO EXISTE: se anota eso, y no que "quedó marcada"', async () => {
    const spy = espiar();
    try {
      // El claim (1er update) entra; el insert falla; y la devolución (2do update) no encuentra
      // la copia porque un borrado concurrente se la llevó en el medio.
      const sb = makeSupabase({
        filas: { transacciones_eliminadas: [COPIA] },
        fallos: { 'transacciones:insert': 'db caída' },
        vacios: ['transacciones_eliminadas:update#2'],
      });
      const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
      // la respuesta es la MISMA que cuando la devolución entra: no hay nada nuevo que contarle
      expect(res).toMatch(/Intenta registrarlo manualmente/i);
      // se intentó devolverla, apuntando a esta copia
      expect(sb.cuenta('transacciones_eliminadas', 'update')).toBe(2);
      expect(sb.filtros('transacciones_eliminadas', 'update', 1)).toEqual([['id', 'snap-1']]);
      // y el diagnóstico es otro: es el que decide a dónde mira quien lea el log
      expect(spy.warns.some((a) => /no hubo nada que devolver/i.test(a[1])), 'no se anotó que la copia ya no está').toBe(true);
      expect(spy.errores.some((a) => /ya no se puede restaurar/i.test(a[1])), 'afirma un estado que no comprobó').toBe(false);
    } finally { spy.restaurar(); }
  });

  it('la devolución FALLA de verdad: sigue anotando que la copia quedó quemada (control)', async () => {
    // El control de la clase hermana. Sin él, "no salió el error" podría venir de que la guarda
    // vieja se rompió, no de que la nueva discrimina.
    const spy = espiar();
    try {
      const sb = makeSupabase({
        filas: { transacciones_eliminadas: [COPIA] },
        fallos: { 'transacciones_eliminadas:update': [null, 'db caída'], 'transacciones:insert': 'db caída' },
      });
      const { res } = await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
      expect(res).toMatch(/Intenta registrarlo manualmente/i);
      expect(spy.errores.some((a) => /ya no se puede restaurar/i.test(a[1]))).toBe(true);
      expect(spy.warns.some((a) => /no hubo nada que devolver/i.test(a[1]))).toBe(false);
    } finally { spy.restaurar(); }
  });

  it('la devolución ENTRA: ni un diagnóstico ni el otro (control del control)', async () => {
    const spy = espiar();
    try {
      const sb = makeSupabase({
        filas: { transacciones_eliminadas: [COPIA] },
        fallos: { 'transacciones:insert': 'db caída' },
      });
      await correr(sb, {}, 'restaurar_eliminado', {}, 'restaura');
      expect(spy.errores.some((a) => /ya no se puede restaurar/i.test(a[1]))).toBe(false);
      expect(spy.warns.some((a) => /no hubo nada que devolver/i.test(a[1]))).toBe(false);
    } finally { spy.restaurar(); }
  });
});
