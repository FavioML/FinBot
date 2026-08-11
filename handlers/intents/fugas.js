const { generarAlertasFugas, generarMensajeFugas, obtenerHistorialAlertas } = require('../../services/spending-alerts');
const { checkProWall } = require('../../helpers/pro-wall');
const { getUserPlanConfig } = require('../../helpers/db-helpers');
const { supabase } = require('../../lib/db');
const { hoyPeru } = require('../../lib/dates');
const { validarMonto } = require('../../lib/validators');

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

      // La misma resolución que usa la persistencia (B28): canónica/alias por el mapa, y
      // cualquier otro nombre tal cual. Antes rechazaba toda no-canónica, así que quien se
      // creó "Comida casera" la veía en /categorias y no podía ponerle un límite.
      //
      // El centinela es `null`, no `'Otros'`: con `'Otros'` un usuario que escribe
      // literalmente "OTROS" —que el mapa difuso resuelve a `Otros`— quedaba rechazado,
      // mientras "otros" en minúscula funcionaba. Lo encontró la revisión adversarial.
      const { resolverCategoriaPersistida } = require('../../services/categories');
      const catNorm = typeof categoria === 'string' && categoria.trim()
        ? resolverCategoriaPersistida(categoria.trim())
        : null;
      if (!catNorm) {
        return '❓ No reconozco la categoría "' + categoria + '".\n\nUsa una de las tuyas (escribe */categorias*) o una de estas: Alimentación, Transporte, Vivienda, Salud, Entretenimiento, Suscripciones, Compras, Educación, Finanzas, Trabajo_Negocio, Otros.';
      }

      // Create/update budget for this category
      const hoy = new Date(hoyPeru());
      const mes = hoy.getMonth() + 1;
      const anio = hoy.getFullYear();

      // `validarMonto`, y no un truthiness: este upsert escribe plata y era el único que
      // se salteaba el validador que `services/budget.js` existe para imponer (NaN,
      // Infinity, negativos, > 999999.99). Lo señaló la revisión adversarial del diff de B28.
      const limiteValidado = validarMonto(montoLimite);
      if (limiteValidado === null) {
        return '⚠️ Ese monto no me cuadra. Dame un número entre S/0.01 y S/999,999.99.\n\nEj: _"ponme límite en Alimentación de 500"_';
      }

      const { error } = await supabase.from('presupuestos').upsert({
        usuario_id: usuarioId,
        categoria: catNorm,
        monto_limite: limiteValidado,
        mes,
        anio,
        alerta_porcentaje: 80,
      }, { onConflict: 'usuario_id,categoria,subcategoria,mes,anio' });

      if (error) {
        return '❌ No pude configurar el límite. Intenta de nuevo.';
      }

      return `✅ Listo, presupuesto de *S/${limiteValidado}* para *${catNorm}* este mes.\n\nTe avisaré cuando llegues al 80% y si te pasas. 📊`;
    }

    default:
      return '❓ No entendí. Prueba con "mis fugas" o "ponme límite en [categoría] de [monto]".';
  }
}

module.exports = { intents, handle };
