import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parsearCorreoBancario, beneficiarioEsElTitular } = require('../services/parsers');

const mockCreate = globalThis.__mockOpenAICreate;

/**
 * UNA TRANSFERENCIA A TU PROPIO NOMBRE NO ES UN GASTO.
 *
 * Reportado por una pagadora dos veces (24-oct y 02-nov-2026): "los ingresos no los está calculando
 * como ingreso sino como egresos". El 02-nov preguntó cuántos ingresos tuvo en el día y Neto le
 * listó tres "gastos" por transferencia. Medido en producción el 04-nov: 16 de sus 20 transferencias
 * leídas de Gmail tenían como beneficiario a ELLA MISMA (S/ 5,395), y otros dos usuarios tenían 5
 * más. Todas entraron por el barrido de Gmail, con asuntos "Constancia de Transferencia a Terceros
 * BCP" / "a Otros Bancos" (logs de Railway).
 *
 * El mecanismo: BCP le manda la constancia también al BENEFICIARIO cuando quien paga anota su
 * correo, y el prompt arma el comercio de una transferencia como "<Beneficiario> — <propósito>" con
 * tipo gasto. En el buzón del que cobra eso es su propio nombre como "a quién le pagó".
 *
 * Los casos con la forma real de las filas: el comercio tal como quedó guardado y el nombre del
 * alta, que en este caso es una sola palabra.
 */

const respuesta = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

const GASTO_AL_TITULAR = {
  es_movimiento: true, tipo: 'gasto', monto: 220, moneda: 'PEN',
  comercio: 'Rosa Elena Huaman C. — transferencia', categoria: 'Otros', subcategoria: 'sin_categoria',
  banco: 'BCP', metodo_pago: 'Transferencia', fecha: '2026-11-02',
};

// Como los arma el barrido: la cuenta de Google primero, después el nombre del alta.
const TITULARES = ['Rosa Huaman', 'Rosa'];

const ASUNTO_TERCEROS = 'Constancia de Transferencia a Terceros BCP - Servicio de Notificaciones BCP';

describe('el barrido no registra como gasto una transferencia cuyo beneficiario es el titular', () => {
  beforeEach(() => mockCreate.mockReset());

  it('el caso de producción: beneficiario = titular → no se registra', async () => {
    mockCreate.mockResolvedValue(respuesta(GASTO_AL_TITULAR));
    const r = await parsearCorreoBancario('Constancia ... Enviado a: Rosa Elena Huaman C. ... S/ 220.00', ASUNTO_TERCEROS, null, { titulares: TITULARES });
    expect(r.es_movimiento).toBe(false);
    // El barrido decide por `resultado.monto`: sin monto no llama a guardarTransaccion.
    expect(r.monto).toBeUndefined();
  });

  it('una transferencia a OTRA persona sigue entrando como gasto', async () => {
    mockCreate.mockResolvedValue(respuesta({ ...GASTO_AL_TITULAR, comercio: 'Torres Vega Mario A. — transferencia', monto: 1200 }));
    const r = await parsearCorreoBancario('Enviado a: Torres Vega Mario A.', ASUNTO_TERCEROS, null, { titulares: TITULARES });
    expect(r.tipo).toBe('gasto');
    expect(r.monto).toBe(1200);
  });

  it('el ingreso que nombra a OTRA persona como quien envía pasa entero', async () => {
    mockCreate.mockResolvedValue(respuesta({ ...GASTO_AL_TITULAR, tipo: 'ingreso', comercio: 'Torres Vega Mario A.', categoria: 'Finanzas' }));
    const r = await parsearCorreoBancario('...', ASUNTO_TERCEROS, null, { titulares: TITULARES });
    expect(r.tipo).toBe('ingreso');
    expect(r.monto).toBe(220);
  });

  it('un "ingreso" a nombre del propio titular tampoco entra: no dice quién le pagó', async () => {
    // Puede ser plata que movió a su propia cuenta en otro banco. Voltear a ingreso sin ordenante
    // infla los ingresos igual que el gasto inflaba los gastos.
    mockCreate.mockResolvedValue(respuesta({ ...GASTO_AL_TITULAR, tipo: 'ingreso', comercio: 'Rosa Elena Huaman C.', categoria: 'Finanzas' }));
    const r = await parsearCorreoBancario('...', ASUNTO_TERCEROS, null, { titulares: TITULARES });
    expect(r.es_movimiento).toBe(false);
  });

  it('con asunto de constancia decide aunque el modelo no escriba "Transferencia" en metodo_pago', async () => {
    // Un correo descartado se re-parsea cada 15 minutos mientras esté en la ventana: la defensa no
    // puede depender de que el modelo repita el mismo metodo_pago en todas las pasadas.
    mockCreate.mockResolvedValue(respuesta({ ...GASTO_AL_TITULAR, metodo_pago: null }));
    const r = await parsearCorreoBancario('...', 'Constancia de Transferencia a Otros Bancos - Servicio de Notificaciones BCP', null, { titulares: TITULARES });
    expect(r.es_movimiento).toBe(false);
  });

  it('un consumo con tarjeta en un comercio que se llama como el titular no se toca', async () => {
    // El guard mira transferencias. "Rosa Burger" con Débito es un gasto de verdad.
    mockCreate.mockResolvedValue(respuesta({ ...GASTO_AL_TITULAR, comercio: 'Rosa Burger', metodo_pago: 'Debito', monto: 25 }));
    const r = await parsearCorreoBancario('Realizaste un consumo en ROSA BURGER', 'Realizaste un consumo con tu Tarjeta de Débito BCP', null, { titulares: TITULARES });
    expect(r.monto).toBe(25);
  });

  it('sin asunto de constancia, decide por el metodo_pago que devolvió el modelo', async () => {
    mockCreate.mockResolvedValue(respuesta(GASTO_AL_TITULAR));
    const r = await parsearCorreoBancario('...', 'Transferencia realizada', null, { titulares: TITULARES });
    expect(r.es_movimiento).toBe(false);
  });

  it('sin titular el parser se comporta como antes (la ruta admin y cualquier llamador viejo)', async () => {
    mockCreate.mockResolvedValue(respuesta(GASTO_AL_TITULAR));
    const r = await parsearCorreoBancario('...', ASUNTO_TERCEROS, null);
    expect(r.tipo).toBe('gasto');
    expect(r.monto).toBe(220);
  });

  it('el nombre del alta y el del banco se comparan sin tildes ni mayúsculas', async () => {
    mockCreate.mockResolvedValue(respuesta({ ...GASTO_AL_TITULAR, comercio: 'PEREZ ROJAS JOSE L. — transferencia' }));
    const r = await parsearCorreoBancario('...', ASUNTO_TERCEROS, null, { titulares: ['José Pérez'] });
    expect(r.es_movimiento).toBe(false);
  });

  it('el titular NO viaja al modelo: con él en el mensaje, 4o-mini descartaba también gastos a terceros', async () => {
    mockCreate.mockResolvedValue(respuesta({ es_movimiento: false }));
    await parsearCorreoBancario('...', ASUNTO_TERCEROS, null, { titulares: TITULARES });
    const [system, user] = mockCreate.mock.calls[0][0].messages;
    expect(user.content).not.toContain('Rosa Huaman');
    expect(system.content).not.toMatch(/TITULAR del buzón/);
  });
});

describe('Entre mis Cuentas no es gasto ni ingreso', () => {
  beforeEach(() => mockCreate.mockReset());

  it('se descarta por el asunto, sin gastar la llamada al modelo', async () => {
    mockCreate.mockResolvedValue(respuesta(GASTO_AL_TITULAR));
    const r = await parsearCorreoBancario('...', 'Constancia de Transferencia Entre mis Cuentas - Servicio de Notificaciones BCP', null);
    expect(r).toEqual({ es_movimiento: false });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('beneficiarioEsElTitular', () => {
  it('usa la comparación de lib/titular.js: nombre de pila y apellido', () => {
    expect(beneficiarioEsElTitular('Rosa Elena Huaman C. — transferencia', TITULARES)).toBe(true);
    // Apellido distinto: otra Rosa.
    expect(beneficiarioEsElTitular('Rosa Elena Perez C. — transferencia', TITULARES)).toBe(false);
  });

  it('con solo el nombre de pila no decide nada (un homónimo no pierde su gasto)', () => {
    expect(beneficiarioEsElTitular('Rosa Elena Huaman C. — transferencia', ['Rosa'])).toBe(false);
    expect(beneficiarioEsElTitular('Rosa Elena Huaman C.', [])).toBe(false);
  });

  it('solo mira el beneficiario, no el propósito que el prompt le pega detrás', () => {
    expect(beneficiarioEsElTitular('Maria Lopez — pago rosa huaman', TITULARES)).toBe(false);
    // El modelo no siempre usa la raya larga.
    expect(beneficiarioEsElTitular('Maria Lopez - pago rosa huaman', TITULARES)).toBe(false);
    expect(beneficiarioEsElTitular('Maria Lopez – pago rosa huaman', TITULARES)).toBe(false);
  });

  it('no descarta a otra persona por un segundo nombre, una partícula o el primer apellido en común', () => {
    // Los casos de la revisión adversarial: con la regla de lib/titular.js los siete daban true, y
    // acá un true es un gasto real que desaparece sin aviso.
    expect(beneficiarioEsElTitular('Maria Elena Quispe Soto', ['Maria Elena Lopez Garcia'])).toBe(false);
    expect(beneficiarioEsElTitular('Jose Luis Torres Vega', ['Jose Luis Perez'])).toBe(false);
    expect(beneficiarioEsElTitular('Maria del Pilar Soto', ['Maria del Carmen Lopez'])).toBe(false);
    expect(beneficiarioEsElTitular('Rosa Los Rios', ['Rosa de los Santos'])).toBe(false);
    expect(beneficiarioEsElTitular('Rosa Huaman Diaz', ['Rosa Huaman Castro'])).toBe(false);
    expect(beneficiarioEsElTitular('Rosa Huaman D. — mesada', ['Rosa Huaman Castro'])).toBe(false);
    expect(beneficiarioEsElTitular('Ana Maria Gomez', ['Ana Maria Torres'])).toBe(false);
  });

  it('una inicial sola no alcanza: hacen falta dos palabras enteras', () => {
    expect(beneficiarioEsElTitular('Rosa H.', ['Rosa Huaman'])).toBe(false);
  });

  it('el nombre completo de la cuenta de Google contra el abreviado de BCP', () => {
    expect(beneficiarioEsElTitular('Rosa Elena Huaman C. — transferencia', ['Rosa Elena Huaman Castro'])).toBe(true);
    expect(beneficiarioEsElTitular('Huaman Castro Rosa E. — transferencia', ['Rosa Elena Huaman Castro'])).toBe(true);
  });
});
