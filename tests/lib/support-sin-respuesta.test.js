import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * Un ticket que nadie contestó NO se cierra porque la persona escribió /salir (25-nov-2026).
 *
 * `cerrarSesion` ponía `estado = 'cerrado'` viniera de donde viniera, y `/tickets`, la cola y
 * el panel leen sólo los estados abiertos. El bot le dice a la persona "Escribe /salir cuando
 * quieras volver al asistente", así que el camino normal de un ticket era desaparecer sin
 * respuesta: el pagador 0050aef0 escribió su problema el 30-oct y mandó /salir 13 segundos
 * después; e6a8c313 lo mismo el 06-nov. Ninguno de los dos recibió nada.
 *
 * Son dos preguntas que vivían en una sola columna: ¿esta persona sigue en modo soporte? (el
 * ruteo) y ¿alguien le contestó? (la cola). Ahora `sin_respuesta` es la segunda sin la primera:
 * fuera de `SESSION_ACTIVE_STATES` (sus mensajes vuelven al bot) y dentro de toda cola.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn(), META_ERR_FUERA_VENTANA: 131047 };
const notifyMock = {
  notificarUsuario: vi.fn(async () => ({ ok: true })),
  CANALES: { AMBOS: 'ambos', SOLO_WHATSAPP: 'solo_whatsapp', SOLO_IN_APP: 'solo_in_app' },
};

/**
 * Doble de supabase que REGISTRA los filtros, no sólo las respuestas: lo que se afirma acá es
 * qué estados lee cada camino y a qué estado escribe cada id.
 */
const db = { resp: {}, consultas: [], updates: [], inserts: [] };

function cadena(tabla) {
  const q = { tabla, op: 'select', filtros: [] };
  db.consultas.push(q);
  let update = null;
  const c = {};
  const resultado = () => {
    const v = db.resp[tabla + ':' + q.op];
    if (Array.isArray(v)) return v.length ? v.shift() : { data: null, error: null };
    return v || { data: null, error: null };
  };
  c.select = () => c;
  for (const m of ['eq', 'lt', 'order', 'limit']) c[m] = (...a) => {
    q.filtros.push([m, ...a]);
    if (update && m === 'eq' && a[0] === 'id') update.ids = [a[1]];
    return c;
  };
  c.in = (col, vals) => {
    q.filtros.push(['in', col, vals]);
    if (update && col === 'id') update.ids = vals;
    return c;
  };
  c.update = (patch) => { q.op = 'update'; update = { tabla, patch, ids: null }; db.updates.push(update); return c; };
  c.insert = (fila) => { q.op = 'insert'; db.inserts.push({ tabla, fila }); return c; };
  c.maybeSingle = async () => resultado();
  c.then = (res, rej) => Promise.resolve(resultado()).then(res, rej);
  return c;
}

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/notify-user.js', notifyMock],
  ['lib/db.js', { supabase: { from: (t) => cadena(t) } }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const {
  cerrarSesion, listarTicketsPendientes, responderTicket, resumenTicketsSinRespuesta, abrirSesion,
  SESSION_ACTIVE_STATES, ESTADO_SIN_RESPUESTA,
} = require('../../lib/support-tickets');

const CAIDA = { data: null, error: { message: 'connection terminated unexpectedly' } };
const OK = { data: null, error: null };

const estadosLeidos = (tabla = 'tickets_soporte') => {
  const q = db.consultas.find((c) => c.tabla === tabla && c.op === 'select');
  const f = q && q.filtros.find((x) => x[0] === 'in' && x[1] === 'estado');
  return f ? f[2] : null;
};
const estadoEscrito = (id) => {
  const u = db.updates.find((x) => x.tabla === 'tickets_soporte' && (x.ids || []).includes(id));
  return u ? u.patch.estado : undefined;
};

beforeEach(() => {
  db.resp = {};
  db.consultas = [];
  db.updates = [];
  db.inserts = [];
  notifyMock.notificarUsuario.mockClear();
  for (const f of Object.values(logMock)) f.mockReset();
  waMock.enviarWhatsapp.mockReset();
  waMock.enviarWhatsapp.mockResolvedValue({ ok: true, msgId: 'wamid.1' });
});

describe('el estado nuevo', () => {
  it('sin_respuesta NO es una sesión activa: los mensajes de esa persona vuelven al bot', () => {
    expect(ESTADO_SIN_RESPUESTA).toBe('sin_respuesta');
    expect(SESSION_ACTIVE_STATES).not.toContain(ESTADO_SIN_RESPUESTA);
  });
});

describe('cerrarSesion por la persona (/salir) o por inactividad', () => {
  it('un ticket PENDIENTE (habló la persona, nadie contestó) pasa a sin_respuesta, no a cerrado', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999', estado: 'pendiente' }], error: null };
    db.resp['tickets_soporte:update'] = OK;

    const r = await cerrarSesion({ usuarioId: 'u1' });

    expect(estadoEscrito('t1')).toBe('sin_respuesta');
    expect(r.ok).toBe(true);
    expect(r.closed).toBe(1);
    expect(r.sinRespuesta).toBe(1);
  });

  it('CONTROL: respondido y esperando_mensaje siguen cerrándose (no hay nada que contestar)', async () => {
    db.resp['tickets_soporte:select'] = {
      data: [
        { id: 't-resp', whatsapp: '51999', estado: 'respondido' },
        { id: 't-esp', whatsapp: '51999', estado: 'esperando_mensaje' },
      ],
      error: null,
    };
    db.resp['tickets_soporte:update'] = OK;

    const r = await cerrarSesion({ usuarioId: 'u1' });

    expect(estadoEscrito('t-resp')).toBe('cerrado');
    expect(estadoEscrito('t-esp')).toBe('cerrado');
    expect(r.sinRespuesta).toBe(0);
  });

  it('no relee los sin_respuesta: un /salir sobre uno de ellos lo cerraría y lo perdería', async () => {
    db.resp['tickets_soporte:select'] = { data: [], error: null };
    await cerrarSesion({ usuarioId: 'u1' });
    expect(estadosLeidos()).not.toContain('sin_respuesta');
  });

  it('el autocierre de un pendiente también lo deja en la cola, y el aviso no le dice que se perdió', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999', estado: 'pendiente' }], error: null };
    db.resp['tickets_soporte:update'] = OK;

    await cerrarSesion({ usuarioId: 'u1', avisarUsuario: true, porInactividad: true });

    expect(estadoEscrito('t1')).toBe('sin_respuesta');
    expect(waMock.enviarWhatsapp).toHaveBeenCalledOnce();
    expect(String(waMock.enviarWhatsapp.mock.calls[0][1])).toMatch(/equipo ya tiene tu mensaje/i);
  });

  it('CONTROL: el autocierre de una conversación respondida usa el aviso de siempre', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999', estado: 'respondido' }], error: null };
    db.resp['tickets_soporte:update'] = OK;

    await cerrarSesion({ usuarioId: 'u1', avisarUsuario: true, porInactividad: true });

    expect(String(waMock.enviarWhatsapp.mock.calls[0][1])).not.toMatch(/equipo ya tiene tu mensaje/i);
  });

  it('si UNO de los dos UPDATE se cae, el cierre entero se reporta como fallido', async () => {
    db.resp['tickets_soporte:select'] = {
      data: [
        { id: 't-pend', whatsapp: '51999', estado: 'pendiente' },
        { id: 't-resp', whatsapp: '51999', estado: 'respondido' },
      ],
      error: null,
    };
    db.resp['tickets_soporte:update'] = [OK, CAIDA];

    const r = await cerrarSesion({ whatsapp: '51999', avisarUsuario: true });

    expect(r.ok).toBe(false);
    expect(r.closed).toBe(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });
});

describe('cerrarSesion: lo que encontró la revisión adversarial', () => {
  it('el UPDATE de sin_respuesta se cae y el de cerrado entra → igual se reporta fallido', async () => {
    // El orden inverso al de arriba. Con `errCierre = error` en vez de conservar el primero, el
    // error se perdía y el /salir decía "✅ Saliste" con la fila pendiente todavía activa.
    db.resp['tickets_soporte:select'] = {
      data: [
        { id: 't-pend', whatsapp: '51999', estado: 'pendiente' },
        { id: 't-resp', whatsapp: '51999', estado: 'respondido' },
      ],
      error: null,
    };
    db.resp['tickets_soporte:update'] = [CAIDA, OK];

    const r = await cerrarSesion({ usuarioId: 'u1' });

    expect(r.ok).toBe(false);
    expect(r.closed).toBe(0);
  });

  it('un pendiente que YA tuvo respuesta del equipo (la persona dijo "gracias") se cierra, no va al aviso diario', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999', estado: 'pendiente', mensaje_admin: 'Ya lo arreglamos' }], error: null };
    db.resp['tickets_soporte:update'] = OK;

    const r = await cerrarSesion({ usuarioId: 'u1' });

    expect(estadoEscrito('t1')).toBe('cerrado');
    expect(r.sinRespuesta).toBe(0);
  });

  it('sin_respuesta conserva updated_at (la hora del último mensaje); cerrado lo mueve', async () => {
    // El autocierre es lazy: puede correr semanas después del último mensaje, y pisar
    // updated_at hacía que una pregunta de 9 días saliera "hace 0 h" y quedara fuera del aviso.
    db.resp['tickets_soporte:select'] = {
      data: [
        { id: 't-pend', whatsapp: '51999', estado: 'pendiente' },
        { id: 't-resp', whatsapp: '51999', estado: 'respondido' },
      ],
      error: null,
    };
    db.resp['tickets_soporte:update'] = OK;

    await cerrarSesion({ usuarioId: 'u1' });

    const uPend = db.updates.find((u) => (u.ids || []).includes('t-pend'));
    const uResp = db.updates.find((u) => (u.ids || []).includes('t-resp'));
    expect(uPend.patch).not.toHaveProperty('updated_at');
    expect(uResp.patch).toHaveProperty('updated_at');
  });
});

describe('abrirSesion retoma un sin_respuesta en vez de crear otro ticket', () => {
  it('/soporte con una pregunta sin contestar la reabre como pendiente y no inserta', async () => {
    db.resp['tickets_soporte:select'] = [
      { data: [], error: null }, // no hay sesión activa
      { data: [{ id: 't-viejo', estado: 'sin_respuesta', whatsapp: '51999' }], error: null },
    ];
    db.resp['tickets_soporte:update'] = OK;

    const r = await abrirSesion({ usuarioId: 'u1', whatsapp: '51999' });

    expect(r.ticket && r.ticket.id).toBe('t-viejo');
    expect(r.yaAbierta).toBe(false);
    expect(estadoEscrito('t-viejo')).toBe('pendiente');
    expect(db.inserts.filter((i) => i.tabla === 'tickets_soporte')).toHaveLength(0);
  });

  it('CONTROL: sin un sin_respuesta previo, crea el ticket como siempre', async () => {
    db.resp['tickets_soporte:select'] = [{ data: [], error: null }, { data: [], error: null }];
    db.resp['tickets_soporte:insert'] = { data: { id: 't-nuevo' }, error: null };

    const r = await abrirSesion({ usuarioId: 'u1', whatsapp: '51999' });

    expect(r.ticket && r.ticket.id).toBe('t-nuevo');
    expect(db.inserts.filter((i) => i.tabla === 'tickets_soporte')).toHaveLength(1);
  });

  it('si la búsqueda del viejo se cae, igual abre una conversación (un ticket de más antes que nada)', async () => {
    db.resp['tickets_soporte:select'] = [{ data: [], error: null }, CAIDA];
    db.resp['tickets_soporte:insert'] = { data: { id: 't-nuevo' }, error: null };

    const r = await abrirSesion({ usuarioId: 'u1', whatsapp: '51999' });

    expect(r.ticket && r.ticket.id).toBe('t-nuevo');
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('cerrarSesion por el admin (/cerrar)', () => {
  it('el admin decide: un pendiente que él cierra queda cerrado', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999', estado: 'pendiente' }], error: null };
    db.resp['tickets_soporte:update'] = OK;

    const r = await cerrarSesion({ whatsapp: '51999', cierraAdmin: true });

    expect(estadoEscrito('t1')).toBe('cerrado');
    expect(r.sinRespuesta).toBe(0);
  });

  it('y puede descartar un sin_respuesta: sin esto, /cerrar no lo encontraba y el aviso diario no se apagaba nunca', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999', estado: 'sin_respuesta' }], error: null };
    db.resp['tickets_soporte:update'] = OK;

    await cerrarSesion({ whatsapp: '51999', cierraAdmin: true });

    expect(estadosLeidos()).toContain('sin_respuesta');
    expect(estadoEscrito('t1')).toBe('cerrado');
  });

  it('descartar un sin_respuesta NO le manda a la persona "el equipo cerró tu conversación"', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999', estado: 'sin_respuesta' }], error: null };
    db.resp['tickets_soporte:update'] = OK;

    const r = await cerrarSesion({ whatsapp: '51999', avisarUsuario: true, cierraAdmin: true });

    expect(r.ok).toBe(true);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('CONTROL: cerrar una sesión viva sí le avisa', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', whatsapp: '51999', estado: 'pendiente' }], error: null };
    db.resp['tickets_soporte:update'] = OK;

    await cerrarSesion({ whatsapp: '51999', avisarUsuario: true, cierraAdmin: true });

    expect(waMock.enviarWhatsapp).toHaveBeenCalledOnce();
  });

  it('el /cerrar de admin-commands declara que lo cierra el admin', () => {
    const fs = require('node:fs');
    // Sin comentarios: `/* cierraAdmin: true */` dejaba este test verde con el flag apagado.
    const src = fs.readFileSync(path.join(projectRoot, 'handlers/admin-commands.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).toMatch(/cerrarSesion\(\{[^}]*cierraAdmin:\s*true/);
  });
});

describe('las colas ven los sin_respuesta', () => {
  it('/tickets los lista', async () => {
    db.resp['tickets_soporte:select'] = { data: [], error: null };
    await listarTicketsPendientes();
    expect(estadosLeidos()).toEqual(expect.arrayContaining(['pendiente', 'sin_respuesta']));
  });

  it('/responder <número> encuentra el ticket y lo marca respondido', async () => {
    db.resp['tickets_soporte:select'] = { data: [{ id: 't1', usuario_id: 'u1' }], error: null };
    db.resp['tickets_soporte:update'] = OK;
    db.resp['tickets_mensajes:insert'] = OK;

    const r = await responderTicket({ numDestino: '51999', mensaje: 'Hola, ya lo revisamos' });

    expect(r.ok).toBe(true);
    // Es el camino al que manda el aviso diario. Sin el usuario_id del ticket, la campana y el
    // correo no salían, y fuera de la ventana de 24h la persona no recibía nada.
    expect(notifyMock.notificarUsuario).toHaveBeenCalledOnce();
    expect(notifyMock.notificarUsuario.mock.calls[0][0].usuarioId).toBe('u1');
    expect(estadosLeidos()).toContain('sin_respuesta');
    expect(db.updates.some((u) => u.patch.estado === 'respondido')).toBe(true);
  });
});

describe('resumenTicketsSinRespuesta (el aviso diario al admin)', () => {
  const hace = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  it('lista los pendientes y sin_respuesta viejos, con cómo responder y cómo descartar', async () => {
    db.resp['tickets_soporte:select'] = {
      data: [{ id: 't1', whatsapp: '51999', nombre_usuario: 'Ana', estado: 'sin_respuesta', mensaje_usuario: 'la web no carga', updated_at: hace(26 * 24) }],
      error: null,
    };

    const txt = await resumenTicketsSinRespuesta();

    expect(estadosLeidos()).toEqual(expect.arrayContaining(['pendiente', 'sin_respuesta']));
    const q = db.consultas.find((c) => c.tabla === 'tickets_soporte');
    expect(q.filtros.some((f) => f[0] === 'lt' && f[1] === 'updated_at')).toBe(true);
    expect(txt).toMatch(/sin respuesta \(1\)/i);
    expect(txt).toMatch(/Ana/);
    expect(txt).toMatch(/51999/);
    expect(txt).toMatch(/la web no carga/);
    expect(txt).toMatch(/hace 26 días/);
    expect(txt).toMatch(/\/responder/);
    expect(txt).toMatch(/\/cerrar/);
  });

  it('con más tickets que el tope, el encabezado dice el total real y avisa que hay más', async () => {
    const filas = Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, whatsapp: '5199' + i, nombre_usuario: 'P' + i, estado: 'sin_respuesta', mensaje_usuario: 'x'.repeat(300), updated_at: hace(30) }));
    db.resp['tickets_soporte:select'] = { data: filas, error: null, count: 14 };

    const txt = await resumenTicketsSinRespuesta();

    expect(txt).toMatch(/sin respuesta \(14\)/i);
    expect(txt).toMatch(/y 4 más/);
    expect(txt.length, 'Telegram corta en 4096').toBeLessThan(4096);
    // El doble no aplica el limit, así que el tope se afirma sobre la consulta.
    const q = db.consultas.find((c) => c.tabla === 'tickets_soporte');
    const lim = q.filtros.find((f) => f[0] === 'limit');
    expect(lim && lim[1]).toBeLessThanOrEqual(10);
  });

  it('sin tickets → null (no se manda nada)', async () => {
    db.resp['tickets_soporte:select'] = { data: [], error: null };
    expect(await resumenTicketsSinRespuesta()).toBeNull();
  });

  it('la lectura se cae → lo DICE, no se calla como si no hubiera tickets', async () => {
    db.resp['tickets_soporte:select'] = CAIDA;
    const txt = await resumenTicketsSinRespuesta();
    expect(txt).toMatch(/no pude leer/i);
    expect(logMock.error).toHaveBeenCalled();
  });
});
