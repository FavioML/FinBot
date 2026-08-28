import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * `contactarUsuario` — responderle como NETO a alguien que NO abrió un ticket (el feedback y
 * la queja del tab "NLP Errors").
 *
 * Lo que se fija acá es UN invariante, y es el que puede hacer daño de verdad:
 *
 *   **la sesión de soporte sólo se abre si el mensaje SE ENTREGÓ.**
 *
 * Abrir la sesión desvía TODO mensaje siguiente de esa persona al admin en vez de al bot
 * (`handlers/message-processor.js`, el bloque de modo soporte). Si se abriera antes de saber
 * el desenlace del envío, un fallo de la ventana de 24h de Meta —que es el caso COMÚN, no el
 * raro: 452 de 459 fallos de 30 días son 131047— dejaría a alguien en modo soporte **sin
 * haber recibido nada**, con su registro de gastos roto hasta el autocierre de 48h, por una
 * conversación que nunca existió. Y del lado de acá se vería idéntico al caso sano.
 *
 * El orden correcto no se puede verificar mirando el mensaje de retorno (los dos dicen
 * "enviado"): se verifica sobre las ESCRITURAS, que es lo que el copy no puede fingir.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn(), META_ERR_FUERA_VENTANA: 131047 };

/**
 * Doble de supabase: una cola de respuestas y un registro de lo que se escribió.
 * `inserts` y `updates` son las dos únicas aserciones que importan.
 */
const db = { cola: [], inserts: [], updates: [] };

function cadena(tabla) {
  const c = {};
  const siguiente = () => (db.cola.length ? db.cola.shift() : { data: null, error: null });
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'neq', 'is']) c[m] = () => c;
  c.insert = (fila) => { db.inserts.push({ tabla, fila }); return c; };
  c.update = (patch) => { db.updates.push({ tabla, patch }); return c; };
  c.maybeSingle = async () => siguiente();
  c.then = (res, rej) => Promise.resolve(siguiente()).then(res, rej);
  return c;
}

const dbMock = { supabase: { from: (tabla) => cadena(tabla) } };

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/db.js', dbMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { contactarUsuario } = require('../../lib/support-tickets');

const BASE = { usuarioId: 'u1', whatsapp: '51999888777', nombre: 'Ana', mensaje: 'Gracias, lo anotamos.' };

/** Las lecturas/escrituras del camino que SÍ abre conversación, en orden. */
function colaCaminoCompleto() {
  db.cola = [
    { data: [], error: null },                // responderTicket: no hay ticket pendiente de ese número
    { data: [], error: null },                // obtenerSesionAbierta: no hay sesión viva
    { data: { id: 't-nuevo' }, error: null }, // el insert de abrirSesion
    { data: null, error: null },              // el insert del mensaje en el HILO (migración 079)
    { data: null, error: null },              // el update de la columna de último mensaje
  ];
}

beforeEach(() => {
  db.cola = [];
  db.inserts = [];
  db.updates = [];
  waMock.enviarWhatsapp.mockReset();
});

describe('contactarUsuario · la conversación no se abre sobre un mensaje que no llegó', () => {
  it('fuera de la ventana de 24h: NO abre sesión, y dice por qué', async () => {
    waMock.enviarWhatsapp.mockResolvedValue({ ok: false, code: 131047 });
    db.cola = [];

    const r = await contactarUsuario({ ...BASE, abrirConversacion: true });

    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/24h|ventana/i);
    // Lo que decide: ninguna escritura. Un ticket acá deja a la persona en modo soporte
    // sin haber recibido el mensaje.
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('Meta rechaza por otro motivo: tampoco abre sesión', async () => {
    // El control del anterior: si sólo se mirara el 131047, cualquier otro rechazo abriría
    // la conversación igual. `responderTicket` ya distingue los dos mensajes; lo que se fija
    // acá es que las dos ramas de fallo compartan la consecuencia.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: false, code: 470 });

    const r = await contactarUsuario({ ...BASE, abrirConversacion: true });

    expect(r.ok).toBe(false);
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('entregado + abrirConversacion: abre la sesión y deja anotado lo que se mandó', async () => {
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    colaCaminoCompleto();

    const r = await contactarUsuario({ ...BASE, abrirConversacion: true });

    expect(r.ok).toBe(true);
    expect(r.conversacionAbierta).toBe(true);

    const ticket = db.inserts.find((i) => i.tabla === 'tickets_soporte');
    expect(ticket, 'no se abrió la sesión').toBeTruthy();
    expect(ticket.fila).toMatchObject({ usuario_id: 'u1', estado: 'esperando_mensaje' });

    // El HILO (migración 079). Es lo que hace que el panel pueda mostrar la conversación:
    // antes sólo existía la columna de último mensaje, que el turno siguiente pisaba.
    const hilo = db.inserts.find((i) => i.tabla === 'tickets_mensajes');
    expect(hilo, 'el mensaje del admin no quedó en el hilo').toBeTruthy();
    expect(hilo.fila).toMatchObject({ ticket_id: 't-nuevo', rol: 'admin', mensaje: BASE.mensaje });

    // Y la columna, que es el caché que lee el listado. Las dos las escribe el MISMO helper:
    // si divergen es porque alguien agregó un segundo escritor.
    expect(db.updates.some((u) => u.patch.mensaje_admin === BASE.mensaje)).toBe(true);

    // La sesión recién abierta NO se marca respondida: nadie preguntó nada por este canal.
    expect(db.updates.some((u) => u.patch.estado === 'respondido')).toBe(false);
  });

  it('el default NO abre conversación', async () => {
    // Contestar "gracias, ya lo anotamos" no debería secuestrarle el bot a nadie. Sin este
    // control, el default podría invertirse y los tres tests de arriba seguirían en verde.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    db.cola = [{ data: [], error: null }];

    const r = await contactarUsuario(BASE);

    expect(r.ok).toBe(true);
    expect(r.conversacionAbierta).toBe(false);
    expect(db.inserts).toEqual([]);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledOnce();
  });

  it('sin usuarioId manda igual, pero no promete una conversación que no abrió', async () => {
    // `nlp_errors.usuario_id` es nullable. El mensaje se entrega igual —el número está— pero
    // `abrirSesion` necesita el id, así que el retorno tiene que decir que quedó sin abrir en
    // vez de dejar al admin esperando una respuesta que se va a ir al bot.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    db.cola = [{ data: [], error: null }];

    const r = await contactarUsuario({ ...BASE, usuarioId: null, abrirConversacion: true });

    expect(r.ok).toBe(true);
    expect(r.conversacionAbierta).toBe(false);
    expect(r.msg).toMatch(/no pude abrir/i);
    expect(db.inserts).toEqual([]);
  });

  it('el envío se etiqueta y ARRASTRA el usuario: sin eso la fila del ledger no es atribuible', async () => {
    // `registrarEntrega` arranca con `if (!tipo) return`, asi que sin el tipo no hay fila y el
    // callback de status de Meta no matchea nada: el desenlace real no se sabe nunca. Y sin el
    // usuarioId la fila existe pero no se puede cruzar con nadie — que es la mitad de para que
    // sirve. Aca no hay ticket del que sacarlo, asi que tiene que viajar desde el llamador.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    db.cola = [{ data: [], error: null }];

    await contactarUsuario(BASE);

    const opts = waMock.enviarWhatsapp.mock.calls[0][2];
    expect(opts).toMatchObject({ tipo: 'soporte_respuesta', usuarioId: 'u1' });
  });

  it('sin número no intenta nada', async () => {
    const r = await contactarUsuario({ ...BASE, whatsapp: '' });
    expect(r.ok).toBe(false);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });
});
