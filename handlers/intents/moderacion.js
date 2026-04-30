const log = require('../../lib/logger');

module.exports = {
  intents: ['silenciar', 'reactivar_recordatorios', 'hablar_con_humano', 'desconectar_cuenta', 'cargar_excel'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, obtenerCuentasGmail
    } = ctx;

    switch (intencion) {

      case 'silenciar': {
        try {
          await supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id);
          // Marcar el ultimo survey_event WhatsApp como opted_out_after para tracking de fatiga (UPDATE-05)
          try {
            const { data: lastEvent } = await supabase.from('survey_events')
              .select('id')
              .eq('user_id', usuario.id)
              .eq('channel', 'whatsapp')
              .not('sent_at', 'is', null)
              .order('sent_at', { ascending: false })
              .limit(1)
              .single();
            if (lastEvent?.id) {
              await supabase.from('survey_events').update({ opted_out_after: true }).eq('id', lastEvent.id);
            }
          } catch { /* silent — tracking secundario */ }
          return '🔇 *Recordatorios desactivados.*\n\nNo te enviaré más resúmenes diarios ni recordatorios.\n\n_Cuando quieras reactivarlos, escribe "activa los recordatorios"._';
        } catch(e) {
          log.error({ tag: 'SILENCIAR', err: e.message }, 'Error silenciar');
          return 'No pude desactivar los recordatorios. Intenta de nuevo.';
        }
      }

      case 'reactivar_recordatorios': {
        try {
          await supabase.from('usuarios').update({ recordatorios_activos: true }).eq('id', usuario.id);
          return '🔔 *Recordatorios activados.*\n\nVolverás a recibir tu resumen diario a las 8pm y alertas de presupuesto.\n\n_Si quieres silenciarlos, escribe "silencia"._';
        } catch(e) {
          log.error({ tag: 'REACTIVAR', err: e.message }, 'Error reactivar recordatorios');
          return 'No pude activar los recordatorios. Intenta de nuevo.';
        }
      }

      case 'hablar_con_humano': {
        try {
          // Crear ticket en estado 'esperando_mensaje'
          await supabase.from('tickets_soporte').insert({
            usuario_id: usuario.id,
            whatsapp: from,
            nombre_usuario: usuario.nombre || null,
            estado: 'esperando_mensaje'
          });
          return '👤 *Soporte humano*\n\nCuéntame tu problema o consulta en un mensaje y se lo paso al equipo.\n\n_Escríbelo a continuación ⬇️_';
        } catch(e) {
          log.error({ tag: 'SOPORTE', err: e.message }, 'Error creando ticket');
          return '👤 *Soporte humano:*\n\nEscríbenos a:\n📧 hola@neto.pe\n📱 WhatsApp: 970398192';
        }
      }

      case 'desconectar_cuenta': {
        const cuentasDesc = await obtenerCuentasGmail(usuario.id);
        await supabase.from('usuarios').update({ onboarding_paso: -1 }).eq('id', usuario.id);
        let menuDesc = '⚠️ *Desconectar cuenta*\n\n';
        if (cuentasDesc.length > 1) {
          menuDesc += 'Cuentas conectadas:\n' + cuentasDesc.map((c, i) => (i + 1) + '. 📧 ' + c.email).join('\n') + '\n\n';
          menuDesc += '¿Qué deseas hacer?\n\n';
          menuDesc += cuentasDesc.map((c, i) => (i + 1) + '️⃣ *Desconectar ' + c.email + '*').join('\n') + '\n';
          menuDesc += (cuentasDesc.length + 1) + '️⃣ *Desconectar todas* — Conservo tu historial\n';
          menuDesc += (cuentasDesc.length + 2) + '️⃣ *Eliminar todo* — Borro todos tus datos (irreversible)\n\n';
          menuDesc += '_Responde con el número._';
        } else if (cuentasDesc.length === 1) {
          menuDesc += 'Cuenta conectada: 📧 ' + cuentasDesc[0].email + '\n\n';
          menuDesc += '¿Qué deseas hacer?\n\n';
          menuDesc += '1️⃣ *Solo desconectar* — Desvinculo tu Gmail pero conservo tu historial de gastos. Puedes volver a conectarte cuando quieras.\n\n';
          menuDesc += '2️⃣ *Eliminar todo* — Borro todos tus datos (gastos, categorías, configuración). Esta acción es irreversible.\n\n';
          menuDesc += '_Responde 1 o 2._';
        } else {
          menuDesc += 'No tienes cuentas Gmail conectadas.\n\n';
          menuDesc += '1️⃣ *Eliminar mis datos* — Borro todos tus gastos, categorías y configuración. Irreversible.\n\n';
          menuDesc += '_Responde 1 para confirmar o cualquier otra cosa para cancelar._';
        }
        return menuDesc;
      }

      case 'cargar_excel': {
        return '📊 *Carga de gastos e ingresos históricos*\n\n' +
          '1️⃣ Descarga la plantilla: neto.pe/plantilla_gastos.xlsx\n' +
          '2️⃣ Completa tus movimientos (máximo 500)\n' +
          '3️⃣ Envíame el archivo por este chat\n\n' +
          '_Tipo, categoría y método de pago son opcionales — NETO los asigna automáticamente con IA._ 🤖';
      }
    }
  }
};
