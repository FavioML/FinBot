import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NETO_TOOLS, mapToolToIntent } = require('../../handlers/neto-tools.js');

/**
 * El puente entre lo que el MODELO emite y lo que el HANDLER lee.
 *
 * `query_expenses` nombra `query` al texto de búsqueda (action=search) y reserva `comercio` para
 * action=frequency. El handler de `buscar_gasto` lee `datos.comercio`. Sin una entrada en
 * `PROPERTY_REMAP` los dos nombres nunca se tocan: el modelo llenaba `query`, el handler leía
 * `comercio`, y la búsqueda por comercio en WhatsApp NUNCA funcionó.
 *
 * Lo que hace a este bug invisible es la forma de la falla. No lanza, no loguea, no deja fila:
 * contesta "Dime el comercio o servicio", que se lee como una petición de aclaración legítima.
 * El usuario reformula, recibe lo mismo, y a los cinco intentos concluye que el producto está
 * roto. Encontrado el 25-ago-2026 en la conversación de un cliente que hizo exactamente eso.
 *
 * El primer test es el caso. El segundo es la CLASE: el remap solo sirve si el nombre de origen
 * existe de verdad en el schema de la tool. Un remap que apunta a un parámetro inexistente es
 * un no-op silencioso, o sea el mismo bug con otra cara.
 */

const paramsDe = (tool) => {
  const t = NETO_TOOLS.find((x) => x.function.name === tool);
  return Object.keys((t && t.function.parameters && t.function.parameters.properties) || {});
};

describe('query_expenses.search entrega el comercio que el handler lee', () => {
  it('traduce query -> comercio', () => {
    const { intencion, datos } = mapToolToIntent('query_expenses', { action: 'search', query: 'Renzo Costa' });
    expect(intencion).toBe('buscar_gasto');
    expect(datos.comercio).toBe('Renzo Costa');
  });

  it('el nombre viejo no sobrevive al remap', () => {
    // Si quedaran los dos, un handler que lea `query` seguiría "funcionando" y taparía la
    // divergencia el día que alguien la reintroduzca.
    const { datos } = mapToolToIntent('query_expenses', { action: 'search', query: 'Uber' });
    expect(datos.query).toBeUndefined();
  });

  it('no le inventa comercio a una búsqueda vacía', () => {
    // El mensaje de ayuda tiene que seguir existiendo para el caso en que de verdad no hay texto.
    const { datos } = mapToolToIntent('query_expenses', { action: 'search' });
    expect(datos.comercio).toBeUndefined();
  });

  it('no toca las otras acciones de la misma tool', () => {
    // `frequency` ya usaba `comercio` directo: el remap es por (tool, action), no por tool.
    const { intencion, datos } = mapToolToIntent('query_expenses', { action: 'frequency', comercio: 'Uber' });
    expect(intencion).toBe('ver_frecuencia_comercio');
    expect(datos.comercio).toBe('Uber');
  });
});

describe('todo remap declarado apunta a un parámetro que la tool realmente emite', () => {
  it('ningún origen de PROPERTY_REMAP es un nombre inexistente', () => {
    // Se reconstruye el remap desde el comportamiento observable (no está exportado): para cada
    // tool.action se manda cada parámetro del schema por separado y se mira con qué nombre sale.
    // Excepcion NOMINAL, no una regla laxa: `yo_debo` es un booleano que el codigo especial de
    // `manage_debts.register` convierte en `datos.tipo` ('debo' | 'me_deben'). El valor no se
    // pierde, se TRANSFORMA, y por eso la sonda no lo reencuentra. Se lista uno por uno a
    // proposito: si manana otro par empieza a tragarse un parametro, este test lo dice.
    const TRANSFORMADOS = new Set(['manage_debts.register.yo_debo']);
    const malos = [];
    for (const t of NETO_TOOLS) {
      const tool = t.function.name;
      const props = t.function.parameters.properties || {};
      const acciones = (props.action && props.action.enum) || [null];
      for (const action of acciones) {
        for (const p of paramsDe(tool)) {
          if (p === 'action') continue;
          const args = action ? { action, [p]: '__probe__' } : { [p]: '__probe__' };
          const { datos } = mapToolToIntent(tool, args);
          const salio = Object.entries(datos).find(([, v]) => v === '__probe__');
          // El valor tiene que sobrevivir con ALGÚN nombre. Si desaparece, el remap lo renombró
          // a algo y después lo borró, o el mapeo lo perdió: en los dos casos el handler no lo ve.
          if (!salio && !TRANSFORMADOS.has(`${tool}.${action}.${p}`)) {
            malos.push(`${tool}.${action} → ${p} se pierde en el camino`);
          }
        }
      }
    }
    expect(malos, malos.join('\n')).toEqual([]);
  });
});
