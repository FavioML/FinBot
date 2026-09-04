import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { construirNetoPrompt, PROMPT_PATH, PLACEHOLDERS, MARCA_CONTEXTO, RAW_PROMPT } = require('../../lib/neto-prompt.js');

// Regresión: durante meses message-processor.js leyó el prompt desde handlers/ (ruta
// inexistente) y el ENOENT caía en un catch silencioso → producción usaba un fallback de
// una línea. Estos tests fallan si el contrato de placeholders se vuelve a romper o si el
// archivo deja de ser el prompt real.
//
// DÓNDE vive el archivo NO se afirma acá, y es deliberado. Hasta el 04-sep-2026 este bloque
// exigía que la ruta contuviera '/docs/NETO_system_prompt.txt', o sea que fijaba como
// correcta la única ubicación desde la que editar el prompt NO redesplegaba el backend
// (`railway.json` excluye `docs/**`): el test no solo no atrapó ese bug, lo blindó.
// Reescribirlo con '/prompts/' habría sido el mismo error con otra cadena. La ubicación la
// vigila `tests/runtime-desplegable.test.js`, que deriva la respuesta de `railway.json` en
// vez de escribirla a mano.
describe('lib/neto-prompt', () => {
  it('el archivo fuente existe y es el prompt completo, no un fallback', () => {
    expect(fs.existsSync(PROMPT_PATH)).toBe(true);
    expect(RAW_PROMPT.length).toBeGreaterThan(10000);
    expect(RAW_PROMPT).toContain('SYSTEM PROMPT MAESTRO');
  });

  it('declara todos los placeholders que el código inyecta', () => {
    for (const p of PLACEHOLDERS) expect(RAW_PROMPT).toContain('{' + p + '}');
  });

  it('inyecta los datos del usuario y no deja variables sin resolver', () => {
    const prompt = construirNetoPrompt({
      nombre: 'Favio', plan: 'pro', mesesHistorial: 12, ultimaSync: '20/7/2026', correoConectado: true,
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

  // 68 de 74 usuarios reales no tienen correo conectado (jul 2026). Afirmarles que leemos
  // sus correos los deja creyendo que están cubiertos mientras nada se registra.
  describe('modo de ingesta según el correo del usuario', () => {
    it('sin correo conectado: prohíbe afirmar que lee correos y no lista parsers', () => {
      const p = construirNetoPrompt({ nombre: 'Ana', correoConectado: false });
      expect(p).toContain('NO tiene su correo conectado');
      expect(p).toMatch(/NUNCA le digas que lees sus correos/);
      expect(p).toContain('Parsers activos: ninguno');
      expect(p).toContain('Última sincronización: no aplica');
      // La afirmación categórica original no puede sobrevivir en ninguna forma.
      expect(p).not.toMatch(/Lees automáticamente\s+sus correos/);
    });

    it('con correo conectado: sí afirma la lectura automática y lista los bancos', () => {
      const p = construirNetoPrompt({ nombre: 'Ana', correoConectado: true, ultimaSync: '21/7/2026' });
      expect(p).toMatch(/lees automáticamente/i);
      expect(p).toContain('Parsers activos: BCP, Interbank, BBVA, Scotiabank, Yape, Plin');
      expect(p).toContain('Última sincronización: 21/7/2026');
      expect(p).not.toContain('NO tiene su correo conectado');
    });

    it('sin el flag asume el caso conservador (sin correo)', () => {
      // Un call site que olvide pasar correoConectado no puede terminar mintiéndole al usuario.
      for (const datos of [{}, { correoConectado: undefined }, { correoConectado: 'sí' }]) {
        expect(construirNetoPrompt(datos)).toContain('NO tiene su correo conectado');
      }
    });
  });

  it('no duplica el archivo fuera de prompts/', () => {
    expect(fs.existsSync(new URL('../../handlers/NETO_system_prompt.txt', import.meta.url))).toBe(false);
  });
});
