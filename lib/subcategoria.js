/**
 * Espejo CommonJS de `webapp/src/lib/subcategoria.ts`. El único sitio del backend que sabe
 * cómo se escribe "esta transacción no tiene subcategoría útil".
 *
 * POR QUÉ EXISTE, y por qué el backend lo necesita TAMBIÉN. `transacciones.subcategoria`
 * pasa por un trigger de Postgres (`trg_normalize_subcategoria`, declarado en
 * `migrations/070_normalize_subcategoria_trigger.sql`) que capitaliza la primera letra y baja
 * el resto. `guardarTransaccion` devuelve la fila con `.select()`, o sea DESPUÉS del trigger:
 * el valor que el código insertó como `'sin_categoria'` vuelve como `'Sin_categoria'`.
 *
 * Con eso, cada `sub !== 'sin_categoria'` escrito a mano es un falso negativo, y acá el
 * síntoma le llega al usuario por WhatsApp: la confirmación de todo gasto sin clasificar
 * decía `✅ S/20 en Otros > Sin_categoria`. Al 2026-08-12 son 503 de 2234 filas (22.5%) las
 * que llevan un centinela capitalizado, y CERO las que lo llevan en minúscula.
 *
 * LA REGLA: nadie compara contra el literal. Lo exige `tests/subcategoria-centinela.test.js`,
 * y su hermano en la webapp — el mismo defecto vivía en los dos canales, que es exactamente
 * la clase `barrido-de-un-solo-arbol` de `docs/DEFECTOS.md`.
 *
 * Lo que SÍ puede seguir escribiendo el literal: los prompts de `services/parsers.js`, donde
 * `sin_categoria` es parte del vocabulario que se le dicta al modelo, no una comparación.
 */

/**
 * El centinela que la NLP deja cuando no clasifica, y que la webapp lee como "Por revisar".
 * Se escribe en minúscula a propósito: el trigger lo capitaliza al guardarlo, así que ésta es
 * la forma canónica del CÓDIGO, no la de la DB.
 */
const SUB_SENTINEL_REVISAR = 'sin_categoria';

/** La segunda grafía del mismo fallo: el string literal `'null'`. Hay filas en prod. */
const SUB_SENTINEL_NULL = 'null';

/**
 * ¿Este valor es un centinela de "no clasificado"?
 *
 * Case-insensitive a propósito. Una subcategoría VACÍA o ausente NO cuenta: "nunca se asignó
 * subcategoría" es un estado normal y distinto.
 */
function esSubSinClasificar(sub) {
  const s = String(sub == null ? '' : sub).trim().toLowerCase();
  return s === SUB_SENTINEL_REVISAR || s === SUB_SENTINEL_NULL;
}

/**
 * La subcategoría MOSTRABLE, o `null` si no hay ninguna que valga la pena mostrar.
 * Reemplaza al patrón `sub && sub !== 'sin_categoria'` repetido por los handlers.
 */
function subcategoriaUtil(sub) {
  const s = String(sub == null ? '' : sub).trim();
  if (s === '' || esSubSinClasificar(s)) return null;
  return s;
}

module.exports = { SUB_SENTINEL_REVISAR, SUB_SENTINEL_NULL, esSubSinClasificar, subcategoriaUtil };
