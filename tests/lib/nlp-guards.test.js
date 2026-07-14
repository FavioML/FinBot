import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { esVerUltimoMovimiento, esRegistroGastoNuevo } = require('../../lib/nlp-guards');

describe('esVerUltimoMovimiento (guard caso Edgar)', () => {
  it('detecta pedidos de ver el último movimiento (incluso con tilde)', () => {
    expect(esVerUltimoMovimiento('El último movimiento')).toBe(true);
    expect(esVerUltimoMovimiento('Imbécil, te estoy diciendo el último movimiento. ¿No sabes lo que es último?')).toBe(true);
    expect(esVerUltimoMovimiento('muestrame mi ultimo gasto')).toBe(true);
    expect(esVerUltimoMovimiento('cuál fue lo último que registré')).toBe(true);
    expect(esVerUltimoMovimiento('muéstrame la última transacción')).toBe(true);
  });

  it('NO redirige cuando hay verbo de borrado explícito (todas las conjugaciones)', () => {
    expect(esVerUltimoMovimiento('elimina el último gasto')).toBe(false);
    expect(esVerUltimoMovimiento('eliminar el último movimiento')).toBe(false);
    expect(esVerUltimoMovimiento('deshacer el último movimiento')).toBe(false);
    expect(esVerUltimoMovimiento('borra mi último gasto')).toBe(false);
    expect(esVerUltimoMovimiento('saca el último gasto')).toBe(false);
    expect(esVerUltimoMovimiento('quita la última transacción')).toBe(false);
  });

  it('NO se activa con mensajes que no piden ver el último movimiento', () => {
    expect(esVerUltimoMovimiento('gasté 20 en taxi')).toBe(false);
    expect(esVerUltimoMovimiento('cuánto gasté este mes')).toBe(false);
    expect(esVerUltimoMovimiento('')).toBe(false);
    expect(esVerUltimoMovimiento(null)).toBe(false);
  });
});

describe('esRegistroGastoNuevo (guard anti-secuestro de consultas pendientes)', () => {
  it('detecta registros de gasto nuevo (verbo + monto), incluidos fraseos hablados', () => {
    expect(esRegistroGastoNuevo('Hola, registro por favor un gasto de diez soles en taxi')).toBe(true);
    expect(esRegistroGastoNuevo('gasté 15 en el cine')).toBe(true);
    expect(esRegistroGastoNuevo('anota 20 soles de farmacia')).toBe(true);
    expect(esRegistroGastoNuevo('registra un pago de 8 soles en desayuno')).toBe(true);
    expect(esRegistroGastoNuevo('pagué cincuenta lucas en el super')).toBe(true);
    expect(esRegistroGastoNuevo('apunta cuarenta soles de gasolina')).toBe(true);
  });

  it('NO se activa con respuestas de categorización de un pendiente (deben ir al intercept)', () => {
    expect(esRegistroGastoNuevo('el 1 fue almuerzo')).toBe(false);
    expect(esRegistroGastoNuevo('es transporte')).toBe(false);
    expect(esRegistroGastoNuevo('el de 100 fue taxi')).toBe(false);
    expect(esRegistroGastoNuevo('el 3 es comida')).toBe(false);
  });

  it('NO se activa sin monto ni con vacío/null', () => {
    expect(esRegistroGastoNuevo('gasté mucho hoy')).toBe(false);
    expect(esRegistroGastoNuevo('')).toBe(false);
    expect(esRegistroGastoNuevo(null)).toBe(false);
  });
});
