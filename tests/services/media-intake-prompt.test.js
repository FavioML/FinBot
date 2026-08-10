import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptVision } from '../../services/media-intake.js';

/**
 * B15 (auditoría 10-ago-2026): el prompt de Vision fijaba `"moneda":"PEN"` como LITERAL, así
 * que toda captura en dólares entraba como soles. No hay señal de que eso pase: el modelo
 * devuelve lo único que el esquema le permite, `guardarTransaccion` copia el monto a `monto_pen`
 * a la par 1:1, y la respuesta que ve el usuario también dice soles. Un consumo de US$40 queda
 * anotado como S/40 sin que nada chille.
 *
 * `services/media-intake.js` es la ÚNICA copia del prompt de Vision, y es quien decide el monto
 * en el camino donde el usuario NO recibe respuesta (registro silencioso, BSUID). Ahí una
 * divergencia de plata no tiene quien la delate — por eso la regla se fija con un test y no con
 * una revisión.
 *
 * Los tres primeros casos son sobre ESTE prompt. El cuarto es sobre la clase: ningún prompt del
 * backend puede volver a fijar la moneda a un solo valor.
 */

const RAIZ = join(import.meta.dirname, '..', '..');
const PROMPT = promptVision('2026-08-10');

describe('promptVision: la moneda es una decisión, no una constante', () => {
  it('declara el enum PEN|USD en el esquema, no un literal', () => {
    expect(PROMPT).toContain('"moneda":"PEN"|"USD"');
    // El literal exacto que causó el bug. Se prohíbe la forma, no solo se exige la buena: sin
    // esto, alguien podría dejar las dos y el modelo seguiría viendo un esquema contradictorio.
    expect(PROMPT).not.toContain('"moneda":"PEN",');
  });

  it('trae la regla de moneda: los símbolos mandan', () => {
    expect(PROMPT).toContain('REGLA CRÍTICA DE MONEDA');
    expect(PROMPT).toMatch(/"\$".*→?.*USD|USD.*"\$"/s);
    expect(PROMPT).toMatch(/S\//);
  });

  it('el default sigue siendo PEN, y Yape/Plin no admiten dólares', () => {
    // Es la mitad que protege el caso mayoritario. Abrir el enum sin anclar el default
    // convierte un "S/" mal leído en un gasto en dólares, o sea cambia un error raro por uno
    // frecuente: Yape y Plin son el grueso de este camino y operan solo en soles.
    expect(PROMPT).toMatch(/Por DEFECTO moneda="PEN"/);
    expect(PROMPT).toMatch(/Yape y Plin operan ÚNICAMENTE en soles/);
  });

  it('ningún prompt del backend fija la moneda a un solo valor', () => {
    // La clase, no la instancia. `parsers.js` ya tenía el enum en sus dos prompts; el de Vision
    // se quedó atrás porque nació aparte. El barrido incluye a los tres.
    const archivos = ['services/media-intake.js', 'services/parsers.js'];
    const malos = [];
    for (const rel of archivos) {
      const src = readFileSync(join(RAIZ, rel), 'utf8');
      // Un `"moneda":"XXX"` que NO sea el enum: cualquier valor único clavado en el esquema.
      for (const m of src.matchAll(/"moneda"\s*:\s*"(\w+)"(?!\s*\|)/g)) {
        malos.push(rel + ' → "moneda":"' + m[1] + '"');
      }
    }
    expect(
      malos,
      'Estos prompts fijan la moneda a un solo valor:\n' + malos.map((m) => '  - ' + m).join('\n') +
      '\n\nUsá `"moneda":"PEN"|"USD"`. Con un literal el modelo no puede reportar la otra ' +
      'moneda ni equivocándose, así que el error entra silencioso y a la par 1:1 (B15).',
    ).toEqual([]);
  });
});
