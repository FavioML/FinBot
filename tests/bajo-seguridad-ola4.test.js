import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Cola de BAJO de la Ola 4 (auditoría CTO del 2026-08-10). Tres hallazgos que comparten una
 * forma: el código funciona, y lo que falla es la señal que deja cuando algo sale mal.
 */

// ── S′9: /test-parser aceptaba la ADMIN_KEY en el BODY, bajo el limiter público ──────
describe('S′9 — ningún endpoint acepta la llave de admin por body o query', () => {
  const leer = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

  it('el router público no lee ADMIN_KEY', () => {
    // `routes/public.js` cuelga de `publicLimiter` (60/min por IP). Un endpoint que acepta
    // la llave del admin no pertenece ahí, y menos leyéndola del body: `verificarAdmin`
    // prohíbe body y query POR ESCRITO, porque los dos quedan en logs.
    //
    // Se busca la LECTURA (`process.env.ADMIN_KEY`), no la mención: el comentario que
    // explica por qué el endpoint se mudó nombra la variable, y un guard que se queja de su
    // propia documentación se termina desactivando. Misma lección que el stripper de
    // `codigos-seguros`.
    expect(leer('routes/public.js')).not.toMatch(/process\.env\.ADMIN_KEY/);
  });

  it('test-parser vive bajo /admin y usa verificarAdmin', () => {
    const admin = leer('routes/admin.js');
    expect(admin).toContain("router.post('/test-parser'");
    // La ruta y su guard, en el mismo bloque: sin el `verificarAdmin` el endpoint queda
    // abierto en un router que el resto del archivo asume autenticado.
    const bloque = admin.slice(admin.indexOf("router.post('/test-parser'"));
    expect(bloque.slice(0, 400)).toContain('verificarAdmin(req, res)');
    expect(leer('routes/public.js')).not.toContain("'/test-parser'");
  });

  it('verificarAdmin sigue sin mirar body ni query', () => {
    const admin = leer('routes/admin.js');
    const fn = admin.slice(admin.indexOf('function verificarAdmin'), admin.indexOf('function verificarAdmin') + 900);
    expect(fn).toContain("req.get('x-admin-key')");
    expect(fn).not.toContain('req.body');
    expect(fn).not.toContain('req.query');
  });
});

// ── B22: ningún fetch a Meta tenía timeout ──────────────────────────────────────────
describe('B22 — los fetch a Meta tienen timeout', () => {
  const leer = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

  // El default de `fetch` es NO tener timeout. Un socket que Meta deja colgado bloquea el
  // turno del usuario para siempre, y estos await están en el camino de cada respuesta,
  // cada cron y cada foto.
  for (const rel of ['lib/whatsapp.js', 'services/media-intake.js']) {
    it(`${rel}: cada fetch lleva AbortSignal.timeout`, () => {
      const src = leer(rel);
      const fetches = (src.match(/await fetch\(/g) || []).length;
      const timeouts = (src.match(/AbortSignal\.timeout\(/g) || []).length;
      expect(fetches, 'antivacuidad: si no hay fetch, este test no mide nada').toBeGreaterThan(0);
      expect(timeouts).toBeGreaterThanOrEqual(fetches);
    });
  }
});

// ── B21: el 23505 de persistirBsuid ES la señal de identidad partida ────────────────
describe('B21 — una colisión de BSUID no se colapsa en el log genérico', () => {
  let updateError = null;
  let duenio = null;
  const registrarError = vi.fn();
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  function chain(tabla) {
    const c = {};
    for (const m of ['select', 'eq', 'is', 'order', 'limit']) c[m] = vi.fn(() => c);
    c.maybeSingle = () => Promise.resolve({ data: duenio, error: null });
    c.update = () => ({ eq: () => Promise.resolve({ error: updateError }) });
    c.then = (r) => Promise.resolve({ data: [], error: null }).then(r);
    return c;
  }

  const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: { from: chain } } };
  const logPath = require.resolve(path.join(projectRoot, 'lib/logger.js'));
  require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: log };
  const errPath = require.resolve(path.join(projectRoot, 'lib/error-monitor.js'));
  require.cache[errPath] = { id: errPath, filename: errPath, loaded: true, exports: { registrarError } };

  const { persistirBsuid, persistirBsuidConEstado } = require(path.join(projectRoot, 'helpers/db-helpers.js'));

  beforeEach(() => { updateError = null; duenio = null; registrarError.mockClear(); log.error.mockClear(); });

  it('el 23505 sale con tag propio, no con el log genérico', async () => {
    updateError = { code: '23505', message: 'duplicate key' };
    duenio = { id: 'otro-usuario', whatsapp: '51999', created_at: '2026-01-01' };
    await persistirBsuid({ id: 'u1', bsuid: null }, 'PE.123');

    const tags = log.error.mock.calls.map((c) => c[0] && c[0].tag);
    expect(tags).toContain('BSUID_COLISION');
    expect(tags).not.toContain('BSUID');
  });

  it('nombra al OTRO usuario: sin eso el aviso no es accionable', async () => {
    updateError = { code: '23505', message: 'duplicate key' };
    duenio = { id: 'otro-usuario', whatsapp: '51999', created_at: '2026-01-01' };
    await persistirBsuid({ id: 'u1', bsuid: null }, 'PE.123');
    expect(log.error.mock.calls[0][0].otroUsuarioId).toBe('otro-usuario');
  });

  it('queda en `errores`, que es donde se busca por usuario', async () => {
    updateError = { code: '23505', message: 'duplicate key' };
    duenio = { id: 'otro-usuario' };
    await persistirBsuid({ id: 'u1', bsuid: null }, 'PE.123');
    expect(registrarError).toHaveBeenCalled();
    expect(registrarError.mock.calls[0][0]).toBe('BSUID_COLISION');
  });

  it('cualquier OTRO error sigue por el camino genérico', async () => {
    updateError = { code: '08006', message: 'connection failure' };
    await persistirBsuid({ id: 'u1', bsuid: null }, 'PE.123');
    const tags = log.error.mock.calls.map((c) => c[0] && c[0].tag);
    expect(tags).toContain('BSUID');
    expect(tags).not.toContain('BSUID_COLISION');
    expect(registrarError).not.toHaveBeenCalled();
  });

  // Y para quien deja de reintentar (el Set de `lib/whatsapp.js`), el 23505 es PERMANENTE: se
  // reporta como estado propio para que no se confunda con un fallo de red que sí vale reintentar.
  it('el 23505 se distingue del fallo transitorio en el estado, no solo en el log', async () => {
    updateError = { code: '23505', message: 'duplicate key' };
    duenio = { id: 'otro-usuario' };
    expect((await persistirBsuidConEstado({ id: 'u1', bsuid: null }, 'PE.123')).estado).toBe('colision');
    updateError = { code: '08006', message: 'connection failure' };
    expect((await persistirBsuidConEstado({ id: 'u1', bsuid: null }, 'PE.123')).estado).toBe('fallo');
  });

  it('el camino feliz no toca ninguno de los dos', async () => {
    const u = await persistirBsuid({ id: 'u1', bsuid: null }, 'PE.123');
    expect(u.bsuid).toBe('PE.123');
    expect(log.error).not.toHaveBeenCalled();
    expect(registrarError).not.toHaveBeenCalled();
  });
});
