import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildCategoriasCustomPrompt } = require('../../services/parsers');

/**
 * `buildCategoriasCustomPrompt` es la ÚNICA copia del bloque que le explica al modelo las
 * categorías propias del usuario, y desde B26 la usan los DOS clasificadores de categoría del
 * backend: `parsearCorreoBancario` (correos) y `detectarCategoriaIA` (gastos por WhatsApp).
 *
 * Se parametrizó el sustantivo para que el texto nombre bien lo que se está clasificando. El
 * riesgo de esa parametrización es cambiar sin querer el prompt de correos, que ya funcionaba:
 * estos tests fijan que **el default lo reproduce palabra por palabra**.
 */
describe('buildCategoriasCustomPrompt', () => {
  const CATS = [
    { nombre: 'Viajes', subcategorias: [{ nombre: 'vuelos' }, { nombre: 'hoteles' }] },
    { nombre: 'Deudas', subcategorias: [] },
  ];

  it('sin opciones reproduce el prompt de correos, con las frases exactas de antes', () => {
    const out = buildCategoriasCustomPrompt(CATS);
    // Las tres frases que llevaban la palabra "correo" antes de parametrizar.
    expect(out).toContain('Si alguna encaja mejor con el contexto del correo (especialmente para transferencias con mensaje), úsala EN LUGAR de la canónica.');
    expect(out).toContain('- Si el correo describe un viaje y el usuario tiene categoría "Viajes" custom → usa "Viajes" (no "Otros > viaje")');
    expect(out).toContain('- Si el correo describe deudas y el usuario tiene categoría "Deudas" custom → usa "Deudas" (no la canónica más cercana)');
    // Y el resto del bloque, que no se tocó.
    expect(out).toContain('CATEGORÍAS CUSTOM DEL USUARIO (PRIORIDAD SOBRE CANÓNICAS)');
    expect(out).toContain('- Viajes → vuelos | hoteles');
    expect(out).toContain('- Deudas (sin subcategorías)');
    expect(out).toContain('Solo cae a categoría canónica si NINGUNA custom encaja con el contexto');
    // ⚠️ Esta es la línea que se volvió opcional, y es la que faltaba: sin esta aserción,
    // quitársela al prompt de correos dejaba la suite ENTERA en verde (1140/1140, medido).
    // La única aserción que existía era la NEGATIVA del lado de gastos, y una negativa no
    // prueba que del otro lado siga estando.
    expect(out).toContain('- subcategoria debe ser una de las listadas para esa categoría custom; si no hay match exacto, usar "sin_categoria"');
  });

  it('con sustantivo "gasto" no queda ni una mención al correo', () => {
    const out = buildCategoriasCustomPrompt(CATS, { sustantivo: 'gasto', matiz: '' });
    expect(out).toContain('el contexto del gasto,');
    expect(out).toContain('- Si el gasto describe un viaje');
    expect(out).not.toContain('correo');
    expect(out).not.toContain('transferencias con mensaje');
  });

  it('el artículo va en la plantilla, no en el parámetro: nunca sale "de el"', () => {
    // El placeholder es el SUSTANTIVO pelado justamente por esto; pasar "el correo" produciría
    // "de el correo". Es el error que tuvo la primera versión.
    for (const sustantivo of ['correo', 'gasto', 'movimiento']) {
      const out = buildCategoriasCustomPrompt(CATS, { sustantivo });
      expect(out).not.toContain('de el ');
      expect(out).toContain('del ' + sustantivo);
    }
  });

  it('sin categorías devuelve string vacío (no un bloque hueco)', () => {
    expect(buildCategoriasCustomPrompt(null)).toBe('');
    expect(buildCategoriasCustomPrompt([])).toBe('');
    expect(buildCategoriasCustomPrompt(undefined, { sustantivo: 'gasto' })).toBe('');
  });

  it('tolera subcategorias ausente o con nombres vacíos', () => {
    const out = buildCategoriasCustomPrompt([
      { nombre: 'Mascotas' },
      { nombre: 'Regalos', subcategorias: [{ nombre: '' }, { nombre: 'cumpleaños' }] },
    ]);
    expect(out).toContain('- Mascotas (sin subcategorías)');
    expect(out).toContain('- Regalos → cumpleaños');
  });
});
