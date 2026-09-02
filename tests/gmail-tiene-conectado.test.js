import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..',
);

/**
 * `tieneGmailConectado`: la unión de las dos fuentes, para el backend.
 *
 * El dato vive en dos almacenes —`usuarios.gmail_access_token` (legacy) y `gmail_cuentas`— y
 * hasta el 2026-09-02 cuatro sitios del canal de WhatsApp respondían esta pregunta mirando solo
 * el viejo. Consecuencia: a quien SÍ tiene Gmail conectado se le daba el copy del que no lo
 * tiene — el saludo de "modo manual", y un "conéctalo en la app" después de escanear.
 *
 * **Este archivo existe porque la propiedad que prueba se mudó de módulo.** El corte por el
 * token legacy estaba en `handlers/message-processor.js` y su test vivía en
 * `message-processor-arranque`; al mover el cuerpo a `gmail.js`, la llamada dejó de pasar por
 * `module.exports` y el mock de aquel archivo dejó de interceptarla. Ese test lo delató en vez
 * de quedarse verde, que es lo que tenía que pasar. Lo que allá se sigue midiendo es el
 * PARALELISMO del arranque; el corte se mide acá, contra el módulo que ahora es su dueño.
 */

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

/** Filas de `gmail_cuentas` que la "base" devuelve, y cuántas veces se la consultó. */
let cuentasActivas = [];
let errorDeLectura = null;
const consultas = [];

function tabla(nombre) {
  const q = {
    _filtros: {},
    select() { return q; },
    eq(col, val) { q._filtros[col] = val; return q; },
    order() { return q; },
    then(resolve) {
      consultas.push({ tabla: nombre, filtros: { ...q._filtros } });
      if (errorDeLectura) return Promise.resolve({ data: null, error: errorDeLectura }).then(resolve);
      return Promise.resolve({ data: nombre === 'gmail_cuentas' ? cuentasActivas : [], error: null }).then(resolve);
    },
  };
  return q;
}

// `gmail.js` no usa `lib/db`: tiene su propio `getSupabase()` que llama a `createClient`. Se
// intercepta el cliente en su origen — mockear `lib/db` lo dejaría hablando con Supabase REAL,
// porque el runner carga el `.env`.
const supaPath = require.resolve('@supabase/supabase-js', { paths: [projectRoot] });
require.cache[supaPath] = {
  id: supaPath, filename: supaPath, loaded: true,
  exports: { createClient: () => ({ from: (n) => tabla(n) }) },
};
const logPath = require.resolve(path.join(projectRoot, 'lib/logger.js'));
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: logMock };

process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'a1'.repeat(32);

const { tieneGmailConectado } = require(path.join(projectRoot, 'gmail.js'));

beforeEach(() => {
  cuentasActivas = [];
  errorDeLectura = null;
  consultas.length = 0;
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe('tieneGmailConectado une las dos fuentes', () => {
  it('el token legacy corta SIN ir a la base', async () => {
    expect(await tieneGmailConectado({ id: 'u1', gmail_access_token: 'cifrado' })).toBe(true);
    // El caso común es no tener Gmail (3 de 102 usuarios al 2026-09-01) y esto corre en el
    // camino de cada mensaje de WhatsApp: la query se paga solo cuando la columna no alcanza.
    expect(consultas).toEqual([]);
  });

  // El caso que originó todo: la cuenta del fundador vive solo en `gmail_cuentas` y el panel
  // —y estos cuatro sitios de copy— la daban por desconectada.
  it('sin token legacy, una fila activa en gmail_cuentas cuenta', async () => {
    cuentasActivas = [{ id: 'c1', usuario_id: 'u1', email: 'x@gmail.com' }];
    expect(await tieneGmailConectado({ id: 'u1', gmail_access_token: null })).toBe(true);
    expect(consultas.map((c) => c.tabla)).toEqual(['gmail_cuentas']);
  });

  it('sin ninguna de las dos, no tiene Gmail', async () => {
    expect(await tieneGmailConectado({ id: 'u1', gmail_access_token: null })).toBe(false);
    expect(consultas).toHaveLength(1);
  });

  // `obtenerCuentasGmail` filtra `activa = true`, así que una cuenta revocada no cuenta. Se
  // fija acá porque es la diferencia entre "conectado hoy" y "gastó cupo alguna vez", y
  // colapsarlas haría que el bot le hable de su Gmail a quien lo desconectó.
  it('la consulta pide solo las cuentas activas', async () => {
    await tieneGmailConectado({ id: 'u1', gmail_access_token: null });
    expect(consultas[0].filtros).toMatchObject({ usuario_id: 'u1', activa: true });
  });

  /**
   * Falla hacia "no tiene", y es deliberado: todos los call-sites eligen COPY con esto. Afirmar
   * que sí lo tiene esconde el enlace para conectarlo, que es el peor de los dos errores.
   */
  it('si la lectura se cae, asume que no tiene y deja rastro', async () => {
    errorDeLectura = new Error('timeout');
    expect(await tieneGmailConectado({ id: 'u1', gmail_access_token: null })).toBe(false);
    // **El log se ASERTA, no se promete.** Hasta el 2026-09-02 `obtenerCuentasGmail` descartaba
    // su `{ error }` y devolvía `[]`, así que este `catch` no se ejecutaba NUNCA y el `warn` que
    // el docblock promete no se emitió jamás — verificado por una revisión adversarial
    // interceptando `fetch`. Un test que dice "deja rastro" en el nombre y no lo comprueba es
    // exactamente cómo esa promesa sobrevivió meses sin ser cierta.
    expect(logMock.error).toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalled();
  });

  /**
   * Antivacuidad del anterior: en el camino SANO no se loguea nada. Sin esto, un `log.warn`
   * suelto en cualquier parte de la función dejaría el caso de arriba en verde.
   */
  it('el camino sano no loguea nada', async () => {
    cuentasActivas = [{ id: 'c1', usuario_id: 'u1' }];
    await tieneGmailConectado({ id: 'u1', gmail_access_token: null });
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
