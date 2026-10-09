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
    // Y la de "sin buzón" (migración 090), por simetría: no sabemos si la cuenta reconectada
    // tiene Gmail hasta que se liste. Si sigue sin tenerlo, el barrido histórico del callback
    // la vuelve a sellar en el mismo minuto.
    sin_buzon_at: null,
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
    // Una cuenta sellada sin buzón (migración 090) no cuenta: con ella el prompt del bot le
    // afirmaba "lees automáticamente sus correos" a quien la app ya le dice que no tiene Gmail.
    return (await obtenerCuentasGmail(usuario.id)).some(c => !c.sin_buzon_at);
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
 * un timeout con Google no puede dejar a un usuario a medio bajar. La LECTURA se corta siempre
 * (`activa=false`, access token en null). Lo que depende de Google es el refresh token: si
 * Google no confirma, se CONSERVA y la fila queda pendiente, que es lo que
 * `reintentarRevocacionesPendientes` (desde `checkGmailHuerfanos`) vuelve a intentar a diario.
 * `invalid_token` no es un fallo: significa que el grant ya no existía, que es el destino.
 *
 * Hasta el 30-sep-2026 el comentario prometía ese reintento y el código no lo sostenía: anulaba
 * el refresh token pasara lo que pasara con Google, y el barrido solo mira `activa=true`. Un 503
 * dejaba el grant vivo para siempre y sin forma de alcanzarlo. Ver DEFECTOS.md.
 *
 * Los estados que salen de acá (ninguno necesita columna nueva):
 * | `gmail_cuentas`                          | legacy en `usuarios`                              | significa |
 * |---|---|---|
 * | `activa=false`, `refresh_token` null     | los tres `gmail_*` en null                       | suelto en Google |
 * | `activa=false`, `refresh_token` puesto   | `gmail_refresh_token` puesto, access en null     | pendiente de revocar |
 *
 * `revocadas` cuenta conexiones que dejaron de LEER (es lo que el aviso al usuario afirma);
 * `pendientes`, las que Google todavía no confirmó. Una puede estar en las dos.
 *
 * @returns {Promise<{revocadas: number, emails: string[], pendientes: number}>}
 */
async function revocarAccesoGmail(usuarioId, { motivo = 'sin_motivo', cuentaId = null } = {}) {
  const todas = await obtenerCuentasGmail(usuarioId);
  // `cuentaId` sirve al usuario multi-cuenta que desconecta UNA sola: revocar las otras le
  // apagaría en silencio una lectura que sigue pagando y no pidió cortar.
  const cuentas = cuentaId ? todas.filter((c) => c.id === cuentaId) : todas;
  if (cuentaId && cuentas.length === 0) return { revocadas: 0, emails: [], pendientes: 0 };

  // Los campos legacy de `usuarios` describen "la" cuenta del usuario, así que solo se tocan
  // cuando no le queda ninguna activa: borrarlos al desconectar una de tres dejaría al usuario
  // viéndose desconectado con dos cuentas leyendo.
  //
  // Se LEEN antes de tocar nada, y un error de lectura corta acá: igual que
  // `obtenerCuentasGmail` arriba, falla sin haber escrito. Antes no se leían —se anulaban a
  // ciegas— y por eso el usuario con token legacy y SIN fila en `gmail_cuentas` (lo deja un
  // canje donde `obtenerPerfilGoogle` no devolvió el correo) salía por el `return` temprano con
  // el grant vivo: nadie lo revocaba, ni esta función ni el barrido.
  const cierraTodo = !cuentaId || todas.length === cuentas.length;
  let legacy = null;
  if (cierraTodo) {
    const { data, error } = await getSupabase().from('usuarios')
      .select('gmail_access_token, gmail_refresh_token').eq('id', usuarioId).maybeSingle();
    if (error) throw new Error('revocarAccesoGmail: no se pudo leer el token legacy: ' + error.message);
    if (data && (data.gmail_access_token || data.gmail_refresh_token)) legacy = data;
  }

  // Una revocación TOTAL también termina las que quedaron pendientes de antes. Sin esto, el
  // borrado de cuenta —que solo miraba filas activas y después anula todo refresh token con el
  // RPC— se llevaba el único token con que se podía revocar un pendiente, sin avisar a nadie:
  // el defecto original por otra puerta (revisión adversarial, 30-sep-2026).
  //
  // Solo sin `cuentaId`. Con `cuentaId` llama `guardarTokens` en pleno canje, y una fila
  // pendiente del MISMO correo que se está reconectando comparte grant con el recién emitido:
  // revocarla lo tumbaría.
  let previas = [];
  if (!cuentaId) {
    const { data, error } = await getSupabase().from('gmail_cuentas')
      .select('id, email, refresh_token').eq('usuario_id', usuarioId).eq('activa', false).not('refresh_token', 'is', null);
    if (error) throw new Error('revocarAccesoGmail: no se pudo leer las revocaciones pendientes: ' + error.message);
    previas = data || [];
  }
  if (cuentas.length === 0 && !legacy && previas.length === 0) return { revocadas: 0, emails: [], pendientes: 0 };

  const emails = [];
  // token en claro → qué dijo Google de su grant. El legacy lo consulta para saber si es copia
  // de una fila ya procesada y, si lo es, si ese grant quedó suelto o pendiente.
  const tokensVistos = new Map();
  // Solo lo que sigue pudiendo LEER. Ver el throw del final.
  const sigueLeyendo = [];
  let pendientes = 0;
  const ahora = new Date().toISOString();
  for (const cuenta of cuentas) {
    // El refresh token es el que sostiene el grant; el access token solo sirve de plan B
    // para una fila vieja que nunca lo recibió.
    const r = await soltarGrantEnGoogle([cuenta.refresh_token, cuenta.access_token],
      { tag: 'GMAIL_REVOKE', usuarioId, email: cuenta.email, motivo });
    if (r.plano) tokensVistos.set(r.plano, r.estado);
    const quedaPendiente = r.estado === 'pendiente' && !!cuenta.refresh_token;
    if (r.estado === 'pendiente' && !quedaPendiente) {
      log.error({ tag: 'GMAIL_REVOKE', usuarioId, email: cuenta.email, motivo },
        'Google no confirmó y la fila no tiene refresh token: no queda con qué reintentar');
    }
    if (quedaPendiente) pendientes++;

    // Se conserva la fila (no `delete`): mantiene el email para historial y deja que el
    // upsert de guardarTokens reconecte limpio por onConflict 'usuario_id,email'. Por id y
    // condicionada a `activa`, para no pisar una fila que otra ruta ya cerró.
    const cierre = { activa: false, access_token: null, token_expiry: null, updated_at: ahora };
    if (!quedaPendiente) cierre.refresh_token = null;
    const { error } = await getSupabase().from('gmail_cuentas').update(cierre).eq('id', cuenta.id).eq('activa', true);
    if (error) {
      log.error({ tag: 'GMAIL_REVOKE', usuarioId, email: cuenta.email, motivo, err: error.message }, 'No se pudo cerrar la fila local de Gmail');
      sigueLeyendo.push(error.message);
    } else {
      emails.push(cuenta.email);
    }
  }

  for (const fila of previas) {
    const r = await reintentarFilaPendiente(fila, { tag: 'GMAIL_REVOKE', usuarioId, email: fila.email, motivo });
    // 'error' = Google lo soltó y lo que falló fue limpiar la fila: queda un token muerto que el
    // reintento de mañana limpia con `invalid_token`. No lee nada, así que no cuenta para lanzar.
    if (r.plano) tokensVistos.set(r.plano, r.estado === 'pendiente' ? 'pendiente' : 'suelto');
    if (r.estado === 'pendiente') pendientes++;
  }

  let revocadas = emails.length;
  if (legacy) {
    const r = await soltarTokenLegacy(usuarioId, legacy, tokensVistos, motivo);
    if (r.cortada) revocadas++;
    if (r.pendiente) pendientes++;
    if (r.sigueLeyendo) sigueLeyendo.push(r.error);
  }

  // Lanza DESPUÉS de haber intentado todo, y SOLO si algo sigue pudiendo leer: una fila activa
  // que no se cerró, o un token legacy con access puesto sobre un grant que Google no soltó. Ahí
  // ni el "✅ desconectado" ni el aviso de vencimiento pueden afirmar lo contrario, y en
  // `guardarTokens` seguir de largo dejaría dos cuentas activas.
  //
  // Una limpieza fallida de algo que ya NO lee (un token cuyo grant Google soltó) no lanza, y
  // no es cosmético: lanzar después de haber cerrado la fila activa dejaba al usuario sin
  // respuesta y con el menú de desconexión abierto, y como el menú se re-arma con las cuentas
  // que QUEDAN, el "1" reenviado caía en la rama "sin cuentas", donde "1" es borrar la cuenta
  // entera (segunda revisión adversarial, 30-sep-2026, reproducido).
  //
  // `parcial` viaja con el error: los avisos de vencimiento lo usan para no callar un Gmail que
  // sí se desconectó, y el borrado para no perder el pendiente.
  if (sigueLeyendo.length) {
    const err = new Error('revocarAccesoGmail: algo sigue leyendo, no se pudo cerrar el estado local: ' + sigueLeyendo.join('; '));
    err.parcial = { revocadas, emails, pendientes };
    throw err;
  }

  log.info({ tag: 'GMAIL_REVOKE', usuarioId, emails, motivo, revocadas, pendientes },
    pendientes ? 'Acceso a Gmail cortado; revocación en Google pendiente' : 'Acceso a Gmail revocado en Google');
  return { revocadas, emails, pendientes };
}

/**
 * Una fila `activa=false` con refresh token: le pide a Google que suelte el grant y, si lo
 * suelta, anula el token. El cierre es condicional al MISMO token que se leyó: si en el medio
 * la persona reconectó ese correo, `guardarTokens` dejó la fila activa con un token nuevo y
 * esto no lo pisa.
 *
 * @returns {Promise<{estado: 'soltada'|'pendiente'|'error', plano: string|null, error?: string}>}
 */
async function reintentarFilaPendiente(fila, ctx) {
  const r = await soltarGrantEnGoogle([fila.refresh_token], ctx);
  if (r.estado === 'pendiente') return { estado: 'pendiente', plano: r.plano };
  const { error } = await getSupabase().from('gmail_cuentas')
    .update({ refresh_token: null, updated_at: new Date().toISOString() })
    .eq('id', fila.id).eq('activa', false).eq('refresh_token', fila.refresh_token);
  if (error) {
    log.error({ ...ctx, err: error.message }, 'Revocado en Google pero no se pudo limpiar la fila');
    return { estado: 'error', plano: r.plano, error: error.message };
  }
  return { estado: 'soltada', plano: r.plano };
}

/**
 * Le pide a Google que suelte el grant de UNA credencial. No escribe nada: dice qué pasó y el
 * que llama decide qué conservar.
 *
 * `pendiente` incluye el token que no se pudo DESCIFRAR. Lo que hace fallar `decrypt` en la
 * práctica es una `ENCRYPTION_KEY` mal cargada, que se corrige; anular el token ahí sería
 * convertir un error de configuración en un grant vivo para siempre.
 *
 * @param {Array<string|null>} cifrados en orden de preferencia (refresh antes que access)
 * @returns {Promise<{estado: 'suelto'|'pendiente'|'sin_token', plano: string|null}>}
 */
async function soltarGrantEnGoogle(cifrados, ctx) {
  let plano = null;
  try {
    for (const c of cifrados) {
      plano = decrypt(c);
      if (plano) break;
    }
  } catch (e) {
    log.error({ ...ctx, err: e.message }, 'No se pudo descifrar el token de Gmail: queda pendiente de revocar');
    return { estado: 'pendiente', plano: null };
  }
  if (!plano) return { estado: 'sin_token', plano: null };
  try {
    await oauth2Client.revokeToken(plano);
    return { estado: 'suelto', plano };
  } catch (e) {
    if (/invalid_token|invalid_grant/i.test(e.message || '')) {
      log.info({ ...ctx, err: e.message }, 'El grant ya no existía en Google');
      return { estado: 'suelto', plano };
    }
    log.error({ ...ctx, err: e.message }, 'Google no confirmó la revocación: queda pendiente para reintentar');
    return { estado: 'pendiente', plano };
  }
}

/**
 * El token legacy de `usuarios`. En el caso normal es una COPIA del de la fila de
 * `gmail_cuentas` (guardarTokens escribe los dos), y ahí no se revoca de nuevo ni se deja
 * pendiente: el estado vive en un solo lugar, la fila. Solo se revoca por su cuenta cuando es
 * otro grant (o cuando es el único que hay).
 */
async function soltarTokenLegacy(usuarioId, legacy, tokensVistos, motivo) {
  const ctx = { tag: 'GMAIL_REVOKE', usuarioId, legacy: true, motivo };
  let plano = null;
  try {
    plano = decrypt(legacy.gmail_refresh_token) || decrypt(legacy.gmail_access_token);
  } catch { /* no se pudo comparar: se trata como grant propio, y soltarGrantEnGoogle lo registra */ }
  const esCopia = !!plano && tokensVistos.has(plano);

  // Una copia no se revoca de nuevo, pero hereda lo que Google dijo de su grant: si quedó
  // pendiente, el access token de la copia sigue sirviendo para leer.
  const estadoGrant = esCopia
    ? tokensVistos.get(plano)
    : (await soltarGrantEnGoogle([legacy.gmail_refresh_token, legacy.gmail_access_token], ctx)).estado;
  // Pendiente propio solo si no es copia: el de una copia vive en su fila.
  const pendiente = !esCopia && estadoGrant === 'pendiente' && !!legacy.gmail_refresh_token;
  // El access token se va siempre: es lo que `tieneGmailConectado`, `cargarTokens` y el
  // barrido del scanner miran para decidir que alguien LEE. Sin él, un refresh token suelto
  // en la fila no lee nada: solo espera su revocación.
  const cierre = { gmail_access_token: null, gmail_token_expiry: null };
  if (!pendiente) cierre.gmail_refresh_token = null;
  const { error } = await getSupabase().from('usuarios').update(cierre).eq('id', usuarioId);
  if (error) {
    log.error({ ...ctx, err: error.message }, 'No se pudo limpiar el token legacy de Gmail');
    // Sigue leyendo solo si quedó un access token sobre un grant que Google NO soltó. Sobre un
    // grant suelto es un token muerto: el scanner recibe `invalid_grant` y no lee nada.
    return {
      cortada: false,
      pendiente: !esCopia && estadoGrant === 'pendiente',
      sigueLeyendo: !!legacy.gmail_access_token && estadoGrant !== 'suelto' && estadoGrant !== 'sin_token',
      error: error.message,
    };
  }
  return { cortada: !esCopia && !!legacy.gmail_access_token, pendiente };
}

/**
 * La segunda vuelta de las revocaciones que Google no confirmó. La llama `checkGmailHuerfanos`
 * a diario y no mira el plan: una fila pendiente es una desconexión DELIBERADA (baja de plan,
 * reemplazo, el usuario que pidió desconectar), así que se suelta igual pague o no.
 *
 * El cierre es condicional al MISMO token que se leyó: si entre la lectura y la escritura la
 * persona reconectó ese correo, `guardarTokens` dejó la fila activa con un token nuevo y esto
 * no lo pisa. Lo que no puede evitar es el lado de Google: revocar el token viejo en ese
 * intervalo tumba también el grant recién emitido. La ventana no es de milisegundos: las filas se
 * leen juntas y se revocan de a una, así que dura lo que tarde Google, y tarda más justo cuando hay
 * pendientes. La consecuencia es acotada: la fila reconectada queda activa sobre un grant muerto y
 * cae en el flujo normal de `auth_error_at`, que le pide reconectar.
 *
 * @returns {Promise<{soltadas: number, siguenPendientes: number, errores: number}>}
 */
async function reintentarRevocacionesPendientes() {
  const sb = getSupabase();
  let soltadas = 0, siguenPendientes = 0, errores = 0;

  const { data: filas, error: errFilas } = await sb.from('gmail_cuentas')
    .select('id, usuario_id, email, refresh_token').eq('activa', false).not('refresh_token', 'is', null);
  if (errFilas) {
    errores++;
    log.error({ tag: 'GMAIL_REVOKE', err: errFilas.message }, 'No se pudieron leer las revocaciones pendientes de gmail_cuentas');
  }
  for (const f of filas || []) {
    const r = await reintentarFilaPendiente(f, { tag: 'GMAIL_REVOKE', usuarioId: f.usuario_id, email: f.email, motivo: 'reintento' });
    if (r.estado === 'pendiente') siguenPendientes++;
    else if (r.estado === 'error') errores++;
    else soltadas++;
  }

  const { data: usuarios, error: errUsuarios } = await sb.from('usuarios')
    .select('id, gmail_refresh_token').not('gmail_refresh_token', 'is', null).is('gmail_access_token', null);
  if (errUsuarios) {
    errores++;
    log.error({ tag: 'GMAIL_REVOKE', err: errUsuarios.message }, 'No se pudieron leer las revocaciones legacy pendientes');
  }
  for (const u of usuarios || []) {
    const r = await soltarGrantEnGoogle([u.gmail_refresh_token], { tag: 'GMAIL_REVOKE', usuarioId: u.id, legacy: true, motivo: 'reintento' });
    if (r.estado === 'pendiente') { siguenPendientes++; continue; }
    const { error } = await sb.from('usuarios').update({ gmail_refresh_token: null })
      .eq('id', u.id).is('gmail_access_token', null).eq('gmail_refresh_token', u.gmail_refresh_token);
    if (error) { errores++; log.error({ tag: 'GMAIL_REVOKE', usuarioId: u.id, err: error.message }, 'Revocado en Google pero no se pudo limpiar el token legacy'); }
    else soltadas++;
  }

  return { soltadas, siguenPendientes, errores };
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

/**
 * ¿Gmail respondió que esta cuenta de Google NO TIENE buzón?
 *
 * Una cuenta de Google se puede crear con un correo ajeno (Hotmail, Outlook, un dominio sin
 * Workspace). El OAuth pasa igual —y gasta un cupo de los 100—, el refresh token anda, pero
 * `users.messages.list` responde 400 FAILED_PRECONDITION "Mail service not enabled". No es
 * transitorio: esa dirección no puede ganar un buzón de Gmail, así que reintentar cada 15
 * minutos solo producía dos líneas de log por barrido (medido en Railway el 07-oct-2026).
 *
 * Se reconoce por el TEXTO y no solo por `failedPrecondition`: esa razón la comparten otras
 * precondiciones de Gmail que sí son de configuración nuestra, y confundirlas sellaría como
 * "sin buzón" a alguien que sí lo tiene. Se mira en los tres lugares donde gaxios lo deja
 * (mensaje, `errors[]` y el cuerpo crudo) para no depender de cuál propague cada versión.
 */
function esErrorSinBuzon(e) {
  if (!e) return false;
  const textos = [e.message];
  for (const x of (Array.isArray(e.errors) ? e.errors : [])) textos.push(x && x.message);
  const cuerpo = e.response && e.response.data && e.response.data.error;
  if (cuerpo) textos.push(typeof cuerpo === 'string' ? cuerpo : cuerpo.message);
  return textos.some(t => typeof t === 'string' && /mail service not enabled/i.test(t));
}

/**
 * Persiste que la cuenta de Google conectada no tiene Gmail (migración 090).
 *
 * Mismo molde que `sellarAuthCaida`: condicional a NULL (la marca es CUÁNDO se detectó), lee el
 * `{ error }` porque postgrest-js no lanza, y no propaga — el `SIN_BUZON` que sigue es la señal
 * que le importa al llamador. Va por `id` porque `leerCorreosBancarios` tiene la fila entera.
 *
 * Desbloqueo manual, si soporte confirma que la cuenta ya tiene Gmail y no quiere esperar la
 * re-prueba diaria: `update gmail_cuentas set sin_buzon_at = null where id = '<id>'`.
 */
async function sellarSinBuzon(cuenta) {
  try {
    const { error } = await getSupabase().from('gmail_cuentas')
      .update({ sin_buzon_at: new Date().toISOString() })
      .eq('id', cuenta.id)
      .is('sin_buzon_at', null);
    if (error) throw new Error(error.message);
    log.warn({ tag: 'GMAIL', usuarioId: cuenta.usuario_id, cuentaId: cuenta.id }, 'Cuenta de Google sin buzón de Gmail: sellada y fuera del barrido');
  } catch (e) {
    log.error({ tag: 'GMAIL', usuarioId: cuenta.usuario_id, cuentaId: cuenta.id, err: e.message }, 'No se pudo sellar la cuenta sin buzón');
  }
}

/**
 * La marca se quita sola cuando la re-prueba diaria lista bien. Hace falta porque el texto de
 * Gmail no distingue "esta dirección no puede tener Gmail" (Hotmail) de "el admin de Workspace
 * apagó Gmail" (que se puede volver a prender), y sellar sin salida dejaría a la segunda fuera
 * del barrido para siempre, sin botón en la app.
 */
async function limpiarSinBuzon(cuenta) {
  try {
    const { error } = await getSupabase().from('gmail_cuentas')
      .update({ sin_buzon_at: null })
      .eq('id', cuenta.id)
      .not('sin_buzon_at', 'is', null);
    if (error) throw new Error(error.message);
    log.info({ tag: 'GMAIL', usuarioId: cuenta.usuario_id, cuentaId: cuenta.id }, 'La cuenta sellada sin buzón volvió a listar: se quita la marca');
  } catch (e) {
    log.error({ tag: 'GMAIL', usuarioId: cuenta.usuario_id, cuentaId: cuenta.id, err: e.message }, 'No se pudo quitar la marca de sin buzón');
  }
}

const DIA_MS = 24 * 60 * 60 * 1000;
// El ancho de la ventana es el período del barrido automático, leído de la MISMA variable que
// `cron/schedule.js` (`SCAN_INTERVAL_HOURS`, 0.25 h por default; no se importa de ahí para no
// colgar `gmail.js` del módulo de crons). Con una ventana fija de 15 min y un barrido cada hora,
// la fase de los ticks se repite cada día y una cuenta sellada podía no re-probarse NUNCA.
function ventanaReprueba() {
  const horas = parseFloat(process.env.SCAN_INTERVAL_HOURS || '0.25');
  return (Number.isFinite(horas) && horas > 0 ? horas : 0.25) * 60 * 60 * 1000;
}

/**
 * ¿Toca volver a preguntarle a Gmail por una cuenta sellada sin buzón? Una vez por día, contado
 * desde la marca. Una marca ilegible se re-prueba: preferible un listado de más a una cuenta que
 * no se vuelve a mirar nunca.
 */
function tocaReprobarSinBuzon(sinBuzonAt, ahora = Date.now()) {
  const desde = Date.parse(sinBuzonAt);
  if (!Number.isFinite(desde)) return true;
  const transcurrido = ahora - desde;
  return transcurrido >= DIA_MS && (transcurrido % DIA_MS) < ventanaReprueba();
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
 * que dice "Por cada S/ 100 de consumo, con tu Tarjeta de Crédito LATAM Pass BCP". Esa dirección
 * NO está en REMITENTES_BANCARIOS (verificado), así que lo más probable es que haya entrado por la
 * query de palabras clave —no se midió cuál de las dos lo listó, y da igual: el filtro corre sobre
 * las dos—. De ahí en adelante nada lo paraba: `esBancario` es un OR de palabras sueltas donde
 * "BCP", "tarjeta", "consumo" y "S/" alcanzan de sobra, y el parser no tenía forma de contestar
 * "esto no es un movimiento" (ver `es_movimiento` en services/parsers.js).
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
  // `usuarioId`/`cuentaId` son solo para el log: hasta el 08-oct los errores de Gmail salían sin
  // dueño y una cuenta rota se atribuía por descarte.
  const { windowDays = 2, filterDays = 3, maxPerQuery = 20, maxProcess = 25, usuarioId = null, cuentaId = null } = opts;

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
    } catch(e) {
      // Sin buzón es su propio desenlace, no un `listado_fallido`: el scanner le contesta otra
      // cosa a la persona y la cuenta se sella. No suma a `salteados` porque no hay correos que
      // un reintento recupere (el claim del histórico se libera igual, por `noCorrio`). Corta
      // antes de la segunda query, que daría el mismo 400.
      if (esErrorSinBuzon(e)) {
        log.warn({ tag: 'GMAIL', usuarioId, cuentaId, err: e.message }, 'La cuenta de Google no tiene buzón de Gmail');
        return { error: 'SIN_BUZON', mensajes: [], cuentaEmail, salteados: 0 };
      }
      salteados++;
      log.error({ tag: 'GMAIL', usuarioId, cuentaId, err: e.message }, 'Error en query Gmail');
    }
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
    } catch(e) { salteados++; log.error({ tag: 'GMAIL', usuarioId, cuentaId, err: e.message }, 'Error obteniendo correo'); }
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
  // `SIN_BUZON` (la cuenta de Google no tiene Gmail) es un hecho permanente, no un listado
  // perdido: no suma salteados, y solo es el desenlace global cuando es el de TODAS. Junto a una
  // cuenta sana no hay nada que decirle al usuario sobre el barrido.
  const todasSinBuzon = resultados.length > 0 && resultados.every(r => r.error === 'SIN_BUZON');

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
    return n + (r.error && r.error !== 'AUTH_EXPIRED' && r.error !== 'SIN_BUZON' ? 1 : 0);
  }, 0);
  // Si NINGUNA cuenta pudo leerse y no hay un solo mensaje, el vacío no es un hecho sobre el
  // usuario sino sobre la corrida. Con una cuenta sana el error deja de ser global, pero su
  // hermana caída ya quedó contada en `salteados`.
  const todasFallaron = resultados.length > 0 && resultados.every(r => r.error) && mensajesUnificados.length === 0;
  return {
    error: authExpired ? 'AUTH_EXPIRED' : todasSinBuzon ? 'SIN_BUZON' : (todasFallaron ? 'listado_fallido' : null),
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
    return leerCorreosDesdeCuenta(authClient, null, remitentes, { ...opts, usuarioId });
  }

  // Las cuentas ya selladas sin buzón no se tocan, salvo la re-prueba diaria: ni refresh de token
  // ni listado. Antes cada barrido de 15 minutos le pedía a Gmail dos listados que siempre
  // respondían 400, y sin la re-prueba un falso positivo quedaba fuera del barrido para siempre.
  const conBuzon = cuentas.filter(c => !c.sin_buzon_at || tocaReprobarSinBuzon(c.sin_buzon_at));
  if (conBuzon.length === 0) return { error: 'SIN_BUZON', mensajes: [], salteados: 0 };

  // Escanear todas las cuentas activas en paralelo
  const resultados = await Promise.all(
    conBuzon.map(async (cuenta) => {
      try {
        const cliente = await configurarClienteParaCuenta(cuenta);
        const r = await leerCorreosDesdeCuenta(cliente, cuenta.email, remitentes, { ...opts, usuarioId: cuenta.usuario_id, cuentaId: cuenta.id });
        if (r.error === 'SIN_BUZON') await sellarSinBuzon(cuenta);
        // Solo un listado SANO quita la marca: un 429 en la re-prueba no dice que haya buzón.
        else if (cuenta.sin_buzon_at && r.error == null) await limpiarSinBuzon(cuenta);
        return r;
      } catch(e) {
        if (e.code === 'AUTH_EXPIRED') {
          // Propagar como valor especial para que el scanner pueda notificar al usuario
          return { error: 'AUTH_EXPIRED', mensajes: [], cuentaEmail: cuenta.email, usuarioId: cuenta.usuario_id };
        }
        log.error({ tag: 'GMAIL', usuarioId: cuenta.usuario_id, cuentaId: cuenta.id, err: e.message }, 'Error en cuenta Gmail');
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
module.exports = { tieneGmailConectado, leerCorreosDesdeCuenta, agregarResultadosDeCuentas, generarUrlAutorizacion, verificarState, guardarTokens, cargarTokens, leerCorreosBancarios, oauth2Client, obtenerPerfilGoogle, obtenerCuentasGmail, revocarAccesoGmail, reintentarRevocacionesPendientes, BANCOS_CATALOGO, remitentesParaSeleccion, describirSeleccion, construirQueriesBancarias, emailGmailVinculado, hashEmailGmail, esElMismoGmail, esCorreoMasivo, direccionDe, esErrorSinBuzon, tocaReprobarSinBuzon };
