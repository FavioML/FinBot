// Multi-intent dispatch test (mlt-001, mlt-002).
// Verifies that when OpenAI returns multiple tool_calls, each one is
// dispatched to its handler (not just tool_calls[0]).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..'
);

// Stub all message-processor heavy deps via require.cache before requiring it.
function stubModule(relPath, exports) {
  const abs = require.resolve(path.join(projectRoot, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

// Counter for tool_calls returned by mock OpenAI.
const guardarTransaccionMock = vi.fn().mockImplementation(async (uid, datos) => ({ id: 'tx-' + Math.random(), ...datos }));

// Stub Supabase client (used by message-processor for tickets and nlp_errors).
function makeChain() {
  const c = {};
  for (const m of ['select','insert','update','delete','upsert','eq','ilike','gte','lte','is','neq','not','order','limit','single']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (ok) => Promise.resolve({ data: [], error: null }).then(ok);
  c.catch = () => Promise.resolve({ data: [], error: null });
  return c;
}
stubModule('lib/db.js', { supabase: { from: vi.fn(() => makeChain()) } });

// Stub Gmail (avoid OAuth env vars at import).
stubModule('gmail.js', {
  obtenerCuentasGmail: vi.fn().mockResolvedValue([]),
  generarUrlAutorizacion: vi.fn(() => 'https://oauth.example/x'),
});
stubModule('services/gmail-scanner.js', { escanearGmailYRegistrar: vi.fn() });

// Stub services/transactions to capture guardarTransaccion calls.
stubModule('services/transactions.js', {
  obtenerTipoCambio: vi.fn().mockResolvedValue({ venta: 3.75 }),
  guardarTransaccion: guardarTransaccionMock,
  obtenerGastosMes: vi.fn(),
  obtenerGastosSemana: vi.fn(),
  obtenerUltimaTransaccion: vi.fn(),
  recategorizarTransaccion: vi.fn(),
  corregirTransaccionEspecifica: vi.fn(),
  guardarReglaComercio: vi.fn(),
  retroaplicarRegla: vi.fn(),
  obtenerConsultasPendientes: vi.fn().mockResolvedValue([]),
});

// Stub parsers — registrar_manual handler calls parsearRegistroManual on the
// raw msg, NOT on individual tool args. To test multi-intent we need it to
// echo back data the handler can use. We'll make it return `ok:true` with
// the monto/comercio coming from the *datos* the handler passes.
// But parsers are imported separately by the handler. Instead, we can
// intercept by stubbing parsers too.
stubModule('services/parsers.js', {
  parsearCorreoBancario: vi.fn().mockResolvedValue({ ok: false, monto: 0 }),
  // Para multi-intent test: el handler de registrar_manual usa parsearRegistroManual,
  // pero también respeta datos.monto si vienen extraídos del tool_call.
  parsearRegistroManual: vi.fn().mockImplementation(async (msg) => {
    // Default: extract first number — kept simple for the test.
    const m = msg.match(/(\d+(?:\.\d+)?)/);
    return { ok: !!m, monto: m ? parseFloat(m[1]) : 0, moneda: 'PEN', categoria: 'Otros', subcategoria: 'sin_categoria', tipo: 'gasto', fecha: '2026-04-05' };
  }),
  parsearCorreccionesMultiples: vi.fn().mockResolvedValue([]),
});

// Stub other heavy deps.
stubModule('services/budget.js', {
  guardarPresupuesto: vi.fn(), obtenerPresupuestosMes: vi.fn(),
  verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null), formatearEstadoPresupuesto: vi.fn(),
});
stubModule('services/recommendations.js', {
  generarRecomendaciones: vi.fn(), construirDatosUsuario: vi.fn(), generarMiniRecomendacion: vi.fn(),
});
stubModule('services/debts.js', {
  registrarDeuda: vi.fn(), obtenerDeudas: vi.fn(), abonarDeuda: vi.fn(),
  marcarDeudaPagada: vi.fn(), formatearResumenDeudas: vi.fn(),
  consolidarDeudasPorContraparte: vi.fn(), saldarTodasDeudas: vi.fn(),
});
stubModule('services/metas.js', {
  obtenerMetas: vi.fn(), abonarMeta: vi.fn(), calcularRitmoAhorro: vi.fn(),
  registrarLogro: vi.fn(), obtenerLogros: vi.fn(), verificarRachaAportes: vi.fn(),
});
stubModule('services/categories.js', {
  obtenerCategoriasUsuario: vi.fn().mockResolvedValue(null),
  detectarCategoriaIA: vi.fn().mockResolvedValue({}),
  crearCategoriaLibreUsuario: vi.fn(),
  crearSubcategoriaLibreUsuario: vi.fn(),
});
stubModule('services/neto-gpt.js', { redactarConNETO: vi.fn().mockResolvedValue('mock') });
stubModule('services/reports.js', { generarYEnviarReporte: vi.fn() });
stubModule('lib/whatsapp.js', { enviarWhatsapp: vi.fn() });
stubModule('lib/admin-notify.js', { notificarErrorAdmin: vi.fn() });
stubModule('lib/error-monitor.js', { registrarError: vi.fn() });

// Mock OpenAI on lib/ai (loaded by setup.js).
const ai = require(path.join(projectRoot, 'lib/ai.js'));

// Now require the processor (after all stubs are in place).
const { procesarMensajeLibre } = require(path.join(projectRoot, 'handlers/message-processor.js'));

describe('multi-intent dispatch (mlt-001, mlt-002)', () => {
  beforeEach(() => {
    guardarTransaccionMock.mockClear();
  });

  it('dispatches all tool_calls when OpenAI returns multiple register_transaction calls', async () => {
    // Mock OpenAI to return 2 register_transaction tool_calls in parallel.
    ai.openai.chat.completions.create.mockResolvedValueOnce({
      choices: [{
        message: {
          tool_calls: [
            {
              id: 'call_1', type: 'function',
              function: {
                name: 'register_transaction',
                arguments: JSON.stringify({ monto: 50, moneda: 'PEN', comercio: 'taxi', categoria: 'Transporte' }),
              },
            },
            {
              id: 'call_2', type: 'function',
              function: {
                name: 'register_transaction',
                arguments: JSON.stringify({ monto: 30, moneda: 'PEN', comercio: 'almuerzo', categoria: 'Alimentacion' }),
              },
            },
          ],
        },
      }],
    });

    const usuario = { id: 'u1', plan: 'free', nombre: 'Test' };
    await procesarMensajeLibre('gasté 50 en taxi y 30 en almuerzo', usuario, '+51999');

    // Both transactions should have been persisted.
    expect(guardarTransaccionMock).toHaveBeenCalledTimes(2);
  });

  it('still works with a single tool_call (regression)', async () => {
    ai.openai.chat.completions.create.mockResolvedValueOnce({
      choices: [{
        message: {
          tool_calls: [
            {
              id: 'call_1', type: 'function',
              function: {
                name: 'register_transaction',
                arguments: JSON.stringify({ monto: 25, moneda: 'PEN', comercio: 'cafe', categoria: 'Alimentacion' }),
              },
            },
          ],
        },
      }],
    });
    const usuario = { id: 'u2', plan: 'free', nombre: 'Test' };
    await procesarMensajeLibre('gasté 25 en cafe', usuario, '+51999');
    expect(guardarTransaccionMock).toHaveBeenCalledTimes(1);
  });
});
