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
let lanzarEnSelect = null;

const persistirBsuid = vi.fn(async (usuario, bsuid) => { usuario.bsuid = bsuid; return usuario; });
require('../../helpers/db-helpers').persistirBsuid = persistirBsuid;

const selects = [];
require('../../lib/db').supabase.from = vi.fn(() => {
  const c = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn((_col, valor) => { c._valor = valor; return c; });
  c.maybeSingle = vi.fn(async () => {
    selects.push(c._valor);
    if (lanzarEnSelect) throw lanzarEnSelect;
    return { data: filas.get(c._valor) || null };
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

describe('aprender el BSUID desde los callbacks de estado', () => {
  beforeEach(() => {
    filas.clear();
    selects.length = 0;
    lanzarEnSelect = null;
    persistirBsuid.mockClear();
  });

  it('aprende el BSUID del destinatario sin que el usuario escriba', async () => {
    const st = status();
    const fila = { id: 'u1', bsuid: null };
    filas.set(st.recipient_id, fila);
    await procesarStatuses([st]);
    expect(persistirBsuid).toHaveBeenCalledWith(fila, 'PE.2052090595730104');
  });

  // `sent` ocurre al ENVIAR, antes de que la persona reciba o lea nada. Es el estado que hace
  // barato el mapeo: si solo mirásemos `read`, dependeríamos de que abran el chat.
  it('funciona ya en `sent`, no solo en delivered/read', async () => {
    const st = status({ status: 'sent' });
    filas.set(st.recipient_id, { id: 'u1', bsuid: null });
    await procesarStatuses([st]);
    expect(persistirBsuid).toHaveBeenCalledTimes(1);
  });

  it('no vuelve a consultar por el mismo número (una query por instancia, no por callback)', async () => {
    const st = status();
    filas.set(st.recipient_id, { id: 'u1', bsuid: null });
    const mismoNumero = (estado) => ({ ...st, id: 'wamid.' + estado, status: estado });
    await procesarStatuses([st, mismoNumero('delivered'), mismoNumero('read')]);
    expect(selects.length).toBe(1);
  });

  it('ignora callbacks sin BSUID (usuario cuyo Meta todavía no lo manda)', async () => {
    const st = status({ recipient_user_id: undefined });
    filas.set(st.recipient_id, { id: 'u2', bsuid: null });
    await procesarStatuses([st]);
    expect(persistirBsuid).not.toHaveBeenCalled();
  });

  // Las dos ramas que no pueden tumbar el procesamiento de entregas: el mapeo es un extra,
  // y `notification_deliveries` es la razón por la que esta función existe.
  it('un número que no está en `usuarios` no rompe nada', async () => {
    await expect(procesarStatuses([status()])).resolves.toBeUndefined();
    expect(persistirBsuid).not.toHaveBeenCalled();
  });

  it('si la consulta falla, procesarStatuses sigue su curso', async () => {
    lanzarEnSelect = new Error('socket hang up');
    await expect(procesarStatuses([status({ status: 'delivered' })])).resolves.toBeUndefined();
  });
});
