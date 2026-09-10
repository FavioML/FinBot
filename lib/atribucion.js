/**
 * DE DÓNDE VINO ESTA ALTA. El eslabón que faltaba.
 *
 * Medido el 2026-09-09: ninguna de las 48 altas de agosto se podía atribuir a un canal, y no era
 * por falta de instrumentación. Los CTA de la landing ya inyectaban la posición en el texto
 * prellenado de WhatsApp desde hacía meses (`[hero]`, `[navbar]`, `[sticky]`, `[final]`,
 * `[pricing-free]`, `[pricing-pro]`); ese mensaje llegaba al backend con la etiqueta adentro; y un
 * grep sobre `app/` no encontraba NINGUNA lectura de ella. Se escribía y se descartaba.
 *
 * **Por qué este archivo existe y no una tabla de eventos ni un pixel.** El alta de Neto ocurre en
 * WhatsApp, no en la web. O sea que el primer mensaje es el ÚNICO punto donde una sesión de la
 * landing toca un alta: es lo que convierte "sesiones por canal" (que PostHog ya sabía) en "altas
 * por canal" (que nadie sabía). No hay otro empalme posible sin pedirle el dato a la persona.
 *
 * EL CONTRATO CON LA LANDING es el FORMATO DEL CORCHETE, y nada más:
 *
 *     Hola Neto, quiero empezar [hero] 👋          → posicion 'hero',        origen null
 *     Hola Neto, quiero empezar [hero|ig] 👋       → posicion 'hero',        origen 'ig'
 *     Hola Neto, quiero activar Pro [pricing-pro|chatgpt.com] ⭐
 *                                                  → posicion 'pricing-pro', origen 'chatgpt.com'
 *
 * La posición va PRIMERA a propósito: los links que ya están publicados (en captions de Instagram,
 * en el blog, en mensajes viejos que alguien reenvía) no llevan origen, y tienen que seguir dando
 * la posición en vez de no parsear. Es retrocompatibilidad que se ejercita sola.
 *
 * **Lo que este parser NO hace, y es deliberado: no ancla sobre la frase.** Sería fácil exigir que
 * el mensaje empiece con "hola neto" —el parser de referidos de `handlers/webhook.js` lo hace— y
 * daría un filtro más estrecho. Pero ataría la atribución al COPY de otro repositorio: el día que
 * la landing cambie "Hola Neto, quiero empezar" por cualquier otra cosa, esto dejaría de medir sin
 * que nada avise, y un arreglo en el repo de la landing no puede poner rojo el CI de acá. El
 * contrato es la forma del corchete, que es lo único que las dos mitades tienen que respetar.
 *
 * Lo que reemplaza a ese anclaje son las tres condiciones de `registrarOrigenDelAlta`, que acotan
 * el riesgo real (alguien que escriba `[algo]` en un mensaje normal) mucho mejor que una frase.
 */

const { supabase } = require('./db');
const log = require('./logger');
const analytics = require('./analytics');
const { registrarError } = require('./error-monitor');

/**
 * La forma del corchete. Los dos campos están acotados en juego de caracteres Y en largo, porque
 * lo que salga de acá va derecho a dos columnas con `CHECK (char_length <= 40)` (migración 084).
 *
 *   posicion  kebab-case, empieza con letra. Es un identificador que la landing controla.
 *   origen    un `utm_source` o un hostname, así que admite punto ('chatgpt.com') y guion bajo.
 *
 * `[^\]]` no aparece en ningún lado a propósito: un patrón permisivo haría que cualquier corchete
 * de un mensaje normal ("pagué el [alquiler]") califique como etiqueta de CTA.
 */
const ETIQUETA = /\[([a-z][a-z0-9-]{1,23})(?:\|([a-z0-9][a-z0-9._-]{0,39}))?\]/i;

/**
 * Parsea la etiqueta de un CTA. Función PURA: no toca la base ni el reloj, así que es la que los
 * tests ejercitan caso por caso.
 *
 * @param {string} msg texto del mensaje entrante
 * @returns {{posicion: string, origen: string|null}|null} null si no hay etiqueta con esta forma
 */
function parsearEtiquetaCta(msg) {
  if (typeof msg !== 'string' || !msg) return null;
  const m = msg.match(ETIQUETA);
  if (!m) return null;
  return { posicion: m[1].toLowerCase(), origen: m[2] ? m[2].toLowerCase() : null };
}

/**
 * Guarda el canal del alta, si corresponde. Best-effort: esto NUNCA puede frenar un alta ni una
 * respuesta — la atribución vale mucho menos que el primer mensaje de alguien que recién llega.
 *
 * TRES CONDICIONES, y cada una tapa un caso distinto:
 *
 *   1. **Hay etiqueta con la forma del contrato.** Si no, ni se consulta nada: es un `match` en
 *      memoria sobre un mensaje que ya está en memoria, o sea gratis. Esto es lo que hace que el
 *      camino caliente (cada mensaje de cada usuario, todo el día) no pague una query.
 *
 *   2. **El alta está abierta** (`!onboarding_completado`). Es lo que protege a las 100+ filas que
 *      ya existen: un usuario de hace meses que hoy hace clic en un CTA no se reetiqueta, y su
 *      `origen` se queda en NULL, que es la verdad (su alta fue antes de que midiéramos). Sin esta
 *      condición, el primer clic de cualquier veterano contaminaría la serie justo cuando se la
 *      empieza a leer.
 *
 *   3. **Todavía no tiene origen.** PRIMER toque, no último. Alguien que abandona el alta, vuelve
 *      por otro canal y la completa, queda atribuido al canal que lo trajo la primera vez. Es la
 *      misma semántica que declara la columna y la misma que resuelve el merge (migración 085).
 *
 * @param {{id: string, origen?: string|null, onboarding_completado?: boolean|null}} usuario fila EN MEMORIA
 * @param {string} msg texto del mensaje entrante
 * @returns {Promise<{posicion: string, origen: string}|null>} lo que se escribió, o null
 */
async function registrarOrigenDelAlta(usuario, msg) {
  // **El try/catch es la razón por la que el call site no necesita uno, y no es defensa genérica.**
  // Esta función corre en el camino del PRIMER mensaje de un usuario nuevo: un throw suyo —un
  // TypeError de programación, un rechazo raro del cliente— se comería la respuesta del alta
  // entera. La atribución vale mucho menos que eso. No es silencioso: loguea y deja fila en
  // `errores`, que es la diferencia con el `catch {}` vacío que este repo persigue.
  try {
    return await _registrar(usuario, msg);
  } catch (e) {
    log.error({ tag: 'ATRIBUCION', usuarioId: usuario && usuario.id, err: e.message },
      'Excepción guardando el origen del alta: se sigue sin atribuir');
    registrarError('ATRIBUCION', e.message, { usuarioId: usuario && usuario.id, stack: e.stack });
    return null;
  }
}

async function _registrar(usuario, msg) {
  if (!usuario || !usuario.id) return null;
  if (usuario.origen) return null;
  if (usuario.onboarding_completado) return null;

  const etiqueta = parsearEtiquetaCta(msg);
  if (!etiqueta) return null;

  // El origen puede venir vacío (link viejo sin `|origen`). Se guarda 'directo' y no NULL: NULL
  // significa "alta anterior a la medición" y esta alta SÍ se midió, sólo que el link que la trajo
  // no decía de dónde. Colapsar las dos cosas haría ilegible el número que esto existe para mover.
  const origen = etiqueta.origen || 'directo';
  const patch = { origen, origen_cta: etiqueta.posicion };

  // El filtro `.is('origen', null)` NO es redundante con el chequeo de arriba: ahí se lee la fila
  // en memoria, que pudo quedar vieja si dos mensajes del alta entraron casi juntos. Con él, el
  // segundo UPDATE no pisa lo que escribió el primero y el primer toque sigue siendo el primero.
  const { data, error } = await supabase
    .from('usuarios')
    .update(patch)
    .eq('id', usuario.id)
    .is('origen', null)
    .select('id');

  if (error) {
    // Se loguea y se deja fila en `errores` porque este dato NO se puede recuperar después: el
    // mensaje con la etiqueta se manda una vez en la vida de una cuenta. Un fallo mudo acá es un
    // alta sin origen para siempre, indistinguible de un alta que llegó sin pista — que es
    // exactamente la confusión que la columna separa.
    log.error({ tag: 'ATRIBUCION', usuarioId: usuario.id, err: error.message, ...patch },
      'No se pudo guardar el origen del alta: esta atribución se pierde y no vuelve');
    registrarError('ATRIBUCION', error.message, { usuarioId: usuario.id, detalle: JSON.stringify(patch) });
    return null;
  }

  // `data` vacío = la carrera de arriba: otra escritura ya puso el origen. No es un fallo.
  if (!data || !data.length) return null;

  // Se refleja en la fila en memoria para que lo que siga en este mismo mensaje vea el valor
  // nuevo, y para que un segundo intento en el mismo proceso corte en el `if` de arriba.
  usuario.origen = origen;
  usuario.origen_cta = etiqueta.posicion;

  log.info({ tag: 'ATRIBUCION', usuarioId: usuario.id, ...patch }, 'Origen del alta atribuido');
  // `$set` y no sólo el evento: así el reparto por canal se puede leer también del lado de
  // PostHog, que es donde vive la otra mitad del embudo (las sesiones de la landing).
  analytics.capture(usuario.id, 'wa_origen_atribuido', {
    origen,
    origen_cta: etiqueta.posicion,
    $set: { origen, origen_cta: etiqueta.posicion },
  });

  return { posicion: etiqueta.posicion, origen };
}

module.exports = { parsearEtiquetaCta, registrarOrigenDelAlta, ETIQUETA };
