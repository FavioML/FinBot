import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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
    const { google } = require('googleapis');
    expect(google._options?.timeout, 'antes de cargar gmail.js no hay timeout').toBeUndefined();

    require('../gmail.js');

    expect(google._options.timeout, 'gmail.js tiene que fijar google.options({ timeout })').toBeGreaterThan(0);
    // Cota superior: un timeout de horas es lo mismo que no tenerlo para el guard de no-solape,
    // que trata como atasco una corrida de 45 minutos.
    expect(google._options.timeout).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});
