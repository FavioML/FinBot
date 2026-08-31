import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

/**
 * EL CONTEO DEL MURO, CUANDO NO SE PUEDE CONTAR.
 *
 * `handlers/muro-gate.js` hacia `const { count } = await supabase...` y su docblock afirmaba
 * que "si la consulta del conteo falla, el error sube". No subia: supabase-js no lanza. El
 * `count` quedaba null, y null en `mensajeMuro` elegia la rama que dice *"se activan cuando
 * registres tu **primer** gasto"* a alguien que ya anoto decenas.
 *
 * Lo que lo vuelve un caso de manual: su GEMELO ya estaba arreglado. La misma query, en la
 * cascada de comandos `/` de `handlers/webhook.js`, lee su `{ error }` y loguea con tag MURO
 * desde el 26-ago-2026. Este call-site se quedo atras porque vive en la costura entre los dos
 * guards que barren lecturas mudas: el de 9B mira `handlers/intents/` y
 * `tests/cron/lecturas-leen-el-error.test.js` mira `cron/checks.js` + el cierre transitivo de
 * `services/`. `handlers/*.js` a secas no lo mira ninguno.
 *
 * ALCANCE MEDIDO (31-ago-2026), porque la rama del mensaje no es hipotetica: hay **19 usuarios
 * reales, free, con `trial_estado` NULL y transacciones, con un maximo de 63**. Todos free, o
 * sea todos del lado del muro. Un hipo del conteo le afirma a esa persona que le falta el
 * primer gasto.
 *
 * LO QUE ESTE ARCHIVO TIENE QUE PODER DISTINGUIR:
 *   1. que el error se LEA (warn con tag MURO), y no que lo tape el ruido de otro tag;
 *   2. que NO se loguee cuando la lectura sale bien (si no, el caso 1 pasa por cualquier warn);
 *   3. que el cartel salga IGUAL (degradar no es callarse: el gate ya decidio arriba);
 *   4. que el texto degrade a la forma neutra, y solo cuando el conteo fallo.
 *
 * LO QUE NO CUBRE, DECLARADO: el gate en si (de quien muere en el muro se ocupa
 * `tests/handlers/muro-dispatch.test.js`, por call-site). Aca la decision ya esta tomada.
 */

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const analyticsMock = { capture: vi.fn(), shutdown: vi.fn() };
for (const [rel, exports] of [
  ['lib/db.js', { supabase: {} }],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn() }],
  ['lib/analytics.js', analyticsMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { respuestaMuroSiCorresponde } = require('../../handlers/muro-gate');

// Free y sin trial: la fila EXACTA de los 19 medidos. `trial_estado: null` es "nunca tuvo
// prueba" y es la unica rama de `mensajeMuro` que recita primer/proximo.
const EN_MURO = { id: 'u-muro', nombre: 'Favio Mendoza', plan: 'free', trial_estado: null };
const INTENCION = 'ver_reporte';   // esta en INTENTS_LECTURA

// El conteo es la UNICA query del gate, asi que un doble minimo alcanza y no esconde nada.
function ctxCon(resultado) {
  const llamadas = [];
  return {
    llamadas,
    ctx: {
      supabase: {
        from(tabla) {
          llamadas.push(tabla);
          return { select: () => ({ eq: () => Promise.resolve(resultado) }) };
        },
      },
    },
  };
}

const warnsDelMuro = () => logMock.warn.mock.calls.filter((c) => c[0] && c[0].tag === 'MURO');

beforeEach(() => {
  logMock.warn.mockClear();
  logMock.error.mockClear();
  analyticsMock.capture.mockClear();
});

describe('muro-gate: el conteo que no se puede leer', () => {
  it('ANTIVACUIDAD: el fixture entra al muro de verdad', async () => {
    const { ctx, llamadas } = ctxCon({ count: 7, error: null });
    const resp = await respuestaMuroSiCorresponde({ intencion: INTENCION, usuario: EN_MURO, ctx });
    // Sin esto, todo lo de abajo pasaria por elevacion el dia que el intent salga de
    // INTENTS_LECTURA o que `estaEnMuro` cambie de criterio: el gate devolveria null y
    // "no hubo warn" seria trivialmente cierto.
    expect(resp, 'el gate dejo pasar: el fixture ya no esta en el muro').not.toBeNull();
    expect(llamadas, 'el gate ni consulto el conteo').toContain('transacciones');
  });

  it('lee el error del conteo y lo loguea con tag MURO', async () => {
    const { ctx } = ctxCon({ count: null, error: { message: 'timeout en el conteo' } });
    await respuestaMuroSiCorresponde({ intencion: INTENCION, usuario: EN_MURO, ctx });
    const mios = warnsDelMuro();
    expect(mios.length, 'ningun warn con tag MURO: el { error } volvio a descartarse').toBe(1);
    expect(JSON.stringify(mios)).toContain('timeout en el conteo');
    expect(mios[0][0].usuarioId).toBe('u-muro');
  });

  it('NO loguea cuando el conteo sale bien', async () => {
    const { ctx } = ctxCon({ count: 40, error: null });
    await respuestaMuroSiCorresponde({ intencion: INTENCION, usuario: EN_MURO, ctx });
    // El control negativo del caso anterior: sin esto, un warn de cualquier otra causa
    // dentro del gate haria pasar al de arriba sin que nadie lea el error del conteo.
    expect(warnsDelMuro(), 'warn con tag MURO sin que haya fallado nada').toHaveLength(0);
  });

  it('el cartel del muro sale igual aunque el conteo falle', async () => {
    const { ctx } = ctxCon({ count: null, error: { message: 'boom' } });
    const resp = await respuestaMuroSiCorresponde({ intencion: INTENCION, usuario: EN_MURO, ctx });
    // Degradar no es callarse. Si alguien "completa" el arreglo con un throw o un return
    // null, el que esta en el muro se queda sin ninguna explicacion, o peor: pasa gratis.
    expect(typeof resp).toBe('string');
    expect(resp).toContain('Neto Pro');
    expect(analyticsMock.capture, 'se perdio el evento del muro').toHaveBeenCalled();
  });

  it('con el conteo caido el texto no afirma un numero: dice "un gasto"', async () => {
    const { ctx } = ctxCon({ count: null, error: { message: 'boom' } });
    const resp = await respuestaMuroSiCorresponde({ intencion: INTENCION, usuario: EN_MURO, ctx });
    expect(resp).toContain('registres un gasto');
    // La mentira concreta que este item cerro, sobre 19 usuarios reales.
    expect(resp, 'le sigue diciendo "primer gasto" a quien ya anoto decenas').not.toContain('primer gasto');
  });

  it('y NO degrada cuando el conteo se pudo leer', async () => {
    // El complemento del anterior: si `undefined` se propagara siempre, el texto neutro
    // taparia el caso bueno y el test de arriba pasaria por la razon equivocada.
    const cero = ctxCon({ count: 0, error: null });
    expect(await respuestaMuroSiCorresponde({ intencion: INTENCION, usuario: EN_MURO, ctx: cero.ctx }))
      .toContain('tu primer gasto');

    const siete = ctxCon({ count: 7, error: null });
    expect(await respuestaMuroSiCorresponde({ intencion: INTENCION, usuario: EN_MURO, ctx: siete.ctx }))
      .toContain('tu próximo gasto');
  });
});
