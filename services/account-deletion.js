// Borrado de cuenta: la UNICA implementacion del flujo, para las dos puertas.
//
// POR QUE ESTE ARCHIVO EXISTE. El wipe estuvo escrito tres veces dentro de `onboarding.js`
// (multi-cuenta, una cuenta, sin cuentas) y las tres compartian el mismo agujero, porque un
// agujero copiado tres veces se arregla una vez y sigue vivo dos. Se unificaron el 17-ago-2026.
// Ahora aparece una segunda PUERTA —la webapp— y volver a escribirlo ahi seria repetir el
// error a mayor escala: dos canales, dos lenguajes, dos deploys. Asi que el flujo vive aca y
// las dos puertas lo llaman. Lo unico que cada canal decide por su cuenta es el TEXTO.
//
// COMO SE REPARTE EL TRABAJO CON LA DB. Todo lo que es Postgres vive en el RPC
// `borrar_cuenta_total` (migracion 073) y corre en UNA transaccion: 24 tablas borradas, 6
// anonimizadas, `pagos` sin comprobante, el rastro de auditoria purgado y la fila de
// `usuarios` convertida en lapida. O pasa todo, o no pasa nada — y por eso aca ya no hay
// nada del arsenal que el wipe viejo necesitaba para distinguir los tres estados de un fallo
// parcial. Si el RPC falla, no se borro NADA y eso se le puede decir a la persona sin mentir.
//
// Lo que queda de este lado es lo que Postgres no puede hacer, y son tres cosas que fallan
// por separado y se reportan por separado:
//
//   · Revocar el grant en Google — HTTP a un tercero.
//   · Borrar los objetos de Storage — borrar la fila de `storage.objects` NO borra el archivo
//     del bucket, asi que tiene que ir por la API de Storage.
//   · Borrar `auth.users` — Admin API. Sin esto la identidad sigue viva y la persona podria
//     seguir entrando a app.neto.pe. Medido el 17-ago: los 2 usuarios ya dados de baja
//     conservaban su fila de auth.
//
// EL ORDEN NO ES ARBITRARIO. La revocacion en Google va ANTES del RPC porque el RPC borra los
// refresh tokens, y sin token el grant queda vivo del lado de Google para siempre, sin forma
// de alcanzarlo. El listado de Storage tambien va antes, porque despues del RPC `pagos` ya no
// tiene los paths — aunque en realidad no dependemos de ellos, ver `listarComprobantes`.

const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { notificarAdmin } = require('../lib/admin-notify');
const { registrarError } = require('../lib/error-monitor');
const { esProPagado } = require('../lib/trial');
const { revocarAccesoGmail, hashEmailGmail } = require('../gmail');

const BUCKET_COMPROBANTES = 'comprobantes';

/**
 * Los objetos de Storage de este usuario.
 *
 * Se listan por CARPETA y no por `pagos.comprobante_url`, aunque esa columna los apunte.
 * Verificado contra produccion (17-ago-2026): los 14 objetos del bucket estan bajo
 * `<usuario_id>/`, y las 7 carpetas corresponden a usuarios reales. La carpeta es un
 * superconjunto: `subirComprobante` sube ANTES de insertar la fila de `pagos`, asi que una
 * subida cuya fila fallo queda huerfana y ninguna columna la nombra. Justo esa es la que se
 * quedaria para siempre.
 */
async function listarComprobantes(usuarioId) {
  const { data, error } = await supabase.storage.from(BUCKET_COMPROBANTES).list(usuarioId, { limit: 1000 });
  if (error) return { paths: null, error: error.message };
  return { paths: (data || []).map((o) => usuarioId + '/' + o.name), error: null };
}

/**
 * Rellena `email_hash` en las filas de Gmail que todavia no lo tengan.
 *
 * Es el unico momento donde su ausencia hace daño de verdad: el borrado esta a punto de
 * vaciar el correo, y si no queda hash se pierde para siempre el rastro de que ese usuario
 * de Google ya gasto uno de los 100 cupos. Alguien podria volver, conectar otro correo y
 * quemar otro cupo irrecuperable, pagando una sola vez.
 *
 * @returns {Promise<boolean>} si se puede borrar el correo en claro sin perder el cupo.
 */
async function leerCuentasGmail(usuarioId) {
  const { data, error } = await supabase.from('gmail_cuentas')
    .select('id, email, email_hash, activa').eq('usuario_id', usuarioId);
  if (error) {
    log.error({ tag: 'WIPE', usuarioId, err: error.message }, 'No se pudo leer gmail_cuentas');
    return { filas: [], error: error.message };
  }
  return { filas: data || [], error: null };
}

async function asegurarHashDeGmail(usuarioId, filas, errorLectura) {
  // Sin poder leer no se afirma nada. `false` = no borres el correo: preferimos retener un
  // dato de mas antes que perder un cupo que no se recupera nunca.
  if (errorLectura) return false;
  if (!filas.length) return true;   // no hay correo que borrar

  for (const fila of filas) {
    if (fila.email_hash || !fila.email) continue;
    const hash = hashEmailGmail(fila.email);
    // Falta `GMAIL_EMAIL_HASH_PEPPER`. Es la unica direccion de fallo aceptable acá.
    if (!hash) {
      log.error({ tag: 'WIPE', usuarioId },
        'Sin GMAIL_EMAIL_HASH_PEPPER no se puede hashear el correo: se conserva para no perder el cupo');
      return false;
    }
    const { error: errHash } = await supabase.from('gmail_cuentas')
      .update({ email_hash: hash }).eq('id', fila.id);
    // supabase-js NO lanza: sin leer esto, el UPDATE rechazado pasaria por bueno y el borrado
    // se llevaria el correo dejando la fila sin ninguna de las dos caras.
    if (errHash) {
      log.error({ tag: 'WIPE', usuarioId, err: errHash.message }, 'No se pudo escribir email_hash: el correo NO se borra');
      return false;
    }
  }
  return true;
}

/**
 * Borra la cuenta. Es el punto de entrada de las dos puertas.
 *
 * @param {object} usuario  fila de `usuarios` (id, nombre, whatsapp, plan, tipo_plan, premium_vence, supabase_auth_id)
 * @param {object} opts
 * @param {string} opts.origen  'whatsapp' | 'webapp' — solo para el aviso al admin
 * @returns {Promise<{ok: boolean, motivo: string|null, tieneGmail: boolean, resumen: object|null, sucio: string[]}>}
 */
async function borrarCuenta(usuario, { origen = 'desconocido' } = {}) {
  const usuarioId = usuario.id;
  const sucio = [];

  // ¿Hay Gmail que revocar? Se resuelve con una lectura PROPIA y no con `obtenerCuentasGmail`,
  // que hace `const { data } = await ...` y descarta el `{ error }`: devuelve `[]` tanto cuando
  // el usuario no tiene Gmail como cuando la lectura FALLÓ. Con esa forma, un statement timeout
  // dejaba `tieneGmail = false`, no se llamaba a `revocarAccesoGmail`, y el RPC borraba el
  // refresh token acto seguido — el grant quedaba vivo en Google PARA SIEMPRE y sin forma de
  // alcanzarlo, con `sucio` vacío y el admin sin enterarse. El `try/catch` no lo cubría porque
  // supabase-js NO lanza. Lo encontró la revisión adversarial del diff.
  //
  // Y de paso es la MISMA lectura que necesita el backfill del hash, así que no son dos.
  const { filas: filasGmail, error: errGmail } = await leerCuentasGmail(usuarioId);
  if (errGmail) {
    // "No sé" no es "no tiene". Se intenta revocar igual: `revocarAccesoGmail` es idempotente
    // y no tener nada que revocar es barato, mientras que NO intentarlo es irreversible.
    sucio.push('no se pudo leer `gmail_cuentas` (' + errGmail + '): se intentó revocar igual, por las dudas');
  }
  // El `|| usuario.gmail_refresh_token` NO es redundante: `cargarTokens` todavia tiene un
  // fallback a las columnas legacy de `usuarios`, asi que existe el usuario con el grant vivo
  // y SIN fila en `gmail_cuentas`. Sin esto no se revocaba, y el RPC le borraba los tokens dos
  // lineas despues: el permiso de lectura sobre su bandeja quedaba vivo para siempre y sin
  // forma de alcanzarlo. Lo levanto la segunda revision adversarial.
  const tieneGmail = errGmail ? true : (filasGmail.some((f) => f.activa) || !!usuario.gmail_refresh_token);

  // El hash ANTES del RPC: es lo que decide si el correo se puede borrar.
  const puedeBorrarEmailGmail = await asegurarHashDeGmail(usuarioId, filasGmail, errGmail);
  if (!puedeBorrarEmailGmail) {
    sucio.push('se conservo el correo de Gmail en claro: sin `email_hash` borrarlo perderia el cupo de Google');
  }

  // Storage se LISTA antes y se BORRA despues. Listar antes no es por los paths de `pagos`
  // (no se usan), sino para que un fallo de lectura del bucket se sepa antes de tocar la DB.
  const { paths: comprobantes, error: errListado } = await listarComprobantes(usuarioId);
  if (errListado) sucio.push('no se pudo listar Storage: ' + errListado);

  // ── Revocar en Google, ANTES del RPC ────────────────────────────────────────
  // El RPC borra los refresh tokens. Sin token, el grant queda vivo del lado de Google para
  // siempre y sin forma de alcanzarlo: seguiriamos con permiso de lectura sobre la bandeja de
  // alguien que se fue. No corta el flujo — la persona pidio irse y el dato se borra igual —
  // pero tiene que llegar al admin, porque se arregla a mano o no se arregla.
  if (tieneGmail) {
    try {
      await revocarAccesoGmail(usuarioId, { motivo: 'usuario_borro_cuenta' });
    } catch (e) {
      // `(e && e.message) || String(e)` y no `e.message`: un rechazo que no sea un Error
      // (`throw 'x'`, un reject con null) rompia DENTRO del catch, y esa excepcion se llevaba
      // puesto el borrado entero — el peor caso, causado por el manejo del peor caso.
      sucio.push('fallo la revocacion en Google: ' + ((e && e.message) || String(e)));
    }
  }

  // ── El borrado, en una transaccion ──────────────────────────────────────────
  const { data: resumen, error: errRpc } = await supabase.rpc('borrar_cuenta_total', {
    p_usuario_id: usuarioId,
    p_borrar_email_gmail: puedeBorrarEmailGmail,
  });
  if (errRpc) {
    // No se borro NADA: la transaccion se revirtio entera. Es lo que hace que el mensaje de
    // "tu cuenta sigue igual" sea verdad, y por eso acá no hace falta medir nada para decidir
    // que decirle a la persona.
    log.error({ tag: 'WIPE', usuarioId, origen, err: errRpc.message }, 'El borrado de cuenta FALLO: no se toco nada');
    try {
      await registrarError('WIPE', 'El borrado total FALLO', { usuarioId, detalle: 'origen: ' + origen + ' · ' + errRpc.message });
    } catch (e) { /* el registro del fallo no puede ser el que rompa la respuesta */ }
    try {
      await notificarAdmin('⚠️ *BORRADO FALLIDO* — nadie perdio datos, pero alguien quiso irse y no pudo\n\n' +
        'Usuario: ' + (usuario.nombre || 'sin nombre') + ' (' + String(usuarioId).slice(0, 8) + ')\n' +
        'Origen: ' + origen + '\n' +
        'Error: ' + errRpc.message);
    } catch (e) { /* `notificarAdmin` no lanza, pero el aviso nunca puede tumbar la respuesta */ }
    return { ok: false, motivo: errRpc.message, tieneGmail, resumen: null, sucio };
  }

  // A partir de aca los datos YA NO ESTAN. Nada de lo que siga puede revertirse ni puede
  // impedir que la persona reciba su respuesta: todo va a `sucio` y de ahi al admin.

  // El RPC corto por idempotencia: esta cuenta YA estaba borrada. No es una baja nueva, asi
  // que no se avisa de nuevo —un segundo "BAJA DECLARADA" con los contadores en cero es
  // indistinguible de una baja real sin datos— pero si se siguen intentando Storage y
  // `auth.users`, que viven FUERA de la transaccion y pueden haber quedado a medias en el
  // intento anterior. Es justamente el caso que hace util reintentar.
  if (resumen && resumen.ya_borrada) {
    log.warn({ tag: 'WIPE', usuarioId, origen }, 'La cuenta ya estaba borrada: se reintenta solo lo de afuera');
  }

  // Se marca la fila EN MEMORIA. El llamador sigue teniendo la version vieja, y en el camino
  // de WhatsApp eso importaba: `webhook.js` guarda el turno de la conversacion DESPUES de que
  // `manejarOnboarding` devuelve, asi que reinsertaba en `conversaciones` —tabla que la
  // transaccion acababa de vaciar— el ultimo mensaje de la persona y el texto que le dice
  // "borre todo lo que nos escribimos". Pasaba en el 100% de las bajas por WhatsApp y el
  // `residual` no podia verlo, porque se calcula DENTRO de la transaccion.
  usuario.cuenta_borrada_at = (resumen && resumen.cuenta_borrada_at) || new Date().toISOString();

  // ── Storage ─────────────────────────────────────────────────────────────────
  if (comprobantes && comprobantes.length) {
    const { error: errStorage } = await supabase.storage.from(BUCKET_COMPROBANTES).remove(comprobantes);
    if (errStorage) sucio.push('quedaron ' + comprobantes.length + ' comprobante(s) en Storage: ' + errStorage.message);
  }

  // ── auth.users ──────────────────────────────────────────────────────────────
  // El RPC ya solto `supabase_auth_id` de la lapida, asi que este id se lee de la fila que
  // trajo el llamador. Si no se borra, la identidad sigue viva y la persona puede seguir
  // entrando a app.neto.pe — a una cuenta sin datos, pero entrando.
  if (usuario.supabase_auth_id) {
    // El id VA EN EL TEXTO del fallo, y no es verbosidad: el RPC ya puso `supabase_auth_id` en
    // NULL dentro de la transaccion, asi que si este borrado falla el puntero deja de existir
    // en cualquier lado. Un reintento por la webapp tampoco sirve —relee la fila, ve null y
    // saltea el paso— o sea que sin este string queda una identidad huerfana que puede seguir
    // autenticando y que nadie puede encontrar. Lo levanto la revision adversarial del diff.
    const pista = ' (auth_id: ' + usuario.supabase_auth_id + ')';
    try {
      const { error: errAuth } = await supabase.auth.admin.deleteUser(usuario.supabase_auth_id);
      if (errAuth) sucio.push('quedo viva la identidad en Supabase Auth' + pista + ': ' + errAuth.message);
    } catch (e) {
      sucio.push('quedo viva la identidad en Supabase Auth' + pista + ': ' + ((e && e.message) || String(e)));
    }
  }

  // El residual lo calcula el RPC recomputando de `pg_constraint`, o sea que delata una tabla
  // nueva que nadie clasifico. Es el unico aviso que existe para ese caso.
  const residual = (resumen && resumen.residual) || {};
  if (Object.keys(residual).length) {
    sucio.push('quedaron filas sin clasificar: ' + JSON.stringify(residual));
  }

  if (sucio.length) {
    log.error({ tag: 'WIPE', usuarioId, origen, sucio: sucio.join(' · ') }, 'El borrado dejo cosas a medias');
  }

  if (!(resumen && resumen.ya_borrada)) {
    await avisarBajaAlAdmin(usuario, { resumen, sucio, origen });
  }

  return { ok: true, motivo: null, tieneGmail, resumen, sucio };
}

/**
 * El aviso es best-effort por construccion: los datos ya se borraron y no hay nada que
 * reintentar. Un fallo aca no puede propagarse a la respuesta que espera la persona.
 *
 * Es la unica baja DECLARADA del producto — todo lo demas (inactividad, vencimiento) es una
 * inferencia nuestra; esto lo pidio la persona.
 */
async function avisarBajaAlAdmin(usuario, { resumen, sucio, origen }) {
  try {
    const pagado = esProPagado(usuario);
    const partes = [
      '🗑️ *BAJA DECLARADA* — un usuario borro su cuenta',
      '',
      // El id COMPLETO, no los 8 primeros caracteres: cuando algo queda a medias hay que ir a
      // buscarlo a mano —la carpeta de Storage es el uuid entero— y un prefijo obliga a una
      // query extra justo en el momento en que uno esta apurado.
      'Usuario: ' + (usuario.nombre || 'sin nombre') + ' (' + usuario.id + ')',
      'Origen: ' + origen,
      // Lo que convierte el aviso en accionable: "se fue" vale poco, "se fue con 131
      // movimientos y plan anual vigente hasta 2027" dice si hay que llamarlo. Los conteos
      // salen del RPC, que los tomo ANTES de borrar — la unica ventana donde existian.
      'Movimientos que tenia: ' + (resumen?.transacciones ?? 'no se pudo contar'),
      'Deudas: ' + (resumen?.deudas ?? '?') + ' · Conversaciones: ' + (resumen?.conversaciones ?? '?'),
      'Rastro de auditoria purgado: ' + (resumen?.auditoria_purgada ?? '?') + ' filas',
    ];
    if (pagado) {
      // Distingue a alguien que probo y se fue de un CLIENTE que pago y se fue. Y ahora
      // ademas hay que actuar: el numero se borro, asi que si vuelve NO se lo reconoce solo.
      partes.push('');
      partes.push('⚠️ *ERA PRO PAGADO* — plan ' + (usuario.tipo_plan || 'mensual') +
        ', vigente hasta ' + (usuario.premium_vence || 'sin fecha'));
      partes.push('El plan sigue en su fila, pero su numero se borro: si vuelve, entra como usuario NUEVO.');
      partes.push('Se le dijo que escriba a soporte para que le devolvamos el Pro.');
    }
    if (sucio.length) {
      partes.push('');
      partes.push('❗ Quedo a medias — ' + sucio.join('\n❗ '));
      partes.push('Esto no tiene reintento automatico: se cierra a mano.');
    }
    // `notificarAdmin` NUNCA lanza: tiene su propio try/catch y devuelve false cuando fallan
    // los dos canales (Telegram caido + WhatsApp fuera de la ventana de 24h de Meta). Sin leer
    // el booleano, el catch de abajo era inalcanzable y la unica baja declarada del producto
    // podia evaporarse sin dejar rastro. Este evento no tiene reintento ni cola: el log ES el
    // ultimo respaldo.
    const ok = await notificarAdmin(partes.join('\n'));
    if (!ok) {
      log.error({ tag: 'WIPE', usuarioId: usuario.id, pagado, resumen },
        'BAJA DECLARADA sin avisar: fallaron Telegram y WhatsApp');
    }
  } catch (e) {
    log.error({ tag: 'WIPE', usuarioId: usuario.id, err: e.message }, 'No se pudo avisar la baja al admin');
  }
}

module.exports = { borrarCuenta };
