const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  (process.env.RAILWAY_URL || process.env.NGROK_URL || 'http://localhost:3000') + '/auth/callback'
);

// Remitentes bancarios peruanos conocidos
const REMITENTES_BANCARIOS = [
  'notificaciones@yape.pe',
  'alertas@bcp.com.pe',
  'notificaciones@bcp.com.pe',
  'alertas@interbank.pe',
  'notificaciones@interbank.pe',
  'alertas@bbva.pe',
  'notificaciones@bbva.pe',
  'notificaciones.tarjetas@scotiabank.pe',
  'alertas@scotiabank.pe',
  'notificaciones@plin.pe',
  'noreply@tunki.pe',
];

// Palabras clave que aparecen en notificaciones bancarias peruanas
const PALABRAS_BANCARIAS = [
  'realizaste', 'realizaste un', 'transaccion', 'consumo', 'pago realizado',
  'transferencia', 'operacion', 'yape', 'plin', 'izipay',
  'BCP', 'Interbank', 'BBVA', 'Scotiabank', 'soles', 'S/',
  'tarjeta', 'cuenta', 'cargo', 'abono', 'deposito',
  'retiro', 'compra', 'comercio', 'monto'
];

function generarUrlAutorizacion(whatsappNum) {
  // Codificamos el numero de WhatsApp en el state para identificar al usuario en el callback
  const state = Buffer.from(whatsappNum || '').toString('base64');
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent',
    state
  });
}

async function guardarTokens(usuarioId, tokens) {
  const { error } = await supabase
    .from('usuarios')
    .update({
      gmail_access_token: tokens.access_token,
      gmail_refresh_token: tokens.refresh_token,
      gmail_token_expiry: tokens.expiry_date
    })
    .eq('id', usuarioId);
  if (error) throw error;
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

// Decodifica base64 de Gmail (URL-safe)
function decodificarBase64(str) {
  try {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  } catch (e) {
    return '';
  }
}

// Extrae el texto plano del payload del correo (recursivo para multipart)
function extraerTexto(payload) {
  if (!payload) return '';
  // Parte directa de texto plano
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodificarBase64(payload.body.data);
  }
  // Parte de texto HTML
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    const html = decodificarBase64(payload.body.data);
    // Limpia HTML basico
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Multipart: buscar en partes
  if (payload.parts && payload.parts.length > 0) {
    // Preferir texto plano primero
    for (const parte of payload.parts) {
      if (parte.mimeType === 'text/plain') {
        const texto = extraerTexto(parte);
        if (texto) return texto;
      }
    }
    // Si no hay texto plano, usar HTML
    for (const parte of payload.parts) {
      const texto = extraerTexto(parte);
      if (texto) return texto;
    }
  }
  return '';
}

// Detecta si el texto contiene contenido bancario
function esBancario(texto, asunto) {
  const contenido = (texto + ' ' + (asunto || '')).toLowerCase();
  return PALABRAS_BANCARIAS.some(p => contenido.includes(p.toLowerCase()));
}

async function leerCorreosBancarios(usuarioId) {
  const tokens = await cargarTokens(usuarioId);
  if (!tokens) return { error: 'no_auth', mensajes: [] };

  oauth2Client.setCredentials(tokens);

  // Refrescar token si esta por vencer
  if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    await guardarTokens(usuarioId, credentials);
    oauth2Client.setCredentials(credentials);
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // ESTRATEGIA DUAL:
  // 1) Correos directos de remitentes bancarios
  // 2) Correos reenviados que contengan palabras bancarias (sin filtro de remitente)
  const queryDirecto = `from:(${REMITENTES_BANCARIOS.join(' OR ')}) newer_than:7d`;
  const queryReenviados = `subject:(Fwd OR Fw OR RV OR Reenviado OR fwd) newer_than:7d`;
  const queryPalabrasClave = `(yape OR "notificacion BCP" OR "consumo con tarjeta" OR "transferencia" OR "pago realizado" OR "cargo en cuenta" OR "abono en cuenta") newer_than:7d`;

  const mensajesIds = new Set();
  const todosLosIds = [];

  for (const query of [queryDirecto, queryReenviados, queryPalabrasClave]) {
    try {
      const { data } = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 15
      });
      if (data.messages) {
        for (const m of data.messages) {
          if (!mensajesIds.has(m.id)) {
            mensajesIds.add(m.id);
            todosLosIds.push(m.id);
          }
        }
      }
    } catch (e) {
      console.error('Error en query Gmail:', e.message);
    }
  }

  if (todosLosIds.length === 0) return { error: null, mensajes: [] };

  // Obtener detalle completo de cada correo
  const mensajes = [];
  for (const id of todosLosIds.slice(0, 20)) {
    try {
      const { data: detalle } = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full'
      });

      const headers = detalle.payload.headers || [];
      const asunto = (headers.find(h => h.name === 'Subject') || {}).value || '';
      const remitente = (headers.find(h => h.name === 'From') || {}).value || '';
      const fecha = new Date(parseInt(detalle.internalDate)).toISOString().split('T')[0];

      // Extraer cuerpo completo
      const cuerpo = extraerTexto(detalle.payload);
      const textoCompleto = asunto + '\n' + cuerpo;

      // Filtrar: solo incluir si parece bancario
      if (!esBancario(textoCompleto, asunto)) continue;

      // Para correos reenviados, combinar snippet + cuerpo para mejor contexto
      const textoParseo = cuerpo.length > 100
        ? cuerpo.substring(0, 1500)  // Limitar a 1500 chars para no exceder tokens
        : detalle.snippet;

      mensajes.push({
        id,
        snippet: detalle.snippet,
        texto: textoParseo,
        asunto,
        remitente,
        fecha,
        esReenviado: asunto.toLowerCase().includes('fwd') ||
                     asunto.toLowerCase().includes('fw:') ||
                     asunto.toLowerCase().includes('rv:') ||
                     asunto.toLowerCase().includes('reenviado')
      });

    } catch (e) {
      console.error('Error obteniendo correo:', e.message);
    }
  }

  return { error: null, mensajes };
}

module.exports = {
  generarUrlAutorizacion,
  guardarTokens,
  cargarTokens,
  leerCorreosBancarios,
  oauth2Client
};