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

const db = { errores: {}, inserts: [], updates: [] };

function cadena(tabla) {
  const c = {};
  const resultado = () => ({ data: null, error: db.errores[tabla] || null });
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

const { registrarMensajeTicket, obtenerHiloTicket } = require('../../lib/support-tickets');

beforeEach(() => {
  db.errores = {};
  db.inserts = [];
  db.updates = [];
  logMock.error.mockReset();
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
