// El LEDGER de entrega: una fila por intento de aviso proactivo, en cualquier canal.
//
// Vivía dentro de `lib/whatsapp.js` y salió de ahí el 27-ago-2026 al entrar el canal de
// email. No es un refactor cosmético: la fila que esta función escribe es lo que separa
// "el proveedor aceptó el POST" de "a la persona le llegó", y esa distinción **no la
// aprendió Neto leyendo documentación**. La aprendió midiendo (hallazgo B23): se reportaba
// 100% de entrega mientras Meta entregaba el 15%. Re-medido el 27-ago sobre 30 días:
// **556 `sent` contra 67 entregados, y 459 fallos que llegaron por callback** — 452 de ellos
// con código 131047, la ventana de 24h.
//
// O sea que un segundo canal escribiendo su propio insert a mano no habría sido duplicación
// inofensiva: habría sido la oportunidad de volver a contar "aceptado" como "entregado" con
// otro proveedor. Un solo lugar escribe la fila, un solo lugar grita cuando no queda.

const log = require('./logger');
const { supabase } = require('./db');

/**
 * Registra el resultado REAL de un envío en notification_deliveries.
 * Best-effort: nunca lanza (no debe romper el flujo de envío).
 * Solo registra envíos etiquetados con `tipo` (proactivos: crons, survey-triggers).
 * Las respuestas interactivas del webhook no pasan `tipo` y no se registran (siempre
 * están dentro de la ventana de 24h de todos modos).
 *
 * @param {string} [canal]  'whatsapp' (default) | 'whatsapp_template' | 'email'.
 * @param {string} [wamid]  id del mensaje EN EL PROVEEDOR. El nombre viene de Meta, pero el
 *   rol es genérico y por eso lo reusa el email: es la clave con la que el callback del
 *   proveedor encuentra esta fila para escribirle `delivered_at`/`failed_at`. Un id de
 *   Resend entra acá por la misma puerta que un wamid, y el índice parcial de la
 *   migración 050 los cubre a los dos.
 */
async function registrarEntrega({ usuarioId, tipo, canal, estado, code, error, wamid }) {
  if (!tipo) return;
  try {
    const deliv = await supabase.from('notification_deliveries').insert({
      usuario_id: usuarioId || null,
      tipo,
      canal: canal || 'whatsapp',
      estado,
      code: code != null ? code : null,
      error: error ? String(error).substring(0, 300) : null,
      // El wamid es lo que permite cruzar este intento con el callback de status del
      // proveedor. Sin él, `estado='sent'` solo dice "el proveedor aceptó el POST", no
      // que le haya llegado a nadie.
      wamid: wamid || null,
    });
    // El `{ error }` se leía: supabase-js NO lanza, así que este `catch` estaba muerto para
    // el modo de falla real (RLS, 5xx de PostgREST, constraint) y un insert rechazado se veía
    // EXACTAMENTE igual que uno exitoso — sin log, sin nada.
    //
    // Importa más de lo que parece porque esta fila es el LEDGER que lee el dedup de
    // `checkRecordatorioOnboarding` (`cron/checks.js`, el único que lee ESTA tabla — los otros
    // mecanismos miran `notificaciones`, `deudas.recordatorios_enviados` y `survey_events`).
    // Sin fila, el cron vuelve a considerar candidato al usuario en la corrida siguiente, y
    // corre **cada 15 minutos** sobre una ventana de 15h (`HORAS_TECHO`/`HORAS_PISO` en
    // `cron/checks.js`, ensanchada el 20-ago-2026): hasta **~60** avisos a la misma persona.
    // Antes de ensanchar la ventana eran ~12, y este comentario decía eso.
    //
    // Ese ~12 no es aritmética de escritorio, está medido — pero con cuidado de no atribuirle
    // una causa que no tuvo. El 17-jul y el 20-jul un usuario cada día recibió **12 `onboarding`
    // idénticos**, espaciados 15 minutos exactos sobre 2h45. Lo que eso demuestra es la CADENCIA
    // y la MAGNITUD del daño de un dedup ciego. **No** demuestra este bug: las 12 filas están en
    // la tabla, o sea que el insert funcionó. En julio este cron todavía no dedupeaba contra
    // `notification_deliveries` (eso llegó el 17-ago con `000fc52`); se marcaba pisando
    // `onboarding_paso`, y la query seleccionaba esos mismos pasos, así que la marca no excluía
    // a nadie. Dos causas distintas con el mismo desenlace.
    //
    // No se puede hacer más que gritar desde acá: quien decide qué hacer con un ledger que no
    // se escribió es el llamador, y ni `enviarWhatsapp` ni `enviarEmail` pueden des-enviar un
    // mensaje que el proveedor ya aceptó. Pero un fallo visible es la diferencia entre
    // diagnosticar esto en el log y volver a deducirlo de la tabla dos meses después.
    if (deliv.error) {
      log.error({ tag: 'NOTIF_DELIV', tipo, usuarioId, estado, err: deliv.error.message },
        'No quedó la fila de notification_deliveries: el dedup del llamador queda ciego');
    }
  } catch (e) {
    // `tipo` y `usuarioId` también acá: sin ellos esta línea no se puede cruzar con la tabla,
    // que es lo único que se puede hacer con ella.
    log.error({ tag: 'NOTIF_DELIV', tipo, usuarioId, estado, err: e.message },
      'No se pudo registrar entrega');
  }
}

module.exports = { registrarEntrega };
