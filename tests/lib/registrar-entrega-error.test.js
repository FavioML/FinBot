import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * `registrarEntrega` es quien escribe la fila de `notification_deliveries`, y esa fila es el
 * LEDGER que leen los dedup de `cron/checks.js`. Hasta el 20-ago-2026 el insert descartaba el
 * `{ error }`.
 *
 * El detalle que lo hacía invisible: había un `try/catch` alrededor, así que **parecía**
 * cubierto. Pero supabase-js no lanza — devuelve `{ data, error }` — así que ese catch estaba
 * muerto para el modo de falla real (RLS, 5xx de PostgREST, constraint) y un insert rechazado
 * se veía EXACTAMENTE igual que uno exitoso: sin log, sin nada.
 *
 * Por qué importa, con la aritmética medida: `checkRecordatorioOnboarding` corre **cada 15
 * minutos** (`cron/schedule.js`) sobre una ventana de 3h. Sin fila, el usuario vuelve a ser
 * candidato en cada corrida — hasta ~12 avisos. No es hipotético: el 20-jul dos usuarios
 * recibieron 12 `onboarding` idénticos cada uno.
 *
 * Este archivo NO afirma que el fallo se recupere: desde acá no se puede (Meta ya aceptó el
 * mensaje, y quién decide qué hacer con un ledger perdido es el llamador). Afirma que **se
 * vea**, que es la diferencia entre leerlo en el log y volver a deducirlo de la tabla.
 */

let resultadoInsert = { error: null };
let lanzarEnInsert = null;
const inserts = [];

let resultadoUpdate = { data: [], error: null };

require('../../lib/db').supabase.from = vi.fn((tabla) => {
  const chain = {
    insert: vi.fn(async (fila) => {
      inserts.push({ tabla, fila });
      if (lanzarEnInsert) throw lanzarEnInsert;
      return resultadoInsert;
    }),
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    select: vi.fn(async () => resultadoUpdate),
  };
  return chain;
});

const logMock = require('../../lib/logger');
const errSpy = vi.spyOn(logMock, 'error').mockImplementation(() => {});

// Se ejercita por `enviarWhatsapp(null, ...)` y no llamando a `registrarEntrega` directo (que
// además no está exportada): esa es la ruta REAL del usuario web-first, la que deja la fila
// `skipped_no_whatsapp` de la que depende el dedup del nudge.
const { enviarWhatsapp, procesarStatuses } = require('../../lib/whatsapp');
const registrarEntrega = ({ usuarioId, tipo }) => enviarWhatsapp(null, 'msg', { usuarioId, tipo });

beforeEach(() => {
  inserts.length = 0;
  errSpy.mockClear();
  resultadoInsert = { error: null };
  lanzarEnInsert = null;
});

describe('registrarEntrega grita cuando la fila del ledger no queda', () => {
  const BASE = { usuarioId: 'u-1', tipo: 'onboarding', estado: 'skipped_no_whatsapp' };

  it('el camino feliz no loguea error', async () => {
    await registrarEntrega(BASE);
    expect(inserts).toHaveLength(1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('un { error } devuelto (sin lanzar) sale por el log — es el modo de falla REAL', async () => {
    resultadoInsert = { error: { message: 'new row violates row-level security policy' } };
    await registrarEntrega(BASE);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = errSpy.mock.calls[0];
    // El log tiene que decir de QUIÉN y de QUÉ aviso: sin eso no se puede cruzar con la tabla.
    expect(ctx.usuarioId).toBe('u-1');
    expect(ctx.tipo).toBe('onboarding');
    expect(ctx.err).toMatch(/row-level security/);
    expect(msg).toMatch(/dedup/i);
  });

  it('sigue cubriendo el caso que SÍ lanza, que es el que el catch veía', async () => {
    lanzarEnInsert = new Error('socket hang up');
    await registrarEntrega(BASE);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('no lanza nunca y devuelve el skip: es best-effort y no puede tumbar el envío', async () => {
    resultadoInsert = { error: { message: 'boom' } };
    await expect(registrarEntrega(BASE)).resolves.toEqual({ ok: false, skipped: 'no_whatsapp' });
  });

  it('sin `tipo` no escribe nada (las respuestas del webhook no llevan ledger)', async () => {
    await registrarEntrega({ usuarioId: 'u-1', estado: 'sent' });
    expect(inserts).toHaveLength(0);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

/**
 * El mismo defecto vivía 240 líneas más abajo en el mismo archivo, y ahí era PEOR: con `error`,
 * `data` viene `null` y caía en la rama que le da una interpretación BENIGNA — "status sin fila
 * de notificación (mensaje conversacional)" — a nivel `debug`. Un UPDATE rechazado se leía como
 * "este status no era de un aviso", sin dejar rastro sobre `info`.
 *
 * Lo que se pierde en silencio: `delivered_at`/`failed_at` no se escriben nunca (y son la
 * fuente de verdad de entrega, no lo que devuelve el POST a Meta), y `avisarVeredictoD10` no se
 * llama — el único camino por el que sale el veredicto del experimento de BSUID.
 */
describe('procesarStatuses distingue "no era un aviso" de "no pude escribirlo"', () => {
  const STATUS = [{ id: 'wamid.X', status: 'delivered', timestamp: '1787000000' }];

  it('cero filas de verdad es debug, no error: es un turno conversacional', async () => {
    resultadoUpdate = { data: [], error: null };
    await procesarStatuses(STATUS);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('un { error } NO puede leerse como conversacional', async () => {
    resultadoUpdate = { data: null, error: { message: 'timeout' } };
    await procesarStatuses(STATUS);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = errSpy.mock.calls[0];
    expect(ctx.wamid).toBe('wamid.X');
    expect(ctx.err).toMatch(/timeout/);
    // El mensaje tiene que NEGAR explícitamente la lectura benigna: es la que costó el bug.
    expect(msg).toMatch(/no es un status conversacional/i);
  });
});
