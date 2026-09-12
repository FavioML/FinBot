import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Los selects que alimentan una decisión sobre `bsuid` tienen que traer `bsuid` (12-sep-2026).
 *
 * Quien oculta su número tiene solo esa columna. Si el select la pierde, `usuario.bsuid` llega
 * `undefined` y dos cosas se rompen en silencio, sin que ningún test de comportamiento lo vea
 * (los dobles de Supabase devuelven la fila entera sin mirar las columnas pedidas):
 *   · los cortes `if (!usuario.whatsapp && !usuario.bsuid)` de `survey-triggers` dejan afuera a
 *     esa persona, que SÍ recibe WhatsApp;
 *   · el `channel` del ledger se anota `in_app` mientras `enviarWhatsapp` igual le manda el
 *     WhatsApp (lo resuelve por `usuarioId`), y la anti-fatiga lee el canal equivocado.
 *
 * La revisión adversarial quitó `bsuid` de los dos selects con la suite entera en verde. Es la
 * regla "una fila parcial no puede decidir" de `app/CLAUDE.md`, fijada donde se rompió.
 */

const RAIZ = process.cwd();
const leer = (rel) => readFileSync(join(RAIZ, rel), 'utf-8');

/** El cuerpo de una función de primer nivel, hasta la siguiente. */
function cuerpo(src, nombre) {
  const i = src.search(new RegExp(String.raw`^(?:async\s+)?function\s+${nombre}\s*\(`, 'm'));
  expect(i, `no se encontró ${nombre}: actualiza este test`).toBeGreaterThan(-1);
  const resto = src.slice(i + 1);
  const fin = resto.search(/^(?:async\s+)?function\s+\w+\s*\(/m);
  return fin === -1 ? src.slice(i) : src.slice(i, i + 1 + fin);
}

const SELECT_CON_BSUID = /\.select\(\s*'[^']*\bbsuid\b[^']*'/;

describe('los selects que deciden por bsuid lo traen', () => {
  it.each([
    ['services/survey-triggers.js', 'checkSurveyTriggers', 'alimenta los cortes y el canal de los triggers'],
    ['cron/checks.js', 'checkUpsellPro', 'alimenta el canal del upsell'],
  ])('%s · %s', (rel, fn, _motivo) => {
    expect(cuerpo(leer(rel), fn)).toMatch(SELECT_CON_BSUID);
  });

  // Los consumidores siguen leyendo `bsuid`. Si un día dejan de hacerlo, este archivo sobra y lo
  // dice, en vez de exigir una columna que ya nadie mira.
  it('los consumidores siguen leyendo usuario.bsuid', () => {
    expect(leer('services/survey-triggers.js')).toMatch(/usuario\.bsuid/);
    expect(cuerpo(leer('cron/checks.js'), 'checkUpsellPro')).toMatch(/usuario\.bsuid/);
  });

  it('contraprueba: el patrón no acepta un select sin bsuid', () => {
    expect(".select('id, whatsapp, nombre')").not.toMatch(SELECT_CON_BSUID);
    expect(".select('id, whatsapp, bsuid, nombre')").toMatch(SELECT_CON_BSUID);
  });
});
