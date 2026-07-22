import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const APP = path.join(import.meta.dirname, '..', '..');

// Usuario sano de referencia: dentro de presupuesto y ahorrando >20%.
const USUARIO_SANO = {
  gastos: [{ monto: 200, monto_pen: 200, categoria: 'Alimentación', fecha: '2026-07-05', tipo: 'gasto' }],
  ingresos: [{ monto: 3000, monto_pen: 3000 }],
  presupuestos: [{ categoria: 'Alimentación', monto_limite: 800, alerta_porcentaje: 80, mes: 7, anio: 2026 }],
};

// Stub de supabase donde SOLO la lectura indicada falla (null = todas sanas).
function stubSupabase(quiebra) {
  return {
    from(tabla) {
      const q = {
        _tipo: null,
        select() { return q; },
        eq(col, val) { if (col === 'tipo') q._tipo = val; return q; },
        gte() { return q; },
        lte() { return q; },
        order() { return q; },
        then(resolve) {
          const err = { message: 'read timeout' };
          if (tabla === 'presupuestos') {
            return resolve(quiebra === 'presupuestos'
              ? { data: null, error: err } : { data: USUARIO_SANO.presupuestos, error: null });
          }
          if (q._tipo === 'ingreso') {
            return resolve(quiebra === 'ingresos'
              ? { data: null, error: err } : { data: USUARIO_SANO.ingresos, error: null });
          }
          return resolve(quiebra === 'gastos'
            ? { data: null, error: err } : { data: USUARIO_SANO.gastos, error: null });
        },
      };
      return q;
    },
  };
}

// require.cache: mismo patrón que tests/services/summaries.test.js.
function cargarConSupabase(quiebra) {
  const dbPath = require.resolve(path.join(APP, 'lib', 'db.js'));
  const recomPath = require.resolve(path.join(APP, 'services', 'recommendations.js'));
  const subsPath = require.resolve(path.join(APP, 'services', 'subscriptions'));
  delete require.cache[recomPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
    exports: { supabase: stubSupabase(quiebra) } };
  require.cache[subsPath] = { id: subsPath, filename: subsPath, loaded: true,
    exports: { detectarSuscripciones: async () => ({ suscripciones_detectadas: [], total_mensual_pen: 0, total_mensual_usd: 0 }) } };
  return require(recomPath);
}

// Regresión (2026-07-22): `services/recommendations.js` leía el prompt desde `prompts/`,
// directorio que dejó de existir en 7941cb0 (31-mar-2026, el archivo se movió a `docs/`).
// El ENOENT caía en `catch { return null }` y los dos call sites tenían fallback:
// `ver_recomendaciones` mostraba la mini-recomendación heurística y el resumen mensual
// omitía el bloque. `generarRecomendaciones` devolvió null en el 100% de las llamadas
// durante ~4 meses. Misma forma que 1a5da6e (system prompt) y 6b677cf (timeout en el body).
describe('prompt de recomendaciones', () => {
  it('todos los prompts que el backend lee viven donde el código los busca', () => {
    // Cubre la CLASE, no solo esta instancia: si alguien mueve un prompt sin tocar el
    // código, este test falla antes de que el fallback lo tape en producción.
    const { PROMPT_PATH } = require(path.join(APP, 'lib', 'neto-prompt.js'));
    const { PROMPT_RECOM_PATH } = require(path.join(APP, 'services', 'recommendations.js'));
    for (const p of [PROMPT_PATH, PROMPT_RECOM_PATH]) {
      expect(fs.existsSync(p), p + ' no existe').toBe(true);
      expect(fs.readFileSync(p, 'utf8').trim().length).toBeGreaterThan(1000);
    }
  });

  it('el prompt real llega al system message con los placeholders resueltos', async () => {
    const { generarRecomendaciones } = cargarConSupabase(null);
    const create = globalThis.__mockOpenAICreate;
    create.mockReset();
    create.mockResolvedValue({ choices: [{ message: { content: '{"mensaje_neto":"ok"}' } }] });

    const recom = await generarRecomendaciones('u1', 'Favio', 'on_demand_general');
    expect(recom).not.toBeNull();

    const [body] = create.mock.calls[0];
    const system = body.messages[0].content;
    // Contenido real del archivo, no un fallback de una línea.
    expect(system.length).toBeGreaterThan(1000);
    expect(system).toContain('{DATOS_USUARIO}'); // placeholder documental, se deja literal
    // Los 3 que el código sí inyecta no pueden quedar sin resolver.
    expect(system).not.toContain('{NOMBRE_USUARIO}');
    expect(system).not.toContain('{SCORE_ACTUAL}');
    expect(system).not.toContain('{SCORE_MES_ANTERIOR}');
    expect(system).toContain('Favio');
  });
});

// Regresión (2026-07-22): las 5 queries de `construirDatosUsuario` descartaban su `error`.
// El objeto resultante alimenta el 45% del Neto Score (budget 0.25 + savings 0.20), la
// viabilidad de metas y las alertas de fugas. Una lectura caída no hacía fallar el número:
// lo movía, y el cron de las 6am lo persistía. Es el mismo agujero que eea8d1c cerró en
// neto-score.js, por la puerta que dejó abierta.
describe('construirDatosUsuario ante una lectura caída', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('con todas las lecturas sanas devuelve los datos reales', async () => {
    const { construirDatosUsuario } = cargarConSupabase(null);
    const d = await construirDatosUsuario('u1');
    expect(d.mes_actual.ingresos).toBe(3000);
    expect(d.mes_actual.gastos).toBe(200);
    expect(d.presupuestos).toHaveLength(1);
  });

  for (const quiebra of ['gastos', 'ingresos', 'presupuestos']) {
    it('lanza si cae la lectura de ' + quiebra + ' (antes devolvía datos fabricados)', async () => {
      const { construirDatosUsuario } = cargarConSupabase(quiebra);
      await expect(construirDatosUsuario('u1')).rejects.toThrow(/No se pudieron leer los datos/);
    });
  }

  it('el score no se calcula sobre una lectura caída', async () => {
    // calcFactorBudget/calcFactorSavings consumen este objeto. Con `presupuestos` caído
    // el factor budget pasaba de 100 (dentro de presupuesto) a 50 (el "neutral" de
    // "no tiene presupuestos"), o sea -12.5 puntos de score persistidos como verdad.
    // Con `gastos` caído fallaba HACIA ARRIBA: savings 100 sobre alguien que se excedió.
    const { calcFactorBudget, calcFactorSavings } = require(path.join(APP, 'services', 'neto-score.js'));
    const sano = { presupuestos: [{ porcentaje_usado: 25 }], mes_actual: { ingresos: 3000, gastos: 200 } };
    const conLecturaCaida = { presupuestos: [], mes_actual: { ingresos: 0, gastos: 0 } };
    expect(calcFactorBudget(sano)).toBe(100);
    expect(calcFactorBudget(conLecturaCaida)).toBe(50);
    expect(calcFactorSavings(sano)).toBe(100);
    expect(calcFactorSavings(conLecturaCaida)).toBe(50);
    // Y el caso que falla hacia arriba: gastos caído sobre alguien que gasta de más.
    const gastador = { mes_actual: { ingresos: 3000, gastos: 4000 } };
    expect(calcFactorSavings(gastador)).toBeLessThan(20);
    expect(calcFactorSavings({ mes_actual: { ingresos: 3000, gastos: 0 } })).toBe(100);
  });
});
