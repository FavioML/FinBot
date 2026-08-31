/**
 * Higiene de la ventana de conversación que viaja al LLM.
 *
 * `obtenerHistorial` devuelve las últimas 6 filas de `conversaciones` tal como están, y
 * `message-processor` le manda las últimas 4 al clasificador como turnos `user`/`assistant`.
 * El supuesto tácito de esa traducción es que las filas alternan: un mensaje del usuario, la
 * respuesta de NETO. **No siempre alternan**, y cuando no lo hacen el clasificador contesta
 * la pregunta ANTERIOR en vez del mensaje nuevo.
 *
 * Por qué puede no alternar: la fila 'neto' la escribe `handlers/webhook.js` DESPUÉS de que
 * `procesarMensajeLibre` devolvió. Si el usuario manda un segundo mensaje antes de que eso
 * pase, el segundo lee un historial que termina en una fila 'usuario' sin respuesta. Pasó 12
 * veces entre marzo y agosto de 2026 (huecos de 0.8s a 16s), y también lo produce cualquier
 * llamador que ejercite `procesarMensajeLibre` sin pasar por el webhook — los harness de
 * qa-e2e, por ejemplo.
 *
 * Qué hace eso en la práctica, medido contra producción con "gaste 30 en taxi" y un usuario
 * en el muro (4 corridas por escenario, gpt-4o-mini a temperature 0):
 *
 *   ventana que alterna .................... 0/4 mal clasificadas
 *   termina en 1 pregunta sin responder .... 2/4  → ver_neto_score, ver_balance
 *   termina en 3 sin responder ............. 4/4  → ver_fugas
 *   termina en 4 sin responder ............. 4/4  → ver_suscripciones
 *
 * O sea: un registro de gasto clasificado como LECTURA. Para un usuario en el muro eso
 * significa recibir el paywall en vez de la confirmación, contra la regla que
 * `handlers/intents-acceso.js` declara como no negociable ("escribir nunca se corta"). El
 * intent que sale no es ruido: es la pregunta que quedó colgada ("cuanto pago en
 * suscripciones" → `ver_suscripciones`), o sea que el modelo contesta el mensaje anterior.
 * **Por qué lo hace no está medido** y este módulo no lo afirma: lo medido es que con la
 * ventana bien formada acierta y con turnos sin responder no.
 *
 * Lo que SÍ se descartó midiendo es el arreglo barato. Pedírselo en el system prompt
 * ("analiza el ÚLTIMO mensaje; los turnos anteriores son solo contexto, si alguno quedó sin
 * responder NO lo contestes ahora") deja la racha de 3 en **4/4 mal clasificadas**: la
 * instrucción no le gana a la ventana.
 *
 * La regla, entonces: un turno del usuario que NUNCA se respondió no es contexto de nada.
 * Se conserva solo el mensaje del usuario que tiene la respuesta de NETO detrás.
 *
 * ── Lo que este recorte CUESTA, medido ────────────────────────────────────────────
 * Un mensaje que solo se entiende con el turno de atrás pierde su antecedente. Con la
 * ventana `[usuario "gaste 20 en pan", neto "✅", usuario "quiero registrar un gasto de 45
 * en cine"]` y el mensaje nuevo `"si"`: sin el recorte sale `registrar_manual` 4/4, con el
 * recorte sale `saludo` 4/4. Se aceptó igual, por dos razones. La primera es que el
 * antecedente NORMAL de un "si" es una pregunta de NETO, y esa es una fila 'neto': el
 * recorte no la toca. La segunda es que para que el antecedente sea un turno del usuario sin
 * responder, NETO ya tuvo que fallar en contestarle — o sea que el costo cae sobre una
 * conversación que ya estaba rota, y el beneficio cae sobre la promesa que no se negocia.
 *
 * No hay riesgo de tirar un turno que sí se respondió: la ventana viene ordenada por
 * `created_at` y termina en la fila más reciente, así que si la última es 'usuario' su
 * respuesta todavía no existía cuando se leyó.
 */

/**
 * @param {Array<{rol:string, mensaje:string}>} filas ventana en orden cronológico
 * @returns {Array<{rol:string, mensaje:string}>} la misma ventana sin los turnos sin respuesta
 */
function soloTurnosRespondidos(filas) {
  if (!Array.isArray(filas)) return [];
  return filas.filter((fila, i) => {
    if (!fila || fila.rol !== 'usuario') return true;
    const siguiente = filas[i + 1];
    return !!siguiente && siguiente.rol === 'neto';
  });
}

module.exports = { soloTurnosRespondidos };
