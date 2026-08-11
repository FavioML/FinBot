import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * M16: las pantallas de CONVERSIÓN contaban el trial como Pro.
 *
 * `plan === 'premium'` es true durante los 14 días de prueba —así los ~40 gates entregan
 * Pro sin tocarse— pero para un panel que existe justamente para mirar cuánta gente PAGA,
 * eso convierte cada prueba en una venta. El panel decía "Premium: 12" con 4 pagos.
 *
 * Este archivo ejercita `/panel` de punta a punta con las tres poblaciones sembradas, que
 * es lo que ningún test hacía: la suite entera pasaba en verde con el comando roto — de
 * hecho una versión de este mismo fix quedó con `enTrial` sin importar y `require` no se
 * queja hasta que alguien escribe el comando.
 */

const filas = [];
const chain = {
  select: vi.fn(() => chain),
  order: vi.fn(() => chain),
  limit: vi.fn(() => Promise.resolve({ data: filas, error: null })),
  eq: vi.fn(() => chain),
  single: vi.fn(() => Promise.resolve({ data: null, error: null })),
};
require('../../lib/db').supabase.from = vi.fn(() => chain);

const { procesarComandoAdmin } = require('../../handlers/admin-commands');

const PAGADO = { whatsapp: '511', nombre: 'Paga', plan: 'premium', trial_estado: 'convertido' };
const EN_PRUEBA = { whatsapp: '512', nombre: 'Prueba', plan: 'premium', trial_estado: 'activo' };
const EN_MURO = { whatsapp: '513', nombre: 'Muro', plan: 'free', trial_estado: 'vencido' };

beforeEach(() => { filas.length = 0; });

describe('M16 — el panel admin no cuenta pruebas como pagos', () => {
  it('separa pagados, en prueba y en el muro', async () => {
    filas.push(PAGADO, EN_PRUEBA, EN_PRUEBA, EN_MURO);
    const msg = await procesarComandoAdmin('/panel');
    expect(msg).toContain('Pro pagado: 1');
    expect(msg).toContain('En prueba: 2');
    expect(msg).toContain('En el muro: 1');
  });

  it('el trial NO lleva la estrella de pagado', async () => {
    filas.push(EN_PRUEBA);
    const msg = await procesarComandoAdmin('/panel');
    expect(msg).toContain('🎁 Prueba');
    expect(msg).not.toContain('⭐ Prueba');
  });

  it('quien paga sí la lleva (control: el ícono no es siempre el mismo)', async () => {
    filas.push(PAGADO);
    const msg = await procesarComandoAdmin('/panel');
    expect(msg).toContain('⭐ Paga');
  });

  // `esProPagado` mira DOS columnas, así que un select que se olvide `trial_estado`
  // devuelve `undefined` y el predicado responde... true. Es la trampa de la fila parcial
  // que este repo ya pagó en `mensajeMuro`: acá se fija que la query la traiga.
  it('la query pide trial_estado (una fila parcial no puede decidir si paga)', async () => {
    filas.push(PAGADO);
    await procesarComandoAdmin('/panel');
    const columnas = chain.select.mock.calls.map((c) => String(c[0] || '')).join(' ');
    expect(columnas).toContain('trial_estado');
  });

  it('los tres estados suman el total (nadie se cuenta dos veces ni se pierde)', async () => {
    filas.push(PAGADO, EN_PRUEBA, EN_MURO, EN_MURO, EN_MURO);
    const msg = await procesarComandoAdmin('/panel');
    const n = (etiqueta) => Number(msg.match(new RegExp(etiqueta + ': (\\d+)'))[1]);
    expect(n('Pro pagado') + n('En prueba') + n('En el muro')).toBe(filas.length);
  });
});
