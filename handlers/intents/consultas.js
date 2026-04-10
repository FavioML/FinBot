const log = require('../../lib/logger');
const { formatearPendientes } = require('../../lib/formatters');
const { obtenerConsultasPendientes } = require('../../services/transactions');
const { escanearGmailYRegistrar } = require('../../services/gmail-scanner');
const { obtenerCuentasGmail, generarUrlAutorizacion } = require('../../gmail');
const { getUserPlanConfig } = require('../../helpers/db-helpers');

module.exports = {
  intents: ['ver_pendientes', 'escanear_gmail', 'agregar_gmail', 'cambiar_gmail', 'preferencia_reporte_gmail'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const { supabase } = ctx;
    switch (intencion) {
      case 'ver_pendientes': {
        const lpend = await obtenerConsultasPendientes(usuario.id);
        return lpend.length === 0 ? 'No tienes gastos pendientes. Todo al dia! \uD83D\uDC4D' : formatearPendientes(lpend);
      }

      case 'escanear_gmail': {
        const planConfigGmail = getUserPlanConfig(usuario);
        if (planConfigGmail.maxGmailAccounts === 0) {
          return '⭐ *Lectura de correos es una función Pro.*\n\nCon Pro, Neto lee tus correos bancarios automáticamente.\n\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        return (await escanearGmailYRegistrar(usuario)) || 'No encontre correos bancarios nuevos. Te aviso automaticamente cuando llegue uno.';
      }

      case 'agregar_gmail': {
        const cuentasExistentes = await obtenerCuentasGmail(usuario.id);
        if (cuentasExistentes.length > 0) {
          // Ya tiene cuenta — ofrecer reconexión/reemplazo
          const urlReconectar = generarUrlAutorizacion(from, 'reemplazar');
          return '📧 Ya tienes un Gmail conectado.\n\n¿Quieres *reemplazarlo* con otra cuenta? Abre este enlace:\n\n' + urlReconectar + '\n\n_⚠️ Esto reemplazará tu cuenta actual._';
        }
        const urlAgregar = generarUrlAutorizacion(from, 'inicial');
        return '📧 Conecta tu Gmail para que Neto registre tus gastos automáticamente:\n\n' + urlAgregar + '\n\n_Solo leemos notificaciones bancarias. Sin contraseñas._';
      }

      case 'cambiar_gmail': {
        const urlCambiar = generarUrlAutorizacion(from, 'reemplazar');
        return '🔄 *Reconecta tu Gmail*\n\nAbre este enlace para autorizar de nuevo:\n\n' + urlCambiar + '\n\n_Tu cuenta anterior será reemplazada automáticamente._';
      }

      case 'preferencia_reporte_gmail': {
        const modoNuevo = datos.modo || 'unificado';
        await supabase.from('usuarios').update({ reporte_gmail_modo: modoNuevo }).eq('id', usuario.id);
        const cuentasConf = await obtenerCuentasGmail(usuario.id);
        if (modoNuevo === 'separado' && cuentasConf.length < 2) {
          return '⚠️ Solo tienes una cuenta Gmail conectada. Agrega otra con _"agregar otro correo"_ para ver reportes separados.';
        }
        return modoNuevo === 'separado'
          ? '✅ Reportes configurados: *separados por cuenta*.\nVerás cada Gmail por separado en tus resúmenes y reportes.'
          : '✅ Reportes configurados: *unificados*.\nTodos tus correos se consolidan en un solo reporte.';
      }
    }
  }
};
