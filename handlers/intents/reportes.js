const log = require('../../lib/logger');
// La línea de precios sale de PRO_PRECIOS: nunca se escribe a mano (ver lib/config).
const { lineaPrecioPro } = require('../../lib/config');
const { mensajeDashboard } = require('../../lib/trial');

module.exports = {
  intents: ['ver_reporte', 'ver_dashboard', 'exportar_datos', 'compartir_resumen', 'ver_recomendaciones'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      mesActual, anioActual, mE,
      getUserPlanConfig, generarRecomendaciones, construirDatosUsuario, generarMiniRecomendacion
    } = ctx;

    switch (intencion) {

      case 'ver_dashboard':
        return mensajeDashboard(usuario);

      case 'ver_reporte': {
        const planConfigRep = getUserPlanConfig(usuario);
        if (planConfigRep.reportesPerMonth === 0) {
          return '⭐ *Reportes PDF son una función Pro.*\n\nCon NETO Pro recibes tu reporte mensual con gráficos y tu score financiero, listo para descargar.\n\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        const mesR = datos.mes || mesActual;
        const anioR = datos.anio || anioActual;
        return '📊 *Tu reporte de ' + mE[mesR] + ' ' + anioR + '*\n\n' +
          'Descarga tu PDF y ve tus gráficos en tu dashboard:\n\n' +
          '🔗 https://app.neto.pe/dashboard/reportes\n\n' +
          '_Inicia sesión con Google para ver tus datos._';
      }

      case 'exportar_datos': {
        const planConfigExp = getUserPlanConfig(usuario);
        if (planConfigExp.csvExport === false) {
          return '⭐ *Exportar a Excel/CSV es una función Pro.*\n\nCon NETO Pro descargas todos tus movimientos en CSV, Excel o JSON desde el dashboard.\n\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        return '📥 *Exporta tus datos*\n\nEntra a tu dashboard y descarga todo:\n\n🔗 https://app.neto.pe/dashboard/transacciones\n\nAhí puedes exportar en CSV, JSON o PDF.\n\n_Inicia sesión con tu cuenta de Google._';
      }

      // El copy de aca prometia un PDF por WhatsApp y era IMPOSIBLE por construccion, no un bug
      // intermitente: `enviarWhatsapp` (lib/whatsapp.js) solo arma `type:'text'` y `type:'template'`,
      // y no hay un solo call-site SALIENTE de `type:'document'` en el runtime (los hits de
      // `document` son ENTRANTES, el usuario subiendo un .xlsx). La receta de 3 pasos mandaba al
      // usuario a pedir "dame mi reporte", y `ver_reporte` --dos casos mas arriba-- devuelve un
      // LINK. El paso 2 no ocurria nunca.
      //
      // Lo grave era la otra mitad: el pitch de arriba le vendia esa capacidad inexistente a quien
      // todavia NO paga. Los tres guards de claims del producto (webapp, landing, content/) no
      // alcanzan este archivo, asi que el canal donde Neto de verdad habla es el unico sin red.
      // Encontrado el 05-sep-2026 cruzando docs/CHANNEL-CAPABILITY-MATRIX.md contra el codigo: la
      // matriz decia la verdad (Reporte PDF por WhatsApp = no, manda link) y el que mentia era el
      // producto.
      //
      // Se arreglo el COPY, no la capacidad: mandar documentos por WhatsApp es una feature (Meta
      // los soporta; `enviarWhatsapp` no). Queda como decision de producto en el backlog.
      case 'compartir_resumen': {
        const planConfigShr = getUserPlanConfig(usuario);
        if (planConfigShr.reportesPerMonth === 0) {
          return '⭐ *Compartir tu reporte es una función Pro.*\n\nCon NETO Pro generas tu reporte mensual en PDF y lo descargas de tu dashboard para compartirlo con quien quieras.\n\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        return '📤 *Compartir tu resumen:*\n\n1️⃣ Entra a tus reportes:\n🔗 https://app.neto.pe/dashboard/reportes\n2️⃣ Descarga el PDF del mes\n3️⃣ Compártelo con quien quieras\n\n_El PDF incluye gráficos, categorías y tu score financiero._';
      }

      case 'ver_recomendaciones': {
        // Consejo IA es Pro-only
        const planConfigRecom = getUserPlanConfig(usuario);
        if (planConfigRecom.consejoPerWeek === 0) {
          return '⭐ *Consejos IA es una función Pro*\n\nCon NETO Pro recibes consejos financieros personalizados todos los días.\n\n' + lineaPrecioPro() + '\n\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        const tipoRecom = datos.tipo || 'general';
        const varianteMap = { score: 'on_demand_score', excesos: 'on_demand_excesos', patrones: 'on_demand_excesos', general: 'on_demand_general' };
        const varianteRecom = varianteMap[tipoRecom] || 'on_demand_general';
        const recom = await generarRecomendaciones(usuario.id, usuario.nombre, varianteRecom);
        if (recom && recom.mensaje) return recom.mensaje;
        // Fallback sin IA
        const datosRecom = await construirDatosUsuario(usuario.id);
        const miniRecom = generarMiniRecomendacion(datosRecom, usuario.nombre);
        return miniRecom || 'Aún no tengo suficientes datos para darte recomendaciones. Sigue registrando tus gastos y en unos días te doy un análisis completo. ¿Revisamos algo más?';
      }
    }
  }
};
