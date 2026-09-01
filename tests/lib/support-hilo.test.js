import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

/**
 * El HILO de una conversación de soporte (migración 079) y su invariante:
 *
 *   **hay UN solo escritor de las dos representaciones.**
 *
 * `tickets_soporte` conserva `mensaje_usuario`/`mensaje_admin` porque el listado del panel y
 * el `/tickets` de WhatsApp muestran una línea por ticket sin traerse el hilo entero. O sea
 * que el último mensaje vive en dos lugares — y el mismo dato en dos lugares diverge solo
 * apenas hay dos escritores. Acá hay uno (`registrarMensajeTicket`), y eso es lo que se fija:
 * no que las dos coincidan hoy, sino que no exista un segundo camino que las separe mañana.
 *
 * Antes de la 079 el UPDATE suelto PISABA el mensaje anterior en cada turno, así que de una
 * conversación de cinco mensajes sobrevivía el último de cada lado.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn(), META_ERR_FUERA_VENTANA: 131047 };

const db = { errores: {}, inserts: [], updates: [], cola: [] };

function cadena(tabla) {
  const c = {};
  // `cola` gana cuando está poblada: es lo que deja sembrar una sesión con una antigüedad
  // concreta. Sin ella el doble sólo sabe devolver vacío, y la ventana no se puede medir.
  const resultado = () => (db.cola.length
    ? db.cola.shift()
    : { data: null, error: db.errores[tabla] || null });
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = () => c;
  c.insert = (fila) => { db.inserts.push({ tabla, fila }); return c; };
  c.update = (patch) => { db.updates.push({ tabla, patch }); return c; };
  c.maybeSingle = async () => resultado();
  c.then = (res, rej) => Promise.resolve(resultado()).then(res, rej);
  return c;
}

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/db.js', { supabase: { from: (t) => cadena(t) } }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { registrarMensajeTicket, obtenerHiloTicket, obtenerSesionAbierta, abrirSesion } = require('../../lib/support-tickets');

beforeEach(() => {
  db.errores = {};
  db.inserts = [];
  db.updates = [];
  db.cola = [];
  logMock.error.mockReset();
  waMock.enviarWhatsapp.mockReset();
  waMock.enviarWhatsapp.mockResolvedValue({ ok: true });
});

/** Una sesión abierta cuyo último movimiento fue hace `horas`. */
function sesionDeHace(horas) {
  const ts = new Date(Date.now() - horas * 3600 * 1000).toISOString();
  return { data: [{ id: 't1', usuario_id: 'u1', whatsapp: '51999', estado: 'respondido', updated_at: ts, created_at: ts }], error: null };
}

describe('la ventana de escucha: corta, deslizante, y avisa al cerrarse salvo a quien lo pidió', () => {
  // El diseño viejo era un INTERRUPTOR de 48h: mientras la sesión estuviera abierta, TODO
  // mensaje de esa persona iba al admin y su asistente quedaba muerto. Un olvido del admin le
  // apagaba el bot dos días a alguien que sólo quería anotar un gasto.
  //
  // Los dos tests de abajo ACOTAN la ventana por comportamiento en vez de afirmar la
  // constante: uno muere si alguien la agranda a horas de más, el otro si la achica tanto que
  // corta conversaciones vivas. Fijar el número habría pasado en verde con los dos extremos.

  it('a las 3 horas de silencio ya no enruta, y se lo dice a la persona', async () => {
    db.cola = [sesionDeHace(3), { data: [{ id: 't1', whatsapp: '51999' }], error: null }, { data: null, error: null }];

    const s = await obtenerSesionAbierta('u1');

    expect(s, 'una sesión de hace 3h sigue secuestrando el bot').toBe(null);
    expect(db.updates.some((u) => u.patch.estado === 'cerrado')).toBe(true);
    // El aviso no es cortesía: sin él, el mensaje que disparó el vencimiento se lo lleva el
    // bot y la persona recibe a Neto hablándole de gastos sobre una pregunta de soporte.
    expect(waMock.enviarWhatsapp).toHaveBeenCalledOnce();
    expect(String(waMock.enviarWhatsapp.mock.calls[0][1])).toMatch(/sin actividad|asistente/i);
  });

  // ── Los DOS caminos del mismo autocierre ──────────────────────────────────────────────
  //
  // El aviso de arriba lo manda el autocierre, pero **no es del autocierre: es del RUTEO**. Por
  // eso los dos tests que siguen no se pueden colapsar en uno: en el de arriba la persona no
  // pidió nada y su mensaje se lo lleva el bot (callar ahí es peor que el silencio), y en el de
  // abajo la persona escribió `/soporte` y va a tener soporte (avisar ahí es desmentirse).
  //
  // Un test que sólo cubriera el de abajo pasaría en verde con el aviso silenciado dentro de
  // `obtenerSesionAbierta`, que es el arreglo equivocado y se ve idéntico desde acá.

  it('/soporte sobre una sesión vencida: la cierra, abre la nueva, y NO manda el aviso de ruteo', async () => {
    // El defecto que cierra el ítem 22: `abrirSesion` empieza llamando a `obtenerSesionAbierta`,
    // así que la persona recibía "💚 … Volví a ser tu asistente" y, pisándolo, "👤 Modo soporte
    // activado". Los dos ciertos por separado; juntos, el bot desmintiéndose en dos mensajes.
    db.cola = [
      sesionDeHace(3),                                                  // la vencida, al entrar
      { data: [{ id: 't1', whatsapp: '51999' }], error: null },         // la que lee cerrarSesion
      { data: null, error: null },                                      // el UPDATE del cierre
      { data: { id: 't-nuevo' }, error: null },                         // el insert de la nueva
    ];

    const r = await abrirSesion({ usuarioId: 'u1', whatsapp: '51999' });

    // Que no llegue el aviso NO puede venir de que no se haya cerrado nada: si la vencida
    // siguiera abierta, `cerrarSesion` cortaría antes de decidir el aviso y este test daría
    // verde sin ejercitar la línea que arregla el ítem. Y además `abrirSesion` devolvería
    // `yaAbierta: true` sobre una sesión muerta, o sea "ya estás en modo soporte".
    expect(db.updates.some((u) => u.patch.estado === 'cerrado'), 'la vencida quedó abierta').toBe(true);
    expect(r).toEqual({ yaAbierta: false, ticket: { id: 't-nuevo' } });

    expect(waMock.enviarWhatsapp, 'el segundo mensaje que se contradice con "Modo soporte activado"')
      .not.toHaveBeenCalled();
  });

  it('CONTROL: /soporte sobre una sesión VIVA no cierra nada y tampoco avisa', async () => {
    // Separa "no avisó porque se silenció el autocierre" de "no avisó porque no hubo autocierre".
    // Sin esto, el test de arriba pasaría igual con un `abrirSesion` que cierre siempre o que no
    // cierre nunca.
    db.cola = [sesionDeHace(0.17)];

    const r = await abrirSesion({ usuarioId: 'u1', whatsapp: '51999' });

    expect(r.yaAbierta).toBe(true);
    expect(r.ticket.id).toBe('t1');
    expect(db.updates.some((u) => u.patch.estado === 'cerrado')).toBe(false);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('a los 10 minutos sigue viva: una conversación en curso no se corta', async () => {
    db.cola = [sesionDeHace(0.17)];

    const s = await obtenerSesionAbierta('u1');

    expect(s && s.id).toBe('t1');
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(db.updates.some((u) => u.patch.estado === 'cerrado')).toBe(false);
  });
});

describe('registrarMensajeTicket · las dos representaciones, un solo escritor', () => {
  it('el mensaje del usuario entra al hilo Y actualiza su columna', async () => {
    await registrarMensajeTicket({ ticketId: 't1', rol: 'usuario', mensaje: 'no me registró el gasto' });

    expect(db.inserts).toEqual([
      { tabla: 'tickets_mensajes', fila: { ticket_id: 't1', rol: 'usuario', mensaje: 'no me registró el gasto', wamid: null } },
    ]);
    // El turno del usuario no lleva wamid: no es un mensaje NUESTRO, no hay entrega que cruzar.
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].patch.mensaje_usuario).toBe('no me registró el gasto');
    // La columna del OTRO lado no se toca: pisarla borraría la última respuesta del admin.
    expect(db.updates[0].patch.mensaje_admin).toBeUndefined();
  });

  it('el del admin va a la columna del admin', async () => {
    await registrarMensajeTicket({ ticketId: 't1', rol: 'admin', mensaje: 'ya lo revisamos' });

    expect(db.inserts[0].fila.rol).toBe('admin');
    expect(db.inserts[0].fila.wamid).toBe(null);
    expect(db.updates[0].patch.mensaje_admin).toBe('ya lo revisamos');
    expect(db.updates[0].patch.mensaje_usuario).toBeUndefined();
  });

  it('`patchExtra` viaja al mismo UPDATE, no a uno aparte', async () => {
    // El estado y el mensaje son UNA transición: dos updates separados dejan alcanzable el
    // estado a medias (mensaje escrito, ticket todavía en `esperando_mensaje`).
    await registrarMensajeTicket({
      ticketId: 't1', rol: 'usuario', mensaje: 'hola', patchExtra: { estado: 'pendiente' },
    });

    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].patch).toMatchObject({ mensaje_usuario: 'hola', estado: 'pendiente' });
  });

  it('si el hilo NO entra, se loguea y no se traga el error', async () => {
    // supabase-js no lanza: sin leer el `{ error }`, un insert rechazado se ve idéntico a uno
    // exitoso y el hilo se vacía en silencio. Como el mensaje ya se envió, no se corta el
    // flujo — pero tiene que quedar rastro, que es la única forma de enterarse.
    db.errores.tickets_mensajes = { message: 'RLS rechazó el insert' };

    await expect(registrarMensajeTicket({ ticketId: 't1', rol: 'admin', mensaje: 'x' })).resolves.toBeUndefined();

    const anotado = logMock.error.mock.calls.filter((c) => /hilo/i.test(String(c[1])));
    expect(anotado.length, 'el fallo del hilo no dejó rastro').toBe(1);
    expect(anotado[0][0].err).toMatch(/RLS/);
    // Y la columna se intenta igual: son dos escrituras independientes.
    expect(db.updates).toHaveLength(1);
  });

  it('el wamid del admin se persiste: es lo que cruza el turno con su entrega', async () => {
    // Sin esta fila el panel no puede decir ENTREGADO ni NO ENTREGADO, solo "enviada" — que
    // es la frase que significaba nada mas que "Meta acepto el POST".
    await registrarMensajeTicket({ ticketId: 't1', rol: 'admin', mensaje: 'ya esta', wamid: 'wamid.ABC' });
    expect(db.inserts[0].fila.wamid).toBe('wamid.ABC');
  });

  it('sin ticketId o sin mensaje no escribe nada', async () => {
    await registrarMensajeTicket({ ticketId: null, rol: 'admin', mensaje: 'x' });
    await registrarMensajeTicket({ ticketId: 't1', rol: 'admin', mensaje: '' });
    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });
});

describe('obtenerHiloTicket · una lectura caída no se pinta como "no hay mensajes"', () => {
  it('propaga el error en vez de devolver []', async () => {
    // Devolver [] acá haría que el panel diga "sin mensajes en el hilo" sobre una caída, o sea
    // la conclusión OPUESTA a la verdadera: que la persona nunca escribió.
    db.errores.tickets_mensajes = { message: 'timeout' };
    await expect(obtenerHiloTicket('t1')).rejects.toThrow(/timeout/);
  });

  it('sin ticketId devuelve vacío sin consultar', async () => {
    await expect(obtenerHiloTicket(null)).resolves.toEqual([]);
  });
});

describe('el invariante de CLASE: nadie más escribe esas columnas', () => {
  it('`mensaje_usuario`/`mensaje_admin` sólo se escriben desde support-tickets.js', () => {
    // Lista NEGRA, no blanca: con una lista blanca de carpetas, un directorio de runtime nuevo
    // quedaría invisible y el segundo escritor entraría sin que nada lo note. Es la misma
    // lección que los `watchPatterns` de railway.json.
    const IGNORAR = new Set(['node_modules', '.git', '.next', 'webapp', 'qa-e2e', 'tests', 'docs', 'migrations', 'coverage', 'assets']);
    const archivos = [];
    (function barrer(dir) {
      for (const e of readdirSync(dir)) {
        if (IGNORAR.has(e) || e.startsWith('.')) continue;
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) barrer(p);
        else if (e.endsWith('.js')) archivos.push(p);
      }
    })(projectRoot);

    // Se busca la ESCRITURA (`columna:` dentro de un objeto), no la mención: leerlas para
    // pintarlas es legítimo y `listarTicketsPendientes` lo hace en el mismo archivo.
    const ESCRITURA = /\b(mensaje_usuario|mensaje_admin)\s*:/;
    const culpables = archivos
      .filter((p) => ESCRITURA.test(readFileSync(p, 'utf8')))
      .map((p) => path.relative(projectRoot, p).split(path.sep).join('/'))
      .filter((rel) => rel !== 'lib/support-tickets.js');

    expect(culpables, 'un segundo escritor separa el hilo de la columna de último mensaje').toEqual([]);
  });

  it('el detector reconoce una escritura (control)', () => {
    // Sin esto, un regex roto pone el test de arriba en verde afirmando sobre nada.
    const ESCRITURA = /\b(mensaje_usuario|mensaje_admin)\s*:/;
    expect(ESCRITURA.test("update({ mensaje_admin: texto })")).toBe(true);
    expect(ESCRITURA.test("update({ mensaje_usuario : x })")).toBe(true);
    expect(ESCRITURA.test("if (t.mensaje_usuario) msg += t.mensaje_usuario")).toBe(false);
  });

  it('el barrido ve archivos de verdad (control)', () => {
    // Un barrido que devuelve cero archivos también da la lista vacía de arriba. Ya pasó en
    // este repo con una lista blanca de carpetas.
    const IGNORAR = new Set(['node_modules', '.git', '.next', 'webapp', 'qa-e2e', 'tests', 'docs', 'migrations', 'coverage', 'assets']);
    let n = 0;
    (function barrer(dir) {
      for (const e of readdirSync(dir)) {
        if (IGNORAR.has(e) || e.startsWith('.')) continue;
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) barrer(p);
        else if (e.endsWith('.js')) n++;
      }
    })(projectRoot);
    expect(n).toBeGreaterThan(50);
  });
});
