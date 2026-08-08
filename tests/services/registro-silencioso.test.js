import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Registro de un gasto que NO se puede confirmar: el usuario activó un username de WhatsApp,
// lo reconocemos por BSUID (migración 065) pero no hay número al que responder.
//
// Lo que se protege acá no es "guarda el gasto" sino que este camino NO invente su propia
// lógica de dinero. Si divergiera de `guardarTransaccion`, guardaría plata distinta que el
// camino normal y nadie lo notaría: no hay respuesta al usuario que delate la diferencia.

const parsearRegistroManual = vi.fn();
require('../../services/parsers').parsearRegistroManual = parsearRegistroManual;
const guardarTransaccion = vi.fn().mockResolvedValue({ id: 'tx1' });
require('../../services/transactions').guardarTransaccion = guardarTransaccion;

const { registrarGastoSilencioso } = require('../../services/registro-silencioso');
const USUARIO = { id: 'u1' };

describe('registrarGastoSilencioso', () => {
  beforeEach(() => {
    parsearRegistroManual.mockReset();
    guardarTransaccion.mockReset().mockResolvedValue({ id: 'tx1' });
  });

  it('guarda el gasto delegando en guardarTransaccion, sin tocar el monto', async () => {
    parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 25.5, moneda: 'PEN', comercio: 'Wong', categoria: 'Alimentación' });
    const r = await registrarGastoSilencioso('gasté 25.50 en wong', USUARIO);
    expect(r).toEqual({ registrado: true, motivo: 'ok' });
    const [usuarioId, datos] = guardarTransaccion.mock.calls[0];
    expect(usuarioId).toBe('u1');
    // El monto y la moneda viajan intactos: la conversión USD→PEN y la validación son de
    // guardarTransaccion, no de acá. Si alguien las reimplementa, este test lo delata.
    expect(datos.monto).toBe(25.5);
    expect(datos.moneda).toBe('PEN');
    expect(datos.descripcion_original).toBe('gasté 25.50 en wong');
  });

  it('pasa la moneda extranjera tal cual (no convierte por su cuenta)', async () => {
    parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 100, moneda: 'USD', comercio: 'Amazon' });
    await registrarGastoSilencioso('gasté 100 dólares en amazon', USUARIO);
    const [, datos] = guardarTransaccion.mock.calls[0];
    expect(datos.moneda).toBe('USD');
    expect(datos.monto).toBe(100);
    expect(datos.monto_pen).toBeUndefined();
  });

  it('no guarda nada cuando el mensaje no es un gasto', async () => {
    parsearRegistroManual.mockResolvedValue({ ok: false });
    const r = await registrarGastoSilencioso('hola neto como estas', USUARIO);
    expect(r.motivo).toBe('no_es_gasto');
    expect(guardarTransaccion).not.toHaveBeenCalled();
  });

  // Las tres ramas de fallo. Ninguna puede propagar: el webhook ya respondió 200 a Meta y
  // una excepción acá se volvería un unhandled rejection.
  it('no propaga si el parser falla', async () => {
    parsearRegistroManual.mockRejectedValue(new Error('openai 429'));
    await expect(registrarGastoSilencioso('gasté 10', USUARIO)).resolves.toEqual({ registrado: false, motivo: 'parser_error' });
  });

  it('no propaga si el guardado falla', async () => {
    parsearRegistroManual.mockResolvedValue({ ok: true, monto: 10, moneda: 'PEN' });
    guardarTransaccion.mockRejectedValue(new Error('Monto inválido: NaN'));
    await expect(registrarGastoSilencioso('gasté 10', USUARIO)).resolves.toEqual({ registrado: false, motivo: 'guardado_error' });
  });

  it('rechaza entradas vacías sin llamar al parser (no quema una llamada a OpenAI)', async () => {
    expect(await registrarGastoSilencioso('   ', USUARIO)).toEqual({ registrado: false, motivo: 'sin_texto' });
    expect(await registrarGastoSilencioso(undefined, USUARIO)).toEqual({ registrado: false, motivo: 'sin_texto' });
    expect(await registrarGastoSilencioso('gasté 10', null)).toEqual({ registrado: false, motivo: 'sin_usuario' });
    expect(parsearRegistroManual).not.toHaveBeenCalled();
  });
});
