const log = require('../../lib/logger');
const { generarRefCode, formatFecha } = require('../../lib/formatters');
const { obtenerCuentasGmail } = require('../../gmail');
const { solicitarComprobante } = require('../../lib/pro-payment');
const { obtenerEstadisticasReferidos, mensajeMisReferidos } = require('../../services/referrals');
const { enTrial, diasRestantesTrial, TRIAL_DIAS } = require('../../lib/trial');
const { PRO_PRECIOS } = require('../../lib/config');
const { verificarEscritura, entro } = require('../../helpers/escritura-verificada');

/**
 * El copy de "¿qué plan tengo?" con sus TRES ramas (trial / pagado / muro). **PURO**: no
 * escribe nada, para que quien solo quiere el texto no arrastre el efecto lateral del
 * intent (`solicitarComprobante`) — ver `pideComprobante` abajo.
 *
 * El trial va primero: comparte `plan === 'premium'` con el Pro pagado, así que sin esa
 * rama le respondía "Tu plan NETO Pro — Plan: Mensual" a alguien que está probando, sin
 * fecha (premium_vence es NULL en el trial) y sin precio. Le decía que ya contrató algo y
 * le escondía el camino de pagar, en el canal donde viven 36 de 82 usuarios.
 */
function mensajeVerPremium(usuario) {
  if (enTrial(usuario)) {
    const diasVp = diasRestantesTrial(usuario);
    const venceVp = usuario.trial_vence ? formatFecha(String(usuario.trial_vence).slice(0, 10)) : null;
    const cuantoVp = diasVp === null ? null
      : diasVp === 0 ? 'Termina hoy'
      : diasVp === 1 ? 'Queda 1 día'
      : 'Quedan ' + diasVp + ' días';
    return '⏳ *Estás probando Neto Pro*\n\n' +
      (cuantoVp ? cuantoVp + (venceVp ? ' (' + venceVp + ')' : '') + '.\n\n' : '') +
      'Tienes abiertos los gráficos, categorías, presupuestos, reportes e historial completo.\n\n' +
      'Cuando termine sigo anotando todos tus gastos gratis; lo que se cierra es verlos.\n\n' +
      'Para continuar con Pro:\n' +
      '💰 *S/' + PRO_PRECIOS.mensual + '/mes* o *S/' + PRO_PRECIOS.anual + '/año*\n' +
      '📲 Yapea al *970398192* (Favio Mendoza) y envíame la captura acá.';
  }
  if (usuario.plan === 'premium') {
    const tipoPlanVp = usuario.tipo_plan || 'mensual';
    const venceVp = (usuario.premium_vence || usuario.fecha_vencimiento) ? new Date(usuario.premium_vence || usuario.fecha_vencimiento).toLocaleDateString('es-PE') : null;
    // Cómo renovar va siempre (24-nov-2026): renovar es volver a yapear a mano, y quien ya paga y
    // pedía pagar recibía solo su fecha. Pagar antes no pierde días: `activarPro` (lib/pro-payment.js)
    // suma el periodo nuevo desde el vencimiento vigente. La captura se reconoce por su contenido
    // (handlers/webhook.js, `esPagoNeto`), así que no hace falta abrir la espera del comprobante.
    const base = '⭐ *Tu plan NETO Pro*\n\nPlan: *' + (tipoPlanVp === 'anual' ? 'Anual' : 'Mensual') + '*' + (venceVp ? '\nVence: ' + venceVp : '') + '\n\n✅ Historial ilimitado\n✅ Lectura de correos del banco (beta, opcional)\n✅ Reportes PDF + CSV export\n✅ Recordatorios diarios\n✅ Consejos IA ilimitados';
    // Con un comprobante en revisión no se repiten las instrucciones: invitaría a pagar dos veces.
    if (usuario.pago_pendiente) return base + '\n\n🧾 Ya me llegó tu comprobante de renovación y lo estoy revisando. No tienes que mandarlo de nuevo.';
    // "No pierdes días" solo con `premium_vence`: es la única columna que mira `activarPro`.
    return base + '\n\nPara renovar:\n💰 *S/' + PRO_PRECIOS.mensual + '/mes* o *S/' + PRO_PRECIOS.anual + '/año*\n📲 Yapea al *970398192* (Favio Mendoza) y envíame la captura acá.' +
      (usuario.premium_vence ? '\n_Si renuevas antes de que venza, no pierdes días: el periodo nuevo se suma desde tu vencimiento._' : '');
  }
  return '⭐ *NETO Pro*\n\nDesbloquea todo el potencial de Neto:\n\n✅ Historial completo\n✅ Lectura de correos del banco (beta, opcional)\n✅ Reportes PDF + exportar datos\n✅ Recordatorios diarios\n✅ Consejos IA ilimitados\n\n💰 *S/' + PRO_PRECIOS.mensual + '/mes* o *S/' + PRO_PRECIOS.anual + '/año* (2 meses gratis)\n\n📲 Yapea al *970398192* (Favio Mendoza) y envíame la captura aquí.\n\n_¿Dudas? Escríbeme._';
}

/**
 * ¿Este usuario cae en la rama de pitch (el muro)? Es la única donde el intent arma la
 * espera del comprobante.
 *
 * **El efecto lateral no es gratis y por eso NO viaja con el texto.** `solicitarComprobante`
 * abre 48h en las que toda foto se lee como comprobante: si no parece el pago a Neto, el
 * webhook responde "esa captura no parece el pago" y **retorna sin registrar el gasto**
 * (webhook.js, rama `esperaComprobante`). O sea que arrastrarlo a superficies que solo
 * informan el plan le rompe el registro por foto a quien está en el muro — justo la única
 * cosa que el muro le deja hacer. Es la misma razón por la que la rama del trial nunca lo
 * llamó. Se separó al delegar `/premium` acá (auditoría 2026-08-04).
 */
function pideComprobante(usuario) {
  return !enTrial(usuario) && usuario.plan !== 'premium';
}

/**
 * ¿La persona dice que YA pagó? (02-oct-2026). "Ya pague pro y no se activa" llegó a
 * `ver_premium` y recibió el texto de venta; su pago estaba en revisión y se aprobó 5 segundos
 * después. Quien dice que pagó recibe el estado de su pago, nunca el pitch.
 *
 * Dos lecturas, y la diferencia la pagó la revisión adversarial: "ya pagué la luz y no me aparece"
 * llegaba como `queja` y recibía "no me llegó tu comprobante". Fuera de `ver_premium` (donde el
 * clasificador ya dijo que se habla de Pro) el mensaje tiene que nombrar Pro, el plan, la
 * suscripción, el comprobante o que algo "se active": `exigePro`.
 */
const RE_DICE_QUE_PAGO = /(?:^| )(?:ya (?:te |le )?(?:pague|yapee|yapie|plinee|deposite|transferi)|acabo de (?:pagar|yapear|plinear|depositar|transferir)|(?:hice|realice|envie|mande|te mande|te envie|te hice) (?:el|un) (?:pago|yape|plin|deposito|comprobante)|(?:ya )?(?:esta|estaba) pagado|pague (?:el|mi|por el) (?:pro|premium|plan|suscripcion|mes de pro))(?: |$)/;
// Fuera de `ver_premium` el mensaje tiene que decir "pro" (o "neto pro", "premium de neto"). Tres
// revisiones fueron achicando esta lista: "neto", "plan", "premium", "suscripción", "mensualidad",
// "se activa" y "comprobante" sueltos atrapaban la luz, el plan de datos de Claro, Spotify, Netflix, el
// gym y "ya pagué el internet y no se activa". Quien escribe "ya pagué y no se activa" sin decir "pro"
// y no cae en `ver_premium` sigue el camino de antes (queja o ayuda).
const RE_HABLA_DE_PRO = /(?:^| )(?:pro|neto pro|premium de neto)(?: |$)/;
function diceQueYaPago(msg, { exigePro = false } = {}) {
  const t = String(msg || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!RE_DICE_QUE_PAGO.test(t)) return false;
  return !exigePro || RE_HABLA_DE_PRO.test(t);
}

/**
 * El estado del pago, para quien dice que ya pagó. PURA: el efecto (abrir la espera del
 * comprobante) lo decide el handler con `pideComprobante`, igual que el pitch.
 *  - Pro activo y no es la prueba → ya está activo, con su vencimiento.
 *  - `pago_pendiente` → el comprobante llegó y está en revisión; la aprobación le avisa por acá
 *    ("✅ ¡Pago confirmado!", `activarPro` en lib/pro-payment.js).
 *  - si no → no llegó: que mande la captura.
 */
function mensajeYaPague(usuario) {
  const u = usuario || {};
  if (u.plan === 'premium' && !enTrial(u)) {
    const vence = u.premium_vence || u.fecha_vencimiento;
    return '✅ Tu *Neto Pro* ya está activo' + (vence ? ', hasta el ' + new Date(vence).toLocaleDateString('es-PE') : '') +
      '.\n\nSi en la app todavía no lo ves, cierra sesión y vuelve a entrar.';
  }
  if (u.pago_pendiente) {
    return '🧾 Ya me llegó tu comprobante y lo estoy revisando.\n\nApenas quede aprobado te aviso por acá con la fecha de vencimiento. No tienes que mandarlo de nuevo.';
  }
  return 'Todavía no me llegó tu comprobante. 📲 Mándame acá la captura del Yape o Plin y la reviso.\n\n_Si ya la mandaste y no te contesté, escribe */soporte*._';
}

/**
 * ¿La persona dice que QUIERE pagarle a Neto? (24-nov-2026). "Quiero pagar mi mensualidad" (una
 * pagadora, el 11-nov) cayó en `recordatorio_pago` y "quiero pagar por tu aplicacion" en
 * `no_quiero_pro`, que contesta "no tienes que pagar nada". Con el clasificador real en frío:
 * la primera 3 de 3 a recordatorios, "deseo pagar la suscripción" 3 de 3 a `ver_suscripciones`.
 *
 * Tres reglas, y las tres cuidan lo que NO es un pago a Neto:
 *  - Deseo o pregunta + verbo en infinitivo ("quiero pagar", "cómo te pago"). Un pasado ("pagué
 *    10 de la mensualidad") es un registro y no entra.
 *  - El objeto tiene que ser de Neto. "Pro", "premium" y "neto" lo son siempre. Los genéricos
 *    (plan, suscripción, mensualidad, app) solo si el mensaje termina ahí o sigue con "de neto",
 *    "del pro": "mi mensualidad del gym" o "la suscripción de Netflix" son de otro.
 *  - "No quiero / no me interesa / no deseo" pagar es lo contrario y sigue en `no_quiero_pro`.
 */
// Revisión adversarial del 24-nov (unas 450 frases contra la primera versión): el objeto tiene que
// CERRAR el mensaje, también "pro/premium/neto", porque "premium de spotify", "neto a juan" o "el pro
// de la tarjeta" son de otro; lo único que puede seguir es "de neto", el periodo o cortesía
// ("porfa", "por yape", "de diciembre"). Sin "voy a" (afirma, no pide), sin "activar" ("activar la
// app" es vincular la cuenta), sin "mes" suelto (la renta, el gym) y "app" solo con "tu/la/esta".
const DESEO_PAGO = '(?:quiero|quisiera|deseo|necesito|me gustaria|vengo a|como|donde|puedo|podria|ayudame a|como hago para|que hago para|como puedo)';
const VERBO_PAGO = '(?:pagar|pagarte|pagarles|renovar|abonar|yapear|yapearte|comprar|adquirir|contratar|suscribirme)';
const ARTICULOS_PAGO = '(?:(?:el|mi|tu|la|un|una|del|al|por|a|de) )*';
const OBJETO_PAGO = '(?:pro|premium|neto pro|neto|plan pro|mes (?:de |del )?(?:neto|pro)|anual|renovacion|plan|suscripcion|mensualidad|membresia|(?:tu|la|esta) (?:aplicacion|app))';
const PERIODO_PAGO = '(?: (?:anual|mensual|del mes|del ano|de este mes|de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)))?';
const COLA_NETO = '(?: (?:de|a|del|en) (?:neto|neto pro|pro|la app|tu app|la aplicacion|tu aplicacion))?';
const CORTESIA = '(?: (?:porfa|por favor|pls|ya|ahora|hoy|por yape|con yape|por plin))*';
const RE_QUIERE_PAGAR = [
  new RegExp('(?:^| )' + DESEO_PAGO + ' (?:te |les )?' + VERBO_PAGO + ' ' + ARTICULOS_PAGO + OBJETO_PAGO + PERIODO_PAGO + COLA_NETO + CORTESIA + '$'),
  new RegExp('(?:^| )' + DESEO_PAGO + ' (?:pagarte|pagarles|yapearte|renovar)' + CORTESIA + '$'),
  // "cómo te pago" sí; "cómo pago" o "cómo yapeo" a secas son preguntas de cualquier pago.
  new RegExp('(?:^| )(?:como|donde) (?:te (?:pago|yapeo|abono)|(?:pago|yapeo|abono) (?:el pro|a neto|neto|la mensualidad de neto))' + CORTESIA + '$'),
];
// "No sé cómo pagar el pro" es un pedido: "no" solo niega pegado a un verbo de deseo o de poder.
const RE_NO_QUIERE_PAGAR = /(?:^| )(?:nunca|jamas|tampoco|ni)(?: |$)|(?:^| )no (?:quiero|deseo|necesito|voy a|pienso|me interesa|puedo|podria)(?: |$)/;
function quierePagarNeto(msg) {
  const t = String(msg || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || RE_NO_QUIERE_PAGAR.test(t) || diceQueYaPago(msg)) return false;
  return RE_QUIERE_PAGAR.some((re) => re.test(t));
}

module.exports = {
  intents: ['ver_premium', 'ver_referidos', 'estado_cuenta'],
  mensajeVerPremium,
  pideComprobante,
  diceQueYaPago,
  quierePagarNeto,
  mensajeYaPague,
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const { supabase } = ctx;
    switch (intencion) {
      case 'ver_premium': {
        // El intent NLP ("quiero pro", "cuánto cuesta") sí arma la espera del comprobante:
        // es una intención de pago expresada en lenguaje natural, y el siguiente paso
        // esperado es la captura del Yape. Con un pago ya en revisión no: la próxima foto no
        // es un comprobante, y abrir la espera le cambiaría el camino a su registro por foto.
        const yaPago = diceQueYaPago(msg);
        // Con un comprobante ya en revisión (`pago_pendiente`) ni se reabre la espera ni se repite
        // "Yapea al…": desde el 24-nov llegan acá también los "quiero pagar", y repetirle las
        // instrucciones a quien ya pagó invita a pagar dos veces.
        const enRevision = pideComprobante(usuario) && usuario.pago_pendiente;
        if (pideComprobante(usuario) && !usuario.pago_pendiente) await solicitarComprobante(usuario.id);
        return (yaPago || enRevision) ? mensajeYaPague(usuario) : mensajeVerPremium(usuario);
      }

      case 'ver_referidos': {
        let refCode = usuario.ref_code;
        if (!refCode) {
          refCode = generarRefCode();
          // **El código ES la credencial**, igual que el `invite_code` de una meta colaborativa
          // (`metas.js`, cerrado en S′8 con la misma lectura). Si el update no entra, el código
          // no queda en la base y abajo se arma el mensaje igual: la persona reparte un código
          // que `routes/public.js` no va a resolver nunca, y cada referido que traiga no le
          // paga el mes gratis a nadie. Es plata, y el fallo es permanentemente silencioso.
          //
          // Se DEVUELVE en vez de lanzar: `ver_referidos` no tiene catch propio, así que un
          // throw termina en el general de `procesarMensajeLibre`, que deja una fila en
          // `nlp_errors` con `error_tipo:"error"` —culpando a la NLP de un fallo de la DB— y
          // contesta "Tuve un problema". Es el mismo motivo que 9B dejó escrito.
          const vRef = await verificarEscritura(
            supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id).select('id'),
            { sitio: 'ver_referidos', userId: usuario.id, campos: ['ref_code'] });
          if (!entro(vRef)) {
            return '⚠️ Se me trabó creando tu código de referido, así que todavía no te lo puedo dar: ' +
              'si lo repartiera, no funcionaría. Pídemelo de nuevo en un momento.';
          }
        }
        const statsRefNlp = await obtenerEstadisticasReferidos(usuario.id);
        return mensajeMisReferidos(refCode, statsRefNlp);
      }

      case 'estado_cuenta': {
        try {
          const cuentasEst = await obtenerCuentasGmail(usuario.id);
          const esPremium = usuario.plan === 'premium';
          // Mismo motivo que en ver_premium: "Plan: Pro ⭐" a secas colapsa al que paga con
          // el que prueba, y en la pantalla donde uno viene a ver qué tiene, eso es mentir.
          const probandoEst = enTrial(usuario);
          const vencimiento = usuario.premium_vence || usuario.fecha_vencimiento || null;
          const nombre = usuario.nombre || 'Usuario';
          let resp = '👤 *Tu cuenta, ' + nombre + ':*\n\n';
          // "Free" era el nombre de un plan que ya no existe: hoy `plan='free'` ES el muro
          // (registro abierto, lectura cerrada). Un usuario que terminó su prueba leía
          // "Plan: Free" y no tenía forma de saber qué conserva. Se nombra lo que cada uno
          // tiene — y al que todavía no gastó nada se le dice que su prueba lo espera.
          //
          // `undefined` NO es `null`, mismo criterio que `mensajeMuro`: el primero es una
          // fila parcial (un select que se olvidó la columna) y es un bug del llamador, no
          // un estado del usuario. Se loguea y se cae al nombre neutro, que es verdadero
          // en cualquier caso, en vez de afirmar una historia que no se puede sostener.
          const sinColumna = usuario.trial_estado === undefined;
          if (sinColumna && !esPremium) {
            log.error({ tag: 'ESTADO_CUENTA', usuarioId: usuario.id },
              'estado_cuenta recibió una fila sin trial_estado: el select del llamador está incompleto');
          }
          const planEst = probandoEst ? 'Pro (prueba)'
            : esPremium ? 'Pro ⭐'
            : usuario.trial_estado ? 'Gratis (solo registro)'
            : 'Gratis';
          resp += '📋 Plan: *' + planEst + '*\n';
          // Solo a quien todavía puede estrenarla: `null` es "nunca tuvo prueba".
          if (!esPremium && usuario.trial_estado === null) {
            resp += '🎁 Tu prueba de *' + TRIAL_DIAS + ' días* se activa con tu primer gasto.\n';
          }
          if (probandoEst && usuario.trial_vence) {
            resp += '📅 Termina: ' + formatFecha(String(usuario.trial_vence).slice(0, 10)) + '\n';
          } else if (esPremium && vencimiento) {
            resp += '📅 Vence: ' + new Date(vencimiento).toLocaleDateString('es-PE') + '\n';
          }
          if (!esPremium) resp += '\n💡 _Escribe /premium para ver los beneficios Pro._\n';
          resp += '📧 Gmail: ' + (cuentasEst.length > 0 ? cuentasEst.map(c => c.email).join(', ') : 'No conectado') + '\n';
          resp += '🔔 Recordatorios: ' + (usuario.recordatorios_activos !== false ? 'Activos ✅' : 'Silenciados 🔇') + '\n';
          resp += '\n🔗 Más detalles en https://app.neto.pe/dashboard/configuracion';
          return resp;
        } catch(e) {
          log.error({ tag: 'ESTADO_CUENTA', err: e.message }, 'Error estado cuenta');
          return 'No pude consultar tu cuenta. Intenta de nuevo.';
        }
      }
    }
  }
};
