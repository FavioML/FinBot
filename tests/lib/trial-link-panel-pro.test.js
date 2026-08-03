import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

/**
 * A dónde mandamos a alguien para que conecte su Gmail, ahora que eso es web-only.
 *
 * El riesgo de la consolidación no era el usuario con cuenta web —ese entra al panel y ya—
 * sino los WhatsApp-only: al cerrar el canal, 43 de 93 usuarios (4 de ellos Pro pagados) no
 * tenían sesión que abrir. Mandarlos a `/dashboard/pro` los deposita en `/login`, donde un
 * "Continuar con Google" cualquiera les crea una cuenta HUÉRFANA en vez de vincularse a su
 * número: pagaron, y su Gmail quedaría conectado a una cuenta sin sus gastos. Eso no habría
 * sido una simplificación sino una regresión, y es lo que este archivo impide.
 *
 * `linkPanelPro` es dueño de esa bifurcación y lo usan los cuatro caminos que mandan a
 * alguien al panel (activarPro, /conectar, /bancos, los intents y el aviso de auth expirada),
 * así que un error acá sale por todos a la vez.
 */

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
for (const [rel, exports] of [
  ['lib/db.js', { supabase: {} }],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// El link firmado no se emite sin secreto (fail closed, ver lib/activacion.js). Se fija acá
// para poder probar las dos ramas; el caso "sin secreto" se prueba aparte al final.
process.env.ACTIVATION_TOKEN_SECRET = 'secreto-de-prueba';

const { linkPanelPro, mensajeConectarEnLaApp } = require('../../lib/trial');
const { verificarTokenActivacion } = require('../../lib/activacion');

const CON_WEB = { id: 'u-web', nombre: 'Ana Torres', supabase_auth_id: 'auth-123' };
const WHATSAPP_ONLY = { id: 'u-wa', nombre: 'Luis Pérez', supabase_auth_id: null };

describe('linkPanelPro — la bifurcación por identidad', () => {
  it('quien ya tiene cuenta web entra directo al panel', () => {
    expect(linkPanelPro(CON_WEB)).toContain('/dashboard/pro');
  });

  it('al WhatsApp-only le da el link de ACTIVACIÓN, no el panel', () => {
    const link = linkPanelPro(WHATSAPP_ONLY);
    expect(link).toContain('/activar?t=');
    expect(link, 'un WhatsApp-only en /dashboard/pro cae en /login y se crea una cuenta huérfana')
      .not.toContain('/dashboard/pro');
  });

  // El token no es decorativo: lleva la identidad para que auth/callback vincule sin
  // preguntar. Si viajara vacío o mal firmado, el usuario terminaría en el mismo /login.
  it('el token del link lleva el id del usuario y verifica', () => {
    const token = linkPanelPro(WHATSAPP_ONLY).split('?t=')[1];
    expect(verificarTokenActivacion(token)).toMatchObject({ uid: 'u-wa' });
  });

  it('sin usuario devuelve null en vez de inventar una URL', () => {
    expect(linkPanelPro(null)).toBeNull();
    expect(linkPanelPro(undefined)).toBeNull();
  });
});

describe('mensajeConectarEnLaApp — lo que recibe un Pro pagado por WhatsApp', () => {
  /**
   * Este mensaje reemplazó a la URL de OAuth cruda. Que vuelva a aparecer una sería el
   * agujero original: un enlace de Google emitido desde WhatsApp, canjeable durante 7 días.
   */
  // El link del WhatsApp-only lleva un timestamp firmado, así que dos llamadas no dan la
  // misma cadena: se compara el destino, que es lo que decide a dónde cae el usuario.
  it.each([
    ['con cuenta web', CON_WEB, '/dashboard/pro'],
    ['WhatsApp-only', WHATSAPP_ONLY, '/activar?t='],
  ])('%s recibe un link accionable y NUNCA una URL de Google', (_caso, usuario, destino) => {
    const msg = mensajeConectarEnLaApp(usuario);
    expect(msg).toContain(destino);
    expect(msg).not.toContain('accounts.google.com');
  });

  it('nombra la acción según el caso (conectar / bancos / gestionar)', () => {
    expect(mensajeConectarEnLaApp(CON_WEB, 'conectar')).toMatch(/conectar tu gmail/i);
    expect(mensajeConectarEnLaApp(CON_WEB, 'bancos')).toMatch(/bancos/i);
    expect(mensajeConectarEnLaApp(CON_WEB, 'gestionar')).toMatch(/cuentas de gmail/i);
  });

  // Al WhatsApp-only hay que decirle que va a entrar con Google y que es SU cuenta: sin eso,
  // un link a un dominio que no reconoce después de pagar parece cualquier otra cosa.
  it('al WhatsApp-only le explica que el link lo hace entrar con su Google', () => {
    expect(mensajeConectarEnLaApp(WHATSAPP_ONLY)).toMatch(/google/i);
  });
});

/**
 * Sin `ACTIVATION_TOKEN_SECRET` no hay link firmado (fail closed). El caso importa porque el
 * llamador más delicado es `activarPro`: alguien que ACABA de pagar no puede recibir un
 * mensaje roto, ni una URL a medio armar que lo deje en /login.
 */
describe('sin ACTIVATION_TOKEN_SECRET no se inventa una URL', () => {
  it('el WhatsApp-only recibe la dirección de la app, sin link muerto', () => {
    const previo = process.env.ACTIVATION_TOKEN_SECRET;
    delete process.env.ACTIVATION_TOKEN_SECRET;
    try {
      expect(linkPanelPro(WHATSAPP_ONLY)).toBeNull();
      const msg = mensajeConectarEnLaApp(WHATSAPP_ONLY);
      expect(msg).toContain('/dashboard/pro');
      expect(msg).not.toContain('/activar?t=');
    } finally {
      process.env.ACTIVATION_TOKEN_SECRET = previo;
    }
  });

  // El que sí tiene cuenta web no depende del secreto: su destino es una URL fija.
  it('el que tiene cuenta web no se ve afectado', () => {
    const previo = process.env.ACTIVATION_TOKEN_SECRET;
    delete process.env.ACTIVATION_TOKEN_SECRET;
    try {
      expect(linkPanelPro(CON_WEB)).toContain('/dashboard/pro');
    } finally {
      process.env.ACTIVATION_TOKEN_SECRET = previo;
    }
  });
});
