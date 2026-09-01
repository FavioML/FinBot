import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import Module from 'module';

/**
 * ÍTEM 19 · las tres lecturas mudas de `procesarComandoAdmin`.
 *
 * Hermano de `admin-callback-lecturas.test.js`, que cubre el CALLBACK (los botones de Telegram).
 * Los comandos por texto quedaron atrás: `/activar`, `/pago` y `/panel` descartaban el `{ error }`
 * de su lectura de `usuarios`, así que un fallo de infraestructura salía por la misma puerta que
 * "ese número no existe".
 *
 * **Los tres NO son igual de graves, y la diferencia es la que decide el copy.** `/panel` se
 * delata solo: "No hay usuarios registrados" con más de cien en la base es absurdo a la vista.
 * `/activar` y `/pago` no: *"No encontré un usuario con el número X"* es exactamente lo que uno
 * esperaría leer si se equivocó al tipearlo, así que el admin va a corregir el número que estaba
 * bien mientras el alta real sigue ahí. Ése es el modo de fallo que este archivo cierra.
 *
 * **Por qué `maybeSingle` y no un `if (error)` sobre el `single` que había.** Con `single` y cero
 * filas, PostgREST devuelve `PGRST116` **en `error`**: un `if (error)` a secas convertiría "ese
 * número no existe" en "no pude leer", o sea la mentira simétrica. Es el mismo molde y el mismo
 * motivo que `resolverSolicitudPro`, ocho líneas más abajo en el mismo archivo.
 *
 * LO QUE ESTE ARCHIVO TIENE QUE PODER DISTINGUIR, y por eso cada caso viene con su control:
 *   · "no se pudo leer"  vs  "no existe"     → dos mensajes distintos, los dos afirmados;
 *   · que ante la lectura caída NO se ejecute lo irreversible (`activarPro`).
 */

const require = createRequire(import.meta.url);

const state = { filas: {}, lista: [], fallos: {}, llamadas: [] };

function builder(tabla) {
  let verbo = 'select';
  const b = new Proxy({}, {
    get(_t, p) {
      if (p === 'update' || p === 'insert' || p === 'delete' || p === 'upsert') {
        return () => { if (verbo === 'select') verbo = p; return b; };
      }
      if (p === 'single' || p === 'maybeSingle') {
        return async () => {
          state.llamadas.push({ tabla, verbo, forma: p });
          const err = state.fallos[tabla + ':' + verbo];
          if (err) return { data: null, error: { message: err } };
          return { data: state.filas[tabla] || null, error: null };
        };
      }
      // La cadena tiene que ser AWAITABLE sin `single`: `/panel` termina en `.limit(20)` y se
      // espera directo. Un Proxy que devuelve `b` para toda propiedad hace que `await` llame a
      // `b.then(resolve, reject)`, reciba `b` y no resuelva nunca — timeout en vez de
      // diagnóstico. Es la misma trampa que el fake del callback documenta al revés.
      if (p === 'then') {
        return (ok, ko) => {
          state.llamadas.push({ tabla, verbo, forma: 'lista' });
          const err = state.fallos[tabla + ':' + verbo];
          const res = err
            ? { data: null, error: { message: err }, count: null }
            : { data: state.lista, error: null, count: state.lista.length };
          return Promise.resolve(res).then(ok, ko);
        };
      }
      return () => b;
    },
  });
  return b;
}

const fakeDb = { supabase: { from: (t) => builder(t) } };
const pro = {
  activarPro: vi.fn(async () => ({ venceStr: '30/09/2026' })),
  rechazarSolicitudPro: vi.fn(async () => ({ claimLimpio: true })),
  reclamarPagoPendiente: vi.fn(async () => null),
};
const tickets = {
  responderTicket: vi.fn(async () => ({ ok: true })),
  listarTicketsPendientes: vi.fn(async () => []),
  cerrarSesion: vi.fn(async () => ({ ok: true })),
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  const norm = String(id).replace(/\\/g, '/');
  if (norm === '../lib/db' || norm.endsWith('/lib/db')) return fakeDb;
  if (norm === '../lib/pro-payment' || norm.endsWith('/lib/pro-payment')) return pro;
  if (norm === '../lib/support-tickets' || norm.endsWith('/lib/support-tickets')) return tickets;
  return origRequire.apply(this, arguments);
};
const { procesarComandoAdmin } = require('../../handlers/admin-commands');
Module.prototype.require = origRequire;

// `trial_estado: null` + `plan: 'free'`: nunca tuvo prueba, así que `esProPagado` es false y
// `/activar` llega hasta `activarPro` en vez de cortarse en "ya tiene Premium".
const USUARIO = { id: 'u-1', nombre: 'Ana', whatsapp: '51999888777', plan: 'free', trial_estado: null };

beforeEach(() => {
  state.filas = { usuarios: { ...USUARIO } };
  state.lista = [{ ...USUARIO, created_at: '2026-08-01T00:00:00Z' }];
  state.fallos = {};
  state.llamadas = [];
  vi.clearAllMocks();
});

describe('/activar · la lectura caída no se disfraza de "no existe"', () => {
  it('camino feliz: activa Pro', async () => {
    const r = await procesarComandoAdmin('/activar 51999888777');
    expect(pro.activarPro).toHaveBeenCalledOnce();
    expect(r).toMatch(/Premium activado/i);
  });

  it('la lectura falla: lo dice, y NO activa Pro', async () => {
    state.fallos['usuarios:select'] = 'db caída';
    const r = await procesarComandoAdmin('/activar 51999888777');
    expect(r).toMatch(/No pude leer/i);
    // Lo que separa este arreglo de un cambio de copy: con la lectura caída no se toma ninguna
    // decisión sobre la cuenta de nadie.
    expect(pro.activarPro).not.toHaveBeenCalled();
  });

  it('CONTROL: cero filas sigue diciendo "no encontré", no "no pude leer"', async () => {
    // Sin esto, el caso de arriba pasaría igual con un `if (error)` puesto sobre el `single`
    // viejo — que convierte PGRST116 (cero filas) en un fallo de infra y rompe el caso normal.
    state.filas.usuarios = null;
    const r = await procesarComandoAdmin('/activar 51900000000');
    expect(r).toMatch(/No encontre un usuario/i);
    expect(r).not.toMatch(/No pude leer/i);
    expect(pro.activarPro).not.toHaveBeenCalled();
  });

  it('usa maybeSingle, que es lo que hace distinguibles a los dos casos', async () => {
    await procesarComandoAdmin('/activar 51999888777');
    const lectura = state.llamadas.find((c) => c.tabla === 'usuarios' && c.verbo === 'select');
    expect(lectura.forma, 'volvió a `single`: cero filas vuelve a llegar como error').toBe('maybeSingle');
  });
});

describe('/pago · el mismo corte, en el comando que además cobra', () => {
  it('camino feliz: confirma el pago', async () => {
    const r = await procesarComandoAdmin('/pago 51999888777 mensual');
    expect(pro.activarPro).toHaveBeenCalledOnce();
    expect(r).toMatch(/Pago confirmado/i);
  });

  it('la lectura falla: lo dice, y NO activa Pro', async () => {
    state.fallos['usuarios:select'] = 'timeout';
    const r = await procesarComandoAdmin('/pago 51999888777 mensual');
    expect(r).toMatch(/No pude leer/i);
    expect(pro.activarPro).not.toHaveBeenCalled();
  });

  it('CONTROL: cero filas sigue diciendo "no encontré"', async () => {
    state.filas.usuarios = null;
    const r = await procesarComandoAdmin('/pago 51900000000 mensual');
    expect(r).toMatch(/No encontr/i);
    expect(r).not.toMatch(/No pude leer/i);
  });
});

describe('/panel · el que se delata solo, y aun así mentía', () => {
  it('camino feliz: lista usuarios', async () => {
    const r = await procesarComandoAdmin('/panel');
    expect(r).toMatch(/Panel NETO/i);
  });

  it('la lectura falla: lo dice, en vez de "no hay usuarios registrados"', async () => {
    state.fallos['usuarios:select'] = 'db caída';
    const r = await procesarComandoAdmin('/panel');
    expect(r).toMatch(/No pude leer el panel/i);
    // La frase concreta que este ítem vino a matar: absurda a la vista con 128 usuarios en la
    // base, pero absurda sólo si uno se acuerda de cuántos hay.
    expect(r).not.toMatch(/No hay usuarios registrados/i);
  });

  it('CONTROL: cero filas de verdad sigue diciendo "no hay usuarios registrados"', async () => {
    state.lista = [];
    const r = await procesarComandoAdmin('/panel');
    expect(r).toMatch(/No hay usuarios registrados/i);
  });
});
