const log = require('../lib/logger');

/**
 * Una tarea programada no se solapa consigo misma.
 *
 * `setInterval` no espera a que la corrida anterior termine: dispara cada N milisegundos pase lo
 * que pase. Hoy ninguna se acerca —a ~106 usuarios los loops de los checks cierran en segundos—
 * pero el día que un barrido pase de sus 15 minutos habría DOS corriendo sobre los mismos
 * usuarios, y a los 30 tres. Varios checks son idempotentes por día contra `notificaciones` y
 * aguantarían el doble envío; otros no, y la garantía no debería depender de cuál es cuál.
 *
 * Vive en su propio módulo, y no dentro de `cron/index.js`, para poder probarse: `index.js`
 * arrastra `cron/checks.js`, que instancia el cliente de Supabase al cargarse.
 *
 * ### Por qué el atasco se avisa, y por qué se mide en TIEMPO y no en ticks
 *
 * Este guard cambia el modo de fallo: antes una tarea colgada se solapaba —feo, pero seguía
 * habiendo progreso— y ahora **deja de correr hasta el próximo deploy**. Con solo un `log.warn`
 * eso se ve idéntico a "no había nada que hacer", porque `log.warn` no escribe en `errores` ni
 * avisa al admin: la señal existiría únicamente si alguien abriera los logs de Railway.
 *
 * El umbral se cuenta en **milisegundos colgada**, no en ticks salteados. Un umbral de "3 ticks"
 * significa 45 minutos para una tarea de 15 min y **72 horas** para `checkGmailHuerfanos`, que
 * corre cada 24: tres días de silencio justo en una de las dos tareas que llaman a Google.
 *
 * Y reavisa con backoff (×4) en vez de una sola vez. Una sola fila en `errores` no dispara el
 * detector de patrón de `lib/error-monitor.js` (5 errores iguales en 1 h), y el WhatsApp puede
 * perderse: `notificarErrorAdmin` tiene un cooldown GLOBAL de 5 minutos, así que si cualquier
 * otro error avisó recién, el del atasco se descarta en silencio. El backoff conserva el rastro
 * sin convertirse en ruido.
 *
 * > La causa raíz de los atascos posibles se cerró aparte: `gmail.js` ahora fija
 * > `google.options({ timeout })`, porque gaxios no trae timeout por default. Sin eso, esta
 * > escalada reporta un fallo del que el proceso no se recupera solo.
 *
 * ### Sin `catch`, a propósito
 *
 * Si la tarea rechaza, la promesa derivada queda sin handler y el error llega igual a
 * `process.on('unhandledRejection')` de `index.js`, que lo escribe en `errores` y avisa al admin.
 * Un `catch` acá se comería esa alerta.
 *
 * > Medido en Node v24: con una promesa **ya rechazada en un turno anterior**, este patrón
 * > dispara `unhandledRejection` DOS veces (la original y la derivada del `.finally`), contra
 * > una del `setInterval(fn)` pelado. Ningún check de hoy devuelve una promesa preexistente
 * > —todos son `async function` que la crean en la llamada— así que no muerde; queda anotado
 * > porque el día que alguno cachee una promesa, el admin recibe el aviso duplicado.
 */

/** nombre → { inicioMs, proximoAvisoMs } */
const enVuelo = new Map();

/** Cuánto puede estar colgada una corrida antes de tratarse como atasco. */
const UMBRAL_ATASCO_MS = 45 * 60 * 1000;

/** Cada reaviso espera 4× lo del anterior: 45 min, 3 h, 12 h, 2 días… */
const FACTOR_REAVISO = 4;

function correrSinSolape(nombre, fn, { alAtascarse, umbralAtascoMs = UMBRAL_ATASCO_MS } = {}) {
  const ahora = Date.now();
  const enCurso = enVuelo.get(nombre);
  if (enCurso) {
    const colgadaHaceMs = ahora - enCurso.inicioMs;
    log.warn({ tag: 'CRON', tarea: nombre, colgadaHaceMs }, 'La corrida anterior sigue en curso: se saltea este tick');
    if (colgadaHaceMs >= enCurso.proximoAvisoMs) {
      enCurso.proximoAvisoMs = Math.max(colgadaHaceMs, enCurso.proximoAvisoMs) * FACTOR_REAVISO;
      if (alAtascarse) alAtascarse(nombre, colgadaHaceMs);
    }
    return false;
  }
  enVuelo.set(nombre, { inicioMs: ahora, proximoAvisoMs: umbralAtascoMs });
  // `fn()` se llama SINCRÓNICAMENTE, igual que lo haría `setInterval`. La primera versión usaba
  // `Promise.resolve().then(fn)`, que difiere la llamada un microtask por nada: cambia el orden
  // de ejecución respecto del código que este wrapper vino a reemplazar.
  let resultado;
  try {
    resultado = fn();
  } catch (e) {
    // Excepción síncrona: liberar el registro y dejarla subir tal cual, como hoy. Termina en
    // `process.on('uncaughtException')`, que la registra y avisa al admin.
    enVuelo.delete(nombre);
    throw e;
  }
  Promise.resolve(resultado).finally(() => enVuelo.delete(nombre));
  return true;
}

/** Solo para tests: deja el registro limpio entre casos. */
function _resetSinSolape() {
  enVuelo.clear();
}

module.exports = { correrSinSolape, _resetSinSolape, UMBRAL_ATASCO_MS, FACTOR_REAVISO };
