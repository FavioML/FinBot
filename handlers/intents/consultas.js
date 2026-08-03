const log = require('../../lib/logger');
const { escanearGmailYRegistrar } = require('../../services/gmail-scanner');
const { obtenerCuentasGmail, generarUrlAutorizacion, menuSeleccionBancos } = require('../../gmail');
const { getUserPlanConfig } = require('../../helpers/db-helpers');
const { esProPagado, mensajeGmailProPagado } = require('../../lib/trial');

module.exports = {
  intents: ['escanear_gmail', 'agregar_gmail', 'cambiar_gmail', 'preferencia_reporte_gmail'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const { supabase } = ctx;
    switch (intencion) {
      case 'escanear_gmail': {
        // La lectura MANUAL sigue al mismo predicado que la automática (gmail-scanner.js) y
        // que la conexión. Con el gate por plan, un usuario en prueba con una cuenta heredada
        // podía pedir "escanea mi gmail" y se le leía la bandeja igual.
        if (!esProPagado(usuario)) {
          return mensajeGmailProPagado(usuario);
        }
        return (await escanearGmailYRegistrar(usuario)) || 'No encontre correos bancarios nuevos. Te aviso automaticamente cuando llegue uno.';
      }

      case 'agregar_gmail': {
        // `maxGmailAccounts === 0` es `plan === 'free'` con otro nombre, y durante el trial el
        // plan vale 'premium': dejaba conectar al que prueba. Conectar cuesta un cupo de
        // Google, así que la pregunta correcta es si PAGA. Ver lib/trial.js.
        if (!esProPagado(usuario)) {
          return mensajeGmailProPagado(usuario);
        }
        const cuentasExistentes = await obtenerCuentasGmail(usuario.id);
        if (cuentasExistentes.length > 0) {
          // Ya tiene cuenta — ofrecer reconexión/reemplazo
          const urlReconectar = generarUrlAutorizacion(from, 'reemplazar');
          return '📧 Ya tienes un Gmail conectado.\n\n¿Quieres *reemplazarlo* con otra cuenta? Abre este enlace:\n\n' + urlReconectar + '\n\n_⚠️ Esto reemplazará tu cuenta actual._';
        }
        // Antes del enlace OAuth, el usuario elige sus bancos (paso 30 en onboarding.js)
        await supabase.from('usuarios').update({ onboarding_paso: 30 }).eq('id', usuario.id);
        return menuSeleccionBancos();
      }

      case 'cambiar_gmail': {
        if (!esProPagado(usuario)) {
          return mensajeGmailProPagado(usuario);
        }
        const urlCambiar = generarUrlAutorizacion(from, 'reemplazar');
        return '🔄 *Reconecta tu Gmail*\n\nAbre este enlace para autorizar de nuevo:\n\n' + urlCambiar + '\n\n_Tu cuenta anterior será reemplazada automáticamente._';
      }

      case 'preferencia_reporte_gmail': {
        const planConfigPref = getUserPlanConfig(usuario);
        if (planConfigPref.maxGmailAccounts === 0 || planConfigPref.resumenDiario === false) {
          return '⭐ *Resúmenes y reportes automáticos son una función Pro.*\n\nCon NETO Pro recibes tu resumen diario, conectas Gmail para que registre solo, y configuras el modo de reporte.\n\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        // El NLP puede devolver variantes ("separado por cuenta", "separados"). Normalizamos a
        // los dos valores canónicos que el resto del código compara exacto (ej. gastos.js).
        const modoNuevo = /separad/i.test(datos.modo || '') ? 'separado' : 'unificado';
        await supabase.from('usuarios').update({ reporte_gmail_modo: modoNuevo }).eq('id', usuario.id);
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
