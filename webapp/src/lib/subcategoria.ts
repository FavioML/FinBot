/**
 * El único sitio que sabe cómo se escribe "esta transacción no tiene subcategoría útil".
 *
 * POR QUÉ EXISTE. `transacciones.subcategoria` pasa por un trigger de Postgres
 * (`trg_normalize_subcategoria`, declarado en `app/migrations/070`) que capitaliza la
 * primera letra y baja el resto: lo que el código INSERTA en minúscula, la DB lo DEVUELVE
 * capitalizado. Los dos centinelas de "sin clasificar" se escriben `'sin_categoria'` y
 * `'null'`, así que en prod viven como `'Sin_categoria'` y `'Null'` — al 2026-08-12, 503 de
 * 2234 filas (22.5%), y CERO en minúscula.
 *
 * Con eso, cada `sub !== 'sin_categoria'` escrito a mano es un falso negativo: el centinela
 * no se filtra y la webapp lo pinta como si "Sin_categoria" fuera una subcategoría de
 * verdad. Era el caso en 16 call-sites.
 *
 * LA REGLA: nadie compara contra el literal. Se compara con estas funciones, que bajan a
 * minúscula ANTES de comparar y por eso sobreviven al trigger. Lo exige
 * `subcategoria-callsites.test.ts` (webapp) y `tests/subcategoria-centinela.test.js`
 * (backend), porque el mismo defecto vive en los dos canales.
 *
 * El espejo CommonJS que usa el backend de WhatsApp es `app/lib/subcategoria.js`. Los dos
 * llevan la misma tabla de casos en sus tests; si tocas uno, toca el otro.
 */

/**
 * El centinela que enciende "Por revisar". Es lo que el cascade ESCRIBE cuando una
 * categoría raíz se borra (ver `category-cascade.ts`), y lo que la NLP deja cuando no
 * clasifica. Se escribe en minúscula a propósito: el trigger lo capitaliza al guardarlo,
 * así que ésta es la forma canónica del CÓDIGO, no la de la DB.
 */
export const SUB_SENTINEL_REVISAR = 'sin_categoria';

/**
 * La segunda grafía del mismo fallo: el string literal `'null'`, que aparece cuando algo
 * serializó un `null` de JS antes de guardarlo. No es hipotético — hay filas en prod.
 */
export const SUB_SENTINEL_NULL = 'null';

/**
 * ¿Este valor es un centinela de "la NLP no clasificó esto"?
 *
 * Case-insensitive a propósito (ver el encabezado). Una subcategoría VACÍA o ausente NO
 * cuenta: "nunca se asignó subcategoría" es un estado normal y distinto — Uber → Transporte
 * sin sub está bien clasificado. Esa distinción la usa `needsReview`, que sí las trata
 * distinto según la categoría padre.
 */
export function esSubSinClasificar(sub: string | null | undefined): boolean {
  const s = (sub ?? '').trim().toLowerCase();
  return s === SUB_SENTINEL_REVISAR || s === SUB_SENTINEL_NULL;
}

/**
 * La subcategoría MOSTRABLE, o `null` si no hay ninguna que valga la pena mostrar.
 *
 * Es la forma que reemplaza al patrón `sub && sub !== 'null' && sub !== 'sin_categoria'`
 * repetido por toda la webapp. Devuelve el valor recortado para que un ` Delivery` heredado
 * no se pinte con el espacio de adelante.
 */
export function subcategoriaUtil(sub: string | null | undefined): string | null {
  const s = (sub ?? '').trim();
  if (s === '' || esSubSinClasificar(s)) return null;
  return s;
}
