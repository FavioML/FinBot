import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * `separarMovimientos` sólo corta; no decide plata (07-oct-2026). Lo que se fija acá es el contrato
 * con quien lo llama: textos limpios, o null si el modelo no contestó, y un esquema que no tiene
 * dónde devolver monto, tipo ni moneda. Lo que le impide inventar o mover un verbo, una fecha o una
 * moneda vive en `handlers/registro-multiple.js` (`esVentanaDelMensaje`).
 */
let contenido = null;
const crear = vi.fn(async () => ({ choices: [{ message: { content: contenido } }] }));
require('../../lib/ai').openai.chat.completions.create = crear;
const { separarMovimientos } = require('../../services/parsers');

describe('separarMovimientos', () => {
  it('devuelve los textos recortados y descarta vacíos', async () => {
    contenido = JSON.stringify({ movimientos: [' pan 3 ', '', 'leche 5'] });
    expect(await separarMovimientos('pan 3 leche 5')).toEqual(['pan 3', 'leche 5']);
  });
  it('null si el modelo no contestó', async () => {
    contenido = null;
    expect(await separarMovimientos('pan 3 leche 5')).toBeNull();
  });
  it('el esquema sólo admite textos: ni monto, ni tipo, ni moneda', async () => {
    contenido = JSON.stringify({ movimientos: [] });
    await separarMovimientos('x');
    const esquema = crear.mock.calls.at(-1)[0].response_format.json_schema.schema;
    expect(Object.keys(esquema.properties)).toEqual(['movimientos']);
    expect(esquema.properties.movimientos.items).toEqual({ type: 'string' });
  });
});
