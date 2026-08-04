const log = require('../../lib/logger');
const { generarRefCode, formatFecha } = require('../../lib/formatters');
const { obtenerCuentasGmail } = require('../../gmail');
const { solicitarComprobante } = require('../../lib/pro-payment');
const { obtenerEstadisticasReferidos, mensajeMisReferidos } = require('../../services/referrals');
const { enTrial, diasRestantesTrial } = require('../../lib/trial');
const { PRO_PRECIOS } = require('../../lib/config');

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
      'Tienes abierto todo: gráficos, categorías, presupuestos, reportes e historial completo.\n\n' +
      'Cuando termine sigo anotando todos tus gastos gratis; lo que se cierra es verlos.\n\n' +
      'Para continuar con Pro:\n' +
      '💰 *S/' + PRO_PRECIOS.mensual + '/mes* o *S/' + PRO_PRECIOS.anual + '/año*\n' +
      '📲 Yapea al *970398192* (Favio Mendoza) y envíame la captura acá.';
  }
  if (usuario.plan === 'premium') {
    const tipoPlanVp = usuario.tipo_plan || 'mensual';
    const venceVp = (usuario.premium_vence || usuario.fecha_vencimiento) ? new Date(usuario.premium_vence || usuario.fecha_vencimiento).toLocaleDateString('es-PE') : null;
    return '⭐ *Tu plan NETO Pro*\n\nPlan: *' + (tipoPlanVp === 'anual' ? 'Anual' : 'Mensual') + '*' + (venceVp ? '\nVence: ' + venceVp : '') + '\n\n✅ Historial ilimitado\n✅ Lectura automática de correos\n✅ Reportes PDF + CSV export\n✅ Recordatorios diarios\n✅ Consejos IA ilimitados';
  }
  return '⭐ *NETO Pro*\n\nDesbloquea todo el potencial de Neto:\n\n✅ Historial completo\n✅ Lectura automática de correos bancarios\n✅ Reportes PDF + exportar datos\n✅ Recordatorios diarios\n✅ Consejos IA ilimitados\n\n💰 *S/' + PRO_PRECIOS.mensual + '/mes* o *S/' + PRO_PRECIOS.anual + '/año* (2 meses gratis)\n\n📲 Yapea al *970398192* (Favio Mendoza) y envíame la captura aquí.\n\n_¿Dudas? Escríbeme._';
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

module.exports = {
  intents: ['ver_premium', 'ver_referidos', 'estado_cuenta'],
  mensajeVerPremium,
  pideComprobante,
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const { supabase } = ctx;
    switch (intencion) {
      case 'ver_premium': {
        // El intent NLP ("quiero pro", "cuánto cuesta") sí arma la espera del comprobante:
        // es una intención de pago expresada en lenguaje natural, y el siguiente paso
        // esperado es la captura del Yape.
        if (pideComprobante(usuario)) await solicitarComprobante(usuario.id);
        return mensajeVerPremium(usuario);
      }

      case 'ver_referidos': {
        let refCode = usuario.ref_code;
        if (!refCode) {
          refCode = generarRefCode();
          await supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id);
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
          resp += '📋 Plan: *' + (probandoEst ? 'Pro (prueba)' : esPremium ? 'Pro ⭐' : 'Free') + '*\n';
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
