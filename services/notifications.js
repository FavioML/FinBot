const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { verificarAlertaPresupuesto } = require('./budget');
const { crearNotificacion } = require('../lib/notifications-db');
const { subcategoriaUtil } = require('../lib/subcategoria');

async function enviarAlertaTransaccion(usuario, tx, resultado) {
  if (!tx || !resultado || !resultado.monto) return;
  if (!usuario) return;
  // Acá había un `if (!usuario.whatsapp) return`. El comentario que lo justificaba —"sin
  // número no hay a quién alertar por WhatsApp"— es cierto y NO responde por el otro canal:
  // más abajo, la rama de gasto inusual escribe una notificación in-app, y ese corte se la
  // llevaba puesta. O sea que al usuario web-first no le llegaba la alerta por NINGÚN lado,
  // ni siquiera por el único que sí lo alcanza (B24).
  //
  // Hoy la única puerta a esta función es `services/gmail-scanner.js`, y conectar Gmail exige
  // Pro PAGADO y pasa por la webapp: no hay ni un usuario web-only con Gmail conectado, así
  // que esto no repara un daño consumado — cierra el agujero antes del primero.
  //
  // **NO se reemplaza por `notificarUsuario`**, aunque el hallazgo lo sugería: eso escribiría
  // una fila in-app por CADA transacción detectada por el scanner, y hoy solo la escribe la
  // rama de gasto inusual. Sería convertir un arreglo de alcance en una campana de spam.
  // Opt-out (/alertas o Configuracion en la webapp). Se compara contra false a
  // proposito: si la columna aun no existe o el usuario es legacy (undefined),
  // la alerta se envia. Apagar es una accion explicita del usuario.
  if (usuario && usuario.alertas_transaccion === false) return;
  const monto = parseFloat(resultado.monto);
  const comercio = resultado.comercio || resultado.banco || 'Sin nombre';
  // Categoría/subcategoría YA persistidas (tx = fila devuelta por guardarTransaccion:
  // normalizada y con reglas de comercio aplicadas), no la salida cruda del parser.
  // Importa más que el case: una regla de comercio puede haber remapeado la categoría.
  const categoria = tx.categoria || resultado.categoria || 'Otros';
  const subcategoria = tx.subcategoria || resultado.subcategoria || null;
  const tipo = resultado.tipo || 'gasto';
  const emoji = tipo === 'ingreso' ? '\uD83D\uDCB5' : '\uD83D\uDCB8';
  const tipoStr = tipo === 'ingreso' ? 'Ingreso recibido' : 'Nuevo gasto';

  const monedaTx = resultado.moneda || 'PEN';
  let montoStr;
  if (monedaTx === 'USD') {
    const montoPen = tx.monto_pen ? parseFloat(tx.monto_pen) : null;
    montoStr = '*$' + monto.toFixed(2) + '*' + (montoPen ? ' (~S/' + montoPen.toFixed(2) + ')' : '');
  } else {
    montoStr = '*S/' + monto.toFixed(2) + '*';
  }

  let msg = emoji + ' *' + tipoStr + '*\n';
  msg += '\uD83C\uDFEA ' + comercio + '\n';
  msg += '\uD83D\uDCB0 ' + montoStr + '\n';
  msg += '\uD83C\uDFF7\uFE0F ' + categoria + (subcategoriaUtil(subcategoria) ? ' > ' + subcategoriaUtil(subcategoria) : '') + '\n';
  msg += '\uD83D\uDCC5 ' + (resultado.fecha || hoyPeru());

  // La alerta de presupuesto solo existe como TEXTO pegado al mensaje de WhatsApp: no tiene
  // canal in-app propio. Sin número no hay dónde ponerla, así que se ahorran las dos queries.
  if (tipo === 'gasto' && usuario.whatsapp) {
    const alertaPres = await verificarAlertaPresupuesto(usuario, categoria, subcategoria);
    if (alertaPres) msg += '\n\n' + alertaPres;
  }

  if (tipo === 'gasto') {
    try {
      const hace28 = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      // Se compara en SOLES, no en la moneda de cada fila. Este promedio usaba `monto` crudo
      // (único sitio del backend fuera de la convención) y después imprimía el resultado con
      // "S/" al lado: con un par de suscripciones en dólares en la categoría, el promedio salía
      // ~3.7x más bajo de lo real y cualquier gasto normal disparaba la alerta de "gasto
      // inusual". Al revés también: un consumo de US$40 se comparaba como si fueran 40 soles y
      // no disparaba nunca (B17).
      //
      // Se trae `moneda` además de las dos columnas de monto, y no es de adorno: `monto_pen` es
      // NULLABLE a propósito (la rama USD fuera de rango deja un null honesto en vez de un
      // número inventado), así que sin la moneda no hay forma de saber si un null se puede
      // tratar como soles. Caer a `monto` a ciegas reintroduce el mismo bug más chico: mete
      // dólares crudos en un promedio de soles.
      const { data: historial } = await supabase.from('transacciones')
        .select('monto, monto_pen, moneda')
        .eq('usuario_id', usuario.id)
        .eq('tipo', 'gasto')
        .ilike('categoria', '%' + categoria + '%')
        .gte('fecha', hace28)
        .neq('id', tx.id);

      // Una fila vale para el promedio solo si se puede expresar en soles: porque tiene
      // `monto_pen`, o porque ya está en soles. La fila USD sin conversión se descarta, y el
      // umbral de 3 de abajo es lo que impide decidir sobre una muestra que quedó muy chica.
      const enSoles = (t) => {
        if (t.monto_pen != null) return parseFloat(t.monto_pen);
        return (t.moneda || 'PEN') === 'PEN' ? parseFloat(t.monto) : null;
      };
      // El gasto nuevo entra en la MISMA unidad que el promedio, o la razón compara peras con
      // manzanas incluso con el historial ya convertido. Si es USD y no tiene conversión no hay
      // comparación honesta posible, así que se calla en vez de mentir: sin esto un consumo de
      // US$40 se compara como 40 soles y el gasto más grande del mes es justo el que nunca
      // dispara la alerta.
      const montoComparable = tx.monto_pen != null ? parseFloat(tx.monto_pen)
        : (monedaTx === 'PEN' ? monto : null);
      const comparables = (historial || []).map(enSoles).filter((n) => n != null && isFinite(n) && n > 0);
      if (montoComparable != null && comparables.length >= 3) {
        const promedio = comparables.reduce((s, n) => s + n, 0) / comparables.length;
        const factor = montoComparable / promedio;
        if (factor >= 2.5 && montoComparable > 30) {
          msg += '\n\n\u26A0\uFE0F *Gasto inusual:* Este gasto es ' + factor.toFixed(1) + 'x tu promedio en ' + categoria + ' (S/ ' + promedio.toFixed(2) + ')';
          await crearNotificacion(usuario.id, 'alerta', 'Gasto inusual detectado',
            comercio + ': ' + montoStr.replace(/\*/g, '') + ' es ' + factor.toFixed(1) + 'x tu promedio en ' + categoria,
            { link: '/dashboard/transacciones' });
        }
      }
    } catch(e) { log.error({ tag: 'INUSUAL', err: e.message }, 'Error alerta inusual'); }
  }

  if (tipo === 'ingreso') {
    try {
      const { data: metasSugg } = await supabase.from('metas_ahorro').select('nombre, monto_objetivo, monto_actual')
        .eq('usuario_id', usuario.id).eq('completada', false).limit(1);
      if (metasSugg && metasSugg.length > 0) {
        const metaSugg = metasSugg[0];
        const faltaSugg = parseFloat(metaSugg.monto_objetivo) - parseFloat(metaSugg.monto_actual || 0);
        if (faltaSugg > 0) {
          msg += '\n\n💡 _¿Quieres destinar algo a tu meta de ' + metaSugg.nombre + '? (te faltan S/ ' + faltaSugg.toFixed(0) + '). Escribe: "ahorré X para ' + metaSugg.nombre + '"_';
        }
      }
    } catch(e) { /* silent */ }
  }

  // Explícito y no apoyado en que `enviarWhatsapp` haga no-op con `null`: acá arriba ya no
  // hay un `return` temprano, así que este es el ÚNICO sitio que decide el canal de WhatsApp.
  if (usuario.whatsapp) await enviarWhatsapp(usuario.whatsapp, msg);
}

module.exports = { enviarAlertaTransaccion };
