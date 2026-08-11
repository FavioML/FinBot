const fs = require('fs');
const path = require('path');

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
  const { respuestaMuroSiCorresponde } = require('./muro-gate');
  const respMuro = await respuestaMuroSiCorresponde({ intencion, usuario, ctx });
  if (respMuro !== null) return { manejado: true, respuesta: respMuro, muro: true };
  const handler = handlers[intencion];
  if (!handler) return { manejado: false, respuesta: null, muro: false };
  return {
    manejado: true,
    respuesta: await handler({ intencion, msg, datos, usuario, from, ctx }),
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
