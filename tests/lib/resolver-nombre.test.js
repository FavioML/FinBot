import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  resolverNombre, filasQueNombra, nombresParecidos, patronAmplio, listaNombres, mensajeNoResuelto, PALABRAS_DEL_DOMINIO,
} = require('../../lib/resolver-nombre');

/**
 * La regla de lib/resolver-nombre.js (decidida por Favio el 02-oct-2026), pieza por pieza. Los
 * casos por handler, con la base filtrando de verdad, viven en tests/handlers/resolucion-de-filas.
 */
const nd = { nombreDe: (f) => f.n };
const filas = (...nombres) => nombres.map((n, i) => ({ id: i, n }));

describe('resolverNombre', () => {
  it('un nombre que no coincide con ninguna fila es "ninguno", y lista lo que hay', () => {
    expect(resolverNombre('moto', filas('Laptop', 'Viaje Cusco'), nd)).toEqual({ estado: 'ninguno', disponibles: ['Laptop', 'Viaje Cusco'] });
  });

  it('por palabra ENTERA: "Luis" no es "Luisa", "lina" no es "gasolina"', () => {
    expect(resolverNombre('Luis', filas('Luisa'), nd).estado).toBe('ninguno');
    expect(resolverNombre('lina', filas('Gasolina', 'Medicina Catalina'), nd).estado).toBe('ninguno');
    expect(resolverNombre('Ana', filas('Mariana'), nd).estado).toBe('ninguno');
  });

  it('todas las palabras clave del nombre dicho, no alguna', () => {
    expect(resolverNombre('viaje europa', filas('Viaje Cusco'), nd).estado).toBe('ninguno');
    expect(resolverNombre('viaje cusco', filas('Viaje a Cusco 2027'), nd)).toMatchObject({ estado: 'uno', nombre: 'Viaje a Cusco 2027' });
  });

  it('la exacta NO tiene prioridad: "Uber" con Uber y Uber Eats son dos nombres y pregunta (cuarta vuelta)', () => {
    expect(resolverNombre('uber', filas('Uber Eats', 'Uber'), nd)).toEqual({ estado: 'varios', nombres: ['Uber Eats', 'Uber'] });
    expect(resolverNombre('juan', filas('Juan', 'Juan Jr'), nd).estado).toBe('varios');
  });

  it('sin exacta, una sola por palabra: "uber" con solo Uber Eats', () => {
    expect(resolverNombre('uber', filas('Uber Eats'), nd)).toMatchObject({ estado: 'uno', nombre: 'Uber Eats' });
  });

  it('varios nombres distintos por palabra: "varios", con los nombres', () => {
    expect(resolverNombre('luis', filas('Luis Pérez', 'Luis Soto'), nd)).toEqual({ estado: 'varios', nombres: ['Luis Pérez', 'Luis Soto'] });
  });

  it('varias filas del MISMO nombre (mayúsculas, tildes, espacios) son "uno", en el orden recibido', () => {
    const r = resolverNombre('juan', [{ id: 'a', n: 'Juan' }, { id: 'b', n: ' juan ' }, { id: 'c', n: 'JUÁN' }], nd);
    expect(r.estado).toBe('uno');
    expect(r.filas.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('tildes y mayúsculas no importan; la "s" final SÍ distingue ("Lucas" no es Luca, "taxis" no es Taxi)', () => {
    expect(resolverNombre('cafe haiti', filas('Café Haití'), nd).estado).toBe('uno');
    // Revisión de 469e728: tolerar la "s" abonaba a Luca lo que pagó Lucas. El costo es "taxis".
    expect(resolverNombre('Lucas', filas('Luca'), nd).estado).toBe('ninguno');
    expect(resolverNombre('taxis', filas('Taxi'), nd).estado).toBe('ninguno');
  });

  it('la palabra corta también distingue: "Carlos M" no es Carlos R, "viaje a NY" no es Viaje Cusco', () => {
    expect(resolverNombre('Carlos M', filas('Carlos R'), nd).estado).toBe('ninguno');
    expect(resolverNombre('viaje a NY', filas('Viaje Cusco'), { ...nd, ignorar: PALABRAS_DEL_DOMINIO.meta }).estado).toBe('ninguno');
  });

  it('en un comercio o una persona "mi" es parte del nombre; solo se quitan los artículos del inicio', () => {
    expect(resolverNombre('mi banco', filas('Banco Pichincha'), nd).estado).toBe('ninguno');
    expect(filasQueNombra('Mi Banco', filas('Mi Banco', 'Banco Pichincha'), nd).map((f) => f.n)).toEqual(['Mi Banco']);
    expect(resolverNombre('el uber', filas('Uber'), nd)).toMatchObject({ estado: 'uno', nombre: 'Uber' });
  });

  it('las palabras del dominio no cuentan: "meta laptop" es Laptop; "la meta" sola es sin nombre', () => {
    const o = { ...nd, ignorar: PALABRAS_DEL_DOMINIO.meta };
    expect(resolverNombre('meta laptop', filas('Laptop', 'Viaje'), o)).toMatchObject({ estado: 'uno', nombre: 'Laptop' });
    expect(resolverNombre('la meta', filas('Laptop', 'Viaje'), o).estado).toBe('sin_nombre');
  });

  it('"meta viaje" cuenta como "viaje" (sin la palabra del dominio): con solo Viaje es Viaje, con Viaje Europa pregunta', () => {
    const o = { ...nd, ignorar: PALABRAS_DEL_DOMINIO.meta };
    expect(resolverNombre('meta viaje', filas('Viaje', 'Laptop'), o)).toMatchObject({ estado: 'uno', nombre: 'Viaje' });
    expect(resolverNombre('meta viaje', filas('Viaje Europa', 'Viaje'), o).estado).toBe('varios');
  });

  it('una meta que SE LLAMA como una palabra del dominio se encuentra por exacta', () => {
    const o = { ...nd, ignorar: PALABRAS_DEL_DOMINIO.meta };
    expect(resolverNombre('ahorro', filas('Ahorro', 'Viaje'), o)).toMatchObject({ estado: 'uno', nombre: 'Ahorro' });
  });

  it('sin nombre (null, vacío, solo puntuación) es "sin_nombre" con todas las filas', () => {
    for (const d of [null, undefined, '', '  ', '¿?']) expect(resolverNombre(d, filas('A', 'B'), nd)).toMatchObject({ estado: 'sin_nombre' });
  });
});

describe('filasQueNombra (lotes)', () => {
  it('exactas y por palabra, nunca por subcadena', () => {
    const r = filasQueNombra('lina', filas('Lina', 'Lina Salon', 'Gasolina', 'Medicina Catalina'), nd);
    expect(r.map((f) => f.n)).toEqual(['Lina', 'Lina Salon']);
  });
  it('pedidosya alcanza sus variantes, con asterisco y mayúsculas', () => {
    expect(filasQueNombra('pedidosya', filas('PEDIDOSYA*PLUS', 'Pedidosya Chifa', 'Rappi'), nd)).toHaveLength(2);
  });
});

describe('patronAmplio', () => {
  it('la palabra clave más larga, sin "s" final ni tildes, como clase POSIX', () => {
    expect(patronAmplio('Café tacos')).toBe("t['’´`]?[aáàâä]['’´`]?c['’´`]?[oóòôö]");
    expect(new RegExp(patronAmplio('donofrio'), 'i').test("D'Onofrio")).toBe(true);
    expect(new RegExp(patronAmplio('cafe'), 'i').test('Café Haití')).toBe(true);
    expect(new RegExp(patronAmplio('taxis'), 'i').test('Taxi')).toBe(true);
  });
  it('sin letras ni dígitos no hay patrón; un comodín no pasa como comodín', () => {
    expect(patronAmplio('***')).toBeNull();
    expect(patronAmplio('%')).toBeNull();
    expect(patronAmplio('IZI*BARBANEGRA')).not.toMatch(/[*%]/);
  });
});

describe('nombresParecidos y los textos', () => {
  it('ofrece lo que comparte alguna palabra, sin elegir', () => {
    expect(nombresParecidos('starbucks coffee', filas('Starbucks', 'Wong'), nd)).toEqual(['Starbucks']);
  });
  it('listaNombres pone tope', () => {
    expect(listaNombres(['A', 'B', 'C'])).toBe('*A*, *B* y *C*');
    expect(listaNombres(['A', 'B', 'C', 'D'], 2)).toBe('*A*, *B* y 2 más');
  });
  it('"ninguno" dice que no cambió nada y NO trae una orden lista para copiar sobre otra fila', () => {
    const m = mensajeNoResuelto(resolverNombre('moto', filas('Laptop'), nd), { ninguna: 'ninguna meta', cosas: 'metas', dicho: 'moto', ejemplo: (n) => 'elimina la meta ' + n });
    expect(m).toMatch(/no cambié nada/);
    expect(m).not.toMatch(/elimina la meta Laptop/);
  });
});
