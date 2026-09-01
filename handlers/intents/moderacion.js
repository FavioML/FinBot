const log = require('../../lib/logger');
const { checkProWall } = require('../../helpers/pro-wall');
const { verificarEscritura, entro } = require('../../helpers/escritura-verificada');
const { mensajeCargaMasivaPro } = require('../../lib/trial');
const analytics = require('../../lib/analytics');

module.exports = {
  intents: ['silenciar', 'reactivar_recordatorios', 'hablar_con_humano', 'desconectar_cuenta', 'cargar_excel'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, obtenerCuentasGmail
    } = ctx;

    switch (intencion) {

      case 'silenciar': {
        // El `try/catch` de este case es CÓDIGO MUERTO para supabase-js, que no lanza: devuelve
        // `{ data: null, error }`. Se conserva porque sigue cubriendo un rechazo del fetch de
        // abajo, pero el desenlace que decide lo trae `verificarEscritura`.
        try {
          const vSilencio = await verificarEscritura(
            supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id).select('id'),
            { sitio: 'silenciar', userId: usuario.id, campos: ['recordatorios_activos'] });
          // Es lo único que hace este intent, y el fallo lo nota la persona sola: mañana a las
          // 8pm le llega el resumen que acaba de pedir que no le llegue. Confirmarlo sin haberlo
          // escrito no es un mensaje feo, es entrenarla a no creerle al "listo".
          if (!entro(vSilencio)) {
            return 'No pude desactivar los recordatorios. Intenta de nuevo.';
          }
          // Marcar el ultimo survey_event WhatsApp como opted_out_after para tracking de fatiga (UPDATE-05)
          try {
            // ACCESORIA de punta a punta: acá el desenlace NO cambia para la persona (el silencio
            // ya está escrito arriba), así que el copy se queda como está y lo único que se compra
            // es que la serie de fatiga deje de perder opt-outs sin que nadie se entere.
            //
            // `maybeSingle` y no `single`: con `single`, cero filas —el caso normal de quien nunca
            // recibió una encuesta— vuelve como `error` PGRST116, así que una guarda de `error`
            // gritaría LECTURA_CAIDA sobre el camino sano. Un warn que suena todos los días se deja
            // de leer, y ahí el log valdría lo mismo que no tenerlo.
            const { data: lastEvent, error: errLastEvent } = await supabase.from('survey_events')
              .select('id')
              .eq('user_id', usuario.id)
              .eq('channel', 'whatsapp')
              .not('sent_at', 'is', null)
              .order('sent_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (errLastEvent) {
              log.warn({ tag: 'LECTURA_CAIDA', intencion, usuarioId: usuario.id, err: errLastEvent.message }, 'silenciar: no se pudo leer el ultimo survey_event, el opt-out no queda marcado');
            }
            if (lastEvent?.id) {
              // ACCESORIA: es telemetría de fatiga, no le cambia nada a la persona, y para
              // cuando corre el silencio ya está escrito. No toca el copy — lo único que se
              // compra es que la serie deje de perder opt-outs en silencio, que es el número
              // con el que se decide cuánto empujar. El `sin_fila` es alcanzable: la lectura de
              // arriba encontró la fila y el update es un instante después.
              await verificarEscritura(
                supabase.from('survey_events').update({ opted_out_after: true }).eq('id', lastEvent.id).select('id'),
                { sitio: 'silenciar_opt_out', userId: usuario.id, campos: ['opted_out_after'] });
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
          // Espejo exacto de `silenciar`, y el fallo se nota igual de solo: la persona vuelve a
          // esperar el resumen de las 8pm que no le va a llegar.
          const vReactivar = await verificarEscritura(
            supabase.from('usuarios').update({ recordatorios_activos: true }).eq('id', usuario.id).select('id'),
            { sitio: 'reactivar_recordatorios', userId: usuario.id, campos: ['recordatorios_activos'] });
          if (!entro(vReactivar)) {
            return 'No pude activar los recordatorios. Intenta de nuevo.';
          }
          return '🔔 *Recordatorios activados.*\n\nVolverás a recibir tu resumen diario a las 8pm y alertas de presupuesto.\n\n_Si quieres silenciarlos, escribe "silencia"._';
        } catch(e) {
          log.error({ tag: 'REACTIVAR', err: e.message }, 'Error reactivar recordatorios');
          return 'No pude activar los recordatorios. Intenta de nuevo.';
        }
      }

      case 'hablar_con_humano': {
        try {
          // Abre la sesión de soporte (idempotente: no duplica si ya hay una abierta).
          // A partir de aquí TODO mensaje del usuario va al equipo hasta /salir. Ver
          // lib/support-tickets + message-processor.procesarMensajeLibre.
          const { abrirSesion } = require('../../lib/support-tickets');
          const r = await abrirSesion({ usuarioId: usuario.id, whatsapp: from, nombre: usuario.nombre || null });
          // El `catch` de abajo NO cubre esto: supabase-js no lanza, así que un insert
          // rechazado llega hasta acá con `ticket: null` y el modo soporte se anunciaba
          // igual. Mismo texto que el catch, porque para la persona es el mismo desenlace.
          if (!(r.yaAbierta || (r.ticket && r.ticket.id))) {
            return '👤 *Soporte humano:*\n\nSe me trabó abriendo la conversación. Reintenta con */soporte* en un momento, o escríbenos a:\n📧 hola@neto.pe';
          }
          return r.yaAbierta
            ? '👤 Ya estás en modo soporte. Escríbeme tu consulta y se la paso al equipo.\n\n_Escribe */salir* cuando quieras terminar._'
            : '👤 *Soporte humano*\n\nCuéntame tu problema o consulta en un mensaje y se lo paso al equipo. Te responderemos por este mismo chat.\n\n_Escribe */salir* cuando termines para volver al asistente ⬇️_';
        } catch(e) {
          log.error({ tag: 'SOPORTE', err: e.message }, 'Error creando ticket');
          return '👤 *Soporte humano:*\n\nSe me trabó abriendo la conversación. Reintenta con */soporte* en un momento, o escríbenos a:\n📧 hola@neto.pe';
        }
      }

      case 'desconectar_cuenta': {
        const cuentasDesc = await obtenerCuentasGmail(usuario.id);
        // **El gemelo del menú que cerró 9D, desde el otro lado.** Allá el riesgo era un menú
        // que no se CIERRA; acá es uno que no se ABRE. `onboarding_paso = -1` es lo único que
        // hace que el próximo mensaje se lea como una opción (`handlers/onboarding.js`, paso
        // -1): sin ese estado escrito, imprimir el menú es ofrecerle a la persona un trámite
        // que no existe. Su "1" cae al NLP, nadie borra nada — y un pedido de baja de datos no
        // hace nada y no se lo dice nadie. Por eso el menú NO se imprime si el paso no entró:
        // enumerar las opciones es la mitad de la mentira.
        const vMenu = await verificarEscritura(
          supabase.from('usuarios').update({ onboarding_paso: -1 }).eq('id', usuario.id).select('id'),
          { sitio: 'desconectar_cuenta', userId: usuario.id, campos: ['onboarding_paso'] });
        if (!entro(vMenu)) {
          return '⚠️ Se me trabó abriendo el menú de desconexión.\n\nNo te muestro las opciones ' +
            'porque si me respondieras un número no lo leería como una opción. Escríbeme ' +
            '*desconectar cuenta* de nuevo en un momento.';
        }
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
        // El mismo flag que corta el archivo cuando llega (webhook.js, rama `document`).
        // Sin esto el bot invita a llenar la plantilla y recién la rechaza al enviarla.
        if (checkProWall(usuario, 'excelUpload').blocked) {
          // El chokepoint de lectura emite `wa_muro_lectura` y estos dos bloqueos no emitían
          // nada, así que "alguien sin Pro quiso importar su historial" —un momento de
          // conversión más caliente que una consulta cualquiera— era invisible en el embudo.
          // `via` separa las dos mitades: preguntar CÓMO se hace y mandar el archivo son
          // intenciones distintas, y la segunda está mucho más abajo en el funnel.
          analytics.capture(usuario.id, 'wa_muro_excel', { via: 'tutorial' });
          return mensajeCargaMasivaPro(usuario);
        }
        return '📊 *Carga de gastos e ingresos históricos*\n\n' +
          '1️⃣ Descarga la plantilla: neto.pe/plantilla_gastos.xlsx\n' +
          '2️⃣ Completa tus movimientos (máximo 500)\n' +
          '3️⃣ Envíame el archivo por este chat\n\n' +
          '_Tipo, categoría y método de pago son opcionales — NETO los asigna automáticamente con IA._ 🤖';
      }
    }
  }
};
