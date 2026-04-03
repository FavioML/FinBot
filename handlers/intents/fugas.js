const { generarAlertasFugas, generarMensajeFugas, obtenerHistorialAlertas } = require('../../services/spending-alerts');
const { checkProWall } = require('../../helpers/pro-wall');
const { getUserPlanConfig } = require('../../helpers/db-helpers');
const { supabase } = require('../../lib/db');
const { hoyPeru } = require('../../lib/dates');
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = require('../../lib/constants');

const intents = ['ver_fugas', 'poner_limite_gasto'];

async function handle({ intencion, datos, usuario, from, ctx }) {
  const usuarioId = usuario.id;
  const isPro = (usuario.plan || 'free') === 'premium';

  switch (intencion) {
    case 'ver_fugas': {
      const alertas = await generarAlertasFugas(usuarioId, isPro);

      if (alertas.length === 0) {
        return '✅ No detecté fugas de dinero este mes. ¡Vas bien! 💪\n\nEscribe "mi score" para ver tu salud financiera.';
      }

      // Build formatted response
      let msg = '🔍 *Fugas detectadas este mes:*\n';

      for (const a of alertas.slice(0, isPro ? 5 : 3)) {
        switch (a.type) {
          case 'spike':
            msg += `\n📈 *${a.category}:* S/${a.amount.toFixed(0)} (+${a.detail.variacion}% vs mes pasado, S/${a.detail.diff} más)`;
            break;
          case 'ant':
            msg += `\n🐜 *Gastos hormiga:* ${a.detail.cantidad} compras chicas suman S/${a.detail.total.toFixed(0)}`;
            break;
          case 'recurring':
            msg += `\n🔄 *${a.detail.comercio}:* ${a.detail.frecuencia}x este mes = S/${a.amount.toFixed(0)} (prom. S/${a.detail.ticket_promedio.toFixed(0)})`;
            break;
          case 'projection':
            // Projections are Pro-only
            if (!isPro) continue;
            msg += `\n⚠️ *${a.category}:* al ritmo actual llegarás a S/${a.detail.proyeccion} (presupuesto: S/${a.detail.limite})`;
            break;
        }
      }

      if (!isPro) {
        msg += '\n\n🔓 _Con Pro: alertas semanales, proyecciones y límites automáticos._';
      } else {
        msg += '\n\n💡 Escribe "ponme límite en [categoría] de [monto]" para controlar una categoría.';
      }

      return msg;
    }

    case 'poner_limite_gasto': {
      const { blocked } = checkProWall(usuario, 'fugasLimits');
      if (blocked) {
        return '🔒 Los límites automáticos son una función Pro.\n\nCon Pro, puedes poner topes a cualquier categoría y Neto te avisa cuando te acercas.\n\n👉 Escribe "ver plan" para más info.';
      }

      const categoria = datos.categoria;
      const montoLimite = datos.monto_limite;

      if (!categoria || !montoLimite) {
        return '❓ Necesito la categoría y el monto. Ejemplo:\n_"Ponme límite en Entretenimiento de 500"_';
      }

      // Normalize category
      const catNorm = CATEGORIA_MAP[categoria] || (CATEGORIAS_VALIDAS.has(categoria) ? categoria : null);
      if (!catNorm) {
        return '❓ No reconozco la categoría "' + categoria + '".\n\nCategorías válidas: Alimentación, Transporte, Vivienda, Salud, Entretenimiento, Suscripciones, Compras, Educación, Finanzas, Trabajo_Negocio, Otros.';
      }

      // Create/update budget for this category
      const hoy = new Date(hoyPeru());
      const mes = hoy.getMonth() + 1;
      const anio = hoy.getFullYear();

      const { error } = await supabase.from('presupuestos').upsert({
        usuario_id: usuarioId,
        categoria: catNorm,
        monto_limite: montoLimite,
        mes,
        anio,
        alerta_porcentaje: 80,
      }, { onConflict: 'usuario_id,categoria,subcategoria,mes,anio' });

      if (error) {
        return '❌ No pude configurar el límite. Intenta de nuevo.';
      }

      return `✅ Listo, presupuesto de *S/${montoLimite}* para *${catNorm}* este mes.\n\nTe avisaré cuando llegues al 80% y si te pasas. 📊`;
    }

    default:
      return '❓ No entendí. Prueba con "mis fugas" o "ponme límite en [categoría] de [monto]".';
  }
}

module.exports = { intents, handle };
