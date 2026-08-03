import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Inject CJS mocks into require.cache BEFORE loading the handler.
// `generarUrlAutorizacion` se mockea aunque consultas.js ya no lo importe: el mock es lo que
// convierte "dejó de emitir" en un assert observable. Si alguien lo reintroduce, el spy lo
// registra en vez de dejar pasar el cambio en silencio.
const gmailMock = {
  obtenerCuentasGmail: vi.fn().mockResolvedValue([]),
  generarUrlAutorizacion: vi.fn(() => 'https://oauth.example/start'),
};
const scannerMock = {
  escanearGmailYRegistrar: vi.fn().mockResolvedValue('ok'),
};
const txMock = {
  obtenerConsultasPendientes: vi.fn().mockResolvedValue([]),
};

const gmailPath = require.resolve(path.join(projectRoot, 'gmail.js'));
const scannerPath = require.resolve(path.join(projectRoot, 'services/gmail-scanner.js'));
const txPath = require.resolve(path.join(projectRoot, 'services/transactions.js'));

require.cache[gmailPath] = { id: gmailPath, filename: gmailPath, loaded: true, exports: gmailMock };
require.cache[scannerPath] = { id: scannerPath, filename: scannerPath, loaded: true, exports: scannerMock };
require.cache[txPath] = { id: txPath, filename: txPath, loaded: true, exports: txMock };

const handler = require('../../handlers/intents/consultas');

function ctxWith() {
  return {
    supabase: {
      from: vi.fn(() => ({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    },
  };
}

describe('consultas paywall — Gmail intents (prw-002)', () => {
  beforeEach(() => {
    gmailMock.obtenerCuentasGmail.mockClear();
    gmailMock.generarUrlAutorizacion.mockClear();
    scannerMock.escanearGmailYRegistrar.mockClear();
  });

  it('agregar_gmail bloquea a usuarios free con mensaje paywall y NO genera URL', async () => {
    const usuario = { id: 'u1', plan: 'free' };
    const res = await handler.handle({
      intencion: 'agregar_gmail', msg: 'quiero conectar mi gmail',
      datos: {}, usuario, from: '+51999', ctx: ctxWith(),
    });
    expect(res).toContain('Pro');
    expect(res).toContain('S/10');
    expect(res).not.toContain('https://oauth');
    expect(gmailMock.generarUrlAutorizacion).not.toHaveBeenCalled();
  });

  it('cambiar_gmail bloquea a usuarios free con mensaje paywall y NO genera URL', async () => {
    const usuario = { id: 'u1', plan: 'free' };
    const res = await handler.handle({
      intencion: 'cambiar_gmail', msg: 'cambiar mi gmail',
      datos: {}, usuario, from: '+51999', ctx: ctxWith(),
    });
    expect(res).toContain('Pro');
    expect(gmailMock.generarUrlAutorizacion).not.toHaveBeenCalled();
  });

  /**
   * Conectar es web-only: el intent responde con el atajo al panel y no toca la base.
   *
   * El `onboarding_paso: 30` que se escribía acá era el otro extremo del problema: dejaba una
   * capability de pago a medio camino, con su estado guardado entre dos mensajes. Que NO haya
   * escritura es parte del contrato nuevo, no un detalle.
   */
  it('agregar_gmail manda al panel sin emitir OAuth ni escribir un paso de onboarding', async () => {
    const usuario = { id: 'u1', plan: 'premium', trial_estado: 'convertido', supabase_auth_id: 'auth-1' };
    const ctx = ctxWith();
    const res = await handler.handle({
      intencion: 'agregar_gmail', msg: 'quiero conectar mi gmail',
      datos: {}, usuario, ctx,
    });
    expect(res).toContain('/dashboard/pro');
    expect(res).not.toContain('https://oauth');
    expect(gmailMock.generarUrlAutorizacion).not.toHaveBeenCalled();
    expect(ctx.supabase.from).not.toHaveBeenCalled();
  });

  // El agujero que motivó el gate: durante el trial `plan` vale 'premium', así que el gate
  // viejo (`maxGmailAccounts === 0`, o sea `plan === 'free'`) dejaba pasar al que prueba y le
  // quemaba uno de los 100 cupos de Google. Los dos casos de arriba (free / premium sin
  // trial) pasaban igual ANTES y DESPUÉS del cambio: no prueban nada de esto.
  it.each([
    ['agregar_gmail'],
    ['cambiar_gmail'],
  ])('%s NO entrega OAuth a quien está en su trial (plan premium + trial activo)', async (intencion) => {
    const usuario = { id: 'u1', nombre: 'Ana', plan: 'premium', trial_estado: 'activo' };
    const res = await handler.handle({
      intencion, msg: 'conectar gmail', datos: {}, usuario, from: '+51999', ctx: ctxWith(),
    });
    // Ojo: el mensaje del paywall SÍ lleva a /dashboard/pro — a pagar, no a conectar. Lo que
    // no puede llevar es un enlace de OAuth.
    expect(res).toContain('Pro pagado');
    expect(res).not.toContain('https://oauth');
    expect(gmailMock.generarUrlAutorizacion).not.toHaveBeenCalled();
  });

  // Sin este caso, los dos de arriba pasarían aunque el intent estuviera roto del todo y no
  // respondiera nada útil a nadie: un gate que niega siempre se ve igual que uno que funciona.
  it('cambiar_gmail SÍ le da el atajo al Pro pagado (el gate no puede pasarse de largo)', async () => {
    const usuario = { id: 'u1', plan: 'premium', trial_estado: 'convertido', supabase_auth_id: 'auth-1' };
    const res = await handler.handle({
      intencion: 'cambiar_gmail', msg: 'cambiar mi gmail', datos: {}, usuario, ctx: ctxWith(),
    });
    expect(res).toContain('/dashboard/pro');
    expect(gmailMock.generarUrlAutorizacion).not.toHaveBeenCalled();
  });

  /**
   * `escanearGmailYRegistrar` devuelve un OBJETO (`{authError:true}`) cuando el token murió,
   * no un string. El handler lo retornaba tal cual, así que el usuario cuyo Gmail se
   * desconectó pedía "escanea mi correo" y recibía basura — justo en el único momento en que
   * PREGUNTA por ese estado. Se afirma que la respuesta es texto y que nombra lo que pasó.
   */
  it('escanear_gmail con el token muerto responde texto, no el objeto {authError}', async () => {
    scannerMock.escanearGmailYRegistrar.mockResolvedValueOnce({ authError: true });
    const usuario = { id: 'u1', plan: 'premium', trial_estado: 'convertido', supabase_auth_id: 'auth-1' };
    const res = await handler.handle({
      intencion: 'escanear_gmail', msg: 'escanea mi gmail', datos: {}, usuario, ctx: ctxWith(),
    });
    expect(typeof res, 'el handler devolvió un objeto: llega crudo a enviarWhatsapp').toBe('string');
    expect(res).toMatch(/desconect/i);
    expect(res).toContain('/dashboard/pro');
  });

  it('escanear_gmail bloquea a free con paywall', async () => {
    const usuario = { id: 'u1', plan: 'free' };
    const res = await handler.handle({
      intencion: 'escanear_gmail', msg: 'escanea mi gmail',
      datos: {}, usuario, from: '+51999', ctx: ctxWith(),
    });
    expect(res).toContain('Pro');
  });
});
