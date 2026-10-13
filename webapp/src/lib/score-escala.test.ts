import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getScoreColor, getScoreLabel } from './utils';

// El Neto Score se lee en tres sitios: el bot (services/neto-score.js), el dashboard y Reportes.
// Hasta el 12-oct-2026 había dos escalas en la webapp (3 y 4 tramos) y un 50 salía "Atención" en
// Reportes mientras el bot decía "Puede mejorar". La escala vive en lib/utils.ts y en ningún otro
// archivo de src/.

const BACKEND = join(process.cwd(), '..', 'services', 'neto-score.js');

function etiquetaDelBot(): (s: number) => string {
  const src = readFileSync(BACKEND, 'utf8');
  const m = src.match(/function scoreLabel\(score\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('services/neto-score.js ya no declara scoreLabel(score): revisa este test');
  return new Function(`${m[0]}; return scoreLabel;`)() as (s: number) => string;
}

describe('escala del Neto Score', () => {
  it('la etiqueta de la webapp es la misma que manda el bot, puntaje por puntaje', () => {
    const bot = etiquetaDelBot();
    for (let s = 0; s <= 100; s++) expect(getScoreLabel(s), `score ${s}`).toBe(bot(s));
  });

  it('cada etiqueta tiene su propio color', () => {
    const pares = new Map<string, Set<string>>();
    for (let s = 0; s <= 100; s++) {
      const l = getScoreLabel(s);
      if (!pares.has(l)) pares.set(l, new Set());
      pares.get(l)!.add(getScoreColor(s));
    }
    for (const [l, colores] of pares) expect([...colores], l).toHaveLength(1);
    expect(new Set([...pares.values()].map((c) => [...c][0])).size).toBe(pares.size);
  });

  it('ningún otro archivo de src/ arma su propia escala', () => {
    const SRC = join(process.cwd(), 'src');
    const archivos = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? archivos(p) : /\.tsx?$/.test(n) && !n.endsWith('.test.ts') ? [p] : [];
      });
    // Un umbral del score (>= 80 / 60 / 40) pegado a un color o a una etiqueta del score. Se ancla a
    // un nombre con "score" para no confundir otros porcentajes (el cupo OAuth de /admin/producto).
    const escala = /\b\w*score\w*\s*>=\s*(?:80|60|40)\s*\)?\s*(?:\?|return)\s*'(?:var\(--(?:positive|primary|info|warning|negative)\)|Excelente|En camino|Puede mejorar|Atención)'/i;
    const fuera = archivos(SRC)
      .map((p) => relative(SRC, p).split('\\').join('/'))
      .filter((r) => r !== 'lib/utils.ts' && escala.test(readFileSync(join(SRC, r), 'utf8')));
    expect(fuera).toEqual([]);
  });
});
