import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolverCategoriaPersistida } = require('../../services/categories');
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = require('../../lib/constants');

/**
 * B28: una categoría CUSTOM no sobrevivía al camino de WhatsApp.
 *
 * `guardarTransaccion` aplicaba `normalizarCategoria` a secas, que manda a `'Otros'` todo lo
 * que el mapa canónico no resuelve. La webapp NO normaliza. Así que el usuario se creaba
 * "Comida casera", la veía en `/categorias`, la usaba desde la app — y sus gastos por
 * WhatsApp caían en Otros. Los dos canales divergían sobre la MISMA columna, que es la que
 * alimenta reportes, presupuestos y score.
 *
 * ⚠️ La primera versión de esta función CONSULTABA el árbol del usuario ("solo respeto el
 * nombre crudo si ya tiene esa raíz") y por eso este archivo tenía un mock de Supabase. Una
 * revisión adversarial la tiró abajo: la raíz la crea `asegurarCategoriaUsuario` en
 * fire-and-forget justo antes, así que el PRIMER gasto de cada categoría custom perdía la
 * carrera y caía en Otros mientras el segundo persistía el nombre — el mismo concepto en dos
 * buckets. Y el árbol no filtraba nada, porque se alimenta del mismo string.
 *
 * Que esta función sea PURA es la propiedad que lo cierra, y por eso el archivo ya no
 * mockea nada: si vuelve a necesitar un mock de DB, alguien reintrodujo la carrera.
 */

describe('B28 — la categoría custom sobrevive al camino de WhatsApp', () => {
  it('una custom se persiste tal cual', () => {
    expect(resolverCategoriaPersistida('Comida casera')).toBe('Comida casera');
  });

  it('es determinística: la misma entrada da lo mismo siempre', () => {
    // El bug que reemplazó a este fix era justo éste: el resultado dependía de si otra
    // promesa había terminado. Diez llamadas seguidas tienen que dar diez veces lo mismo.
    const salidas = new Set(Array.from({ length: 10 }, () => resolverCategoriaPersistida('Comida casera')));
    expect([...salidas]).toEqual(['Comida casera']);
  });

  it('las canónicas no cambian de comportamiento', () => {
    for (const c of CATEGORIAS_VALIDAS) expect(resolverCategoriaPersistida(c)).toBe(c);
  });

  it('TODA clave de CATEGORIA_MAP sigue resolviéndose por el mapa', () => {
    // Guard de clase, no de instancia: cubre los alias ortográficos y los colapsos con
    // pérdida de una sola vez, así que una entrada nueva mal puesta rompe el build.
    for (const [clave, destino] of Object.entries(CATEGORIA_MAP)) {
      expect(resolverCategoriaPersistida(clave), clave).toBe(destino);
    }
  });

  it('un colapso CON PÉRDIDA sigue colapsando', () => {
    // La decisión de B26, medida: dejar pasar `Viajes` creaba una raíz visible en
    // /categorias que ninguna transacción iba a poblar, porque cae en Otros igual.
    expect(resolverCategoriaPersistida('Viajes')).toBe('Otros');
    expect(resolverCategoriaPersistida('Hogar')).toBe('Vivienda');
  });

  it('sin categoría se comporta como antes', () => {
    expect(resolverCategoriaPersistida(null)).toBe('Otros');
    expect(resolverCategoriaPersistida('')).toBe('Otros');
    expect(resolverCategoriaPersistida(undefined)).toBe('Otros');
  });

  it('no consulta la base: es pura', () => {
    // Si esto falla es porque alguien volvió a meter un await adentro, y con él la carrera.
    expect(resolverCategoriaPersistida.constructor.name).toBe('Function');
    expect(String(resolverCategoriaPersistida)).not.toContain('await');
    expect(String(resolverCategoriaPersistida)).not.toContain('supabase');
  });
});
