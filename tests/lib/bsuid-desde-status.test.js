import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Mapeo pasivo del BSUID desde los callbacks de estado.
//
// Medido contra un callback real el 08-ago-2026: traen `recipient_id` (el número) y
// `recipient_user_id` (el BSUID) juntos, y ya en `sent`. Eso permite mapear a los usuarios sin
// que escriban — con los recordatorios y resúmenes que ya reciben — que es lo único que llega
// a quien está por activar un username y no piensa escribir antes.

const filas = new Map();        // whatsapp -> fila
let lanzarEnSelect = null;      // el cliente LANZA (socket hang up)
let errorEnSelect = null;       // el cliente devuelve { error } sin lanzar
let estadoPersistir = 'guardado';

const persistirBsuidConEstado = vi.fn(async (usuario, bsuid) => {
  if (estadoPersistir === 'guardado') usuario.bsuid = bsuid;
  return { usuario, estado: estadoPersistir };
});
require('../../helpers/db-helpers').persistirBsuidConEstado = persistirBsuidConEstado;

const selects = [];
require('../../lib/db').supabase.from = vi.fn(() => {
  const c = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn((_col, valor) => { c._valor = valor; return c; });
  c.maybeSingle = vi.fn(async () => {
    selects.push(c._valor);
    if (lanzarEnSelect) throw lanzarEnSelect;
    if (errorEnSelect) return { data: null, error: errorEnSelect };
    return { data: filas.get(c._valor) || null, error: null };
  });
  // procesarStatuses hace update(...).eq(...).select('id') sobre notification_deliveries
  c.update = vi.fn(() => c);
  c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
  return c;
});

const { procesarStatuses } = require('../../lib/whatsapp');

// El Set de números ya vistos vive en el MÓDULO y no se limpia nunca (a propósito: una sola
// consulta por número y por instancia). Así que cada test usa su propio número, o el segundo
// heredaría el cache del primero y pasaría por la razón equivocada.
let n = 0;
const numeroFresco = () => '5199900' + String(1000 + (n++)).slice(-4);
const status = (extra = {}) => ({
  id: 'wamid.x' + n, status: 'sent', timestamp: '1',
  recipient_id: numeroFresco(), recipient_user_id: 'PE.2052090595730104', ...extra,
});
// El mismo número otra vez, que es como llega el callback siguiente del mismo envío.
const otroCallback = (st, estado) => ({ ...st, id: 'wamid.' + estado, status: estado });

describe('aprender el BSUID desde los callbacks de estado', () => {
  beforeEach(() => {
    filas.clear();
    selects.length = 0;
    lanzarEnSelect = null;
    errorEnSelect = null;
    estadoPersistir = 'guardado';
    persistirBsuidConEstado.mockClear();
  });

  it('aprende el BSUID del destinatario sin que el usuario escriba', async () => {
    const st = status();
    const fila = { id: 'u1', bsuid: null };
    filas.set(st.recipient_id, fila);
    await procesarStatuses([st]);
    expect(persistirBsuidConEstado).toHaveBeenCalledWith(fila, 'PE.2052090595730104');
  });

  // `sent` ocurre al ENVIAR, antes de que la persona reciba o lea nada. Es el estado que hace
  // barato el mapeo: si solo mirásemos `read`, dependeríamos de que abran el chat.
  it('funciona ya en `sent`, no solo en delivered/read', async () => {
    const st = status({ status: 'sent' });
    filas.set(st.recipient_id, { id: 'u1', bsuid: null });
    await procesarStatuses([st]);
    expect(persistirBsuidConEstado).toHaveBeenCalledTimes(1);
  });

  it('no vuelve a consultar por el mismo número (una query por instancia, no por callback)', async () => {
    const st = status();
    filas.set(st.recipient_id, { id: 'u1', bsuid: null });
    await procesarStatuses([st, otroCallback(st, 'delivered'), otroCallback(st, 'read')]);
    expect(selects.length).toBe(1);
  });

  // Los tres callbacks de un envío llegan en POSTs SEPARADOS, o sea concurrentes de verdad. El
  // test de arriba los pasa en un solo array y los procesa en fila, así que NO ve esta carrera:
  // sin la promesa compartida, los tres pasan el `has` antes de que el primero termine.
  it('tres callbacks CONCURRENTES del mismo número hacen una sola consulta', async () => {
    const st = status();
    filas.set(st.recipient_id, { id: 'u1', bsuid: null });
    await Promise.all([
      procesarStatuses([st]),
      procesarStatuses([otroCallback(st, 'delivered')]),
      procesarStatuses([otroCallback(st, 'read')]),
    ]);
    expect(selects.length).toBe(1);
    expect(persistirBsuidConEstado).toHaveBeenCalledTimes(1);
  });

  it('ignora callbacks sin BSUID (usuario cuyo Meta todavía no lo manda)', async () => {
    const st = status({ recipient_user_id: undefined });
    filas.set(st.recipient_id, { id: 'u2', bsuid: null });
    await procesarStatuses([st]);
    expect(persistirBsuidConEstado).not.toHaveBeenCalled();
  });

  // Las dos ramas que no pueden tumbar el procesamiento de entregas: el mapeo es un extra,
  // y `notification_deliveries` es la razón por la que esta función existe.
  it('un número que no está en `usuarios` no rompe nada', async () => {
    await expect(procesarStatuses([status()])).resolves.toBeUndefined();
    expect(persistirBsuidConEstado).not.toHaveBeenCalled();
  });

  it('si la consulta falla, procesarStatuses sigue su curso', async () => {
    lanzarEnSelect = new Error('socket hang up');
    await expect(procesarStatuses([status({ status: 'delivered' })])).resolves.toBeUndefined();
  });

  // ── B19: qué entra al Set y qué no ────────────────────────────────────────────────
  // El Set no se limpia nunca en la vida de la instancia, así que meter ahí un fallo
  // transitorio congela el mapeo de ese número hasta el próximo deploy. La pregunta de estos
  // tests es siempre la misma: después de esto, ¿el número SIGUE siendo consultable?

  it('un SELECT que LANZA deja el número reintentable en el callback siguiente', async () => {
    const st = status();
    filas.set(st.recipient_id, { id: 'u1', bsuid: null });
    lanzarEnSelect = new Error('socket hang up');
    await procesarStatuses([st]);
    lanzarEnSelect = null;
    await procesarStatuses([otroCallback(st, 'delivered')]);
    expect(selects.length).toBe(2);
    expect(persistirBsuidConEstado).toHaveBeenCalledTimes(1);   // el reintento sí llegó a guardar
  });

  it('un SELECT que devuelve { error } tampoco se lee como "ese número no es de nadie"', async () => {
    const st = status();
    filas.set(st.recipient_id, { id: 'u1', bsuid: null });
    errorEnSelect = { message: 'upstream request timeout' };
    await procesarStatuses([st]);
    errorEnSelect = null;
    await procesarStatuses([otroCallback(st, 'delivered')]);
    expect(selects.length).toBe(2);
    expect(persistirBsuidConEstado).toHaveBeenCalledTimes(1);
  });

  // El corazón de B19: `persistirBsuid` se traga el error del UPDATE, así que "no lanzó" nunca
  // significó "se guardó". Sin el estado explícito este caso es indistinguible del éxito.
  it('un UPDATE que falla deja el número reintentable (el fallo no lo delata una excepción)', async () => {
    const st = status();
    filas.set(st.recipient_id, { id: 'u1', bsuid: null });
    estadoPersistir = 'fallo';
    await procesarStatuses([st]);
    estadoPersistir = 'guardado';
    await procesarStatuses([otroCallback(st, 'delivered')]);
    expect(selects.length).toBe(2);
    expect(persistirBsuidConEstado).toHaveBeenCalledTimes(2);
  });

  // Y las tres respuestas que SÍ son definitivas, porque reintentarlas no cambia nada y el Set
  // existe justamente para no repetirlas.
  it('un número que no es de ningún usuario NO se reconsulta', async () => {
    const st = status();
    await procesarStatuses([st]);
    await procesarStatuses([otroCallback(st, 'delivered')]);
    expect(selects.length).toBe(1);
  });

  it('una colisión de BSUID (23505) NO se reintenta: es permanente', async () => {
    const st = status();
    filas.set(st.recipient_id, { id: 'u1', bsuid: null });
    estadoPersistir = 'colision';
    await procesarStatuses([st]);
    await procesarStatuses([otroCallback(st, 'delivered')]);
    expect(selects.length).toBe(1);
    expect(persistirBsuidConEstado).toHaveBeenCalledTimes(1);
  });

  it('cuando ya lo tenía guardado tampoco se reconsulta', async () => {
    const st = status();
    filas.set(st.recipient_id, { id: 'u1', bsuid: 'PE.2052090595730104' });
    estadoPersistir = 'sin_cambio';
    await procesarStatuses([st]);
    await procesarStatuses([otroCallback(st, 'delivered')]);
    expect(selects.length).toBe(1);
  });
});
