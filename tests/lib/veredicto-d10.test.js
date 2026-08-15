import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * El callback que contesta D10.
 *
 * D10 pregunta si a alguien cuyo número Meta dejó de mandarnos le llega igual un mensaje
 * dirigido al número que le guardamos antes. Desde el 15-ago-2026 la confirmación se intenta
 * sola (`services/registro-silencioso.js`) y **el veredicto lo decide este callback**, no el
 * envío: Meta contesta 200 encolando, incluso para destinatarios que después rechaza.
 *
 * Lo que se prueba acá es que el veredicto EXISTE y llega. Sin esto, el experimento entero
 * termina en una fila de `notification_deliveries` que nadie mira, que es exactamente el estado
 * del que este trabajo viene a sacarlo: la medición pasiva llevaba meses disponible y sin leer.
 *
 * Es también la mitad más fácil de romper sin enterarse. El aviso vive dentro del bucle que
 * procesa los callbacks de TODOS los envíos, así que cualquier cambio ahí lo puede dejar mudo
 * sin poner nada en rojo — no hay usuario que reclame por un Telegram que no salió.
 */

const filaDeEntrega = { valor: null };

require('../../helpers/db-helpers').persistirBsuidConEstado = vi.fn(async (usuario) => ({ usuario, estado: 'sin_usuario' }));

/**
 * El mock PROYECTA las columnas que pidió el `select`, en vez de devolver la fila entera.
 *
 * No es prolijidad: la primera versión ignoraba el argumento, y con eso la mutación "volver el
 * `select` a `'id'`" sobrevivía en verde. En producción eso deja `tipo` en `undefined`, el
 * veredicto no se dispara nunca y **D10 no se contesta jamás** — sin un solo test rojo y sin
 * nadie que reclame, porque el único síntoma es un Telegram que no llega. Un mock más permisivo
 * que la DB real convierte a este archivo en decoración.
 */
require('../../lib/db').supabase.from = vi.fn(() => {
  const c = {};
  c._cols = null;
  c.select = vi.fn((cols) => { c._cols = cols; return c; });
  c.eq = vi.fn(() => c);
  c.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  c.update = vi.fn(() => c);
  c.then = (onF, onR) => {
    const pedidas = String(c._cols || '').split(',').map((s) => s.trim()).filter(Boolean);
    const proyectada = (filaDeEntrega.valor || []).map((fila) =>
      Object.fromEntries(Object.entries(fila).filter(([k]) => pedidas.includes(k))));
    return Promise.resolve({ data: proyectada, error: null }).then(onF, onR);
  };
  return c;
});

// Devuelve `true` como el real: `notificarAdmin` ahora reporta si algún canal lo aceptó, y el
// throttle depende de eso. Un mock que devolviera `undefined` haría que TODOS los tests corran
// por la rama de "no salió", o sea que el mock decidiría el comportamiento bajo prueba.
const notificarAdmin = vi.fn().mockResolvedValue(true);
require('../../lib/admin-notify').notificarAdmin = notificarAdmin;

const logError = vi.fn();
require('../../lib/logger').error = logError;

const { procesarStatuses, TIPO_CONFIRMACION_SIN_NUMERO } = require('../../lib/whatsapp');

// Números frescos: `aprenderBsuidDeStatus` cachea por número en un Set de módulo que no se
// limpia, y reusar uno haría que el segundo test pasara por la razón equivocada.
let n = 0;
const status = (extra = {}) => ({
  id: 'wamid.d10.' + (++n), status: 'delivered', timestamp: '1',
  recipient_id: '5199901' + String(1000 + n).slice(-4), ...extra,
});

// El anuncio está throttleado por `usuario_id` con un Set de MÓDULO que no se limpia (a
// propósito: si no, `delivered` y `read` del mismo envío son dos Telegrams, y cada gasto futuro
// de esa persona otro par). O sea que cada test necesita su propio usuario, o el segundo pasaría
// por la razón equivocada — silencio por throttle leído como silencio por la condición que se
// está probando.
let u = 0;
const usuarioFresco = () => 'u-oculto-' + (++u);
const filaD10 = (usuarioId) => [{ id: 'nd-1', tipo: TIPO_CONFIRMACION_SIN_NUMERO, usuario_id: usuarioId }];

describe('el veredicto de D10 sale por el callback de status', () => {
  let usuarioId;
  beforeEach(() => {
    notificarAdmin.mockClear().mockResolvedValue(true);
    logError.mockClear();
    usuarioId = usuarioFresco();
    filaDeEntrega.valor = filaD10(usuarioId);
  });

  it('un `delivered` grita que la premisa es FALSA', async () => {
    await procesarStatuses([status({ status: 'delivered' })]);

    expect(notificarAdmin).toHaveBeenCalledOnce();
    const msg = notificarAdmin.mock.calls[0][0];
    expect(msg).toMatch(/PREMISA ES FALSA/i);
    expect(msg).toContain(usuarioId);
    // El aviso tiene que decir qué hacer, no solo que pasó: quien lo lea meses después no va a
    // reconstruir solo que esto habilita desarmar el camino silencioso.
    expect(msg).toMatch(/registro-silencioso/);
  });

  it('un `read` cuenta como llegado igual que un `delivered`', async () => {
    // Si alguien lo LEYÓ, le llegó. Tratar solo `delivered` como entrega dejaría la conclusión
    // colgada del orden en que Meta manda los callbacks.
    await procesarStatuses([status({ status: 'read' })]);

    expect(notificarAdmin).toHaveBeenCalledOnce();
    expect(notificarAdmin.mock.calls[0][0]).toMatch(/PREMISA ES FALSA/i);
  });

  it('un `failed` reporta el código y descarta la ventana de 24h como explicación', async () => {
    await procesarStatuses([status({ status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] })]);

    expect(notificarAdmin).toHaveBeenCalledOnce();
    const msg = notificarAdmin.mock.calls[0][0];
    expect(msg).toContain('131026');
    expect(msg).toContain('Message undeliverable');
    // Es la propiedad que hace útil a esta medición y que la pasiva no tenía: el usuario acababa
    // de escribirnos, así que la ventana estaba abierta y el fallo es de IDENTIDAD, no cadencia.
    expect(msg).toMatch(/131047/);
    expect(msg).not.toMatch(/PREMISA ES FALSA/i);
  });

  it('un `131047` NO se reporta como rechazo de identidad', async () => {
    // La primera versión tenía el texto fijo y podía salir diciendo "Código 131047 ... esto NO
    // es 131047". El chiste es lo de menos: la premisa "la ventana está abierta porque nos
    // acaba de escribir" asume que Meta ata su mensaje entrante (que llega por BSUID) a ESTE
    // número a efectos de la ventana — que es el mismo vínculo de identidad que se está
    // midiendo. Si no existe, un 131047 es la respuesta correcta y no dice nada de identidad.
    await procesarStatuses([status({ status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] })]);

    const msg = notificarAdmin.mock.calls[0][0];
    expect(msg).toMatch(/no concluye/i);
    expect(msg).not.toMatch(/rechazo por identidad/i);
    expect(msg).not.toMatch(/PREMISA ES FALSA/i);
  });

  it('un `failed` sin `errors` no inventa un código', async () => {
    // `patch.fail_code` queda en null cuando Meta manda el status sin `errors`, y el texto salía
    // como "Código *null*", que es justo el tipo de dato inventado del que este trabajo viene a
    // salir.
    await procesarStatuses([status({ status: 'failed' })]);

    const msg = notificarAdmin.mock.calls[0][0];
    expect(msg).not.toMatch(/\bnull\b/);
    expect(msg).toContain('(sin código)');
  });

  it('avisa UNA sola vez por usuario, aunque lleguen los dos callbacks del mismo envío', async () => {
    // `delivered` y `read` son dos callbacks del MISMO mensaje, `procesarStatuses` corre antes
    // del dedup por wamid del webhook (que además solo cubre `value.messages`), y el intento se
    // repite en cada gasto futuro de esa persona. Sin throttle, un solo experimento son varios
    // Telegrams y el patrón real de este camino son 6 mensajes en 13 minutos.
    await procesarStatuses([status({ status: 'delivered' })]);
    await procesarStatuses([status({ status: 'read' })]);
    await procesarStatuses([status({ status: 'delivered' })]);

    expect(notificarAdmin).toHaveBeenCalledOnce();
  });

  it('NO dice nada por una entrega de cualquier otro tipo', async () => {
    // El aviso vive en el bucle que procesa los callbacks de TODOS los envíos. Si se disparara
    // por cualquier fila, cada recordatorio de las 8pm sería un Telegram.
    filaDeEntrega.valor = [{ id: 'nd-2', tipo: 'recordatorio_diario', usuario_id: usuarioId }];

    await procesarStatuses([status({ status: 'delivered' })]);

    expect(notificarAdmin).not.toHaveBeenCalled();
  });

  it('NO dice nada cuando el status no tiene fila (mensaje conversacional)', async () => {
    filaDeEntrega.valor = [];

    await procesarStatuses([status({ status: 'delivered' })]);

    expect(notificarAdmin).not.toHaveBeenCalled();
  });

  it('un `sent` no adelanta ningún veredicto', async () => {
    // Meta encola y contesta 200 sobre destinatarios que después rechaza. Confundir `sent` con
    // entrega es el error que ya casi produjo una conclusión falsa dos veces en este trabajo.
    await procesarStatuses([status({ status: 'sent' })]);

    expect(notificarAdmin).not.toHaveBeenCalled();
  });

  it('un veredicto POSITIVO posterior no se lo come el throttle del negativo', async () => {
    // El envío NO está throttleado: se intenta en cada gasto, y el patrón real de este camino
    // son ráfagas. Con la clave por usuario a secas era first-writer-wins entre dos veredictos
    // que no son equivalentes — un rechazo quemaba la clave y el `delivered` posterior, que es
    // el ÚNICO veredicto accionable del experimento, se descartaba en silencio.
    await procesarStatuses([status({ status: 'failed', errors: [{ code: 131026, title: 'undeliverable' }] })]);
    await procesarStatuses([status({ status: 'delivered' })]);

    expect(notificarAdmin).toHaveBeenCalledTimes(2);
    expect(notificarAdmin.mock.calls[1][0]).toMatch(/PREMISA ES FALSA/i);
  });

  it('si el aviso NO salió, el veredicto queda para reintentar', async () => {
    // `notificarAdmin` se traga sus propios errores. Marcar la clave sin mirar su resultado
    // perdía el veredicto para siempre con Telegram caído: el síntoma es un Telegram que no
    // llega, o sea ninguno. Es exactamente el estado del que este trabajo saca al experimento.
    notificarAdmin.mockResolvedValue(false);
    await procesarStatuses([status({ status: 'delivered' })]);
    expect(notificarAdmin).toHaveBeenCalledOnce();

    notificarAdmin.mockResolvedValue(true);
    await procesarStatuses([status({ status: 'delivered' })]);

    expect(notificarAdmin).toHaveBeenCalledTimes(2);
    expect(notificarAdmin.mock.calls[1][0]).toMatch(/PREMISA ES FALSA/i);
  });

  // ACÁ HABÍA UN TEST Y SE BORRÓ A PROPÓSITO. Hacía `notificarAdmin.mockRejectedValue(...)` para
  // ejercitar el `catch` de `avisarVeredictoD10`, y `notificarAdmin` **nunca rechaza**: envuelve
  // todo en su propio try/catch. O sea que fabricaba una rama que producción no toma, que es la
  // regla que este repo ya tiene escrita en `services/registro-silencioso.js`. Peor: su comentario
  // afirmaba cubrir el fallo del aviso, y el fallo REAL —Telegram caído, que devuelve normal— era
  // justo el que se perdía sin que nada lo detectara. Eso lo cubre ahora el test de acá arriba
  // ("si el aviso NO salió"). El `catch` sigue en el código como defensa en profundidad del bucle
  // que procesa TODOS los callbacks, y queda sin test a sabiendas: no hay entrada real que lo
  // alcance. Lo encontró la segunda revisión adversarial.
});
