import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import Module from 'module';

/**
 * B7 — `/activar <numero>` (el comp por WhatsApp) cortaba con `plan === 'premium'`.
 *
 * Durante el trial esa columna vale 'premium' (es lo que hace que los ~40 gates entreguen
 * Pro sin tocarse), así que el comando respondía "ya tiene Premium activo" y NO activaba
 * nada a todo el que estuviera probando — justo la población a la que uno le regala un mes
 * para cerrar la venta. El endpoint hermano `POST /admin/activar` nunca tuvo ese chequeo y
 * sí podía, así que los dos canales del mismo comp se comportaban distinto.
 *
 * La pregunta correcta es "¿PAGA?" (`esProPagado`), no "¿tiene Pro ahora?" (`plan`).
 *
 * Mismo patrón de carga que admin-callback.test.js: vitest no intercepta el `require` CJS
 * transitivo, así que se sustituye por Module.prototype.require durante la carga del módulo.
 */

const require = createRequire(import.meta.url);

const state = { usuario: null };
const activarProSpy = vi.fn(async () => ({ venceStr: '2026-09-17', mensaje: 'ok' }));

function makeBuilder() {
  const b = new Proxy({}, {
    get(_t, p) {
      if (p === 'single') return async () => ({ data: state.usuario });
      if (p === 'maybeSingle') return async () => ({ data: state.usuario });
      if (p === 'then') return undefined;
      return () => b;
    },
  });
  return b;
}
const fakeDb = { supabase: { from: () => makeBuilder() } };
const fakeProPayment = {
  activarPro: activarProSpy,
  rechazarSolicitudPro: vi.fn(),
  reclamarPagoPendiente: vi.fn(),
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  const norm = String(id).replace(/\\/g, '/');
  if (norm === '../lib/db' || norm.endsWith('/lib/db')) return fakeDb;
  if (norm === '../lib/pro-payment' || norm.endsWith('/lib/pro-payment')) return fakeProPayment;
  return origRequire.apply(this, arguments);
};
const { procesarComandoAdmin } = require('../../handlers/admin-commands');
Module.prototype.require = origRequire;

const BASE = { id: 'u-1', whatsapp: '51999888777', nombre: 'Ana' };

beforeEach(() => {
  state.usuario = null;
  activarProSpy.mockClear();
});

describe('/activar — el comp tiene que poder alcanzar al que está en prueba', () => {
  // El caso del hallazgo.
  it('activa el comp a un usuario EN TRIAL (plan premium, trial activo)', async () => {
    state.usuario = { ...BASE, plan: 'premium', trial_estado: 'activo', trial_vence: '2026-08-17' };

    const r = await procesarComandoAdmin('/activar 51999888777');

    expect(activarProSpy).toHaveBeenCalledTimes(1);
    expect(r).toMatch(/Premium activado/);
  });

  it('activa el comp a alguien cuyo trial ya venció (está en el muro)', async () => {
    state.usuario = { ...BASE, plan: 'free', trial_estado: 'vencido' };

    await procesarComandoAdmin('/activar 51999888777');

    expect(activarProSpy).toHaveBeenCalledTimes(1);
  });

  it('activa el comp a un usuario nuevo, sin trial todavía', async () => {
    state.usuario = { ...BASE, plan: 'free', trial_estado: null };

    await procesarComandoAdmin('/activar 51999888777');

    expect(activarProSpy).toHaveBeenCalledTimes(1);
  });

  // La otra mitad: el corte tiene que seguir existiendo para quien SÍ paga, o el comando
  // se convierte en una forma de apilarle meses gratis a un cliente por error de tipeo.
  it('rechaza a un Pro PAGADO (trial convertido)', async () => {
    state.usuario = { ...BASE, plan: 'premium', trial_estado: 'convertido' };

    const r = await procesarComandoAdmin('/activar 51999888777');

    expect(activarProSpy).not.toHaveBeenCalled();
    expect(r).toMatch(/ya tiene Premium/i);
  });

  it('rechaza a un Pro pagado histórico (trial_estado null, plan premium)', async () => {
    state.usuario = { ...BASE, plan: 'premium', trial_estado: null };

    const r = await procesarComandoAdmin('/activar 51999888777');

    expect(activarProSpy).not.toHaveBeenCalled();
    expect(r).toMatch(/ya tiene Premium/i);
  });

  it('sigue avisando cuando el número no existe', async () => {
    state.usuario = null;

    const r = await procesarComandoAdmin('/activar 51900000000');

    expect(activarProSpy).not.toHaveBeenCalled();
    expect(r).toMatch(/No encontre un usuario/i);
  });

  // El comp NO puede premiar al referrer ni registrar caja: es la razón por la que existe
  // el flag, y un cambio en este bloque es justo donde se perdería.
  it('el comp sigue siendo comp: esConversionPagada false y sin link de Gmail', async () => {
    state.usuario = { ...BASE, plan: 'premium', trial_estado: 'activo', trial_vence: '2026-08-17' };

    await procesarComandoAdmin('/activar 51999888777');

    const args = activarProSpy.mock.calls[0][0];
    expect(args.esConversionPagada).toBe(false);
    expect(args.enviarLinkGmail).toBe(false);
    expect(args.tipoPlan).toBe('mensual');
  });
});
