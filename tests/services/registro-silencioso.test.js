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
// Se parchea ANTES de requerir el service: `registro-silencioso` destructura del módulo al
// cargarse, así que un mock puesto después se queda mirando la función real.
const enviarWhatsapp = vi.fn().mockResolvedValue({ ok: true, msgId: 'wamid.1' });
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;
const anunciarVeredictoD10 = vi.fn().mockResolvedValue(true);
require('../../lib/whatsapp').anunciarVeredictoD10 = anunciarVeredictoD10;

const { registrarGastoSilencioso } = require('../../services/registro-silencioso');
const USUARIO = { id: 'u1' };
const CON_NUMERO = { id: 'u1', whatsapp: '51999000111' };
const FILA_GUARDADA = { id: 'tx1', tipo: 'gasto', monto: 25.5, moneda: 'PEN', comercio: 'Wong', categoria: 'Alimentación' };

describe('registrarGastoSilencioso', () => {
  beforeEach(() => {
    parsearRegistroManual.mockReset();
    guardarTransaccion.mockReset().mockResolvedValue({ ...FILA_GUARDADA });
    enviarWhatsapp.mockClear().mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    anunciarVeredictoD10.mockClear().mockResolvedValue(true);
  });

  it('guarda el gasto delegando en guardarTransaccion, sin tocar el monto', async () => {
    parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 25.5, moneda: 'PEN', comercio: 'Wong', categoria: 'Alimentación' });
    const r = await registrarGastoSilencioso('gasté 25.50 en wong', USUARIO);
    // `intento: false` porque este usuario no tiene número guardado. Es parte del contrato: el
    // aviso de primera vez lo lee para no prometer un veredicto que no viene.
    expect(r).toEqual({ registrado: true, motivo: 'ok', intento: false });
    const [usuarioId, datos] = guardarTransaccion.mock.calls[0];
    expect(usuarioId).toBe('u1');
    // El monto y la moneda viajan intactos: la conversión USD→PEN y la validación son de
    // guardarTransaccion, no de acá. Si alguien las reimplementa, este test lo delata.
    expect(datos.monto).toBe(25.5);
    expect(datos.moneda).toBe('PEN');
    expect(datos.descripcion_original).toBe('gasté 25.50 en wong');
  });

  it('en un hit de DEDUP no se le confirma nada', async () => {
    // `guardarTransaccion` no siempre devuelve la fila que escribió: cuando dedupea (mismo
    // usuario/fecha/monto/comercio dentro de 10s) devuelve el duplicado que encontró, y ese sale
    // de un `select('id, tarjeta_last4')` — sin monto, sin comercio, sin categoría. Es un objeto
    // válido, así que un `!tx` no lo atrapa, y el mensaje salía **"Anoté tu gasto: S/ undefined"**.
    // Lo encontró la revisión adversarial del diff. Y además no hay nada que confirmar: ese gasto
    // ya estaba. El caso llega desde el webhook con DOS mensajes distintos de Meta, así que el
    // dedup por wamid no lo cubre.
    guardarTransaccion.mockResolvedValue({ id: 'tx-previa', tarjeta_last4: null });
    parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 25.5, moneda: 'PEN', comercio: 'Wong' });

    const r = await registrarGastoSilencioso('gasté 25.50 en wong', CON_NUMERO);

    expect(r).toEqual({ registrado: true, motivo: 'ok', intento: false });
    expect(enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('con número guardado, la confirmación sale con los valores de la fila', async () => {
    parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 25.5, moneda: 'PEN', comercio: 'Wong', categoria: 'Alimentación' });

    const r = await registrarGastoSilencioso('gasté 25.50 en wong', CON_NUMERO);

    expect(r.intento).toBe(true);
    const [dest, texto, opts] = enviarWhatsapp.mock.calls[0];
    expect(dest).toBe('51999000111');
    // Con DOS decimales, como todo el resto del producto. `toContain('25.5')` no alcanzaba: pasa
    // igual con "25.5" pelado, así que la mutación "sacar el toFixed" sobrevivía en verde. Y este
    // es el único mensaje que este camino le puede llegar a entregar a una persona.
    expect(texto).toContain('S/ 25.50');
    expect(texto).toContain('Wong');
    expect(texto).not.toContain('undefined');
    expect(opts.tipo).toBe('confirmacion_sin_numero');
  });

  it('si Meta rechaza en el POST, el veredicto sale DESDE ACÁ y no espera un callback', async () => {
    // Es el caso más probable si la premisa se sostiene, y era el que quedaba mudo: cuando Meta
    // rechaza sincrónicamente, `registrarEntrega` escribe la fila SIN `wamid`, así que no hay
    // status callback que matchear y `avisarVeredictoD10` no corre nunca. Delegar todo el
    // veredicto al callback dejaba el experimento sin respuesta justo en el desenlace esperado.
    enviarWhatsapp.mockResolvedValue({ ok: false, code: 131026, error: 'Message undeliverable' });
    parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 25.5, moneda: 'PEN', comercio: 'Wong' });

    const r = await registrarGastoSilencioso('gasté 25.50 en wong', CON_NUMERO);

    expect(r.registrado).toBe(true);          // el gasto NO depende del experimento
    expect(anunciarVeredictoD10).toHaveBeenCalledOnce();
    expect(anunciarVeredictoD10.mock.calls[0][0]).toMatchObject({
      usuarioId: 'u1', llego: false, code: 131026, origen: 'envio',
    });
  });

  it('un fallo TRANSITORIO no es veredicto y no quema el throttle', async () => {
    // `enviarWhatsapp` devuelve el mismo `{ok:false}` cuando el POST ni siquiera llegó a Meta
    // (el timeout de 15s, DNS, respuesta no-JSON), y ahí `code` viene NULL. Tratarlo como
    // rechazo anunciaba "la premisa se sostiene" sin haber medido nada, y como el throttle es
    // por usuario, cancelaba la medición real de por vida. Es la misma clase de B19, que este
    // mismo archivo ya había pagado con `bsuidVistos`.
    enviarWhatsapp.mockResolvedValue({ ok: false, code: null, error: 'The operation was aborted' });
    parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 25.5, moneda: 'PEN', comercio: 'Wong' });

    const r = await registrarGastoSilencioso('gasté 25.50 en wong', CON_NUMERO);

    expect(r.registrado).toBe(true);
    expect(anunciarVeredictoD10).not.toHaveBeenCalled();
  });

  it('un envío aceptado NO adelanta veredicto: eso lo decide el callback', async () => {
    parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 25.5, moneda: 'PEN', comercio: 'Wong' });

    await registrarGastoSilencioso('gasté 25.50 en wong', CON_NUMERO);

    expect(anunciarVeredictoD10).not.toHaveBeenCalled();
  });

  it('un `skipped` (usuario de harness) no cuenta como intento ni dispara veredicto', async () => {
    // `enviarWhatsapp` devuelve ok:true SIN llamar a Meta cuando el destino es `is_test_user`.
    // Contarlo como intento haría que el aviso de primera vez prometa un veredicto inexistente.
    enviarWhatsapp.mockResolvedValue({ ok: true, skipped: 'test_user' });
    parsearRegistroManual.mockResolvedValue({ ok: true, tipo: 'gasto', monto: 25.5, moneda: 'PEN', comercio: 'Wong' });

    const r = await registrarGastoSilencioso('gasté 25.50 en wong', CON_NUMERO);

    expect(r.intento).toBe(false);
    expect(anunciarVeredictoD10).not.toHaveBeenCalled();
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
