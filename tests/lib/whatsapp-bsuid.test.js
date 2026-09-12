import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * Envío por BSUID (12-sep-2026), contra el `lib/whatsapp.js` REAL.
 *
 * Todos los demás tests mockean `enviarWhatsapp`, así que ninguno mira el payload que sale a
 * Meta. Acá lo que se afirma es el cuerpo del POST, porque la diferencia entre "llega" y "Meta
 * lo trata como un teléfono" es una sola clave: `recipient` sin `to`. Con `to` presente Meta usa
 * el teléfono y sanitiza a dígitos, y en agosto eso produjo un 200 con wamid que parecía éxito.
 *
 * Mismo perímetro de mocks que `lecturas-de-infra.test.js`: db, logger, ledger y admin.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const entregasMock = { registrarEntrega: vi.fn(async () => {}) };

/** Respuestas de `usuarios` por columna consultada: `{ bsuid: {...}, whatsapp: {...} }`. */
const db = { porColumna: {}, columnas: [] };

function cadena() {
  const c = {};
  let columna = null;
  c.select = () => c;
  c.eq = (col) => { columna = col; db.columnas.push(col); return c; };
  c.maybeSingle = async () => db.porColumna[columna] || { data: null, error: null };
  return c;
}

for (const [rel, exports] of [
  ['lib/logger.js', logMock],
  ['lib/notification-deliveries.js', entregasMock],
  ['lib/admin-notify.js', { notificarAdmin: vi.fn(async () => true) }],
  ['lib/db.js', { supabase: { from: () => cadena() } }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { enviarWhatsapp, esBsuid, destinoWhatsapp } = require('../../lib/whatsapp');

let fetchOriginal;
const cuerpoEnviado = () => JSON.parse(global.fetch.mock.calls[0][1].body);
const urlEnviada = () => global.fetch.mock.calls[0][0];

// El cache de `isTestUser` es de módulo y vive entre tests: cada caso usa su propio destino.
let n = 0;
const bsuidNuevo = () => 'PE.' + (1000000000000000 + (++n));

beforeEach(() => {
  db.porColumna = {};
  db.columnas = [];
  for (const f of Object.values(logMock)) f.mockReset();
  entregasMock.registrarEntrega.mockClear();
  delete process.env.WA_ENVIO_BSUID;
  delete process.env.META_GRAPH_VERSION_BSUID;
  process.env.META_PHONE_NUMBER_ID = 'pid';
  process.env.META_ACCESS_TOKEN = 'tok';
  fetchOriginal = global.fetch;
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.x' }] }) }));
});

afterEach(() => { global.fetch = fetchOriginal; });

describe('la forma del destino', () => {
  it('reconoce un BSUID y no confunde un teléfono', () => {
    expect(esBsuid('PE.1049206861029395')).toBe(true);
    expect(esBsuid('51999888777')).toBe(false);
    expect(esBsuid('+51999888777')).toBe(false);
    expect(esBsuid(null)).toBe(false);
  });

  it('destinoWhatsapp prefiere el número y cae al BSUID', () => {
    expect(destinoWhatsapp({ whatsapp: '51999888777', bsuid: 'PE.1' })).toBe('51999888777');
    expect(destinoWhatsapp({ whatsapp: null, bsuid: 'PE.1' })).toBe('PE.1');
    expect(destinoWhatsapp({ whatsapp: null, bsuid: null })).toBeNull();
    expect(destinoWhatsapp(null)).toBeNull();
  });
});

describe('enviarWhatsapp · por BSUID', () => {
  it('manda `recipient` y NO `to`, en v25.0', async () => {
    const b = bsuidNuevo();
    const r = await enviarWhatsapp(b, 'hola');

    expect(r.ok).toBe(true);
    const cuerpo = cuerpoEnviado();
    expect(cuerpo.recipient).toBe(b);
    expect(cuerpo.recipient_type).toBe('individual');
    expect(cuerpo, 'con `to` presente Meta usa el teléfono: el BSUID no se usaría').not.toHaveProperty('to');
    expect(cuerpo.text).toEqual({ body: 'hola' });
    expect(urlEnviada()).toContain('/v25.0/');
  });

  it('la versión del BSUID se puede mover por env sin tocar la del teléfono', async () => {
    process.env.META_GRAPH_VERSION_BSUID = 'v27.0';
    await enviarWhatsapp(bsuidNuevo(), 'hola');
    expect(urlEnviada()).toContain('/v27.0/');
  });

  it('las plantillas también van por `recipient`', async () => {
    const b = bsuidNuevo();
    await enviarWhatsapp(b, null, { template: { name: 't', language: { code: 'es' } } });
    const cuerpo = cuerpoEnviado();
    expect(cuerpo.type).toBe('template');
    expect(cuerpo.recipient).toBe(b);
    expect(cuerpo).not.toHaveProperty('to');
  });

  it('usa `opts.bsuid` cuando no hay número', async () => {
    const b = bsuidNuevo();
    await enviarWhatsapp(null, 'aviso', { bsuid: b, tipo: 'x', usuarioId: 'u1' });
    expect(cuerpoEnviado().recipient).toBe(b);
  });

  it('con número Y bsuid, gana el número (el camino de hoy no cambia)', async () => {
    await enviarWhatsapp('51900000101', 'aviso', { bsuid: bsuidNuevo() });
    const cuerpo = cuerpoEnviado();
    expect(cuerpo.to).toBe('51900000101');
    expect(cuerpo).not.toHaveProperty('recipient');
    expect(urlEnviada()).toContain('/v19.0/');
  });

  it('sin número ni bsuid sigue siendo skipped_no_whatsapp, sin fetch', async () => {
    const r = await enviarWhatsapp(null, 'aviso', { tipo: 'x', usuarioId: 'u1' });
    expect(r.skipped).toBe('no_whatsapp');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(entregasMock.registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ estado: 'skipped_no_whatsapp' }));
  });
});

describe('aviso proactivo sin número: el BSUID se resuelve por usuarioId', () => {
  it('si la fila del usuario tiene BSUID, el aviso sale por `recipient`', async () => {
    // Los crons pasan `whatsapp: u.whatsapp` (null para quien se dio de alta sin número) y no
    // saben del BSUID. Sin esta búsqueda, esa persona solo recibiría la campana.
    const b = bsuidNuevo();
    db.porColumna.id = { data: { bsuid: b }, error: null };

    const r = await enviarWhatsapp(null, 'tu resumen', { tipo: 'resumen_semanal', usuarioId: 'u-sin-numero' });

    expect(r.ok).toBe(true);
    expect(cuerpoEnviado().recipient).toBe(b);
    expect(entregasMock.registrarEntrega).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: 'resumen_semanal', usuarioId: 'u-sin-numero', estado: 'sent' }),
    );
  });

  it('con la lectura caída sale como hoy: skipped_no_whatsapp, sin fetch', async () => {
    db.porColumna.id = { data: null, error: { message: 'timeout' } };
    const r = await enviarWhatsapp(null, 'tu resumen', { tipo: 'x', usuarioId: 'u-x' });
    expect(r.skipped).toBe('no_whatsapp');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('una fila sin BSUID tampoco inventa destino', async () => {
    db.porColumna.id = { data: { bsuid: null }, error: null };
    const r = await enviarWhatsapp(null, 'tu resumen', { tipo: 'x', usuarioId: 'u-web' });
    expect(r.skipped).toBe('no_whatsapp');
  });

  it('sin usuarioId no consulta nada', async () => {
    await enviarWhatsapp(null, 'x');
    expect(db.columnas).toHaveLength(0);
  });
});

describe('isTestUser · por la columna que corresponde', () => {
  it('un fixture marcado por BSUID NO llega a Meta', async () => {
    // Antes buscaba el BSUID en `usuarios.whatsapp`, no lo encontraba, y el fail-open lo
    // trataba como real: el fixture de un harness le escribía a Meta de verdad.
    const b = bsuidNuevo();
    db.porColumna.bsuid = { data: { id: 'u-test', is_test_user: true }, error: null };

    const r = await enviarWhatsapp(b, 'hola');

    expect(r.skipped).toBe('test_user');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.columnas).toContain('bsuid');
    expect(db.columnas).not.toContain('whatsapp');
    expect(entregasMock.registrarEntrega).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'skipped_test', tipo: 'respuesta_bsuid', usuarioId: 'u-test' }),
    );
  });

  it('un teléfono se sigue buscando por `whatsapp`', async () => {
    db.porColumna.whatsapp = { data: { id: 'u2', is_test_user: true }, error: null };
    const r = await enviarWhatsapp('51900000102', 'hola');
    expect(r.skipped).toBe('test_user');
    expect(db.columnas).toEqual(['whatsapp']);
  });
});

describe('la respuesta por BSUID deja fila de entrega', () => {
  it('sin `tipo` se anota como respuesta_bsuid, con el usuario que resolvió la búsqueda', async () => {
    db.porColumna.bsuid = { data: { id: 'u-real', is_test_user: false }, error: null };
    await enviarWhatsapp(bsuidNuevo(), 'listo');
    expect(entregasMock.registrarEntrega).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'sent', tipo: 'respuesta_bsuid', usuarioId: 'u-real', wamid: 'wamid.x' }),
    );
  });

  it('un `tipo` explícito se respeta', async () => {
    await enviarWhatsapp(null, 'aviso', { bsuid: bsuidNuevo(), tipo: 'trial_d11', usuarioId: 'u3' });
    expect(entregasMock.registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'trial_d11', usuarioId: 'u3' }));
  });

  it('una respuesta por teléfono sigue sin dejar fila de tipo (nada cambia para el 100% de hoy)', async () => {
    await enviarWhatsapp('51900000103', 'hola');
    expect(entregasMock.registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ tipo: null, estado: 'sent' }));
  });
});

describe('interruptor WA_ENVIO_BSUID', () => {
  it('apagado, no sale nada por BSUID y queda la fila', async () => {
    process.env.WA_ENVIO_BSUID = 'off';
    const r = await enviarWhatsapp(bsuidNuevo(), 'hola');
    expect(r.skipped).toBe('bsuid_off');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(entregasMock.registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ estado: 'skipped_bsuid_off' }));
  });

  it('apagado, el teléfono sale igual', async () => {
    process.env.WA_ENVIO_BSUID = 'off';
    const r = await enviarWhatsapp('51900000104', 'hola');
    expect(r.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it('apagado, un fixture de prueba sigue viendo skipped_test (el harness no pierde su señal)', async () => {
    process.env.WA_ENVIO_BSUID = 'off';
    db.porColumna.bsuid = { data: { id: 'u-test2', is_test_user: true }, error: null };
    const r = await enviarWhatsapp(bsuidNuevo(), 'hola');
    expect(r.skipped).toBe('test_user');
  });
});
