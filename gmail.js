const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const log = require('./lib/logger');

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

function generarUrlAutorizacion(whatsappNum, modo) {
  const stateObj = { num: whatsappNum || '', modo: modo || 'inicial' };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64');
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state
  });
}

async function guardarTokens(usuarioId, tokens, email, modo) {
  // Siempre sincronizar en usuarios para backwards compat
  const updateData = { gmail_access_token: tokens.access_token, gmail_token_expiry: tokens.expiry_date };
  if (tokens.refresh_token) updateData.gmail_refresh_token = tokens.refresh_token;
  await getSupabase().from('usuarios').update(updateData).eq('id', usuarioId);

  if (!email) return; // sin email no se puede guardar en gmail_cuentas

  if (modo === 'reemplazar') {
    // Desactivar todas las cuentas anteriores
    await getSupabase().from('gmail_cuentas').update({ activa: false }).eq('usuario_id', usuarioId);
  }

  // Upsert la cuenta nueva
  const cuenta = {
    usuario_id: usuarioId,
    email,
    access_token: tokens.access_token,
    token_expiry: tokens.expiry_date || null,
    activa: true,
    updated_at: new Date().toISOString()
  };
  if (tokens.refresh_token) cuenta.refresh_token = tokens.refresh_token;
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
    return { access_token: c.access_token, refresh_token: c.refresh_token, expiry_date: c.token_expiry };
  }
  // Fallback a usuarios tabla
  const { data } = await getSupabase().from('usuarios')
    .select('gmail_access_token, gmail_refresh_token, gmail_token_expiry').eq('id', usuarioId).single();
  if (!data || !data.gmail_access_token) return null;
  return { access_token: data.gmail_access_token, refresh_token: data.gmail_refresh_token, expiry_date: data.gmail_token_expiry };
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
  cliente.setCredentials({ access_token: cuenta.access_token, refresh_token: cuenta.refresh_token, expiry_date: cuenta.token_expiry });
  const necesitaRefresh = cuenta.token_expiry && cuenta.token_expiry < Date.now() + 5 * 60 * 1000;
  if (necesitaRefresh && cuenta.refresh_token) {
    try {
      const { credentials } = await cliente.refreshAccessToken();
      // Actualizar token en gmail_cuentas
      await getSupabase().from('gmail_cuentas').update({
        access_token: credentials.access_token,
        token_expiry: credentials.expiry_date,
        updated_at: new Date().toISOString()
      }).eq('usuario_id', cuenta.usuario_id).eq('email', cuenta.email);
      cliente.setCredentials(credentials);
    } catch(e) { log.error({ tag: 'TOKEN', err: e.message }, 'Error refrescando token'); }
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

async function leerCorreosDesdeCuenta(authClient, cuentaEmail) {

  const gmail = google.gmail({ version: 'v1', auth: authClient });

  // Query principal: remitentes bancarios conocidos - últimas 36 horas
  const queryDirecto = 'from:(' + REMITENTES_BANCARIOS.join(' OR ') + ') newer_than:2d -in:sent';
  
  // Query secundaria: palabras clave bancarias más amplias para BCP crédito y otros
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
  ].join(' OR ') + ' newer_than:2d -in:sent';

  const mensajesIds = new Set();
  const todosLosIds = [];

  for (const query of [queryDirecto, queryPalabrasClave]) {
    try {
      const { data } = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 20 });
      if (data.messages) {
        for (const m of data.messages) {
          if (!mensajesIds.has(m.id)) { mensajesIds.add(m.id); todosLosIds.push(m.id); }
        }
      }
    } catch(e) { log.error({ tag: 'GMAIL', err: e.message }, 'Error en query Gmail'); }
  }

  if (todosLosIds.length === 0) return { error: null, mensajes: [] };

  const mensajes = [];
  for (const id of todosLosIds.slice(0, 25)) {
    try {
      const { data: detalle } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = detalle.payload.headers || [];
      const asunto = (headers.find(h => h.name === 'Subject') || {}).value || '';
      const remitente = (headers.find(h => h.name === 'From') || {}).value || '';
      const fecha = new Date(parseInt(detalle.internalDate)).toISOString().split('T')[0];

      // FILTRO 1: Rechazar correos reenviados
      if (esCorreoReenviado(headers)) {
        log.debug({ tag: 'GMAIL', asunto: asunto.substring(0, 50) }, 'Correo reenviado ignorado');
        continue;
      }

      // FILTRO 2: Solo correos de los últimos 3 días (evitar correos viejos)
      const fechaCorreo = new Date(parseInt(detalle.internalDate));
      const hace3dias = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      if (fechaCorreo < hace3dias) {
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
      mensajes.push({ id, snippet: detalle.snippet, texto: textoParseo, asunto, remitente, fecha });
      log.info({ tag: 'GMAIL', asunto: asunto.substring(0, 60) }, 'Correo bancario encontrado');
    } catch(e) { log.error({ tag: 'GMAIL', err: e.message }, 'Error obteniendo correo'); }
  }

  return { error: null, mensajes, cuentaEmail };
}

async function leerCorreosBancarios(usuarioId) {
  const cuentas = await obtenerCuentasGmail(usuarioId);

  if (cuentas.length === 0) {
    // Fallback: intentar con token legacy en usuarios
    const authClient = await configurarClienteAutenticado(usuarioId);
    if (!authClient) return { error: 'no_auth', mensajes: [] };
    return leerCorreosDesdeCuenta(authClient, null);
  }

  // Escanear todas las cuentas activas en paralelo
  const resultados = await Promise.all(
    cuentas.map(async (cuenta) => {
      try {
        const cliente = await configurarClienteParaCuenta(cuenta);
        return leerCorreosDesdeCuenta(cliente, cuenta.email);
      } catch(e) {
        log.error({ tag: 'GMAIL', email: cuenta.email, err: e.message }, 'Error en cuenta Gmail');
        return { error: e.message, mensajes: [], cuentaEmail: cuenta.email };
      }
    })
  );

  // Unificar mensajes de todas las cuentas (deduplicar por id)
  const vistos = new Set();
  const mensajesUnificados = [];
  for (const r of resultados) {
    for (const m of (r.mensajes || [])) {
      const key = m.id + (r.cuentaEmail || '');
      if (!vistos.has(key)) { vistos.add(key); mensajesUnificados.push({ ...m, cuentaEmail: r.cuentaEmail }); }
    }
  }

  return { error: null, mensajes: mensajesUnificados };
}

module.exports = { generarUrlAutorizacion, guardarTokens, cargarTokens, leerCorreosBancarios, oauth2Client, obtenerPerfilGoogle, obtenerCuentasGmail };
