import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * El barrido de Gmail le pasa al parser el nombre del dueño del buzón.
 *
 * Sin esto, la regla de `gmail-transferencia-al-titular.test.js` queda escrita y apagada: el parser
 * sin `titular` se comporta como antes, así que una constancia de transferencia a nombre de quien
 * cobra vuelve a entrar como gasto. Ese archivo prueba el parser; éste prueba el cable.
 *
 * `usuarios.nombre` suele ser solo el nombre de pila y `lib/titular.js` exige nombre y apellido, así
 * que el nombre completo sale de la cuenta de Google (Auth), una vez por corrida. Los llamadores de
 * hoy traen la fila entera.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

/** Lo que devuelve la lectura de `usuarios.nombre`. */
let filaUsuario = { data: { nombre: 'Rosa', supabase_auth_id: 'a1' }, error: null };
/** Lo que devuelve `auth.admin.getUserById`. */
let respuestaAuth = { data: { user: { user_metadata: { full_name: 'Rosa Huaman' } } }, error: null };
let lecturasAuth = 0;
/** Cuántas veces se leyó `usuarios`. */
let lecturasUsuarios = 0;
const llamadasParser = [];
const CONSTANCIAS = [
  { id: 'm1', texto: 'Constancia', asunto: 'Constancia de Transferencia a Terceros BCP', fecha: '2026-11-02' },
  { id: 'm2', texto: 'Constancia', asunto: 'Constancia de Transferencia a Otros Bancos', fecha: '2026-11-02' },
];
let correosDelBuzon = CONSTANCIAS;

function tabla(nombre) {
  const q = {
    select() { return q; },
    eq() { return q; },
    limit() { return q; },
    maybeSingle: async () => {
      if (nombre === 'usuarios') { lecturasUsuarios++; return filaUsuario; }
      return { data: null, error: null };
    },
  };
  return q;
}

const stubs = {
  'lib/logger.js': logMock,
  'lib/db.js': { supabase: { from: tabla, auth: { admin: { getUserById: async () => { lecturasAuth++; return respuestaAuth; } } } } },
  'lib/error-monitor.js': { registrarError: vi.fn() },
  'lib/admin-notify.js': { notificarErrorAdmin: vi.fn() },
  'gmail.js': { leerCorreosBancarios: async () => ({ error: null, mensajes: correosDelBuzon }) },
  'services/parsers.js': { parsearCorreoBancario: async (...args) => { llamadasParser.push(args); return { es_movimiento: false }; } },
  'services/transactions.js': { guardarTransaccion: vi.fn() },
  'services/categories.js': { obtenerCategoriasUsuario: async () => [] },
  'services/notifications.js': { enviarAlertaTransaccion: vi.fn() },
  'lib/trial.js': { esProPagado: () => true, linkPanelPro: () => 'https://app.neto.pe/dashboard/pro' },
  'lib/notify-user.js': { CANALES: {}, notificarUsuario: vi.fn() },
};
for (const [rel, exports] of Object.entries(stubs)) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { escanearGmailYRegistrar } = require('../services/gmail-scanner');

beforeEach(() => {
  filaUsuario = { data: { nombre: 'Rosa', supabase_auth_id: 'a1' }, error: null };
  respuestaAuth = { data: { user: { user_metadata: { full_name: 'Rosa Huaman' } } }, error: null };
  lecturasUsuarios = 0;
  lecturasAuth = 0;
  logMock.warn.mockClear();
  llamadasParser.length = 0;
  correosDelBuzon = CONSTANCIAS;
});

const titularesPasados = () => llamadasParser.map((args) => (args[3] || {}).titulares);

describe('el barrido le pasa el titular al parser', () => {
  it('con la fila entera (como la traen todos los llamadores hoy): solo el nombre de Google, sin releer usuarios', async () => {
    await escanearGmailYRegistrar({ id: 'u1', nombre: 'Rosa', supabase_auth_id: 'a1' });
    expect(titularesPasados()).toEqual([['Rosa Huaman'], ['Rosa Huaman']]);
    expect(lecturasUsuarios).toBe(0);
    // Una vez por corrida, no por correo.
    expect(lecturasAuth).toBe(1);
  });

  it('el barrido histórico de 30 días también lo pasa', async () => {
    await escanearGmailYRegistrar({ id: 'u1', nombre: 'Rosa', supabase_auth_id: 'a1' }, { historico: true, enviarAlertas: false });
    expect(titularesPasados()).toEqual([['Rosa Huaman'], ['Rosa Huaman']]);
  });

  it('el nombre del alta no entra: dos nombres de pila pasaban por nombre y apellido', async () => {
    await escanearGmailYRegistrar({ id: 'u1', nombre: 'Juan Carlos', supabase_auth_id: null });
    expect(titularesPasados()).toEqual([[], []]);
    expect(lecturasAuth).toBe(0);
  });

  it('si Auth falla, las constancias NO se parsean (se reintentan) y queda el aviso', async () => {
    // Parsearlas sin el nombre las guardaría como gasto, y el pre-check por descripcion_original
    // no las volvería a mirar nunca.
    respuestaAuth = { data: null, error: { message: 'timeout' } };
    await escanearGmailYRegistrar({ id: 'u1', nombre: 'Rosa', supabase_auth_id: 'a1' });
    expect(llamadasParser).toHaveLength(0);
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('si Auth falla, un correo que no es constancia sigue su camino', async () => {
    respuestaAuth = { data: null, error: { message: 'timeout' } };
    correosDelBuzon = [{ id: 'm3', texto: 'Consumo', asunto: 'Realizaste un consumo con tu Tarjeta de Débito BCP', fecha: '2026-11-02' }];
    await escanearGmailYRegistrar({ id: 'u1', nombre: 'Rosa', supabase_auth_id: 'a1' });
    expect(titularesPasados()).toEqual([[]]);
  });

  it('si el llamador no trajo las columnas, sigue sin titular y no lee usuarios', async () => {
    // Una lectura de `usuarios` acá sería una query más por corrida para un caso que hoy no existe
    // (los cinco llamadores traen `select('*')`), y sin titular el parser hace lo de antes.
    await escanearGmailYRegistrar({ id: 'u1' });
    expect(titularesPasados()).toEqual([[], []]);
    expect(lecturasUsuarios).toBe(0);
  });
});
