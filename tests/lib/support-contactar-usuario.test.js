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
 * haber recibido nada**, con su asistente desviado al panel por una conversación que nunca
 * existió. Y del lado de acá se vería idéntico al caso sano.
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

// El chokepoint de avisos, mockeado a propósito: la campana escribe por el mismo cliente de
// Supabase, así que sin esto consume entradas de la cola y desalinea toda la secuencia. Y de
// paso queda ASERTABLE, que es lo que importa.
const notifMock = { notificarUsuario: vi.fn().mockResolvedValue({ inApp: { ok: true } }), CANALES: { AMBOS: 'ambos', SOLO_WHATSAPP: 'solo_whatsapp', SOLO_IN_APP: 'solo_in_app' } };

/**
 * Doble de supabase: respuestas POR TABLA y un registro de lo que se escribió.
 *
 * Era una cola global y se rompió al entrar `estadoVentana`, que lee `usuarios` y
 * `conversaciones` en un `Promise.all`: con una cola única el resultado depende de en qué
 * orden resuelven dos promesas concurrentes, o sea que el fixture pasa a ser una carrera. Por
 * tabla no hay orden que adivinar y además se lee qué está simulando cada entrada.
 */
const db = { porTabla: {}, inserts: [], updates: [] };

function cadena(tabla) {
  const c = {};
  const siguiente = () => {
    const q = db.porTabla[tabla];
    return q && q.length ? q.shift() : { data: null, error: null };
  };
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
  ['lib/notify-user.js', notifMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { contactarUsuario } = require('../../lib/support-tickets');

const BASE = { usuarioId: 'u1', whatsapp: '51999888777', nombre: 'Ana', mensaje: 'Gracias, lo anotamos.' };

/** El camino completo de una respuesta que se entrega. Por tabla, en orden de uso. */
function colaCaminoCompleto({ ultimoMensajeHaceHoras = 1 } = {}) {
  db.porTabla = {
    tickets_soporte: [
      { data: [], error: null },                // responderTicket: no hay ticket pendiente del número
      { data: [], error: null },                // obtenerSesionAbierta: no hay sesión viva
      { data: { id: 't-nuevo' }, error: null }, // el insert de abrirSesion
      { data: null, error: null },              // el update de la columna de último mensaje
    ],
    usuarios: [{ data: { email: 'ana@ejemplo.pe' }, error: null }],
    conversaciones: [{
      data: [{ created_at: new Date(Date.now() - ultimoMensajeHaceHoras * 3600 * 1000).toISOString() }],
      error: null,
    }],
    tickets_mensajes: [{ data: null, error: null }],  // el insert del turno en el HILO
  };
}

beforeEach(() => {
  db.porTabla = {};
  db.inserts = [];
  db.updates = [];
  waMock.enviarWhatsapp.mockReset();
  notifMock.notificarUsuario.mockClear();
});

describe('contactarUsuario · la conversación no se abre sobre un mensaje que no llegó', () => {
  it('fuera de la ventana de 24h: NO abre sesión, y dice por qué', async () => {
    waMock.enviarWhatsapp.mockResolvedValue({ ok: false, code: 131047 });
    db.porTabla = {};

    const r = await contactarUsuario(BASE);

    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/24h|ventana/i);
    // Lo que decide: ninguna escritura. Un ticket acá deja a la persona en modo soporte
    // sin haber recibido el mensaje.
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
    // Ni campana: avisar "te respondimos" sobre un mensaje que no salió es peor que callarse.
    expect(notifMock.notificarUsuario).not.toHaveBeenCalled();
  });

  it('Meta rechaza por otro motivo: tampoco abre sesión', async () => {
    // El control del anterior: si sólo se mirara el 131047, cualquier otro rechazo abriría
    // la conversación igual. `responderTicket` ya distingue los dos mensajes; lo que se fija
    // acá es que las dos ramas de fallo compartan la consecuencia.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: false, code: 470 });

    const r = await contactarUsuario(BASE);

    expect(r.ok).toBe(false);
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('entregado: registra la conversación y deja anotado lo que se mandó', async () => {
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    colaCaminoCompleto();

    const r = await contactarUsuario(BASE);

    expect(r.ok).toBe(true);
    expect(r.conversacionAbierta).toBe(true);

    const ticket = db.inserts.find((i) => i.tabla === 'tickets_soporte');
    expect(ticket, 'no se abrió la sesión').toBeTruthy();
    expect(ticket.fila).toMatchObject({ usuario_id: 'u1', estado: 'esperando_mensaje' });

    // El HILO (migración 079). Es lo que hace que el panel pueda mostrar la conversación:
    // antes sólo existía la columna de último mensaje, que el turno siguiente pisaba.
    const hilo = db.inserts.find((i) => i.tabla === 'tickets_mensajes');
    expect(hilo, 'el mensaje del admin no quedó en el hilo').toBeTruthy();
    expect(hilo.fila).toMatchObject({ ticket_id: 't-nuevo', rol: 'admin', mensaje: BASE.mensaje, wamid: 'wamid.1' });

    // Y la columna, que es el caché que lee el listado. Las dos las escribe el MISMO helper:
    // si divergen es porque alguien agregó un segundo escritor.
    expect(db.updates.some((u) => u.patch.mensaje_admin === BASE.mensaje)).toBe(true);

    // `respondido` y no `esperando_mensaje`: el que habló fue el admin. Es un estado ACTIVO, o
    // sea que la ventana de escucha queda abierta y lo que la persona conteste vuelve al panel.
    expect(db.updates.some((u) => u.patch.estado === 'respondido')).toBe(true);

    // Y la campana. Es el único canal que no depende de la ventana de 24h de Meta, así que es
    // lo que hace que el aviso llegue también al usuario web-first.
    expect(notifMock.notificarUsuario).toHaveBeenCalledOnce();
    const aviso = notifMock.notificarUsuario.mock.calls[0][0];
    expect(aviso.canales).toBe('solo_in_app');
    expect(aviso.usuarioId).toBe('u1');
    // Canal único exige motivo declarado: es la regla del chokepoint, no un adorno.
    expect(String(aviso.motivo || {})).not.toBe('');
    // Ventana ABIERTA (escribió hace 1h): nada de correo. Mandarlo en paralelo sería
    // duplicarle el mensaje a todo el mundo por un caso que casi nunca ocurre.
    expect(aviso.email.to).toBe(null);
  });

  it('si la ventana de Meta parece cerrada, el correo SÍ sale', async () => {
    // El 131047 llega por CALLBACK, no en la respuesta del POST (452 de 459 fallos de 30
    // días), así que un fallback colgado del resultado del envío no se dispararía nunca. Se
    // predice al enviar: cuando la predicción se equivoca el precio es un correo de más.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    colaCaminoCompleto({ ultimoMensajeHaceHoras: 30 });

    await contactarUsuario(BASE);

    const aviso = notifMock.notificarUsuario.mock.calls[0][0];
    expect(aviso.email).toMatchObject({ to: 'ana@ejemplo.pe' });
    expect(String(aviso.email.asunto || '').length).toBeGreaterThan(0);
  });

  it('quien se dio de baja NO recibe el correo, aunque la ventana este cerrada', async () => {
    // El pie de cada email promete por escrito que darse de baja apaga TODOS los canales.
    // Mandarle igual una respuesta de soporte nos convierte en mentirosos sobre lo unico que le
    // prometimos por escrito. No queda sin respuesta: el WhatsApp se intenta igual y la campana
    // sale siempre — lo que se pierde es el canal de repuesto, que es lo que pidio.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    colaCaminoCompleto({ ultimoMensajeHaceHoras: 30 });
    db.porTabla.usuarios = [{ data: { email: 'ana@ejemplo.pe', recordatorios_activos: false }, error: null }];

    await contactarUsuario(BASE);

    const aviso = notifMock.notificarUsuario.mock.calls[0][0];
    expect(aviso.email.to).toBe(null);
    // La campana SI sale: no es un recordatorio, es la respuesta a algo que preguntó.
    expect(aviso.canales).toBe('solo_in_app');
  });

  it('sin correo en la fila no se inventa un destinatario', async () => {
    // El control del anterior: la rama del correo depende de DOS cosas, y sin esto un
    // `to: undefined` pasaría como "salió el correo".
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    colaCaminoCompleto({ ultimoMensajeHaceHoras: 30 });
    db.porTabla.usuarios = [{ data: { email: null }, error: null }];

    await contactarUsuario(BASE);

    expect(notifMock.notificarUsuario.mock.calls[0][0].email.to).toBe(null);
  });

  it('NO hay camino que envíe sin registrar: el ticket es el registro, no una opción', async () => {
    // Este test estaba invertido hasta el 28-ago-2026 y afirmaba que el default NO abría
    // conversación. La garantía que buscaba —no secuestrarle el bot a nadie— la da ahora la
    // ventana corta y deslizante (SESSION_IDLE_MS), no el hecho de no registrar nada.
    //
    // Lo que costaba el diseño viejo, medido en producción con la primera respuesta real: el
    // mensaje llegó (`delivered_at` puesto) y de su texto no quedó rastro en ninguna tabla.
    // Sin ticket no hay dónde colgarlo, y si la persona contestaba se lo comía el bot.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    colaCaminoCompleto();

    const r = await contactarUsuario(BASE);

    expect(r.ok).toBe(true);
    expect(r.conversacionAbierta).toBe(true);
    expect(db.inserts.some((i) => i.tabla === 'tickets_soporte')).toBe(true);
    expect(db.inserts.some((i) => i.tabla === 'tickets_mensajes')).toBe(true);
  });

  it('sin usuarioId manda igual, pero no promete una conversación que no abrió', async () => {
    // `nlp_errors.usuario_id` es nullable. El mensaje se entrega igual —el número está— pero
    // `abrirSesion` necesita el id, así que el retorno tiene que decir que quedó sin abrir en
    // vez de dejar al admin esperando una respuesta que se va a ir al bot.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    db.porTabla = { tickets_soporte: [{ data: [], error: null }] };

    const r = await contactarUsuario({ ...BASE, usuarioId: null });

    expect(r.ok).toBe(true);
    expect(r.conversacionAbierta).toBe(false);
    expect(r.msg).toMatch(/no quedó registrada/i);
    expect(db.inserts).toEqual([]);
  });

  it('el envío se etiqueta y ARRASTRA el usuario: sin eso la fila del ledger no es atribuible', async () => {
    // `registrarEntrega` arranca con `if (!tipo) return`, asi que sin el tipo no hay fila y el
    // callback de status de Meta no matchea nada: el desenlace real no se sabe nunca. Y sin el
    // usuarioId la fila existe pero no se puede cruzar con nadie — que es la mitad de para que
    // sirve. Aca no hay ticket del que sacarlo, asi que tiene que viajar desde el llamador.
    waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
    colaCaminoCompleto();

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
