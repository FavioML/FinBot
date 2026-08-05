import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('../../handlers/intents/metas');
const { ALFABETO_META } = require('../../lib/codigos-seguros');

/**
 * El wiring de `compartir_meta`, gemelo de `tests/services/spaces-invite-code.test.js`.
 *
 * Existe porque el revisor adversarial marcó que el commit de seguimiento (`e92e2d8`)
 * cerró el hueco "podría llamar al helper y después escribir otra cosa" **solo para
 * espacios**. Para metas no había equivalente: la mutación "llama a
 * `generarCodigoInvitacion` y escribe `inviteCode = 'AAAAAAAA'` en el update" dejaba toda
 * la suite verde. Los dos caminos emiten credenciales; los dos necesitan el mismo test.
 *
 * Lo que se mira es el payload que llega al `update`, no lo que devuelve el helper.
 */

const META = {
  id: 'meta-1',
  nombre: 'Viaje',
  icono: '✈️',
  monto_objetivo: 3000,
  monto_actual: 600,
  invite_code: null,
  colaborativa: false,
};

function makeChain(data, sink, table, errores) {
  const c = {};
  const q = { op: 'select' };
  for (const m of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  for (const op of ['update', 'upsert', 'insert']) {
    c[op] = vi.fn((p) => { q.op = op; sink.push({ table, op, payload: p }); return c; });
  }
  c.then = (ok, err) =>
    Promise.resolve({ data, error: errores[table + ':' + q.op] || null }).then(ok, err);
  return c;
}

async function compartirMeta(sink, { meta = META, errores = {} } = {}) {
  const supabase = {
    from: vi.fn((t) => makeChain(t === 'metas_ahorro' ? [{ ...meta }] : [], sink, t, errores)),
  };
  return handler.handle({
    intencion: 'compartir_meta',
    msg: 'comparte mi meta',
    datos: {},
    usuario: { id: 'user-1' },
    from: '51900000000',
    ctx: { supabase },
  });
}

function codigosEscritos(sink) {
  return sink
    .filter((o) => o.table === 'metas_ahorro' && o.op === 'update' && o.payload.invite_code)
    .map((o) => o.payload.invite_code);
}

afterEach(() => vi.restoreAllMocks());

describe('compartir_meta escribe el codigo del helper criptografico', () => {
  it('el codigo que se guarda tiene 8 chars del alfabeto de metas', async () => {
    const sink = [];
    const out = await compartirMeta(sink);
    const [code] = codigosEscritos(sink);
    expect(code, 'no se escribio ningun invite_code').toBeDefined();
    expect(code).toHaveLength(8);
    expect([...code].every((ch) => ALFABETO_META.includes(ch))).toBe(true);
    // Y el link que ve el usuario lleva ESE código, no otro.
    expect(out).toContain('https://app.neto.pe/join/meta/' + code);
  });

  it('no depende de Math.random', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.42);
    const codes = [];
    for (let i = 0; i < 25; i++) {
      const sink = [];
      await compartirMeta(sink);
      codes.push(...codigosEscritos(sink));
    }
    expect(codes).toHaveLength(25);
    expect(new Set(codes).size).toBeGreaterThan(1);
  });

  /**
   * Si el update falla, el codigo NO queda en la base y `colaborativa` sigue en false,
   * pero el link se arma igual unas lineas mas abajo: el usuario reparte una URL
   * permanentemente muerta y nadie se entera. Clase `error-no-leido`. Lo marco la segunda
   * revision adversarial, sobre codigo que el commit anterior habia dejado intacto a 200
   * lineas de donde se felicitaba por cerrar esta misma clase.
   */
  it('si no se pudo guardar el codigo, NO reparte un link muerto', async () => {
    const sink = [];
    const out = await compartirMeta(sink, {
      errores: { 'metas_ahorro:update': { message: 'connection reset' } },
    });
    expect(out).toBe('No pude generar el link. Intenta de nuevo.');
    expect(out).not.toContain('app.neto.pe/join/meta/');
  });

  it('lo mismo si no se pudo registrar al creador como participante', async () => {
    const sink = [];
    const out = await compartirMeta(sink, {
      errores: { 'meta_participantes:upsert': { message: 'deadlock' } },
    });
    expect(out).toBe('No pude generar el link. Intenta de nuevo.');
  });

  /**
   * La meta que YA es colaborativa reparte el codigo que ya tenia. Regenerarlo invalidaria
   * los links que la gente ya recibio, y esa regresion pasaba verde: el fixture original
   * solo tenia `invite_code: null`, o sea que la rama del `if` solo se ejercitaba por un
   * lado.
   */
  it('una meta que ya tiene codigo no lo regenera', async () => {
    const sink = [];
    const out = await compartirMeta(sink, {
      meta: { ...META, invite_code: 'YaExiste', colaborativa: true },
    });
    expect(codigosEscritos(sink)).toEqual([]);
    expect(out).toContain('https://app.neto.pe/join/meta/YaExiste');
  });
});
