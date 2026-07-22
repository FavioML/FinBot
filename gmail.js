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

function listaBancosNumerada() {
  return BANCOS_CATALOGO.map((b, i) => (i + 1) + '. ' + b.label).join('\n');
}

// Describe la selección guardada en texto legible. null/[] → "todos los bancos".
function describirSeleccion(seleccion) {
  if (!Array.isArray(seleccion) || seleccion.length === 0) return 'todos los bancos';
  const labels = BANCOS_CATALOGO.filter(b => seleccion.includes(b.id)).map(b => b.label);
  return labels.length > 0 ? labels.join(', ') : 'todos los bancos';
}

// Menú numerado de bancos para el flujo de conexión Gmail (WhatsApp).
function menuSeleccionBancos() {
  return '📧 *Conectar Gmail*\n\n' +
    'Primero dime con qué bancos operas, así Neto lee solo esos correos y nada más.\n\n' +
    'Responde con los números separados por coma (ej: *1,3,5*) o escribe *todos*:\n\n' +
    listaBancosNumerada();
}

// Menú para editar la selección en cualquier momento (comando /bancos), ya
// conectado o no. Muestra qué lee hoy y NO entrega enlace OAuth.
function menuEdicionBancos(seleccionActual) {
  return '🏦 *Tus bancos*\n\n' +
    'Hoy leo: *' + describirSeleccion(seleccionActual) + '*\n\n' +
    'Elige con qué bancos quieres que lea tus correos. Responde con los números separados por coma (ej: *1,3,5*) o escribe *todos*:\n\n' +
    listaBancosNumerada();
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

function generarUrlAutorizacion(whatsappNum, modo, origen) {
  const stateObj = { num: whatsappNum || '', modo: modo || 'inicial', ts: Date.now() };
  if (origen) stateObj.origen = origen; // 'web' → el callback redirige a la webapp
  const payload = Buffer.from(JSON.stringify(stateObj)).toString('base64url');
  const state = payload + '.' + firmarState(payload);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state
  });
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

async function guardarTokens(usuarioId, tokens, email, modo) {
  // Siempre sincronizar en usuarios para backwards compat (encrypted)
  const updateData = { gmail_access_token: encrypt(tokens.access_token), gmail_token_expiry: tokens.expiry_date };
  if (tokens.refresh_token) updateData.gmail_refresh_token = encrypt(tokens.refresh_token);
  await getSupabase().from('usuarios').update(updateData).eq('id', usuarioId);

  if (!email) return; // sin email no se puede guardar en gmail_cuentas

  if (modo === 'reemplazar') {
    // Desactivar todas las cuentas anteriores
    await getSupabase().from('gmail_cuentas').update({ activa: false }).eq('usuario_id', usuarioId);
  }

  // Upsert la cuenta nueva (encrypted tokens)
  const cuenta = {
    usuario_id: usuarioId,
    email,
    access_token: encrypt(tokens.access_token),
    token_expiry: tokens.expiry_date || null,
    activa: true,
    updated_at: new Date().toISOString()
  };
  if (tokens.refresh_token) cuenta.refresh_token = encrypt(tokens.refresh_token);
  await getSupabase().from('gmail_cuentas').upsert(cuenta, { onConflict: 'usuario_id,email' });
}

async function obtenerCuentasGmail(usuarioId) {
  const { data } = await getSupabase().from('gmail_cuentas').select('*')
    .eq('usuario_id', usuarioId).eq('activa', true).order('created_at', { ascending: true });
  return data || [];
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

  for (const query of [queryDirecto, queryPalabrasClave]) {
    try {
      const { data } = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: maxPerQuery });
      if (data.messages) {
        for (const m of data.messages) {
          if (!mensajesIds.has(m.id)) { mensajesIds.add(m.id); todosLosIds.push(m.id); }
        }
      }
    } catch(e) { log.error({ tag: 'GMAIL', err: e.message }, 'Error en query Gmail'); }
  }

  if (todosLosIds.length === 0) return { error: null, mensajes: [] };

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
    } catch(e) { log.error({ tag: 'GMAIL', err: e.message }, 'Error obteniendo correo'); }
  }

  return { error: null, mensajes, cuentaEmail };
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

async function leerCorreosBancarios(usuarioId, opts = {}) {
  const cuentas = await obtenerCuentasGmail(usuarioId);
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

  // Detectar si alguna cuenta tiene auth expirada
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

  return { error: authExpired ? 'AUTH_EXPIRED' : null, mensajes: mensajesUnificados };
}

module.exports = { generarUrlAutorizacion, verificarState, guardarTokens, cargarTokens, leerCorreosBancarios, oauth2Client, obtenerPerfilGoogle, obtenerCuentasGmail, BANCOS_CATALOGO, remitentesParaSeleccion, menuSeleccionBancos, menuEdicionBancos, describirSeleccion, construirQueriesBancarias };
