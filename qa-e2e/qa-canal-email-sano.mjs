// ¿El canal de correo sigue entregando?
//
// Existe por lo que pasó el 28 y 29 de agosto de 2026. La `RESEND_API_KEY` cargada en Railway
// tenía un carácter de más (el MCP imprime el token pegado a la palabra "IMPORTANT" y se copió
// la `I`), y Resend la rechazaba con `API key is invalid`. Todo lo demás estaba bien: dominio
// verificado, DNS puesto, webhook entregando. El canal estuvo **muerto 22 horas** y lo descubrió
// una mirada manual, no un guard: el cron de las 9am dejó 5 correos en `estado='error'` y esos 5
// avisos se perdieron, porque el ledger de la deuda marca el toque como enviado sin mirar el
// resultado del correo.
//
// Es el caso de libro de lo que va al canary y no a la suite: **una credencial que se vence, se
// revoca o se copia mal no deja rastro en git**, así que ningún test la puede ver. Ver la memoria
// `feedback_criterio_canary_diario`.
//
// ── Las cuatro cosas que mira, y por qué cada una ────────────────────────────────────────────
//
//  1. `estado='error'`  → el proveedor rechazó el envío. Es la firma exacta del incidente: key
//     inválida, dominio sin verificar, cuota agotada. El mensaje de Resend viene en `error`.
//  2. `skipped_sin_proveedor` / `skipped_sin_baja` → se cayó una variable de entorno. El canal
//     se apaga solo y en silencio, que es su comportamiento correcto pero no el deseado.
//  3. `sent` viejo sin `delivered_at` ni `failed_at` → **el webhook no está llegando**. Sin esto
//     el canal reporta como entregado todo lo que el proveedor aceptó, que es literalmente el
//     hallazgo B23 repetido en otro canal. Medido el 28-ago: el callback llega 2 o 3 segundos
//     después del envío, así que la ventana de gracia de abajo es dos órdenes de magnitud más
//     ancha que el caso normal.
//  4. `complained` → alguien marcó el correo como spam. Es la señal más cara que existe para la
//     reputación del dominio y no se recupera sola.
//
// ── Lo que NO hace, a propósito ──────────────────────────────────────────────────────────────
//
// **No manda ningún correo.** Es read-only sobre `notification_deliveries`. Un canary que envía
// para probarse a sí mismo gasta cuota, ensucia la métrica de entrega y necesita un destinatario.
//
// Y **cero filas NO es un PASS del canal**: significa que en la ventana no hubo nada que mandar.
// Sale exit 0 porque no hay nada roto, pero el veredicto lo dice con esas palabras en vez de
// "OK", que se leería como "el canal funciona". Es la misma trampa que dejó pasar el incidente:
// un negativo que se explica por otra condición.
//
// **Y desde el 31-ago-2026 ese silencio es la REGLA, no la excepción.** Acá decía que cero filas
// es normal *"porque el cron de deudas manda hasta 4 avisos por deuda en toda su vida"* — ese
// cron ya no manda correo: el suyo pasó a un resumen SEMANAL (`checkResumenDeudasSemanal`), y era
// el único emisor con cadencia diaria. Medido sobre 30 días, el canal entero tiene 10 filas en 2
// días. O sea que este harness va a decir "SIN TRAFICO" casi siempre y su ventana de detección
// pasó de ~1 día a ~7.
//
// Por eso existe `qa-canal-email-key.mjs`, que le pregunta a Resend directamente si la
// credencial de PRODUCCIÓN sirve, sin depender de que alguien haya mandado algo. Éste sigue
// haciendo falta: es el único que ve lo que pasa DESPUÉS del envío (rebotes, quejas, el webhook
// que dejó de llegar), y eso no se puede preguntar por API.
//
// Correr:  node qa-e2e/qa-canal-email-sano.mjs   (desde app/)
//   exit 0 = no hay nada roto (con o sin tráfico)
//   exit 1 = el canal está fallando  → ver el veredicto
//   exit 2 = no se pudo determinar (credenciales, red). NO es un PASS.

import 'dotenv/config';
import { clienteGuardado } from './lib/qa-guard.mjs';

// La ventana. El canary corre a diario, así que 26h se solapa un poco con la corrida anterior en
// vez de dejar un hueco si un día se atrasa. El precio del solape es volver a reportar un fallo
// que ya se reportó ayer, y eso es correcto: sigue roto.
// Override por entorno como `backend-watchpatterns-real`, para poder ejercitar las ramas contra
// datos reales sin editar el archivo. El canary NO la pasa: corre con el default.
const VENTANA_HORAS = Number(process.env.NETO_EMAIL_VENTANA_H) || 26;

// Cuánto se le perdona a un `sent` sin desenlace antes de llamarlo webhook caído. El callback
// real tarda 2-3 segundos (medido, 28-ago-2026). 30 minutos cubre reintentos de Resend, un
// desfase de reloj y una demora de su cola, sin volverse inútil.
const GRACIA_CALLBACK_MIN = 30;

const supabase = clienteGuardado(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const indeterminado = (motivo) => {
  console.log(JSON.stringify({ veredicto: 'INDETERMINADO', motivo }, null, 2));
  return 2;
};

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    return indeterminado('faltan SUPABASE_URL/SUPABASE_KEY');
  }

  const desde = new Date(Date.now() - VENTANA_HORAS * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('notification_deliveries')
    .select('id, tipo, estado, error, delivered_at, failed_at, created_at, usuario_id')
    .eq('canal', 'email')
    .gte('created_at', desde);

  // supabase-js NO lanza: sin mirar el `{ error }`, un timeout deja `data` en null y la lista
  // vacía se leería como "no hubo fallos" — el PASS falso que este guard no puede permitirse.
  if (error) return indeterminado('query notification_deliveries: ' + error.message);

  const filas = data || [];
  const problemas = [];

  const errores = filas.filter((f) => f.estado === 'error');
  if (errores.length) {
    problemas.push({
      que: 'EL PROVEEDOR RECHAZO EL ENVIO',
      cuantos: errores.length,
      // El mensaje de Resend es lo único que separa "key inválida" de "dominio sin verificar" de
      // "cuota agotada", y las tres se arreglan en lugares distintos.
      mensajes: [...new Set(errores.map((f) => f.error || '(sin mensaje)'))],
      queHacer: '"API key is invalid" -> RESEND_API_KEY en Railway. Probala ANTES de cargarla: '
        + 'curl -X POST https://api.resend.com/emails -H "Authorization: Bearer <key>" ... y leer el '
        + 'CUERPO, no el codigo. "domain is not verified" -> el dominio en Resend. '
        + 'Estos avisos NO se reintentan: el ledger del emisor ya marco el toque como enviado.',
    });
  }

  const apagados = filas.filter((f) => f.estado === 'skipped_sin_proveedor' || f.estado === 'skipped_sin_baja');
  if (apagados.length) {
    problemas.push({
      que: 'FALTA UNA VARIABLE DE ENTORNO: el canal se apago solo',
      cuantos: apagados.length,
      estados: [...new Set(apagados.map((f) => f.estado))],
      queHacer: 'skipped_sin_proveedor -> falta RESEND_API_KEY. skipped_sin_baja -> falta '
        + 'EMAIL_OPTOUT_SECRET (y ese NO se regenera: rotarlo invalida los links de baja de todos '
        + 'los correos ya enviados). Las dos viven en Railway, servicio Neto.pe.',
    });
  }

  const corte = Date.now() - GRACIA_CALLBACK_MIN * 60 * 1000;
  const colgados = filas.filter((f) => f.estado === 'sent' && !f.delivered_at && !f.failed_at
    && new Date(f.created_at).getTime() < corte);
  if (colgados.length) {
    problemas.push({
      que: 'EL WEBHOOK NO ESTA LLEGANDO',
      cuantos: colgados.length,
      masViejo: colgados.map((f) => f.created_at).sort()[0],
      queSignifica: 'Resend acepto estos correos y nunca dijo si llegaron. Sin el callback el canal '
        + 'reporta 100% de entrega pase lo que pase, que es el hallazgo B23 en otro canal.',
      queHacer: 'Resend -> Webhooks -> el de api.neto.pe/webhooks/resend, mirar los intentos y su '
        + 'codigo de respuesta. Nuestro endpoint responde 200 con firma valida y 401 con firma mala; '
        + 'si Resend ve 401, el RESEND_WEBHOOK_SECRET de Railway no coincide con el del webhook.',
    });
  }

  const spam = filas.filter((f) => f.error === 'complained');
  if (spam.length) {
    problemas.push({
      que: 'ALGUIEN MARCO EL CORREO COMO SPAM',
      cuantos: spam.length,
      queSignifica: 'Es la senal mas cara para la reputacion del dominio y no se recupera sola. '
        + 'Con volumen bajo, una sola queja ya es una tasa alta.',
      queHacer: 'Mirar QUE aviso fue (campo tipo) y si esa persona tenia por que esperarlo. El pie '
        + 'del correo lleva link de baja de un click: que lo usen en vez de marcar spam es todo el '
        + 'punto de tenerlo.',
    });
  }

  const enviados = filas.filter((f) => f.estado === 'sent');
  const resumen = {
    ventanaHoras: VENTANA_HORAS,
    filas: filas.length,
    enviados: enviados.length,
    entregados: enviados.filter((f) => f.delivered_at).length,
    fallidos: enviados.filter((f) => f.failed_at).length,
    porEstado: Object.fromEntries(
      Object.entries(filas.reduce((a, f) => { a[f.estado] = (a[f.estado] || 0) + 1; return a; }, {}))
    ),
  };

  if (problemas.length) {
    console.log(JSON.stringify({ veredicto: 'CANAL DE CORREO FALLANDO', problemas, resumen }, null, 2));
    return 1;
  }

  // Cero filas no es evidencia de salud, y el veredicto tiene que decirlo con todas las letras.
  // Un "OK" acá se leería como "el canal funciona" cuando lo único cierto es que nadie lo usó.
  if (filas.length === 0) {
    console.log(JSON.stringify({
      veredicto: 'SIN TRAFICO',
      queSignifica: 'Ningun emisor intento mandar correo en la ventana. NO dice nada sobre si el '
        + 'canal funciona, y desde el 31-ago-2026 este es el caso NORMAL: el correo de deudas '
        + 'paso a ser semanal y era el unico emisor diario, asi que la mayoria de los dias no hay '
        + 'nada que medir aca. Quien contesta "la credencial sirve?" sin depender del trafico es '
        + 'qa-canal-email-key.mjs. Esto es exit 0 porque no hay nada roto, no porque este verificado.',
      resumen,
    }, null, 2));
    return 0;
  }

  console.log(JSON.stringify({ veredicto: 'OK', resumen }, null, 2));
  return 0;
}

// `process.exit()` con el cliente de Supabase abierto revienta libuv en Windows y se lleva el
// exit code. Se devuelve el código y se sale por `exitCode`, igual que los demás harness.
main()
  .then((c) => { process.exitCode = c; })
  .catch((e) => { console.log(JSON.stringify({ veredicto: 'INDETERMINADO', motivo: e.message })); process.exitCode = 2; });
