// El muro de lectura, en el punto donde un intent se convierte en una llamada al handler.
//
// Antes vivía inline en `message-processor.js`, evaluado UNA sola vez con la intención que
// salió del LLM maestro. El problema no era el gate sino DÓNDE estaba: el pipeline despacha
// handlers en cuatro sitios, no en uno, y los otros tres tomaban el handler del registry y
// lo llamaban directo (hallazgo M21 de la auditoría del 2026-08-10):
//
//   · la continuación multi-intent   — message-processor.js, `detectarContinuacion`
//   · los dos redirects de registrar_manual — intents/transacciones.js, `detectarQuerySinMonto`
//   · el redirect ver_balance → ver_presupuesto — intents/presupuestos.js
//
// Los tres primeros salen de un intent LIBRE (`registrar_manual`) hacia uno de LECTURA, y los
// siete destinos de `detectarQuerySinMonto` están todos en `INTENTS_LECTURA`. O sea que
// "gasté 20 en taxi y cuánto llevo este mes" entregaba la lectura gratis a quien está en el
// muro. El cuarto no es explotable hoy —`ver_balance` ya es lectura, así que el gate del
// dispatch primario corta antes— pero es la misma forma y quedaba a una reclasificación de
// serlo.
//
// Por eso esto NO es "un check más para acordarse de llamar": vive dentro de
// `dispatchIntent()` (handlers/intent-registry.js), que es hoy el único camino por el que
// producción convierte un intent en una llamada. El guard `tests/handlers/muro-dispatch-unico.test.js`
// impide que aparezca un quinto call-site que se saltee el registry.
//
// Lo que NO hace: no gatea la cascada de comandos `/` de webhook.js, que corre antes del NLP
// y no pasa por el registry. Ese es su propio gate (`comandoRequiereLectura`).

const { requiereLectura } = require('./intents-acceso');
const { estaEnMuro, mensajeMuro } = require('../lib/trial');
const analytics = require('../lib/analytics');

/**
 * ¿Este intent, para este usuario, muere en el muro?
 *
 * @returns {Promise<string|null>} el mensaje del muro, o `null` si puede seguir.
 *   `null` es "pasá", nunca "no pude decidir": si la consulta del conteo falla, el error
 *   sube — un gate que se abre ante un error de red entrega gratis lo que cobra.
 */
async function respuestaMuroSiCorresponde({ intencion, usuario, ctx }) {
  if (!requiereLectura(intencion) || !estaEnMuro(usuario)) return null;
  const { count } = await ctx.supabase.from('transacciones')
    .select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id);
  const respMuro = mensajeMuro(usuario, count);
  // Sin `guardarMensaje`: el único escritor de la fila 'neto' es `handlers/webhook.js`,
  // que guarda lo que devuelve `procesarMensajeLibre`. Escribir también acá duplicaba la
  // fila (P′9) y, en el camino de la continuación multi-intent, guardaba un FRAGMENTO de la
  // respuesta que el usuario recibió entera.
  analytics.capture(usuario.id, 'wa_muro_lectura', { intencion });
  return respMuro;
}

module.exports = { respuestaMuroSiCorresponde };
