import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * LA OTRA MITAD DEL ÍTEM 21, para los `services/` que el guard de crons NO alcanzaba.
 *
 * El guard de `tests/cron/lecturas-leen-el-error.test.js` barre `services/`, pero sólo el cierre
 * transitivo desde `cron/checks.js`. `escaneoAutomatico` lo llama `cron/index.js`, así que
 * `services/gmail-scanner.js` —con el escaneo de correo entero adentro— quedaba a UN salto del
 * perímetro, en un directorio que el guard sí mira. `referrals.js` y `notifications.js`, igual.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTOS TRES NO COMPARTEN POLÍTICA
 *
 * Es la razón por la que el guard de forma no alcanza. Los tres archivos tienen lecturas mudas
 * de la misma FORMA y tres arreglos distintos:
 *
 *   · **`gmail-scanner`, pre-checks de dedupe → CERRADO.** Tocan el cupo de Google y el
 *     dashboard de la persona. El índice único `(usuario_id, gmail_msg_id)` tapa el caso
 *     moderno, pero el pre-check existe justamente para las filas VIEJAS sin `gmail_msg_id`,
 *     que ese índice no protege: ahí una lectura caída era un gasto DUPLICADO. Y
 *     `gmail_excluidos` no tiene ninguna red detrás — un correo que el usuario mandó a ignorar
 *     volvía a registrarse solo.
 *   · **`gmail-scanner`, el cron → ABORTA la corrida.** Las dos lecturas definen JUNTAS a quién
 *     se le escanea; con una caída, su mitad de usuarios dejaba de recibir sus movimientos sin
 *     una sola línea que lo dijera. Abortar es barato: corre cada 15 minutos.
 *   · **`referrals.resumenReferidoParaAdmin` → ABIERTO, pero DECLARANDO que no sabe.** Es lo que
 *     el admin lee ANTES de aprobar un comprobante, y su default con la lectura muda (0% de
 *     descuento, sin referrer) es EXACTAMENTE el de un usuario sin referido. O sea que
 *     "no pude leer" se presentaba como "se esperan S/10" — y ese admin podía rechazar un pago
 *     legítimo de S/5. Por eso `parcial: true`, que el consumidor imprime.
 *   · **`notifications` → ABIERTO y en silencio.** La alerta de gasto inusual no sale, que es el
 *     lado seguro; lo único que cambia es que ahora se sabe por qué.
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
 * `escrituras` guarda el PAYLOAD y los filtros de cada insert/update, y sin eso el doble sólo
 * sabía que "hubo una escritura a `usuarios`". Una revisión adversarial lo evadió tres veces
 * sobre el guard del claim histórico, las tres en verde: una liberación que escribe
 * `historico_importado: true` (la persona queda igual de quemada), una que se come el
 * `.eq('id', …)` y libera el claim de la TABLA ENTERA, y una que emite `log.error` en cada
 * liberación exitosa. Contar cadenas `tabla:op` no puede ver ninguna de las tres.
 */
const db = { resp: {}, llamadas: [], escrituras: [] };
/**
 * **Este doble sabe simular MÁS DE UNA FILA, y sin eso el arreglo de `.limit(1)` no tendría
 * quien lo sostenga.** Sembrar `{ filas: [...] }` hace que el terminador se comporte como
 * postgrest-js: con `.limit(1)` recorta antes, y sin él `maybeSingle()` **fabrica un PGRST116
 * del lado del cliente** cuando vuelven >1 (verificado en
 * `node_modules/@supabase/postgrest-js/dist/index.cjs`). Es la única forma de que un test note
 * la diferencia entre el pre-check de `transacciones` —cuyo índice único es PARCIAL, así que
 * puede haber dos filas— y el de `gmail_excluidos`, cuyo índice es completo.
 */
const MULTIPLES = (n) => ({
  code: 'PGRST116',
  details: 'Results contain ' + n + ' rows, application/vnd.pgrst.object+json requires 1 row',
  message: 'JSON object requested, multiple (or no) rows returned',
});
function cadena(tabla) {
  const c = {};
  let op = 'select';
  let limite = null;
  const resultado = () => {
    db.llamadas.push(tabla + ':' + op);
    const k = tabla + ':' + op;
    const v = db.resp[k];
    if (Array.isArray(v)) return v.length ? v.shift() : { data: null, error: null };
    if (v) return v;
    return { data: null, error: null };
  };
  /** Aplica la semántica de terminador de fila única sobre una siembra `{ filas: [...] }`. */
  const unaFila = (r, sintetizarSiSobran) => {
    if (!r || !Array.isArray(r.filas)) return r;
    const filas = limite != null ? r.filas.slice(0, limite) : r.filas;
    if (filas.length > 1) return sintetizarSiSobran ? { data: null, error: MULTIPLES(filas.length) } : { data: filas[0], error: null };
    return { data: filas.length ? filas[0] : null, error: null };
  };
  // `filtros` se llena DESPUÉS del `.update()` y se comparte por referencia con la escritura ya
  // registrada — es el orden real de postgrest-js (`.update(payload).eq(...)`).
  const filtros = [];
  for (const m of ['select', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'order', 'ilike']) c[m] = () => c;
  c.eq = (col, val) => { filtros.push([col, val]); return c; };
  c.limit = (n) => { limite = n; return c; };
  c.insert = (payload) => { op = 'insert'; db.escrituras.push({ tabla, op, payload, filtros }); return c; };
  c.update = (payload) => { op = 'update'; db.escrituras.push({ tabla, op, payload, filtros }); return c; };
  c.maybeSingle = async () => unaFila(resultado(), true);
  // **`single()` NO es igual a `maybeSingle()`, y hacerlos iguales dejaba sin cobertura la
  // distinción que este trabajo declara load-bearing en cinco sitios.** PostgREST devuelve
  // PGRST116 cuando un `.single()` no encuentra fila; ése es todo el motivo por el que el
  // arreglo usa `maybeSingle` + `if (error)` separado del `if (!data)` en vez de un
  // `if (error)` a secas. Con los dos dobles idénticos, revertir un `.maybeSingle()` a
  // `.single()` dejaba la suite entera en verde — medido por la revisión adversarial — y en
  // producción esa mutación convierte cada 404 legítimo en un 500. Ahora la mata este doble.
  c.single = async () => {
    const r = unaFila(resultado(), true);
    return (r.data == null && !r.error) ? { data: null, error: SIN_FILAS } : r;
  };
  c.then = (res, rej) => Promise.resolve(resultado()).then(res, rej);
  return c;
}

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const parsearCorreoMock = vi.fn(async () => ({ monto: 50, comercio: 'Tienda', tipo: 'gasto' }));
const guardarTransaccionMock = vi.fn(async () => ({ id: 't1', tipo: 'gasto' }));
const registrarErrorMock = vi.fn();
const leerCorreosMock = vi.fn(async () => ({ error: null, mensajes: [{ id: 'msg-1', texto: 'compra', asunto: 'x' }] }));
const crearNotificacionMock = vi.fn(async () => ({ id: 'n1' }));

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/db.js', { supabase: { from: (t) => cadena(t) } }],
  ['lib/error-monitor.js', { registrarError: registrarErrorMock }],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn(), META_ERR_FUERA_VENTANA: 131047 }],
  ['lib/analytics.js', { capture: vi.fn(), default: { capture: vi.fn() } }],
  ['lib/notify-user.js', { notificarUsuario: vi.fn(async () => ({})), CANALES: { AMBOS: 'ambos', SOLO_WHATSAPP: 'wa', SOLO_IN_APP: 'app' } }],
  ['services/parsers.js', { parsearCorreoBancario: parsearCorreoMock }],
  ['services/transactions.js', { guardarTransaccion: guardarTransaccionMock }],
  ['services/categories.js', { obtenerCategoriasUsuario: vi.fn(async () => []) }],
  ['gmail.js', { leerCorreosBancarios: leerCorreosMock, revocarAccesoGmail: vi.fn(), configurarClienteParaCuenta: vi.fn() }],
  ['services/budget.js', { verificarAlertaPresupuesto: vi.fn(async () => null) }],
  ['lib/notifications-db.js', { crearNotificacion: crearNotificacionMock }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { escanearGmailYRegistrar, escaneoAutomatico, escanearHistoricoInicial } = require('../../services/gmail-scanner');
const { resumenReferidoParaAdmin } = require('../../services/referrals');
const { enviarAlertaTransaccion } = require('../../services/notifications');

const USUARIO = { id: 'u1', whatsapp: '51999888777', plan: 'premium', trial_estado: 'convertido' };

beforeEach(() => {
  db.resp = {};
  db.llamadas = [];
  db.escrituras = [];
  vi.clearAllMocks();
  parsearCorreoMock.mockResolvedValue({ monto: 50, comercio: 'Tienda', tipo: 'gasto' });
  guardarTransaccionMock.mockResolvedValue({ id: 't1', tipo: 'gasto' });
  leerCorreosMock.mockResolvedValue({ error: null, mensajes: [{ id: 'msg-1', texto: 'compra', asunto: 'x' }] });
});

describe('gmail-scanner: los pre-checks de dedupe fallan CERRADO', () => {
  it('con `transacciones` caída NO registra el correo ni gasta la llamada a OpenAI', async () => {
    // Sin esto, una caída sobre una fila vieja sin `gmail_msg_id` era un gasto duplicado en el
    // dashboard de la persona: el índice único no cubre ese caso.
    db.resp['transacciones:select'] = CAIDA;
    await escanearGmailYRegistrar(USUARIO);
    expect(guardarTransaccionMock, 'registró un gasto sin poder verificar el duplicado').not.toHaveBeenCalled();
    expect(parsearCorreoMock, 'gastó una llamada a OpenAI sobre un correo que no podía decidir').not.toHaveBeenCalled();
    expect(registrarErrorMock, 'el correo salteado no dejó fila en `errores`').toHaveBeenCalled();
  });

  it('con `gmail_excluidos` caída tampoco registra: ese correo no tiene otra red', async () => {
    db.resp['gmail_excluidos:select'] = CAIDA;
    await escanearGmailYRegistrar(USUARIO);
    expect(guardarTransaccionMock, 're-registró un correo que el usuario pudo haber excluido').not.toHaveBeenCalled();
    expect(registrarErrorMock).toHaveBeenCalled();
  });

  it('CONTROL: con las dos lecturas sanas SÍ registra', async () => {
    // La mitad que separa "falla cerrado" de "nunca registra nada".
    await escanearGmailYRegistrar(USUARIO);
    expect(guardarTransaccionMock).toHaveBeenCalledTimes(1);
    expect(registrarErrorMock).not.toHaveBeenCalled();
  });

  it('DOS filas con la misma descripcion_original NO rompen el correo para siempre', async () => {
    // **El índice único de `transacciones` es PARCIAL (`WHERE gmail_msg_id IS NOT NULL`)**, así
    // que sobre `descripcion_original` puede haber dos filas: una legacy sin `gmail_msg_id` y
    // una moderna con él. Sin `.limit(1)`, `maybeSingle()` fabrica un PGRST116 y eso caía en el
    // `throw`: ese correo fallaría en CADA corrida del cron, cada 15 minutos, para siempre,
    // escribiendo una fila en `errores` cada vez. Medido el 31-ago-2026: hay 83 grupos
    // duplicados y 577 filas legacy con forma de msg-id. Lo encontró la revisión adversarial.
    db.resp['transacciones:select'] = { filas: [{ id: 't-legacy' }, { id: 't-moderna' }] };
    await escanearGmailYRegistrar(USUARIO);
    expect(registrarErrorMock, 'las dos filas se leyeron como un error irrecuperable').not.toHaveBeenCalled();
    expect(guardarTransaccionMock, 'se re-registró un correo que ya estaba dos veces').not.toHaveBeenCalled();
  });

  it('CONTROL: gmail_excluidos NO lleva limit, y su índice único COMPLETO es por qué', async () => {
    // La mitad que impide que `.limit(1)` se vuelva un amuleto que se pega a toda query. Acá
    // `idx_gmail_excluidos_unique` cubre (usuario_id, descripcion_original) entero, así que dos
    // filas serían una violación del esquema y romper es lo correcto.
    db.resp['gmail_excluidos:select'] = { filas: [{ id: 'e1' }, { id: 'e2' }] };
    await escanearGmailYRegistrar(USUARIO);
    expect(registrarErrorMock, 'dos filas en gmail_excluidos pasaron desapercibidas').toHaveBeenCalled();
    expect(guardarTransaccionMock).not.toHaveBeenCalled();
  });

  it('CONTROL: un correo YA registrado se saltea sin error', async () => {
    // El caso legítimo del pre-check, que el arreglo no puede haber roto.
    db.resp['transacciones:select'] = { data: { id: 't-vieja' }, error: null };
    await escanearGmailYRegistrar(USUARIO);
    expect(guardarTransaccionMock).not.toHaveBeenCalled();
    expect(registrarErrorMock, 'un duplicado normal se reportó como error').not.toHaveBeenCalled();
  });
});

describe('gmail-scanner: el barrido HISTÓRICO libera su claim si algo se saltó', () => {
  // **El fail-closed de los pre-checks costaba datos acá, y el comentario que lo justificaba
  // sólo valía para el otro camino.** Decía "lo reintenta el escaneo de los 15 minutos", pero
  // ese cron mira una ventana de 2 días (`windowDays = 2` en `gmail.js`), no de 30; y el claim
  // `historico_importado` ya está en true, así que ni reconectando vuelve. Lo encontró la
  // revisión adversarial.
  const SIN_IMPORTAR = { id: 'u1', whatsapp: '51999888777', plan: 'premium', trial_estado: 'convertido', historico_importado: false };

  const sembrarClaim = () => { db.resp['usuarios:update'] = { data: { id: 'u1' }, error: null }; };

  it('con un correo salteado por error, `historico_importado` vuelve a false', async () => {
    sembrarClaim();
    db.resp['transacciones:select'] = CAIDA;
    const usuario = { ...SIN_IMPORTAR };
    await escanearHistoricoInicial(usuario);
    expect(usuario.historico_importado, 'el claim quedó tomado: esos 30 días no vuelven nunca').toBe(false);
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('CONTROL: sin fallos el claim se QUEDA tomado (si no, el barrido se repite solo)', async () => {
    // La mitad que impide que "liberar ante fallos" se vuelva "liberar siempre": eso re-correría
    // el barrido de 30 días en cada reconexión.
    sembrarClaim();
    const usuario = { ...SIN_IMPORTAR };
    await escanearHistoricoInicial(usuario);
    expect(usuario.historico_importado, 'el claim se liberó sin que fallara nada').toBe(true);
  });

  it('CONTROL: si el claim no se gana, no se corre el barrido', async () => {
    db.resp['usuarios:update'] = { data: null, error: null };   // otra ejecución ganó la fila
    const usuario = { ...SIN_IMPORTAR };
    expect(await escanearHistoricoInicial(usuario)).toBe(null);
    expect(leerCorreosMock, 'se corrió el barrido sin haber ganado el claim').not.toHaveBeenCalled();
  });

  it('el claim caído NO corre el barrido, y el log deja de decir "ya reclamado"', async () => {
    db.resp['usuarios:update'] = CAIDA;
    const usuario = { ...SIN_IMPORTAR };
    expect(await escanearHistoricoInicial(usuario)).toBe(null);
    expect(leerCorreosMock, 'se duplicaron 30 días de movimientos sin saber si se ganó el claim').not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * **Y los desenlaces en que el barrido no corrió NADA, que hasta el 2026-09-02 se quedaban
   * con el claim tomado.**
   *
   * `escanearGmailYRegistrar` tiene cuatro salidas vacías y sólo UNA significa que el barrido
   * corrió. Liberar sólo en `authError` dejaba las otras dos —no hay cuenta, y no se pudo leer
   * `gmail_cuentas`— quemando el import de 30 días de esa persona de forma permanente: el `if`
   * del tope de `escanearHistoricoInicial` la saca antes de volver a intentarlo, así que ni
   * reconectando. Un timeout de Supabase durante el callback de OAuth alcanzaba.
   *
   * Es preexistente: antes ese timeout se disfrazaba de `no_auth` porque `obtenerCuentasGmail`
   * se tragaba el `{ error }`. Lo nuevo es que hay con qué distinguirlo.
   *
   * **Se asserta sobre el UPDATE, no sólo sobre `usuario.historico_importado`.** Ese campo es
   * el objeto en memoria; una versión que lo pusiera en false sin escribir la fila dejaría a la
   * persona igual de quemada y pasaría el test. Lo que decide es la segunda escritura a
   * `usuarios`: la primera es el claim.
   */
  const updatesAUsuarios = () => db.escrituras.filter((e) => e.tabla === 'usuarios' && e.op === 'update');
  /**
   * La liberación, tal como tiene que verse: escribe `false` (no `true`, que deja a la persona
   * igual de quemada) y acotada a ESE usuario (sin el `.eq`, un UPDATE sin `where` libera el
   * claim del padrón entero y re-dispara barridos de 30 días para todos). Las dos mutaciones
   * pasaban el guard cuando esto sólo contaba escrituras.
   */
  const esperarLiberacionDe = (id) => {
    const updates = updatesAUsuarios();
    expect(updates.length, 'no se escribió la liberación: esos 30 días no vuelven nunca').toBe(2);
    const liberacion = updates[1];
    expect(liberacion.payload, 'la liberación no puso el flag en false').toEqual({ historico_importado: false });
    expect(liberacion.filtros, 'la liberación no está acotada a este usuario').toContainEqual(['id', id]);
  };

  for (const [nombre, lectura] of [
    ['no se pudo leer `gmail_cuentas` (`lectura_fallida`)', { error: 'lectura_fallida', mensajes: [] }],
    ['no hay ninguna cuenta conectada (`no_auth`)', { error: 'no_auth', mensajes: [] }],
    ['la autorización está caída (`AUTH_EXPIRED`)', { error: 'AUTH_EXPIRED', mensajes: [] }],
  ]) {
    it(`si ${nombre}, el claim se libera`, async () => {
      sembrarClaim();
      leerCorreosMock.mockResolvedValue(lectura);
      const usuario = { ...SIN_IMPORTAR };
      await escanearHistoricoInicial(usuario);
      esperarLiberacionDe('u1');
      expect(usuario.historico_importado).toBe(false);
    });
  }

  it('CONTROL: si el barrido SÍ corrió y no había correos, el claim se QUEDA tomado', async () => {
    // **La mitad que impide que "liberar cuando no corrió" se vuelva "liberar siempre".** Este
    // es el único vacío de los cuatro en que la lectura funcionó: la persona tiene su Gmail
    // conectado y no había movimientos en 30 días. Liberar acá re-correría el barrido entero en
    // cada reconexión. Sin este control, los tres de arriba pasan con el defecto puesto.
    sembrarClaim();
    leerCorreosMock.mockResolvedValue({ error: null, mensajes: [] });
    const usuario = { ...SIN_IMPORTAR };
    await escanearHistoricoInicial(usuario);
    expect(updatesAUsuarios().length, 'se liberó el claim de un barrido que sí corrió').toBe(1);
    expect(usuario.historico_importado).toBe(true);
    // El nivel de log también decide: `error` es "esta persona quedó quemada y no hay nada que
    // reintentar". Emitirlo en el camino feliz es fatiga de alertas sobre la única línea que
    // avisa el daño real.
    expect(logMock.error, 'un barrido sano emitió log.error').not.toHaveBeenCalled();
  });

  it('si la liberación no pega, se registra: es el único síntoma que queda', async () => {
    // No hay nada que reintentar en el momento. Sin la línea, una persona sin sus 30 días es
    // invisible — y el log tiene que ser `error`, no el `warn` del caso que sí se liberó.
    db.resp['usuarios:update'] = [{ data: { id: 'u1' }, error: null }, CAIDA];
    leerCorreosMock.mockResolvedValue({ error: 'lectura_fallida', mensajes: [] });
    const usuario = { ...SIN_IMPORTAR };
    await escanearHistoricoInicial(usuario);
    expect(logMock.error).toHaveBeenCalled();
    expect(logMock.warn, 'la liberación fallida se reportó como si hubiera pegado').not.toHaveBeenCalled();
  });
  it('LA COSTURA: salteados con la lista de mensajes VACÍA también libera', async () => {
    // **El caso que ninguno de los dos guards cubría, y por el que una mutación realista pasaba
    // en verde.** El guard de `gmail.js` produce esta forma exacta (3 ids listados, los 3 `get`
    // caídos → `mensajes: [], salteados: 3`) y el del scanner sólo probaba `salteados` con
    // `mensajes` NO vacío. En el medio queda el orden de `estado.fallidos += salteados`: si esa
    // línea se mueve debajo del `if (!mensajes.length) return null` —lo que hace cualquiera que
    // "ordene" los early-returns juntos— el contador no se suma nunca en este caso y el barrido
    // incompleto se da por completo. Verificado: 33 tests en verde con la mutación puesta.
    sembrarClaim();
    leerCorreosMock.mockResolvedValue({ error: null, mensajes: [], salteados: 3 });
    const usuario = { ...SIN_IMPORTAR };
    await escanearHistoricoInicial(usuario);
    esperarLiberacionDe('u1');
  });

  it('si el scan rechaza con un valor FALSY, la excepción igual sube', async () => {
    // `throw undefined` / `Promise.reject()` sin argumento. Gatear el re-throw por la verdad del
    // valor capturado devolvía `null` —indistinguible de "ya reclamado"— y el callback de OAuth
    // seguía de largo: `onboarding_completado: true` y "🎉 ¡Listo! Tu cuenta está activa" sobre
    // un barrido que acababa de reventar.
    sembrarClaim();
    leerCorreosMock.mockImplementation(() => Promise.reject(undefined));
    const usuario = { ...SIN_IMPORTAR };
    let subio = false;
    try { await escanearHistoricoInicial(usuario); } catch (e) { subio = true; }
    expect(subio, 'el rechazo falsy se tragó: el caller cree que todo salió bien').toBe(true);
    esperarLiberacionDe('u1');
  });

  it('si el UPDATE de liberación TIRA, sube el error del SCAN y queda el log', async () => {
    // Sin el `try` sobre la escritura, la excepción de la DB pisa la del scan (el caller ve la
    // causa equivocada) y el `log.error` —el único síntoma que queda de una persona quemada— no
    // se emite justo cuando la liberación falló peor.
    leerCorreosMock.mockRejectedValue(new Error('el error DEL SCAN'));
    db.resp['usuarios:update'] = [
      { data: { id: 'u1' }, error: null },
      { get then() { throw new Error('socket hang up'); } },
    ];
    const usuario = { ...SIN_IMPORTAR };
    await expect(escanearHistoricoInicial(usuario)).rejects.toThrow('el error DEL SCAN');
    expect(logMock.error, 'la liberación reventó y no dejó una sola línea').toHaveBeenCalled();
  });
  it('el log del barrido perdido lleva CUÁNTOS se saltaron, no un 0', async () => {
    // **La única línea que queda de un barrido perdido, y decía `fallidos: 0`.** `estado.fallidos
    // += salteados` estaba pasado el early return de `listado_fallido`, así que ese caso perdía el
    // número: el log salía `motivo: 'listado_fallido', fallidos: 0` sobre una corrida donde Gmail
    // rechazó 4 listados. El desenlace era correcto igual —libera por `motivo`— y por eso el
    // arreglo se podía revertir con la suite COMPLETA en verde. Esto lo fija.
    sembrarClaim();
    leerCorreosMock.mockResolvedValue({ error: 'listado_fallido', mensajes: [], salteados: 4 });
    const usuario = { ...SIN_IMPORTAR };
    await escanearHistoricoInicial(usuario);
    esperarLiberacionDe('u1');
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: 'listado_fallido', fallidos: 4 }),
      expect.any(String),
    );
  });

  it('si el scan LANZA, el claim se libera antes de que la excepción suba', async () => {
    // **La ruta que salteaba las 20 líneas de liberación entera.** `obtenerCuentasGmail` lanza
    // desde el 2026-09-02 y `leerCorreosBancarios` sólo envuelve la primera de sus tres
    // llamadas: las del camino legacy (`configurarClienteAutenticado`, `cargarTokens`) suben.
    // El `catch` genérico del callback de OAuth se la tragaba sin dejar una línea `HIST`, así
    // que el síntoma —usuario sin sus 30 días— era invisible.
    sembrarClaim();
    leerCorreosMock.mockRejectedValue(new Error('No se pudieron leer las cuentas de Gmail: 57P01'));
    const usuario = { ...SIN_IMPORTAR };
    await expect(escanearHistoricoInicial(usuario), 'la excepción dejó de propagarse a quien llama').rejects.toThrow('57P01');
    esperarLiberacionDe('u1');
    expect(usuario.historico_importado).toBe(false);
  });

  it('si Gmail no dejó listar, el claim se libera (no es "no había correos")', async () => {
    // Los dos `catch` de `leerCorreosDesdeCuenta` devolvían el mismo `{error:null, mensajes:[]}`
    // que el caso legítimo, así que un 429 de cuota durante el callback se registraba como
    // "30d completado". Y el histórico es el más expuesto: pide `maxPerQuery: 100` contra los
    // 20 del incremental.
    sembrarClaim();
    leerCorreosMock.mockResolvedValue({ error: 'listado_fallido', mensajes: [] });
    const usuario = { ...SIN_IMPORTAR };
    await escanearHistoricoInicial(usuario);
    esperarLiberacionDe('u1');
  });

  it('si Gmail salteó correos, el claim se libera aunque nada haya fallado al parsear', async () => {
    // Un `messages.get` caído o el cap de `maxProcess` dejan correos que existen sin mirar, y
    // eso no llegaba al `mapPool`: `estado.fallidos` se quedaba en 0 y el barrido incompleto
    // se daba por completo.
    sembrarClaim();
    leerCorreosMock.mockResolvedValue({ error: null, mensajes: [{ id: 'msg-1', texto: 'compra', asunto: 'x' }], salteados: 3 });
    const usuario = { ...SIN_IMPORTAR };
    await escanearHistoricoInicial(usuario);
    esperarLiberacionDe('u1');
  });
});

describe('gmail-scanner: el cron aborta en vez de escanear a medias', () => {
  it('con `usuarios` caída no escanea a NADIE', async () => {
    db.resp['usuarios:select'] = CAIDA;
    await escaneoAutomatico();
    expect(leerCorreosMock, 'escaneó con una lista de usuarios incompleta').not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('con `gmail_cuentas` caída tampoco: las dos definen JUNTAS a quién se escanea', async () => {
    // Sin este segundo caso, el arreglo podría estar mirando sólo la primera query y el test
    // pasaría igual — que es el modo de fallo #12 de `feedback_guards_que_no_ven`.
    db.resp['usuarios:select'] = { data: [USUARIO], error: null };
    db.resp['gmail_cuentas:select'] = CAIDA;
    await escaneoAutomatico();
    expect(leerCorreosMock, 'escaneó sólo a los legacy sin decir que faltaba la otra mitad').not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('CONTROL: con las dos sanas SÍ escanea a los usuarios que corresponden', async () => {
    db.resp['usuarios:select'] = { data: [USUARIO], error: null };
    db.resp['gmail_cuentas:select'] = { data: [], error: null };
    await escaneoAutomatico();
    expect(leerCorreosMock, 'el cron no escaneó a nadie con la base sana: el harness no mide').toHaveBeenCalled();
  });
});

describe('notifications: el silencio deja de ser indistinguible de "no correspondía"', () => {
  // **Este bloque existe porque la revisión adversarial midió que no existía.** El docblock de
  // arriba nombra a `notifications.js` como uno de los cuatro con política propia y el archivo
  // no tenía un solo caso suyo: sus dos sitios estaban cubiertos únicamente por el guard de
  // forma, que no puede ver que fallan ABIERTOS a propósito.
  const TX = { id: 't1', tipo: 'gasto', monto: 200, monto_pen: 200, moneda: 'PEN', categoria: 'Comida', comercio: 'Rest' };
  const USR = { id: 'u1', whatsapp: '51999888777', plan: 'premium', trial_estado: 'convertido' };

  it('gasto inusual: con el historial caído NO alerta, y lo loguea', async () => {
    db.resp['transacciones:select'] = CAIDA;
    await enviarAlertaTransaccion(USR, TX, { monto: 200, categoria: 'Comida', comercio: 'Rest' });
    expect(crearNotificacionMock, 'alertó "gasto inusual" sin poder calcular el promedio').not.toHaveBeenCalled();
    expect(logMock.error, 'una alerta que no salió por una caída no dejó rastro').toHaveBeenCalled();
  });

  it('CONTROL: con historial sano y un gasto 4x el promedio SÍ alerta', async () => {
    // La mitad que separa "falla abierto hacia el silencio" de "nunca alerta". Tres filas de
    // S/50 dan promedio 50; el gasto de 200 es 4x y supera el umbral de 30.
    db.resp['transacciones:select'] = { data: [{ monto: 50, monto_pen: 50, moneda: 'PEN' }, { monto: 50, monto_pen: 50, moneda: 'PEN' }, { monto: 50, monto_pen: 50, moneda: 'PEN' }], error: null };
    await enviarAlertaTransaccion(USR, TX, { monto: 200, categoria: 'Comida', comercio: 'Rest' });
    expect(crearNotificacionMock, 'el detector de gasto inusual dejó de alertar').toHaveBeenCalled();
    expect(logMock.error, 'el camino sano loguea un error: el log dejaría de significar algo').not.toHaveBeenCalled();
  });

  it('CONTROL: con historial sano y un gasto normal NO alerta', async () => {
    db.resp['transacciones:select'] = { data: [{ monto: 180, monto_pen: 180, moneda: 'PEN' }, { monto: 200, monto_pen: 200, moneda: 'PEN' }, { monto: 220, monto_pen: 220, moneda: 'PEN' }], error: null };
    await enviarAlertaTransaccion(USR, TX, { monto: 200, categoria: 'Comida', comercio: 'Rest' });
    expect(crearNotificacionMock).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('referrals: el resumen del admin declara cuando no sabe', () => {
  it('con `usuarios` caída marca `parcial` en vez de afirmar 0% de descuento', async () => {
    // El default (0%, sin referrer) es idéntico al de un usuario sin referido, así que sin la
    // bandera el admin no tiene forma de distinguir "no tiene descuento" de "no pude leerlo".
    db.resp['usuarios:select'] = CAIDA;
    const out = await resumenReferidoParaAdmin('u2');
    expect(out.parcial, 'el resumen se presentó como completo sobre una lectura caída').toBe(true);
    expect(out.descuentoPct).toBe(0);
  });

  it('con `referidos` caída también marca `parcial`', async () => {
    db.resp['usuarios:select'] = { data: { referido_dscto_pct: null }, error: null };
    db.resp['referidos:select'] = CAIDA;
    expect((await resumenReferidoParaAdmin('u2')).parcial).toBe(true);
  });

  it('CONTROL: un usuario sin referido devuelve parcial:false, que es la mitad que decide', async () => {
    // Si `parcial` fuera siempre true, la bandera no diría nada y el admin la ignoraría a la
    // semana. Éste es el caso que le da significado.
    db.resp['usuarios:select'] = { data: { referido_dscto_pct: null }, error: null };
    db.resp['referidos:select'] = { data: null, error: null };
    const out = await resumenReferidoParaAdmin('u2');
    expect(out.parcial).toBe(false);
    expect(out.descuentoPct).toBe(0);
    expect(out.referrerId).toBe(null);
  });

  it('CONTROL: con un referido real trae el descuento y NO marca parcial', async () => {
    const hoy = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    db.resp['usuarios:select'] = [
      { data: { referido_dscto_pct: 50, referido_dscto_vence: hoy }, error: null },
      { data: { nombre: 'Ana Pérez' }, error: null },
    ];
    db.resp['referidos:select'] = { data: { referrer_id: 'r1', convertido_pro: true, premio_otorgado_at: null }, error: null };
    const out = await resumenReferidoParaAdmin('u2');
    expect(out).toMatchObject({ descuentoPct: 50, referrerId: 'r1', referrerNombre: 'Ana Pérez', yaPremiado: false, parcial: false });
  });
});
