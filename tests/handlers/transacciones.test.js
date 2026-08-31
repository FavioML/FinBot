import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// La regla de conversion USD->PEN se toma del MODULO REAL, no se re-implementa aca: un
// duplicado en el test convierte el guard en una copia que puede divergir del codigo.
const realTx = require('../../services/transactions');
const handler = require('../../handlers/intents/transacciones');

// PRE-CARGA DELIBERADA. `handler.handle` resuelve el redirect de query con un
// `require('../intent-registry')` PEREZOSO (esta ahi para cortar un ciclo, y en produccion el
// arbol ya vino cargado desde el boot). En la suite, ese require cae adentro del primer test
// que dispara el redirect: `el rescate no le gana al redirect de query`. Medido el 26-ago
// dentro de vitest, el registry solo cuesta 1943 ms con el cache del SO caliente.
//
// Lo que eso provoca, medido con el reporter JSON sobre la suite COMPLETA: ese test tardaba
// 30455 ms en la primera corrida del dia y 2965 ms en la segunda (10.3x), contra un
// `testTimeout` de 10 s. El resto de la suite se movio 1.1x entre las dos, o sea que no era
// contencion de CPU generica: era este require. Cargarlo aca lo pasa a la fase de import de
// vitest, que no tiene `testTimeout`, y el cuerpo del test vuelve a medir solo el orden que
// afirma. El tercer test mas lento de la suite queda en 1.6 s en frio, 6x bajo el umbral.
require('../../handlers/intent-registry');

// ─── Supabase mock ──────────────────────────────────────────────────────────
// Cada llamada a from(tabla) devuelve un chain que es thenable (await-able)
// y donde todos los metodos de filtrado retornan this para permitir chaining.
// tableData = { 'tabla': [filas] } configura que devuelve cada tabla.

function makeChain(data = [], error = null) {
  const c = {};
  // `maybeSingle` faltaba y su ausencia no daba un fallo legible: el chain devolvía `undefined`,
  // el call-site lo invocaba y el TypeError caía en el catch del intent, que responde el mismo
  // texto amable que un fallo de negocio. O sea que un método sin modelar se veía igual que un
  // rechazo de la DB. Lo destapó el claim de `restaurar_eliminado` al empezar a usarlo.
  const METHODS = ['select','insert','update','delete','upsert',
                   'eq','ilike','gte','lte','is','neq','not','order','limit','single','maybeSingle'];
  for (const m of METHODS) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (onFulfilled, onRejected) =>
    Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : null })
      .then(onFulfilled, onRejected);
  c.catch = () => Promise.resolve({ data, error });
  c._resolvedData = data;
  return c;
}

function makeSupabaseMock(tableData = {}) {
  const chains = {};
  const sb = {
    from: vi.fn((table) => {
      if (!chains[table]) chains[table] = makeChain(tableData[table] || [], null);
      return chains[table];
    }),
    _chains: chains,
    _setData: (table, data) => { chains[table] = makeChain(data); },
    // Simula un fallo de postgrest: NO lanza, devuelve { data: null, error }.
    _setError: (table, error) => { chains[table] = makeChain(null, error); },
  };
  return sb;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TX_BASE = {
  id: 'tx-001',
  usuario_id: 'user-001',
  monto: 45.50,
  monto_pen: 45.50,
  moneda: 'PEN',
  comercio: 'Starbucks',
  categoria: 'Alimentacion',
  subcategoria: 'cafeteria',
  tipo: 'gasto',
  fecha: '2026-04-01',
  created_at: new Date().toISOString(),
  descripcion_original: null,
};

const USUARIO = { id: 'user-001', plan: 'free' };

// ─── Context builder ─────────────────────────────────────────────────────────

function buildCtx(sb, extras = {}) {
  return {
    supabase: sb,
    mesActual: 4,
    anioActual: 2026,
    netoPrompt: 'Test',
    historialConv: [],
    CATEGORIAS_VALIDAS: new Set(['Alimentacion','Transporte','Vivienda','Salud',
      'Entretenimiento','Compras','Educacion','Finanzas','Trabajo_Negocio','Suscripciones','Otros']),
    CATEGORIA_MAP: {},
    obtenerUltimaTransaccion: vi.fn().mockResolvedValue(TX_BASE),
    recategorizarTransaccion: vi.fn().mockResolvedValue({ ok: true, tx: TX_BASE }),
    // Desde B30 devuelve un resultado DISCRIMINADO: `{ok:true, destino}` o
    // `{ok:false, motivo}`. El default es el caso normal; cada motivo tiene su propio test,
    // porque el handler ya no puede ni anunciar "Regla creada" sobre una regla descartada ni
    // darle el mismo consejo a un rechazo por política que a un fallo de escritura.
    guardarReglaComercio: vi.fn().mockResolvedValue({ ok: true, destino: { categoria: 'Transporte', subcategoria: null } }),
    retroaplicarRegla: vi.fn().mockResolvedValue(0),
    corregirTransaccionEspecifica: vi.fn().mockResolvedValue({ ok: true, comercio: 'Starbucks', monto: 45.50, moneda: 'PEN' }),
    guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-002', ...TX_BASE }),
    obtenerTipoCambio: vi.fn().mockResolvedValue({ venta: 3.75 }),
    // Los helpers de conversion van REALES, no mockeados: son la regla que el item 13
    // unifico (validar como el alta, y escribir monto_pen y tipo_cambio juntos). Un
    // `vi.fn()` aca dejaria los tres sitios de edicion sin ejercitar justo lo que cambio.
    convertirUsdAPen: realTx.convertirUsdAPen,
    tipoCambioDeLaFila: realTx.tipoCambioDeLaFila,
    verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null),
    crearCategoriaLibreUsuario: vi.fn(),
    // Reemplazó al guard de canonicidad que estaba copiado en los tres call-sites (B26):
    // decide sola si la categoría es libre, canónica faltante, o nada. Devuelve promesa porque
    // el call-site encadena la subcategoría con `.then()` — un `vi.fn()` pelado da undefined y
    // el handler revienta.
    asegurarCategoriaUsuario: vi.fn().mockResolvedValue('creada'),
    crearSubcategoriaLibreUsuario: vi.fn(),
    detectarCategoriaIA: vi.fn().mockResolvedValue({ categoria: 'Alimentacion', subcategoria: 'cafeteria' }),
    parsearRegistroManual: vi.fn().mockResolvedValue({ ok: true, monto: 50, moneda: 'PEN', categoria: 'Alimentacion', subcategoria: 'cafeteria', tipo: 'gasto', fecha: '2026-04-05' }),
    parsearCorreccionesMultiples: vi.fn().mockResolvedValue([]),
    redactarConNETO: vi.fn().mockResolvedValue('Respuesta mock'),
    fechaHoyPeru: vi.fn().mockReturnValue('2026-04-05'),
    fechaAyerPeru: vi.fn().mockReturnValue('2026-04-04'),
    formatFecha: vi.fn((f) => f || ''),
    ...extras,
  };
}

function call(intencion, datos, msg = '') {
  const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
  const ctx = buildCtx(sb);
  return { sb, ctx, run: () => handler.handle({ intencion, msg, datos, usuario: USUARIO, from: '+51999', ctx }) };
}

// ─── registrar_manual ───────────────────────────────────────────────────────

describe('registrar_manual', () => {
  it('registra gasto valido y retorna confirmacion con monto', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en cafe', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(res).toContain('S/50.00');
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
  });

  it('rechaza cuando monto no extraible', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, { parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false, monto: 0 }) });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste algo', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(res).toContain('No pude leer el monto');
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });

  // El copy del rebote le pedia a la persona EXACTAMENTE lo que acababa de escribir: decia
  // 'Dime algo como: "gaste S/50 en farmacia"' a quien habia escrito "Gaste 1.5 en Movilidad".
  // Lo que queda rebotando despues del rescate es otra cosa (monto dictado en palabras, o
  // varios gastos juntos) y el texto tiene que nombrar eso.
  it('el rebote ya no pide el formato que la persona ya usó', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, { parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false, monto: 0 }) });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste algo', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(res).not.toMatch(/gast[eé] S\/50 en farmacia/i);
    expect(res).toMatch(/d[ií]gitos/i);
    expect(res).toMatch(/uno por mensaje/i);
  });

  it('llama crearSubcategoriaLibreUsuario para subcategorias custom', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: true, monto: 30, moneda: 'PEN', categoria: 'Comida_Casera', subcategoria: 'tupper', tipo: 'gasto', fecha: '2026-04-05' }),
      detectarCategoriaIA: vi.fn().mockResolvedValue({}),
    });
    await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 30 en tupper', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(ctx.crearSubcategoriaLibreUsuario).toHaveBeenCalledWith('user-001', 'Comida_Casera', 'tupper');
  });

  /**
   * El centinela NO se le muestra al usuario, y el fixture es el que importa: la fila que
   * devuelve `guardarTransaccion` viene de un `.select()`, o sea DESPUÉS del trigger
   * `trg_normalize_subcategoria` (migración 070), que capitaliza. El código escribe
   * 'sin_categoria' y prod devuelve **'Sin_categoria'** — 499 filas al 12-ago-2026, cero en
   * minúscula. Con la comparación literal que había antes, la confirmación de todo gasto sin
   * clasificar decía `✅ S/50.00 en Otros > Sin_categoria`.
   *
   * Por eso el mock devuelve la grafía de la DB y no la del código: un fixture en minúscula
   * probaría una rama que producción no alcanza nunca.
   */
  it('un gasto sin clasificar NO muestra el centinela en la confirmación', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: true, monto: 50, moneda: 'PEN', categoria: 'Otros', subcategoria: 'sin_categoria', tipo: 'gasto', fecha: '2026-04-05' }),
      detectarCategoriaIA: vi.fn().mockResolvedValue({}),
      guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-003', categoria: 'Otros', subcategoria: 'Sin_categoria' }),
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en no se que', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(res.toLowerCase()).not.toContain('sin_categoria');
    expect(res).toContain('en Otros ·');   // la categoría sola, sin el ` > sub`
    expect(res).not.toContain('Otros >');
    // Y la sub tampoco nace como categoría libre en el árbol del usuario.
    expect(ctx.crearSubcategoriaLibreUsuario).not.toHaveBeenCalled();
  });

  it('una subcategoría REAL sí se muestra (el fix no se comió el caso normal)', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-004', categoria: 'Alimentacion', subcategoria: 'Cafeteria' }),
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en cafe', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(res).toContain('Alimentacion > Cafeteria');
  });
});

// ─── registrar_manual: rescate cuando el modelo descarta un monto que SÍ está ───
//
// Medido el 2026-08-18 sobre 20 rebotes reales de 14 usuarios: en 16 de ellos el mensaje
// llegó bien a `registrar_manual` y el que devolvió `{ok:false}` fue gpt-4o-mini, sobre
// mensajes con el monto en dígitos. No hay regla que prediga cuáles: "Gasté X en Movilidad"
// falla con 0.5 y con 20, "gasté X en taxi" entra con los dos, y la misma cadena dio 4/4 y
// 1/3 en dos corridas. Por eso el arreglo es un extractor determinístico, no un prompt nuevo
// ni un regex más largo.
describe('registrar_manual — rescate determinístico del monto', () => {
  it('rescata el gasto cuando el modelo devuelve ok:false pero el monto está en el texto', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
      detectarCategoriaIA: vi.fn().mockResolvedValue({}),
      guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-r1', categoria: 'Otros', subcategoria: 'Sin_categoria' }),
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'Gasté 1.5 en Movilidad', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
    expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ monto: 1.5, moneda: 'PEN', tipo: 'gasto' });
    expect(res).toContain('S/1.50');
  });

  /**
   * El `abort()` estaba al ENTRAR a la rama de "sin monto", porque las dos salidas que había
   * no leían `detCat`. El rescate agrega una tercera que sí sigue al camino normal, y dejarlo
   * arriba hace que toda fila rescatada quede en 'Otros' aunque el clasificador supiera la
   * categoría.
   *
   * El mock TIENE que honrar la señal, o la cancelación no se observa y el test pasa verde
   * con el bug puesto. Y tiene que honrarla COMO LA FUNCIÓN REAL: `detectarCategoriaIA`
   * atrapa el `AbortError` en su propio try y devuelve `{categoria:null}`, NO rechaza. Una
   * versión anterior de este mock rechazaba, así que fijaba una decisión sobre una premisa
   * que producción no puede producir — y hacía creer que el bug perdía el gasto entero.
   */
  it('el rescate NO cancela al clasificador de categorías, y usa su resultado', async () => {
    let señal;
    const detectarCategoriaIA = vi.fn((_msg, _uid, opts) => new Promise((resolve) => {
      señal = opts && opts.signal;
      if (señal) señal.addEventListener('abort', () => resolve({ categoria: null, subcategoria: null }));
      setImmediate(() => resolve({ categoria: 'Transporte', subcategoria: 'taxi' }));
    }));
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
      detectarCategoriaIA,
      guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-r2', categoria: 'Transporte', subcategoria: 'Taxi' }),
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'Gasté 1.5 en Movilidad', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(señal.aborted).toBe(false);
    // Ésta es la aserción que mata la mutación: con el abort arriba, detCat resuelve
    // `{categoria:null}` y la fila se guarda con el default del rescate.
    expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ categoria: 'Transporte', subcategoria: 'taxi' });
    expect(res).toContain('S/1.50');
  });

  /**
   * Un mensaje que es SOLO un número no se rescata, y rebotar ahí es lo correcto.
   * Los dos casos reales medidos eran SALDOS, no gastos. Uno de ellos es el usuario que
   * había pagado S/10 esa mañana, terminó anotando su saldo como ingreso porque era la
   * única forma de que entrara, y su resumen del día quedó diciendo "Ingresos: S/ 3815.70".
   * Registrarlo en silencio como gasto sería peor que el rebote de hoy.
   */
  it('un mensaje que es SOLO un número no se rescata', async () => {
    for (const msg of ['592.91', 'S/ 1045.21', '  100  ', '250 soles']) {
      const sb = makeSupabaseMock({ transacciones: [] });
      const ctx = buildCtx(sb, {
        parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
        detectarCategoriaIA: vi.fn().mockResolvedValue({}),
      });
      const res = await handler.handle({ intencion: 'registrar_manual', msg, datos: {}, usuario: USUARIO, from: '+51999', ctx });
      expect(ctx.guardarTransaccion, 'no debería guardar: ' + JSON.stringify(msg)).not.toHaveBeenCalled();
      expect(res).toContain('No pude leer el monto');
    }
  });

  /**
   * La moneda al FINAL no puede evadir la guarda de "solo un número".
   *
   * La primera versión escribía su propia lista de monedas y solo las aceptaba como prefijo,
   * así que "592.91 usd" se le escapaba y entraba como gasto en DÓLARES: `guardarTransaccion`
   * lo multiplica por el tipo de cambio, o sea un saldo de 592.91 aterrizando como ~S/2200 en
   * `monto_pen`, que es lo que alimenta reportes y score. Y "20 lucas" registraba mientras
   * "250 soles" rebotaba, siendo el mismo mensaje (el prompt del parser declara lucas = soles
   * 1:1). Lo encontró la revisión adversarial del arreglo, no la suite.
   */
  it('la moneda al final no evade la guarda de solo-un-número', async () => {
    for (const msg of ['592.91 usd', '592.91 PEN', '1045.21 S/', '20 lucas', '592.91 cocos', '250 soles']) {
      const sb = makeSupabaseMock({ transacciones: [] });
      const ctx = buildCtx(sb, {
        parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
        detectarCategoriaIA: vi.fn().mockResolvedValue({}),
      });
      const res = await handler.handle({ intencion: 'registrar_manual', msg, datos: {}, usuario: USUARIO, from: '+51999', ctx });
      expect(ctx.guardarTransaccion, 'no debería guardar: ' + JSON.stringify(msg)).not.toHaveBeenCalled();
      expect(res).toContain('No pude leer el monto');
    }
  });

  /**
   * Con DOS montos no se adivina cuál es: se rebota.
   *
   * `detectarMultiGasto` exige verbo + preposición, así que "15 taxi 40 cena" no le dispara y
   * llega acá. El extractor entra por su rama de número suelto, se queda con el PRIMERO y
   * mete el resto DENTRO del nombre del comercio: se guardaba S/15 con comercio "taxi 40
   * cena" y la persona veía un ✅ creyendo que entraron los dos gastos.
   *
   * El caso de UN solo monto va en el mismo test: sin él, "no guardó nada" se satisface
   * también rompiendo el rescate entero.
   */
  it('con dos montos en el mensaje rebota, con uno solo rescata', async () => {
    const nuevoCtx = () => {
      const sb = makeSupabaseMock({ transacciones: [] });
      return buildCtx(sb, {
        parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
        detectarCategoriaIA: vi.fn().mockResolvedValue({}),
        guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-m', categoria: 'Otros', subcategoria: 'Sin_categoria' }),
      });
    };
    for (const msg of ['15 taxi 40 cena', '20 pan, 30 leche', '20 Movilidad 30 Snack']) {
      const ctx = nuevoCtx();
      const res = await handler.handle({ intencion: 'registrar_manual', msg, datos: {}, usuario: USUARIO, from: '+51999', ctx });
      expect(ctx.guardarTransaccion, 'no debería guardar: ' + JSON.stringify(msg)).not.toHaveBeenCalled();
      expect(res).toContain('No pude leer el monto');
    }
    // Control: el mensaje de un solo monto —el caso que este arreglo existe para cubrir—
    // sigue entrando. Si esto se cae, la guarda de arriba se comió el rescate.
    const ctxOk = nuevoCtx();
    await handler.handle({ intencion: 'registrar_manual', msg: '4.10 pastillas', datos: {}, usuario: USUARIO, from: '+51999', ctx: ctxOk });
    expect(ctxOk.guardarTransaccion).toHaveBeenCalledOnce();
    expect(ctxOk.guardarTransaccion.mock.calls[0][1]).toMatchObject({ monto: 4.10 });
  });

  // El rescate no inventa: si en el texto no hay número, sigue rebotando. Sin esto, el test
  // de arriba se satisface con un extractor que devuelve cualquier cosa.
  it('no inventa monto cuando el texto no trae ninguno', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
      detectarCategoriaIA: vi.fn().mockResolvedValue({}),
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gasté algo en el mercado', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('No pude leer el monto');
  });

  /**
   * El rescate corre DESPUÉS del redirect a query, no antes.
   *
   * El mensaje no es cualquiera y elegirlo mal deja el test vacuo: hay DOS redirects, y el
   * `pre` corre antes de llamar al parser, así que "cuanto gaste hoy 50" nunca llega a la
   * rama donde vive el rescate y el test pasaría con cualquier orden. Éste matchea
   * `tienePatronGasto` (así se saltea el pre-check), matchea `detectarQuerySinMonto`, y
   * `extraerGastoSinIA` SÍ le lee un monto — o sea que si el rescate estuviera antes, esta
   * consulta se registraría como gasto de S/50.
   *
   * ⚠️ El mensaje va SIN coma, y eso no es cosmético: con coma ("gaste 50 en taxi, cuanto
   * gaste hoy") `partirEscrituraLectura` lo reconoce como mensaje COMPUESTO y entonces sí se
   * registra la mitad de escritura, a propósito — es el arreglo del mensaje mixto. Este test
   * cuida un caso distinto: el mensaje donde el sistema NO logró separar dos mitades y por lo
   * tanto no tiene evidencia positiva de que haya un gasto adentro. Ahí la conducta
   * conservadora sigue siendo no registrar. Si alguien le devuelve la coma, este test pasa a
   * medir el splitter y deja de medir el orden, en silencio.
   */
  it('el rescate no le gana al redirect de query (post-parser)', async () => {
    const MSG = 'gaste 50 en taxi cuanto gaste hoy';
    // Precondición del propio test: si alguna de las tres deja de valer, el caso dejó de
    // ejercitar el orden y hay que elegir otro mensaje en vez de creerle al verde.
    expect(handler.detectarQuerySinMonto(MSG)).toBeTruthy();
    expect(require('../../lib/nlp-guards').extraerGastoSinIA(MSG)).toBeTruthy();

    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
      detectarCategoriaIA: vi.fn().mockResolvedValue({}),
    });
    await handler.handle({ intencion: 'registrar_manual', msg: MSG, datos: {}, usuario: USUARIO, from: '+51999', ctx });
    // Llegó al parser (o sea, se salteó el pre-check) y aun así no registró nada.
    expect(ctx.parsearRegistroManual).toHaveBeenCalled();
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });

  /**
   * Y tampoco lo rescata cuando el dispatch de la consulta FALLA.
   *
   * No es hipotético: este test, en su primera versión, dependía de que el dispatch real
   * funcionara, y una corrida se fue a 28 segundos y salió roja porque la llamada de red
   * murió — el rescate se disparó sobre una consulta y registró el gasto. Lo mismo le pasa a
   * un usuario en producción cada vez que ese handler tenga un mal rato.
   *
   * El fallo se INYECTA en vez de esperar que la red se caiga sola: un test que necesita mala
   * suerte para ejercitar su rama no la ejercita nunca. Se rompe el `supabase` que el handler
   * de lectura va a usar.
   */
  it('tampoco rescata si el dispatch de la consulta revienta', async () => {
    const MSG = 'gaste 50 en taxi cuanto gaste hoy';   // sin coma: ver la nota del test de arriba
    const sb = makeSupabaseMock({ transacciones: [] });
    sb.from = vi.fn(() => { throw new Error('supabase caido'); });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
      detectarCategoriaIA: vi.fn().mockResolvedValue({}),
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: MSG, datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('No pude leer el monto');
  });
});

// ─── registrar_manual: el mensaje que trae un gasto Y una consulta ───────────
//
// "Gasté 20 en Movilidad, cuánto llevo hoy" perdía el gasto entero: `tienePatronGasto`
// saltea el pre-check, el parser devuelve ok:false, y el redirect lee el mensaje COMPLETO
// como consulta y lo despacha. Quien estaba en el muro recibía el paywall en lugar de su
// gasto, o sea que se le cortaba una ESCRITURA.
//
// El arreglo NO es mover el rescate antes del redirect, y hay dos motivos independientes
// para descartarlo: abre el agujero que cuidan los dos tests de arriba, y ADEMÁS no
// funcionaría — el primer `it` de acá lo fija midiéndolo, porque es justo la clase de
// premisa que se propaga si no queda escrita con su medición al lado.
describe('registrar_manual — mensaje mixto (escritura + lectura)', () => {
  const { extraerGastoSinIA } = require('../../lib/nlp-guards');
  const MIXTO = 'Gasté 20 en Movilidad, cuánto llevo hoy';

  const ctxMixto = (extra = {}) => buildCtx(makeSupabaseMock({ transacciones: [] }), {
    parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
    detectarCategoriaIA: vi.fn().mockResolvedValue({}),
    ...extra,
  });

  it('el rescate NO alcanza: sobre el mensaje entero el extractor devuelve null', () => {
    // Sobre la mitad sola sí lee el gasto. O sea que el problema no es dónde corre el
    // rescate: es que nadie parte el mensaje. Si esto algún día pasa a ser truthy, la
    // justificación del splitter cambió y hay que releerla, no borrar el test.
    expect(extraerGastoSinIA(MIXTO)).toBeNull();
    expect(extraerGastoSinIA('Gasté 20 en Movilidad')).toBeTruthy();
  });

  it('registra la mitad de escritura, con el monto y el comercio de esa mitad', async () => {
    const ctx = ctxMixto();
    await handler.handle({ intencion: 'registrar_manual', msg: MIXTO, datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
    expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ monto: 20, tipo: 'gasto' });
  });

  it('la fila guardada NO arrastra la pregunta', async () => {
    // `descripcion_original` alimenta `extraerLast4` y el dedup, y es lo único que después
    // permite diagnosticar qué escribió la persona. Con el mensaje entero adentro, la
    // transacción queda describiéndose a sí misma como una consulta.
    const ctx = ctxMixto();
    await handler.handle({ intencion: 'registrar_manual', msg: MIXTO, datos: {}, usuario: USUARIO, from: '+51999', ctx });
    const guardado = ctx.guardarTransaccion.mock.calls[0][1];
    expect(guardado.descripcion_original || '').not.toMatch(/cuánto/i);
    expect(guardado.comercio).toBe('Movilidad');
  });

  /**
   * LA invariante del arreglo, y la razón por la que puede correr antes del redirect.
   *
   * El defecto que este repo ya pagó era que **el fallo de red del dispatch** era lo que
   * terminaba produciendo el gasto. Acá la decisión de escribir se toma con evidencia
   * positiva y ANTES de intentar ningún dispatch, así que tiene que dar lo MISMO con el
   * dispatch sano y con el dispatch muerto. Si algún día estos dos números difieren, la
   * escritura volvió a depender de un fallo y el arreglo se rompió.
   */
  it('registra igual, ande o no ande el dispatch de la consulta', async () => {
    const sano = ctxMixto();
    await handler.handle({ intencion: 'registrar_manual', msg: MIXTO, datos: {}, usuario: USUARIO, from: '+51999', ctx: sano });

    const sbRoto = makeSupabaseMock({ transacciones: [] });
    sbRoto.from = vi.fn(() => { throw new Error('supabase caido'); });
    const roto = buildCtx(sbRoto, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }),
      detectarCategoriaIA: vi.fn().mockResolvedValue({}),
    });
    await handler.handle({ intencion: 'registrar_manual', msg: MIXTO, datos: {}, usuario: USUARIO, from: '+51999', ctx: roto });

    expect(sano.guardarTransaccion).toHaveBeenCalledOnce();
    expect(roto.guardarTransaccion).toHaveBeenCalledOnce();
    expect(roto.guardarTransaccion.mock.calls[0][1].monto)
      .toBe(sano.guardarTransaccion.mock.calls[0][1].monto);
  });

  it('la pregunta no le contamina la fecha al gasto', async () => {
    // El guard de TZ solo respeta `parsed.fecha` si el mensaje trae una fecha explícita, y
    // "cuánto llevo *hoy*" se la regalaba: con el mensaje entero, una fecha alucinada por el
    // modelo sobrevivía. Con el mensaje partido, el marcador ya no está y el guard corrige.
    const ctx = ctxMixto({
      parsearRegistroManual: vi.fn().mockResolvedValue({
        ok: true, monto: 20, moneda: 'PEN', tipo: 'gasto',
        categoria: 'Transporte', subcategoria: null, fecha: '2026-01-02',
      }),
    });
    await handler.handle({ intencion: 'registrar_manual', msg: MIXTO, datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(ctx.guardarTransaccion.mock.calls[0][1].fecha).toBe(ctx.fechaHoyPeru());
  });
});

// ─── registrar_manual: las dos llamadas al LLM van en paralelo (P′2) ─────────
//
// Registrar un gasto disparaba TRES llamadas a gpt-4o-mini en serie: la clasificación del
// message-processor, después `parsearRegistroManual` y después `detectarCategoriaIA`. Las
// dos últimas reciben solo `msg` y no dependen entre sí.
//
// Lo que se fija no es un tiempo (eso no se puede afirmar con mocks) sino la FORMA: que la
// segunda esté disparada mientras la primera sigue en vuelo. Volver a la versión en serie
// mata el primer test, porque con el parser colgado el clasificador nunca llega a llamarse.

describe('registrar_manual — paralelismo de las dos llamadas al LLM', () => {
  it('dispara detectarCategoriaIA mientras el parser sigue sin resolver', async () => {
    let resolverParser;
    const parsearRegistroManual = vi.fn(() => new Promise((res) => {
      resolverParser = () => res({ ok: true, monto: 50, moneda: 'PEN', categoria: 'Alimentacion', subcategoria: 'cafeteria', tipo: 'gasto', fecha: '2026-04-05' });
    }));
    const detectarCategoriaIA = vi.fn().mockResolvedValue({ categoria: 'Alimentacion', subcategoria: 'cafeteria' });

    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, { parsearRegistroManual, detectarCategoriaIA });
    const promesa = handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en cafe', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    // Dejar correr los microtasks pendientes SIN resolver el parser.
    await new Promise((r) => setTimeout(r, 0));

    expect(parsearRegistroManual).toHaveBeenCalledOnce();
    // ⚠️ Esto es lo que muere si alguien vuelve a poner el clasificador después del parser.
    expect(detectarCategoriaIA).toHaveBeenCalledOnce();
    expect(detectarCategoriaIA).toHaveBeenCalledWith('gaste 50 en cafe', 'user-001', expect.anything());

    resolverParser();
    const res = await promesa;
    expect(res).toContain('S/50.00');
    // Y el resultado del clasificador se sigue usando, no se descarta por llegar antes.
    expect(res).toContain('Alimentacion');
  });

  it('un fallo del clasificador sigue rompiendo el registro (no se traga en silencio)', async () => {
    // El `.catch` mudo que evita el unhandledRejection NO debe consumir el rechazo: awaitear
    // la promesa más abajo tiene que lanzar igual que cuando la llamada era secuencial.
    const detectarCategoriaIA = vi.fn().mockRejectedValue(new Error('supabase caido'));
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, { detectarCategoriaIA });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en cafe', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(res).toContain('No pude procesar eso');
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });

  it('sale por el camino del parser sin monto sin dejar un rechazo sin dueño', async () => {
    // La ruta que hace falta el `.catch`: el parser no encuentra monto, el handler retorna, y
    // la promesa del clasificador —ya en vuelo— se rechaza sin que nadie la espere. Sin la
    // guarda eso es un `unhandledRejection`, que en Node mata el proceso del backend.
    const capturados = [];
    const onUnhandled = (err) => capturados.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const sb = makeSupabaseMock({ transacciones: [] });
      const ctx = buildCtx(sb, {
        parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false, monto: 0 }),
        // ⚠️ Función PELADA, no `vi.fn()`: el spy de vitest le engancha handlers a la promesa
        // que devuelve (es como alimenta `mock.settledResults`), así que con un mock el
        // rechazo NUNCA queda huérfano y este test pasaría verde sin la guarda. Medido:
        // con `vi.fn().mockRejectedValue(...)` la mutación "quitar el .catch" no lo mata.
        detectarCategoriaIA: () => Promise.reject(new Error('supabase caido')),
      });
      const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste algo raro', datos: {}, usuario: USUARIO, from: '+51999', ctx });
      expect(res).toContain('No pude leer el monto');

      // Dos vueltas de macrotask: es cuando Node decide que un rechazo quedó sin dueño.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(capturados).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('cancela la llamada al clasificador cuando el parser no encuentra monto', async () => {
    // Disparar en paralelo hace que las rutas que salen temprano paguen una llamada a
    // gpt-4o-mini que nadie va a leer. Con `maxRetries: 3` y `timeout: 60000` (lib/ai.js) eso
    // puede ser hasta cuatro requests durante minutos, quemando presupuesto de rate-limit
    // justo en el escenario del 429 que ya se comió 163 registros.
    let señal;
    const detectarCategoriaIA = vi.fn((_msg, _uid, opts) => { señal = opts && opts.signal; return Promise.resolve({}); });
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false, monto: 0 }),
      detectarCategoriaIA,
    });
    await handler.handle({ intencion: 'registrar_manual', msg: 'gaste algo raro', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(señal).toBeInstanceOf(AbortSignal);
    expect(señal.aborted).toBe(true);
  });

  it('cancela también cuando el parser LANZA, no solo cuando no encuentra monto', async () => {
    // Este caso no lo cubría el test de arriba y la mutación lo demostró: quitar el `abort()`
    // del catch dejaba los 5 tests en verde. Es la salida más cara — si el parser reventó por
    // un 429, el clasificador está reintentando contra la misma organización saturada.
    let señal;
    const detectarCategoriaIA = vi.fn((_msg, _uid, opts) => { señal = opts && opts.signal; return Promise.resolve({}); });
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockRejectedValue(new Error('429 rate limit')),
      detectarCategoriaIA,
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en taxi', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(res).toContain('No pude procesar eso');
    expect(señal.aborted).toBe(true);
  });

  it('NO cancela en el camino feliz: el resultado del clasificador sí se usa', async () => {
    let señal;
    const detectarCategoriaIA = vi.fn((_msg, _uid, opts) => {
      señal = opts && opts.signal;
      return Promise.resolve({ categoria: 'Transporte', subcategoria: 'taxi' });
    });
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, { detectarCategoriaIA });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en taxi', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(señal.aborted).toBe(false);
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
    expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ categoria: 'Transporte', subcategoria: 'taxi' });
    expect(res).toContain('S/50.00');
  });
});

// ─── eliminar_transaccion ───────────────────────────────────────────────────

describe('eliminar_transaccion', () => {
  it('elimina cuando hay exactamente un match por monto', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra el de 45.50',
      datos: { monto: 45.50 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).toContain('45.50');
    expect(res).toContain('restaura');
  });

  it('lista opciones cuando hay multiples candidatos', async () => {
    const tx2 = { ...TX_BASE, id: 'tx-002', comercio: 'Starbucks Miraflores' };
    const sb = makeSupabaseMock({ transacciones: [TX_BASE, tx2] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra el de starbucks',
      datos: { comercio: 'starbucks' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Encontr');
    expect(res).toContain('monto o la fecha exacta');
  });

  it('responde amigablemente si no hay resultados', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(null) });
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra Netflix de 19.90',
      datos: { comercio: 'Netflix', monto: 19.90 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('No encontr');
    expect(res).toContain('Netflix');
  });

  it('inserta el snapshot ANTES del delete de la transaccion', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra el de 45.50',
      datos: { monto: 45.50 }, usuario: USUARIO, from: '+51999', ctx,
    });
    const insertOrder = sb._chains['transacciones_eliminadas'].insert.mock.invocationCallOrder[0];
    const deleteOrder = sb._chains['transacciones'].delete.mock.invocationCallOrder[0];
    expect(insertOrder).toBeDefined();
    expect(deleteOrder).toBeDefined();
    expect(insertOrder).toBeLessThan(deleteOrder);
  });

  it('no promete restaurar cuando el insert del snapshot devuelve error', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    sb._setError('transacciones_eliminadas', { message: 'insert failed' });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra el de 45.50',
      datos: { monto: 45.50 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).not.toContain('escribe \"restaura\"');
    expect(res).toContain('no lo voy a poder restaurar');
  });
});

// ─── deshacer_ultimo ────────────────────────────────────────────────────────

describe('deshacer_ultimo', () => {
  it('guarda snapshot en transacciones_eliminadas antes de borrar', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'deshacer',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(sb.from).toHaveBeenCalledWith('transacciones_eliminadas');
    expect(res).toContain('restaura');
  });

  it('responde si no hay transacciones recientes', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(null) });
    const res = await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'deshacer',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('No hay transacciones');
  });

  // El orden importa: si borramos primero y el snapshot falla, el gasto se pierde
  // y le prometimos al usuario que podia restaurarlo.
  it('inserta el snapshot ANTES del delete de la transaccion', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'deshacer',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    const insertOrder = sb._chains['transacciones_eliminadas'].insert.mock.invocationCallOrder[0];
    const deleteOrder = sb._chains['transacciones'].delete.mock.invocationCallOrder[0];
    expect(insertOrder).toBeDefined();
    expect(deleteOrder).toBeDefined();
    expect(insertOrder).toBeLessThan(deleteOrder);
  });

  it('no promete restaurar cuando el insert del snapshot devuelve error', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    sb._setError('transacciones_eliminadas', { message: 'new row violates row-level security policy' });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'deshacer',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).not.toContain('escribe \"restaura\"');
    expect(res).toContain('no lo voy a poder restaurar');
  });
});

// ─── deshacer_ultimo: la guarda de frase ambigua ────────────────────────────
//
// `undo` es el unico borrado sin sujeto, asi que es donde cae cualquier frase que el
// clasificador no supo ubicar. Estos casos afirman que NO se borra sin que el mensaje
// nombre la accion. La mutacion que los mata es quitar el `if (!PIDE_BORRAR...)` del
// handler: los dos primeros pasan a borrar y fallan por el `delete` no llamado.

describe('deshacer_ultimo — no borra si el mensaje no pidio borrar', () => {
  // El chain de una tabla se crea LAZY, la primera vez que alguien llama from(tabla). En la
  // ruta de la guarda no se toca `transacciones` en absoluto, asi que el chain no existe y
  // `expect(undefined).not.toHaveBeenCalled()` revienta con "not a spy" en vez de pasar.
  // Contar llamadas cubre los dos estados: sin chain es 0, con chain y sin delete tambien.
  const deletesDe = (sb, tabla) => sb._chains[tabla]?.delete?.mock.calls.length ?? 0;

  // Caso REAL de produccion (usuario 2cad9c8c, 17-ago-2026): escribio "Quiero reiniciar"
  // y recibio "Deshecho: Elimine Sueldo — S/ 480.00". Nunca pidio borrar nada.
  it('"Quiero reiniciar" no borra: pide la orden explicita', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'Quiero reiniciar',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(deletesDe(sb, 'transacciones')).toBe(0);
    expect(sb.from).not.toHaveBeenCalledWith('transacciones_eliminadas');
    expect(res).toContain('borra el último');
    expect(res).not.toContain('Deshecho');
  });

  // Muestra QUE se borraria, para que la segunda vuelta sea una decision informada.
  it('nombra el registro en riesgo al pedir confirmacion', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'empecemos de cero',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(deletesDe(sb, 'transacciones')).toBe(0);
    expect(res).toContain('Starbucks');
    expect(res).toContain('45.50');
  });

  // El contrapeso: la guarda no puede romper al que SI pide borrar. Si alguna de estas
  // deja de pasar, la regex se apreto de mas y el intent quedo inalcanzable.
  const ORDENES_REALES = [
    'borra el último',
    'elimina eso',
    'deshacer',
    'deshaz eso',
    'undo',
    'quita ese gasto',
    'anula el último',
    'cancela ese registro',
    'me equivoqué',
    'no era ese',
    'está mal, bórralo',
    'revierte eso',
  ];
  it.each(ORDENES_REALES)('"%s" SI borra', async (msg) => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'deshacer_ultimo', msg,
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Deshecho');
    expect(sb._chains['transacciones'].delete).toHaveBeenCalled();
  });

  // LA PUERTA GEMELA. `delete` y `undo` salen del MISMO tool (`manage_transaction`) y quién
  // de los dos sale lo elige gpt-4o-mini. Guardar solo `undo` dejaba a `eliminar_transaccion`
  // sin comercio/monto/fecha haciendo exactamente lo mismo: borrar lo último que haya. El
  // comentario de PIDE_BORRAR afirmaba que undo era el único borrado sin sujeto y era falso;
  // lo levantó la revisión adversarial, no la suite.
  it('eliminar_transaccion SIN sujeto tampoco borra con una frase ambigua', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'Quiero reiniciar',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(deletesDe(sb, 'transacciones')).toBe(0);
    expect(res).toContain('borra el último');
  });

  // Y con sujeto explícito sigue borrando sin fricción: nombrar QUÉ borrar ES la orden.
  it('eliminar_transaccion CON comercio borra aunque la frase no diga "borra"', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, {
      corregirTransaccionEspecifica: vi.fn().mockResolvedValue({ ok: true, comercio: 'Starbucks', monto: 45.5, moneda: 'PEN' }),
    });
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'el de Starbucks no va',
      datos: { comercio: 'Starbucks' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).not.toContain('No estoy seguro');
  });

  // El agujero más grave del PRIMER arreglo: PIDE_BORRAR acepta `elimin`/`borr`/`cancel`,
  // así que las frases de borrar la CUENTA pasaban la guarda y terminaban borrando el
  // último gasto. Son justo las más caras de confundir.
  const FRASES_DE_CUENTA = [
    'quiero eliminar mi cuenta',
    'borra todos mis datos',
    'cancela mi cuenta',
    'quiero borrar mi historial',
  ];
  it.each(FRASES_DE_CUENTA)('"%s" NO borra un gasto', async (msg) => {
    for (const intencion of ['deshacer_ultimo', 'eliminar_transaccion']) {
      const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
      const ctx = buildCtx(sb);
      const res = await handler.handle({
        intencion, msg, datos: {}, usuario: USUARIO, from: '+51999', ctx,
      });
      expect(deletesDe(sb, 'transacciones'), intencion + ' borró con: ' + msg).toBe(0);
      expect(res).not.toContain('Deshecho');
    }
  });

  // Un `msg` ausente no puede convertirse en un borrado silencioso: sin texto no hay
  // forma de saber que pidio, y el default tiene que ser no tocar nada.
  it('msg vacio o ausente no borra', async () => {
    for (const msg of ['', null, undefined]) {
      const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
      const ctx = buildCtx(sb);
      const res = await handler.handle({
        intencion: 'deshacer_ultimo', msg,
        datos: {}, usuario: USUARIO, from: '+51999', ctx,
      });
      expect(deletesDe(sb, 'transacciones')).toBe(0);
      expect(res).not.toContain('Deshecho');
    }
  });
});

// ─── restaurar_eliminado ────────────────────────────────────────────────────

describe('restaurar_eliminado', () => {
  it('restaura el ultimo gasto eliminado', async () => {
    const deletedRow = {
      id: 'del-001',
      usuario_id: 'user-001',
      deleted_at: new Date().toISOString(),
      restored_at: null,
      snapshot: { ...TX_BASE },
    };
    const sb = makeSupabaseMock({ transacciones_eliminadas: [deletedRow], transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'restaurar_eliminado', msg: 'restaura',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).toMatch(/[Rr]estaur/);
  });

  it('responde si no hay nada eliminado', async () => {
    const sb = makeSupabaseMock({ transacciones_eliminadas: [] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'restaurar_eliminado', msg: 'restaura',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('No tengo');
  });
});

// ─── editar_monto ───────────────────────────────────────────────────────────

describe('editar_monto', () => {
  it('busca por comercio cuando datos.comercio esta disponible', async () => {
    const netflixTx = { ...TX_BASE, id: 'tx-netflix', comercio: 'Netflix', monto: 19.90, monto_pen: 19.90 };
    const sb = makeSupabaseMock({ transacciones: [netflixTx] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_monto', msg: 'corrige Netflix a 25',
      datos: { monto_nuevo: 25, comercio: 'Netflix' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Netflix');
    expect(res).toContain('25.00');
    expect(sb.from).toHaveBeenCalledWith('transacciones');
    const chain = sb._chains['transacciones'];
    expect(chain.ilike).toHaveBeenCalledWith('comercio', '%Netflix%');
  });

  it('cae al ultimo gasto si no hay comercio en datos', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_monto', msg: 'el monto fue 80',
      datos: { monto_nuevo: 80 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
    expect(res).toContain('80.00');
  });

  it('rechaza monto invalido', async () => {
    const { run, ctx } = call('editar_monto', {});
    const res = await run();
    expect(res).toContain('Dime el monto correcto');
  });

  /**
   * B18 (auditoría 10-ago-2026): esta rama usaba `parseFloat` + `> 0`, sin techo ni
   * `isFinite`. Es el gemelo por WhatsApp del bug ya arreglado en la webapp, y acá la
   * escritura es DIRECTA: no hay formulario que frene nada antes.
   *
   * Los casos son los mismos que `validarMonto` cubre, escritos como los mandaría alguien
   * por chat. Con el chequeo suelto los cuatro primeros pasaban y terminaban en la DB.
   */
  it.each([
    ['Infinity', Infinity],
    ['string Infinity', 'Infinity'],
    ['sobre el techo de 999999.99', 1000000],
    ['15 dígitos', 999999999999999],
    ['negativo', -50],
    ['cero', 0],
    ['texto', 'mucho'],
    ['NaN', NaN],
  ])('rechaza %s', async (_nombre, monto_nuevo) => {
    const { run } = call('editar_monto', { monto_nuevo });
    const res = await run();
    expect(res).toContain('Dime el monto correcto');
  });

  it('redondea a dos decimales en vez de escribir la cola infinita', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_monto', msg: 'el monto es 33.333333',
      datos: { monto_nuevo: 33.333333 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('33.33');
    expect(sb._chains['transacciones'].update).toHaveBeenCalledWith(
      expect.objectContaining({ monto: 33.33 }),
    );
  });
});

// ─── dividir_gasto ──────────────────────────────────────────────────────────

describe('dividir_gasto', () => {
  it('divide el gasto y escribe la parte del usuario', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'dividir_gasto', msg: 'divide entre 2',
      datos: { partes: 2 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('22.75'); // 45.50 / 2
    expect(sb._chains['transacciones'].update).toHaveBeenCalledWith(
      expect.objectContaining({ monto: 22.75 }),
    );
  });

  // B18: el monto viene de la DB y esta rama lo vuelve a ESCRIBIR. Si ya estaba envenenado,
  // `parseFloat` lo dividía y lo propagaba sin mirarlo.
  it('no propaga un monto envenenado que ya estaba guardado', async () => {
    const podrido = { ...TX_BASE, monto: 'Infinity' };
    const sb = makeSupabaseMock({ transacciones: [podrido] });
    const ctx = buildCtx(sb, { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(podrido) });
    const res = await handler.handle({
      intencion: 'dividir_gasto', msg: 'divide entre 2',
      datos: { partes: 2 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('no puedo dividir');
    // Ni siquiera abre la tabla: corta antes de tocar la DB.
    expect(sb.from).not.toHaveBeenCalledWith('transacciones');
  });

  // El resultado también se valida: dividir bajo el centavo escribía un gasto de 0.00, que
  // no es un gasto — y encima rompe el promedio de cualquier cosa que lo mire después.
  it('no escribe un gasto de cero cuando la división cae bajo el centavo', async () => {
    // 0.04 / 20 = 0.002 → toFixed(2) = "0.00". (0.10/20 redondea a 0.01 y sí es válido.)
    const centavos = { ...TX_BASE, monto: 0.04, monto_pen: 0.04 };
    const sb = makeSupabaseMock({ transacciones: [centavos] });
    const ctx = buildCtx(sb, { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(centavos) });
    const res = await handler.handle({
      intencion: 'dividir_gasto', msg: 'divide entre 20',
      datos: { partes: 20 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('menos de un centavo');
    expect(sb.from).not.toHaveBeenCalledWith('transacciones');
  });
});

// ─── corregir_categoria ─────────────────────────────────────────────────────

describe('corregir_categoria', () => {
  it('recategoriza por comercio especifico', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'corregir_categoria', msg: 'mueve Rappi a Entretenimiento',
      datos: { categoria_nueva: 'Entretenimiento', comercio: 'Rappi' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Entretenimiento');
    expect(ctx.recategorizarTransaccion).toHaveBeenCalledWith('user-001', 'Rappi', 'Entretenimiento', null);
  });

  it('usa el ultimo gasto si no viene comercio', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'corregir_categoria', msg: 'muevelo a Transporte',
      datos: { categoria_nueva: 'Transporte' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
    expect(res).toContain('Transporte');
  });

  // B30 — la resolución vive ACÁ ARRIBA y no en cada consumidor, porque de este único nombre
  // salen cinco escrituras/lecturas que tienen que coincidir: la fila recategorizada, el árbol,
  // la regla, la retroaplicación de las filas VIEJAS y el texto que lee el usuario.
  //
  // Si se resolviera sólo dentro de `guardarReglaComercio`, la regla guardaría 'Alimentación'
  // mientras `retroaplicarRegla` escribe 'Alimentacion' en el histórico: el pasado y el futuro
  // del mismo comercio partidos en dos categorías, que es el bug medido dado vuelta.
  it('resuelve el alias ortográfico y TODOS los consumidores reciben el mismo nombre (B30)', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'corregir_categoria', msg: 'mueve Berny a alimentacion',
      datos: { categoria_nueva: 'alimentacion', comercio: 'Berny' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.recategorizarTransaccion).toHaveBeenCalledWith('user-001', 'Berny', 'Alimentación', null);
    expect(ctx.guardarReglaComercio).toHaveBeenCalledWith('user-001', 'Starbucks', 'Alimentación', null);
    expect(ctx.retroaplicarRegla).toHaveBeenCalledWith('user-001', 'Starbucks', 'Alimentación', null);
    expect(ctx.asegurarCategoriaUsuario).toHaveBeenCalledWith('user-001', 'Alimentación');
    expect(res).toContain('Alimentación');
    expect(res).not.toContain('alimentacion');
  });

  // La otra mitad del hallazgo: 77 reglas de 13 usuarios llevan categorías libres legítimas.
  // Si esto se pone rojo, el fix está mandando esas categorías a 'Otros' — que es el bug que
  // B28 cerró, reintroducido por la puerta que B30 viene a tapar.
  it('deja intacta la categoría libre que el mapa canónico no resuelve', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'corregir_categoria', msg: 'mueve eso a Gastos Hormiga',
      datos: { categoria_nueva: 'Gastos Hormiga', comercio: 'Starbucks' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.recategorizarTransaccion).toHaveBeenCalledWith('user-001', 'Starbucks', 'Gastos Hormiga', null);
    expect(ctx.guardarReglaComercio).toHaveBeenCalledWith('user-001', 'Starbucks', 'Gastos Hormiga', null);
    expect(res).toContain('Gastos Hormiga');
  });

  // `normalizarDestinoRegla` recorta la categoría de la REGLA y nada recortaba la que va a
  // `transacciones`, así que "Ahorro " dejaba la fila CON el espacio y la regla SIN él: dos
  // categorías distintas para todo lo que agrupe por nombre. Hay cuatro nombres con espacio
  // final en las reglas de prod ('PAGOS PENDIENTES ', 'Ahorro ', 'Sueldo ', 'PAREJA ').
  it('recorta los espacios ANTES de repartir, para que la fila y la regla no diverjan', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'corregir_categoria', msg: 'mueve eso a Ahorro',
      datos: { categoria_nueva: 'Ahorro ', comercio: 'Starbucks' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.recategorizarTransaccion).toHaveBeenCalledWith('user-001', 'Starbucks', 'Ahorro', null);
    expect(ctx.guardarReglaComercio).toHaveBeenCalledWith('user-001', 'Starbucks', 'Ahorro', null);
    expect(ctx.retroaplicarRegla).toHaveBeenCalledWith('user-001', 'Starbucks', 'Ahorro', null);
  });
});

// ─── corregir_multiple ───────────────────────────────────────────────────────
// El tercer call-site de regla, y no tenía cobertura. Recorre un `for`, así que acá la
// resolución tiene que pasar por CADA corrección, no por la primera.

describe('corregir_multiple — resuelve la categoría de cada corrección (B30)', () => {
  it('cada corrección del lote llega resuelta a la fila, a la regla y a la retroaplicación', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, {
      parsearCorreccionesMultiples: vi.fn().mockResolvedValue([
        { comercio: 'Berny', categoria_nueva: 'alimentacion' },
        { comercio: 'Uber', categoria_nueva: 'auto' },
        { comercio: 'Cliente X', categoria_nueva: 'Freelance' },
      ]),
    });
    const res = await handler.handle({
      intencion: 'corregir_multiple', msg: 'Berny es alimentacion, Uber es auto, Cliente X es Freelance',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    const catsCorregidas = ctx.corregirTransaccionEspecifica.mock.calls.map((c) => c[4]);
    // 'auto' es un colapso con pérdida decidido en B26 (→ Transporte) y 'Freelance' una
    // categoría libre legítima de las 77 medidas: una se resuelve, la otra no se toca.
    expect(catsCorregidas).toEqual(['Alimentación', 'Transporte', 'Freelance']);
    expect(ctx.retroaplicarRegla.mock.calls.map((c) => c[2])).toEqual(['Alimentación', 'Transporte', 'Freelance']);
    expect(ctx.guardarReglaComercio.mock.calls.map((c) => c[2])).toEqual(['Alimentación', 'Transporte', 'Freelance']);
    expect(res).toContain('Alimentación');
    expect(res).toContain('Transporte');
  });
});

// ─── duplicar_gasto ─────────────────────────────────────────────────────────

describe('duplicar_gasto', () => {
  it('duplica el ultimo gasto con descripcion_original=duplicado:ID', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'duplicar_gasto', msg: 'duplica el ultimo',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
    const payload = ctx.guardarTransaccion.mock.calls[0][1];
    expect(payload.descripcion_original).toMatch(/^duplicado:/);
  });
});

// ─── editar_fecha ────────────────────────────────────────────────────────────

describe('editar_fecha', () => {
  it('corrige fecha al dia especificado', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_fecha', msg: 'fue ayer',
      datos: { fecha_nueva: 'ayer' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).toContain('2026-04-04');
  });

  it('rechaza si no hay fecha nueva', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_fecha', msg: 'cambia la fecha',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Dime la fecha correcta');
  });
});

// ─── editar_categoria_comercio (defensa anti-gasto-mal-clasificado) ───────────
// Un gasto verboso ("registro un gasto de diez soles en taxi") que el clasificador
// confunde con set_category_rule llega con un "comercio" que es en realidad una
// frase (con monto o >4 palabras). El handler NO debe crear una regla basura.

describe('editar_categoria_comercio — defensa contra gasto mal clasificado', () => {
  it('NO crea regla si el comercio trae un monto (dígitos) y guía al usuario', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'registra un gasto de diez soles en taxi',
      datos: { comercio: 'gasto de diez soles en taxi', categoria: 'Transporte', subcategoria: 'Taxi' },
      usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).not.toMatch(/Regla creada/i);
    expect(res).toMatch(/registrar un gasto/i);
    expect(ctx.guardarReglaComercio).not.toHaveBeenCalled();
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
  });

  it('NO crea regla si el "comercio" es una frase de más de 4 palabras', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'anota que gasté algo en el mercado del centro',
      datos: { comercio: 'gasto en el mercado del centro', categoria: 'Alimentacion' },
      usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).not.toMatch(/Regla creada/i);
    expect(res).toMatch(/registrar un gasto/i);
    expect(ctx.guardarReglaComercio).not.toHaveBeenCalled();
  });
});

// ─── editar_categoria_comercio — el destino EFECTIVO manda (B30) ──────────────
// Este era el único de los tres caminos de regla que no tocaba el árbol del usuario y que
// anunciaba "Regla creada" sin mirar si `guardarReglaComercio` la había guardado.

describe('editar_categoria_comercio — destino efectivo y árbol (B30)', () => {
  it('imprime, retroaplica y crea en el árbol el nombre con el que quedó la regla, no el que pidió el usuario', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, {
      guardarReglaComercio: vi.fn().mockResolvedValue({ ok: true, destino: { categoria: 'Alimentación', subcategoria: 'Delivery' } }),
      retroaplicarRegla: vi.fn().mockResolvedValue(3),
    });
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de Rappi va en alimentacion',
      // OJO: `datos.subcategoria` es hoy INALCANZABLE por este intent — la tool
      // `manage_transaction.set_category_rule` sólo remapea `nueva_categoria → categoria`
      // (`handlers/neto-tools.js:961`) y no expone subcategoría. O sea que en producción la
      // rama del `> sub` no corre. Se ejercita igual porque `subRegla` ya estaba en el handler
      // desde antes y la rama tiene que ser correcta el día que la tool la exponga; lo que NO
      // hay que hacer es leer este test como evidencia de que el camino existe.
      datos: { comercio: 'Rappi', categoria: 'alimentacion', subcategoria: 'Delivery' },
      usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toMatch(/Regla creada/i);
    expect(res).toContain('Alimentación > Delivery');
    expect(ctx.retroaplicarRegla).toHaveBeenCalledWith('user-001', 'Rappi', 'Alimentación', 'Delivery');
    expect(ctx.asegurarCategoriaUsuario).toHaveBeenCalledWith('user-001', 'Alimentación');
    expect(res).toContain('3 transacciones');
  });

  // Este camino era el ÚNICO que pasaba `datos.categoria` crudo, sin capitalizar ni recortar,
  // mientras los otros tres sí. Resultado: la misma categoría libre nacía con dos grafías según
  // por dónde la pidieras, que es el split que este trabajo existe para cerrar.
  it('normaliza la grafía igual que los otros caminos: capitaliza y recorta', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de Wong va en gastos hormiga',
      datos: { comercio: 'Wong', categoria: '  gastos hormiga ' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.guardarReglaComercio).toHaveBeenCalledWith('user-001', 'Wong', 'Gastos hormiga', null);
  });

  // Antes decía "✅ Regla creada" igual. Pasa con "todo lo de X va en Otros" sin subcategoría
  // y, desde B30, con cualquier categoría que colapse a 'Otros' (`Viajes`, `Transferencia`).
  it('cuando la regla se descarta por política NO anuncia que la creó, y no retroaplica nada', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, { guardarReglaComercio: vi.fn().mockResolvedValue({ ok: false, motivo: 'no-clasifica' }) });
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de Latam va en Viajes',
      datos: { comercio: 'Latam', categoria: 'Viajes' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).not.toMatch(/Regla creada/i);
    expect(res).toMatch(/no clasificar[íi]a nada/i);
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
    expect(ctx.asegurarCategoriaUsuario).not.toHaveBeenCalled();
  });

  // El consejo es el OPUESTO al de arriba: acá hay que reintentar lo mismo, no cambiar la
  // categoría. Con un solo mensaje para los dos motivos, un rechazo de la DB mandaba al usuario
  // a probar categorías distintas contra un problema que no era suyo.
  it('cuando la escritura FALLA le pide reintentar, no que cambie de categoría', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, { guardarReglaComercio: vi.fn().mockResolvedValue({ ok: false, motivo: 'error' }) });
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de Rappi va en Delivery',
      datos: { comercio: 'Rappi', categoria: 'Delivery' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).not.toMatch(/Regla creada/i);
    expect(res).not.toMatch(/no clasificar[íi]a nada/i);
    expect(res).toMatch(/intentarlo/i);
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
  });

  it('un comercio de puros espacios culpa al comercio, no a la categoría', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, { guardarReglaComercio: vi.fn().mockResolvedValue({ ok: false, motivo: 'sin-comercio' }) });
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de va en Delivery',
      datos: { comercio: '   ', categoria: 'Delivery' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toMatch(/de qu[ée] comercio/i);
    expect(res).not.toMatch(/no clasificar[íi]a nada/i);
  });
});
