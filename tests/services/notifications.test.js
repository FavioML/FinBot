import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Supabase chainable stub: cualquier metodo devuelve la cadena, y la cadena es
// awaitable resolviendo { data: [] } (sin historial => sin alerta de gasto inusual).
function makeChain() {
  const chain = {};
  for (const m of ['select', 'eq', 'ilike', 'gte', 'neq', 'limit', 'order', 'insert', 'update']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve) => resolve({ data: [] });
  return chain;
}

const dbMock = { supabase: { from: vi.fn(() => makeChain()) } };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue(true) };
const budgetMock = { verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null) };
const notifDbMock = { crearNotificacion: vi.fn().mockResolvedValue(true) };

const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
const waPath = require.resolve(path.join(projectRoot, 'lib/whatsapp.js'));
const budgetPath = require.resolve(path.join(projectRoot, 'services/budget.js'));
const notifDbPath = require.resolve(path.join(projectRoot, 'lib/notifications-db.js'));

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: waMock };
require.cache[budgetPath] = { id: budgetPath, filename: budgetPath, loaded: true, exports: budgetMock };
require.cache[notifDbPath] = { id: notifDbPath, filename: notifDbPath, loaded: true, exports: notifDbMock };

const { enviarAlertaTransaccion } = require('../../services/notifications');

const TX = { id: 'tx1', monto_pen: 142 };
const RESULTADO = { monto: 142, comercio: 'BCP', categoria: 'Otros', tipo: 'gasto', fecha: '2026-07-14' };

describe('enviarAlertaTransaccion — opt-out alertas_transaccion', () => {
  beforeEach(() => { waMock.enviarWhatsapp.mockClear(); });

  it('NO envia WhatsApp si el usuario apago las alertas (alertas_transaccion=false)', async () => {
    const usuario = { id: 'u1', whatsapp: '51999', alertas_transaccion: false };
    await enviarAlertaTransaccion(usuario, TX, RESULTADO);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('envia WhatsApp si las alertas estan activas (alertas_transaccion=true)', async () => {
    const usuario = { id: 'u1', whatsapp: '51999', alertas_transaccion: true };
    await enviarAlertaTransaccion(usuario, TX, RESULTADO);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
  });

  it('envia WhatsApp si el campo no existe (usuario legacy / columna ausente)', async () => {
    const usuario = { id: 'u1', whatsapp: '51999' };
    await enviarAlertaTransaccion(usuario, TX, RESULTADO);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
  });

  it('la tarjeta incluye comercio, monto y categoria', async () => {
    const usuario = { id: 'u1', whatsapp: '51999', alertas_transaccion: true };
    await enviarAlertaTransaccion(usuario, TX, RESULTADO);
    const msg = waMock.enviarWhatsapp.mock.calls[0][1];
    expect(msg).toContain('Nuevo gasto');
    expect(msg).toContain('BCP');
    expect(msg).toContain('142.00');
    expect(msg).toContain('Otros');
  });

  it('no envia nada si la transaccion es invalida', async () => {
    const usuario = { id: 'u1', whatsapp: '51999', alertas_transaccion: true };
    await enviarAlertaTransaccion(usuario, null, RESULTADO);
    await enviarAlertaTransaccion(usuario, TX, { monto: null });
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });
});
