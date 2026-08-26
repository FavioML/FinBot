import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// PRE-CARGA DELIBERADA, y no un import decorativo: el grafo de `googleapis` es lo unico caro
// que hay aca. Medido el 26-ago con el reporter JSON de vitest sobre la suite COMPLETA: este
// test tardaba 32231 ms en la primera corrida del dia y 3177 ms en la segunda (10.1x), contra
// un `testTimeout` de 10 s — o sea que salia rojo por el estado del cache de archivos del SO,
// no por lo que afirma. El resto de la suite se movio 1.1x entre esas dos corridas, asi que
// no era contencion de CPU: era ESTE require, cobrado adentro del cuerpo del test.
//
// Cargarlo aca lo pasa a la fase de import de vitest, que no tiene `testTimeout`. El cuerpo
// queda midiendo lo suyo: re-ejecutar `gmail.js` (147 ms medidos en frio, sin sus deps).
// No debilita la precondicion — el test la FIJA con `google._options = {}`, nunca la hereda.
const { google } = require('googleapis');
// Y sus deps tambien: el `require('../gmail.js')` del cuerpo es la re-ejecucion del modulo,
// no la carga de su arbol. Sin esto la primera carga del arbol volvia a caer adentro del test.
require('../gmail.js');

/**
 * `googleapis` va por gaxios, que **no trae timeout por default**: una conexión que Google
 * acepta y nunca responde deja el `await` colgado para siempre. Medido contra un servidor que
 * acepta y no contesta —incluyendo el camino real `gmail.users.messages.list`— sin
 * `google.options({ timeout })` seguía esperando a los 5 segundos, y con él aborta puntual.
 *
 * Importa desde que existe `cron/sin-solape.js`: una corrida colgada de `escaneoAutomatico`
 * (que sale al boot y cada 15 min) **bloquea todas las siguientes hasta el próximo deploy**.
 * `checkGmailHuerfanos` cuelga del mismo transporte vía `oauth2Client.revokeToken`.
 *
 * El guard no lee el texto de `gmail.js`: carga el módulo y comprueba el EFECTO sobre el cliente
 * compartido de `googleapis`. Borrar la línea lo pone rojo.
 */
describe('timeout de transporte de googleapis', () => {
  it('cargar gmail.js le fija un timeout a TODA llamada a Google', () => {
    // El require cache de CJS es POR WORKER, y vitest reusa el worker para varios archivos. Otros
    // CINCO tests cargan `../../gmail` para stubearlo (message-processor-arranque, muro-dispatch,
    // onboarding-gmail-gate, webhook-onboarding), y `google` es un singleton de módulo: si alguno
    // corrió antes en este worker, el timeout YA está puesto y la precondición fallaba por una
    // razón que no tiene nada que ver con lo que este guard vigila. Descubierto el 14-ago porque
    // un cambio de COMENTARIOS en otro archivo movió el reparto (vitest lo hace por TAMAÑO).
    //
    // El primer intento fue borrar la entrada de `googleapis` del cache, y **no alcanza**: el
    // paquete resuelve a su entry point, pero `google` se construye en un submódulo interno que
    // queda cacheado igual, así que volver a requerirlo devuelve el MISMO objeto con el timeout
    // ya puesto. Sobrevivió una corrida y volvió a fallar al siguiente cambio de tamaño.
    //
    // Lo robusto es no suponer el estado previo sino FIJARLO, y forzar que el cuerpo de gmail.js
    // vuelva a ejecutarse (un módulo solo corre una vez por cache).
    google._options = {};
    delete require.cache[require.resolve('../gmail.js')];

    expect(google._options?.timeout, 'la precondición se fija acá, no se hereda').toBeUndefined();

    require('../gmail.js');

    expect(google._options.timeout, 'gmail.js tiene que fijar google.options({ timeout })').toBeGreaterThan(0);
    // Cota superior: un timeout de horas es lo mismo que no tenerlo para el guard de no-solape,
    // que trata como atasco una corrida de 45 minutos.
    expect(google._options.timeout).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});
