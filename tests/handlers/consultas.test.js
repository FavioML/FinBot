import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Inject CJS mocks into require.cache BEFORE loading the handler.
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

  it('agregar_gmail genera URL OAuth para usuarios premium', async () => {
    const usuario = { id: 'u1', plan: 'premium' };
    const res = await handler.handle({
      intencion: 'agregar_gmail', msg: 'quiero conectar mi gmail',
      datos: {}, usuario, from: '+51999', ctx: ctxWith(),
    });
    expect(res).toContain('https://oauth.example/start');
    expect(gmailMock.generarUrlAutorizacion).toHaveBeenCalledWith('+51999', 'inicial');
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
