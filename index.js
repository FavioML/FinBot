require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { generarReportePDF } = require('./reporte_pdf');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { generarUrlAutorizacion, guardarTokens, leerCorreosBancarios, oauth2Client } = require('./gmail');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function obtenerOCrearUsuario(numeroWhatsapp) {
  try {
    const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroWhatsapp).single();
    if (data) return data;
  } catch (e) {}
  const { data: nuevo, error } = await supabase.from('usuarios').insert({ whatsapp: numeroWhatsapp }).select().single();
  if (error) throw new Error('Error creando usuario: ' + error.message);
  return nuevo;
}

async function guardarTransaccion(usuarioId, datos) {
  const { data, error } = await supabase.from('transacciones').insert({
    usuario_id: usuarioId, tipo: datos.tipo, monto: datos.monto, moneda: datos.moneda || 'PEN',
    comercio: datos.comercio, categoria: datos.categoria, banco: datos.banco,
    fecha: datos.fecha || new Date().toISOString().split('T')[0],
    descripcion_original: datos.descripcion_original, confirmado: false
  }).select().single();
  if (error) throw error;
  return data;
}

async function obtenerGastosMes(usuarioId) {
  const hoy = new Date();
  const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];
  const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto').gte('fecha', primero).order('fecha', { ascending: false });
  return data || [];
}

async function obtenerGastosSemana(usuarioId) {
  const hace7 = new Date();
  hace7.setDate(hace7.getDate() - 7);
  const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto').gte('fecha', hace7.toISOString().split('T')[0]).order('fecha', { ascending: false });
  return data || [];
}

async function guardarPresupuesto(usuarioId, categoria, monto) {
  const hoy = new Date();
  const { data, error } = await supabase.from('presupuestos').upsert({
    usuario_id: usuarioId, categoria, monto_limite: monto,
    mes: hoy.getMonth() + 1, anio: hoy.getFullYear()
  }, { onConflict: 'usuario_id,categoria,mes,anio' }).select().single();
  if (error) throw error;
  return data;
}

async function obtenerPresupuestosMes(usuarioId) {
  const hoy = new Date();
  const { data } = await supabase.from('presupuestos').select('*').eq('usuario_id', usuarioId)
    .eq('mes', hoy.getMonth() + 1).eq('anio', hoy.getFullYear());
  return data || [];
}

async function verificarAlertaPresupuesto(usuarioId, categoria) {
  const hoy = new Date();
  const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];
  const { data: presupuesto } = await supabase.from('presupuestos').select('*')
    .eq('usuario_id', usuarioId).eq('categoria', categoria)
    .eq('mes', hoy.getMonth() + 1).eq('anio', hoy.getFullYear()).single();
  if (!presupuesto) return null;
  const { data: txs } = await supabase.from('transacciones').select('monto')
    .eq('usuario_id', usuarioId).eq('categoria', categoria).eq('tipo', 'gasto').gte('fecha', primero);
  const total = (txs || []).reduce((s, t) => s + parseFloat(t.monto), 0);
  const limite = parseFloat(presupuesto.monto_limite);
  const pct = (total / limite) * 100;
  if (pct >= 100) return 'LIMITE SUPERADO: Gastaste S/ ' + total.toFixed(2) + ' de S/ ' + limite.toFixed(2) + ' en ' + categoria + ' (' + pct.toFixed(0) + '%)';
  if (pct >= 80) return 'ALERTA: Llevas S/ ' + total.toFixed(2) + ' de S/ ' + limite.toFixed(2) + ' en ' + categoria + ' (' + pct.toFixed(0) + '%). Casi al limite!';
  return null;
}

async function parsearCorreoBancario(texto, contexto) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Eres un parser de notificaciones bancarias peruanas. El texto puede ser correo directo de banco o REENVIADO con la notificacion dentro. En reenviados, extrae la informacion del cuerpo reenviado. Devuelve SOLO JSON sin markdown: { "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"nombre del comercio o descripcion del pago", "categoria":"Supermercados|Restaurantes|Transporte|Streaming|Educacion|Salud|Transferencia|Entretenimiento|Servicios|Farmacia|Otro", "banco":"BCP|Interbank|BBVA|Scotiabank|Yape|Plin|Otro", "fecha":"YYYY-MM-DD", "descripcion_original":"texto original" }. Normaliza: SPSA=Plaza Vea, DLOCAL*NETFLIX=Netflix, PRIMAX=Grifo, NETFLIX.COM=Netflix, TGESTIONA=Claro. IMPORTANTE: comercio NUNCA debe ser null; si no hay nombre claro usa la descripcion del pago o el banco como fallback.' },
      { role: 'user', content: 'Parsea este correo bancario' + (contexto ? ' (asunto: ' + contexto + ')' : '') + ':\n\n' + texto }
    ],
    temperature: 0
  });
  const raw = res.choices[0].message.content.trim();
  const clean = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  return JSON.parse(clean);
}

function barraProgreso(pct) {
  const llenos = Math.min(Math.round((pct / 100) * 10), 10);
  const color = pct >= 100 ? '[ROJO]' : pct >= 80 ? '[AMARILLO]' : '[VERDE]';
  return color + ' [' + '#'.repeat(llenos) + '.'.repeat(10 - llenos) + '] ' + pct.toFixed(0) + '%';
}

function formatearResumen(txs, periodo) {
  if (!txs.length) return 'No hay gastos registrados ' + periodo + '.';
  const total = txs.reduce((s, t) => s + parseFloat(t.monto), 0);
  const porCat = {};
  txs.forEach(t => { const c = t.categoria || 'Otro'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto); });
  let msg = '*Resumen ' + periodo + '*\n---------------\nTotal: *S/ ' + total.toFixed(2) + '*\nTransacciones: ' + txs.length + '\n\n*Por categoria:*\n';
  Object.entries(porCat).sort((a, b) => b[1] - a[1]).forEach(([cat, monto]) => {
    msg += '- ' + cat + ': S/ ' + monto.toFixed(2) + ' (' + ((monto/total)*100).toFixed(0) + '%)\n';
  });
  return msg;
}

async function formatearEstadoPresupuesto(usuarioId) {
  const presupuestos = await obtenerPresupuestosMes(usuarioId);
  if (!presupuestos.length) return 'No tienes presupuestos configurados.\n\nUsa: /presupuesto [categoria] [monto]\nEj: /presupuesto Restaurantes 300';
  const hoy = new Date();
  const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];
  let msg = '*Tu presupuesto de ' + hoy.toLocaleString('es-PE', { month: 'long' }) + '*\n---------------\n\n';
  for (const p of presupuestos) {
    const { data: txs } = await supabase.from('transacciones').select('monto')
      .eq('usuario_id', usuarioId).eq('categoria', p.categoria).eq('tipo', 'gasto').gte('fecha', primero);
    const gastado = (txs || []).reduce((s, t) => s + parseFloat(t.monto), 0);
    const limite = parseFloat(p.monto_limite);
    const pct = (gastado / limite) * 100;
    msg += '*' + p.categoria + '*\n' + barraProgreso(pct) + '\nS/ ' + gastado.toFixed(2) + ' / S/ ' + limite.toFixed(2) + ' (resta S/ ' + Math.max(limite - gastado, 0).toFixed(2) + ')\n\n';
  }
  return msg;
}

async function escanearGmailYRegistrar(usuario) {
  const { error, mensajes } = await leerCorreosBancarios(usuario.id);
  if (error === 'no_auth') return null;
  if (!mensajes.length) return null;
  let registradas = 0;
  let ignoradas = 0;
  let resumen = '';
  for (const msg of mensajes) {
    try {
      const textoParseo = msg.texto || msg.snippet;
      const claveDedup = msg.id;
      const { data: existente } = await supabase.from('transacciones').select('id')
        .eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).single();
      if (existente) { ignoradas++; continue; }
      const resultado = await parsearCorreoBancario(textoParseo, msg.asunto);
      if (!resultado.monto) continue;
      await guardarTransaccion(usuario.id, {
        ...resultado,
        fecha: msg.fecha || resultado.fecha,
        descripcion_original: claveDedup
      });
      registradas++;
      const tipo = resultado.tipo === 'ingreso' ? 'Ingreso' : 'Gasto';
      const reenviado = msg.esReenviado ? ' (reenviado)' : '';
      const nombreComercio = resultado.comercio || resultado.banco || (msg.asunto ? msg.asunto.substring(0,30) : 'Sin nombre');
      resumen += '- ' + tipo + ': ' + nombreComercio + ' S/ ' + resultado.monto + reenviado + '\n';
    } catch (e) { console.error('Error procesando correo:', e.message); }
  }
  if (registradas === 0) {
    if (ignoradas > 0) return '*Sin correos nuevos*\n\n' + ignoradas + ' correo(s) ya estaban registrados.';
    return null;
  }
  return '*FinBot escaneo tu Gmail*\n\nRegistre *' + registradas + '* transaccion(es):\n' + resumen + '\nEscribe */mes* para ver tu resumen.';
}



// -- REPORTE MENSUAL PDF -----------------------------------------------------
async function generarYEnviarReporte(usuario, mes, anio) {
  // Obtener transacciones del mes
  const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
  const hasta = anio + '-' + String(mes).padStart(2,'0') + '-31';
  const { data: txs } = await supabase
    .from('transacciones')
    .select('*')
    .eq('usuario_id', usuario.id)
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .order('fecha', { ascending: false });

  if (!txs || txs.length === 0) {
    return { ok: false, msg: 'No hay transacciones registradas para ese mes.' };
  }

  // Obtener presupuestos
  const { data: presupData } = await supabase
    .from('presupuestos')
    .select('*')
    .eq('usuario_id', usuario.id)
    .eq('mes', mes)
    .eq('anio', anio);

  const presupuestos = {};
  if (presupData) presupData.forEach(p => { presupuestos[p.categoria] = parseFloat(p.monto_limite); });

  // Generar PDF
  const tmpPath = path.join(os.tmpdir(), 'finbot_reporte_' + usuario.id + '_' + mes + '_' + anio + '.pdf');
  await generarReportePDF({ nombre: usuario.nombre || 'Usuario', mes, anio, transacciones: txs, presupuestos }, tmpPath);

  // Subir PDF a Twilio y obtener URL publica (usamos el endpoint de media de Twilio)
  const pdfBuffer = fs.readFileSync(tmpPath);
  const base64PDF = pdfBuffer.toString('base64');

  // Servir el PDF via endpoint temporal del propio servidor
  const reporteId = Date.now();
  global.reportesTemp = global.reportesTemp || {};
  global.reportesTemp[reporteId] = { buffer: pdfBuffer, expires: Date.now() + 30 * 60 * 1000 };

  return { ok: true, reporteId, txCount: txs.length, tmpPath };
}
// ---------------------------------------------------------------------------

// -- RECATEGORIZACION ----------------------------------------
const CATEGORIAS = ['Supermercados','Restaurantes','Transporte','Streaming','Educacion','Salud','Transferencia','Entretenimiento','Servicios','Farmacia','Otro'];

async function interpretarCorreccion(texto) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Eres un asistente que interpreta correcciones de categoria de gastos. El usuario quiere cambiar la categoria de una transaccion. Devuelve SOLO JSON sin markdown: { "comercio": "nombre del comercio mencionado o null", "categoria_nueva": "una de: Supermercados|Restaurantes|Transporte|Streaming|Educacion|Salud|Transferencia|Entretenimiento|Servicios|Farmacia|Otro", "es_correccion": true|false }. Si el mensaje no es una correccion de categoria, devuelve es_correccion: false.' },
      { role: 'user', content: texto }
    ],
    temperature: 0
  });
  const raw = res.choices[0].message.content.trim();
  const clean = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1);
  return JSON.parse(clean);
}

async function recategorizarTransaccion(usuarioId, comercio, categoriaNueva) {
  // Buscar la transaccion mas reciente que coincida con ese comercio
  const { data: txs } = await supabase
    .from('transacciones')
    .select('*')
    .eq('usuario_id', usuarioId)
    .ilike('comercio', '%' + comercio + '%')
    .order('created_at', { ascending: false })
    .limit(5);

  if (!txs || txs.length === 0) return { ok: false, msg: 'No encontre ninguna transaccion de *' + comercio + '*.' };

  const tx = txs[0];
  const { error } = await supabase
    .from('transacciones')
    .update({ categoria: categoriaNueva })
    .eq('id', tx.id);

  if (error) return { ok: false, msg: 'Error actualizando: ' + error.message };

  return {
    ok: true,
    msg: 'Listo! Cambie la categoria de *' + (tx.comercio || comercio) + '* (S/ ' + tx.monto + ') de *' + (tx.categoria || 'Sin categoria') + '* a *' + categoriaNueva + '*.'
  };
}
// -----------------------------------------------------------

app.post('/webhook', async (req, res) => {
  const msg = (req.body.Body || '').trim();
  const from = req.body.From || '';
  console.log('[MSG] [' + from + ']: ' + msg);
  let respuesta = '';
  try {
    const usuario = await obtenerOCrearUsuario(from);
    const cmd = msg.toLowerCase().trim();

    // Auto-bienvenida si es usuario nuevo sin Gmail y escribe algo que no es comando
    const esUsuarioNuevo = !usuario.gmail_access_token;
    if (esUsuarioNuevo && cmd !== 'hola' && cmd !== 'hi' && cmd !== 'inicio' && !cmd.startsWith('/') && msg.length < 30) {
      respuesta = '👋 Bienvenido a *FinBot Peru*!\n\nEscribe *hola* para ver como empezar, o */conectar* para vincular tu Gmail directamente.';
    } else if (cmd === 'hola' || cmd === 'hi' || cmd === 'inicio') {
      const tieneGmail = !!usuario.gmail_access_token;
      const esNuevo = !tieneGmail;
      if (esNuevo) {
        respuesta = '👋 Bienvenido a *FinBot Peru*!\n\nSoy tu asistente de finanzas personales. Registro automaticamente tus gastos desde correos de BCP, Interbank, BBVA, Scotiabank, Yape y Plin.\n\n*Para empezar:*\n1⃣ Escribe */conectar* para vincular tu Gmail\n2⃣ Escribe */escanear* para importar tus movimientos\n3⃣ Escribe */mes* para ver tu resumen mensual\n\n_Escribe /ayuda para ver todos los comandos._';
      } else {
        respuesta = '👋 Hola! Soy *FinBot Peru*\n\nGmail: ✅ Conectado\n\n*Comandos:*\n*/semana* — gastos 7 dias\n*/mes* — gastos del mes\n*/presupuesto* — ver presupuesto\n*/conectar* — reconectar Gmail\n*/escanear* — leer correos bancarios\n*/ayuda* — todos los comandos';
      }
    } else if (cmd === '/conectar') {
      const url = generarUrlAutorizacion(from);
      respuesta = '*Conectar Gmail a FinBot*\n\nAbre este enlace en tu navegador:\n\n' + url + '\n\n_Solo leeremos correos bancarios. Proceso seguro._';
    } else if (cmd === '/escanear') {
      const resultado = await escanearGmailYRegistrar(usuario);
      if (resultado) { respuesta = resultado; }
      else if (!usuario.gmail_access_token) { respuesta = 'No tienes Gmail conectado. Escribe */conectar*.'; }
      else { respuesta = 'No encontre correos bancarios nuevos en las ultimas 24 horas.'; }
    } else if (cmd === '/semana' || cmd === '/resumen') {
      const gastos = await obtenerGastosSemana(usuario.id);
      const porCat = {};
      gastos.forEach(t => { const c = t.categoria || 'Otro'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto); });
      const top3 = Object.entries(porCat).sort((a,b) => b[1]-a[1]).slice(0,3).map(([c,m]) => c + ': S/ ' + m.toFixed(2)).join(' | ');
      respuesta = formatearResumen(gastos, 'esta semana') + (top3 ? '\n🏆 *Top:* ' + top3 : '');
    } else if (cmd === '/mes') {
      respuesta = formatearResumen(await obtenerGastosMes(usuario.id), 'este mes');
    } else if (cmd === '/presupuesto') {
      respuesta = await formatearEstadoPresupuesto(usuario.id);
    } else if (cmd.startsWith('/presupuesto ')) {
      const partes = msg.trim().split(' ');
      if (partes.length >= 3) {
        const categoria = partes[1]; const monto = parseFloat(partes[2]);
        if (isNaN(monto) || monto <= 0) { respuesta = 'Monto invalido. Ej: /presupuesto Restaurantes 300'; }
        else { await guardarPresupuesto(usuario.id, categoria, monto); respuesta = '*Presupuesto guardado*\n' + categoria + ': S/ ' + monto.toFixed(2) + '/mes'; }
      } else { respuesta = 'Formato: /presupuesto [categoria] [monto]'; }
      respuesta = '*Comandos FinBot Peru:*\n*/semana* o */resumen* - gastos 7 dias\n*/mes* - gastos del mes\n*/reporte* - PDF del mes actual\n*/reporte [mes] [anio]* - PDF de otro mes\n*/presupuesto* - ver/configurar presupuesto\n*/conectar* - vincular Gmail\n*/escanear* - leer correos ahora\n*/cambiar [comercio] [cat]* - corregir categoria\n\n_"ese gasto de KFC era Entretenimiento"_ - lenguaje natural';
      respuesta = '*Comandos FinBot Peru:*\n*/semana* o */resumen* — gastos 7 dias\n*/mes* — gastos del mes\n*/reporte* — PDF del mes actual\n*/reporte [mes] [anio]* — PDF de otro mes\n*/presupuesto* — ver/configurar presupuesto\n*/conectar* — vincular Gmail\n*/escanear* — leer correos ahora\n*/cambiar [comercio] [cat]* — corregir categoria\n\n_"ese gasto de KFC era Entretenimiento"_ — lenguaje natural';
    } else if (cmd.startsWith('/cambiar ')) {
      // Formato: /cambiar [comercio] [categoria]
      const partes = msg.trim().split(' ');
      if (partes.length >= 3) {
        const comercioInput = partes[1];
        const categoriaInput = partes.slice(2).join(' ');
        const catNormalizada = CATEGORIAS.find(c => c.toLowerCase() === categoriaInput.toLowerCase());
        if (!catNormalizada) {
          respuesta = 'Categoria no valida. Usa una de:\n' + CATEGORIAS.join(' | ');
        } else {
          const resultado = await recategorizarTransaccion(usuario.id, comercioInput, catNormalizada);
          respuesta = resultado.msg;
        }
      } else {
        respuesta = 'Formato: /cambiar [comercio] [categoria]\nEj: /cambiar KFC Entretenimiento\nCategorias: ' + CATEGORIAS.join(' | ');
      }
    } else if (cmd === '/reporte' || cmd.startsWith('/reporte ')) {
      const ahoraR = new Date();
      const partesR = cmd.split(' ');
      const mesR  = partesR[1] ? parseInt(partesR[1]) : (ahoraR.getMonth() + 1);
      const anioR = partesR[2] ? parseInt(partesR[2]) : ahoraR.getFullYear();
      if (mesR < 1 || mesR > 12 || isNaN(mesR)) {
        respuesta = 'Formato: /reporte [mes] [anio]\nEj: /reporte 3 2026';
      } else {
        respuesta = 'Generando tu reporte PDF... un momento.';
        res.set('Content-Type', 'text/xml');
        const safe0 = respuesta.replace(/&/g,'&amp;');
        res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + safe0 + '</Message></Response>');
        const ngrokUrl = process.env.NGROK_URL || 'https://argillaceous-elyse-unaddible.ngrok-free.dev';
        generarYEnviarReporte(usuario, mesR, anioR).then(async (result) => {
          if (!result.ok) { await enviarWhatsapp(usuario.whatsapp, result.msg); }
          else {
            const pdfUrl = ngrokUrl + '/reporte/' + result.reporteId;
            const mE = ['','Enero','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
            await enviarWhatsapp(usuario.whatsapp,
              '*Reporte ' + mE[mesR] + ' ' + anioR + ' listo!*\n\n' +
              result.txCount + ' transacciones registradas.\n' +
              'Disponible por 30 minutos:\n' + pdfUrl);
          }
        }).catch(async (e) => {
          console.error('[REPORTE]', e.message);
          await enviarWhatsapp(usuario.whatsapp, 'Error generando reporte: ' + e.message);
        });
        return;
      }
    } else if (cmd === '/ayuda') {
      const mE2 = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
      const mesActual = new Date().getMonth() + 1;
      respuesta = '*Comandos FinBot Peru:*\n*/semana* o */resumen* — gastos 7 dias\n*/mes* — gastos del mes\n*/presupuesto* — ver/configurar presupuesto\n*/conectar* — vincular Gmail\n*/escanear* — leer correos ahora\n*/cambiar [comercio] [categoria]* — corregir categoria\n*/reporte* — PDF del mes actual\n*/reporte ' + mesActual + '* — PDF de un mes especifico\n*hola* — estado general';
    } else if (msg.length > 30) {
      // Primero verificar si es una correccion de categoria en lenguaje natural
      let esCorreccion = false;
      const palabrasCorreccion = ['era', 'fue', 'es', 'cambiar', 'cambia', 'categoria', 'no es', 'no era', 'corregir', 'corrige'];
      if (palabrasCorreccion.some(p => msg.toLowerCase().includes(p))) {
        try {
          const interp = await interpretarCorreccion(msg);
          if (interp.es_correccion && interp.comercio && interp.categoria_nueva) {
            esCorreccion = true;
            const resultado = await recategorizarTransaccion(usuario.id, interp.comercio, interp.categoria_nueva);
            respuesta = resultado.msg;
          }
        } catch(e) { console.error('Error interpretando correccion:', e.message); }
      }

      if (!esCorreccion) {
        const resultado = await parsearCorreoBancario(msg);
        const tx = await guardarTransaccion(usuario.id, resultado);
      console.log('Guardado id:', tx.id);
      respuesta = '*Transaccion registrada*\nTipo: ' + resultado.tipo + '\nMonto: S/ ' + resultado.monto + '\nComercio: ' + (resultado.comercio || 'No detectado') + '\nCategoria: ' + (resultado.categoria || 'No detectado') + '\nBanco: ' + (resultado.banco || 'No detectado');
      if (resultado.tipo === 'gasto' && resultado.categoria) {
        const alerta = await verificarAlertaPresupuesto(usuario.id, resultado.categoria);
        if (alerta) respuesta += '\n\n' + alerta;
      }
      respuesta += '\n\n_Escribe /mes o /presupuesto_';
      }
    } else {
      respuesta = 'No entendi ese mensaje. Escribe *hola* para ver los comandos.';
    }
  } catch (error) {
    console.error('ERROR:', error.message);
    respuesta = 'Error: ' + error.message;
  }
  res.set('Content-Type', 'text/xml');
  const safe = respuesta.replace(/&/g, '&amp;');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + safe + '</Message></Response>');
});

// Endpoint para descargar PDF del reporte

app.get('/debug/reportes', (req, res) => {
  global.reportesTemp = global.reportesTemp || {};
  const keys = Object.keys(global.reportesTemp);
  res.json({ count: keys.length, ids: keys, now: Date.now() });
});

app.get('/reporte/:id', (req, res) => {
  const id = req.params.id;
  global.reportesTemp = global.reportesTemp || {};
  const entry = global.reportesTemp[id];
  if (!entry) return res.status(404).send('Reporte no encontrado o expirado.');
  if (Date.now() > entry.expires) {
    delete global.reportesTemp[id];
    return res.status(404).send('El link del reporte expiro. Escribe /reporte para generar uno nuevo.');
  }
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="finbot_reporte.pdf"');
  res.set('ngrok-skip-browser-warning', 'true');
  res.send(entry.buffer);
});


// Endpoint para descargar PDF temporal
app.get('/reporte/:id', (req, res) => {
  const id = req.params.id;
  global.reportesTemp = global.reportesTemp || {};
  const reporte = global.reportesTemp[id];
  if (!reporte || Date.now() > reporte.expires) {
    return res.status(404).send('Reporte expirado o no encontrado.');
  }
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="finbot_reporte.pdf"');
  res.send(reporte.buffer);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send('<h2>Error: ' + error + '</h2>');
  if (!code) return res.send('<h2>No se recibio el codigo</h2>');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Decodificar el numero de WhatsApp desde el state
    let whatsappNum = null;
    if (req.query.state) {
      try { whatsappNum = Buffer.from(req.query.state, 'base64').toString('utf8'); } catch(e) {}
    }

    let usuario = null;
    if (whatsappNum) {
      const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', whatsappNum).single();
      usuario = data;
    }
    if (!usuario) {
      const { data } = await supabase.from('usuarios').select('*')
        .is('gmail_access_token', null).order('created_at', { ascending: false }).limit(1).single();
      usuario = data;
    }
    if (!usuario) return res.send('<h2>No se encontro el usuario. Vuelve a WhatsApp y escribe /conectar.</h2>');

    await guardarTokens(usuario.id, tokens);
    const nombre = usuario.nombre ? ', ' + usuario.nombre : '';
    res.send('<html><body style="font-family:Arial;text-align:center;padding:50px;background:#0d1b2a;color:white"><h1 style="color:#4CAF50">Gmail conectado' + nombre + '!</h1><p style="font-size:18px">Vuelve a WhatsApp y escribe <strong>/escanear</strong> para leer tus correos bancarios.</p><p style="color:#aaa;font-size:14px">Puedes cerrar esta ventana.</p></body></html>');
  } catch (err) {
    res.send('<h2>Error: ' + err.message + '</h2>');
  }
});

app.post('/test-parser', async (req, res) => {
  const { correo } = req.body;
  if (!correo) return res.status(400).json({ error: 'Falta correo' });
  try { const r = await parsearCorreoBancario(correo); res.json({ ok: true, resultado: r }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (req, res) => res.send('FinBot Peru v4'));

// ── ESCANEO AUTOMATICO ──────────────────────────────────────────────
// Envia mensaje WhatsApp proactivo via Twilio REST API
async function enviarWhatsapp(numero, mensaje) {
  try {
    const auth = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
    const body = new URLSearchParams({
      From: process.env.TWILIO_WHATSAPP_NUMBER,
      To: numero,
      Body: mensaje
    });
    const response = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Messages.json', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await response.json();
    if (data.sid) { console.log('[AUTO] Mensaje enviado a', numero, '- SID:', data.sid); }
    else { console.error('[AUTO] Error Twilio:', JSON.stringify(data)); }
  } catch (e) {
    console.error('[AUTO] Error enviando WhatsApp:', e.message);
  }
}

// Escanea Gmail de todos los usuarios con token y envia notificacion si hay movimientos nuevos
async function escaneoAutomatico() {
  console.log('[AUTO] Iniciando escaneo automatico -', new Date().toLocaleString('es-PE'));
  try {
    const { data: usuarios } = await supabase
      .from('usuarios')
      .select('*')
      .not('gmail_access_token', 'is', null);

    if (!usuarios || usuarios.length === 0) {
      console.log('[AUTO] Sin usuarios con Gmail conectado.');
      return;
    }

    console.log('[AUTO]', usuarios.length, 'usuario(s) con Gmail conectado.');

    for (const usuario of usuarios) {
      try {
        const resultado = await escanearGmailYRegistrar(usuario);
        if (resultado) {
          // Solo notifica si hay transacciones nuevas (no si dice "ya registrados")
          const tieneNuevas = resultado.includes('Registre');
          if (tieneNuevas) {
            console.log('[AUTO] Nuevas transacciones para', usuario.whatsapp);
            await enviarWhatsapp(usuario.whatsapp, '🔄 *Escaneo automatico*\n\n' + resultado);
          } else {
            console.log('[AUTO] Sin nuevos movimientos para', usuario.whatsapp);
          }
        }
      } catch (e) {
        console.error('[AUTO] Error procesando usuario', usuario.whatsapp, ':', e.message);
      }
    }
  } catch (e) {
    console.error('[AUTO] Error general:', e.message);
  }
}

// ── RESUMEN SEMANAL AUTOMATICO ──────────────────────────────────────
// Verifica si hay que enviar el resumen semanal (lunes a las 8am Lima, UTC-5)
async function checkResumenSemanal() {
  const ahora = new Date();
  // Peru es UTC-5
  const horaLima = new Date(ahora.getTime() - 5 * 60 * 60 * 1000);
  const diaSemana = horaLima.getUTCDay(); // 1 = lunes
  const hora = horaLima.getUTCHours();
  const minuto = horaLima.getUTCMinutes();

  // Solo los lunes entre 8:00 y 8:14 (ventana de 15 min para no perder el disparo)
  if (diaSemana !== 1 || hora !== 8 || minuto > 14) return;

  console.log('[SEMANAL] Es lunes 8am Lima - enviando resumen semanal...');

  try {
    const { data: usuarios } = await supabase
      .from('usuarios')
      .select('*')
      .not('gmail_access_token', 'is', null);

    if (!usuarios || usuarios.length === 0) return;

    for (const usuario of usuarios) {
      try {
        const gastos = await obtenerGastosSemana(usuario.id);
        if (!gastos.length) continue;

        const resumen = formatearResumen(gastos, 'esta semana');
        const total = gastos.reduce((s, t) => s + parseFloat(t.monto), 0);

        // Top 3 categorias
        const porCat = {};
        gastos.forEach(function(t) { var c = t.categoria || 'Otro'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto); });
        const top3 = Object.entries(porCat).sort(function(a,b){return b[1]-a[1];}).slice(0,3);
        const topStr = top3.map(function(x){return x[0]+': S/ '+x[1].toFixed(2);}).join(' | ');
        const fechaDesde = new Date(Date.now() - 7*24*60*60*1000).toLocaleDateString('es-PE', {day:'numeric',month:'short'});
        const fechaHoy = new Date().toLocaleDateString('es-PE', {day:'numeric',month:'short'});
        const msg = '*[FinBot] Resumen semanal*' +
          '\n_Semana del ' + fechaDesde + ' al ' + fechaHoy + '_\n\n' +
          resumen +
          '\n*Top gastos:* ' + topStr +
          '\n\n_Escribe /mes para el detalle completo._';
        await enviarWhatsapp(usuario.whatsapp, msg);
        console.log('[SEMANAL] Resumen enviado a', usuario.whatsapp);
      } catch(e) {
        console.error('[SEMANAL] Error para', usuario.whatsapp, ':', e.message);
      }
    }
  } catch(e) {
    console.error('[SEMANAL] Error general:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
const INTERVALO_HORAS = parseFloat(process.env.SCAN_INTERVAL_HOURS || '4');
const INTERVALO_MS = INTERVALO_HORAS * 60 * 60 * 1000;

app.listen(PORT, () => {
  console.log('FinBot Peru v4 en http://localhost:' + PORT);
  console.log('Auth callback: http://localhost:' + PORT + '/auth/callback');

  // Primer escaneo a los 30 segundos del arranque (para no sobrecargar en reinicios)
  setTimeout(() => {
    escaneoAutomatico();
    // Luego cada X horas
    setInterval(escaneoAutomatico, INTERVALO_MS);
    console.log('[AUTO] Escaneo automatico activo cada', INTERVALO_HORAS, 'hora(s).');

    // Verificar resumen semanal cada 15 minutos
    setInterval(checkResumenSemanal, 15 * 60 * 1000);
    console.log('[SEMANAL] Resumen semanal automatico activo (lunes 8am Lima).');
  }, 30000);
});