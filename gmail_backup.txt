const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  (process.env.RAILWAY_URL || 'https://finbot-production-c662.up.railway.app') + '/auth/callback'
);

const REMITENTES_BANCARIOS = [
  'notificaciones@yape.pe', 'alertas@bcp.com.pe', 'notificaciones@bcp.com.pe',
  'alertas@interbank.pe', 'notificaciones@interbank.pe', 'alertas@bbva.pe',
  'notificaciones@bbva.pe', 'notificaciones.tarjetas@scotiabank.pe',
  'alertas@scotiabank.pe', 'notificaciones@plin.pe', 'noreply@tunki.pe',
];

const PALABRAS_BANCARIAS = [
  'realizaste', 'transaccion', 'consumo', 'pago realizado', 'transferencia',
  'operacion', 'yape', 'plin', 'izipay', 'BCP', 'Interbank', 'BBVA',
  'Scotiabank', 'soles', 'S/', 'tarjeta', 'cuenta', 'cargo', 'abono',
  'deposito', 'retiro', 'compra', 'comercio', 'monto'
];

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
];

function generarUrlAutorizacion(whatsappNum) {
  const state = Buffer.from(whatsappNum || '').toString('base64');
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state
  });
}

async function guardarTokens(usuarioId, tokens) {
  const updateData = {
    gmail_access_token: tokens.access_token,
    gmail_token_expiry: tokens.expiry_date
  };
  if (tokens.refresh_token) {
    updateData.gmail_refresh_token = tokens.refresh_token;
  }
  const { error } = await supabase.from('usuarios').update(updateData).eq('id', usuarioId);
  if (error) throw error;
}

async function obtenerPerfilGoogle(authClient) {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: authClient });
    const { data } = await oauth2.userinfo.get();
    return { nombre: data.given_name || data.name || null, email: data.email || null };
  } catch(e) {
    console.error('[PERFIL] Error obteniendo perfil:', e.message);
    return { nombre: null, email: null };
  }
}

async function cargarTokens(usuarioId) {
  const { data } = await supabase
    .from('usuarios')
    .select('gmail_access_token, gmail_refresh_token, gmail_token_expiry')
    .eq('id', usuarioId)
    .single();
  if (!data || !data.gmail_access_token) return null;
  return {
    access_token: data.gmail_access_token,
    refresh_token: data.gmail_refresh_token,
    expiry_date: data.gmail_token_expiry
  };
}

async function configurarClienteAutenticado(usuarioId) {
  const tokens = await cargarTokens(usuarioId);
  if (!tokens) return null;

  const clienteLocal = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.RAILWAY_URL || 'https://finbot-production-c662.up.railway.app') + '/auth/callback'
  );
  clienteLocal.setCredentials(tokens);

  const necesitaRefresh = tokens.expiry_date && tokens.expiry_date < Date.now() + 5 * 60 * 1000;
  if (necesitaRefresh && tokens.refresh_token) {
    try {
      const { credentials } = await clienteLocal.refreshAccessToken();
      await guardarTokens(usuarioId, credentials);
      clienteLocal.setCredentials(credentials);
      console.log('[TOKEN] Token refrescado para usuario', usuarioId);
    } catch(e) {
      console.error('[TOKEN] Error refrescando token:', e.message);
    }
  }

  return clienteLocal;
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
  return PALABRAS_BANCARIAS.some(p => contenido.includes(p.toLowerCase()));
}

async function leerCorreosBancarios(usuarioId) {
  const authClient = await configurarClienteAutenticado(usuarioId);
  if (!authClient) return { error: 'no_auth', mensajes: [] };

  const gmail = google.gmail({ version: 'v1', auth: authClient });

  const queryDirecto = 'from:(' + REMITENTES_BANCARIOS.join(' OR ') + ') newer_than:2d';
  const queryPalabrasClave = '(yape OR "notificacion BCP" OR "consumo con tarjeta" OR "transferencia" OR "pago realizado" OR "cargo en cuenta" OR "abono en cuenta") newer_than:2d';

  const mensajesIds = new Set();
  const todosLosIds = [];

  for (const query of [queryDirecto, queryPalabrasClave]) {
    try {
      const { data } = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 15 });
      if (data.messages) {
        for (const m of data.messages) {
          if (!mensajesIds.has(m.id)) { mensajesIds.add(m.id); todosLosIds.push(m.id); }
        }
      }
    } catch(e) { console.error('Error en query Gmail:', e.message); }
  }

  if (todosLosIds.length === 0) return { error: null, mensajes: [] };

  const mensajes = [];
  for (const id of todosLosIds.slice(0, 20)) {
    try {
      const { data: detalle } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = detalle.payload.headers || [];
      const asunto = (headers.find(h => h.name === 'Subject') || {}).value || '';
      const remitente = (headers.find(h => h.name === 'From') || {}).value || '';
      const fecha = new Date(parseInt(detalle.internalDate)).toISOString().split('T')[0];
      const cuerpo = extraerTexto(detalle.payload);
      if (!esBancario(asunto + '\n' + cuerpo, asunto)) continue;
      const textoParseo = cuerpo.length > 100 ? cuerpo.substring(0, 1500) : detalle.snippet;
      mensajes.push({ id, snippet: detalle.snippet, texto: textoParseo, asunto, remitente, fecha });
    } catch(e) { console.error('Error obteniendo correo:', e.message); }
  }

  return { error: null, mensajes };
}

module.exports = { generarUrlAutorizacion, guardarTokens, cargarTokens, leerCorreosBancarios, oauth2Client, obtenerPerfilGoogle };
