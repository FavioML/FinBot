import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { construirNetoPrompt, PROMPT_PATH, PLACEHOLDERS, MARCA_CONTEXTO, RAW_PROMPT } = require('../../lib/neto-prompt.js');

// Regresión: durante meses message-processor.js leyó el prompt desde handlers/ (ruta
// inexistente) y el ENOENT caía en un catch silencioso → producción usaba un fallback de
// una línea. Estos tests fallan si la ruta o el contrato de placeholders se vuelve a romper.
describe('lib/neto-prompt', () => {
  it('el archivo fuente existe en docs/ y es el prompt completo, no un fallback', () => {
    expect(fs.existsSync(PROMPT_PATH)).toBe(true);
    expect(PROMPT_PATH.replace(/\\/g, '/')).toContain('/docs/NETO_system_prompt.txt');
    expect(RAW_PROMPT.length).toBeGreaterThan(10000);
    expect(RAW_PROMPT).toContain('SYSTEM PROMPT MAESTRO');
  });

  it('declara todos los placeholders que el código inyecta', () => {
    for (const p of PLACEHOLDERS) expect(RAW_PROMPT).toContain('{' + p + '}');
  });

  it('inyecta los datos del usuario y no deja variables sin resolver', () => {
    const prompt = construirNetoPrompt({
      nombre: 'Favio', plan: 'pro', mesesHistorial: 12, ultimaSync: '20/7/2026',
    });
    const bloque = prompt.slice(prompt.indexOf(MARCA_CONTEXTO));
    expect(bloque).toContain('Nombre: Favio');
    expect(bloque).toContain('Plan: pro');
    expect(bloque).toContain('Historial disponible: 12 meses');
    expect(bloque).toContain('Última sincronización: 20/7/2026');
    expect(bloque).toContain('BCP');
    // Ningún {ALGO} sin cablear en el bloque de contexto dinámico.
    expect(bloque.match(/\{[A-Z_]+\}/g)).toBeNull();
  });

  it('aplica defaults sensatos cuando faltan datos del usuario', () => {
    const bloque = construirNetoPrompt({}).slice(RAW_PROMPT.indexOf(MARCA_CONTEXTO));
    expect(bloque).toContain('Nombre: amigo');
    expect(bloque).toContain('Plan: free');
    expect(bloque.match(/\{[A-Z_]+\}/g)).toBeNull();
  });

  it('no duplica el archivo fuera de docs/', () => {
    expect(fs.existsSync(new URL('../../handlers/NETO_system_prompt.txt', import.meta.url))).toBe(false);
  });
});
