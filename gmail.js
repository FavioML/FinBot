const { google } = require('googleapis');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const log = require('./lib/logger');
const { encrypt, decrypt } = require('./lib/crypto');

let _supabase = null;
function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return _supabase;
}

// Timeout de transporte para TODA llamada a las APIs de Google. gaxios —el cliente HTTP de
// googleapis— **no trae timeout por default**, así que una conexión que Google acepta y nunca
// responde deja el `await` colgado indefinidamente. Medido contra un servidor que acepta y no
// contesta: sin esta línea seguía esperando a los 8 segundos; con ella aborta a los 30.
//
// Importa por el barrido de Gmail: `escaneoAutomatico` corre al boot y cada 15 minutos, y desde
// que existe el guard de no-solape (`cron/sin-solape.js`) una corrida colgada **impide todas las
// siguientes** hasta el próximo deploy. Con el timeout, esa corrida muere sola, el error sube a
// `unhandledRejection` (que lo registra y avisa al admin) y el tick siguiente reintenta.
// `checkGmailHuerfanos` cuelga del mismo transporte vía `oauth2Client.revokeToken`.
//
// Es una opción global de transporte, no de la lógica de OAuth ni de los cupos: no cambia qué
// se pide ni con qué credencial.
google.options({ timeout: 30000 });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  (process.env.RAILWAY_URL || 'https://api.neto.pe') + '/auth/callback'
);

const REMITENTES_BANCARIOS = [
  'notificaciones@yape.pe', 'alertas@bcp.com.pe', 'notificaciones@bcp.com.pe',
  'notificaciones@notificacionesbcp.com.pe',
  'alertas@interbank.pe', 'notificaciones@interbank.pe', 'alertas@bbva.pe',
  'notificaciones@bbva.pe', 'notificaciones.tarjetas@scotiabank.pe',
  'alertas@scotiabank.pe', 'notificaciones@plin.pe', 'noreply@tunki.pe',
  // Bancos adicionales
  'notificaciones@bancofalabella.pe', 'alertas@bancofalabella.pe',
  'notificaciones@bancoripley.com.pe', 'alertas@bancoripley.com.pe',
  'notificaciones@banbif.com.pe', 'alertas@banbif.com.pe',
  'notificaciones@mibanco.com.pe', 'alertas@mibanco.com.pe',
  'notificaciones@cajahuancayo.com.pe', 'notificaciones@cmacpiura.com.pe',
  'notificaciones@cajatrujillo.com.pe', 'notificaciones@cajacusco.com.pe',
  'notificaciones@cmacica.com.pe', 'notificaciones@cajasullana.com.pe',
];

// Catálogo de bancos para que el usuario Pro elija cuáles leer al conectar Gmail.
// Cada entrada agrupa los remitentes de REMITENTES_BANCARIOS por institución; su
// `id` se guarda en usuarios.bancos_seleccionados y el scan lo expande a la union
// de sus remitentes. Al agregar un remitente nuevo arriba, súmalo también aquí.
const BANCOS_CATALOGO = [
  { id: 'bcp', label: 'BCP', remitentes: ['alertas@bcp.com.pe', 'notificaciones@bcp.com.pe', 'notificaciones@notificacionesbcp.com.pe'] },
  { id: 'interbank', label: 'Interbank', remitentes: ['alertas@interbank.pe', 'notificaciones@interbank.pe'] },
  { id: 'bbva', label: 'BBVA', remitentes: ['alertas@bbva.pe', 'notificaciones@bbva.pe'] },
  { id: 'scotiabank', label: 'Scotiabank', remitentes: ['notificaciones.tarjetas@scotiabank.pe', 'alertas@scotiabank.pe'] },
  { id: 'yape', label: 'Yape', remitentes: ['notificaciones@yape.pe'] },
  { id: 'plin', label: 'Plin', remitentes: ['notificaciones@plin.pe'] },
  { id: 'tunki', label: 'Tunki', remitentes: ['noreply@tunki.pe'] },
  { id: 'falabella', label: 'Banco Falabella', remitentes: ['notificaciones@bancofalabella.pe', 'alertas@bancofalabella.pe'] },
  { id: 'ripley', label: 'Banco Ripley', remitentes: ['notificaciones@bancoripley.com.pe', 'alertas@bancoripley.com.pe'] },
  { id: 'banbif', label: 'BanBif', remitentes: ['notificaciones@banbif.com.pe', 'alertas@banbif.com.pe'] },
  { id: 'mibanco', label: 'Mibanco', remitentes: ['notificaciones@mibanco.com.pe', 'alertas@mibanco.com.pe'] },
  { id: 'cajas', label: 'Cajas municipales (Huancayo, Piura, Trujillo, Cusco, Ica, Sullana)', remitentes: ['notificaciones@cajahuancayo.com.pe', 'notificaciones@cmacpiura.com.pe', 'notificaciones@cajatrujillo.com.pe', 'notificaciones@cajacusco.com.pe', 'notificaciones@cmacica.com.pe', 'notificaciones@cajasullana.com.pe'] },
];

// Traduce la selección del usuario (array de ids del catálogo) a la lista de
// remitentes para el scan. Selección vacía/null/ids desconocidos → set completo
// (backward-compatible con quienes conectaron antes de existir esta columna).
function remitentesParaSeleccion(seleccion) {
  if (!Array.isArray(seleccion) || seleccion.length === 0) return REMITENTES_BANCARIOS;
  const set = new Set(seleccion);
  const remitentes = BANCOS_CATALOGO.filter(b => set.has(b.id)).flatMap(b => b.remitentes);
  return remitentes.length > 0 ? remitentes : REMITENTES_BANCARIOS;
}

// Describe la selección guardada en texto legible. null/[] → "todos los bancos".
// La elección en sí se hace con checkboxes en app.neto.pe/dashboard/pro; los menús
// numerados de WhatsApp (`menuSeleccionBancos` / `menuEdicionBancos`) se borraron con
// los pasos 30 y 31, que eran sus únicos llamadores.
function describirSeleccion(seleccion) {
  if (!Array.isArray(seleccion) || seleccion.length === 0) return 'todos los bancos';
  const labels = BANCOS_CATALOGO.filter(b => seleccion.includes(b.id)).map(b => b.label);
  return labels.length > 0 ? labels.join(', ') : 'todos los bancos';
}

const PALABRAS_BANCARIAS = [
  'realizaste', 'transaccion', 'consumo', 'pago realizado', 'transferencia',
  'operacion', 'yape', 'plin', 'izipay', 'BCP', 'Interbank', 'BBVA',
  'Scotiabank', 'Falabella', 'Ripley', 'BanBif', 'Mibanco', 'CMAC',
  'Caja Huancayo', 'Caja Piura', 'Caja Trujillo', 'Caja Cusco',
  'soles', 'S/', 'tarjeta', 'cuenta', 'cargo', 'abono',
  'deposito', 'retiro', 'compra', 'comercio', 'monto'
];

// Subjects conocidos de cada banco para detección rápida
const SUBJECTS_BANCARIOS = [
  'realizaste un consumo',
  'realizaste un pago',
  'transferencia realizada',
  'operacion realizada',
  'cargo en tu cuenta',
  'abono en tu cuenta',
  'notificacion de operacion',
  'confirmacion de pago',
  'yapeo exitoso',
  'yapaste',
  'plin',
  'consumo con tu tarjeta',
  'consumo tarjeta',
  'tarjeta de credito bcp',
  'tarjeta de debito bcp',
  'retiro de efectivo',
  'pago de servicio',
  'constancia de pago',
  'servicio de notificaciones bcp',
  'alerta de movimiento',
  'movimiento en tu cuenta',
  'interbank te informa',
  'bbva',
  'scotiabank',
  'falabella',
  'ripley',
  'banbif',
  'mibanco',
  'caja',
  'cmac',
];

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
];

// Secreto para firmar el state OAuth. Reutiliza GOOGLE_CLIENT_SECRET (server-only y
// siempre presente si OAuth funciona) cuando no hay uno dedicado; ninguno sale del backend.
function stateSecret() {
  return process.env.OAUTH_STATE_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
}

function firmarState(payloadB64) {
  return crypto.createHmac('sha256', stateSecret()).update(payloadB64).digest('base64url');
}

// TTL generoso: el enlace OAuth puede quedar en un chat de WhatsApp y abrirse horas después
// (ej. el link post-pago). La firma es el control de seguridad; `ts` es solo anti-replay.
// Un replay de un state legítimo es inofensivo (sin un `code` real de Google el callback falla).
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {string} whatsappNum
 * @param {string} [modo]
 * @param {string} [origen]
 * @param {string} [usuarioId]
 * @param {string|null} [emailActual]  correo ya vinculado, si lo hay. Se manda como
 *   `login_hint` para que Google preseleccione ESA cuenta.
 *
 * El `login_hint` no es cosmético y es la ÚNICA defensa que existe contra gastar un cupo de
 * más. El cupo de Google se consume cuando el usuario aprueba en la pantalla de Google, o sea
 * ANTES de que nuestro callback corra: cuando podemos mirar qué correo eligió, el cupo ya está
 * gastado y revocar no lo devuelve. Rechazar en el callback impide que tenga dos cuentas, pero
 * no des-quema el cupo. Lo único que evita la pérdida es que no elija otra cuenta, y para eso
 * está esto (Google igual le deja cambiarla, por eso el callback también valida).
 */
function generarUrlAutorizacion(whatsappNum, modo, origen, usuarioId, emailActual) {
  const stateObj = { num: whatsappNum || '', modo: modo || 'inicial', ts: Date.now() };
  if (origen) stateObj.origen = origen; // 'web' → el callback redirige a la webapp
  // uid liga el vínculo por identidad, no por número: un Pro web-only no tiene
  // whatsapp, así que sin esto el callback no sabría a quién asignar el token.
  // Solo se agrega cuando se pasa → los states de los flujos WhatsApp (que no lo
  // pasan) quedan idénticos y su resolución por `num` sigue igual.
  if (usuarioId) stateObj.uid = usuarioId;
  const payload = Buffer.from(JSON.stringify(stateObj)).toString('base64url');
  const state = payload + '.' + firmarState(payload);
  const opciones = {
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state
  };
  if (emailActual) opciones.login_hint = emailActual;
  return oauth2Client.generateAuthUrl(opciones);
}

/**
 * Huella irreversible de un correo de Google. Es lo ÚNICO del vínculo con Gmail que sobrevive
 * a un borrado de cuenta, y existe para que sobrevivir no cueste retener la dirección.
 *
 * El pepper vive en el entorno, NO en la base: un dump de Postgres —o un backup de R2, que se
 * guarda 365 días— no alcanza para revertirlo. Un correo tiene poca entropía frente a una
 * lista de candidatos, así que sin pepper esto sería decorativo.
 *
 * Devuelve `null` si falta el pepper, y NO lanza: quien decide qué hacer con esa ausencia es
 * el llamador, y en el borrado la decisión es conservar el correo (ver `borrarCuenta`).
 *
 * @returns {string|null}
 */
function hashEmailGmail(email) {
  const pepper = process.env.GMAIL_EMAIL_HASH_PEPPER;
  if (!pepper || !email) return null;
  return crypto.createHmac('sha256', pepper).update(String(email).trim().toLowerCase()).digest('hex');
}

/**
 * El correo de Gmail que este usuario ya vinculó ALGUNA VEZ, activo o no.
 *
 * Mira el historial y no solo lo activo a propósito: una fila inactiva significa que ese
 * usuario de Google YA otorgó permiso y su cupo ya se gastó (revocar no lo devuelve). Para
 * decidir "¿esto sería una cuenta nueva?" el pasado es lo que cuenta, no el presente.
 *
 * Devuelve las DOS caras porque son dos preguntas distintas que hasta la migración 073
 * compartían una sola columna, y el borrado de cuenta las separó:
 *
 *   · `email`     — para el `login_hint`. Es comodidad y es dato personal: el borrado lo vacía.
 *   · `emailHash` — para "¿este correo ya gastó cupo?". Es el invariante: SOBREVIVE al borrado.
 *
 * Después de una baja la fila más vieja tiene `email` en null y `emailHash` puesto. Por eso
 * el gate del canje (`routes/public.js`) TIENE que mirar el hash: si mirara el correo vería
 * null, concluiría "nunca vinculó nada" y dejaría quemar otro de los 100 cupos de por vida.
 *
 * @returns {Promise<{email: string|null, emailHash: string|null}|null>}
 */
async function emailGmailVinculado(usuarioId) {
  const { data } = await getSupabase().from('gmail_cuentas')
    .select('email, email_hash').eq('usuario_id', usuarioId)
    .order('created_at', { ascending: true }).limit(1);
  const fila = data && data[0];
  if (!fila) return null;
  return { email: fila.email || null, emailHash: fila.email_hash || null };
}

/**
 * ¿El correo que acaba de autorizar es el MISMO que este usuario ya tenía vinculado?
 *
 * Único lugar donde se decide esa comparación, para que no se reimplemente distinto en cada
 * call-site. Prefiere el hash y cae al correo en claro solo mientras la fila no esté
 * backfilleada — que es exactamente lo que el código hacía antes de la 073, o sea que el
 * estado intermedio no cambia ningún comportamiento.
 *
 * Con `previo` sin ninguna de las dos (fila borrada sin hash porque faltaba el pepper) no se
 * puede afirmar nada, y devuelve `null` = "no sé". El llamador NO debe leer eso como "es el
 * mismo": dejaría pasar un segundo correo.
 *
 * @returns {boolean|null}
 */
function esElMismoGmail(previo, emailEntrante) {
  if (!previo || !emailEntrante) return null;
  // El hash MANDA cuando se puede calcular. Si NO se puede —falta el pepper— y el correo en
  // claro todavía está, se compara por correo: es exactamente lo que hacía el código antes de
  // la 073, así que no se pierde nada.
  //
  // OJO CON LA ROTACIÓN, que este fallback NO cubre y una versión anterior de este comentario
  // decía que sí: con un pepper NUEVO, `hashEmailGmail` devuelve un valor perfectamente
  // válido que simplemente no coincide con el guardado, así que se resuelve `false` y el
  // fallback ni se toca. Quien reconecta su propio correo recibe el 409 y le revocamos el
  // grant recién emitido. Rotar el pepper exige backfillear `email_hash` en la misma pasada
  // (ver `.env.example`).
  //
  // Sin este fallback el pepper se convertía en dependencia dura del canje: con la fila ya
  // backfilleada (hash Y correo presentes), un deploy sin la env var hacía que quien reconecta
  // SU MISMO correo recibiera el 409 "escríbenos y lo resolvemos" y le revocáramos el grant
  // recién emitido, con la respuesta correcta ahí al lado sin mirarse. Lo levantó la revisión
  // adversarial del diff.
  if (previo.emailHash) {
    const entrante = hashEmailGmail(emailEntrante);
    if (entrante) return previo.emailHash === entrante;
  }
  if (previo.email) return previo.email === emailEntrante;
  // Ninguna de las dos caras: hubo una cuenta (por eso existe la fila) y no se puede
  // identificar. `null` = "no sé", y el gate lo trata como rechazo.
  return null;
}

// Verifica la firma HMAC del state y lo decodifica. Devuelve el objeto {num, modo, origen}
// o null si la firma no valida, el formato es inválido o venció. Nunca adivina el usuario.
function verificarState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) return null;
  const idx = state.lastIndexOf('.');
  const payload = state.slice(0, idx);
  const sig = state.slice(idx + 1);
  if (!payload || !sig) return null;
  const esperada = firmarState(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!obj.ts || (Date.now() - obj.ts) > STATE_TTL_MS) return null;
  return obj;
}

/**
 * Guarda la conexión de Gmail recién autorizada. **UNA sola cuenta activa por usuario.**
 *
 * No es una preferencia de UI: cada cuenta de Google distinta consume OTRO de los 100 cupos
 * de por vida (el límite cuenta usuarios que otorgaron permiso, y no se restablece). Permitir
 * varias dejaba a un usuario gastando N cupos por un solo pago de S/10, y cobrar por cuenta
 * conectada se descartó por no complicar el modelo.
 *
 * El límite se hace cumplir ACÁ y no en el modo, a propósito. Antes dependía de que el state
 * firmado dijera `reemplazar`: con `inicial` —el modo por defecto, el que manda la webapp— el
 * upsert dejaba viva la cuenta anterior, así que alcanzaba con volver a llamar la API teniendo
 * ya una conectada para acumular. Este es el único punto por donde pasa TODA conexión, venga
 * del modo que venga, incluido un enlace viejo emitido con un modo que ya no existe.
 */
async function guardarTokens(usuarioId, tokens, email) {
  // Antes de escribir nada: soltar lo que hubiera. Va PRIMERO porque revocarAccesoGmail
  // limpia los campos legacy de `usuarios` cuando revoca la última cuenta activa — hacerlo
  // después borraría los tokens nuevos que acabamos de guardar.
  //
  // Se salta la cuenta con el MISMO email (reconexión tras un invalid_grant): revocar ahí
  // tumbaría el grant que Google acaba de emitir, porque es el mismo. Y además no hay cupo
  // nuevo en juego: es el mismo usuario de Google que ya estaba contado.
  if (email) {
    const { data: previas, error: errPrevias } = await getSupabase().from('gmail_cuentas')
      .select('id, email').eq('usuario_id', usuarioId).eq('activa', true);
    // supabase-js no lanza: sin leer este error, un hipo de red devuelve data=null, el loop
    // de revocación se salta y el upsert deja DOS cuentas activas — y la regla una-cuenta
    // no vive en la DB (el índice único es (usuario_id,email)), así que nada la repararía
    // después. Lanzar acá corta el canje: el callback ya tiene página de error + reintento.
    if (errPrevias) throw new Error('guardarTokens: no se pudo leer las cuentas previas: ' + errPrevias.message);
    for (const previa of previas || []) {
      if (previa.email === email) continue;
      await revocarAccesoGmail(usuarioId, { motivo: 'reemplazada_por_conexion_nueva', cuentaId: previa.id });
    }
  }

  // Siempre sincronizar en usuarios para backwards compat (encrypted)
  const updateData = { gmail_access_token: encrypt(tokens.access_token), gmail_token_expiry: tokens.expiry_date };
  if (tokens.refresh_token) updateData.gmail_refresh_token = encrypt(tokens.refresh_token);
  const { error: errUsuario } = await getSupabase().from('usuarios').update(updateData).eq('id', usuarioId);
  if (errUsuario) throw new Error('guardarTokens: no se pudo sincronizar los tokens en usuarios: ' + errUsuario.message);

  if (!email) return; // sin email no se puede guardar en gmail_cuentas

  // Upsert la cuenta nueva (encrypted tokens)
  const cuenta = {
    usuario_id: usuarioId,
    email,
    // La huella que sobrevive al borrado de cuenta. Se escribe SIEMPRE, no solo cuando hace
    // falta, porque el momento en que hace falta —el wipe— es demasiado tarde para calcularla
    // si para entonces falta el pepper. `null` cuando no hay pepper: el gate cae al correo en
    // claro, que es el comportamiento anterior a la 073.
    email_hash: hashEmailGmail(email),
    access_token: encrypt(tokens.access_token),
    token_expiry: tokens.expiry_date || null,
    activa: true,
    // Toda conexión exitosa borra la marca de auth caída: acabamos de recibir credenciales
    // que Google aceptó, así que la fila vuelve a ser sana. Va en el mismo upsert para que
    // no exista un instante en que la cuenta esté reconectada y la app la siga dando por rota.
    auth_error_at: null,
    updated_at: new Date().toISOString()
  };
  if (tokens.refresh_token) cuenta.refresh_token = encrypt(tokens.refresh_token);
  const { error: errUpsert } = await getSupabase().from('gmail_cuentas').upsert(cuenta, { onConflict: 'usuario_id,email' });
  // Sin esto, una conexión podía "completarse" (callback feliz) sin que la cuenta quedara
  // escrita: el usuario vería "conectado" y el barrido no leería nada.
  if (errUpsert) throw new Error('guardarTokens: no se pudo guardar la cuenta: ' + errUpsert.message);
}

/**
 * Las cuentas de Gmail ACTIVAS de un usuario.
 *
 * **LANZA cuando no puede leer, y ese cambio es del 2026-09-02.** Descartaba el `{ error }` y
 * devolvía `[]`, o sea que un timeout de Supabase era indistinguible de "esta persona no
 * conectó Gmail". Eso no era un detalle: `leerCorreosBancarios` cae al token legacy cuando esta
 * función devuelve vacío, así que un hipo de red terminaba en `no_auth`, y desde que `no_auth`
 * significa `{sinCuenta:true}` el usuario recibía **"conéctalo en la app"** teniendo su cuenta
 * conectada. Es el mismo defecto que ese cambio venía a arreglar, reintroducido por la rama de
 * error. Lo encontró una revisión adversarial sondeando con `fetch` roto.
 *
 * El segundo daño era más silencioso: con el error tragado acá, el `try/catch` de
 * `tieneGmailConectado` **nunca se ejecutaba** y su `log.warn` no se emitió jamás.
 *
 * Los consumidores que prefieren degradar antes que romper (los que eligen COPY) envuelven la
 * llamada; los que deciden algo real dejan que propague. Devolver `[]` no le deja esa elección
 * a nadie.
 */
async function obtenerCuentasGmail(usuarioId) {
  const { data, error } = await getSupabase().from('gmail_cuentas').select('*')
    .eq('usuario_id', usuarioId).eq('activa', true).order('created_at', { ascending: true });
  if (error) {
    log.error({ tag: 'GMAIL', usuarioId, err: error.message }, 'No se pudieron leer las cuentas de Gmail');
    throw new Error('No se pudieron leer las cuentas de Gmail: ' + error.message);
  }
  return data || [];
}

/**
 * ¿Esta persona tiene Gmail conectado? La UNION de las dos fuentes, para el backend.
 *
 * Vive acá y no en `lib/gmail-conectado.js` porque hace I/O y ese módulo es puro a propósito
 * (su test de paridad contra el TS depende de eso). La regla es la misma: token legacy en
 * `usuarios` ∪ una fila `activa` en `gmail_cuentas`.
 *
 * **El corte por el token legacy va primero y no es una optimización cosmética.** El caso común
 * es no tener Gmail —3 de 102 usuarios al 2026-09-01— así que la query se paga solo cuando la
 * columna vieja no alcanza, que es justo cuando hace falta.
 *
 * Falla hacia "no tiene": si la lectura se cae, la alternativa es afirmar que sí lo tiene y
 * esconderle el enlace para conectarlo, que es peor. Todos los call-sites usan esto para elegir
 * COPY, así que degradar cuesta un mensaje subóptimo y no una capability.
 *
 * Nació inline en `handlers/message-processor.js` como `resolverCorreoConectado`. Se movió acá
 * el 2026-09-02 al aparecer el tercer y cuarto consumidor: los tres sitios que faltaban leían
 * la columna legacy sola y le daban a quien tiene Gmail el copy del que no lo tiene.
 */
async function tieneGmailConectado(usuario) {
  if (usuario.gmail_access_token) return true;
  try {
    return (await obtenerCuentasGmail(usuario.id)).length > 0;
  } catch (e) {
    log.warn({ tag: 'GMAIL', usuarioId: usuario.id, err: e.message }, 'No se pudo verificar Gmail; asumo sin correo');
    return false;
  }
}

/**
 * Suelta el acceso a Gmail de un usuario: se lo dice a GOOGLE y recién después limpia acá.
 *
 * El orden importa y es la razón de existir de esta función. Hasta ahora "desconectar" era
 * un flip local de `activa: false` (onboarding.js), que le corta la lectura al usuario pero
 * deja el grant vivo del lado de Google: seguíamos teniendo permiso técnico para leer el
 * correo de alguien que ya no paga. Revocar el refresh token tumba el grant completo (y con
 * él todos los access tokens derivados).
 *
 * ⚠️ Esto NO devuelve un cupo. El límite de 100 usuarios de OAuth de Google se cuenta sobre
 * TODO EL CICLO DE VIDA del proyecto y su propia consola dice que "no se puede restablecer ni
 * cambiar": cuenta a quien alguna vez otorgó permiso, no a quien lo tiene ahora. O sea que el
 * cupo se pierde al CONECTAR y no vuelve. Lo que protege el inventario es el gate de entrada
 * (`esProPagado` en las puertas de OAuth); esto es higiene: cortar un permiso vivo sobre la
 * bandeja de alguien que dejó de pagar, y dejar el estado local honesto.
 *
 * Tolerante a fallos A PROPÓSITO: esto se llama desde el camino que baja a alguien de plan, y
 * un timeout con Google no puede dejar a un usuario a medio bajar. Si la revocación falla, se
 * loguea y se limpia local igual — la próxima corrida de checkGmailHuerfanos lo reintenta.
 * `invalid_token` no es un fallo: significa que el grant ya no existía, que es el destino.
 *
 * @returns {Promise<{revocadas: number, emails: string[]}>}
 */
async function revocarAccesoGmail(usuarioId, { motivo = 'sin_motivo', cuentaId = null } = {}) {
  const todas = await obtenerCuentasGmail(usuarioId);
  // `cuentaId` sirve al usuario multi-cuenta que desconecta UNA sola: revocar las otras le
  // apagaría en silencio una lectura que sigue pagando y no pidió cortar.
  const cuentas = cuentaId ? todas.filter((c) => c.id === cuentaId) : todas;
  if (cuentas.length === 0) return { revocadas: 0, emails: [] };

  const emails = [];
  for (const cuenta of cuentas) {
    // El refresh token es el que sostiene el grant; el access token solo sirve de plan B
    // para una fila vieja que nunca lo recibió.
    let token = null;
    try {
      token = decrypt(cuenta.refresh_token) || decrypt(cuenta.access_token);
    } catch (e) {
      log.warn({ tag: 'GMAIL_REVOKE', usuarioId, err: e.message }, 'No se pudo descifrar el token; se limpia local igual');
    }
    if (token) {
      try {
        await oauth2Client.revokeToken(token);
      } catch (e) {
        const yaMuerto = /invalid_token|invalid_grant/i.test(e.message || '');
        log[yaMuerto ? 'info' : 'error'](
          { tag: 'GMAIL_REVOKE', usuarioId, email: cuenta.email, motivo, err: e.message },
          yaMuerto ? 'El grant ya no existía en Google' : 'Falló la revocación en Google; se limpia local igual',
        );
      }
    }
    emails.push(cuenta.email);
  }

  // Cierre local, pase lo que pase con Google. Se conserva la fila (no `delete`): mantiene el
  // email para historial y deja que el upsert de guardarTokens reconecte limpio por
  // onConflict 'usuario_id,email'. Los tokens se anulan porque ya están muertos: guardarlos
  // cifrados no aporta nada y es pasivo.
  const limpieza = getSupabase().from('gmail_cuentas')
    .update({ activa: false, access_token: null, refresh_token: null, token_expiry: null, updated_at: new Date().toISOString() })
    .eq('usuario_id', usuarioId).eq('activa', true);
  await (cuentaId ? limpieza.eq('id', cuentaId) : limpieza);

  // Los campos legacy de `usuarios` describen "la" cuenta del usuario, así que solo se
  // limpian cuando no le queda ninguna activa: borrarlos al desconectar una de tres dejaría
  // al usuario viéndose desconectado con dos cuentas leyendo.
  if (!cuentaId || todas.length === cuentas.length) {
    await getSupabase().from('usuarios')
      .update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null })
      .eq('id', usuarioId);
  }

  log.info({ tag: 'GMAIL_REVOKE', usuarioId, emails, motivo }, 'Acceso a Gmail revocado en Google');
  return { revocadas: emails.length, emails };
}

async function obtenerPerfilGoogle(authClient) {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: authClient });
    const { data } = await oauth2.userinfo.get();
    return { nombre: data.given_name || data.name || null, email: data.email || null };
  } catch(e) {
    log.error({ tag: 'PERFIL', err: e.message }, 'Error obteniendo perfil');
    return { nombre: null, email: null };
  }
}

async function cargarTokens(usuarioId) {
  // Primero intenta desde gmail_cuentas (nueva estructura)
  const cuentas = await obtenerCuentasGmail(usuarioId);
  if (cuentas.length > 0) {
    const c = cuentas[0];
    return { access_token: decrypt(c.access_token), refresh_token: decrypt(c.refresh_token), expiry_date: c.token_expiry };
  }
  // Fallback a usuarios tabla
  const { data } = await getSupabase().from('usuarios')
    .select('gmail_access_token, gmail_refresh_token, gmail_token_expiry').eq('id', usuarioId).single();
  if (!data || !data.gmail_access_token) return null;
  return { access_token: decrypt(data.gmail_access_token), refresh_token: decrypt(data.gmail_refresh_token), expiry_date: data.gmail_token_expiry };
}

function crearClienteOAuth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.RAILWAY_URL || 'https://api.neto.pe') + '/auth/callback'
  );
}

/**
 * Persiste que Google dejó de aceptar el refresh token de esta cuenta.
 *
 * Sin esto el estado roto solo existía en un log y en un throttle en memoria: la fila quedaba
 * en `activa = true`, así que la app seguía afirmando "Gmail conectado" mientras no leía nada.
 *
 * Va acá y no en el barrido porque este es el único punto que sabe QUÉ fila falló —
 * `leerCorreosBancarios` colapsa N cuentas en un solo flag y `escanearGmailYRegistrar`
 * devuelve `{authError:true}` pelado. Además así marcan los tres caminos que producen el
 * error, no solo el barrido automático: el manual (`/escanear`) y el histórico del callback
 * de OAuth también pasan por acá, y los dos descartan el objeto sin avisarle a nadie.
 *
 * Condicional a `auth_error_at is null` a propósito: la marca es CUÁNDO se rompió, no cuándo
 * se reintentó por última vez. De paso escribe una sola vez y no en cada barrido.
 *
 * No propaga su error: el AUTH_EXPIRED que sigue es la señal que importa, y tragárselo por un
 * hipo de la base dejaría al usuario sin el aviso además de sin la marca.
 */
async function sellarAuthCaida(cuenta) {
  try {
    // El `error` se mira explícitamente: postgrest-js NO lanza, devuelve `{ error }`. Un
    // try/catch pelado solo atrapa fallas de red, así que un filtro mal formado dejaría el
    // sello sin escribir EN SILENCIO — y como esto solo corre cuando un token ya murió, nadie
    // se enteraría hasta que un usuario reclamara que la app le miente.
    const { error } = await getSupabase().from('gmail_cuentas')
      .update({ auth_error_at: new Date().toISOString() })
      .eq('usuario_id', cuenta.usuario_id)
      .eq('email', cuenta.email)
      .is('auth_error_at', null);
    if (error) throw new Error(error.message);
  } catch (e) {
    log.error({ tag: 'AUTH', email: cuenta.email, err: e.message }, 'No se pudo sellar la auth caída');
  }
}

async function configurarClienteParaCuenta(cuenta) {
  const cliente = crearClienteOAuth();
  const decryptedAccess = decrypt(cuenta.access_token);
  const decryptedRefresh = decrypt(cuenta.refresh_token);
  cliente.setCredentials({ access_token: decryptedAccess, refresh_token: decryptedRefresh, expiry_date: cuenta.token_expiry });
  const necesitaRefresh = cuenta.token_expiry && cuenta.token_expiry < Date.now() + 5 * 60 * 1000;
  if (necesitaRefresh && decryptedRefresh) {
    try {
      const { credentials } = await cliente.refreshAccessToken();
      // Actualizar token en gmail_cuentas (encrypted)
      await getSupabase().from('gmail_cuentas').update({
        access_token: encrypt(credentials.access_token),
        token_expiry: credentials.expiry_date,
        updated_at: new Date().toISOString()
      }).eq('usuario_id', cuenta.usuario_id).eq('email', cuenta.email);
      cliente.setCredentials(credentials);
    } catch(e) {
      log.error({ tag: 'TOKEN', err: e.message }, 'Error refrescando token');
      // Detectar revocación/expiración permanente del refresh token (ej: app en modo Testing)
      const esAuthPermanente = e.message && (
        e.message.includes('invalid_grant') ||
        e.message.includes('Token has been expired or revoked') ||
        e.message.includes('refresh_token') ||
        e.message.toLowerCase().includes('revoked')
      );
      if (esAuthPermanente) {
        log.warn({ tag: 'TOKEN', email: cuenta.email }, 'Refresh token revocado — cuenta necesita reconexión');
        await sellarAuthCaida(cuenta);
        const authErr = new Error('AUTH_EXPIRED');
        authErr.code = 'AUTH_EXPIRED';
        authErr.email = cuenta.email;
        authErr.usuarioId = cuenta.usuario_id;
        throw authErr;
      }
    }
  }
  return cliente;
}

async function configurarClienteAutenticado(usuarioId) {
  const cuentas = await obtenerCuentasGmail(usuarioId);
  if (cuentas.length > 0) return configurarClienteParaCuenta(cuentas[0]);
  // Fallback a tokens en usuarios tabla
  const tokens = await cargarTokens(usuarioId);
  if (!tokens) return null;
  const cliente = crearClienteOAuth();
  cliente.setCredentials(tokens);
  return cliente;
}

function decodificarBase64(str) {
  try {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  } catch(e) { return ''; }
}

function extraerTexto(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodificarBase64(payload.body.data);
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    return decodificarBase64(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (payload.parts && payload.parts.length > 0) {
    for (const parte of payload.parts) {
      if (parte.mimeType === 'text/plain') { const t = extraerTexto(parte); if (t) return t; }
    }
    for (const parte of payload.parts) { const t = extraerTexto(parte); if (t) return t; }
  }
  return '';
}

function esBancario(texto, asunto) {
  const contenido = (texto + ' ' + (asunto || '')).toLowerCase();
  // Verificar subjects conocidos primero (más rápido)
  const asuntoLower = (asunto || '').toLowerCase();
  if (SUBJECTS_BANCARIOS.some(s => asuntoLower.includes(s))) return true;
  // Verificar palabras clave en el cuerpo
  return PALABRAS_BANCARIAS.some(p => contenido.includes(p.toLowerCase()));
}

// Dirección pelada de un header From ("BCP Comunica <bcpcomunica@email.bcp.com.pe>" →
// "bcpcomunica@email.bcp.com.pe"). En minúsculas, porque la parte local es case-sensitive por
// RFC pero ningún banco peruano la usa así y comparar exacto sólo abriría falsos negativos.
function direccionDe(remitente) {
  const m = /<([^>]+)>/.exec(remitente || '');
  return (m ? m[1] : (remitente || '')).trim().toLowerCase();
}

const SET_REMITENTES_TRANSACCIONALES = new Set(REMITENTES_BANCARIOS.map(r => r.toLowerCase()));

/**
 * **Un aviso de cargo no se manda por lista de correo, y una promo sí.**
 *
 * El 04-sep-2026 Neto le registró a Favio un gasto de S/ 100 en "LATAM Pass BCP" que nunca
 * existió: era el mailing "¡Favio, gana hasta 1,000,000 de Millas!" de `bcpcomunica@email.bcp.com.pe`,
 * que dice "Por cada S/ 100 de consumo, con tu Tarjeta de Crédito LATAM Pass BCP". Ese correo NO
 * entra por la lista de remitentes —esa dirección no está— sino por la query de palabras clave,
 * y de ahí en adelante nada lo paraba: `esBancario` es un OR de palabras sueltas donde "BCP",
 * "tarjeta", "consumo" y "S/" alcanzan de sobra, y el parser no tenía forma de contestar "esto
 * no es un movimiento" (ver `es_movimiento` en services/parsers.js).
 *
 * El discriminador que sí separa las dos poblaciones es de TRANSPORTE, no de contenido: los
 * headers de envío masivo. `List-Unsubscribe` existe porque de una promoción uno se puede dar de
 * baja; del aviso de tu propio consumo, no — es transaccional y el banco está obligado a
 * mandarlo. Mismo argumento para `List-Id`, `Precedence: bulk` y el `Feedback-ID` que los ESP
 * ponen para la reputación de sus campañas.
 *
 * **Sólo se aplica a remitentes que NO están en REMITENTES_BANCARIOS**, y eso no es timidez: no
 * pude inspeccionar los headers reales de un aviso de `alertas@bcp.com.pe` desde acá, así que
 * aplicarlo a ciegas sobre el camino que HOY funciona arriesga el error caro —perder un gasto
 * real en silencio— para tapar uno que ya está tapado por la propia lista de remitentes. Sobre
 * las direcciones desconocidas el cálculo se invierte: ahí no hay ninguna garantía de que el
 * correo sea transaccional, y el costo de equivocarse es inventarle plata a alguien.
 *
 * Las promos que SÍ salen de un remitente transaccional las agarra la segunda capa (`es_movimiento`).
 */
function esCorreoMasivo(headers, remitente) {
  if (SET_REMITENTES_TRANSACCIONALES.has(direccionDe(remitente))) return false;
  const valor = (nombre) => {
    const h = headers.find(x => (x.name || '').toLowerCase() === nombre);
    return h ? (h.value || '') : '';
  };
  if (valor('list-unsubscribe')) return true;
  if (valor('list-id')) return true;
  if (valor('feedback-id')) return true;
  if (/\b(bulk|list|junk)\b/i.test(valor('precedence'))) return true;
  return false;
}

function esCorreoReenviado(headers) {
  // Detectar correos reenviados por múltiples métodos
  const subject = (headers.find(h => h.name === 'Subject') || {}).value || '';
  const inReplyTo = (headers.find(h => h.name === 'In-Reply-To') || {}).value || '';
  const references = (headers.find(h => h.name === 'References') || {}).value || '';
  const forwarded = (headers.find(h => h.name === 'X-Forwarded-To') || {}).value || '';
  const subjectLower = subject.toLowerCase();

  if (subjectLower.startsWith('fwd:') || subjectLower.startsWith('fw:') ||
      subjectLower.startsWith('rv:') || subjectLower.startsWith('reenvío:') ||
      subjectLower.includes('fwd:') || subjectLower.includes('[fwd]')) {
    return true;
  }
  if (inReplyTo || references || forwarded) return true;
  return false;
}

// Construye las dos queries de Gmail (remitentes + palabras clave) para una ventana
// de `windowDays` días. Pura y exportada para poder testear la ventana sin red.
function construirQueriesBancarias(remitentes, windowDays) {
  const ventana = 'newer_than:' + windowDays + 'd';
  const queryDirecto = 'from:(' + remitentes.join(' OR ') + ') ' + ventana + ' -in:sent';
  const queryPalabrasClave = [
    '"Servicio de Notificaciones BCP"',
    '"realizaste un consumo"',
    '"consumo con tu Tarjeta"',
    '"Tarjeta de Credito BCP"',
    '"Tarjeta de Debito BCP"',
    '"yapaste"',
    '"pago realizado" (BCP OR BBVA OR Interbank OR Scotiabank)',
    '"CONSTANCIA DE PAGO" BCP',
    '"transferencia realizada"',
    '"abono en tu cuenta"',
    '"cargo en tu cuenta"',
  ].join(' OR ') + ' ' + ventana + ' -in:sent';
  return { queryDirecto, queryPalabrasClave };
}

// opts controla la ventana y los caps del scan. Defaults = comportamiento recurrente
// (últimos ~2-3 días, caps bajos). El barrido histórico inicial pasa windowDays=30.
async function leerCorreosDesdeCuenta(authClient, cuentaEmail, remitentes = REMITENTES_BANCARIOS, opts = {}) {
  const { windowDays = 2, filterDays = 3, maxPerQuery = 20, maxProcess = 25 } = opts;

  const gmail = google.gmail({ version: 'v1', auth: authClient });

  const { queryDirecto, queryPalabrasClave } = construirQueriesBancarias(remitentes, windowDays);

  const mensajesIds = new Set();
  const todosLosIds = [];
  // **Los correos que Gmail no entregó se CUENTAN, no se olvidan.** Los dos `catch` de acá
  // abajo sólo logueaban, así que un 429 de cuota salía por el mismo `{ error: null,
  // mensajes: [] }` que "no había correos". Para el escaneo incremental da igual —vuelve a
  // correr en 15 minutos—, pero el barrido histórico reclama `historico_importado` ANTES de
  // leer y sólo se lo libera si se entera de que algo se saltó. Sin este contador, un 429
  // durante el callback de OAuth se registraba como "30d completado" y esa persona perdía su
  // import para siempre. Y el histórico es el más expuesto: pide `maxPerQuery: 100` contra
  // los 20 del incremental.
  let salteados = 0;
  let listadosOk = 0;

  for (const query of [queryDirecto, queryPalabrasClave]) {
    try {
      const { data } = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: maxPerQuery });
      listadosOk++;
      if (data.messages) {
        for (const m of data.messages) {
          if (!mensajesIds.has(m.id)) { mensajesIds.add(m.id); todosLosIds.push(m.id); }
        }
      }
    } catch(e) { salteados++; log.error({ tag: 'GMAIL', err: e.message }, 'Error en query Gmail'); }
  }

  // Sin un solo listado que haya funcionado no se puede afirmar que no había correos: es el
  // mismo `no pude preguntar` ≠ `no tiene` que separa `lectura_fallida` de `no_auth`.
  // `salteados` va TAMBIÉN acá, y omitirlo dejaba el arreglo sin efecto en multi-cuenta: el
  // agregador suma `salteados` y descarta el `error` de una cuenta si otra vino sana, así que
  // sin el contador la cuenta caída desaparecía sin dejar rastro.
  if (listadosOk === 0) return { error: 'listado_fallido', mensajes: [], cuentaEmail, salteados };
  if (todosLosIds.length === 0) return { error: null, mensajes: [], salteados, cuentaEmail };

  const mensajes = [];
  for (const id of todosLosIds.slice(0, maxProcess)) {
    try {
      const { data: detalle } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = detalle.payload.headers || [];
      const asunto = (headers.find(h => h.name === 'Subject') || {}).value || '';
      const remitente = (headers.find(h => h.name === 'From') || {}).value || '';
      const fecha = new Date(parseInt(detalle.internalDate)).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

      // FILTRO 1: Rechazar correos reenviados
      if (esCorreoReenviado(headers)) {
        log.debug({ tag: 'GMAIL', asunto: asunto.substring(0, 50) }, 'Correo reenviado ignorado');
        continue;
      }

      // FILTRO 1b: Rechazar envíos masivos de remitentes no transaccionales (promos, newsletters).
      // Va ANTES del filtro de ventana y del de palabras porque es el único que mira transporte
      // en vez de contenido: ninguna palabra del cuerpo distingue "gastaste S/ 100" de "gana
      // millas por cada S/ 100 de consumo", y los headers sí.
      if (esCorreoMasivo(headers, remitente)) {
        log.info({ tag: 'GMAIL', remitente, asunto: asunto.substring(0, 60) }, 'Correo masivo/promocional ignorado');
        continue;
      }

      // FILTRO 2: Solo correos dentro de la ventana (evitar correos viejos)
      const fechaCorreo = new Date(parseInt(detalle.internalDate));
      const haceLimite = new Date(Date.now() - filterDays * 24 * 60 * 60 * 1000);
      if (fechaCorreo < haceLimite) {
        log.debug({ tag: 'GMAIL', fecha, asunto: asunto.substring(0, 30) }, 'Correo antiguo ignorado');
        continue;
      }

      const cuerpo = extraerTexto(detalle.payload);

      // FILTRO 3: Verificar que es bancario
      if (!esBancario(asunto + '\n' + cuerpo, asunto)) {
        log.debug({ tag: 'GMAIL', asunto: asunto.substring(0, 50) }, 'Correo no bancario ignorado');
        continue;
      }

      const textoParseo = cuerpo.length > 100 ? cuerpo.substring(0, 2000) : detalle.snippet;
      // recibidoEnMs: hora exacta de llegada del correo. `fecha` la trunca a día y se pierde
      // la señal que distingue "dos avisos del MISMO cargo" (llegan con segundos de diferencia)
      // de "dos compras iguales reales" (llegan con minutos u horas de diferencia).
      mensajes.push({ id, snippet: detalle.snippet, texto: textoParseo, asunto, remitente, fecha, recibidoEnMs: parseInt(detalle.internalDate) });
      log.info({ tag: 'GMAIL', asunto: asunto.substring(0, 60) }, 'Correo bancario encontrado');
    } catch(e) { salteados++; log.error({ tag: 'GMAIL', err: e.message }, 'Error obteniendo correo'); }
  }

  // **El truncado por `maxProcess` NO se cuenta como salteado, y contarlo fue un defecto que
  // duró una hora.** Un usuario con 60 correos bancarios en 30 días —normal— deja 10 ids fuera
  // del cap del histórico (`maxProcess: 50`), así que `salteados` nunca daba 0 y el barrido
  // liberaba su claim SIEMPRE: `historico_importado` no se marcaba nunca y los 30 días se
  // re-corrían en cada reconexión. Medido: 60 ids listados → `salteados: 10`.
  //
  // Y liberar no compraba nada: re-correr trunca en el mismo orden, así que esos 10 no vuelven
  // igual. `salteados` significa "Gmail no me lo dio", que sí se recupera reintentando; el cap
  // es una decisión de diseño nuestra y su arreglo —si hace falta— es paginar, no reintentar.
  // Queda registrado en `docs/DEFECTOS.md` como truncado silencioso, que es lo que es.
  return { error: null, mensajes, cuentaEmail, salteados };
}

async function remitentesParaUsuario(usuarioId) {
  try {
    const { data } = await getSupabase()
      .from('usuarios').select('bancos_seleccionados').eq('id', usuarioId).single();
    return remitentesParaSeleccion(data && data.bancos_seleccionados);
  } catch (e) {
    log.warn({ tag: 'GMAIL', err: e.message }, 'No se pudo leer bancos_seleccionados; uso set completo');
    return REMITENTES_BANCARIOS;
  }
}

/**
 * Colapsa el resultado de N cuentas en el `{ error, mensajes, salteados }` que ve el scanner.
 *
 * **Vive suelta y exportada porque es la que decide si un barrido cuenta como completo, y no
 * tenía quien la mirara.** Estaba embebida en `leerCorreosBancarios`, que ningún test ejecuta
 * (el guard del scanner la mockea entera y el de `leerCorreosDesdeCuenta` corre por debajo):
 * una revisión adversarial dejó las dos líneas que agregan inertes y la suite completa —169
 * archivos, 3011 tests— siguió en verde.
 *
 * Dos reglas, y las dos nacieron de un defecto medido:
 *
 * · **`salteados` se SUMA, y una cuenta que falló entera cuenta como al menos uno.** No sabemos
 *   cuántos correos quedaron adentro de una cuenta que ni se pudo listar, pero para el barrido
 *   histórico lo que decide es si quedó algo afuera, no cuánto. Sin esto, una cuenta con 429 y
 *   otra sana devolvían `salteados: 0` y el claim se conservaba: el defecto original intacto,
 *   en forma multi-cuenta.
 * · **`AUTH_EXPIRED` gana** porque tiene su propio aviso al usuario (`notificarAuthExpirada`), y
 *   no suma salteados porque su rama ya libera el claim del histórico por su cuenta.
 */
function agregarResultadosDeCuentas(resultados) {
  const authExpired = resultados.some(r => r.error === 'AUTH_EXPIRED');

  // Unificar mensajes de todas las cuentas (deduplicar por id)
  const vistos = new Set();
  const mensajesUnificados = [];
  for (const r of resultados) {
    for (const m of (r.mensajes || [])) {
      const key = m.id + (r.cuentaEmail || '');
      if (!vistos.has(key)) { vistos.add(key); mensajesUnificados.push({ ...m, cuentaEmail: r.cuentaEmail }); }
    }
  }

  const salteados = resultados.reduce((n, r) => {
    if (r.salteados) return n + r.salteados;
    return n + (r.error && r.error !== 'AUTH_EXPIRED' ? 1 : 0);
  }, 0);
  // Si NINGUNA cuenta pudo leerse y no hay un solo mensaje, el vacío no es un hecho sobre el
  // usuario sino sobre la corrida. Con una cuenta sana el error deja de ser global, pero su
  // hermana caída ya quedó contada en `salteados`.
  const todasFallaron = resultados.length > 0 && resultados.every(r => r.error) && mensajesUnificados.length === 0;
  return {
    error: authExpired ? 'AUTH_EXPIRED' : (todasFallaron ? 'listado_fallido' : null),
    mensajes: mensajesUnificados,
    salteados,
  };
}

async function leerCorreosBancarios(usuarioId, opts = {}) {
  // **`no_auth` significa "no tiene cuenta", así que solo se puede afirmar si la lectura
  // FUNCIONÓ.** `obtenerCuentasGmail` descartaba su `{ error }` y devolvía `[]`, con lo cual un
  // timeout de Supabase caía al fallback legacy y terminaba en `no_auth` — y desde que ese
  // valor se traduce a "conéctalo en la app", a alguien con Gmail conectado se le pedía
  // conectarlo por un hipo de red. Hoy esa función lanza; acá se traduce a un error PROPIO
  // para que el llamador no confunda "no pude preguntar" con "no tiene".
  let cuentas;
  try {
    cuentas = await obtenerCuentasGmail(usuarioId);
  } catch (e) {
    log.error({ tag: 'GMAIL', usuarioId, err: e.message }, 'No se pudo resolver si tiene cuentas: no se afirma nada');
    return { error: 'lectura_fallida', mensajes: [] };
  }
  const remitentes = await remitentesParaUsuario(usuarioId);

  if (cuentas.length === 0) {
    // Fallback: intentar con token legacy en usuarios
    const authClient = await configurarClienteAutenticado(usuarioId);
    if (!authClient) return { error: 'no_auth', mensajes: [] };
    return leerCorreosDesdeCuenta(authClient, null, remitentes, opts);
  }

  // Escanear todas las cuentas activas en paralelo
  const resultados = await Promise.all(
    cuentas.map(async (cuenta) => {
      try {
        const cliente = await configurarClienteParaCuenta(cuenta);
        return leerCorreosDesdeCuenta(cliente, cuenta.email, remitentes, opts);
      } catch(e) {
        if (e.code === 'AUTH_EXPIRED') {
          // Propagar como valor especial para que el scanner pueda notificar al usuario
          return { error: 'AUTH_EXPIRED', mensajes: [], cuentaEmail: cuenta.email, usuarioId: cuenta.usuario_id };
        }
        log.error({ tag: 'GMAIL', email: cuenta.email, err: e.message }, 'Error en cuenta Gmail');
        return { error: e.message, mensajes: [], cuentaEmail: cuenta.email };
      }
    })
  );

  return agregarResultadosDeCuentas(resultados);
}

// `leerCorreosDesdeCuenta` y `agregarResultadosDeCuentas` se exportan SOLO para sus guards: la
// primera recibe un `authClient` crudo y la segunda un array ya resuelto, así que llamarlas
// desde producción saltearía la resolución de cuentas, `remitentesParaUsuario` y los gates de
// plan que viven en `leerCorreosBancarios`. El camino de producción es ése, siempre.
module.exports = { tieneGmailConectado, leerCorreosDesdeCuenta, agregarResultadosDeCuentas, generarUrlAutorizacion, verificarState, guardarTokens, cargarTokens, leerCorreosBancarios, oauth2Client, obtenerPerfilGoogle, obtenerCuentasGmail, revocarAccesoGmail, BANCOS_CATALOGO, remitentesParaSeleccion, describirSeleccion, construirQueriesBancarias, emailGmailVinculado, hashEmailGmail, esElMismoGmail, esCorreoMasivo, direccionDe };
