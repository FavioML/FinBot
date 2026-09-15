// El cierre del día de los días 0-2 de la prueba (plan día 0→1, 14-sep-2026).
//
// Por qué existe: la hora del primer gasto decide si la persona vuelve. De quienes anotaron su
// primer movimiento de mañana (0-14h Lima), 4 de 21 volvieron a anotar entre 4h y 36h después; de
// tarde, 12 de 20. Quien anota de noche vuelve solo. Quien anota de mañana no tiene nada que lo
// traiga de vuelta, y su ventana de 24h de Meta sigue abierta hasta la mañana siguiente sin que
// nadie la use.
//
// El cron (`cron/checks.js:checkCierreDiaPrueba`) sale a las 21h y SOLO a quien escribió ESE día:
// eso es lo que garantiza la ventana, sin plantillas pagas.
//
// **El día 2 ofrece seguir con `/manoslibres`, no con un "sí".** La primera versión reconocía un
// "sí" suelto como respuesta a la oferta, y dos revisiones adversariales seguidas le encontraron
// la misma clase de defecto en direcciones opuestas: con una regla floja, un "ok" a la respuesta
// de una foto prendía Manos Libres (esa respuesta no deja rastro en ninguna tabla); con una
// estricta, el propio mensaje del día 2 anulaba el "sí" apenas la persona tocaba el link de
// activación o anotaba el gasto que se le pedía. Saber si un "sí" responde a ESTE mensaje, leyendo
// rastros incompletos, no se puede hacer bien. Se retiró (Favio, 14-sep) por el comando que ya
// existe: el cierre solo le llega a quien NO tiene Manos Libres, así que `/manoslibres` —que es un
// toggle— siempre lo prende. No hay nada que inferir. Ver `docs/DEFECTOS.md`, 14-sep.
//
// Freno: `CIERRE_DIA_PRUEBA=off` en Railway apaga el cron y la promesa del primer gasto a la vez.

const TIPO_CIERRE = 'cierre_dia_prueba';
// El dedup del cron lee `notificaciones` por este título: es la fila que escribe el claim.
// Cambiarlo deja al dedup ciego por un día.
const TITULO_CIERRE = 'El cierre de tu día';
// El último día de cierre ofrece seguir cada noche (Manos Libres). "Mañana ya no te lo mando
// solo" es cierto porque el día 3 no está en `DIAS_CIERRE_PRUEBA` (lib/trial.js).
const DIA_OFERTA = 2;

/**
 * El mensaje del cierre. Puro: todo lo que decide llega por argumento.
 *
 * El orden es a propósito. Primero lo suyo (el resumen), después la única pregunta que pide
 * respuesta HOY —esa respuesta es la que reabre la ventana para mañana—, y la salida al final.
 *
 * @param {{ dia: number, resumen: string|null, linkActivacion?: string|null }} args
 * @returns {{ mensaje: string, cuerpo: string }|null}
 */
function armarCierreDiaPrueba({ dia, resumen, linkActivacion = null }) {
  if (!resumen) return null;
  const partes = [resumen, '¿Se te pasó alguno? Mándamelo ahora y queda en el día.'];
  // Sin cuenta web: el gancho para activarla es SU día, recién mirado. Es el paso 3 del plan
  // en su forma final (Favio, 14-sep): en vez de pedirle el correo, que active la webapp — que
  // además trae el correo de Google, ya verificado.
  if (linkActivacion) partes.push('📊 Tus gastos de hoy ya están en gráficos. Míralos aquí:\n' + linkActivacion);
  if (dia === DIA_OFERTA) {
    partes.push('Mañana ya no te lo mando solo. ¿Quieres que siga cada noche a las 9? Escribe */manoslibres*.');
  }
  // `/silenciar` es la SALIDA; `/manoslibres` es la entrada del día 2 y nunca la salida: es un
  // toggle, y a quien no lo tiene se lo prendería. `/silenciar` apaga `recordatorios_activos`,
  // que es lo que el cron mira.
  partes.push('_Si prefieres que no te escriba de noche, escribe /silenciar._');

  // La campana no puede pedir "mándamelo" ni ofrecer un comando: ahí no hay chat. Misma regla
  // que los `reminder_dN` de survey-triggers (la acción existe en la app: el botón de agregar).
  const plano = resumen.replace(/[*_]/g, '');
  return {
    mensaje: partes.join('\n\n'),
    cuerpo: plano.substring(0, 400) + '\n\n¿Se te pasó alguno? Anótalo aquí o por WhatsApp.',
  };
}

module.exports = {
  TIPO_CIERRE,
  TITULO_CIERRE,
  DIA_OFERTA,
  armarCierreDiaPrueba,
};
