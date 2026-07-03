import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { esVerUltimoMovimiento } = require('../../lib/nlp-guards');

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
