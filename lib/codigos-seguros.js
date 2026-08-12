const { randomInt } = require('node:crypto');

/**
 * Todo codigo que funcione como CREDENCIAL sale de aca, nunca de `Math.random()`.
 *
 * Espejo backend de `webapp/src/lib/codigos-seguros.ts`. Existe porque S4 se cerro solo
 * del lado de la webapp: las cuatro instancias que se arreglaron el 04-ago viven todas en
 * `webapp/src/`, y el backend generaba LOS MISMOS DOS codigos —invitacion a espacio y a
 * meta— con `Math.random()`. El guard de la webapp barre `src/`, asi que no podia verlos.
 * Un hallazgo que toca los dos canales necesita el arreglo y el barrido en los dos arboles.
 *
 * Por que `Math.random()` no sirve: el PRNG de V8 es xorshift128+ y su estado interno se
 * reconstruye observando unas pocas salidas. Observarlas es trivial porque el propio
 * producto se las entrega a quien las pide — se crean espacios propios desde WhatsApp,
 * se juntan los codigos, se recupera el estado y se predicen los que se emitan despues.
 * El lookup es global (`.eq('invite_code', code)` en los dos canales) y el codigo es la
 * unica prueba: quien lo tiene entra a las finanzas compartidas de otro.
 *
 * Y aca pega mas fuerte que en la webapp: el backend corre en **instancia unica** (ver
 * CLAUDE.md), o sea un solo proceso y un solo stream de PRNG del que salen los codigos de
 * todos los usuarios. En la webapp cada lambda arranca con su propio estado.
 *
 * Los rate limits acotan la FUERZA BRUTA, que es otro ataque. Predecir no es adivinar.
 *
 * `crypto.randomInt` y no el bucle de rechazo a mano del espejo de la webapp: alla la
 * fuente es Web Crypto (`getRandomValues`), que entrega bytes y obliga a escribir el
 * rechazo uniforme uno mismo. Node ya trae el entero uniforme hecho, y un built-in
 * correcto le gana a una reimplementacion propia.
 */

/**
 * Espacios compartidos: MAYUSCULAS, sin caracteres confundibles a mano (I, O, 0, 1).
 * Identico a `ALFABETO_ESPACIO` de la webapp, y eso arregla de paso un bug de canal.
 *
 * El backend usaba un alfabeto de 55 chars CON minusculas mientras la webapp genera en
 * mayusculas y **normaliza al buscar** (`code.toUpperCase()` en `api/spaces/join` y en
 * `api/spaces/invite`). O sea que un espacio creado desde WhatsApp cuyo codigo cayera con
 * una minuscula no se podia unir desde la web nunca: la web buscaba su version en
 * mayusculas, que no existia. Al 05-ago-2026 eso afecta a 1 de los 3 codigos vivos.
 * Emitir en mayusculas hace que todo codigo NUEVO funcione por los dos canales.
 *
 * **El cambio BAJA la entropia y hay que decirlo**: 55^8 = 46.3 bits contra 31^8 = 39.6.
 * Se pierden 6.7 bits. No cambia la conclusion —8.5e11 combinaciones contra un endpoint
 * con rate limit siguen siendo inviables por fuerza bruta, y el ataque que motivo todo
 * esto es PREDECIR, no adivinar, que es justo lo que arregla `randomInt`— pero el balance
 * neto no era todo hacia arriba y la primera version del commit lo presentaba como si lo
 * fuera. Lo marco el revisor adversarial.
 *
 * Colision: `invite_code` es UNIQUE y `crearEspacio` no reintenta, asi que una colision
 * sube como excepcion y el usuario ve "No pude crear el espacio". El alfabeto mas chico
 * multiplico esa probabilidad por ~100 sobre una base despreciable (al 05-ago-2026 hay 3
 * espacios). Con ~1e5 espacios la probabilidad acumulada sigue por debajo de 1e-2; si
 * alguna vez se acerca a eso, el arreglo es un reintento sobre el codigo 23505.
 */
const ALFABETO_ESPACIO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Metas colaborativas: el alfabeto mixto de 55 chars, byte-identico al `ALFABETO_INVITE`
 * de `webapp/src/app/api/goals/invite/route.ts`.
 *
 * Aca NO se pasa a mayusculas, y es a proposito: ninguno de los dos canales normaliza al
 * buscar (`api/goals/join` compara exacto), asi que los dos lados ya coinciden. Cambiar el
 * alfabeto sin cambiar la busqueda invalidaria los links que la gente tenga pegados en un
 * chat, que es justo lo que el cambio de los espacios SI puede permitirse porque alla la
 * web ya normaliza.
 */
const ALFABETO_META = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/**
 * Codigo de invitacion desde la fuente criptografica.
 *
 * El alfabeto lo elige el llamador porque cada superficie ya tenia el suyo (ver arriba).
 *
 * @param {string} alfabeto
 * @param {number} largo
 * @returns {string}
 */
function generarCodigoInvitacion(alfabeto, largo) {
  if (typeof alfabeto !== 'string' || alfabeto.length < 2) {
    throw new Error('generarCodigoInvitacion: alfabeto invalido');
  }
  if (!Number.isInteger(largo) || largo < 1) {
    throw new Error('generarCodigoInvitacion: largo invalido');
  }
  let out = '';
  for (let i = 0; i < largo; i++) out += alfabeto[randomInt(alfabeto.length)];
  return out;
}

/**
 * Alfabeto del `ref_code`. **Solo mayusculas, y eso NO es estetica**: la mini-landing
 * (`neto.pe/r/CODE`) y `POST /admin/referido` hacen `toUpperCase()` sobre lo que reciben
 * antes de buscar, asi que un codigo con minusculas seria imposible de canjear por su
 * propio link. Mismo criterio de caracteres ambiguos que ALFABETO_ESPACIO (sin O/0, I/1, L).
 *
 * El `ref_code` es PUBLICO por diseno —viaja en el link que el usuario reparte— asi que esto
 * no es una defensa contra predecirlo: usar el codigo de otro te convierte en SU referido, o
 * sea que el premio es de el. Lo que sale de `Math.random()` es la CORRECTITUD:
 * `Math.random().toString(36).substring(2, 8)` devuelve MENOS de 6 chars cuando el float cae
 * corto (~1 de cada 30), y con un espacio tan chico las colisiones importan — dos usuarios
 * con el mismo codigo le dan el premio al equivocado.
 */
const ALFABETO_REF = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

module.exports = { generarCodigoInvitacion, ALFABETO_ESPACIO, ALFABETO_META, ALFABETO_REF };
