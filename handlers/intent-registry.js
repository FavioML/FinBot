const fs = require('fs');
const path = require('path');
const log = require('../lib/logger');
const { revisarDatosDichos } = require('../lib/datos-dichos');
const { INTENTS_QUE_BORRAN } = require('../lib/nlp-guards');
const { enrutarPorVerbo } = require('../lib/prestamos');

const { FRASE_BORRAR_CUENTA } = require('../lib/constants');

// Nombra las DOS órdenes exactas y no dice "pídemelo otra vez" (tercera revisión del 07-oct): quien
// quiso confirmar la CUENTA con "sí, bórrala ya" llega acá, y si se le pide repetir, la repetición
// corta ("bórrala"), ya sin menú, borraba su último movimiento. La protección vive donde ocurre el
// efecto, así que cubre cualquier forma de escribir la frase, y no otra lista de palabras.
const NO_BORRO_TRAS_EL_MENU = 'No borré nada: tu mensaje llegó mientras te mostraba el menú para eliminar la cuenta.\n\n' +
  'Si querías borrar un movimiento, dime cuál (o escríbeme *borra el último*). Si era tu cuenta, pídeme ' +
  '*borrar mi cuenta* y, cuando te muestre el menú, confírmalo con *' + FRASE_BORRAR_CUENTA + '*.';

const handlers = {};
const intentsDir = path.join(__dirname, 'intents');
const files = fs.readdirSync(intentsDir).filter(f => f.endsWith('.js'));

for (const file of files) {
  const mod = require(path.join(intentsDir, file));
  if (mod.intents && mod.handle) {
    for (const intent of mod.intents) {
      handlers[intent] = mod.handle;
    }
  }
}

function getHandler(intent) {
  return handlers[intent] || null;
}

/**
 * El ÚNICO camino por el que producción convierte un intent en una llamada al handler.
 *
 * Existe para que el muro de lectura no dependa de que cada sitio que despacha se acuerde
 * de consultarlo: el gate está acá adentro, así que un redirect nuevo lo hereda. Ver
 * `handlers/muro-gate.js` (hallazgo M21) y el guard `tests/handlers/muro-dispatch-unico.test.js`.
 *
 * El gate se evalúa ANTES de buscar el handler, igual que el chokepoint viejo: un intent de
 * lectura sin handler registrado tiene que morir en el muro, no caer al fallback.
 *
 * @returns {Promise<{manejado: boolean, respuesta: string|null, muro: boolean}>}
 *   `manejado:false` = no hay handler para ese intent y el muro no aplicaba; el llamador
 *   sigue con su fallback. Es la misma señal que antes daba `getHandler() === null`.
 */
async function dispatchIntent({ intencion, msg, datos, usuario, from, ctx }) {
  // Require perezoso: `muro-gate` arrastra `intents-acceso`, `lib/trial` y `lib/analytics`,
  // y los harness del muro reemplazan esos tres en el require-cache ANTES de cargar index.js
  // para espiarlos. Con el require al tope, el registry —que carga con el proceso— se
  // quedaría con las referencias reales y los espías quedarían mudos.
  // La dirección de un préstamo la dice el verbo, no el clasificador (07-oct-2026): "Y preste 118 soles"
  // se anotó como deuda que ella debía y "Me preste 50 soles" como gasto. Va ANTES del muro porque
  // cambia el intent que el muro juzga (un préstamo que llegó como gasto es una deuda), y acá para que
  // la continuación de un mensaje compuesto también pase. Ver lib/prestamos.js.
  const ruta = enrutarPorVerbo({ intencion, datos, msg });
  if (ruta.pregunta) {
    log.info({ tag: 'PRESTAMO_PREGUNTA', intencion, msg: String(msg || '').slice(0, 80) }, 'Préstamo sin dirección clara: se pregunta');
    return { manejado: true, respuesta: ruta.pregunta, muro: false };
  }
  if (ruta.intencion !== intencion || (ruta.datos || {}).tipo !== (datos || {}).tipo) {
    log.info({ tag: 'PRESTAMO_VERBO', desde: intencion, hacia: ruta.intencion, clasificador: (datos || {}).tipo, verbo: (ruta.datos || {}).tipo }, 'El verbo decide el préstamo');
  }
  intencion = ruta.intencion;
  datos = ruta.datos;
  const { respuestaMuroSiCorresponde } = require('./muro-gate');
  const respMuro = await respuestaMuroSiCorresponde({ intencion, usuario, ctx });
  if (respMuro !== null) return { manejado: true, respuesta: respMuro, muro: true };
  // El turno que siguió al menú de borrar la cuenta no borra nada (07-oct-2026). El menú se cerró
  // para que ese mensaje no se pierda (`handlers/onboarding.js`, paso -1), y la única forma de
  // borrar con el menú abierto es la frase de confirmación: un "borra el último" escrito ahí se
  // contesta, no se ejecuta. Vive acá y no en el clasificador por lo mismo que el muro: la
  // continuación de un mensaje compuesto también despacha por este camino.
  if (ctx && ctx.sinBorrados && INTENTS_QUE_BORRAN.has(intencion)) {
    log.info({ tag: 'MENU_BORRADO', intencion }, 'Borrado pedido con el menú de la cuenta abierto: no se ejecuta');
    // Lo que el freno dice es "pídemelo de nuevo", y eso es una respuesta pendiente: la otra mitad
    // de un mensaje compuesto no se registra en este turno, o el "borra el último" repetido
    // borraría justo lo que se acaba de anotar (revisión adversarial del 07-oct). Es la misma
    // marca que deja el borrado que pidió la orden (`message-processor.js`).
    ctx.borradoPidioOrden = true;
    return { manejado: true, respuesta: NO_BORRO_TRAS_EL_MENU, muro: false };
  }
  const handler = handlers[intencion];
  if (!handler) return { manejado: false, respuesta: null, muro: false };
  // Una escritura no usa datos que el mensaje no dice (02-oct-2026): el clasificador los copia del
  // historial ("No aparece en mi dashboard" → "Le debes S/20 a bidon de agua"). Vive acá, como el
  // muro, para que ningún handler que escribe dependa de acordarse. Ver lib/datos-dichos.js.
  const revision = revisarDatosDichos({ intencion, msg, datos });
  if (revision.descartados.length || revision.pregunta) {
    log.info({ tag: 'DATO_NO_DICHO', intencion, descartados: revision.descartados, pregunta: !!revision.pregunta,
      msg: String(msg || '').slice(0, 80) }, 'Escritura con datos que el mensaje no nombra');
  }
  if (revision.pregunta) return { manejado: true, respuesta: revision.pregunta, muro: false };
  return {
    manejado: true,
    respuesta: await handler({ intencion, msg, datos: revision.datos, usuario, from, ctx }),
    muro: false,
  };
}

/**
 * Todos los intents registrados. Lo usa el test de `handlers/intents-acceso.js` para
 * exigir que cada intent esté clasificado como lectura (muro) o libre: un intent nuevo
 * sin clasificar rompe el build en vez de filtrarse gratis en producción.
 */
function listIntents() {
  return Object.keys(handlers);
}

module.exports = { getHandler, dispatchIntent, listIntents };
