const log = require('../../lib/logger');
// La línea de precios sale de PRO_PRECIOS: nunca se escribe a mano (ver lib/config).
const { lineaPrecioPro } = require('../../lib/config');
const { escanearGmailYRegistrar } = require('../../services/gmail-scanner');
const { obtenerCuentasGmail } = require('../../gmail');
const { getUserPlanConfig } = require('../../helpers/db-helpers');
const { esProPagado, mensajeGmailProPagado, mensajeConectarEnLaApp, mensajeGmailDesconectado } = require('../../lib/trial');
const { verificarEscritura, entro } = require('../../helpers/escritura-verificada');

module.exports = {
  intents: ['escanear_gmail', 'agregar_gmail', 'cambiar_gmail', 'preferencia_reporte_gmail'],
  async handle({ intencion, msg, datos, usuario, ctx }) {
    const { supabase } = ctx;
    switch (intencion) {
      case 'escanear_gmail': {
        // La lectura MANUAL sigue al mismo predicado que la automática (gmail-scanner.js) y
        // que la conexión. Con el gate por plan, un usuario en prueba con una cuenta heredada
        // podía pedir "escanea mi gmail" y se le leía la bandeja igual.
        if (!esProPagado(usuario)) {
          return mensajeGmailProPagado(usuario);
        }
        const resultado = await escanearGmailYRegistrar(usuario);
        // Devuelve un OBJETO ({authError:true}) cuando el token murió, no un string: sin esta
        // rama el handler retornaba el objeto y el usuario recibía basura.
        if (resultado && resultado.authError) return mensajeGmailDesconectado(usuario);
        return resultado || 'No encontre correos bancarios nuevos. Te aviso automaticamente cuando llegue uno.';
      }

      // Conectar y reconectar el Gmail es web-only: el OAuth termina en un navegador
      // igual, y en la app el usuario ve los bancos con checkboxes antes de autorizar. Acá
      // solo se responde con el atajo. El gate ya NO protege el cupo (no hay nada que emitir):
      // elige el copy, porque a quien no paga se le debe el pitch, no un link a una pantalla
      // bloqueada. La puerta real vive en routes/pro.js y el canje en routes/public.js.
      case 'agregar_gmail': {
        if (!esProPagado(usuario)) {
          return mensajeGmailProPagado(usuario);
        }
        const cuentasExistentes = await obtenerCuentasGmail(usuario.id);
        return mensajeConectarEnLaApp(usuario, cuentasExistentes.length > 0 ? 'gestionar' : 'conectar');
      }

      case 'cambiar_gmail': {
        if (!esProPagado(usuario)) {
          return mensajeGmailProPagado(usuario);
        }
        return mensajeConectarEnLaApp(usuario, 'gestionar');
      }

      case 'preferencia_reporte_gmail': {
        const planConfigPref = getUserPlanConfig(usuario);
        if (planConfigPref.maxGmailAccounts === 0 || planConfigPref.resumenDiario === false) {
          return '⭐ *Resúmenes y reportes automáticos son una función Pro.*\n\nCon NETO Pro recibes tu resumen diario, conectas Gmail para que registre solo, y configuras el modo de reporte.\n\n' + lineaPrecioPro() + '\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        // El NLP puede devolver variantes ("separado por cuenta", "separados"). Normalizamos a
        // los dos valores canónicos que el resto del código compara exacto (ej. gastos.js).
        const modoNuevo = /separad/i.test(datos.modo || '') ? 'separado' : 'unificado';
        // El intent entero es esta preferencia. Confirmarla sin haberla escrito produce el peor
        // desenlace posible acá: la persona deja de mirar sus reportes esperando el formato que
        // pidió, y el que llega es el de siempre. No hay nada más en el mensaje que sostener,
        // así que el fallo se dice y no se maquilla.
        const vModo = await verificarEscritura(
          supabase.from('usuarios').update({ reporte_gmail_modo: modoNuevo }).eq('id', usuario.id).select('id'),
          { sitio: 'preferencia_reporte_gmail', userId: usuario.id, campos: ['reporte_gmail_modo'] });
        if (!entro(vModo)) {
          return '⚠️ No pude guardar tu preferencia de reportes: siguen como estaban. Vuelve a pedírmelo en un momento.';
        }
        const cuentasConf = await obtenerCuentasGmail(usuario.id);
        if (modoNuevo === 'separado' && cuentasConf.length < 2) {
          return '📧 Tienes una sola cuenta Gmail conectada, así que tus reportes ya salen en uno solo. El modo separado aplica cuando hay más de una cuenta.';
        }
        return modoNuevo === 'separado'
          ? '✅ Reportes configurados: *separados por cuenta*.\nVerás cada Gmail por separado en tus resúmenes y reportes.'
          : '✅ Reportes configurados: *unificados*.\nTodos tus correos se consolidan en un solo reporte.';
      }
    }
  }
};
