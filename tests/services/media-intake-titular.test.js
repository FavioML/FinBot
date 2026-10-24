import { describe, it, expect, beforeEach } from 'vitest';
import { promptVision, extraerPagoDeImagen } from '../../services/media-intake.js';
import { destinatarioEsTitular } from '../../lib/titular.js';

/**
 * Caso de producción del 24-oct-2026: un psicólogo recibe el comprobante de Yape que le manda su
 * paciente. La captura sale del celular de quien paga ("¡Yapeaste! S/120 Jaime Car*") y Vision la
 * registraba como gasto. Cuatro cobros quedaron como egresos en su dashboard.
 *
 * Los destinatarios de abajo son los que Vision devolvió de verdad para ese usuario.
 */

describe('destinatarioEsTitular', () => {
  const TITULAR = ['Jaime Carrillo'];

  it.each([
    'Jaime Car*',
    'Jaime Car***',
    'Carrillo Cruz Jaime C.',
    'Jaime Carlos Carrillo C.',
    'JAIME CARRILLO',
  ])('reconoce al titular en "%s"', (d) => {
    expect(destinatarioEsTitular(d, TITULAR)).toBe(true);
  });

  it.each([
    'Angelica Ala*',                                     // otra persona: el gasto real del caso
    'Corporacion De Formacion Continua Del Peru Sac',
    'Jaime Castro',                                      // mismo nombre, otro apellido
    'Jaime',                                             // sin apellido no se puede decidir
    'Carrillo Cruz Ana',                                 // mismo apellido, otro nombre
    'Jaime Ca*',                                         // dos letras de apellido no alcanzan
    '',
    null,
  ])('NO confunde con el titular a "%s"', (d) => {
    expect(destinatarioEsTitular(d, TITULAR)).toBe(false);
  });

  it('sin apellido del titular no voltea nada: un Jaime le paga a otro Jaime', () => {
    expect(destinatarioEsTitular('Jaime Car*', ['Jaime'])).toBe(false);
    expect(destinatarioEsTitular('Jaime Car*', [null, undefined, ''])).toBe(false);
    expect(destinatarioEsTitular('Jaime Car*', undefined)).toBe(false);
  });

  it('alcanza con que UNO de los nombres conocidos tenga apellido', () => {
    expect(destinatarioEsTitular('Jaime Car*', ['Jaime', 'Jaime Carrillo'])).toBe(true);
  });

  it('ignora tildes y mayúsculas', () => {
    expect(destinatarioEsTitular('Jose Nuñ*', ['José Núñez'])).toBe(true);
  });
});

describe('promptVision nombra al titular solo cuando lo conoce', () => {
  it('con titular, el prompt lo nombra y explica el comprobante del pagador', () => {
    const p = promptVision('2026-10-24', 'Jaime Carrillo');
    expect(p).toContain('El usuario de Neto se llama Jaime Carrillo');
    expect(p).toMatch(/INGRESO para el usuario/);
  });

  it('sin titular, no aparece la regla (ni un "null" colado)', () => {
    const p = promptVision('2026-10-24');
    expect(p).not.toContain('El usuario de Neto se llama');
    expect(p).not.toContain('se llama null');
  });
});

describe('extraerPagoDeImagen convierte en ingreso el "¡Yapeaste!" hacia el titular', () => {
  const visionCreate = globalThis.__mockOpenAICreate;
  const responder = (obj) => visionCreate.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(obj) } }]
  });
  const IMG = Buffer.from('x');
  const OPTS = { nombresTitular: ['Jaime Carrillo', 'Jaime'] };

  beforeEach(() => { visionCreate.mockReset(); });

  it('el caso de producción: gasto a "Jaime Car*" sale ingreso', async () => {
    responder({ tipo: 'gasto', monto: 120, moneda: 'PEN', metodo_pago: 'Yape', comercio: 'Jaime Car*', categoria: 'Otros', subcategoria: 'consulta', fecha: '2026-10-20', descripcion_original: '¡Yapeaste! S/120 Jaime Car*' });
    const parsed = await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24', OPTS);
    expect(parsed.tipo).toBe('ingreso');
    expect(parsed.categoria).toBe('Finanzas');
    expect(parsed.subcategoria).toBeNull();
    // Lo demás pasa intacto: esto decide el signo, no reescribe la transacción.
    expect(parsed.monto).toBe(120);
    expect(parsed.comercio).toBe('Jaime Car*');
  });

  it('el prompt que recibe Vision lleva el nombre con apellido', async () => {
    responder({ tipo: 'gasto', monto: 1, comercio: 'X' });
    await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24', { nombresTitular: [null, 'Jaime', 'Jaime Carrillo'] });
    const texto = visionCreate.mock.calls[0][0].messages[0].content[0].text;
    expect(texto).toContain('se llama Jaime Carrillo');
  });

  it('un gasto a otra persona sigue siendo gasto', async () => {
    responder({ tipo: 'gasto', monto: 50, comercio: 'Angelica Ala', categoria: 'Otros', metodo_pago: 'Yape' });
    const parsed = await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24', OPTS);
    expect(parsed.tipo).toBe('gasto');
    expect(parsed.categoria).toBe('Otros');
  });

  it('sin nombres del titular se comporta como antes', async () => {
    responder({ tipo: 'gasto', monto: 120, comercio: 'Jaime Car*', metodo_pago: 'Yape' });
    const parsed = await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24');
    expect(parsed.tipo).toBe('gasto');
  });

  it('Plin también voltea (el formato "Pago exitoso")', async () => {
    responder({ tipo: 'gasto', monto: 400, comercio: 'Jaime Car***', metodo_pago: 'Plin' });
    expect((await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24', OPTS)).tipo).toBe('ingreso');
  });

  it('una transferencia BANCARIA a nombre propio no se voltea: puede ser entre sus cuentas', async () => {
    responder({ tipo: 'gasto', monto: 550, comercio: 'Jaime Carlos Carrillo C.', metodo_pago: 'BCP' });
    expect((await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24', OPTS)).tipo).toBe('gasto');
    responder({ tipo: 'gasto', monto: 550, comercio: 'Jaime Car*', metodo_pago: null });
    expect((await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24', OPTS)).tipo).toBe('gasto');
  });

  it('el pago de la suscripción a Neto nunca se voltea, aunque el usuario se llame igual', async () => {
    responder({ tipo: 'gasto', monto: 10, comercio: 'Favio Men*', metodo_pago: 'Yape' });
    const parsed = await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24', { nombresTitular: ['Favio Mendez'] });
    expect(parsed.tipo).toBe('gasto');
  });

  it('no toca un no_pago ni un ingreso que ya vino bien', async () => {
    responder({ tipo: 'no_pago' });
    expect((await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24', OPTS)).tipo).toBe('no_pago');
    responder({ tipo: 'ingreso', monto: 130, comercio: 'Ada Cortes Montufar', categoria: 'Finanzas' });
    const ing = await extraerPagoDeImagen(IMG, 'image/jpeg', '2026-10-24', OPTS);
    expect(ing.tipo).toBe('ingreso');
    expect(ing.comercio).toBe('Ada Cortes Montufar');
  });
});
