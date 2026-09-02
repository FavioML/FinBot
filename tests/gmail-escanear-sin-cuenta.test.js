import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..',
);

/**
 * Escanear sin encontrar nada tiene DOS causas, y confundirlas invierte el copy.
 *
 * `leerCorreosBancarios` ya distingue: consulta `gmail_cuentas` y recién si no hay cae al token
 * legacy de `usuarios`, así que `error === 'no_auth'` significa **ninguna de las dos fuentes**.
 * `escanearGmailYRegistrar` devolvía `null` en ese caso Y en "sí tiene, pero no había correos
 * nuevos", así que los call-sites tenían que adivinar cuál había sido — y lo adivinaban
 * mirando `usuario.gmail_access_token`, el almacén viejo, vacío para 99 de 102 usuarios.
 * Resultado: a quien SÍ tiene Gmail conectado, `/escanear` le respondía "conéctalo en la app".
 *
 * **Este archivo existe porque ningún guard de texto puede ver esto.** Colapsar los dos
 * desenlaces de vuelta en `null` no menciona ninguna columna ni ninguna tabla: se comprobó por
 * mutación que la suite entera (166 archivos, 2988 tests) quedaba en verde con el defecto
 * puesto. La única forma de fijarlo es por COMPORTAMIENTO.
 */

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

/** Lo que `leerCorreosBancarios` va a contestar en cada caso. */
let lectura = { error: 'no_auth', mensajes: [] };

const gmailMock = {
  leerCorreosBancarios: vi.fn(async () => lectura),
  obtenerCuentasGmail: vi.fn(async () => []),
  tieneGmailConectado: vi.fn(async () => false),
  oauth2Client: {},
  BANCOS_CATALOGO: {},
};

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['gmail.js', gmailMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { escanearGmailYRegistrar } = require(path.join(projectRoot, 'services', 'gmail-scanner.js'));

const USUARIO = { id: 'u-1', nombre: 'Ana', plan: 'premium', trial_estado: 'convertido', gmail_access_token: null };

beforeEach(() => {
  gmailMock.leerCorreosBancarios.mockClear();
});

describe('escanearGmailYRegistrar separa "no tiene cuenta" de "no hay correos"', () => {
  it('sin ninguna cuenta conectada devuelve {sinCuenta:true}, no null', () => {
    lectura = { error: 'no_auth', mensajes: [] };
    return expect(escanearGmailYRegistrar(USUARIO)).resolves.toEqual({ sinCuenta: true });
  });

  it('con cuenta pero sin correos nuevos devuelve null', async () => {
    lectura = { error: null, mensajes: [] };
    expect(await escanearGmailYRegistrar(USUARIO)).toBeNull();
  });

  // El tercer desenlace, que ya estaba separado y no se toca: el token murió.
  it('con la autorización caída devuelve {authError:true}', async () => {
    lectura = { error: 'AUTH_EXPIRED', mensajes: [] };
    expect(await escanearGmailYRegistrar(USUARIO)).toEqual({ authError: true });
  });

  /**
   * Y el cuarto: **no se pudo AVERIGUAR** si tiene cuentas.
   *
   * `obtenerCuentasGmail` descartaba su `{ error }` y devolvía `[]`, así que un timeout de
   * Supabase caía al fallback legacy y terminaba en `no_auth`. Con `no_auth` significando
   * "conéctalo en la app", un hipo de red le pedía conectar Gmail a quien ya lo tenía — el
   * mismo bug que `sinCuenta` vino a arreglar, entrando por la rama de error. Lo encontró una
   * revisión adversarial sondeando con `fetch` roto.
   *
   * Cae en `null`, el desenlace MUDO, porque es el único que no afirma nada sobre la persona.
   */
  it('si no se pudo leer, no afirma que no tiene cuenta', async () => {
    lectura = { error: 'lectura_fallida', mensajes: [] };
    expect(await escanearGmailYRegistrar(USUARIO)).toBeNull();
  });

  /**
   * Antivacuidad de los tres de arriba: si los tres devolvieran lo mismo, cada aserción por
   * separado seguiría pasando con el defecto puesto. Lo que importa es que sean DISTINGUIBLES.
   */
  it('los tres desenlaces son distinguibles entre sí', async () => {
    lectura = { error: 'no_auth', mensajes: [] };
    const sinCuenta = await escanearGmailYRegistrar(USUARIO);
    lectura = { error: null, mensajes: [] };
    const sinCorreos = await escanearGmailYRegistrar(USUARIO);
    lectura = { error: 'AUTH_EXPIRED', mensajes: [] };
    const roto = await escanearGmailYRegistrar(USUARIO);
    const serializados = [sinCuenta, sinCorreos, roto].map((r) => JSON.stringify(r));
    expect(new Set(serializados).size).toBe(3);
  });
});

/**
 * Y que los call-sites LO USEN. Separar los desenlaces no sirve de nada si el que responde
 * sigue preguntándole a la columna vieja: el defecto vivía ahí, no en el scanner.
 *
 * Se lee el fuente en vez de ejecutar los handlers porque los dos viven detrás de la máquina de
 * comandos de WhatsApp (gates de plan, muro, sesión de soporte) y montarla entera para observar
 * una rama de copy costaría más de lo que prueba. Lo que se fija es lo mínimo que decide: que
 * ramifiquen por `sinCuenta` y que ya no adivinen con `gmail_access_token`.
 */
describe('los dos call-sites de /escanear ramifican por sinCuenta', () => {
  const fuente = (rel) => require('fs').readFileSync(path.join(projectRoot, rel), 'utf8');

  for (const rel of ['handlers/webhook.js', 'handlers/intents/consultas.js']) {
    it(`${rel} responde el copy de "conectalo" solo cuando NO hay cuenta`, () => {
      const src = fuente(rel);
      // **Se exige el COPY dentro de la rama, no solo que la rama exista.** La primera versión
      // pedía ver `resultado.sinCuenta` y prohibía las formas viejas, y una revisión adversarial
      // la evadió dejando la rama y respondiendo "No encontré correos bancarios nuevos" adentro:
      // suite entera en verde con el defecto original —una persona sin Gmail esperando correos
      // que no van a llegar— de vuelta.
      const rama = src.match(
        new RegExp(String.raw`resultado\s*&&\s*resultado\.sinCuenta\s*\)?\s*\{?[^}]{0,200}`),
      );
      expect(rama, `${rel}: no ramifica por sinCuenta`).not.toBeNull();
      expect(rama[0], `${rel}: la rama de sinCuenta no manda a conectar`).toContain(
        'mensajeConectarEnLaApp',
      );
      // Y que el copy de conectar NO cuelgue de la columna legacy. La forma que había antes
      // —`!usuario.gmail_access_token ? mensajeConectarEnLaApp(...)`— es el bug.
      expect(src, rel).not.toMatch(/gmail_access_token\s*\?\s*mensajeConectar/);
      expect(src, rel).not.toMatch(/!usuario\.gmail_access_token\s*\?/);
    });
  }
});
