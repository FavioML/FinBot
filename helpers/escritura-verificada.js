const log = require('../lib/logger');

/**
 * El reporte de UNA escritura de `handlers/intents/` (ítem 9B-bis).
 *
 * Las 15 escrituras de ese directorio eran `await supabase…update/insert/delete()` pelados: el
 * `{ error }` se descartaba y nadie miraba cuántas filas se habían tocado. Es la misma clase que
 * cerraron 9A (plata), 9A-bis (cero filas) y 9D (el alta), y acá produce el mismo daño con otro
 * disfraz — *"🔇 Recordatorios desactivados"* sobre alguien que va a seguir recibiendo el resumen
 * de las 8pm, *"✅ Gasto compartido creado, cada uno S/ 75"* sobre un reparto que no existe.
 *
 * **Este helper sólo REPORTA; no decide.** Qué hacer con un fallo cambia sitio por sitio y se
 * resuelve en el call-site: en `dividir_gasto_grupal` hay que COMPENSAR (borrar el padre que
 * quedó huérfano), en `registrar_deuda` hay que seguir de largo porque la deuda vale más que la
 * corrección, y en el opt-out de `survey_events` alcanza con que quede el log. Centralizar la
 * decisión es el error que el ítem 1 dejó escrito: un `if (error) return` puesto donde no va
 * apaga de más.
 *
 * **`.select(…)` es lo que separa las dos causas, y va en el call-site.** postgrest NO devuelve
 * `error` cuando la escritura no matchea ninguna fila, así que sin el RETURNING *"la DB lo
 * rechazó"* y *"esa fila ya no está"* llegan con la MISMA forma (`error: null`). El helper no
 * puede verificar que el llamador lo puso — lo que sí hace es que la falta se NOTE: sin
 * `.select()` postgrest devuelve `data: null` siempre, o sea `sin_fila` en cada escritura, y el
 * control del camino feliz (que exige cero logs) se pone rojo.
 *
 * **El `catch` no es adorno**, aunque postgrest-js no lance: el `fetch` de abajo sí puede
 * rechazar, y estos handlers corren dentro del try de `message-processor`, cuyo catch escribe
 * una fila en `nlp_errors` con `error_tipo:"error"` —atribuyéndole a la NLP un fallo de la DB— y
 * contesta *"Tuve un problema"*. Convertir el rechazo en veredicto es lo que permite responder
 * la verdad en vez de esa.
 *
 * **Límites declarados.** Dos, y el segundo lo encontró una revisión adversarial:
 *
 *   · el catch atrapa cualquier excepción, incluido un `TypeError` de programación en la
 *     cadena, y la reporta como *"la DB rechazó la escritura"*. Se prefiere así (la alternativa
 *     es el silencio), pero el diagnóstico puede apuntar a la DB cuando el error es nuestro.
 *     Separarlos pide mirar el tipo del error, y hoy nada lo hace. Heredado de 9D.
 *   · **una cadena con `{ count: 'exact', head: true }` sale siempre `sin_fila`**, porque ahí
 *     `data` viene `null` por contrato. No se maneja: `head: true` sobre una ESCRITURA no
 *     tiene sentido (pide el conteo sin las filas), así que reconocerlo sería inventarle
 *     soporte a una forma que nadie debería escribir. Queda dicho para que el próximo no la
 *     use creyendo que el helper la entiende. `PGRST116`, en cambio, sí se maneja abajo.
 *
 * @param {PromiseLike<{data:any,error:any}>} consulta  la cadena postgrest YA armada, **con su
 *        `.select(…)`**. Se arma afuera y se espera acá: es lo que permite que el helper sirva
 *        para ocho tablas distintas sin saber nada de ninguna.
 * @param {object} ctx
 * @param {string} ctx.sitio   discriminador del log. Es la clave por la que un test afirma que
 *        corrió ESTA guarda y no la de al lado, así que dos sitios no pueden compartirlo.
 * @param {string} ctx.userId
 * @param {string[]} ctx.campos  qué se escribió (el payload no se puede leer de la cadena).
 * @param {'aviso'|'esperado'} [ctx.ceroFilas='aviso']  qué significan cero filas ACÁ. `'esperado'`
 *        es para el único sitio donde la fila ausente ES el objetivo (el DELETE que corrige una
 *        deuda opuesta: si ya no está, el estado deseado se cumplió). Un `warn` ahí sería una
 *        falsa alarma diaria, y un guard que grita sin motivo deja de leerse.
 * @returns {Promise<'ok'|'sin_fila'|'error'>}
 */
const TAG = 'INTENT_ESCRITURA';

async function verificarEscritura(consulta, { sitio, userId, campos, ceroFilas = 'aviso' }) {
  let filas = null;
  let error = null;
  try {
    ({ data: filas, error } = await consulta);
  } catch (e) {
    // `msgErr` de `lib/error-monitor` haría lo mismo, pero ese módulo arrastra `lib/db` y
    // `admin-notify`: importarlo acá le metería el cliente real de Supabase a los siete
    // handlers que reciben el suyo por `ctx`. La forma segura son dos operadores.
    error = { message: (e && e.message) || String(e) };
  }
  // **`PGRST116` NO es un rechazo: es cero filas con otra cara.** Una escritura que termine en
  // `.select(…).single()` devuelve el error `PGRST116` cuando no matcheó nada, así que sin esta
  // rama el helper diría *"la DB rechazó la escritura"* sobre el desenlace que los tres sitios
  // con copy propio existen para separar — y mandaría a "Intenta de nuevo" sobre una fila que no
  // existe, que es justo lo que este ítem decidió no hacer. Hoy ningún call-site usa `.single()`
  // (los dieciséis terminan en `.select('id')`), o sea que es una trampa para el próximo y no un
  // bug de hoy. Es la misma lección que el ítem 7 dejó escrita para las LECTURAS, en la mitad de
  // las escrituras. Lo encontró una revisión adversarial.
  if (error && error.code === 'PGRST116') {
    error = null;
    filas = [];
  }
  if (error) {
    log.error({ tag: TAG, sitio, userId, campos, err: error.message },
      'La escritura del intent fue rechazada por la DB');
    return 'error';
  }
  const tocoAlgo = Array.isArray(filas) ? filas.length > 0 : filas != null;
  if (!tocoAlgo) {
    if (ceroFilas === 'esperado') return 'ok';
    log.warn({ tag: TAG, sitio, userId, campos },
      'La escritura del intent no tocó NINGUNA fila: la fila objetivo ya no está');
    return 'sin_fila';
  }
  return 'ok';
}

/**
 * Los dos desenlaces malos casi nunca cambian la DECISIÓN del call-site (cambian el diagnóstico,
 * que ya quedó en el log), así que lo que se lee arriba es este predicado. Los tres sitios donde
 * sí se separan —`editar_meta`, `eliminar_meta`, `eliminar_presupuesto`— comparan contra
 * `'sin_fila'` a mano, porque ahí "ya no está" no invita al mismo reintento que "se cayó".
 */
const entro = (veredicto) => veredicto === 'ok';

module.exports = { verificarEscritura, entro, TAG_ESCRITURA: TAG };
