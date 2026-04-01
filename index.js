require('dotenv').config();
const { validateConfig } = require('./lib/config');
validateConfig();
const express = require('express');
// OpenAI y Supabase ahora en lib/ai.js y lib/db.js
const { generarReporteHTML, generarDashboardHTML, generarReporteJSON } = require('./reporte_html');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { rateLimit } = require('express-rate-limit');
const log = require('./lib/logger');
const { hoyPeru, ahoraPeru, primeroDeMesPeru } = require('./lib/dates');
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP, MESES, CATEGORIAS_SUGERIDAS, FREEMIUM_ACTIVE, PLAN_CONFIG } = require('./lib/constants');
const { validarMonto, normalizarCategoria } = require('./lib/validators');
const { formatFecha, barraProgreso, getEmojiCategoria, formatearResumen, formatearPendientes, formatearCategoriasMsg, parsearIndicesRespuesta, generarRefCode } = require('./lib/formatters');
const { enviarWhatsapp } = require('./lib/whatsapp');
const { obtenerTipoCambio, guardarTransaccion, obtenerGastosMes, obtenerGastosSemana, obtenerUltimaTransaccion, recategorizarTransaccion, recategorizarPorId, corregirTransaccionEspecifica, guardarReglaComercio, buscarReglaComercio, retroaplicarRegla, guardarConsultaPendiente, obtenerConsultasPendientes, resolverConsulta, necesitaConsulta, mensajeConsulta } = require('./services/transactions');
const { guardarPresupuesto, obtenerPresupuestosMes, verificarAlertaPresupuesto, formatearEstadoPresupuesto } = require('./services/budget');
const { parsearCorreoBancario, parsearRegistroManual, parsearCorreccionesMultiples, interpretarComandoPresupuesto } = require('./services/parsers');
const { notificarErrorAdmin } = require('./lib/admin-notify');
const { registrarError, limpiarContadores } = require('./lib/error-monitor');
const { generarUrlAutorizacion, guardarTokens, leerCorreosBancarios, oauth2Client, obtenerPerfilGoogle, obtenerCuentasGmail } = require('./gmail');
const { runBackup } = require('./scripts/backup');
const { generarRecomendaciones, construirDatosUsuario, generarMiniRecomendacion, verificarAlertasProactivas } = require('./services/recommendations');
const { registrarDeuda, obtenerDeudas, abonarDeuda, marcarDeudaPagada, formatearResumenDeudas, obtenerDeudasProximasVencer, consolidarDeudasPorContraparte, saldarTodasDeudas } = require('./services/debts');
const { obtenerMetas: obtenerMetasService, abonarMeta: abonarMetaService, calcularRitmoAhorro, registrarLogro, obtenerLogros, verificarRachaAportes } = require('./services/metas');
// Modularized helpers and services
const { guardarMensaje, obtenerHistorial, obtenerOCrearUsuario, getUserPlanConfig, getHistoryDateLimit } = require('./helpers/db-helpers');
const { intentarResolverConsulta } = require('./helpers/consultas');
const { obtenerCategoriasUsuario, crearCategoriasDesdeIndices, detectarCategoriaIA, sugerirEmojiConIA, crearCategoriaLibreUsuario, crearSubcategoriaLibreUsuario } = require('./services/categories');
const { registrarReferido, verificarProReferidos } = require('./services/referrals');
const { redactarConNETO } = require('./services/neto-gpt');
const { escanearGmailYRegistrar, escaneoAutomatico } = require('./services/gmail-scanner');
const { generarYEnviarReporte } = require('./services/reports');
const { enviarAlertaTransaccion } = require('./services/notifications');
const { generarResumenSemanal, generarResumenMensual } = require('./services/summaries');

// Helper: último día real del mes (evita fechas inválidas como 02-31)
function ultimoDiaMes(anio, mes) {
  return new Date(anio, mes, 0).getDate();
}

// fechaHoyPeru y fechaAyerPeru ahora en lib/dates.js, alias para retrocompatibilidad
function fechaHoyPeru() { return hoyPeru(); }
function fechaAyerPeru() { const { ayerPeru } = require('./lib/dates'); return ayerPeru(); }

const cors = require('cors');
const helmet = require('helmet');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Reportes HTML usan scripts inline
  crossOriginEmbedderPolicy: false
}));

// CORS: solo permitir requests desde dominios de Neto
app.use(cors({
  origin: ['https://app.neto.pe', 'https://neto.pe', 'https://neto-app.vercel.app'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.urlencoded({ extended: false }));
// Capturar raw body para validación HMAC del webhook de Meta
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// Rate limiting: 300 req/min global, 30 req/min por número WhatsApp
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false, default: true },
  message: { error: 'Demasiadas solicitudes, intenta en un momento' },
  keyGenerator: (req) => {
    try {
      const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) return from;
    } catch {}
    return req.ip || '0.0.0.0';
  },
});
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes admin' },
});

const { openai } = require('./lib/ai');
const { supabase } = require('./lib/db');

// -- Historial de conversacion --
// guardarMensaje, obtenerHistorial, obtenerOCrearUsuario → helpers/db-helpers.js
// getUserPlanConfig, getHistoryDateLimit → helpers/db-helpers.js

// escanearGmailYRegistrar → services/gmail-scanner.js

// generarYEnviarReporte → services/reports.js

// intentarResolverConsulta → helpers/consultas.js

// obtenerCategoriasUsuario, crearCategoriasDesdeIndices, detectarCategoriaIA, sugerirEmojiConIA, crearCategoriaLibreUsuario, crearSubcategoriaLibreUsuario → services/categories.js
// registrarReferido, verificarProReferidos → services/referrals.js

// === RUTAS API ===
// ============================================================
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'NETO', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    log.info({ tag: 'WEBHOOK' }, 'Verificado por Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', webhookLimiter, async (req, res) => {
  // Validar firma HMAC de Meta (X-Hub-Signature-256)
  const META_APP_SECRET = process.env.META_APP_SECRET;
  if (!META_APP_SECRET) {
    log.error({ tag: 'WEBHOOK' }, 'META_APP_SECRET no configurado — rechazando request');
    return res.sendStatus(500);
  }
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    log.warn({ tag: 'WEBHOOK' }, 'Request sin X-Hub-Signature-256');
    return res.sendStatus(403);
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    log.warn({ tag: 'WEBHOOK' }, 'Firma HMAC invalida');
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  try {
    const entry = req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const messages = value && value.messages;
    if (!messages || messages.length === 0) return;
    const message = messages[0];
    const from = message.from;

    // --- Manejo de imágenes ---
    if (message.type === 'image') {
      const usuario = await obtenerOCrearUsuario(from);

      // Si está en paso 2 (esperando comprobante de pago), tratar como recibo
      if (usuario.onboarding_paso === 2) {
        const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
        await enviarWhatsapp(ADMIN_NUMBER,
          '💸 *Comprobante de pago recibido:*\n' +
          'Usuario: ' + (usuario.nombre || from) + '\n' +
          'WhatsApp: ' + from + '\n' +
          'Plan solicitado: ' + (usuario.tipo_plan || 'mensual') + '\n\n' +
          'Verificar y enviar: /pago ' + from + ' ' + (usuario.tipo_plan || 'mensual')
        );
        await enviarWhatsapp(from,
          '📸 *Comprobante recibido.*\n\nEstamos verificando tu pago. Te confirmaremos en breve. ⏳'
        );
        return;
      }

      const mediaId = message.image && message.image.id;
      const phoneId = process.env.META_PHONE_NUMBER_ID;
      const metaToken = process.env.META_ACCESS_TOKEN;
      log.info({ tag: 'IMAGEN', mediaId, phoneId, tokenOk: !!metaToken }, 'Procesando imagen');
      if (!mediaId) { await enviarWhatsapp(from, 'No pude recibir la imagen. Intenta de nuevo.'); return; }
      try {
        // 1. Obtener URL de la imagen desde Meta API
        const metaUrl = 'https://graph.facebook.com/v19.0/' + mediaId + '?phone_number_id=' + phoneId;
        const metaRes = await fetch(metaUrl, {
          headers: { Authorization: 'Bearer ' + metaToken }
        });
        const metaJson = await metaRes.json();
        log.debug({ tag: 'IMAGEN', metaJson: JSON.stringify(metaJson).slice(0, 200) }, 'Meta response');
        if (!metaJson.url) throw new Error('Meta no devolvió URL: ' + JSON.stringify(metaJson).slice(0, 100));

        // 2. Descargar imagen como base64
        const imgRes = await fetch(metaJson.url, {
          headers: { Authorization: 'Bearer ' + metaToken }
        });
        if (!imgRes.ok) throw new Error('Error descargando imagen: ' + imgRes.status);
        const imgBuffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(imgBuffer).toString('base64');
        const mimeType = metaJson.mime_type || message.image.mime_type || 'image/jpeg';
        log.info({ tag: 'IMAGEN', mimeType, size: imgBuffer.byteLength }, 'Imagen descargada');

        // 3. Parsear con GPT-4o vision
        const hoy = hoyPeru();
        const visionRes = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Esta imagen es una captura de pantalla de una transacción financiera (Yape, Plin, banco peruano). Puede ser un GASTO (pago enviado) o un INGRESO (dinero recibido). Extrae los datos y devuelve SOLO JSON válido, sin texto extra:\n{"tipo":"gasto"|"ingreso","monto":numero,"moneda":"PEN","comercio":"nombre del destinatario (si gasto) o remitente (si ingreso)","categoria":"Alimentación|Transporte|Vivienda|Salud|Entretenimiento|Compras|Educación|Finanzas|Trabajo_Negocio|Otros","subcategoria":"descripcion breve o null","metodo_pago":"Yape|Plin|BCP|BBVA|Interbank|Scotiabank|Falabella|Ripley|BanBif|Efectivo|null","fecha":"YYYY-MM-DD","descripcion_original":"texto clave de la imagen","motivo":"nota/motivo del pago si aparece o null"}\n\nREGLAS PARA DETECTAR TIPO:\n- GASTO: "¡Yapeaste!", "Pago exitoso", "Enviado a", "Realizaste un yapeo/plin", monto enviado\n- INGRESO: "¡Te yapearon!", "Recibiste", "Yapeo recibido", "Plin recibido", "Enviado por" (alguien te envió dinero)\n- Para ingresos: categoria="Finanzas", subcategoria=null, comercio=nombre de quien envía\n\nMÉTODO DE PAGO (metodo_pago):\n- Si la pantalla es de Yape (verde, logo Yape, "¡Yapeaste!" o "¡Te yapearon!") → metodo_pago="Yape"\n- Si la pantalla es de Plin (morado/azul, logo Plin, "¡Pago exitoso!") → metodo_pago="Plin"\n- Si es notificación de BCP, BBVA, Interbank, Scotiabank u otro banco → metodo_pago=nombre del banco\n- Si no se puede determinar → metodo_pago=null\n\nMOTIVO Y CATEGORIZACIÓN:\n- El campo "motivo" es la nota/mensaje que el usuario escribe al enviar el pago (ej: "pollo a la brasa", "almuerzo", "cumpleaños")\n- Si hay motivo, USALO para determinar la categoría y subcategoría (ej: motivo "pollo a la brasa" → Alimentación > Restaurantes)\n- Si el nombre del destinatario/comercio sugiere una categoría, úsalo también (ej: "Polleria Rokys" → Alimentación > Restaurantes, "Farmacia" → Salud)\n- El motivo tiene PRIORIDAD sobre el nombre del comercio para categorizar\n- subcategoria debe ser una descripción breve en español, o null si no aplica. NUNCA escribas la palabra "null" como texto.\n\nFORMATOS DE APPS:\n- Yape: pantalla verde con "¡Yapeaste!" (gasto) o "¡Te yapearon!" (ingreso), monto grande, nombre del destinatario/remitente, campo "Motivo" o "Nota" debajo\n- Plin: pantalla con "¡Pago exitoso!" y monto en verde, datos de "Enviado a" (gasto) o "Recibido de" (ingreso), código de operación, campo "Mensaje"\n- Bancos (BCP, BBVA, Interbank, etc.): notificación de consumo/depósito\n\nSi la imagen NO muestra ningún pago o transacción, devuelve: {"tipo":"no_pago"}\nFecha de hoy si no se ve en la imagen: ' + hoy },
              { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64, detail: 'high' } }
            ]
          }],
          temperature: 0, max_tokens: 400
        });
        const rawV = visionRes.choices[0].message.content.trim();
        log.debug({ tag: 'IMAGEN', response: rawV.slice(0, 200) }, 'GPT vision response');

        // Parsear JSON de la respuesta
        let parsed;
        try {
          const start = rawV.indexOf('{'); const end = rawV.lastIndexOf('}');
          parsed = JSON.parse(start >= 0 ? rawV.slice(start, end + 1) : rawV);
        } catch(pe) { throw new Error('GPT no devolvió JSON válido: ' + rawV.slice(0, 100)); }

        if (parsed.tipo === 'no_pago') {
          await enviarWhatsapp(from, 'No reconocí ninguna transacción en esa imagen. Envíame la captura de Yape, Plin o tu banco (la pantalla que muestra el monto y destinatario).');
          return;
        }
        if (!parsed.monto || isNaN(parseFloat(parsed.monto))) {
          throw new Error('No se detectó monto en la imagen');
        }
        parsed.fecha = parsed.fecha || hoy;
        await guardarTransaccion(usuario.id, parsed);
        const montoStr = parsed.moneda === 'USD' ? '$' + parseFloat(parsed.monto).toFixed(2) : 'S/ ' + parseFloat(parsed.monto).toFixed(2);
        const esIngreso = parsed.tipo === 'ingreso';
        const emoji = esIngreso ? '💵' : (getEmojiCategoria(parsed.categoria) || '📋');
        const tipoLabel = esIngreso ? 'Ingreso registrado' : 'Gasto registrado';
        await enviarWhatsapp(from, '📸 *' + tipoLabel + '*\n\n' + emoji + ' *' + (parsed.comercio || (esIngreso ? 'Ingreso' : 'Pago')) + '* — ' + montoStr + '\n' + parsed.categoria + (parsed.subcategoria && parsed.subcategoria !== 'sin_categoria' ? ' > ' + parsed.subcategoria : '') + ' · ' + parsed.fecha);
      } catch(e) {
        log.error({ tag: 'IMAGEN', err: e.message }, 'Error procesando imagen'); registrarError('IMAGEN', e.message, { stack: e.stack, whatsapp: from });
        await enviarWhatsapp(from, 'No pude procesar la imagen. Asegúrate de enviar la captura de la notificación de pago (la pantalla que muestra el monto y destinatario).');
      }
      return;
    }

    // --- Manejo de documentos (Excel para carga de gastos históricos) ---
    if (message.type === 'document') {
      const usuario = await obtenerOCrearUsuario(from);

      const doc = message.document;
      const fileName = (doc && doc.filename) || '';
      const docMime = (doc && doc.mime_type) || '';

      const esCSV = fileName.endsWith('.csv') || docMime.includes('csv') || docMime.includes('text/plain');
      const esExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || docMime.includes('spreadsheet') || docMime.includes('excel') || docMime.includes('officedocument');
      if (!esCSV && !esExcel) {
        await enviarWhatsapp(from, '📄 Acepto archivos Excel (.xlsx) o CSV (.csv).\n\nDescarga la plantilla en: neto.pe/plantilla_gastos.xlsx\nO envía tu estado de cuenta bancario en CSV.');
        return;
      }

      const mediaId = doc && doc.id;
      if (!mediaId) { await enviarWhatsapp(from, 'No pude recibir el archivo. Intenta de nuevo.'); return; }

      try {
        await enviarWhatsapp(from, '📊 Procesando tu archivo de gastos... ⏳');

        // 1. Descargar desde Meta API (mismo patrón que imágenes)
        const metaToken = process.env.META_ACCESS_TOKEN;
        const phoneId = process.env.META_PHONE_NUMBER_ID;
        const metaUrl = 'https://graph.facebook.com/v19.0/' + mediaId + '?phone_number_id=' + phoneId;
        const metaRes = await fetch(metaUrl, { headers: { Authorization: 'Bearer ' + metaToken } });
        const metaJson = await metaRes.json();
        if (!metaJson.url) throw new Error('Meta no devolvió URL del documento');

        const fileRes = await fetch(metaJson.url, { headers: { Authorization: 'Bearer ' + metaToken } });
        if (!fileRes.ok) throw new Error('Error descargando archivo: ' + fileRes.status);
        const fileBuffer = Buffer.from(await fileRes.arrayBuffer());
        log.info({ tag: 'EXCEL', size: fileBuffer.byteLength }, 'Archivo descargado');

        // 2. Parsear archivo (CSV o Excel)
        const rows = [];
        if (esCSV) {
          // --- Parsing CSV (estados de cuenta bancarios) ---
          const csvText = fileBuffer.toString('utf-8');
          const lines = csvText.split(/\r?\n/).filter(l => l.trim());
          if (lines.length < 2) throw new Error('El archivo CSV está vacío.');

          // Detectar separador (coma, punto y coma, tab)
          const firstLine = lines[0];
          const sep = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
          const headers = firstLine.split(sep).map(h => h.replace(/"/g, '').trim().toLowerCase());

          // Auto-detectar columnas por nombre de header
          const iDate = headers.findIndex(h => h.includes('fecha') || h === 'date' || h.includes('fec'));
          const iAmount = headers.findIndex(h => h.includes('monto') || h.includes('importe') || h.includes('cargo') || h.includes('amount') || h === 'debito');
          const iDesc = headers.findIndex(h => h.includes('descripci') || h.includes('concepto') || h.includes('detalle') || h.includes('comercio') || h.includes('description') || h.includes('movimiento'));
          const iCredit = headers.findIndex(h => h.includes('abono') || h.includes('credito') || h.includes('credit') || h.includes('deposito'));

          if (iDate < 0 || (iAmount < 0 && iDesc < 0)) throw new Error('No pude detectar las columnas del CSV. Necesito al menos Fecha y Monto/Descripción.');

          for (let li = 1; li < lines.length; li++) {
            const cols = lines[li].split(sep).map(c => c.replace(/"/g, '').trim());
            if (!cols[iDate]) continue;

            // Normalizar fecha
            let fechaStr = cols[iDate];
            const parts = fechaStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
            if (parts) {
              const anio = parts[3].length === 2 ? '20' + parts[3] : parts[3];
              fechaStr = anio + '-' + parts[2].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
            }

            // Monto: cargo (gasto) vs abono (ingreso)
            let monto = 0, tipo = 'gasto';
            if (iAmount >= 0) {
              monto = parseFloat((cols[iAmount] || '0').replace(/[,\s]/g, ''));
            }
            if (iCredit >= 0 && cols[iCredit] && parseFloat(cols[iCredit].replace(/[,\s]/g, '')) > 0) {
              monto = parseFloat(cols[iCredit].replace(/[,\s]/g, ''));
              tipo = 'ingreso';
            }
            if (isNaN(monto) || monto <= 0) continue;

            const comercio = iDesc >= 0 ? (cols[iDesc] || 'Sin descripción').substring(0, 100) : 'Sin descripción';
            rows.push({ fecha: fechaStr, monto, comercio, tipo, categoria: null, subcategoria: null, metodo_pago: null, banco: null });
          }
        } else {
        // --- Parsing Excel ---
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(fileBuffer);
        const sheet = workbook.getWorksheet(1);
        if (!sheet) throw new Error('El archivo no tiene hojas de cálculo');

        // 3. Detectar header row y formato de columnas (auto-detect)
        let headerRow = null;
        let colFormat = 'legacy6'; // legacy6 | tipo7 | full8
        sheet.eachRow((row, rowNumber) => {
          const vals = row.values.slice(1); // exceljs es 1-indexed
          const firstVal = String(vals[0] || '').toLowerCase();
          if (firstVal.includes('fecha') || firstVal.includes('date')) {
            headerRow = rowNumber;
            // Detectar formato por headers
            const headers = vals.map(v => String(v || '').toLowerCase());
            const hasSubcatCol = headers.some(h => h.includes('subcategor'));
            const hasTipoCol = headers.some(h => h === 'tipo' || h === 'type');
            if (hasSubcatCol) colFormat = 'full8';
            else if (hasTipoCol) colFormat = 'tipo7';
            else colFormat = 'legacy6';
            return;
          }
          if (headerRow && rowNumber > headerRow) {
            const fecha = vals[0];
            const monto = parseFloat(vals[1]);
            const comercio = String(vals[2] || '').trim();
            let tipo, categoria, subcategoria, metodo, banco;
            if (colFormat === 'full8') {
              // 8 cols: Fecha, Monto, Comercio, Tipo, Categoría, Subcategoría, Método, Banco
              const tipoRaw = String(vals[3] || '').trim().toLowerCase();
              tipo = tipoRaw.includes('ingreso') ? 'ingreso' : 'gasto';
              categoria = String(vals[4] || '').trim();
              subcategoria = String(vals[5] || '').trim() || null;
              metodo = String(vals[6] || '').trim();
              banco = String(vals[7] || '').trim();
            } else if (colFormat === 'tipo7') {
              // 7 cols: Fecha, Monto, Comercio, Tipo, Categoría, Método, Banco
              const tipoRaw = String(vals[3] || '').trim().toLowerCase();
              tipo = tipoRaw.includes('ingreso') ? 'ingreso' : 'gasto';
              categoria = String(vals[4] || '').trim();
              subcategoria = null;
              metodo = String(vals[5] || '').trim();
              banco = String(vals[6] || '').trim();
            } else {
              // 6 cols legacy: Fecha, Monto, Comercio, Categoría, Método, Banco
              tipo = 'gasto';
              categoria = String(vals[3] || '').trim();
              subcategoria = null;
              metodo = String(vals[4] || '').trim();
              banco = String(vals[5] || '').trim();
            }

            if (!fecha || isNaN(monto) || monto <= 0 || !comercio) return; // Skip filas inválidas

            // Normalizar fecha
            let fechaStr;
            if (fecha instanceof Date) {
              fechaStr = fecha.toISOString().split('T')[0];
            } else {
              fechaStr = String(fecha).trim();
              const parts = fechaStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
              if (parts) fechaStr = parts[3] + '-' + parts[2].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
            }

            rows.push({ fecha: fechaStr, monto, comercio, tipo, categoria, subcategoria, metodo_pago: metodo || null, banco: banco || null });
          }
        });
        } // fin else (Excel)

        if (rows.length === 0) throw new Error('No encontré datos válidos en el archivo. Asegúrate de usar la plantilla correcta o enviar tu estado de cuenta CSV.');
        if (rows.length > 500) throw new Error('Máximo 500 transacciones por archivo. Tu archivo tiene ' + rows.length + '.');

        // 4. Auto-categorizar filas sin categoría o sin subcategoría usando GPT-4o-mini
        const sinCategoria = rows.filter(r => !r.categoria || !r.subcategoria);
        if (sinCategoria.length > 0) {
          const batchSize = 50;
          for (let i = 0; i < sinCategoria.length; i += batchSize) {
            const batch = sinCategoria.slice(i, i + batchSize);
            const prompt = 'Categoriza cada movimiento. Categorías válidas: Alimentación, Transporte, Vivienda, Salud, Entretenimiento, Compras, Educación, Finanzas, Trabajo_Negocio, Otros.\nSubcategorías por categoría: Alimentación(delivery,restaurante,supermercado,mercado,cafeteria,snacks), Transporte(uber_cabify,taxi,bus_micro,metro_bus,gasolina,peaje,estacionamiento), Vivienda(alquiler,mantenimiento,electricidad,agua,gas,internet,cable), Salud(farmacia,medico,clinica,laboratorio,seguro_salud,optica), Entretenimiento(streaming,cine,juegos,bares_clubs,eventos,hobbies), Compras(ropa,calzado,electronico,hogar,belleza,mascotas), Educación(universidad,instituto,curso_online,utiles,idiomas,colegios), Finanzas(prestamo,tarjeta_credito,seguro,ahorro,inversion,comision_banco), Trabajo_Negocio(herramientas,publicidad,oficina,logistica,contador), Otros(regalo,donacion,multa,viaje,sin_categoria).\nDevuelve SOLO un JSON array: [{"index":0,"categoria":"...","subcategoria":"..."},...].\nMovimientos:\n' +
              batch.map((r, idx) => idx + '. ' + r.comercio + ' S/' + r.monto + (r.categoria ? ' [cat:' + r.categoria + ']' : '')).join('\n');

            try {
              const catRes = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0
              });
              const raw = catRes.choices[0].message.content.trim();
              const start = raw.indexOf('['); const end = raw.lastIndexOf(']');
              if (start >= 0 && end >= 0) {
                const cats = JSON.parse(raw.slice(start, end + 1));
                cats.forEach(c => {
                  if (batch[c.index]) {
                    if (!batch[c.index].categoria) batch[c.index].categoria = c.categoria;
                    if (!batch[c.index].subcategoria) batch[c.index].subcategoria = c.subcategoria;
                  }
                });
              }
            } catch(catErr) {
              log.error({ tag: 'EXCEL', err: catErr.message }, 'Error categorizando batch');
            }
          }
        }

        // 5. Insertar transacciones
        let insertados = 0, errores = 0;
        for (const row of rows) {
          try {
            await guardarTransaccion(usuario.id, {
              tipo: row.tipo || 'gasto',
              monto: row.monto,
              moneda: 'PEN',
              comercio: row.comercio,
              categoria: row.categoria || 'Otros',
              subcategoria: row.subcategoria || 'sin_categoria',
              metodo_pago: row.metodo_pago,
              banco: row.banco,
              fecha: row.fecha,
              descripcion_original: 'Excel: ' + row.comercio
            });
            insertados++;
          } catch(insErr) {
            errores++;
            log.error({ tag: 'EXCEL', err: insErr.message }, 'Error insertando fila');
          }
        }

        // 6. Resumen
        const gastos = rows.filter(r => r.tipo === 'gasto');
        const ingresos = rows.filter(r => r.tipo === 'ingreso');
        const totalGastos = gastos.reduce((s, r) => s + r.monto, 0);
        const totalIngresos = ingresos.reduce((s, r) => s + r.monto, 0);
        let resumenMsg = '✅ *Carga completada*\n\n' +
          '📊 ' + insertados + ' movimientos registrados\n';
        if (gastos.length > 0) resumenMsg += '💸 Gastos: ' + gastos.length + ' — S/ ' + totalGastos.toFixed(2) + '\n';
        if (ingresos.length > 0) resumenMsg += '💰 Ingresos: ' + ingresos.length + ' — S/ ' + totalIngresos.toFixed(2) + '\n';
        if (errores > 0) resumenMsg += '⚠️ ' + errores + ' filas con error\n';
        resumenMsg += '\n_Escribe "mis gastos" para ver tu resumen actualizado._';
        await enviarWhatsapp(from, resumenMsg);
        log.info({ tag: 'EXCEL', insertados, errores }, 'Carga Excel completada');
      } catch(e) {
        log.error({ tag: 'EXCEL', err: e.message }, 'Error procesando Excel'); registrarError('EXCEL', e.message, { stack: e.stack, whatsapp: from });
        await enviarWhatsapp(from, '❌ Error procesando el archivo: ' + e.message + '\n\nDescarga la plantilla correcta en: neto.pe/plantilla_gastos.xlsx');
      }
      return;
    }

    if (message.type !== 'text') return;
    const msg = (message.text.body || '').trim();
    log.info({ tag: 'MSG', from, msg: msg.substring(0, 100) }, 'Mensaje recibido');

    let respuesta = '';
    const usuario = await obtenerOCrearUsuario(from);
    const cmd = msg.toLowerCase().trim();

    // Detectar referido: nuevo usuario llegó vía link /r/:code
    const refMatch = msg.match(/^hola\s+neto\s+ref:([A-Z0-9]{4,12})/i);
    if (refMatch) {
      const refCode = refMatch[1].toUpperCase();
      const { data: referrer } = await supabase.from('usuarios').select('id').eq('ref_code', refCode).neq('id', usuario.id).single();
      if (referrer) {
        registrarReferido(referrer.id, usuario.id);
        verificarProReferidos(referrer.id);
      }
    }

    // Flujo desconectar cuenta (paso -1)
    if (usuario.onboarding_paso === -1 && !cmd.startsWith('/')) {
      const respDesc = parseInt(cmd.trim());
      const cuentasActivas = await obtenerCuentasGmail(usuario.id);
      const numCuentas = cuentasActivas.length;

      if (numCuentas > 1) {
        // Multi-cuenta: 1..N = desconectar individual, N+1 = todas, N+2 = eliminar todo
        if (respDesc >= 1 && respDesc <= numCuentas) {
          const cuentaTarget = cuentasActivas[respDesc - 1];
          await supabase.from('gmail_cuentas').update({ activa: false }).eq('id', cuentaTarget.id);
          await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
          await enviarWhatsapp(from, '✅ *' + cuentaTarget.email + ' desconectado*\n\nTus otras cuentas siguen activas. Tu historial se mantiene intacto.');
          return;
        } else if (respDesc === numCuentas + 1) {
          await supabase.from('gmail_cuentas').update({ activa: false }).eq('usuario_id', usuario.id);
          await supabase.from('usuarios').update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null, onboarding_paso: 0 }).eq('id', usuario.id);
          await enviarWhatsapp(from, '✅ *Todas las cuentas Gmail desconectadas*\n\nTu historial de gastos se mantiene intacto. Puedes volver a conectar escribiendo _"conectar gmail"_.');
          return;
        } else if (respDesc === numCuentas + 2) {
          await supabase.from('transacciones').delete().eq('usuario_id', usuario.id);
          await supabase.from('categorias_usuario').delete().eq('usuario_id', usuario.id);
          await supabase.from('presupuestos').delete().eq('usuario_id', usuario.id);
          await supabase.from('gmail_cuentas').delete().eq('usuario_id', usuario.id);

          await supabase.from('consultas_pendientes').delete().eq('usuario_id', usuario.id);
          await supabase.from('usuarios').update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null, email: null, onboarding_paso: 0, onboarding_completado: false }).eq('id', usuario.id);
          await enviarWhatsapp(from, '🗑️ *Cuenta limpia*\n\nTodos tus datos han sido eliminados. Si quieres volver, escribe _"hola"_ y empezamos de cero.');
          return;
        }
      } else if (numCuentas === 1) {
        if (respDesc === 1) {
          await supabase.from('gmail_cuentas').update({ activa: false }).eq('usuario_id', usuario.id);
          await supabase.from('usuarios').update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null, onboarding_paso: 0 }).eq('id', usuario.id);
          await enviarWhatsapp(from, '✅ *Gmail desconectado*\n\nTu historial de gastos se mantiene intacto. Puedes volver a conectar cuando quieras escribiendo _"conectar gmail"_.');
          return;
        } else if (respDesc === 2) {
          await supabase.from('transacciones').delete().eq('usuario_id', usuario.id);
          await supabase.from('categorias_usuario').delete().eq('usuario_id', usuario.id);
          await supabase.from('presupuestos').delete().eq('usuario_id', usuario.id);
          await supabase.from('gmail_cuentas').delete().eq('usuario_id', usuario.id);

          await supabase.from('consultas_pendientes').delete().eq('usuario_id', usuario.id);
          await supabase.from('usuarios').update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null, email: null, onboarding_paso: 0, onboarding_completado: false }).eq('id', usuario.id);
          await enviarWhatsapp(from, '🗑️ *Cuenta limpia*\n\nTodos tus datos han sido eliminados. Si quieres volver, escribe _"hola"_ y empezamos de cero.');
          return;
        }
      } else {
        // Sin cuentas Gmail, solo opción de eliminar datos
        if (respDesc === 1) {
          await supabase.from('transacciones').delete().eq('usuario_id', usuario.id);
          await supabase.from('categorias_usuario').delete().eq('usuario_id', usuario.id);
          await supabase.from('presupuestos').delete().eq('usuario_id', usuario.id);

          await supabase.from('consultas_pendientes').delete().eq('usuario_id', usuario.id);
          await supabase.from('usuarios').update({ email: null, onboarding_paso: 0, onboarding_completado: false }).eq('id', usuario.id);
          await enviarWhatsapp(from, '🗑️ *Datos eliminados*\n\nSi quieres volver, escribe _"hola"_.');
          return;
        }
      }
      // Respuesta no válida → cancelar
      await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
      await enviarWhatsapp(from, 'Cancelado. Tu cuenta sigue igual. 👍');
      return;
    }

    // Paso 100: Recoger nombre del usuario
    if (usuario.onboarding_paso === 100 && !cmd.startsWith('/')) {
      // Extraer nombre inteligentemente: "Mi nombre es Annie" → "Annie", "Soy Juan Carlos" → "Juan Carlos"
      let nombreInput = msg.trim();
      const nombreMatch = nombreInput.match(/(?:me llamo|mi nombre es|soy|es)\s+(.+)/i);
      if (nombreMatch) nombreInput = nombreMatch[1].trim();
      // Limpiar posibles puntos, comas al final
      nombreInput = nombreInput.replace(/[.,!]+$/, '').trim();
      if (nombreInput.length < 2 || nombreInput.length > 50 || /^\d+$/.test(nombreInput)) {
        respuesta = 'Dime tu nombre real. Ej: _"María"_ o _"Juan Carlos"_.';
        await enviarWhatsapp(from, respuesta);
        return;
      }
      const nombreLimpio = nombreInput.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      await supabase.from('usuarios').update({ nombre: nombreLimpio, onboarding_paso: 101 }).eq('id', usuario.id);
      respuesta = '¡Mucho gusto, *' + nombreLimpio + '*! 🤝\n\n¿Cuál es tu correo electrónico?\n\n_Lo usaremos solo para contactarte si necesitas soporte._';
      await enviarWhatsapp(from, respuesta);
      return;
    }

    // Paso 101: Recoger email del usuario
    if (usuario.onboarding_paso === 101 && !cmd.startsWith('/')) {
      // Extraer email inteligentemente: "Mi correo es juan@gmail.com" → "juan@gmail.com"
      const emailRegex = /[^\s@]+@[^\s@]+\.[^\s@]+/;
      const emailMatch = msg.trim().toLowerCase().match(emailRegex);
      const emailInput = emailMatch ? emailMatch[0].replace(/[.,;:!?]+$/, '') : '';
      if (!emailInput || !emailRegex.test(emailInput)) {
        respuesta = 'Eso no parece un correo válido. Escribe tu email, ej: _"juan@gmail.com"_.';
        await enviarWhatsapp(from, respuesta);
        return;
      }
      await supabase.from('usuarios').update({ email: emailInput, onboarding_paso: 1 }).eq('id', usuario.id);
      const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
      respuesta = '📧 ¡Perfecto' + (primerNombre ? ', ' + primerNombre : '') + '!\n\nAhora, elige tu plan:\n\n' +
        '📊 *¿Qué hace Neto?*\n' +
        '• Te dice en qué gastas tu plata por WhatsApp\n' +
        '• Dashboard con gráficos, metas y reportes\n' +
        '• Funciona con BCP, BBVA, Interbank, Yape, Plin y más\n\n' +
        '🆓 *Plan Free* — S/0\n' +
        '• Registra gastos manual o por foto\n' +
        '• Presupuestos y metas ilimitados\n' +
        '• Dashboard del mes actual\n\n' +
        '⭐ *Plan Pro* — S/10/mes\n' +
        '• Lectura automática de correos bancarios\n' +
        '• Historial completo + reportes PDF\n' +
        '• Resumen diario + consejos IA\n\n' +
        'Escribe *free* para empezar gratis o *pro* para activar Pro.';
      await enviarWhatsapp(from, respuesta);
      return;
    }

    // Paso 1: Usuario confirma interés → enviar datos de pago
    if (usuario.onboarding_paso === 1 && !cmd.startsWith('/')) {
      const resp1 = cmd.trim().toLowerCase();
      if (resp1 === 'free' || resp1 === 'gratis' || resp1 === 'manual') {
        await supabase.from('usuarios').update({
          plan: 'free',
          onboarding_paso: 0,
          onboarding_completado: true
        }).eq('id', usuario.id);
        respuesta = '🆓 *¡Bienvenido a Neto Free!*\n\n' +
          'Registra gastos así:\n\n' +
          '📝 _"gasté 50 en taxi"_\n' +
          '📸 Envía una foto de Yape o Plin\n\n' +
          '📊 Configura tus presupuestos en tu dashboard:\nhttps://app.neto.pe/dashboard/presupuestos\n\n' +
          '¿Por dónde empezamos?';
        await enviarWhatsapp(from, respuesta);
        return;
      }
      if (resp1 === 'pro' || resp1 === 'si' || resp1 === 'sí' || resp1 === 'yes' || resp1 === 'dale' || resp1 === 'va' || resp1 === 'quiero') {
        await supabase.from('usuarios').update({ onboarding_paso: 2 }).eq('id', usuario.id);
        respuesta = '🎉 *¡Genial!*\n\n' +
          'Elige tu plan:\n\n' +
          '1️⃣ *Mensual* — S/10/mes\n' +
          '2️⃣ *Anual* — S/99/año (2 meses gratis)\n\n' +
          '📲 *Yapea al:* 970398192\n' +
          '👤 *A nombre de:* Favio Mendoza\n\n' +
          'Después envíame la captura del Yape aquí. 📸';
        await enviarWhatsapp(from, respuesta);
        return;
      }
      if (resp1 === 'no' || resp1 === 'no gracias') {
        await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
        respuesta = '👍 Sin problema. Si cambias de opinión, escribe *hola* cuando quieras.';
        await enviarWhatsapp(from, respuesta);
        return;
      }
      respuesta = 'Escribe *free* para empezar gratis o *pro* para activar el plan Pro.';
      await enviarWhatsapp(from, respuesta);
      return;
    }

    // Paso 2: Esperando selección de plan o comprobante de pago
    if (usuario.onboarding_paso === 2 && !cmd.startsWith('/')) {
      if (cmd === '1' || cmd.trim().toLowerCase() === 'mensual') {
        await supabase.from('usuarios').update({ tipo_plan: 'mensual' }).eq('id', usuario.id);
        respuesta = '✅ Plan *mensual* (S/10/mes).\n\n📲 Yapea S/10 al *970398192* (Favio Mendoza) y envíame la captura aquí. 📸';
        await enviarWhatsapp(from, respuesta);
        return;
      } else if (cmd === '2' || cmd.trim().toLowerCase() === 'anual') {
        await supabase.from('usuarios').update({ tipo_plan: 'anual' }).eq('id', usuario.id);
        respuesta = '✅ Plan *anual* (S/99/año — 2 meses gratis).\n\n📲 Yapea S/99 al *970398192* (Favio Mendoza) y envíame la captura aquí. 📸';
        await enviarWhatsapp(from, respuesta);
        return;
      }
      respuesta = 'Elige tu plan:\n\n1️⃣ *Mensual* — S/10\n2️⃣ *Anual* — S/99\n\nO envíame la captura de tu Yape si ya pagaste. 📸';
      await enviarWhatsapp(from, respuesta);
      return;
    }

    // Paso 3: Pago confirmado, esperando Gmail
    // Paso 3 eliminado — OAuth link se envía directamente con /pago

    if (usuario.onboarding_paso === 10 && !cmd.startsWith('/')) {
      var idxResp = parsearIndicesRespuesta(msg, CATEGORIAS_SUGERIDAS.length);
      if (idxResp.length > 0) {
        await crearCategoriasDesdeIndices(usuario.id, idxResp);
        var nombresAct = idxResp.map(function(i){ return CATEGORIAS_SUGERIDAS[i-1].emoji+' '+CATEGORIAS_SUGERIDAS[i-1].nombre; }).join(', ');
        var rspCat = '\uD83C\uDF89 *Categorias activadas:*\n' + nombresAct + '\n\nCada una tiene subcategorias sugeridas.\n\n*\u00bfQuieres configurar un presupuesto mensual?* \uD83D\uDCB0\n\nEj: _"limite de 500 soles en Comida"_\n\nO escribe *listo* para empezar con NETO.';
        await supabase.from('usuarios').update({ onboarding_paso: 20, onboarding_completado: true }).eq('id', usuario.id);
        await enviarWhatsapp(from, rspCat); return;
      }
    }

    if (usuario.onboarding_paso === 20 && !cmd.startsWith('/')) {
      var cmdLower20 = cmd.trim().toLowerCase();
      if (cmdLower20 === 'listo' || cmdLower20 === 'no' || cmdLower20 === 'omitir' || cmdLower20 === 'saltar') {
        await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
        var primerNombre20 = usuario.nombre ? usuario.nombre.split(' ')[0] : '';
        respuesta = (primerNombre20 ? 'Listo, ' + primerNombre20 + '.' : 'Listo.') + ' Ya estoy trabajando por ti.\n\nEscribeme como quieras:\n_"cuanto gaste esta semana"_\n_"como va mi delivery"_\n_"dame mi reporte"_\n\n\u00bfPor donde empezamos?';
        await enviarWhatsapp(from, respuesta); return;
      }
      try {
        var interpPres20 = await interpretarComandoPresupuesto(msg);
        if (interpPres20.es_presupuesto && interpPres20.categoria && interpPres20.monto) {
          await guardarPresupuesto(usuario.id, interpPres20.categoria, interpPres20.monto);
          respuesta = '\u2705 Presupuesto de *' + interpPres20.categoria + '*: *S/ ' + parseFloat(interpPres20.monto).toFixed(2) + '/mes*\n\n\u00bfAlguna otra categoria? O escribe *listo* para terminar.';
          await enviarWhatsapp(from, respuesta); return;
        }
      } catch(e) {}
    }

    // Consultas pendientes: solo resolver si el usuario responde a una (no forzar)
    // NO interceptar si el mensaje es una corrección explícita de categoría — el clasificador lo maneja mejor
    const esCorreccionExplicita = /\bes\s+categor[ií]a\b/i.test(msg) || /\bcambia(r|lo)?\s+(a|la)\s+categor[ií]a\b/i.test(msg) || /\bmuev[elo]+\s+(a|en)\b/i.test(msg) || /\bponl[oa]\s+en\b/i.test(msg) || /\bcorrig[eé]\b/i.test(msg) || /\brecategoriz/i.test(msg);
    // NO interceptar si el mensaje claramente es una intención diferente (deudas, presupuestos, metas, etc.)
    const esIntencionDirecta = /\b(me debe[s]?|le debo|debo\s+\S|le prest[eé]|me prest[oó]|mis deudas|ya pagu[eé]|me pag[oó]|abonar?\s+deuda)\b/i.test(msg)
      || /\b(presupuesto|meta de ahorro|suscripci[oó]n|reporte|resumen|elimina|borra|quita)\b/i.test(msg);
    if (!cmd.startsWith('/') && cmd !== 'hola' && cmd !== 'hi' && cmd !== 'inicio' && !esCorreccionExplicita && !esIntencionDirecta) {
      var pendInter = await obtenerConsultasPendientes(usuario.id);
      if (pendInter.length > 0) {
        var resC = await intentarResolverConsulta(usuario, msg);
        if (resC) { await enviarWhatsapp(from, resC); return; }
      }
    }

    const esUsuarioNuevo = !usuario.gmail_access_token && !usuario.onboarding_completado;
    if (cmd === 'hola' || cmd === 'hi' || cmd === 'inicio') {
      var tieneGmail = !!usuario.gmail_access_token;
      var primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
      if (!tieneGmail && !usuario.onboarding_completado) {
        if (!usuario.nombre) {
          // First ask for name
          await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', usuario.id);
          respuesta = '👋 ¡Hola! Soy *NETO*, tu asistente financiero por WhatsApp.\n\n' +
            'Antes de empezar, ¿cómo te llamas?';
        } else {
          // Already has name, go to Free/Pro selection
          await supabase.from('usuarios').update({ onboarding_paso: 1 }).eq('id', usuario.id);
          respuesta = '👋 Hola, ' + usuario.nombre.split(' ')[0] + '. Soy *NETO*, tu asistente financiero.\n\n' +
            '📊 *¿Qué hace Neto?*\n' +
            '• Te dice en qué gastas tu plata por WhatsApp\n' +
            '• Dashboard con gráficos, metas y reportes\n' +
            '• Funciona con BCP, BBVA, Interbank, Yape, Plin y más\n\n' +
            '🆓 *Plan Free* — S/0\n' +
            '• Registra gastos manual o por foto\n' +
            '• Presupuestos y metas ilimitados\n' +
            '• Dashboard del mes actual\n\n' +
            '⭐ *Plan Pro* — S/10/mes\n' +
            '• Lectura automática de correos bancarios\n' +
            '• Historial completo + reportes PDF\n' +
            '• Resumen diario + consejos IA\n\n' +
            'Escribe *free* para empezar gratis o *pro* para activar Pro.';
        }
      } else if (!tieneGmail && usuario.onboarding_completado) {
        // Usuario en modo manual — saludo normal
        var gastosMesHola = await obtenerGastosMes(usuario.id);
        var totalMesHola = gastosMesHola.reduce(function(s,t){return s+parseFloat(t.monto_pen||t.monto);},0);
        respuesta = '👋 Hola' + (primerNombre ? ', ' + primerNombre : '') + '.\n\n' +
          (gastosMesHola.length > 0 ? 'Este mes llevas *S/ ' + totalMesHola.toFixed(2) + '* en ' + gastosMesHola.length + ' movimientos.' : 'Sin movimientos este mes aun.') +
          '\n\n📝 Registra gastos así:\n_"gasté 50 en taxi"_\n_"almuerzo 25 soles"_\nO envía una foto de tu Yape/Plin.\n\n📊 *Tu dashboard:* https://app.neto.pe\n💡 _Escribe /conectar para lectura automática de correos._';
      } else {
        var gastosMesHola = await obtenerGastosMes(usuario.id);
        var totalMesHola = gastosMesHola.reduce(function(s,t){return s+parseFloat(t.monto_pen||t.monto);},0);
        var pendHola = await obtenerConsultasPendientes(usuario.id);
        var alertaPend = pendHola.length > 0 ? '\n\n\u2757 *' + pendHola.length + ' gasto(s) sin identificar.* Escribe */pendientes*.' : '';
        var catsHola = await obtenerCategoriasUsuario(usuario.id);
        var tipCats = (!usuario.onboarding_completado && !catsHola) ? '\n\n\uD83D\uDCA1 Escribe */categorias* para personalizar tus categorias.' : '';
        var saludo = primerNombre ? 'Hola, ' + primerNombre + '!' : 'Hola!';
        respuesta = '\uD83D\uDC4B Hola' + (primerNombre ? ', ' + primerNombre : '') + '. Soy NETO.\n\n' +
          (gastosMesHola.length > 0 ? 'Este mes llevas *S/ ' + totalMesHola.toFixed(2) + '* en ' + gastosMesHola.length + ' movimientos.' : 'Sin movimientos este mes aun.') +
          (pendHola.length > 0 ? '\n\n\u2757 ' + pendHola.length + ' gasto(s) sin identificar. Escribe */pendientes*.' : '') +
          '\n\n📊 Revisa tu dashboard en *https://app.neto.pe*\n\n\u00bfQue revisamos?';
      }
    } else if (cmd === '/manual') {
      // Onboarding sin Gmail — modo free
      await supabase.from('usuarios').update({ plan: 'free', onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
      respuesta = '✍️ *Modo Free activado*\n\nRegistra gastos así:\n📝 _"gasté 50 en taxi"_\n📸 Envía una foto de Yape o Plin\n\n📊 Configura tus presupuestos en tu dashboard:\nhttps://app.neto.pe/dashboard/presupuestos\n\n¿Por dónde empezamos?';
    } else if (esUsuarioNuevo && !cmd.startsWith('/')) {
      await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', usuario.id);
      respuesta = '👋 ¡Hola! Soy *NETO*, tu asistente financiero.\n\nPara empezar, ¿cómo te llamas?';
    } else if (cmd === '/silenciar') {
      await supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id);
      respuesta = '🔇 Recordatorios desactivados. Escribe */recordar* para reactivarlos.';
    } else if (cmd === '/recordar') {
      await supabase.from('usuarios').update({ recordatorios_activos: true }).eq('id', usuario.id);
      respuesta = '🔔 Recordatorios activados. Te avisaré a las 8pm si no registras gastos.';
    } else if (cmd === '/conectar') {
      if (usuario.plan !== 'premium') {
        respuesta = '⭐ *Conectar Gmail es una función Pro.*\n\n' +
          'Con Pro, Neto lee tus correos bancarios automáticamente.\n\n' +
          '💰 S/10/mes o S/99/año\n' +
          '📲 Yapea al 970398192 y escríbeme aquí para activar.';
      } else if (usuario.gmail_access_token) {
        respuesta = '📧 Ya tienes Gmail conectado.\n\nSi necesitas cambiar tu cuenta, escríbenos por WhatsApp al 970398192.';
      } else {
        respuesta = 'Para conectar tu Gmail, abre este enlace:\n\n' + generarUrlAutorizacion(from) + '\n\n_Solo leemos notificaciones bancarias. Sin contrasenas bancarias._';
      }
    } else if (cmd === '/escanear') {
      const resultado = await escanearGmailYRegistrar(usuario);
      respuesta = resultado || (!usuario.gmail_access_token ? 'No tienes Gmail conectado. Escribe */conectar*.' : 'No encontre correos bancarios nuevos.');
    } else if (cmd === '/semana' || cmd === '/resumen') {
      const resumenSem = await generarResumenSemanal(usuario);
      respuesta = resumenSem || 'No hay gastos registrados esta semana.';
    } else if (cmd === '/mes') {
      respuesta = formatearResumen(await obtenerGastosMes(usuario.id), 'este mes');
    } else if (cmd === '/presupuesto') {
      respuesta = await formatearEstadoPresupuesto(usuario.id);
    } else if (cmd.startsWith('/presupuesto ')) {
      const partes = msg.trim().split(' ');
      if (partes.length >= 3) {
        const categoria = partes[1]; const monto = parseFloat(partes[2]);
        if (isNaN(monto) || monto <= 0) { respuesta = 'Monto invalido. Ej: /presupuesto Comida 500'; }
        else { await guardarPresupuesto(usuario.id, categoria, monto); respuesta = '*Presupuesto guardado*\n' + categoria + ': S/ ' + monto.toFixed(2) + '/mes'; }
      } else { respuesta = 'Formato: /presupuesto [categoria] [monto]'; }
    } else if (cmd.startsWith('/cambiar ')) {
      const partes = msg.trim().split(' ');
      if (partes.length >= 3) {
        const comercioInput = partes[1], categoriaInput = partes.slice(2).join(' ');
        // Acepta categoría conocida o libre (capitalizada)
        const catKnown = CATEGORIAS_SUGERIDAS.map(c=>c.nombre).find(c => c.toLowerCase() === categoriaInput.toLowerCase());
        const catFinal = catKnown || (categoriaInput.charAt(0).toUpperCase() + categoriaInput.slice(1));
        const resultado = await recategorizarTransaccion(usuario.id, comercioInput, catFinal);
        respuesta = resultado.msg;
      } else { respuesta = 'Formato: /cambiar [comercio] [categoria]\nEj: /cambiar Netflix Streaming'; }
    } else if (cmd === '/reporte' || cmd.startsWith('/reporte ')) {
      const ahoraR = new Date(), partesR = cmd.split(' ');
      const mesR = partesR[1] ? parseInt(partesR[1]) : (ahoraR.getMonth() + 1);
      const anioR = partesR[2] ? parseInt(partesR[2]) : ahoraR.getFullYear();
      if (mesR < 1 || mesR > 12 || isNaN(mesR)) { respuesta = 'Formato: /reporte [mes] [anio]\nEj: /reporte 3 2026'; }
      else {
        respuesta = '📊 *Tu reporte de ' + MESES[mesR] + ' ' + anioR + '*\n\n' +
          'Descarga tu PDF y ve tus gráficos en tu dashboard:\n\n' +
          '🔗 https://app.neto.pe/dashboard/reportes\n\n' +
          '_Inicia sesión con Google para ver tus datos._';
      }
    } else if (cmd === '/premium') {
      const tipoPlanActual = usuario.tipo_plan || 'mensual';
      const vence = usuario.fecha_vencimiento ? new Date(usuario.fecha_vencimiento).toLocaleDateString('es-PE') : null;
      respuesta = '\u2B50 *Tu plan NETO Pro*\n\n' +
        'Plan: *' + (tipoPlanActual === 'anual' ? 'Anual (S/99/año)' : 'Mensual (S/10/mes)') + '*\n' +
        (vence ? 'Vence: ' + vence + '\n' : '') +
        '\n\u2705 Reportes PDF ilimitados\n\u2705 Lectura automática de correos\n\u2705 Dashboard con gráficos y metas\n\u2705 Consejos IA personalizados\n\n' +
        '_¿Dudas? Escribe al +51970398192_';
    } else if (cmd === '/referir' || cmd === '/referidos' || cmd === '/invitar' ||
      /\b(quiero referir|referir a|mis referidos|mi link de referido|link de referido|invitar amigos|invitar a un amigo|compartir neto|recomendar neto|c[oó]digo de referido|programa de referidos|como refiero|cómo refiero|ganar pro gratis|referir amigos|quiero invitar)\b/i.test(cmd)) {
      let refCode = usuario.ref_code;
      if (!refCode) {
        refCode = generarRefCode();
        await supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id);
        usuario.ref_code = refCode;
      }
      const { data: misRefs } = await supabase.from('referidos').select('activo').eq('referrer_id', usuario.id);
      const totalRefs = (misRefs || []).length;
      const activos = (misRefs || []).filter(r => r.activo).length;
      const railwayUrl = process.env.RAILWAY_URL || 'https://api.neto.pe';
      const mesesAcumulados = Math.floor(activos / 3);
      const progreso = activos % 3;
      let estadoRef = '_Referidos: ' + totalRefs + ' | Activos: ' + activos + '_';
      if (mesesAcumulados > 0) {
        estadoRef += '\n✅ *' + (mesesAcumulados === 1 ? '1 mes' : mesesAcumulados + ' meses') + ' gratis ganado' + (mesesAcumulados > 1 ? 's' : '') + '*';
        if (progreso > 0) estadoRef += ' | ' + progreso + '/3 para el siguiente';
      } else {
        estadoRef += ' | ' + progreso + '/3 para tu primer mes gratis';
      }
      respuesta = '🎁 *Tu link de referido:*\n\n' + railwayUrl + '/r/' + refCode + '\n\nComparte con amigos. Cada *3 referidos* te dan *1 mes gratis* de Neto. 🎉\n\n' + estadoRef;
    } else if (cmd === '/dashboard' || cmd === '/app') {
      respuesta = '📊 *Tu dashboard está en:*\n\n🔗 https://app.neto.pe\n\nAhí puedes ver gráficos, metas, reportes PDF, suscripciones y más.\n\n_Inicia sesión con tu cuenta de Google._';
    } else if (cmd.startsWith('/activar ')) {
      // Comando admin: /activar <numero_whatsapp> - solo Favio puede usarlo
      const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
      if (from !== ADMIN_NUMBER) {
        respuesta = 'No tienes permiso para usar este comando.';
      } else {
        const numeroActivar = cmd.replace('/activar ', '').trim().replace(/\+/g, '');
        const { data: usuarioActivar } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroActivar).single();
        if (!usuarioActivar) {
          respuesta = '\u274C No encontre un usuario con el numero: ' + numeroActivar;
        } else if (usuarioActivar.plan === 'premium') {
          respuesta = '\u26A0\uFE0F ' + (usuarioActivar.nombre || numeroActivar) + ' ya tiene Premium activo.';
        } else {
          const hoy = new Date();
          const vence = new Date(hoy.getFullYear(), hoy.getMonth() + 1, hoy.getDate()).toISOString().split('T')[0];
          await supabase.from('usuarios').update({
            plan: 'premium',
            pago_pendiente: false,
            premium_desde: hoy.toISOString().split('T')[0],
            premium_vence: vence
          }).eq('id', usuarioActivar.id);
          // Notificar al usuario
          await enviarWhatsapp(usuarioActivar.whatsapp,
            '\u2B50 *\u00a1Bienvenido a NETO Pro!*\n\n' +
            'Tu pago fue confirmado. Ya tienes acceso completo.\n\n' +
            'Registra gastos así:\n' +
            '📝 _"gasté 50 en taxi"_\n' +
            '📸 Envía una foto de Yape o Plin\n\n' +
            '📊 Configura tus presupuestos en tu dashboard:\nhttps://app.neto.pe/dashboard/presupuestos\n\n' +
            '¿Por dónde empezamos?'
          );
          respuesta = '\u2705 Premium activado para ' + (usuarioActivar.nombre || numeroActivar) + '\nVence: ' + vence;
        }
      }
    } else if (cmd.startsWith('/pago ')) {
      const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
      if (from !== ADMIN_NUMBER) {
        respuesta = 'No tienes permiso para usar este comando.';
      } else {
        const partes = cmd.replace('/pago ', '').trim().split(/\s+/);
        const numeroPago = (partes[0] || '').replace(/\+/g, '');
        const tipoPlan = partes[1] || 'mensual';
        const { data: usuarioPago } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroPago).single();
        if (!usuarioPago) {
          respuesta = '❌ No encontré un usuario con el número: ' + numeroPago;
        } else {
          const hoy = new Date();
          const mesesAdd = tipoPlan === 'anual' ? 12 : 1;
          const vence = new Date(hoy.getFullYear(), hoy.getMonth() + mesesAdd, hoy.getDate());
          await supabase.from('usuarios').update({
            plan: 'premium',
            estado_pago: 'pagado',
            tipo_plan: tipoPlan,
            fecha_pago: hoy.toISOString(),
            fecha_vencimiento: vence.toISOString(),
            premium_desde: hoy.toISOString().split('T')[0],
            premium_vence: vence.toISOString().split('T')[0],
            pago_pendiente: false,
            onboarding_paso: 0
          }).eq('id', usuarioPago.id);
          const urlOAuth = generarUrlAutorizacion(usuarioPago.whatsapp);
          await enviarWhatsapp(usuarioPago.whatsapp,
            '✅ *¡Pago confirmado!*\n\n' +
            'Plan: *' + (tipoPlan === 'anual' ? 'Anual (S/99/año)' : 'Mensual (S/10/mes)') + '*\n' +
            'Vence: ' + vence.toISOString().split('T')[0] + '\n\n' +
            'Conecta tu Gmail para que Neto lea tus correos bancarios automáticamente:\n\n' +
            '🔗 ' + urlOAuth + '\n\n' +
            '_Solo leemos notificaciones bancarias. Sin contraseñas bancarias._'
          );
          respuesta = '✅ Pago confirmado para ' + (usuarioPago.nombre || numeroPago) + ' (' + tipoPlan + '). Link OAuth enviado.';
        }
      }
    } else if (cmd === '/usuarios' || cmd === '/admin') {
      // Panel admin rapido
      const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
      if (from !== ADMIN_NUMBER) {
        respuesta = 'No tienes permiso para usar este comando.';
      } else {
        const { data: todos } = await supabase.from('usuarios').select('whatsapp, nombre, plan, pago_pendiente, estado_pago, created_at').order('created_at', { ascending: false }).limit(20);
        if (!todos || todos.length === 0) { respuesta = 'No hay usuarios registrados.'; }
        else {
          const premium = todos.filter(u => u.plan === 'premium').length;
          const pendientes = todos.filter(u => u.pago_pendiente).length;
          let msg = '*Panel NETO*\n---------------\n';
          msg += 'Total: ' + todos.length + ' usuarios\n';
          msg += 'Premium: ' + premium + ' | Free: ' + (todos.length - premium) + '\n';
          if (pendientes > 0) msg += '\u26A0\uFE0F Pagos pendientes: ' + pendientes + '\n';
          msg += '\n*Ultimos usuarios:*\n';
          todos.slice(0, 10).forEach(u => {
            const plan = u.plan === 'premium' ? '\u2B50' : '\uD83D\uDFE2';
            const pend = u.pago_pendiente ? ' \uD83D\uDCB8' : '';
            const estado = u.estado_pago === 'pagado' ? '' : (u.estado_pago === 'pendiente' ? ' \u23F3' : '');
            msg += plan + ' ' + (u.nombre || u.whatsapp) + pend + estado + '\n';
          });
          msg += '\n_Comandos:_\n/pago <num> <mensual|anual>\n/activar <num>';
          respuesta = msg;
        }
      }
    } else if (cmd === '/categorias' || cmd === '/categorias agregar') {
      var catsCmd = await obtenerCategoriasUsuario(usuario.id);
      if (cmd === '/categorias agregar' || !catsCmd) {
        var menuCatsStr = CATEGORIAS_SUGERIDAS.map(function(c,i){ return (i+1)+'. '+c.emoji+' '+c.nombre; }).join('\n');
        respuesta = '*Personaliza tus categorias*\n\nResponde con los numeros:\n\n' + menuCatsStr + '\n\n_Ej: 1 3 5 o "todas"_';
        await supabase.from('usuarios').update({ onboarding_paso: 10 }).eq('id', usuario.id);
      } else { respuesta = formatearCategoriasMsg(catsCmd); }
    } else if (cmd.startsWith('/responder ')) {
      // Admin responde a un ticket de soporte: /responder 51933XXXXXX mensaje
      const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
      if (from !== ADMIN_NUMBER) {
        respuesta = 'No tienes permiso para usar este comando.';
      } else {
        const partes = msg.substring('/responder '.length).trim();
        const spaceIdx = partes.indexOf(' ');
        if (spaceIdx === -1) {
          respuesta = 'Formato: /responder <número> <mensaje>\nEj: /responder 51933014505 Hola, ya revisé tu caso...';
        } else {
          const numDestino = partes.substring(0, spaceIdx).replace(/\+/g, '');
          const msgAdmin = partes.substring(spaceIdx + 1).trim();
          if (!msgAdmin) {
            respuesta = 'Escribe el mensaje. Ej: /responder ' + numDestino + ' Ya revisé tu caso...';
          } else {
            try {
              // Enviar respuesta al usuario como NETO
              await enviarWhatsapp(numDestino, '👤 *Respuesta del equipo Neto:*\n\n' + msgAdmin + '\n\n_Si necesitas más ayuda, cuéntanos o escríbenos a hola@neto.pe_');
              // Actualizar ticket
              const { data: ticketAdmin } = await supabase.from('tickets_soporte').select('*')
                .eq('whatsapp', numDestino).in('estado', ['pendiente', 'esperando_mensaje'])
                .order('created_at', { ascending: false }).limit(1);
              if (ticketAdmin && ticketAdmin.length > 0) {
                await supabase.from('tickets_soporte').update({
                  mensaje_admin: msgAdmin.substring(0, 1000),
                  estado: 'respondido',
                  updated_at: new Date().toISOString()
                }).eq('id', ticketAdmin[0].id);
              }
              respuesta = '✅ Respuesta enviada a ' + numDestino + '.';
            } catch(e) {
              log.error({ tag: 'RESPONDER', err: e.message }, 'Error enviando respuesta admin');
              respuesta = '❌ Error enviando la respuesta: ' + e.message;
            }
          }
        }
      }
    } else if (cmd.startsWith('/tickets')) {
      // Admin ve tickets pendientes: /tickets
      const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
      if (from !== ADMIN_NUMBER) {
        respuesta = 'No tienes permiso para usar este comando.';
      } else {
        const { data: ticketsList } = await supabase.from('tickets_soporte').select('*')
          .in('estado', ['pendiente', 'esperando_mensaje'])
          .order('created_at', { ascending: false }).limit(10);
        if (!ticketsList || ticketsList.length === 0) {
          respuesta = '📭 No hay tickets pendientes. ¡Todo tranquilo!';
        } else {
          let msgTickets = '🎫 *Tickets pendientes (' + ticketsList.length + '):*\n\n';
          ticketsList.forEach((t, i) => {
            msgTickets += (i + 1) + '. ' + (t.nombre_usuario || 'Sin nombre') + ' (' + t.whatsapp + ')\n';
            msgTickets += '   📋 ' + t.estado + ' | ' + new Date(t.created_at).toLocaleDateString('es-PE') + '\n';
            if (t.mensaje_usuario) msgTickets += '   💬 ' + t.mensaje_usuario.substring(0, 80) + '\n';
            msgTickets += '\n';
          });
          msgTickets += '_Responde con:_\n/responder <número> <mensaje>';
          respuesta = msgTickets;
        }
      }
    } else if (cmd === '/pendientes') {
      var lpend = await obtenerConsultasPendientes(usuario.id);
      respuesta = lpend.length === 0 ? 'No tienes gastos pendientes.' : formatearPendientes(lpend);
    } else if (cmd === '/ayuda') {
      const mesActual = new Date().getMonth() + 1;
      respuesta = '*Comandos NETO:*\n*/semana* -- gastos 7 dias\n*/mes* -- gastos del mes\n*/presupuesto* -- ver/configurar presupuesto\n*/categorias* -- categorias\n*/conectar* -- vincular Gmail\n*/escanear* -- leer correos ahora\n*/cambiar [comercio] [cat]* -- corregir categoria\n*/reporte* -- PDF del mes\n*/reporte ' + mesActual + '* -- PDF mes especifico\n*/pendientes* -- gastos sin identificar\n*/dashboard* -- ir a tu app (https://app.neto.pe)\n*/referir* -- invitar amigos y ganar Pro\n*/premium* -- plan premium\n*hola* -- estado general\n\n_Tambien puedes escribirme en lenguaje natural!_';
    } else {
      respuesta = await procesarMensajeLibre(msg, usuario, from);
    }
    if (respuesta) {
      await enviarWhatsapp(from, respuesta);
      // Guardar respuesta de NETO en historial
      try { await guardarMensaje(usuario.id, 'neto', respuesta); } catch(e) {}
    }
  } catch (error) { log.error({ tag: 'WEBHOOK', err: error.message }, 'Error en webhook'); notificarErrorAdmin('WEBHOOK', error.message); registrarError('WEBHOOK', error.message, { stack: error.stack, whatsapp: from }); }
});

app.get('/reporte/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const { data: entry, error } = await supabase
      .from('reporte_cache').select('html, expires_at').eq('id', id).single();
    if (error || !entry) {
      return res.status(404).send('<h2>Reporte no encontrado o expirado.</h2><p>El link es valido por 1 hora. Genera uno nuevo con /reporte</p>');
    }
    if (new Date(entry.expires_at) < new Date()) {
      await supabase.from('reporte_cache').delete().eq('id', id);
      return res.status(404).send('<h2>El link del reporte expiro.</h2><p>Genera uno nuevo escribiendo /reporte</p>');
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(entry.html);
  } catch(e) {
    log.error({ tag: 'REPORTE', err: e.message }, 'Error leyendo cache');
    res.status(500).send('<h2>Error cargando el reporte. Intenta de nuevo.</h2>');
  }
});
// Ruta de referido: redirige a WhatsApp con el ref_code pre-cargado
app.get('/r/:code', async (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const { data: referrer } = await supabase.from('usuarios').select('id').eq('ref_code', code).single();
  const waNum = process.env.WA_PHONE_NUMBER || '51933014505';
  const waText = encodeURIComponent('Hola NETO ref:' + code);
  if (!referrer) return res.redirect('https://wa.me/' + waNum);
  res.redirect('https://wa.me/' + waNum + '?text=' + waText);
});

// Dashboard: muestra gráficos de gastos de los últimos 3 meses
app.get('/dashboard/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const { data: entry, error } = await supabase.from('reporte_cache').select('html, expires_at').eq('id', id).single();
    if (error || !entry) return res.status(404).send('<h2>Dashboard no encontrado.</h2><p>Genera uno nuevo con /dashboard</p>');
    if (new Date(entry.expires_at) < new Date()) {
      await supabase.from('reporte_cache').delete().eq('id', id);
      return res.status(410).send('<h2>El link expiró.</h2><p>Genera uno nuevo escribiendo */dashboard* en WhatsApp.</p>');
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(entry.html);
  } catch(e) {
    log.error({ tag: 'DASHBOARD', err: e.message }, 'Error generando dashboard');
    res.status(500).send('<h2>Error cargando el dashboard.</h2>');
  }
});

// === API JSON para dashboard interactivo ===
app.get('/api/reporte/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const { data: entry, error } = await supabase
      .from('reporte_cache').select('html, expires_at').eq('id', id).single();
    if (error || !entry) return res.status(404).json({ error: 'Reporte no encontrado o expirado.' });
    if (new Date(entry.expires_at) < new Date()) {
      await supabase.from('reporte_cache').delete().eq('id', id);
      return res.status(410).json({ error: 'El link del reporte expiro. Genera uno nuevo con /reporte' });
    }
    // El campo html almacena JSON stringificado para dashboards interactivos
    try {
      const jsonData = JSON.parse(entry.html);
      res.json(jsonData);
    } catch {
      // Fallback: es HTML legacy, no JSON
      res.status(400).json({ error: 'Este reporte usa el formato anterior. Genera uno nuevo con /reporte' });
    }
  } catch(e) {
    log.error({ tag: 'API_REPORTE', err: e.message }, 'Error API reporte');
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/reporte/:id/mes/:mes/:anio', async (req, res) => {
  const { id, mes, anio } = req.params;
  const mesNum = parseInt(mes);
  const anioNum = parseInt(anio);
  if (!mesNum || mesNum < 1 || mesNum > 12 || !anioNum) {
    return res.status(400).json({ error: 'Mes o anio invalido' });
  }
  try {
    // Verificar que el reporte original existe y obtener usuario_id
    const { data: entry } = await supabase
      .from('reporte_cache').select('usuario_id, expires_at').eq('id', id).single();
    if (!entry) return res.status(404).json({ error: 'Reporte no encontrado' });
    if (new Date(entry.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Sesion expirada. Genera un nuevo reporte.' });
    }
    const usuarioId = entry.usuario_id;
    const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', usuarioId).single();
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Obtener transacciones del mes solicitado
    const desde = anioNum + '-' + String(mesNum).padStart(2,'0') + '-01';
    const hasta = anioNum + '-' + String(mesNum).padStart(2,'0') + '-' + String(ultimoDiaMes(anioNum, mesNum)).padStart(2,'0');
    const { data: txs } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
    if (!txs || txs.length === 0) return res.json({ error: 'Sin transacciones para ese mes', empty: true });

    // Presupuestos
    const { data: presupData } = await supabase.from('presupuestos').select('*').eq('usuario_id', usuarioId).eq('mes', mesNum).eq('anio', anioNum);
    const presupuestos = {};
    if (presupData) presupData.forEach(p => { presupuestos[p.categoria] = parseFloat(p.monto_limite); });

    // Historial
    const historial = [];
    for (let i = 3; i >= 1; i--) {
      const d = new Date(anioNum, mesNum - 1 - i, 1); const hm = d.getMonth()+1; const ha = d.getFullYear();
      const { data: ht } = await supabase.from('transacciones').select('monto,monto_pen,tipo').eq('usuario_id', usuarioId).gte('fecha', ha+'-'+String(hm).padStart(2,'0')+'-01').lte('fecha', ha+'-'+String(hm).padStart(2,'0')+'-'+String(ultimoDiaMes(ha,hm)).padStart(2,'0'));
      const gastos = (ht||[]).filter(t => t.tipo === 'gasto');
      const ingr = (ht||[]).filter(t => t.tipo === 'ingreso');
      const totG = gastos.reduce((s,t) => s+parseFloat(t.monto_pen||t.monto||0), 0);
      const totI = ingr.reduce((s,t) => s+parseFloat(t.monto_pen||t.monto||0), 0);
      if (totG > 0 || totI > 0) historial.push({ mes: hm, anio: ha, total: totG, totalIngresos: totI });
    }

    // Obtener TODOS los meses con transacciones del usuario para el selector
    const { data: allMonths } = await supabase.from('transacciones').select('fecha').eq('usuario_id', usuarioId);
    const todosMeses = [];
    if (allMonths) {
      const mSet = new Set();
      allMonths.forEach(t => { const p = (t.fecha||'').split('-'); if (p.length>=2) mSet.add(p[0]+'-'+p[1]); });
      mSet.forEach(s => { const [a,m] = s.split('-').map(Number); todosMeses.push({ mes: m, anio: a }); });
    }
    const jsonData = generarReporteJSON({ nombre: usuario.nombre || 'Usuario', mes: mesNum, anio: anioNum, transacciones: txs, presupuestos, historialMeses: historial, todosMeses });
    res.json(jsonData);
  } catch(e) {
    log.error({ tag: 'API_REPORTE_MES', err: e.message }, 'Error API reporte mensual');
    res.status(500).json({ error: 'Error interno' });
  }
});

// Redirigir dashboard interactivo a la landing (neto.pe)
app.get('/mi-reporte/:id', (req, res) => {
  res.redirect(301, `https://neto.pe/mi-reporte/${req.params.id}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send('<h2>Error: ' + error + '</h2>');
  if (!code) return res.send('<h2>No se recibio el codigo</h2>');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // Decodificar state: puede ser JSON {num, modo} o string legacy
    let whatsappNum = null; let modoConexion = 'inicial';
    if (req.query.state) {
      try {
        const decoded = Buffer.from(req.query.state, 'base64').toString('utf8');
        if (decoded.startsWith('{')) {
          const stateObj = JSON.parse(decoded);
          whatsappNum = stateObj.num; modoConexion = stateObj.modo || 'inicial';
        } else { whatsappNum = decoded; }
      } catch(e) { log.warn({ tag: 'OAUTH', err: e.message }, 'Error decodificando state OAuth'); }
    }
    let usuario = null;
    if (whatsappNum) { const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', whatsappNum).single(); usuario = data; }
    if (!usuario) { const { data } = await supabase.from('usuarios').select('*').is('gmail_access_token', null).order('created_at', { ascending: false }).limit(1).single(); usuario = data; }
    if (!usuario) return res.send('<h2>No se encontro el usuario. Escribe /conectar en WhatsApp.</h2>');

    const perfil = await obtenerPerfilGoogle(oauth2Client);
    const emailConectado = perfil.email;
    await guardarTokens(usuario.id, tokens, emailConectado, modoConexion);
    if (perfil.nombre || emailConectado) {
      const updateUser = { nombre: usuario.nombre || perfil.nombre };
      // Solo actualizar email en usuarios si es la primera conexión (no tiene email aún)
      if (!usuario.email && emailConectado) updateUser.email = emailConectado;
      await supabase.from('usuarios').update(updateUser).eq('id', usuario.id);
      usuario.nombre = usuario.nombre || perfil.nombre;
    }

    const nombre = usuario.nombre ? ', ' + usuario.nombre : '';
    const emailMsg = emailConectado ? ' (' + emailConectado + ')' : '';
    res.send('<html><body style="font-family:Arial;text-align:center;padding:50px;background:#0d1b2a;color:white"><h1 style="color:#4CAF50">Gmail conectado' + nombre + '!</h1><p style="font-size:18px">' + emailMsg + '</p><p>Vuelve a WhatsApp, el bot te escribira en un momento.</p></body></html>');
    const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : 'por ahi';

    setTimeout(async () => {
      try {
        if (modoConexion === 'agregar') {
          // Cuenta adicional agregada
          const cuentasNow = await obtenerCuentasGmail(usuario.id);
          await enviarWhatsapp(usuario.whatsapp, '✅ *Cuenta Gmail adicional conectada!*\n📧 ' + emailConectado + '\n\nAhora tienes ' + cuentasNow.length + ' cuentas. ¿Cómo quieres ver tus reportes?\n\n1️⃣ *Unificado* — todo junto\n2️⃣ *Separado* — una sección por cuenta\n\n_Responde 1 o 2._');
          await supabase.from('usuarios').update({ onboarding_paso: 0 }).eq('id', usuario.id);
          return;
        }
        if (modoConexion === 'reemplazar') {
          await enviarWhatsapp(usuario.whatsapp, '🔄 *Cuenta Gmail actualizada, ' + primerNombre + '!*\n📧 ' + emailConectado + '\n\nEscaneando tus correos... 🔍');
        } else {
          await enviarWhatsapp(usuario.whatsapp, '✅ *Gmail conectado, ' + primerNombre + '!*\n📧 ' + emailConectado + '\n\nEscaneando tus correos bancarios... 🔍');
        }
        const resultado = await escanearGmailYRegistrar(usuario);
        if (resultado) {
          await enviarWhatsapp(usuario.whatsapp, resultado);
        }
        if (modoConexion === 'inicial') {
          await supabase.from('usuarios').update({ onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
          await new Promise(r => setTimeout(r, 1500));
          await enviarWhatsapp(usuario.whatsapp,
            '🎉 *¡Listo, ' + primerNombre + '!* Tu cuenta está activa.\n\n' +
            '📊 *Tu dashboard:* https://app.neto.pe\n' +
            'Ahí puedes ver gráficos, metas, reportes PDF y más.\n\n' +
            'Por WhatsApp escríbeme como quieras:\n' +
            '_"cuánto gasté esta semana"_\n' +
            '_"dame mi reporte"_\n\n' +
            'Te aviso cada vez que detecte un gasto nuevo. 🔔'
          );
        }
      } catch(e) { log.error({ tag: 'CALLBACK', err: e.message }, 'Error OAuth callback'); }
    }, 2000);
  } catch (err) { res.send('<h2>Error: ' + err.message + '</h2>'); }
});

app.post('/test-parser', adminLimiter, async (req, res) => {
  const { correo, clave } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (!ADMIN_KEY || !clave || !crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(ADMIN_KEY))) return res.status(401).json({ error: 'No autorizado' });
  if (!correo) return res.status(400).json({ error: 'Falta correo' });
  try { const r = await parsearCorreoBancario(correo); res.json({ ok: true, resultado: r }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (req, res) => res.send('NETO v5'));

// Endpoint admin: activar premium via web
// POST /admin/activar { whatsapp: "51970398192", clave: "ADMIN_KEY" }
app.post('/admin/activar', adminLimiter, async (req, res) => {
  const { whatsapp, clave } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (!ADMIN_KEY || !clave || clave.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(ADMIN_KEY))) return res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
  if (!whatsapp) return res.status(400).json({ ok: false, msg: 'Falta whatsapp' });
  const numero = whatsapp.replace(/\+/g, '').replace(/^0/, '');
  const { data: usuarioActivar } = await supabase.from('usuarios').select('*').eq('whatsapp', numero).single();
  if (!usuarioActivar) return res.status(404).json({ ok: false, msg: 'Usuario no encontrado' });
  const hoy = new Date();
  const vence = new Date(hoy.getFullYear(), hoy.getMonth() + 1, hoy.getDate()).toISOString().split('T')[0];
  await supabase.from('usuarios').update({
    plan: 'premium', pago_pendiente: false,
    premium_desde: hoy.toISOString().split('T')[0], premium_vence: vence
  }).eq('id', usuarioActivar.id);
  await enviarWhatsapp(usuarioActivar.whatsapp,
    '\u2B50 *\u00a1Bienvenido a NETO Pro!*\n\n' +
    'Tu pago fue confirmado. Ya tienes acceso completo.\n\n' +
    '\u2705 Reportes PDF ilimitados\n\u2705 Resumen semanal automatico\n\u2705 Categorias personalizadas\n\n' +
    '_Gracias por confiar en NETO._ \uD83D\uDC9A'
  );
  res.json({ ok: true, msg: 'Premium activado para ' + (usuarioActivar.nombre || numero), vence });
});

// Endpoint admin: ver pagos pendientes
// GET /admin/pendientes?clave=ADMIN_KEY
app.get('/admin/pendientes', adminLimiter, async (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_KEY;
  const clavePendientes = req.query.clave || '';
  if (!ADMIN_KEY || !clavePendientes || clavePendientes.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(clavePendientes), Buffer.from(ADMIN_KEY))) return res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
  const { data } = await supabase.from('usuarios').select('whatsapp, nombre, plan, pago_pendiente, pago_referencia, created_at').eq('pago_pendiente', true);
  res.json({ ok: true, pendientes: data || [] });
});

// GET /admin/usuarios?clave=ADMIN_KEY — lista de usuarios registrados
app.get('/admin/usuarios', adminLimiter, async (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_KEY;
  const clave = req.query.clave || '';
  if (!ADMIN_KEY || !clave || clave.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(ADMIN_KEY))) return res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
  try {
    const { data } = await supabase.from('usuarios')
      .select('id, whatsapp, nombre, email, plan, onboarding_completado, gmail_access_token, created_at, premium_vence, supabase_auth_id')
      .order('created_at', { ascending: false });
    const usuarios = (data || []).map(u => ({
      id: u.id,
      whatsapp: u.whatsapp,
      nombre: u.nombre,
      email: u.email,
      plan: u.plan || 'free',
      onboarding_completado: u.onboarding_completado,
      tiene_gmail: !!u.gmail_access_token,
      tiene_webapp: !!u.supabase_auth_id,
      premium_vence: u.premium_vence,
      created_at: u.created_at,
    }));
    res.json({ ok: true, total: usuarios.length, usuarios });
  } catch(e) {
    log.error({ tag: 'ADMIN_USUARIOS', err: e.message }, 'Error listando usuarios');
    res.status(500).json({ ok: false, msg: 'Error listando usuarios' });
  }
});

// GET /admin/stats?clave=ADMIN_KEY — métricas de uso
app.get('/admin/stats', adminLimiter, async (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_KEY;
  const clave = req.query.clave || '';
  if (!ADMIN_KEY || !clave || clave.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(ADMIN_KEY))) return res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
  try {
    const hoy = hoyPeru();
    const hace7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const hace30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Usuarios
    const { data: allUsers } = await supabase.from('usuarios').select('id, plan, onboarding_completado, gmail_access_token, created_at');
    const totalUsuarios = (allUsers || []).length;
    const conGmail = (allUsers || []).filter(u => !!u.gmail_access_token).length;
    const modoManual = (allUsers || []).filter(u => u.onboarding_completado && !u.gmail_access_token).length;
    const premium = (allUsers || []).filter(u => u.plan === 'premium').length;
    const nuevos7d = (allUsers || []).filter(u => u.created_at >= hace7).length;

    // Transacciones
    const { count: txsHoy } = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).eq('fecha', hoy);
    const { count: txs7d } = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).gte('fecha', hace7);
    const { count: txs30d } = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).gte('fecha', hace30);

    // Top categorías (últimos 30 días)
    const { data: txsCat } = await supabase.from('transacciones').select('categoria, monto_pen').eq('tipo', 'gasto').gte('fecha', hace30);
    const porCat = {};
    (txsCat || []).forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || 0); });
    const topCategorias = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([cat, total]) => ({ categoria: cat, total: parseFloat(total.toFixed(2)) }));

    // Top bancos
    const { data: txsBanco } = await supabase.from('transacciones').select('banco').gte('fecha', hace30).not('banco', 'is', null);
    const porBanco = {};
    (txsBanco || []).forEach(t => { porBanco[t.banco] = (porBanco[t.banco] || 0) + 1; });
    const topBancos = Object.entries(porBanco).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([banco, count]) => ({ banco, transacciones: count }));

    res.json({
      ok: true,
      generado: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }),
      usuarios: { total: totalUsuarios, conGmail, modoManual, premium, nuevos7d },
      transacciones: { hoy: txsHoy || 0, ultimos7d: txs7d || 0, ultimos30d: txs30d || 0 },
      topCategorias,
      topBancos,
    });
  } catch(e) {
    log.error({ tag: 'ADMIN_STATS', err: e.message }, 'Error generando stats');
    res.status(500).json({ ok: false, msg: 'Error generando estadísticas' });
  }
});

// GET /admin/errores?clave=ADMIN_KEY — errores recientes
app.get('/admin/errores', adminLimiter, async (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_KEY;
  const clave = req.query.clave || '';
  if (!ADMIN_KEY || !clave || clave.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(ADMIN_KEY))) return res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
  try {
    const limite = parseInt(req.query.limite) || 20;
    const soloNoResueltos = req.query.resueltos !== 'true';
    let query = supabase.from('errores').select('*').order('created_at', { ascending: false }).limit(limite);
    if (soloNoResueltos) query = query.eq('resuelto', false);
    const { data } = await query;
    res.json({ ok: true, errores: data || [], total: (data || []).length });
  } catch(e) {
    res.status(500).json({ ok: false, msg: 'Error consultando errores' });
  }
});

// == NETO: Redactar respuesta con GPT usando el system prompt de NETO ==
// redactarConNETO → services/neto-gpt.js

async function procesarMensajeLibre(msg, usuario, from) {
  try {
    // === Interceptar tickets de soporte pendientes ===
    const { data: ticketPendiente } = await supabase.from('tickets_soporte').select('*')
      .eq('usuario_id', usuario.id).eq('estado', 'esperando_mensaje')
      .order('created_at', { ascending: false }).limit(1);
    if (ticketPendiente && ticketPendiente.length > 0) {
      const ticket = ticketPendiente[0];
      // Guardar el mensaje del usuario como descripción del ticket
      await supabase.from('tickets_soporte').update({
        mensaje_usuario: msg.substring(0, 1000),
        estado: 'pendiente',
        updated_at: new Date().toISOString()
      }).eq('id', ticket.id);
      // Notificar al admin con contexto completo
      const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
      const textoAdmin = '🎫 *Nuevo ticket de soporte*\n\n'
        + '👤 ' + (usuario.nombre || 'Sin nombre') + '\n'
        + '📱 ' + from + '\n'
        + '📋 Plan: ' + (usuario.tipo_plan || usuario.plan || 'free') + '\n\n'
        + '💬 *Mensaje:*\n' + msg.substring(0, 500) + '\n\n'
        + '_Responde con:_\n/responder ' + from + ' [tu mensaje]';
      await enviarWhatsapp(ADMIN_NUMBER, textoAdmin);
      return '✅ *Recibido.*\n\nTu mensaje fue enviado al equipo de Neto. Te responderemos lo antes posible por este mismo chat.\n\n_Si prefieres, también puedes escribirnos a 📧 hola@neto.pe_';
    }

    // === Interceptar tickets respondidos (usuario replica) ===
    const { data: ticketRespondido } = await supabase.from('tickets_soporte').select('*')
      .eq('usuario_id', usuario.id).eq('estado', 'respondido')
      .order('updated_at', { ascending: false }).limit(1);
    if (ticketRespondido && ticketRespondido.length > 0) {
      // Verificar si fue respondido en las últimas 2 horas (ventana de seguimiento)
      const ticketResp = ticketRespondido[0];
      const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      if (ticketResp.updated_at > hace2h) {
        // El usuario responde después de recibir respuesta del admin — reabrir como nuevo ticket
        await supabase.from('tickets_soporte').update({ estado: 'cerrado' }).eq('id', ticketResp.id);
        await supabase.from('tickets_soporte').insert({
          usuario_id: usuario.id, whatsapp: from,
          nombre_usuario: usuario.nombre || null,
          mensaje_usuario: msg.substring(0, 1000),
          estado: 'pendiente'
        });
        const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
        const textoReopen = '🔄 *Seguimiento de ticket*\n\n'
          + '👤 ' + (usuario.nombre || 'Sin nombre') + ' (' + from + ')\n\n'
          + '💬 *Respuesta del usuario:*\n' + msg.substring(0, 500) + '\n\n'
          + '📌 _El usuario no quedó conforme. Mensaje anterior:_\n'
          + (ticketResp.mensaje_usuario || '').substring(0, 200) + '\n\n'
          + '_Responde con:_\n/responder ' + from + ' [tu mensaje]';
        await enviarWhatsapp(ADMIN_NUMBER, textoReopen);
        return '📨 *Recibido.*\n\nTu mensaje fue reenviado al equipo. Si prefieres, también puedes contactarnos a:\n\n📧 hola@neto.pe\n\n_Te responderemos pronto._';
      }
    }

    const hoyParts = hoyPeru().split('-');
    const mesActual = parseInt(hoyParts[1], 10);
    const anioActual = parseInt(hoyParts[0], 10);
    const planUsuario = usuario.plan || 'free';
    const mE = ['','Enero','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    // Cargar NETO system prompt con datos del usuario
    let netoPrompt = 'Eres NETO, asistente financiero por WhatsApp. Hablas en espanol peruano, eres directo y siempre terminas con una accion o pregunta.';
    try {
      const rawPrompt = fs.readFileSync(require('path').join(__dirname, 'NETO_system_prompt.txt'), 'utf8');
      const parsersActivos = ['BCP','Interbank','BBVA','Scotiabank','Yape','Plin'].join(', ');
      const ultimaSync = usuario.updated_at ? new Date(usuario.updated_at).toLocaleDateString('es-PE') : 'hoy';
      netoPrompt = rawPrompt
        .replace(/\{NOMBRE_USUARIO\}/g, usuario.nombre || 'amigo')
        .replace(/\{PLAN_USUARIO\}/g, planUsuario)
        .replace(/\{MESES_HISTORIAL\}/g, '3')
        .replace(/\{PARSERS_ACTIVOS\}/g, parsersActivos)
        .replace(/\{ULTIMA_SYNC\}/g, ultimaSync);
    } catch(e) { log.error({ tag: 'NETO', err: e.message }, 'Error cargando system prompt'); }

    // Cargar historial de conversacion del usuario
    const historialConv = await obtenerHistorial(usuario.id);

    // Guardar mensaje del usuario en historial
    await guardarMensaje(usuario.id, 'usuario', msg);

    // Construir contexto del historial para el clasificador
    const histCtx = historialConv.length > 0
      ? '\n\nHISTORIAL RECIENTE (ultimos mensajes de la conversacion):\n' +
        historialConv.slice(-4).map(h => (h.rol === 'neto' ? 'NETO: ' : 'Usuario: ') + h.mensaje.substring(0, 120)).join('\n')
      : '';

    const clasificacion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'Eres el clasificador de intenciones de NETO, bot de finanzas personales por WhatsApp para usuarios peruanos.\nEl mes actual es ' + mE[mesActual] + ' ' + anioActual + '.\n\nAnaliza el mensaje y devuelve SOLO JSON.\n\nINTENCIONES:\n1. "listar_gastos_mes" - ver resumen/lista de gastos del mes\n   Ej: "cuales son mis gastos", "que gaste este mes", "gastos registrados", "que tengo registrado", "mis compras", "transacciones"\n   Datos: mes (numero, default=mes_actual), anio\n\n2. "listar_gastos_semana" - gastos de los ultimos 7 dias\n   Ej: "que gaste esta semana", "gastos recientes", "mis compras de los ultimos dias"\n\n2b. "listar_gastos_dia" - gastos de HOY o de un dia especifico\n   Ej: "que gaste hoy", "gastos de hoy", "resumen de hoy", "resumen del dia", "que compre hoy", "movimientos de hoy", "gastos de ayer", "que gaste ayer"\n   Datos: fecha (null si dice "hoy" o "del dia" — el sistema calcula la fecha real. Solo poner fecha YYYY-MM-DD si el usuario menciona una fecha especifica como "el 15 de marzo").\n\n3. "listar_gastos_categoria" - gastos de UNA categoria especifica\n   Ej: "que hay en Otros", "gastos de Alimentación", "que esta en Transporte", "detalle de Hogar", "cuales estan en otros"\n   Datos: categoria (nombre exacto), mes (default=mes_actual)\n\n4. "ver_total_gastado" - saber el TOTAL numerico gastado\n   Ej: "cuanto gaste", "cuanto llevo gastado", "total de gastos"\n   Datos: periodo ("semana" o "mes"), categoria (o null)\n\n5. "ver_presupuesto" - ver estado del presupuesto\n   Ej: "como va mi presupuesto", "cuanto me queda", "mis limites"\n\n6. "configurar_presupuesto" - configurar limite de gasto\n   Ej: "pon limite de 500 en comida", "presupuesto de 300 para transporte"\n   Datos: categoria, monto\n\n7. "ver_categorias" - ver categorias configuradas del sistema\n   Ej: "que categorias hay", "muestra las categorias del sistema"\n   IMPORTANTE: Si el historial muestra que NETO estaba hablando de gastos por categoria, NO usar esta intencion\n\n8. "ver_reporte" - reporte PDF\n   Ej: "dame mi reporte", "informe mensual", "reporte de marzo", "genera pdf"\n   Datos: mes (default=mes_actual), anio\n\n9. "corregir_categoria" - cambiar categoria de un gasto\n   Ej: "netflix es streaming", "cambia uber a transporte", "ponlo en Hogar", "muevelo a Delivery", "este gasto es de Comida", "ponlo en la categoria NETO", "categorizalo en Trabajo", "muevelo a Herramientas", "regístralo en alimentación", "es alimentación porque compré pan", "ponlo en comida", "es de transporte"\n   IMPORTANTE: Usar cuando el usuario quiere mover/cambiar/reclasificar un gasto a cualquier categoria (incluso una categoría personalizada no canónica como "NETO", "Mascota", etc). comercio puede ser null. También usar cuando el historial muestra que NETO acaba de registrar un gasto (desde imagen o notificación) y el usuario corrige la categoría.\n   Datos: comercio (null si no se menciona), categoria_nueva (el nombre de la categoria), subcategoria_nueva (null si no se menciona, o el nombre exacto de la subcategoria)\n\n10. "ver_pendientes" - gastos sin identificar\n    Ej: "gastos pendientes", "que no identificaste", "gastos sin categoria"\n\n11. "escanear_gmail" - escanear correos\n    Ej: "escanea mi correo", "busca transacciones nuevas", "hay correos nuevos"\n\n12. "ver_premium" - info del plan premium\n    Ej: "cuanto cuesta premium", "que incluye el plan"\n\n13. "saludo" - saludo sin intencion especifica\n    Ej: "buenos dias", "que tal", "como estas"\n\n14. "ayuda" - pide ayuda\n    Ej: "que puedes hacer", "ayuda", "como funciona"\n\n15. "registrar_manual" - el usuario quiere registrar un gasto o ingreso NUEVO\n   Ej: "gaste 50 soles en farmacia", "anota S/120 en ropa", "mi sueldo fue S/4500", "cobré S/800 de honorarios", "registra un ingreso de S/3500", "pague 200 en gasolina ayer"\n   IMPORTANTE: NO usar si el historial muestra que NETO acaba de notificar un gasto existente y el usuario está corrigiendo su moneda o monto (ej: "el gasto es USD 95", "son dolares", "el importe es 25 USD" → usar corregir_monto_moneda).\n   Datos: ninguno (se parsea el mensaje completo)\n\n16. "desconocido" - no encaja con ninguna intencion clara, o es continuacion de conversacion\n    Usar cuando: el mensaje es "si", "no", "dale", "ok", "mas", o cualquier respuesta corta a algo que NETO pregunto\n\n17. "corregir_monto_moneda" - el usuario indica que la moneda o monto de un gasto YA REGISTRADO está incorrecto\n   Ej: "el gasto es en dolares", "es en USD no en soles", "corrígelo son $25", "el monto es USD 25", "son 25 dolares", "el importe es en dolares", "eso es en USD", "el gasto es USD 95.07", "cambiale la moneda a dolares", "es dolar no sol"\n   IMPORTANTE: Solo cuando el historial muestra que se habla de un gasto existente ya notificado por NETO.\n   Datos: monto (numero o null), moneda ("USD" o "PEN" o null)\n\n18. "corregir_multiple" - el usuario da 2 o más instrucciones de corrección de categoría en el mismo mensaje, cada una referenciando un comercio/gasto diferente\n   Ej: "Netflix pasalo a Entretenimiento · Uber a Transporte · BCP comision a Finanzas", "E S NEUQUEN pasalo a gasolina\\nEdita Pal menu\\nEdita Pal (18/03) pasalo a menu"\n   IMPORTANTE: Usar cuando hay CLARAMENTE múltiples correcciones distintas en el mensaje (2+). Si solo hay una, usar corregir_categoria.\n   Datos: ninguno (se parsea el mensaje completo)\n\n19. "agregar_gmail" - el usuario quiere conectar una cuenta Gmail adicional (ya tiene una conectada)\n   Ej: "quiero agregar otro correo", "conectar una segunda cuenta de gmail", "agregar otro gmail", "tengo otro correo que quiero añadir"\n   Datos: ninguno\n\n20. "cambiar_gmail" - el usuario quiere reemplazar/cambiar su cuenta Gmail actual\n   Ej: "quiero cambiar mi cuenta", "me equivoqué de correo", "cambiar el gmail", "reconectar mi correo", "el correo que puse está mal", "quiero usar otro gmail"\n   Datos: ninguno\n\n21. "preferencia_reporte_gmail" - el usuario quiere configurar si sus reportes son unificados o separados por cuenta Gmail\n   Ej: "quiero los reportes separados por cuenta", "unifica mis correos en un solo reporte", "muéstrame por separado cada gmail"\n   Datos: modo ("unificado" o "separado")\n\n22. "cargar_excel" - el usuario quiere cargar gastos historicos desde un archivo Excel o quiere la plantilla\n   Ej: "quiero cargar mis gastos", "como subo mi historial", "tengo un Excel con mis gastos", "plantilla de gastos", "cargar gastos antiguos", "importar gastos"\n   Datos: ninguno\n\n23. "desconectar_cuenta" - el usuario quiere desconectar su cuenta, eliminar sus datos o darse de baja\n   Ej: "quiero desconectar mi cuenta", "eliminar mi cuenta", "borrar mis datos", "quiero darme de baja", "desconectar gmail", "eliminar todo", "ya no quiero usar Neto", "quiero salir", "desactivar mi cuenta"\n   Datos: ninguno\n\n24. "ver_referidos" - el usuario quiere referir amigos, ver su link de referido, o preguntar por el programa de referidos\n   Ej: "quiero referir a alguien", "mi link de referido", "como invito amigos", "programa de referidos", "quiero invitar a un amigo", "como refiero", "compartir neto", "recomendar neto", "mis referidos", "ganar pro gratis", "referir amigos", "como gano meses gratis"\n   Datos: ninguno\n\n25. "ver_recomendaciones" - el usuario quiere consejos financieros, saber como mejorar, donde se excede, como subir su score, o recomendaciones\n   Ej: "como mejoro mis finanzas", "donde me estoy excediendo", "como subo mi score", "dame recomendaciones", "en que puedo mejorar", "que dias gasto mas", "donde puedo ahorrar", "analiza mis gastos", "que ajusto", "tips para ahorrar", "como estoy financieramente", "que puedo mejorar"\n   Datos: tipo ("score" si pregunta por score, "excesos" si pregunta donde se excede, "general" si pide recomendaciones generales, "patrones" si pregunta por dias/patrones)\n\n26. "comparar_meses" - el usuario quiere comparar gastos entre dos meses o con el mes anterior\n   Ej: "gaste mas este mes?", "compara marzo con febrero", "como voy vs el mes pasado", "comparacion de meses", "febrero vs marzo", "me fue mejor este mes?", "gasto mas o menos que antes"\n   Datos: mes1 (numero, default=mes_actual), mes2 (numero, default=mes_anterior), anio1, anio2\n\n27. "buscar_gasto" - el usuario busca gastos de un comercio o lugar especifico\n   Ej: "cuanto gaste en Uber", "busca mis pagos de Netflix", "gastos en Plaza Vea", "que pague en Rappi", "pagos a Movistar", "cuanto llevo en gasolina"\n   IMPORTANTE: Diferente de listar_gastos_categoria. Aqui el usuario menciona un COMERCIO o servicio especifico, no una categoria.\n   Datos: comercio (nombre del comercio/servicio), mes (default=mes_actual), anio\n\n28. "ver_ingresos" - el usuario quiere ver sus ingresos (sueldo, cobros, ventas)\n   Ej: "cuanto gane este mes", "mis ingresos", "cuanto me pagaron", "ingresos de marzo", "cuanto cobre", "mi sueldo", "entradas de dinero"\n   Datos: periodo ("mes" o "semana"), mes (default=mes_actual), anio\n\n29. "ver_balance" - el usuario quiere saber su balance (ingresos menos gastos)\n   Ej: "cuanto me queda", "estoy en rojo", "mi balance", "como estoy de plata", "me alcanza", "saldo del mes", "cuanto tengo disponible", "estoy bien o mal"\n   Datos: mes (default=mes_actual), anio\n\n30. "ver_suscripciones" - ver pagos recurrentes y suscripciones activas\n   Ej: "mis suscripciones", "que pago mensual", "servicios que pago", "pagos recurrentes", "cuanto gasto en suscripciones", "cuantas suscripciones tengo"\n   Datos: ninguno\n\n31. "ver_tipo_cambio" - consultar tipo de cambio USD/PEN\n   Ej: "a cuanto esta el dolar", "tipo de cambio", "precio del dolar", "cuanto esta el dolar hoy", "tc", "cambio de dolar a sol"\n   Datos: ninguno\n\n32. "editar_monto" - corregir el monto de un gasto ya registrado (sin cambiar moneda)\n   Ej: "el monto es 50 no 500", "corrige a S/120", "el monto real es 35", "no es 100 es 10", "el monto esta mal, son 80 soles"\n   IMPORTANTE: Diferente de corregir_monto_moneda (que cambia la MONEDA). Aqui solo se corrige el numero del monto en la misma moneda.\n   Datos: monto_nuevo (numero)\n\n33. "editar_fecha" - corregir la fecha de un gasto ya registrado\n   Ej: "ese gasto fue ayer", "cambialo al 15 de marzo", "la fecha es el 20", "no fue hoy, fue el viernes", "corrige la fecha al 10"\n   Datos: fecha_nueva (YYYY-MM-DD o "ayer" o dia del mes)\n\n34. "editar_comercio" - corregir el nombre del comercio de un gasto\n   Ej: "el comercio es Plaza Vea", "no es PV, es Plaza Vea", "el nombre correcto es Sodimac", "cambia el comercio a Wong"\n   Datos: comercio_nuevo (nombre correcto)\n\n35. "dividir_gasto" - dividir un gasto entre varias personas/partes\n   Ej: "divide entre 3", "mitad es mio", "split entre 2", "solo me toca la tercera parte", "dividelo entre 4 personas", "pagamos a medias"\n   Datos: partes (numero, ej: 2 para mitad, 3 para tercios)\n\n36. "duplicar_gasto" - registrar un gasto igual al ultimo\n   Ej: "registra otro igual", "lo mismo para hoy", "repite el ultimo gasto", "otro igual", "lo mismo pero de hoy"\n   Datos: fecha (YYYY-MM-DD o null para hoy)\n\n37. "ver_metas" - ver estado de las metas de ahorro\n   Ej: "como van mis metas", "mi meta de ahorro", "cuanto me falta para mi meta", "progreso de mis metas", "mis objetivos"\n   Datos: ninguno\n\n38. "crear_meta" - crear una nueva meta de ahorro\n   Ej: "quiero ahorrar 5000 para julio", "meta de ahorro de 2000 soles", "crear meta para viaje", "ahorrar para navidad 3000"\n   Datos: nombre (descripcion corta), monto (numero), fecha_limite (YYYY-MM-DD o mes/anio)\n\n39. "agradecimiento" - el usuario agradece o felicita a NETO\n   Ej: "gracias", "gracias neto", "eres crack", "genial", "excelente", "buenazo", "eres lo mejor", "que bueno", "perfecto gracias", "chevere"\n   Datos: ninguno\n\n40. "queja" - el usuario se queja o reporta un problema\n   Ej: "no funciona", "esto esta mal", "no me lee los correos", "hay un error", "no jala", "esta fallando", "no me registra", "no sirve", "tengo un problema"\n   IMPORTANTE: Solo cuando es claramente una queja sobre el funcionamiento. Si dice "no" como respuesta a una pregunta → usar "desconocido".\n   Datos: ninguno\n\n41. "chiste_finanzas" - el usuario pide humor o entretenimiento\n   Ej: "cuentame un chiste", "hazme reir", "dime algo gracioso", "un chiste de plata", "animate", "dime un dato curioso"\n   Datos: ninguno\n\n42. "exportar_datos" - el usuario quiere exportar/descargar sus datos\n   Ej: "quiero mis datos en excel", "exportar todo", "descargar mis gastos", "bajar mi historial", "quiero un backup de mis datos", "dame mis datos"\n   Datos: ninguno\n\n43. "cambiar_nombre" - el usuario quiere cambiar su nombre en el sistema\n   Ej: "mi nombre es Juan", "cambiame el nombre", "no me llamo asi", "ponme Pedro", "mi nombre correcto es Maria", "llamame Carlos"\n   IMPORTANTE: Solo cuando el usuario EXPLICITAMENTE dice su nombre o pide cambiarlo. No confundir con editar_comercio.\n   Datos: nombre_nuevo (el nombre correcto)\n\n44. "ver_gasto_mayor" - el gasto mas grande/caro del mes\n   Ej: "cual fue mi gasto mas grande", "mi gasto mas caro", "el mayor gasto del mes", "donde gaste mas"\n   Datos: mes (default=mes_actual), anio\n\n45. "ver_gasto_menor" - el gasto mas pequeño/barato del mes\n   Ej: "cual es mi gasto mas chiquito", "el menor gasto", "lo mas barato que compre", "mi gasto mas pequeño"\n   Datos: mes (default=mes_actual), anio\n\n46. "ver_promedio_diario" - promedio de gasto diario\n   Ej: "cuanto gasto al dia", "mi promedio diario", "gasto promedio", "cuanto gasto en promedio"\n   Datos: mes (default=mes_actual)\n\n47. "ver_frecuencia_comercio" - cuantas veces compro en un comercio especifico y total\n   Ej: "cuantas veces fui a Rappi", "cuantos pagos en Uber", "frecuencia de Netflix", "cuantas compras en Plaza Vea"\n   IMPORTANTE: Diferente de buscar_gasto (que lista gastos). Aqui pregunta por FRECUENCIA/CONTEO.\n   Datos: comercio (nombre del comercio)\n\n48. "ver_gastos_rango_fecha" - gastos en un rango de fechas especifico\n   Ej: "gastos del 1 al 15", "transacciones de la quincena", "gastos entre el 5 y el 20", "primera quincena", "segunda quincena"\n   Datos: fecha_inicio (YYYY-MM-DD), fecha_fin (YYYY-MM-DD)\n\n49. "ver_gastos_fin_de_semana" - cuanto gasta en fines de semana (sabado y domingo)\n   Ej: "cuanto gasto los fines de semana", "gastos de sabado y domingo", "fin de semana cuanto me sale", "mis gastos del finde"\n   Datos: mes (default=mes_actual)\n\n50. "deshacer_ultimo" - deshacer/cancelar el ultimo registro sin especificar cual\n   Ej: "deshaz eso", "cancela el ultimo", "me equivoque", "undo", "borra el ultimo", "quita eso"\n   IMPORTANTE: Diferente de eliminar_transaccion (que requiere comercio o especificacion). Este es genérico: "deshaz lo ultimo".\n   Datos: ninguno\n\n51. "editar_categoria_comercio" - crear una REGLA permanente para que un comercio siempre vaya a una categoria\n   Ej: "todo lo de Rappi siempre va en Delivery", "Netflix siempre es Entretenimiento", "cuando sea Uber ponlo en Transporte", "Rappi siempre delivery"\n   IMPORTANTE: Diferente de corregir_categoria (que corrige UNA transaccion). Aqui se crea una REGLA permanente.\n   Datos: comercio (nombre), categoria (categoria destino)\n\n52. "marcar_como_ingreso" - cambiar un gasto ya registrado a ingreso (o viceversa)\n   Ej: "eso no es gasto, es ingreso", "es un cobro no un pago", "marcalo como ingreso", "ese es ingreso", "no es gasto sino cobro", "es una venta"\n   Datos: tipo_nuevo ("ingreso" o "gasto")\n\n53. "eliminar_presupuesto" - eliminar/quitar un presupuesto existente\n   Ej: "quita el limite de comida", "borra el presupuesto de transporte", "elimina presupuesto de delivery", "ya no quiero limite en salud"\n   Datos: categoria (nombre de la categoria)\n\n54. "editar_meta" - modificar una meta de ahorro existente\n   Ej: "sube mi meta a 3000", "cambia la fecha de mi meta", "actualiza mi meta de viaje", "la meta ahora es 5000"\n   Datos: nombre (nombre de la meta, null si solo tiene una), monto_nuevo (numero o null), fecha_nueva (YYYY-MM-DD o null)\n\n55. "eliminar_meta" - eliminar una meta de ahorro\n   Ej: "borra la meta de viaje", "ya no quiero esa meta", "elimina mi meta", "quita la meta de navidad"\n   Datos: nombre (nombre de la meta, null si solo tiene una)\n\n56. "abonar_meta" - agregar dinero/abono a una meta de ahorro existente\n   Ej: "abone 500 a mi meta", "agrega 200 a mi ahorro", "deposite 1000 para mi viaje", "meti 300 a la meta", "ahorre 500"\n   IMPORTANTE: Diferente de registrar_manual. Aqui el dinero va a una META, no es un gasto ni ingreso.\n   Datos: monto (numero), nombre_meta (nombre de la meta o null si solo tiene una)\n\n57. "consulta_financiera" - pregunta sobre conceptos financieros peruanos\n   Ej: "que es un CTS", "como funciona una AFP", "me conviene un deposito a plazo", "que es la gratificacion", "como funciona la ONP", "que son los fondos mutuos", "que es TEA", "que significa TCEA"\n   Datos: ninguno\n\n58. "calcular_cuotas" - calcular cuanto pagaria en cuotas con intereses\n   Ej: "si pago 1500 en 12 cuotas cuanto sale", "cuanto de interes me cobran", "cuotas de 3000 soles", "quiero saber cuanto pago en 6 cuotas", "calcula las cuotas de 2000"\n   Datos: monto (numero), cuotas (numero de cuotas, default=12), tasa (TEA porcentaje o null, default=45)\n\n59. "recordatorio_pago" - quiere que le recuerden pagar algo en cierta fecha\n   Ej: "recuerdame pagar la luz el 15", "avisame del agua el 20", "recordatorio de pago", "no me dejes olvidar pagar el internet"\n   Datos: concepto (que pagar), dia (dia del mes)\n\n60. "convertir_moneda" - convertir un monto entre USD y PEN\n   Ej: "cuanto es 50 dolares en soles", "convierte 200 USD a PEN", "100 soles a dolares", "pasa 500 dolares a soles", "50 usd en pen"\n   IMPORTANTE: Diferente de ver_tipo_cambio (que solo muestra la tasa). Aqui el usuario quiere convertir un MONTO especifico.\n   Datos: monto (numero), moneda_origen ("USD" o "PEN"), moneda_destino ("PEN" o "USD")\n\n61. "feedback" - el usuario da sugerencias, ideas o feedback sobre Neto\n   Ej: "estaria bueno que", "podrias agregar", "sugiero que", "me gustaria que", "una idea", "deberian poner", "falta que"\n   Datos: ninguno\n\n62. "estado_cuenta" - el usuario pregunta por su cuenta, plan, o estado de suscripcion\n   Ej: "que plan tengo", "cuando vence mi pro", "mi cuenta", "estado de mi suscripcion", "soy free o pro", "cuanto me queda de pro", "mi perfil"\n   IMPORTANTE: Diferente de ver_premium (que muestra INFO del plan Pro). Aqui el usuario pregunta por SU estado actual.\n   Datos: ninguno\n\n63. "silenciar" - el usuario quiere desactivar recordatorios/notificaciones\n   Ej: "silencia", "no me mandes mensajes", "para los recordatorios", "deja de enviar", "no me escribas", "desactiva notificaciones", "no quiero recordatorios"\n   Datos: ninguno\n\n64. "reactivar_recordatorios" - el usuario quiere volver a recibir recordatorios\n   Ej: "activa los recordatorios", "vuelve a avisarme", "quiero recibir notificaciones", "reactiva los mensajes", "activa las alertas"\n   Datos: ninguno\n\n65. "como_empezar" - el usuario es nuevo y quiere saber como empezar\n   Ej: "soy nuevo", "como empiezo", "que hago primero", "recien empiezo", "acabo de registrarme", "por donde empiezo", "primera vez aqui"\n   IMPORTANTE: Diferente de ayuda (que lista comandos). Aqui es ONBOARDING para nuevos.\n   Datos: ninguno\n\n66. "ver_historial_cambios" - ver cambios/ediciones recientes hechas a sus transacciones\n   Ej: "que cambios hice hoy", "que corregi", "mis ultimas ediciones", "que modifique", "cambios recientes"\n   Datos: ninguno\n\n67. "compartir_resumen" - quiere compartir/enviar su resumen o reporte a alguien\n   Ej: "comparte mi resumen", "manda a mi esposa", "envia mi reporte a", "compartir mis gastos", "reenvia el reporte"\n   Datos: ninguno\n\n68. "hablar_con_humano" - quiere hablar con una persona real, soporte humano\n   Ej: "quiero hablar con alguien", "pasame con soporte", "necesito un humano", "atencion al cliente", "quiero hablar con una persona", "soporte tecnico"\n   IMPORTANTE: Diferente de queja (que reporta un problema). Aqui el usuario PIDE contacto humano directamente.\n   Datos: ninguno\n\n69. "registrar_deuda" - el usuario quiere registrar que debe dinero a alguien, o que alguien le debe dinero. Puede ser conversacional y natural.\n   Ej: "debo 200 a Juan", "le presté 500 a mi hermana", "Renzo me debe 150 por la cancha", "Annie me debe 100 soles y 10 dólares", "María me debe 50 lucas, tiene que pagarme el viernes", "le debo como 300 a Pedro por la cena del otro día"\n   Datos: tipo ("debo" si el usuario debe, "me_deben" si le deben), contraparte (nombre de la persona — SIEMPRE extraerlo del mensaje), monto (numero — si hay multiples montos en distintas monedas, usar el primer monto), moneda ("PEN" o "USD" — si hay multiples monedas, usar la del primer monto; el handler parsea el resto), descripcion (motivo, plazo o contexto adicional, o null)\n   REGLA: "debo X a Y" → tipo="debo". "Y me debe X" o "le presté X a Y" → tipo="me_deben"\n   IMPORTANTE: Extraer SIEMPRE contraparte y al menos un monto. El handler se encarga de parsear multiples montos/monedas del mensaje original. Si el usuario dice "me debe pagar en X días" o "tiene que pagarme el viernes", incluirlo en descripcion.\n\n70. "ver_deudas" - el usuario quiere ver sus deudas activas\n   Ej: "mis deudas", "cuánto debo", "quién me debe", "ver deudas", "resumen de deudas", "cuánto me deben"\n   Datos: ninguno\n\n71. "abonar_deuda" - el usuario registra un pago parcial o total de una deuda\n   Ej: "pagué 100 a Juan", "abono 50 a lo que le debo a Pedro", "le devolví 200 a mi hermana"\n   Datos: contraparte (nombre), monto (numero)\n   IMPORTANTE: Solo cuando habla de pagar una deuda existente. Gasto nuevo → "registrar_manual"\n\n72. "marcar_deuda_pagada" - la deuda quedó saldada completamente\n   Ej: "ya pagué a Juan", "saldé con Pedro", "quedó saldado", "me pagó Renzo", "ya nos arreglamos con Ana"\n   Datos: contraparte (nombre)\n\n73. "consolidar_deudas" - el usuario quiere saber cuanto debe o le deben EN TOTAL a una persona especifica (suma de todas las deudas con esa contraparte)\n   Ej: "cuanto le debo a Ana en total", "total con Pedro", "cuanto me debe Juan en total", "mis deudas con Maria"\n   Datos: contraparte (nombre de la persona)\n   IMPORTANTE: Diferente de ver_deudas (que lista TODAS). Aqui pregunta por el TOTAL con UNA persona especifica.\n\n74. "saldar_todo_contraparte" - el usuario quiere saldar/liquidar TODAS las deudas pendientes con una persona de golpe\n   Ej: "salda todo con Ana", "liquida todo con Pedro", "arregla todo con Maria", "cancela todo con Juan"\n   Datos: contraparte (nombre de la persona)\n   IMPORTANTE: Diferente de marcar_deuda_pagada (que salda UNA deuda). Aqui salda TODAS las deudas con esa persona.\n\n75. "compartir_meta" - el usuario quiere compartir una meta de ahorro para que otros se unan (meta colaborativa)\n   Ej: "comparte mi meta", "invitar a mi meta de viaje", "link de mi meta", "compartir mi ahorro"\n   Datos: nombre_meta (nombre de la meta o null si solo tiene una)\n\n76. "dividir_gasto_grupal" - el usuario quiere dividir un gasto entre varias personas (Splitwise lite)\n   Ej: "pague 300 la cena entre 4", "split de 500 entre 3", "dividir gasto de uber entre 2", "repartir 150 entre 3"\n   Datos: monto (numero), num_personas (numero), descripcion (que se pago)\n   IMPORTANTE: Diferente de dividir_gasto (que divide un gasto YA registrado). Aqui se CREA un gasto compartido nuevo.\n\nREGLAS CRITICAS:\n- Si el historial muestra que NETO hizo una pregunta y el usuario responde con "si", "no", "dale", "ok", "mas detalle", "eso", "las dos", o cualquier respuesta corta -> usar "desconocido" para que NETO maneje la continuacion\n- Si NETO acaba de notificar "Nuevo gasto" y el usuario dice algo como "el gasto es USD X" o "son dolares" -> usar "corregir_monto_moneda", NO "registrar_manual"\n- Si NETO acaba de registrar un gasto desde una imagen (historial muestra "Registré desde la imagen" o "📸") y el usuario dice la categoría o cómo corregirlo -> usar "corregir_categoria", NO "registrar_manual". Ej: "regístralo en alimentación", "ponlo en comida", "es alimentación porque compré pan", "cambialo a transporte"\n- Si el historial muestra que NETO hablaba de gastos por categoria y el usuario dice "otras categorias" o similar -> usar "desconocido" no "ver_categorias"\n- "otros" como categoria de gasto -> listar_gastos_categoria con categoria="Otros"\n- "cuanto gaste" sin periodo -> ver_total_gastado con periodo="mes"\n- "gastos registrados"/"que tengo" -> listar_gastos_mes\n- mes: enero=1, febrero=2, marzo=3, ..., diciembre=12\n- Si no especifica mes -> usar mes_actual\n- "debo X a Y" → "registrar_deuda" con tipo="debo". "Y me debe X" → tipo="me_deben"\n- "mis deudas" / "cuánto debo" / "quién me debe" → "ver_deudas", NO "desconocido"\n- "pagué X a [nombre]" sin mencionar gasto nuevo → "abonar_deuda", NO "registrar_manual"\n- "ya pagué a [nombre]" / "saldé con X" → "marcar_deuda_pagada", NO "desconocido"\n- "cuanto le debo a X en total" / "total con X" + contexto deudas → "consolidar_deudas", NO "ver_deudas"\n- "salda/liquida/cancela todo con X" → "saldar_todo_contraparte", NO "marcar_deuda_pagada"\n- "comparte/invita/link mi meta" → "compartir_meta", NO "desconocido"\n- "pague X entre N" / "dividir gasto" / "split" → "dividir_gasto_grupal", NO "registrar_manual"\n- "gracias", "genial", "crack", "buenazo" sin otra intencion -> "agradecimiento", NO "desconocido"\n- "cuanto gaste en [comercio]" con nombre de COMERCIO -> "buscar_gasto", NO "ver_total_gastado"\n- "cuanto gane" o "mis ingresos" -> "ver_ingresos", NO "ver_total_gastado"\n- "cuanto me queda" o "mi balance" -> "ver_balance", NO "ver_presupuesto"\n- "el monto es X" SIN mencionar dolares/moneda -> "editar_monto", NO "corregir_monto_moneda"\n- "divide entre X" o "mitad" -> "dividir_gasto"\n- "otro igual" o "lo mismo" -> "duplicar_gasto"\n- "mi nombre es X" -> "cambiar_nombre", NO "desconocido"\n- "no funciona", "hay un error", "no jala" como QUEJA -> "queja", NO "desconocido"\n- "deshaz", "cancela el ultimo", "me equivoque" SIN mencionar comercio -> "deshacer_ultimo", NO "eliminar_transaccion"\n- "siempre va en X" o "todo lo de X es Y" -> "editar_categoria_comercio", NO "corregir_categoria"\n- "no es gasto, es ingreso" o "es un cobro" -> "marcar_como_ingreso", NO "corregir_categoria"\n- "que es un CTS/AFP/gratificacion/deposito a plazo" -> "consulta_financiera", NO "desconocido"\n- "cuanto es X dolares en soles" o "convierte X USD" -> "convertir_moneda", NO "ver_tipo_cambio"\n- "soy nuevo" o "como empiezo" o "que hago primero" -> "como_empezar", NO "ayuda"\n- "quiero hablar con alguien/humano/soporte" -> "hablar_con_humano", NO "queja"\n- "estaria bueno que" o "podrias agregar" o "sugiero" -> "feedback", NO "desconocido"\n- "silencia" o "no me mandes mensajes" o "para los recordatorios" -> "silenciar", NO "desconocido"\n- "que plan tengo" o "mi cuenta" o "cuando vence" -> "estado_cuenta", NO "ver_premium"\n- "cual fue mi gasto mas grande/caro" -> "ver_gasto_mayor", NO "ver_total_gastado"\n- "cuantas veces fui a [comercio]" -> "ver_frecuencia_comercio", NO "buscar_gasto"\n- "gastos del 1 al 15" o "quincena" -> "ver_gastos_rango_fecha", NO "listar_gastos_mes"\n- "cuanto gasto los fines de semana" -> "ver_gastos_fin_de_semana", NO "ver_total_gastado"\n- "abona/agrega X a mi meta" -> "abonar_meta", NO "registrar_manual"\n- "quita/borra el presupuesto de X" -> "eliminar_presupuesto", NO "configurar_presupuesto"\n- "borra la meta de X" -> "eliminar_meta", NO "eliminar_transaccion"\n- "cuotas de X" o "cuanto pago en cuotas" -> "calcular_cuotas", NO "desconocido"\n- "recuerdame pagar X el dia Y" -> "recordatorio_pago", NO "desconocido"' + histCtx
      }, {
        role: 'user',
        content: msg
      }],
      temperature: 0
    });

    const rawClasif = clasificacion.choices[0].message.content.trim();
    const clean = rawClasif.startsWith('{') ? rawClasif : rawClasif.slice(rawClasif.indexOf('{'), rawClasif.lastIndexOf('}')+1);
    const _nlp = JSON.parse(clean); let intencion = _nlp.intencion; const datos = _nlp.datos || _nlp.data || {};

    // Overrides regex para patrones que el clasificador suele fallar
    const msgL = msg.toLowerCase();
    // "elimina/borra/quita [el gasto de] X" → eliminar_transaccion
    if (/\b(elimina|borra|quita|borrar|eliminar)\b.*(gasto|pago|cobro|movimiento|transacci[oó]n)/i.test(msg) ||
        /\b(elimina|borra|quita)\b.*\bde\b/i.test(msg)) {
      intencion = 'eliminar_transaccion';
      // Intentar extraer comercio del mensaje si no vino del clasificador
      if (!datos.comercio) {
        const m = msg.match(/(?:de|el de|gasto de|pago de)\s+([A-Za-záéíóúÁÉÍÓÚñÑ][A-Za-z0-9áéíóúÁÉÍÓÚñÑ\s\.]{1,30}?)(?:\s+(?:de|por|S\/|\$|\d|,|\.)|\s*$)/i);
        if (m) datos.comercio = m[1].trim();
      }
    }
    // "a la categoría NETO" / "ponlo en NETO" cuando clasificador no extrajo categoria_nueva
    if ((intencion === 'corregir_categoria' || intencion === 'desconocido') &&
        /(?:categor[íi]a|en)\s+neto\b|ponl[oa]\s+en\s+neto|muev[elo]+\s+a\s+neto/i.test(msg)) {
      intencion = 'corregir_categoria';
      if (!datos.categoria_nueva) datos.categoria_nueva = 'NETO';
    }
    // "es categoría X [y subcategoría Y]" → corregir_categoria con datos extraídos
    if (/\bes\s+categor[ií]a\b/i.test(msg)) {
      intencion = 'corregir_categoria';
      const mCatSub = msg.match(/\bes\s+categor[ií]a\s+([A-Za-záéíóúÁÉÍÓÚñÑ_\s]+?)(?:\s+y\s+subcategor[ií]a\s+([A-Za-záéíóúÁÉÍÓÚñÑ_\s]+))?\s*$/i);
      if (mCatSub) {
        datos.categoria_nueva = mCatSub[1].trim();
        if (mCatSub[2]) datos.subcategoria_nueva = mCatSub[2].trim();
      }
    }
    // "quiero ir a mi dashboard/app" → enviar link directo a app.neto.pe
    if (/\b(dashboard|mi app|la app|al app|mi panel|ver mis gr[aá]ficos|abrir app|entrar a la app|ir a mi app|ir al app|ir a la app|ir al dashboard|ver mi dashboard|abrir mi app|abrir la app|quiero ir al app|quiero ver mi app)\b/i.test(msg)) {
      intencion = 'ver_dashboard';
    }
    // "a cuánto está el dólar" / "tipo de cambio" → ver_tipo_cambio
    if (/\b(d[oó]lar|tipo de cambio|tc hoy|precio.+d[oó]lar|cambio.+d[oó]lar)\b/i.test(msg) && !/gast[eé]|pagu[eé]|registr/i.test(msg)) {
      intencion = 'ver_tipo_cambio';
    }
    // "gracias" / "eres crack" → agradecimiento (no desconocido)
    if (/^\s*(gracias|thanks|genial|crack|excelente|buenazo|buen[ií]simo|eres (lo|el) mejor|perfecto|chevere|ch[eé]vere|que bueno|muy bien)\s*[!.]*\s*$/i.test(msg)) {
      intencion = 'agradecimiento';
    }
    // "exportar" / "descargar mis datos" → exportar_datos
    if (/\b(exportar?|descargar?).+(datos|gastos|historial|todo)\b/i.test(msg) || /\b(excel|csv|backup).+mis\b/i.test(msg)) {
      intencion = 'exportar_datos';
    }
    // "divide entre X" / "mitad" → dividir_gasto
    if (/\b(divid[eir]|split|a medias|mitad)\b/i.test(msg) && !/categor/i.test(msg)) {
      intencion = 'dividir_gasto';
      if (!datos.partes) {
        const mDiv = msg.match(/entre\s+(\d+)/i) || msg.match(/(\d+)\s+part/i);
        if (mDiv) datos.partes = parseInt(mDiv[1]);
        else if (/mitad|medias/i.test(msg)) datos.partes = 2;
      }
    }
    // "otro igual" / "lo mismo" → duplicar_gasto
    if (/\b(otro igual|lo mismo|repite|rep[ií]telo|igual que el anterior|mismo gasto)\b/i.test(msg)) {
      intencion = 'duplicar_gasto';
    }
    // "deshaz" / "cancela el último" / "me equivoqué" → deshacer_ultimo
    if (/\b(desha[zs]|cancela el [uú]ltimo|me equivoqu[eé]|undo|quita eso|borra el [uú]ltimo)\b/i.test(msg) && !/\b(gasto de|pago de|cobro de)\b/i.test(msg)) {
      intencion = 'deshacer_ultimo';
    }
    // "silencia" / "no me mandes mensajes" → silenciar
    if (/\b(silenci[ao]r?|no me mandes|no me escribas|deja de enviar|desactiva.*(notificaci|recordatorio)|no quiero recordatorio)\b/i.test(msg)) {
      intencion = 'silenciar';
    }
    // "activa los recordatorios" / "vuelve a avisarme" → reactivar_recordatorios
    if (/\b(activa.*(recordatorio|notificaci|alerta)|vuelve a avisarme|reactiva.*(mensaje|recordatorio|notificaci))\b/i.test(msg)) {
      intencion = 'reactivar_recordatorios';
    }
    // "quiero hablar con alguien/humano/soporte" → hablar_con_humano
    if (/\b(hablar con (alguien|humano|persona|soporte)|p[aá]same con|atenci[oó]n al cliente|soporte t[eé]cnico|necesito.+humano|quiero.+persona)\b/i.test(msg)) {
      intencion = 'hablar_con_humano';
    }
    // "soy nuevo" / "cómo empiezo" → como_empezar
    if (/\b(soy nuev[oa]|c[oó]mo empiezo|qu[eé] hago primero|reci[eé]n empiezo|primera vez|acabo de registrarme|por d[oó]nde empiezo)\b/i.test(msg)) {
      intencion = 'como_empezar';
    }
    // "cuánto es X dólares en soles" → convertir_moneda (no ver_tipo_cambio)
    if (/\b(cu[aá]nto es|conv[ie]rt[eir]|pasa)\b.+\b(d[oó]lares?.*(en|a) soles|soles.*(en|a) d[oó]lares|USD.*(a|en) PEN|PEN.*(a|en) USD)\b/i.test(msg)) {
      intencion = 'convertir_moneda';
    }
    // "estaría bueno que" / "podrías agregar" / "sugiero" → feedback
    if (/\b(estar[ií]a bueno|podr[ií]as agregar|sugiero|sugerencia|me gustar[ií]a que|deber[ií]an|falta que|una idea)\b/i.test(msg) && !/gast/i.test(msg)) {
      intencion = 'feedback';
    }
    // "qué plan tengo" / "mi cuenta" / "cuándo vence" → estado_cuenta
    if (/\b(qu[eé] plan tengo|soy free|soy pro|cu[aá]ndo vence|estado de mi (cuenta|suscripci)|mi perfil)\b/i.test(msg)) {
      intencion = 'estado_cuenta';
    }
    // "gastos hormiga" / "calcular mis gastos hormiga" → gastos_hormiga
    if (/gastos?\s+hormiga/i.test(msg)) {
      intencion = 'gastos_hormiga';
    }
    // "debo X a Y" / "me prestaron X" / "tengo deuda de X con Y" → registrar_deuda
    if (/\b(debo|le debo|me prest[oó]|tengo.*(deuda|prestamo|pr[eé]stamo)|me pidi[oó]|pidi[eé]ndome)\b/i.test(msg)) {
      intencion = 'registrar_deuda';
    }
    // "X me debe Y" / "le presté X a Y" / "Y me debe por" → registrar_deuda tipo me_deben
    if (/\b\w+\s+me debe\b|\ble prest[eé]\b|\bme deben\b/i.test(msg) && !/\bcu[aá]nto me deben\b/i.test(msg)) {
      intencion = 'registrar_deuda';
    }
    // "mis deudas" / "cuánto debo" / "quién me debe" → ver_deudas
    if (/\b(mis deudas|cu[aá]nto debo|ver deudas|deudas activas|qu[eé] debo|resumen de deudas|cu[aá]nto me deben|qui[eé]n me debe)\b/i.test(msg)) {
      intencion = 'ver_deudas';
    }
    // "pagué X a Y" / "abono X a deuda" → abonar_deuda
    if (/\b(pagu[eé]|abono|abon[eé]|le pa[gq]u[eé])\b.+\b(a |de |su |lo que)\b/i.test(msg) && !/\b(gast[eé]|registra|anota)\b/i.test(msg)) {
      intencion = 'abonar_deuda';
    }
    // "ya pagué a Y" / "saldé con Y" / "Y me pagó" → marcar_deuda_pagada
    if (/\b(ya pagu[eé]|sald[eé]|liquidu[eé]|cancel[eé] la deuda|me pag[oó]|ya me pag[oó]|ya nos arreglamos|qued[oó] saldado)\b/i.test(msg)) {
      intencion = 'marcar_deuda_pagada';
    }
    // "Annie me dio 50" / "me transfirió 30" → abonar_deuda (pago recibido)
    if (/\b(\w+)\s+me\s+(dio|transfiri[oó]|deposit[oó]|pas[oó])\s+\d/i.test(msg) && !/\b(gast[eé]|registra|anota|debe)\b/i.test(msg)) {
      intencion = 'abonar_deuda';
    }
    // "le pagué la mitad a X" / "le di un tercio" → abonar_deuda (fracciones)
    if (/\b(le\s+)?(pagu[eé]|di|abon[eé])\s+(la mitad|un tercio|la tercera|un cuarto|la cuarta|\d+\s*%)\b/i.test(msg)) {
      intencion = 'abonar_deuda';
    }
    // "cuánto le debo a X en total" / "total con X" → consolidar_deudas
    if (/\bcu[aá]nto\s+(le\s+debo|me\s+debe)\b.+\b(en total|total)\b/i.test(msg) || /\btotal\s+(con|de)\s+\w+.*deuda/i.test(msg)) {
      intencion = 'consolidar_deudas';
    }
    // "salda todo con X" / "liquida todo con X" → saldar_todo_contraparte
    if (/\b(salda|liquida|arregla|cancela)\s+todo\s+(con|de)\b/i.test(msg)) {
      intencion = 'saldar_todo_contraparte';
    }
    // "ahorré 200 para mi laptop" / "guardé 100 para el viaje" → abonar_meta
    if (/\b(ahorr[eé]|guard[eé]|met[ií]|apart[eé]|separ[eé])\b.+\b(para|a|en)\s+(mi\s+)?\w+/i.test(msg) && !/\b(meta|ahorro)\b.*\bcre/i.test(msg) && !/\b(debo|debe|prest|deuda)\b/i.test(msg)) {
      intencion = 'abonar_meta';
    }
    // "saqué 50 de mi fondo" / "retiré de mi meta" → abonar_meta (retiro)
    if (/\b(saqu[eé]|retir[eé]|quit[eé]|us[eé]|tom[eé])\b.+\b(de\s+mi|del|de\s+la)\s+\w+/i.test(msg) && /\b(meta|fondo|ahorro)\b/i.test(msg)) {
      intencion = 'abonar_meta';
    }
    // "comparte mi meta" / "invitar a mi meta" / "link de mi meta" → compartir_meta
    if (/\b(comparte?|invitar?|compartir|link)\b.+\b(meta|ahorro)\b/i.test(msg) || /\b(meta|ahorro)\b.+\b(comparte?|invitar?|compartir|link)\b/i.test(msg)) {
      intencion = 'compartir_meta';
    }
    // "pagué 300 la cena entre 4" / "split de 500 entre 3" / "dividir gasto" → dividir_gasto_grupal
    if (
  /\b(pagu[eé]|divid[eiír]|split|repartir)\b.+\bentre\s+\d+/i.test(msg) ||
  /\b(dividir|split|repartir)\s+(gasto|cuenta|cena|almuerzo|uber)\b/i.test(msg) ||
  /\b(pagu[eé]|divid[eiír])\b.+\bcon\s+\d+\s+(amigos?|personas?)/i.test(msg)
) {
  intencion = 'dividir_gasto_grupal';
}
    log.info({ tag: 'NLP', intencion, datos }, 'Intención clasificada');

    switch (intencion) {

      case 'ver_dashboard':
        return '📊 *Tu dashboard está en:*\n\n🔗 https://app.neto.pe\n\nAhí puedes ver gráficos, metas, reportes PDF, suscripciones y más.\n\n_Inicia sesión con tu cuenta de Google._';

      case 'listar_gastos_mes': {
        const fechaMinLgm = getHistoryDateLimit(usuario);
        // Si tiene 2+ cuentas Gmail y modo separado, mostrar por cuenta
        const cuentasGm = await obtenerCuentasGmail(usuario.id);
        if (cuentasGm.length >= 2 && usuario.reporte_gmail_modo === 'separado') {
          const mes2 = datos.mes || mesActual; const anio2 = datos.anio || anioActual;
          const desde2 = anio2+'-'+String(mes2).padStart(2,'0')+'-01';
          if (fechaMinLgm && desde2 < fechaMinLgm) return '🔒 Tu plan gratuito solo muestra el último mes de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
          const hasta2 = anio2+'-'+String(mes2).padStart(2,'0')+'-'+String(ultimoDiaMes(anio2,mes2)).padStart(2,'0');
          const { data: txsTodas } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde2).lte('fecha', hasta2);
          // Agrupar por cuenta_email (campo que se agrega en futuros registros)
          let respSep = '📊 *' + mE[mes2] + ' ' + anio2 + ' — por cuenta*\n\n';
          for (const c of cuentasGm) {
            const txsCuenta = (txsTodas||[]).filter(t => t.cuenta_email === c.email || (!t.cuenta_email && cuentasGm.indexOf(c) === 0));
            const totalC = txsCuenta.reduce((s,t) => s + parseFloat(t.monto_pen||t.monto||0), 0);
            respSep += '📧 *' + c.email + '*: S/ ' + totalC.toFixed(2) + ' (' + txsCuenta.length + ' movs)\n';
          }
          return respSep;
        }
        const mes = datos.mes || mesActual;
        const anio = datos.anio || anioActual;
        let txsMes;
        if (mes === mesActual && anio === anioActual) {
          txsMes = await obtenerGastosMes(usuario.id, fechaMinLgm);
        } else {
          const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
          if (fechaMinLgm && desde < fechaMinLgm) return '🔒 Tu plan gratuito solo muestra el último mes de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
          const hasta = anio + '-' + String(mes).padStart(2,'0') + '-' + String(ultimoDiaMes(anio, mes)).padStart(2,'0');
          const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
          txsMes = data || [];
        }
        const totalMesN = txsMes.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const porCatMes = {};
        const porSubMes = {};
        txsMes.forEach(t => {
          const cat = t.categoria || 'Otros'; const sub = t.subcategoria || 'sin_categoria';
          porCatMes[cat] = (porCatMes[cat]||0) + parseFloat(t.monto_pen || t.monto || 0);
          if (!porSubMes[cat]) porSubMes[cat] = {};
          porSubMes[cat][sub] = (porSubMes[cat][sub]||0) + parseFloat(t.monto_pen || t.monto || 0);
        });
        const catMesStr = Object.entries(porCatMes).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([c,m]) => (getEmojiCategoria(c)||'') + ' ' + c + ': S/ ' + m.toFixed(2)).join(', ');
        const subMesStr = Object.entries(porCatMes).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([c]) => {
          const subs = Object.entries(porSubMes[c]||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,m])=>s+' S/'+m.toFixed(2)).join(', ');
          return (getEmojiCategoria(c)||'') + c + ': ' + subs;
        }).join(' | ');
        const ctxMes = mE[mes] + ' ' + anio + ': ' + txsMes.length + ' movimientos. Total: S/ ' + totalMesN.toFixed(2) + '. Categorias con emoji: ' + (catMesStr || 'sin datos') + '. Subcategorias: ' + (subMesStr || 'sin datos') + '.';
        const respMes = await redactarConNETO(netoPrompt, ctxMes, msg, historialConv);
        return respMes || formatearResumen(txsMes, 'en ' + mE[mes]);
      }

      case 'listar_gastos_semana': {
        const txsSem = await obtenerGastosSemana(usuario.id);
        const totalSemN = txsSem.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const porCatSem = {};
        const porSubSem = {};
        txsSem.forEach(t => {
          const cat = t.categoria || 'Otros'; const sub = t.subcategoria || 'sin_categoria';
          porCatSem[cat] = (porCatSem[cat]||0) + parseFloat(t.monto_pen || t.monto || 0);
          if (!porSubSem[cat]) porSubSem[cat] = {};
          porSubSem[cat][sub] = (porSubSem[cat][sub]||0) + parseFloat(t.monto_pen || t.monto || 0);
        });
        const catSemStr = Object.entries(porCatSem).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([c,m]) => (getEmojiCategoria(c)||'') + ' ' + c + ': S/ ' + m.toFixed(2)).join(', ');
        // Comparativa semana anterior
        const hace14 = new Date(); hace14.setDate(hace14.getDate()-14);
        const hace7 = new Date(); hace7.setDate(hace7.getDate()-7);
        const { data: txsAnt } = await supabase.from('transacciones').select('monto,monto_pen').eq('usuario_id', usuario.id).eq('tipo','gasto').gte('fecha', hace14.toISOString().split('T')[0]).lte('fecha', hace7.toISOString().split('T')[0]);
        const totalAnt = (txsAnt||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const diffSem = totalSemN - totalAnt;
        const subSemStr = Object.entries(porCatSem).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c]) => {
          const subs = Object.entries(porSubSem[c]||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,m])=>s+' S/'+m.toFixed(2)).join(', ');
          return (getEmojiCategoria(c)||'') + c + ': ' + subs;
        }).join(' | ');
        const ctxSem = 'Semana: ' + txsSem.length + ' movimientos. Total: S/ ' + totalSemN.toFixed(2) + '. ' +
          (totalAnt > 0 ? 'Semana anterior: S/ ' + totalAnt.toFixed(2) + '. Diferencia: ' + (diffSem >= 0 ? '+' : '') + 'S/ ' + diffSem.toFixed(2) + '. ' : '') +
          'Top categorias con emoji: ' + (catSemStr || 'sin datos') + '. Subcategorias: ' + (subSemStr || 'sin datos') + '. ' +
          'Dia mas caro: ' + (txsSem.length > 0 ? txsSem.reduce((max,t) => parseFloat(t.monto_pen||t.monto||0) > parseFloat(max.monto_pen||max.monto||0) ? t : max, txsSem[0]).fecha : 'sin datos') +
          '.';
        const respSem = await redactarConNETO(netoPrompt, ctxSem, msg, historialConv);
        return respSem || formatearResumen(txsSem, 'esta semana');
      }

      case 'listar_gastos_dia': {
        // Usar fecha real de Perú; solo respetar datos.fecha si es una fecha explícita distinta a hoy/ayer
        const msgLDia = msg.toLowerCase();
        let fechaDia;
        if (msgLDia.includes('ayer')) {
          fechaDia = fechaAyerPeru();
        } else if (datos.fecha && !msgLDia.includes('hoy') && !msgLDia.includes('dia') && !msgLDia.includes('día')) {
          fechaDia = datos.fecha;
        } else {
          fechaDia = fechaHoyPeru();
        }
        const { data: txsDia } = await supabase.from('transacciones').select('*')
          .eq('usuario_id', usuario.id).eq('fecha', fechaDia).order('created_at', { ascending: false });
        if (!txsDia || txsDia.length === 0) return 'No tienes movimientos registrados el ' + formatFecha(fechaDia) + '.';
        const gastosDia = txsDia.filter(t => t.tipo !== 'ingreso');
        const ingresosDia = txsDia.filter(t => t.tipo === 'ingreso');
        const totalGDia = gastosDia.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const totalIDia = ingresosDia.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const porCatDia = {};
        gastosDia.forEach(t => { const c = t.categoria || 'Otros'; porCatDia[c] = (porCatDia[c]||0) + parseFloat(t.monto_pen || t.monto || 0); });
        const catDiaStr = Object.entries(porCatDia).sort((a,b)=>b[1]-a[1]).map(([c,m]) => (getEmojiCategoria(c)||'') + ' ' + c + ': S/ ' + m.toFixed(2)).join(', ');
        let ctxDia = formatFecha(fechaDia) + ': ' + txsDia.length + ' movimientos. ';
        if (gastosDia.length > 0) ctxDia += 'Gastos: S/ ' + totalGDia.toFixed(2) + ' en ' + gastosDia.length + ' transacciones. Categorias: ' + (catDiaStr || 'sin datos') + '. ';
        if (ingresosDia.length > 0) ctxDia += 'Ingresos: S/ ' + totalIDia.toFixed(2) + '. ';
        ctxDia += 'Detalle: ' + txsDia.slice(0,8).map(t => (t.tipo === 'ingreso' ? '💰' : '💸') + ' ' + (t.comercio||t.banco||'Pago') + ' ' + (t.moneda === 'USD' ? '$' : 'S/') + parseFloat(t.monto).toFixed(2) + ' [' + (t.categoria||'Otros') + ']').join(', ');
        const respDia = await redactarConNETO(netoPrompt, ctxDia, msg, historialConv);
        return respDia || '📊 *' + formatFecha(fechaDia) + '*\nGastos: S/ ' + totalGDia.toFixed(2) + ' (' + gastosDia.length + ' movimientos)\n\n' + catDiaStr;
      }

            case 'listar_gastos_categoria': {
        const fechaMinLgc = getHistoryDateLimit(usuario);
        const cat = datos.categoria;
        if (!cat) return 'Dime la categoria. Ej: _"gastos de Alimentación"_, _"que hay en Transporte"_';
        const mes = datos.mes || mesActual;
        const anio = datos.anio || anioActual;
        const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
        if (fechaMinLgc && desde < fechaMinLgc) return '🔒 Tu plan gratuito solo muestra el último mes de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
        const hasta = anio + '-' + String(mes).padStart(2,'0') + '-' + String(ultimoDiaMes(anio, mes)).padStart(2,'0');
        const { data: txs } = await supabase.from('transacciones').select('*')
          .eq('usuario_id', usuario.id).ilike('categoria', '%' + cat + '%')
          .gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
        if (!txs || txs.length === 0) return 'No encontre gastos en *' + cat + '* para ' + mE[mes] + ' ' + anio + '.';
        const total = txs.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto), 0);
        const emojiCat = getEmojiCategoria(cat) || '';
        let msgCat = emojiCat + ' *Gastos en ' + cat + '* (' + mE[mes] + ' ' + anio + ')\n\nTotal: *S/ ' + total.toFixed(2) + '*\n' + txs.length + ' transacciones\n\n';
        // Agrupar por subcategoria
        const porSub = {};
        txs.forEach(t => { const s = t.subcategoria || 'sin_categoria'; if (!porSub[s]) porSub[s] = []; porSub[s].push(t); });
        const subs = Object.keys(porSub);
        if (subs.length > 1 && subs.some(s => s !== 'sin_categoria')) {
          // Mostrar agrupado por subcategoria
          Object.entries(porSub).forEach(([sub, txsSub]) => {
            const totalSub = txsSub.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto), 0);
            msgCat += '*' + sub + '* — S/ ' + totalSub.toFixed(2) + '\n';
            txsSub.slice(0,4).forEach(t => { msgCat += '  • ' + (t.comercio || t.banco || 'Sin nombre') + ' S/ ' + parseFloat(t.monto_pen || t.monto).toFixed(2) + ' (' + formatFecha(t.fecha) + ')\n'; });
          });
        } else {
          txs.slice(0,10).forEach(t => { msgCat += '• ' + (t.comercio || t.banco || 'Sin nombre') + ' — S/ ' + parseFloat(t.monto_pen || t.monto).toFixed(2) + ' (' + formatFecha(t.fecha) + ')\n'; });
        }
        if (txs.length > 10) msgCat += '_...y ' + (txs.length-10) + ' mas_';
        return msgCat;
      }

      case 'ver_total_gastado': {
        const fechaMinVt = getHistoryDateLimit(usuario);
        const periodoVt = datos.periodo || 'mes';
        const catVt = datos.categoria;
        let txsVt = periodoVt === 'semana' ? await obtenerGastosSemana(usuario.id, fechaMinVt) : await obtenerGastosMes(usuario.id, fechaMinVt);
        if (catVt) txsVt = txsVt.filter(t => (t.categoria||'').toLowerCase().includes(catVt.toLowerCase()));
        const totalVt = txsVt.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const ctxVt = (catVt ? 'Categoria ' + catVt + ' en ' : 'Total ') + periodoVt + ': S/ ' + totalVt.toFixed(2) + ' en ' + txsVt.length + ' movimientos.';
        const respVt = await redactarConNETO(netoPrompt, ctxVt, msg, historialConv);
        return respVt || 'Llevas *S/ ' + totalVt.toFixed(2) + '* ' + (catVt ? 'en ' + catVt + ' ' : '') + 'esta ' + periodoVt + ' (' + txsVt.length + ' movimientos).';
      }
            case 'ver_presupuesto': {
        const presupStr = await formatearEstadoPresupuesto(usuario.id);
        const ctxVp = 'Estado del presupuesto del usuario: ' + presupStr.replace(/[*_]/g, '');
        const respVp = await redactarConNETO(netoPrompt, ctxVp, msg, historialConv);
        return respVp || presupStr;
      }

      case 'configurar_presupuesto': {
        if (datos.categoria && datos.monto) {
          const alertaPct = datos.alerta_porcentaje || 80;
          await guardarPresupuesto(usuario.id, datos.categoria, datos.monto);
          await supabase.from('presupuestos').update({ alerta_porcentaje: alertaPct }).eq('usuario_id', usuario.id).eq('categoria', datos.categoria);
          const emojiPres = getEmojiCategoria(datos.categoria) || '💰';
          return '✅ Presupuesto configurado:\n' + emojiPres + ' *' + datos.categoria + ':* S/ ' + parseFloat(datos.monto).toFixed(2) + '/mes\n🔔 Te aviso cuando llegues al ' + alertaPct + '%.\n\n_Puedes cambiar el % de alerta: "alerta de Comida al 70%"_';
        }
        return '💰 Dime la categoría y el monto.\n\nEj:\n• _"límite de S/500 en Alimentación"_\n• _"presupuesto S/200 en Transporte, aviso al 70%"_';
      }

      case 'ver_categorias':
        return formatearCategoriasMsg(await obtenerCategoriasUsuario(usuario.id));

      case 'ver_reporte': {
        const mesR = datos.mes || mesActual;
        const anioR = datos.anio || anioActual;
        return '📊 *Tu reporte de ' + mE[mesR] + ' ' + anioR + '*\n\n' +
          'Descarga tu PDF y ve tus gráficos en tu dashboard:\n\n' +
          '🔗 https://app.neto.pe/dashboard/reportes\n\n' +
          '_Inicia sesión con Google para ver tus datos._';
      }

      case 'corregir_categoria': {
        try {
          const catRaw = datos.categoria_nueva || datos.categoria || null;
          const _subRawTmp = datos.subcategoria_nueva || datos.subcategoria || null;
          const subRaw = (_subRawTmp && /^null$/i.test(String(_subRawTmp).trim())) ? null : _subRawTmp;
          const comercioRaw = datos.comercio || null;
          if (catRaw) {
            const catLibre = catRaw.charAt(0).toUpperCase() + catRaw.slice(1);
            const subLibre = subRaw ? subRaw.charAt(0).toUpperCase() + subRaw.slice(1) : null;
            let txActualizada = null;
            if (comercioRaw) {
              const res = await recategorizarTransaccion(usuario.id, comercioRaw, catLibre, subLibre);
              if (res.ok) txActualizada = res.tx || { comercio: comercioRaw, monto: null, moneda: 'PEN' };
              if (!res.ok) return res.msg;
            } else {
              txActualizada = await obtenerUltimaTransaccion(usuario.id);
              if (txActualizada) {
                const updFields = { categoria: catLibre };
                if (subLibre) updFields.subcategoria = subLibre;
                await supabase.from('transacciones').update(updFields).eq('id', txActualizada.id);
              } else {
                return '\u00bfDe qu\u00e9 gasto hablamos? D\u00edme el comercio y lo muevo.';
              }
            }
            // Crear categoría en categorias_usuario si es libre (no canónica)
            if (!CATEGORIAS_VALIDAS.has(catLibre) && !CATEGORIA_MAP[catLibre]) {
              crearCategoriaLibreUsuario(usuario.id, catLibre);
            }
            // Crear subcategoría si el usuario la especificó
            if (subLibre && subLibre !== 'Sin_categoria') {
              crearSubcategoriaLibreUsuario(usuario.id, catLibre, subLibre);
            }
            // Guardar regla y retroaplicar usando el comercio REAL de la DB (no el del usuario, que puede tener typos)
            const comercioReal = txActualizada?.comercio || comercioRaw;
            if (comercioReal) {
              guardarReglaComercio(usuario.id, comercioReal, catLibre, subLibre);
              retroaplicarRegla(usuario.id, comercioReal, catLibre, subLibre);
            }
            // Respuesta con moneda correcta
            const monedaTxCorr = txActualizada.moneda || 'PEN';
            const montoMostrar = monedaTxCorr === 'USD'
              ? '$' + parseFloat(txActualizada.monto || 0).toFixed(2) + (txActualizada.monto_pen ? ' (~S/' + parseFloat(txActualizada.monto_pen).toFixed(2) + ')' : '')
              : 'S/ ' + parseFloat(txActualizada.monto_pen || txActualizada.monto || 0).toFixed(2);
            return 'Listo! Movi *' + (txActualizada.comercio || 'el gasto') + '* (' + montoMostrar + ') a *' + catLibre + (subLibre ? ' > ' + subLibre : '') + '*.\n\n_Aplique el cambio a todos los pagos anteriores de ' + (comercioReal || 'ese comercio') + '._';
          }
          const ultimaTx2 = await obtenerUltimaTransaccion(usuario.id);
          const _ctxCorr = 'El usuario quiere mover un gasto pero no especifico la categoria. Ultimo gasto: ' + (ultimaTx2 ? ultimaTx2.comercio + ' ' + (ultimaTx2.moneda === 'USD' ? '$' : 'S/') + ultimaTx2.monto : 'sin datos') + '. Pregunta a que categoria moverlo. Puede ser una categoria personalizada.';
          const _respCorr = await redactarConNETO(netoPrompt, _ctxCorr, msg, historialConv);
          return _respCorr || '\u00bfA qu\u00e9 categor\u00eda lo muevo? D\u00edme y lo cambio.';
        } catch(e) {
          log.error({ tag: 'CORREGIR', err: e.message }, 'Error corrigiendo categoría');
          return 'No pude procesar eso. Usa: /cambiar [comercio] [categoria]';
        }
      }
      case 'corregir_multiple': {
        try {
          const correcciones = await parsearCorreccionesMultiples(msg);
          if (!correcciones || correcciones.length === 0) {
            return 'No pude entender las correcciones. Dime una por una: "Netflix pasalo a Entretenimiento".';
          }
          const resultados = [];
          for (const corr of correcciones) {
            if (!corr.comercio || !corr.categoria_nueva) continue;
            const catLibre = corr.categoria_nueva.charAt(0).toUpperCase() + corr.categoria_nueva.slice(1);
            const _subCorrTmp = corr.subcategoria_nueva ? corr.subcategoria_nueva.charAt(0).toUpperCase() + corr.subcategoria_nueva.slice(1) : null;
            const res = await corregirTransaccionEspecifica(usuario.id, corr.comercio, corr.monto, corr.fecha, catLibre, _subCorrTmp);
            if (!CATEGORIAS_VALIDAS.has(catLibre) && !CATEGORIA_MAP[catLibre]) {
              crearCategoriaLibreUsuario(usuario.id, catLibre);
            }
            const subCorr = corr.subcategoria_nueva ? corr.subcategoria_nueva.charAt(0).toUpperCase() + corr.subcategoria_nueva.slice(1) : null;
            if (subCorr && subCorr !== 'Sin_categoria') {
              crearSubcategoriaLibreUsuario(usuario.id, catLibre, subCorr);
            }
            if (res.ok) {
              guardarReglaComercio(usuario.id, corr.comercio, catLibre, subCorr || null);
              retroaplicarRegla(usuario.id, corr.comercio, catLibre, subCorr || null);
              const montoStr = res.moneda === 'USD' ? '$' + parseFloat(res.monto).toFixed(2) : 'S/ ' + parseFloat(res.monto).toFixed(2);
              resultados.push('✅ *' + res.comercio + '* (' + montoStr + ') → ' + catLibre);
            } else {
              resultados.push('❌ No encontré gasto de *' + corr.comercio + '*');
            }
          }
          if (resultados.length === 0) return 'No pude aplicar ninguna corrección.';
          return 'Listo! Actualicé ' + resultados.length + ' gastos:\n\n' + resultados.join('\n');
        } catch(e) {
          log.error({ tag: 'MULT', err: e.message }, 'Error corrección múltiple');
          return 'No pude procesar las correcciones. Intenta una por una.';
        }
      }

      case 'ver_pendientes': {
        const lpend = await obtenerConsultasPendientes(usuario.id);
        return lpend.length === 0 ? 'No tienes gastos pendientes. Todo al dia! \uD83D\uDC4D' : formatearPendientes(lpend);
      }

      case 'escanear_gmail': {
        const planConfigGmail = getUserPlanConfig(usuario);
        if (planConfigGmail.maxGmailAccounts === 0) {
          return '⭐ *Lectura de correos es una función Pro.*\n\nCon Pro, Neto lee tus correos bancarios automáticamente.\n\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        return (await escanearGmailYRegistrar(usuario)) || 'No encontre correos bancarios nuevos. Te aviso automaticamente cuando llegue uno.';
      }

      case 'agregar_gmail':
        return '📧 Por el momento solo se permite una cuenta Gmail por usuario.\n\nSi necesitas ayuda, escríbenos al 970398192.';

      case 'cambiar_gmail':
        return '📧 Para cambiar tu cuenta Gmail, escríbenos al 970398192.\n\n_El cambio requiere verificación manual._';

      case 'preferencia_reporte_gmail': {
        const modoNuevo = datos.modo || 'unificado';
        await supabase.from('usuarios').update({ reporte_gmail_modo: modoNuevo }).eq('id', usuario.id);
        const cuentasConf = await obtenerCuentasGmail(usuario.id);
        if (modoNuevo === 'separado' && cuentasConf.length < 2) {
          return '⚠️ Solo tienes una cuenta Gmail conectada. Agrega otra con _"agregar otro correo"_ para ver reportes separados.';
        }
        return modoNuevo === 'separado'
          ? '✅ Reportes configurados: *separados por cuenta*.\nVerás cada Gmail por separado en tus resúmenes y reportes.'
          : '✅ Reportes configurados: *unificados*.\nTodos tus correos se consolidan en un solo reporte.';
      }

      case 'ver_premium': {
        if (usuario.plan === 'premium') {
          const tipoPlanVp = usuario.tipo_plan || 'mensual';
          const venceVp = (usuario.premium_vence || usuario.fecha_vencimiento) ? new Date(usuario.premium_vence || usuario.fecha_vencimiento).toLocaleDateString('es-PE') : null;
          return '⭐ *Tu plan NETO Pro*\n\nPlan: *' + (tipoPlanVp === 'anual' ? 'Anual' : 'Mensual') + '*' + (venceVp ? '\nVence: ' + venceVp : '') + '\n\n✅ Historial ilimitado\n✅ Lectura automática de correos\n✅ Reportes PDF + CSV export\n✅ Recordatorios diarios\n✅ Consejos IA ilimitados';
        }
        return '⭐ *NETO Pro*\n\nDesbloquea todo el potencial de Neto:\n\n✅ Historial completo (no solo 1 mes)\n✅ Lectura automática de correos bancarios\n✅ Reportes PDF + exportar datos\n✅ Recordatorios diarios\n✅ Consejos IA ilimitados\n\n💰 *S/10/mes* o *S/99/año* (2 meses gratis)\n\n📲 Yapea al *970398192* (Favio Mendoza) y envíame la captura aquí.\n\n_¿Dudas? Escríbeme._';
      }

      case 'registrar_manual': {
        try {
          const fechaHoy = hoyPeru();
          const parsed = await parsearRegistroManual(msg, fechaHoy);
          if (!parsed.ok || !parsed.monto || parsed.monto <= 0) {
            return 'No pude extraer el monto. Dime algo como: "gasté S/50 en farmacia" o "mi sueldo fue S/4500".';
          }
          // Re-clasificar con categorías y subcategorías custom del usuario
          const detCat = await detectarCategoriaIA(msg, usuario.id);
          if (detCat.categoria) {
            parsed.categoria = detCat.categoria;
            if (detCat.subcategoria) parsed.subcategoria = detCat.subcategoria;
          }
          // Auto-crear categoría/subcategoría custom si es nueva
          if (parsed.categoria && !CATEGORIAS_VALIDAS.has(parsed.categoria) && !CATEGORIA_MAP[parsed.categoria]) {
            crearCategoriaLibreUsuario(usuario.id, parsed.categoria);
          }
          if (parsed.subcategoria && parsed.subcategoria !== 'sin_categoria') {
            crearSubcategoriaLibreUsuario(usuario.id, parsed.categoria, parsed.subcategoria);
          }
          const tx = await guardarTransaccion(usuario.id, parsed);
          const esIngreso = parsed.tipo === 'ingreso';
          const montoStr = parsed.moneda === 'USD' ? '$' + parseFloat(parsed.monto).toFixed(2) : 'S/' + parseFloat(parsed.monto).toFixed(2);
          let respReg = '✅ ' + montoStr + ' en ' + (esIngreso ? 'Ingresos' : (parsed.categoria || 'Otros') + ' > ' + (parsed.subcategoria || 'sin_categoria')) + ' · ' + formatFecha(parsed.fecha);
          if (!esIngreso && parsed.categoria) {
            const alerta = await verificarAlertaPresupuesto(usuario.id, parsed.categoria, parsed.subcategoria || null);
            if (alerta) respReg += '\n\n' + alerta;
          }
          // Cada 5 registros, recordar la app
          const { count: txCount } = await supabase.from('transacciones')
            .select('*', { count: 'exact', head: true })
            .eq('usuario_id', usuario.id);
          if (txCount && txCount % 5 === 0) {
            respReg += '\n\n💡 _Revisa tus gráficos en https://app.neto.pe_';
          }
          return respReg;
        } catch(e) {
          log.error({ tag: 'REGISTRAR_MANUAL', err: e.message }, 'Error registro manual');
          return 'No pude procesar eso. Dime: "gasté S/50 en farmacia ayer" y lo anoto.';
        }
      }

      case 'corregir_monto_moneda': {
        try {
          const ultimaTxM = await obtenerUltimaTransaccion(usuario.id);
          if (!ultimaTxM) return 'No encuentro el gasto al que te refieres. \u00bfDe cu\u00e1l se trata?';
          const updates = {};
          const nuevaMoneda = datos.moneda || 'USD'; // si mencionaron "dolares" sin especificar, asumimos USD
          const nuevoMonto = datos.monto ? parseFloat(datos.monto) : parseFloat(ultimaTxM.monto);
          updates.moneda = nuevaMoneda;
          updates.monto = nuevoMonto;
          if (nuevaMoneda === 'USD') {
            const tc = await obtenerTipoCambio();
            updates.monto_pen = parseFloat((nuevoMonto * tc.venta).toFixed(2));
            updates.tipo_cambio = tc.venta;
          } else {
            updates.monto_pen = nuevoMonto;
            updates.tipo_cambio = null;
          }
          await supabase.from('transacciones').update(updates).eq('id', ultimaTxM.id);
          const comercioM = ultimaTxM.comercio || 'el gasto';
          const montoStrM = nuevaMoneda === 'USD'
            ? '$' + nuevoMonto.toFixed(2) + ' (~S/ ' + updates.monto_pen.toFixed(2) + ')'
            : 'S/ ' + nuevoMonto.toFixed(2);
          return 'Corregido. *' + comercioM + '*: ' + montoStrM + ' en ' + (ultimaTxM.categoria || 'Otros') + '.';
        } catch(e) {
          log.error({ tag: 'CORREGIR_MONEDA', err: e.message }, 'Error corrigiendo monto/moneda');
          return 'No pude corregir la moneda. Int\u00e9ntalo de nuevo.';
        }
      }

      case 'eliminar_transaccion': {
        try {
          const comercioElim = datos.comercio || null;
          let txElim = null;
          if (comercioElim) {
            const { data: txsElim } = await supabase.from('transacciones').select('*')
              .eq('usuario_id', usuario.id).ilike('comercio', '%' + comercioElim + '%')
              .order('created_at', { ascending: false }).limit(1);
            txElim = txsElim?.[0] || null;
          } else {
            txElim = await obtenerUltimaTransaccion(usuario.id);
          }
          if (!txElim) return '\u00bfDe qu\u00e9 gasto me hablas? D\u00edme el comercio y lo elimino.';
          // Limpiar consultas_pendientes asociadas antes de eliminar
          await supabase.from('consultas_pendientes').update({ estado: 'respondida', respondida_at: new Date().toISOString() }).eq('transaccion_id', txElim.id).eq('estado', 'pendiente');
          // Si es transacción de Gmail, guardar en excluidos para evitar re-importación
          if (txElim.descripcion_original && !txElim.descripcion_original.startsWith('duplicado:')) {
            await supabase.from('gmail_excluidos').upsert({ usuario_id: usuario.id, descripcion_original: txElim.descripcion_original }, { onConflict: 'usuario_id,descripcion_original' }).then(() => {}).catch(() => {});
          }
          await supabase.from('transacciones').delete().eq('id', txElim.id);
          const montoElim = txElim.moneda === 'USD' ? '$' + parseFloat(txElim.monto).toFixed(2) : 'S/ ' + parseFloat(txElim.monto).toFixed(2);
          return 'Listo. Elimin\u00e9 *' + (txElim.comercio || 'ese gasto') + '* (' + montoElim + ') del ' + txElim.fecha + '.';
        } catch(e) {
          log.error({ tag: 'ELIMINAR', err: e.message }, 'Error eliminando transacción');
          return 'No pude eliminarlo. \u00bfDe cu\u00e1l gasto se trata?';
        }
      }

      case 'ver_referidos': {
        let refCode = usuario.ref_code;
        if (!refCode) {
          refCode = generarRefCode();
          await supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id);
        }
        const { data: misRefsNlp } = await supabase.from('referidos').select('activo').eq('referrer_id', usuario.id);
        const totalRefsNlp = (misRefsNlp || []).length;
        const activosNlp = (misRefsNlp || []).filter(r => r.activo).length;
        const railwayUrlRef = process.env.RAILWAY_URL || 'https://api.neto.pe';
        const mesesAcumNlp = Math.floor(activosNlp / 3);
        const progresoNlp = activosNlp % 3;
        let estadoRefNlp = '_Referidos: ' + totalRefsNlp + ' | Activos: ' + activosNlp + '_';
        if (mesesAcumNlp > 0) {
          estadoRefNlp += '\n✅ *' + (mesesAcumNlp === 1 ? '1 mes' : mesesAcumNlp + ' meses') + ' gratis ganado' + (mesesAcumNlp > 1 ? 's' : '') + '*';
          if (progresoNlp > 0) estadoRefNlp += ' | ' + progresoNlp + '/3 para el siguiente';
        } else {
          estadoRefNlp += ' | ' + progresoNlp + '/3 para tu primer mes gratis';
        }
        return '🎁 *Tu link de referido:*\n\n' + railwayUrlRef + '/r/' + refCode + '\n\nComparte con amigos. Cada *3 referidos* te dan *1 mes gratis* de Neto. 🎉\n\n' + estadoRefNlp;
      }

      case 'ver_recomendaciones': {
        // Consejo IA es Pro-only
        const planConfigRecom = getUserPlanConfig(usuario);
        if (planConfigRecom.consejoPerWeek === 0) {
          return '⭐ *Consejos IA es una función Pro*\n\nCon NETO Pro recibes consejos financieros personalizados todos los días.\n\n💰 *S/10/mes* o *S/99/año*\n\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._';
        }
        const tipoRecom = datos.tipo || 'general';
        const varianteMap = { score: 'on_demand_score', excesos: 'on_demand_excesos', patrones: 'on_demand_excesos', general: 'on_demand_general' };
        const varianteRecom = varianteMap[tipoRecom] || 'on_demand_general';
        const recom = await generarRecomendaciones(usuario.id, usuario.nombre, varianteRecom);
        if (recom && recom.mensaje) return recom.mensaje;
        // Fallback sin IA
        const datosRecom = await construirDatosUsuario(usuario.id);
        const miniRecom = generarMiniRecomendacion(datosRecom, usuario.nombre);
        return miniRecom || 'Aún no tengo suficientes datos para darte recomendaciones. Sigue registrando tus gastos y en unos días te doy un análisis completo. ¿Revisamos algo más?';
      }

      case 'saludo': {
        const gastosSaludo = await obtenerGastosMes(usuario.id);
        const totalSaludo = gastosSaludo.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const _partsSaludo = hoyPeru().split('-');
        const { data: ingresosSaludo } = await supabase.from('transacciones').select('monto_pen,monto').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', _partsSaludo[0] + '-' + _partsSaludo[1] + '-01');
        const totalIngresosSaludo = (ingresosSaludo || []).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const pendSaludo = await obtenerConsultasPendientes(usuario.id);
        const ctxSaludo = 'El usuario saluda. Contexto: este mes lleva S/ ' + totalSaludo.toFixed(0) + ' en gastos (' + gastosSaludo.length + ' movimientos)' + (totalIngresosSaludo > 0 ? ', S/ ' + totalIngresosSaludo.toFixed(0) + ' en ingresos registrados, balance S/ ' + (totalIngresosSaludo - totalSaludo).toFixed(0) : ', sin ingresos registrados') + '.' +
          (pendSaludo.length > 0 ? ' Tiene ' + pendSaludo.length + ' gasto(s) sin identificar.' : ' Sin pendientes.');
        const respSaludo = await redactarConNETO(netoPrompt, ctxSaludo, msg, historialConv);
        return respSaludo || ('\uD83D\uDC4B Hola' + (usuario.nombre ? ', ' + usuario.nombre.split(' ')[0] : '') + '. Soy NETO.\n\nEste mes llevas *S/ ' + totalSaludo.toFixed(0) + '* en ' + gastosSaludo.length + ' movimientos.\n\n\u00bfQue revisamos?');
      }
            case 'ayuda': {
        const ctxAyu = 'El usuario pregunta que puede hacer NETO o como funciona. Explica brevemente las capacidades: ver gastos, resumen semanal y mensual, presupuestos, reporte PDF, corregir categorias. Todo en tono NETO.';
        const respAyu = await redactarConNETO(netoPrompt, ctxAyu, msg, historialConv);
        return respAyu || 'Puedo ayudarte con tus gastos, presupuestos y reportes. Escribe como quieras: _"cuanto gaste esta semana"_, _"como va mi delivery"_, _"dame mi reporte"_. \u00bfPor donde empezamos?';
      }

      case 'cargar_excel': {
        return '📊 *Carga de gastos e ingresos históricos*\n\n' +
          '1️⃣ Descarga la plantilla: neto.pe/plantilla_gastos.xlsx\n' +
          '2️⃣ Completa tus movimientos (máximo 500)\n' +
          '3️⃣ Envíame el archivo por este chat\n\n' +
          '_Tipo, categoría y método de pago son opcionales — NETO los asigna automáticamente con IA._ 🤖';
      }

      case 'desconectar_cuenta': {
        const cuentasDesc = await obtenerCuentasGmail(usuario.id);
        await supabase.from('usuarios').update({ onboarding_paso: -1 }).eq('id', usuario.id);
        let menuDesc = '⚠️ *Desconectar cuenta*\n\n';
        if (cuentasDesc.length > 1) {
          menuDesc += 'Cuentas conectadas:\n' + cuentasDesc.map((c, i) => (i + 1) + '. 📧 ' + c.email).join('\n') + '\n\n';
          menuDesc += '¿Qué deseas hacer?\n\n';
          menuDesc += cuentasDesc.map((c, i) => (i + 1) + '️⃣ *Desconectar ' + c.email + '*').join('\n') + '\n';
          menuDesc += (cuentasDesc.length + 1) + '️⃣ *Desconectar todas* — Conservo tu historial\n';
          menuDesc += (cuentasDesc.length + 2) + '️⃣ *Eliminar todo* — Borro todos tus datos (irreversible)\n\n';
          menuDesc += '_Responde con el número._';
        } else if (cuentasDesc.length === 1) {
          menuDesc += 'Cuenta conectada: 📧 ' + cuentasDesc[0].email + '\n\n';
          menuDesc += '¿Qué deseas hacer?\n\n';
          menuDesc += '1️⃣ *Solo desconectar* — Desvinculo tu Gmail pero conservo tu historial de gastos. Puedes volver a conectarte cuando quieras.\n\n';
          menuDesc += '2️⃣ *Eliminar todo* — Borro todos tus datos (gastos, categorías, configuración). Esta acción es irreversible.\n\n';
          menuDesc += '_Responde 1 o 2._';
        } else {
          menuDesc += 'No tienes cuentas Gmail conectadas.\n\n';
          menuDesc += '1️⃣ *Eliminar mis datos* — Borro todos tus gastos, categorías y configuración. Irreversible.\n\n';
          menuDesc += '_Responde 1 para confirmar o cualquier otra cosa para cancelar._';
        }
        return menuDesc;
      }

      // ===== NUEVAS INTENCIONES (26-43) =====

      case 'comparar_meses': {
        try {
          const mes1 = datos.mes1 || mesActual;
          const anio1 = datos.anio1 || anioActual;
          const mes2Raw = datos.mes2 || (mes1 === 1 ? 12 : mes1 - 1);
          const anio2 = datos.anio2 || (mes1 === 1 ? anioActual - 1 : anioActual);
          const desde1 = anio1 + '-' + String(mes1).padStart(2,'0') + '-01';
          const hasta1 = anio1 + '-' + String(mes1).padStart(2,'0') + '-' + String(ultimoDiaMes(anio1, mes1)).padStart(2,'0');
          const desde2 = anio2 + '-' + String(mes2Raw).padStart(2,'0') + '-01';
          const hasta2 = anio2 + '-' + String(mes2Raw).padStart(2,'0') + '-' + String(ultimoDiaMes(anio2, mes2Raw)).padStart(2,'0');
          const [{ data: txs1 }, { data: txs2 }] = await Promise.all([
            supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desde1).lte('fecha', hasta1),
            supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desde2).lte('fecha', hasta2)
          ]);
          const total1 = (txs1||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const total2 = (txs2||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const diff = total1 - total2;
          const pct = total2 > 0 ? ((diff / total2) * 100).toFixed(0) : 0;
          // Top categorías que cambiaron
          const porCat1 = {}; (txs1||[]).forEach(t => { const c = t.categoria || 'Otros'; porCat1[c] = (porCat1[c]||0) + parseFloat(t.monto_pen || t.monto || 0); });
          const porCat2 = {}; (txs2||[]).forEach(t => { const c = t.categoria || 'Otros'; porCat2[c] = (porCat2[c]||0) + parseFloat(t.monto_pen || t.monto || 0); });
          const allCats = [...new Set([...Object.keys(porCat1), ...Object.keys(porCat2)])];
          const cambios = allCats.map(c => ({ cat: c, m1: porCat1[c]||0, m2: porCat2[c]||0, diff: (porCat1[c]||0) - (porCat2[c]||0) }))
            .sort((a,b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0,4);
          const cambiosStr = cambios.map(c => (getEmojiCategoria(c.cat)||'') + c.cat + ': S/' + c.m1.toFixed(0) + ' vs S/' + c.m2.toFixed(0) + ' (' + (c.diff > 0 ? '+' : '') + c.diff.toFixed(0) + ')').join(', ');
          const ctxComp = mE[mes1] + ' ' + anio1 + ': S/' + total1.toFixed(2) + ' (' + (txs1||[]).length + ' gastos) vs ' + mE[mes2Raw] + ' ' + anio2 + ': S/' + total2.toFixed(2) + ' (' + (txs2||[]).length + ' gastos). Diferencia: ' + (diff > 0 ? '+' : '') + 'S/' + diff.toFixed(2) + ' (' + (diff > 0 ? '+' : '') + pct + '%). Categorias con mayor cambio: ' + cambiosStr;
          const respComp = await redactarConNETO(netoPrompt, ctxComp, msg, historialConv);
          return respComp || '📊 *' + mE[mes1] + ' vs ' + mE[mes2Raw] + '*\n\n' + mE[mes1] + ': S/ ' + total1.toFixed(2) + '\n' + mE[mes2Raw] + ': S/ ' + total2.toFixed(2) + '\nDiferencia: ' + (diff > 0 ? '+' : '') + 'S/ ' + diff.toFixed(2) + ' (' + (diff > 0 ? '+' : '') + pct + '%)';
        } catch(e) {
          log.error({ tag: 'COMPARAR', err: e.message }, 'Error comparando meses');
          return 'No pude comparar los meses. Intenta: "compara marzo con febrero".';
        }
      }

      case 'buscar_gasto': {
        try {
          const comercioBusq = datos.comercio;
          if (!comercioBusq) return 'Dime el comercio o servicio. Ej: _"cuánto gasté en Uber"_, _"pagos de Netflix"_.';
          const mesBusq = datos.mes || mesActual;
          const anioBusq = datos.anio || anioActual;
          const desdeBusq = anioBusq + '-' + String(mesBusq).padStart(2,'0') + '-01';
          const hastaBusq = anioBusq + '-' + String(mesBusq).padStart(2,'0') + '-' + String(ultimoDiaMes(anioBusq, mesBusq)).padStart(2,'0');
          const { data: txsBusq } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id).ilike('comercio', '%' + comercioBusq + '%')
            .gte('fecha', desdeBusq).lte('fecha', hastaBusq).order('fecha', { ascending: false });
          if (!txsBusq || txsBusq.length === 0) return 'No encontré gastos de *' + comercioBusq + '* en ' + mE[mesBusq] + ' ' + anioBusq + '.';
          const totalBusq = txsBusq.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          let msgBusq = '🔍 *Gastos en ' + comercioBusq + '* (' + mE[mesBusq] + ' ' + anioBusq + ')\n\nTotal: *S/ ' + totalBusq.toFixed(2) + '* en ' + txsBusq.length + ' pago' + (txsBusq.length > 1 ? 's' : '') + '\n\n';
          txsBusq.slice(0,8).forEach(t => {
            const montoB = t.moneda === 'USD' ? '$' + parseFloat(t.monto).toFixed(2) : 'S/ ' + parseFloat(t.monto_pen || t.monto).toFixed(2);
            msgBusq += '• ' + montoB + ' — ' + formatFecha(t.fecha) + ' [' + (t.categoria || 'Otros') + ']\n';
          });
          if (txsBusq.length > 8) msgBusq += '_...y ' + (txsBusq.length - 8) + ' más_';
          return msgBusq;
        } catch(e) {
          log.error({ tag: 'BUSCAR', err: e.message }, 'Error buscando gasto');
          return 'No pude buscar ese gasto. Intenta de nuevo.';
        }
      }

      case 'ver_ingresos': {
        try {
          const mesIng = datos.mes || mesActual;
          const anioIng = datos.anio || anioActual;
          const periodoIng = datos.periodo || 'mes';
          let txsIng;
          if (periodoIng === 'semana') {
            const hace7 = new Date(); hace7.setDate(hace7.getDate() - 7);
            const desdeIng = hace7.toISOString().split('T')[0];
            const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', desdeIng).order('fecha', { ascending: false });
            txsIng = data || [];
          } else {
            const desdeIng = anioIng + '-' + String(mesIng).padStart(2,'0') + '-01';
            const hastaIng = anioIng + '-' + String(mesIng).padStart(2,'0') + '-' + String(ultimoDiaMes(anioIng, mesIng)).padStart(2,'0');
            const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', desdeIng).lte('fecha', hastaIng).order('fecha', { ascending: false });
            txsIng = data || [];
          }
          if (txsIng.length === 0) return 'No tienes ingresos registrados ' + (periodoIng === 'semana' ? 'esta semana' : 'en ' + mE[mesIng]) + '.\n\n_Registra ingresos: "mi sueldo fue S/4500"_';
          const totalIng = txsIng.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const detalleIng = txsIng.slice(0,6).map(t => '💰 ' + (t.comercio || t.banco || 'Ingreso') + ' — ' + (t.moneda === 'USD' ? '$' : 'S/ ') + parseFloat(t.monto).toFixed(2) + ' (' + formatFecha(t.fecha) + ')').join('\n');
          const ctxIng = 'Ingresos ' + (periodoIng === 'semana' ? 'de la semana' : 'de ' + mE[mesIng] + ' ' + anioIng) + ': S/ ' + totalIng.toFixed(2) + ' en ' + txsIng.length + ' movimientos. Detalle: ' + detalleIng.replace(/\n/g, ', ');
          const respIng = await redactarConNETO(netoPrompt, ctxIng, msg, historialConv);
          return respIng || '💰 *Ingresos ' + (periodoIng === 'semana' ? 'de la semana' : 'de ' + mE[mesIng]) + '*\n\nTotal: *S/ ' + totalIng.toFixed(2) + '*\n\n' + detalleIng;
        } catch(e) {
          log.error({ tag: 'INGRESOS', err: e.message }, 'Error consultando ingresos');
          return 'No pude consultar tus ingresos. Intenta de nuevo.';
        }
      }

      case 'ver_balance': {
        try {
          const mesBal = datos.mes || mesActual;
          const anioBal = datos.anio || anioActual;
          const desdeBal = anioBal + '-' + String(mesBal).padStart(2,'0') + '-01';
          const hastaBal = anioBal + '-' + String(mesBal).padStart(2,'0') + '-' + String(ultimoDiaMes(anioBal, mesBal)).padStart(2,'0');
          const [{ data: gastosBal }, { data: ingresosBal }] = await Promise.all([
            supabase.from('transacciones').select('monto_pen,monto').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desdeBal).lte('fecha', hastaBal),
            supabase.from('transacciones').select('monto_pen,monto').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', desdeBal).lte('fecha', hastaBal)
          ]);
          const totalGBal = (gastosBal||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const totalIBal = (ingresosBal||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const balance = totalIBal - totalGBal;
          const pctGasto = totalIBal > 0 ? ((totalGBal / totalIBal) * 100).toFixed(0) : null;
          const ctxBal = 'Balance de ' + mE[mesBal] + ' ' + anioBal + ': Ingresos S/' + totalIBal.toFixed(2) + ', Gastos S/' + totalGBal.toFixed(2) + ', Balance ' + (balance >= 0 ? '+' : '') + 'S/' + balance.toFixed(2) + (pctGasto ? '. Ha gastado ' + pctGasto + '% de sus ingresos.' : '. Sin ingresos registrados — solo se muestran gastos.');
          const respBal = await redactarConNETO(netoPrompt, ctxBal, msg, historialConv);
          return respBal || (balance >= 0
            ? '✅ *Balance ' + mE[mesBal] + '*\n\n💰 Ingresos: S/ ' + totalIBal.toFixed(2) + '\n💸 Gastos: S/ ' + totalGBal.toFixed(2) + '\n📊 Balance: *+S/ ' + balance.toFixed(2) + '*'
            : '⚠️ *Balance ' + mE[mesBal] + '*\n\n💰 Ingresos: S/ ' + totalIBal.toFixed(2) + '\n💸 Gastos: S/ ' + totalGBal.toFixed(2) + '\n📊 Balance: *-S/ ' + Math.abs(balance).toFixed(2) + '*');
        } catch(e) {
          log.error({ tag: 'BALANCE', err: e.message }, 'Error calculando balance');
          return 'No pude calcular tu balance. Intenta de nuevo.';
        }
      }

      case 'ver_suscripciones': {
        try {
          // Buscar comercios que aparecen en al menos 2 meses distintos
          const hace90 = new Date(); hace90.setDate(hace90.getDate() - 90);
          const desdeSub = hace90.toISOString().split('T')[0];
          const { data: txsSub } = await supabase.from('transacciones').select('comercio,monto,monto_pen,fecha,categoria')
            .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desdeSub).order('fecha', { ascending: false });
          if (!txsSub || txsSub.length === 0) return 'No tengo suficiente historial para detectar suscripciones. Sigue registrando y en unas semanas te muestro tus pagos recurrentes.';
          const porComercio = {};
          (txsSub||[]).forEach(t => {
            const c = (t.comercio||'').toLowerCase().trim();
            if (!c || c.length < 3) return;
            const mesKey = t.fecha.substring(0,7);
            if (!porComercio[c]) porComercio[c] = { nombre: t.comercio, meses: new Set(), montos: [], cat: t.categoria };
            porComercio[c].meses.add(mesKey);
            porComercio[c].montos.push(parseFloat(t.monto_pen || t.monto || 0));
          });
          const recurrentes = Object.values(porComercio)
            .filter(c => c.meses.size >= 2)
            .map(c => ({ nombre: c.nombre, meses: c.meses.size, promedio: c.montos.reduce((s,m)=>s+m,0)/c.montos.length, cat: c.cat }))
            .sort((a,b) => b.promedio - a.promedio);
          if (recurrentes.length === 0) return 'No detecté pagos recurrentes en tus últimos 3 meses. Si tienes suscripciones, regístralas y las rastreo automáticamente.';
          const totalSub = recurrentes.reduce((s,r) => s + r.promedio, 0);
          let msgSub = '🔄 *Pagos recurrentes detectados*\n\nTotal estimado mensual: *S/ ' + totalSub.toFixed(2) + '*\n\n';
          recurrentes.slice(0,10).forEach(r => {
            msgSub += '• ' + (r.nombre || 'Sin nombre') + ' — ~S/ ' + r.promedio.toFixed(2) + '/mes [' + (r.cat || 'Otros') + ']\n';
          });
          msgSub += '\n_Basado en pagos de los últimos 3 meses._';
          return msgSub;
        } catch(e) {
          log.error({ tag: 'SUBS', err: e.message }, 'Error detectando suscripciones');
          return 'No pude detectar tus suscripciones. Intenta de nuevo.';
        }
      }

      case 'ver_tipo_cambio': {
        try {
          const tc = await obtenerTipoCambio();
          return '💵 *Tipo de cambio USD/PEN*\n\n🟢 Compra: S/ ' + tc.compra.toFixed(4) + '\n🔴 Venta: S/ ' + tc.venta.toFixed(4) + '\n\n_Fuente: dolar.pe_';
        } catch(e) {
          return '💵 No pude obtener el tipo de cambio actual. Intenta en unos minutos.';
        }
      }

      case 'editar_monto': {
        try {
          const montoNuevo = datos.monto_nuevo ? parseFloat(datos.monto_nuevo) : null;
          if (!montoNuevo || montoNuevo <= 0) return 'Dime el monto correcto. Ej: _"el monto es 50"_, _"corrige a S/120"_.';
          const txEditM = await obtenerUltimaTransaccion(usuario.id);
          if (!txEditM) return 'No encuentro un gasto reciente para corregir.';
          const monedaEdit = txEditM.moneda || 'PEN';
          const updates = { monto: montoNuevo };
          if (monedaEdit === 'USD') {
            const tc = await obtenerTipoCambio();
            updates.monto_pen = parseFloat((montoNuevo * tc.venta).toFixed(2));
          } else {
            updates.monto_pen = montoNuevo;
          }
          await supabase.from('transacciones').update(updates).eq('id', txEditM.id);
          const montoViejo = monedaEdit === 'USD' ? '$' + parseFloat(txEditM.monto).toFixed(2) : 'S/ ' + parseFloat(txEditM.monto).toFixed(2);
          const montoNuevoStr = monedaEdit === 'USD' ? '$' + montoNuevo.toFixed(2) : 'S/ ' + montoNuevo.toFixed(2);
          return '✅ Monto corregido.\n*' + (txEditM.comercio || 'Gasto') + '*: ' + montoViejo + ' → ' + montoNuevoStr;
        } catch(e) {
          log.error({ tag: 'EDITAR_MONTO', err: e.message }, 'Error editando monto');
          return 'No pude corregir el monto. Intenta de nuevo.';
        }
      }

      case 'editar_fecha': {
        try {
          let fechaNueva = datos.fecha_nueva;
          if (!fechaNueva) return 'Dime la fecha correcta. Ej: _"fue ayer"_, _"cámbialo al 15 de marzo"_.';
          // Parsear "ayer"
          if (fechaNueva === 'ayer') {
            fechaNueva = fechaAyerPeru();
          } else if (/^\d{1,2}$/.test(fechaNueva)) {
            // Solo día → asumir mes/año actual
            fechaNueva = anioActual + '-' + String(mesActual).padStart(2,'0') + '-' + String(parseInt(fechaNueva)).padStart(2,'0');
          }
          const txEditF = await obtenerUltimaTransaccion(usuario.id);
          if (!txEditF) return 'No encuentro un gasto reciente para corregir.';
          await supabase.from('transacciones').update({ fecha: fechaNueva }).eq('id', txEditF.id);
          return '✅ Fecha corregida.\n*' + (txEditF.comercio || 'Gasto') + '*: ' + formatFecha(txEditF.fecha) + ' → ' + formatFecha(fechaNueva);
        } catch(e) {
          log.error({ tag: 'EDITAR_FECHA', err: e.message }, 'Error editando fecha');
          return 'No pude corregir la fecha. Intenta de nuevo.';
        }
      }

      case 'editar_comercio': {
        try {
          const comercioNuevo = datos.comercio_nuevo;
          if (!comercioNuevo) return 'Dime el nombre correcto. Ej: _"el comercio es Plaza Vea"_.';
          const txEditC = await obtenerUltimaTransaccion(usuario.id);
          if (!txEditC) return 'No encuentro un gasto reciente para corregir.';
          const comercioViejo = txEditC.comercio || 'Sin nombre';
          await supabase.from('transacciones').update({ comercio: comercioNuevo }).eq('id', txEditC.id);
          return '✅ Comercio corregido.\n' + comercioViejo + ' → *' + comercioNuevo + '*';
        } catch(e) {
          log.error({ tag: 'EDITAR_COMERCIO', err: e.message }, 'Error editando comercio');
          return 'No pude corregir el comercio. Intenta de nuevo.';
        }
      }

      case 'dividir_gasto': {
        try {
          const partes = datos.partes ? parseInt(datos.partes) : null;
          if (!partes || partes < 2 || partes > 20) return 'Dime entre cuántos dividir. Ej: _"divide entre 3"_, _"mitad es mío"_.';
          const txDiv = await obtenerUltimaTransaccion(usuario.id);
          if (!txDiv) return 'No encuentro un gasto reciente para dividir.';
          const montoOriginal = parseFloat(txDiv.monto);
          const montoNuevoDiv = parseFloat((montoOriginal / partes).toFixed(2));
          const updates = { monto: montoNuevoDiv };
          if (txDiv.moneda === 'USD') {
            const tc = await obtenerTipoCambio();
            updates.monto_pen = parseFloat((montoNuevoDiv * tc.venta).toFixed(2));
          } else {
            updates.monto_pen = montoNuevoDiv;
          }
          await supabase.from('transacciones').update(updates).eq('id', txDiv.id);
          const monedaDiv = txDiv.moneda === 'USD' ? '$' : 'S/ ';
          return '✅ Gasto dividido entre ' + partes + '.\n*' + (txDiv.comercio || 'Gasto') + '*: ' + monedaDiv + montoOriginal.toFixed(2) + ' → ' + monedaDiv + montoNuevoDiv.toFixed(2) + ' (tu parte)';
        } catch(e) {
          log.error({ tag: 'DIVIDIR', err: e.message }, 'Error dividiendo gasto');
          return 'No pude dividir el gasto. Intenta de nuevo.';
        }
      }

      case 'duplicar_gasto': {
        try {
          const txDup = await obtenerUltimaTransaccion(usuario.id);
          if (!txDup) return 'No encuentro un gasto reciente para duplicar.';
          const fechaDup = datos.fecha || hoyPeru();
          const datosDup = {
            monto: parseFloat(txDup.monto),
            moneda: txDup.moneda || 'PEN',
            comercio: txDup.comercio,
            categoria: txDup.categoria,
            subcategoria: txDup.subcategoria,
            tipo: txDup.tipo || 'gasto',
            banco: txDup.banco,
            metodo_pago: txDup.metodo_pago,
            fecha: fechaDup,
            descripcion_original: 'duplicado:' + txDup.id
          };
          await guardarTransaccion(usuario.id, datosDup);
          const monedaDup = txDup.moneda === 'USD' ? '$' : 'S/ ';
          return '✅ Gasto duplicado.\n*' + (txDup.comercio || 'Gasto') + '*: ' + monedaDup + parseFloat(txDup.monto).toFixed(2) + ' registrado para ' + formatFecha(fechaDup) + '.';
        } catch(e) {
          log.error({ tag: 'DUPLICAR', err: e.message }, 'Error duplicando gasto');
          return 'No pude duplicar el gasto. Intenta de nuevo.';
        }
      }

      case 'ver_metas': {
        try {
          const { data: metas } = await supabase.from('metas_ahorro').select('*').eq('usuario_id', usuario.id).order('created_at', { ascending: false });
          if (!metas || metas.length === 0) return '🎯 No tienes metas de ahorro configuradas.\n\n_Crea una: "quiero ahorrar S/5000 para julio"_';
          let msgMetas = '🎯 *Tus metas de ahorro*\n\n';
          metas.forEach(m => {
            const pctM = m.monto_objetivo > 0 ? ((m.monto_actual / m.monto_objetivo) * 100).toFixed(0) : 0;
            const barra = barraProgreso(parseFloat(pctM));
            msgMetas += (m.completada ? '✅ ' : '') + '*' + m.nombre + '*' + (m.icono ? ' ' + m.icono : '') + '\n' + barra + '\nS/ ' + parseFloat(m.monto_actual || 0).toFixed(2) + ' / S/ ' + parseFloat(m.monto_objetivo).toFixed(2);
            if (m.fecha_limite) {
              msgMetas += ' · Meta: ' + formatFecha(m.fecha_limite);
              if (!m.completada) {
                const ritmo = calcularRitmoAhorro(m);
                if (ritmo.montoMensual !== null && ritmo.montoMensual > 0) {
                  msgMetas += '\n📊 Ritmo: S/ ' + ritmo.montoMensual.toFixed(0) + '/mes ' + (ritmo.enRitmo ? '✅' : '⚠️');
                }
              }
            }
            msgMetas += '\n\n';
          });
          msgMetas += '_Abona: "ahorré 200 para [nombre]"_\n_Dashboard: https://app.neto.pe/dashboard/metas_';
          return msgMetas;
        } catch(e) {
          log.error({ tag: 'METAS', err: e.message }, 'Error consultando metas');
          return 'No pude consultar tus metas. Intenta de nuevo.';
        }
      }

      case 'crear_meta': {
        try {
          const nombreMeta = datos.nombre || 'Mi meta';
          const montoMeta = datos.monto ? parseFloat(datos.monto) : null;
          if (!montoMeta || montoMeta <= 0) return 'Dime cuánto quieres ahorrar. Ej: _"quiero ahorrar S/5000 para julio"_.';
          const fechaLimMeta = datos.fecha_limite || null;
          await supabase.from('metas_ahorro').insert({
            usuario_id: usuario.id, nombre: nombreMeta, monto_objetivo: montoMeta, monto_actual: 0, fecha_limite: fechaLimMeta
          });
          return '✅ Meta creada!\n\n🎯 *' + nombreMeta + '*\nObjetivo: S/ ' + montoMeta.toFixed(2) + (fechaLimMeta ? '\nFecha: ' + formatFecha(fechaLimMeta) : '') + '\n\n_Actualiza tu progreso en https://app.neto.pe/dashboard/metas_';
        } catch(e) {
          log.error({ tag: 'CREAR_META', err: e.message }, 'Error creando meta');
          return 'No pude crear la meta. Intenta de nuevo.';
        }
      }

      case 'agradecimiento': {
        const ctxAgr = 'El usuario agradece o felicita a NETO. Responde breve y motivacional, mencionando algun dato positivo de sus finanzas si lo tienes. No hagas preguntas.';
        const gastosMesAgr = await obtenerGastosMes(usuario.id);
        const totalAgr = gastosMesAgr.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const ctxAgrDatos = ctxAgr + ' Contexto: lleva S/' + totalAgr.toFixed(0) + ' en ' + gastosMesAgr.length + ' movimientos este mes.';
        const respAgr = await redactarConNETO(netoPrompt, ctxAgrDatos, msg, historialConv);
        return respAgr || '¡De nada! Aquí andamos cuidando tu bolsillo. 💪';
      }

      case 'queja': {
        const ctxQueja = 'El usuario reporta un problema o se queja de algo que no funciona. Empatiza brevemente, ofrece verificar y da el contacto de soporte: WhatsApp 970398192. No te disculpes de más, se directo.';
        const respQueja = await redactarConNETO(netoPrompt, ctxQueja, msg, historialConv);
        return respQueja || 'Entendido. Déjame revisar.\n\nSi el problema persiste, escríbenos al 970398192 y lo resolvemos.';
      }

      case 'chiste_finanzas': {
        const ctxChiste = 'El usuario quiere un chiste o dato curioso sobre finanzas. Cuenta un chiste corto y gracioso relacionado con dinero, ahorro o finanzas personales. Usa humor peruano si puedes. Máximo 3 líneas.';
        const respChiste = await redactarConNETO(netoPrompt, ctxChiste, msg, historialConv);
        return respChiste || '¿Sabes cuál es el banco favorito de los peces? 🐟\n\n¡El banco de arena! 😄\n\n_Ahora sí, ¿revisamos tus gastos?_';
      }

      case 'exportar_datos': {
        return '📥 *Exporta tus datos*\n\nEntra a tu dashboard y descarga todo:\n\n🔗 https://app.neto.pe/dashboard/transacciones\n\nAhí puedes exportar en CSV, JSON o PDF.\n\n_Inicia sesión con tu cuenta de Google._';
      }

      case 'cambiar_nombre': {
        try {
          const nombreNuevo = datos.nombre_nuevo;
          if (!nombreNuevo || nombreNuevo.length < 2) return 'Dime tu nombre. Ej: _"mi nombre es Juan"_.';
          const nombreLimpio = nombreNuevo.trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          await supabase.from('usuarios').update({ nombre: nombreLimpio }).eq('id', usuario.id);
          return '✅ Listo, ahora te llamo *' + nombreLimpio + '*. ¡Mucho gusto! 👋';
        } catch(e) {
          log.error({ tag: 'NOMBRE', err: e.message }, 'Error cambiando nombre');
          return 'No pude actualizar tu nombre. Intenta de nuevo.';
        }
      }

      // ===== BLOQUE 1: Consultas avanzadas =====

      case 'ver_gasto_mayor': {
        try {
          const txsMayor = await obtenerGastosMes(usuario.id);
          const gastosMayor = txsMayor.filter(t => t.tipo !== 'ingreso');
          if (!gastosMayor.length) return 'No tienes gastos registrados este mes.';
          gastosMayor.sort((a, b) => parseFloat(b.monto_pen || b.monto || 0) - parseFloat(a.monto_pen || a.monto || 0));
          const top = gastosMayor[0];
          const montoMayor = top.moneda === 'USD' ? '$' + parseFloat(top.monto).toFixed(2) : 'S/ ' + parseFloat(top.monto).toFixed(2);
          return '🔝 *Tu gasto más grande del mes:*\n\n' + (top.comercio || 'Sin comercio') + ' — ' + montoMayor + '\n📁 ' + (top.categoria || 'Sin categoría') + '\n📅 ' + (top.fecha || '') + '\n\n_De un total de ' + gastosMayor.length + ' gastos este mes._';
        } catch(e) {
          log.error({ tag: 'GASTO_MAYOR', err: e.message }, 'Error ver gasto mayor');
          return 'No pude obtener el dato. Intenta de nuevo.';
        }
      }

      case 'ver_gasto_menor': {
        try {
          const txsMenor = await obtenerGastosMes(usuario.id);
          const gastosMenor = txsMenor.filter(t => t.tipo !== 'ingreso' && parseFloat(t.monto_pen || t.monto || 0) > 0);
          if (!gastosMenor.length) return 'No tienes gastos registrados este mes.';
          gastosMenor.sort((a, b) => parseFloat(a.monto_pen || a.monto || 0) - parseFloat(b.monto_pen || b.monto || 0));
          const bottom = gastosMenor[0];
          const montoMenor = bottom.moneda === 'USD' ? '$' + parseFloat(bottom.monto).toFixed(2) : 'S/ ' + parseFloat(bottom.monto).toFixed(2);
          return '🔻 *Tu gasto más pequeño del mes:*\n\n' + (bottom.comercio || 'Sin comercio') + ' — ' + montoMenor + '\n📁 ' + (bottom.categoria || 'Sin categoría') + '\n📅 ' + (bottom.fecha || '') + '\n\n_De un total de ' + gastosMenor.length + ' gastos este mes._';
        } catch(e) {
          log.error({ tag: 'GASTO_MENOR', err: e.message }, 'Error ver gasto menor');
          return 'No pude obtener el dato. Intenta de nuevo.';
        }
      }

      case 'ver_promedio_diario': {
        try {
          const txsProm = await obtenerGastosMes(usuario.id);
          const gastosProm = txsProm.filter(t => t.tipo !== 'ingreso');
          if (!gastosProm.length) return 'No tienes gastos registrados este mes para calcular el promedio.';
          const totalProm = gastosProm.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const hoyDia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getDate();
          const promDiario = totalProm / hoyDia;
          const diasMes = new Date(anioActual, mesActual, 0).getDate();
          const proyeccion = promDiario * diasMes;
          return '📊 *Promedio diario de gasto:*\n\n💰 S/ ' + promDiario.toFixed(2) + ' por día\n📅 Basado en ' + hoyDia + ' días transcurridos\n💸 Total acumulado: S/ ' + totalProm.toFixed(2) + '\n📈 Proyección a fin de mes: S/ ' + proyeccion.toFixed(0) + '\n\n_Llevas ' + gastosProm.length + ' gastos en ' + hoyDia + ' días._';
        } catch(e) {
          log.error({ tag: 'PROMEDIO', err: e.message }, 'Error promedio diario');
          return 'No pude calcular el promedio. Intenta de nuevo.';
        }
      }

      case 'ver_frecuencia_comercio': {
        try {
          const comercioFreq = datos.comercio;
          if (!comercioFreq) return '¿De qué comercio quieres saber la frecuencia? Ej: _"cuántas veces fui a Rappi"_';
          const { data: txsFreq } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id).ilike('comercio', '%' + comercioFreq + '%')
            .order('fecha', { ascending: false });
          if (!txsFreq || !txsFreq.length) return 'No encontré pagos en *' + comercioFreq + '*. ¿Seguro que se llama así?';
          const totalFreq = txsFreq.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const promFreq = totalFreq / txsFreq.length;
          return '🔄 *Frecuencia en ' + comercioFreq + ':*\n\n📍 ' + txsFreq.length + ' pagos registrados\n💰 Total: S/ ' + totalFreq.toFixed(2) + '\n📊 Promedio por pago: S/ ' + promFreq.toFixed(2) + '\n📅 Último: ' + (txsFreq[0].fecha || 'N/D') + '\n\n_Datos de todo tu historial._';
        } catch(e) {
          log.error({ tag: 'FRECUENCIA', err: e.message }, 'Error frecuencia comercio');
          return 'No pude obtener la frecuencia. Intenta de nuevo.';
        }
      }

      case 'ver_gastos_rango_fecha': {
        try {
          const fechaIni = datos.fecha_inicio;
          const fechaFin = datos.fecha_fin;
          if (!fechaIni || !fechaFin) return 'Dime el rango de fechas. Ej: _"gastos del 1 al 15"_ o _"gastos del 5 al 20 de marzo"_';
          const { data: txsRango } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id).gte('fecha', fechaIni).lte('fecha', fechaFin)
            .eq('tipo', 'gasto').order('fecha', { ascending: false });
          if (!txsRango || !txsRango.length) return 'No hay gastos entre ' + fechaIni + ' y ' + fechaFin + '.';
          const totalRango = txsRango.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          let respRango = '📅 *Gastos del ' + fechaIni + ' al ' + fechaFin + ':*\n\n';
          respRango += '💰 Total: S/ ' + totalRango.toFixed(2) + ' (' + txsRango.length + ' gastos)\n\n';
          const topRango = txsRango.slice(0, 5);
          topRango.forEach(t => {
            const m = t.moneda === 'USD' ? '$' + parseFloat(t.monto).toFixed(2) : 'S/ ' + parseFloat(t.monto).toFixed(2);
            respRango += '• ' + (t.comercio || 'N/D') + ' — ' + m + ' (' + t.fecha + ')\n';
          });
          if (txsRango.length > 5) respRango += '\n_...y ' + (txsRango.length - 5) + ' más._';
          return respRango;
        } catch(e) {
          log.error({ tag: 'RANGO_FECHA', err: e.message }, 'Error gastos rango fecha');
          return 'No pude consultar ese rango. Intenta de nuevo.';
        }
      }

      case 'ver_gastos_fin_de_semana': {
        try {
          const txsFds = await obtenerGastosMes(usuario.id);
          const gastosFds = txsFds.filter(t => t.tipo !== 'ingreso');
          if (!gastosFds.length) return 'No tienes gastos registrados este mes.';
          const finDeSemana = gastosFds.filter(t => {
            const d = new Date(t.fecha + 'T12:00:00');
            return d.getDay() === 0 || d.getDay() === 6;
          });
          const entreSemana = gastosFds.filter(t => {
            const d = new Date(t.fecha + 'T12:00:00');
            return d.getDay() !== 0 && d.getDay() !== 6;
          });
          const totalFds = finDeSemana.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const totalEs = entreSemana.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
          const pctFds = gastosFds.length > 0 ? ((finDeSemana.length / gastosFds.length) * 100).toFixed(0) : 0;
          return '🗓️ *Gastos de fin de semana (sáb-dom):*\n\n🎉 Fin de semana: S/ ' + totalFds.toFixed(2) + ' (' + finDeSemana.length + ' gastos)\n💼 Entre semana: S/ ' + totalEs.toFixed(2) + ' (' + entreSemana.length + ' gastos)\n📊 ' + pctFds + '% de tus gastos son en finde\n\n_Los fines de semana gastas en promedio S/ ' + (finDeSemana.length > 0 ? (totalFds / finDeSemana.length).toFixed(2) : '0') + ' por compra._';
        } catch(e) {
          log.error({ tag: 'FDS', err: e.message }, 'Error gastos fin de semana');
          return 'No pude calcular los gastos del finde. Intenta de nuevo.';
        }
      }

      // ===== BLOQUE 2: Edición y corrección =====

      case 'deshacer_ultimo': {
        try {
          const txDeshacer = await obtenerUltimaTransaccion(usuario.id);
          if (!txDeshacer) return 'No hay transacciones recientes para deshacer.';
          const montoDeshacer = txDeshacer.moneda === 'USD' ? '$' + parseFloat(txDeshacer.monto).toFixed(2) : 'S/ ' + parseFloat(txDeshacer.monto).toFixed(2);
          await supabase.from('transacciones').delete().eq('id', txDeshacer.id);
          return '↩️ *Deshecho:*\n\nEliminé *' + (txDeshacer.comercio || 'último registro') + '* — ' + montoDeshacer + ' del ' + (txDeshacer.fecha || '') + '.\n\n_Si fue un error, puedes volver a registrarlo._';
        } catch(e) {
          log.error({ tag: 'DESHACER', err: e.message }, 'Error deshacer último');
          return 'No pude deshacer la última acción. Intenta de nuevo.';
        }
      }

      case 'editar_categoria_comercio': {
        try {
          const comercioRegla = datos.comercio;
          const catRegla = datos.categoria;
          const subRegla = datos.subcategoria || null;
          if (!comercioRegla || !catRegla) return 'Dime el comercio y la categoría. Ej: _"todo lo de Rappi siempre va en Delivery"_';
          await guardarReglaComercio(usuario.id, comercioRegla, catRegla, subRegla);
          const retro = await retroaplicarRegla(usuario.id, comercioRegla, catRegla, subRegla);
          return '✅ *Regla creada:*\n\n' + comercioRegla + ' → *' + catRegla + '* (siempre)\n\n' + (retro > 0 ? '🔄 Actualicé ' + retro + ' transacciones anteriores con esta regla.' : 'Se aplicará a las próximas transacciones.') + '\n\n_Puedes cambiarlo cuando quieras._';
        } catch(e) {
          log.error({ tag: 'REGLA_CAT', err: e.message }, 'Error editar categoría comercio');
          return 'No pude crear la regla. Intenta de nuevo.';
        }
      }

      case 'marcar_como_ingreso': {
        try {
          const txMarcar = await obtenerUltimaTransaccion(usuario.id);
          if (!txMarcar) return 'No hay transacciones recientes para modificar.';
          const tipoNuevo = datos.tipo_nuevo || 'ingreso';
          await supabase.from('transacciones').update({ tipo: tipoNuevo }).eq('id', txMarcar.id);
          const montoMarcar = txMarcar.moneda === 'USD' ? '$' + parseFloat(txMarcar.monto).toFixed(2) : 'S/ ' + parseFloat(txMarcar.monto).toFixed(2);
          return '✅ *' + (txMarcar.comercio || 'Transacción') + '* (' + montoMarcar + ') ahora está marcado como *' + tipoNuevo + '*.\n\n_Tu balance se ha actualizado._';
        } catch(e) {
          log.error({ tag: 'MARCAR_INGRESO', err: e.message }, 'Error marcar como ingreso');
          return 'No pude cambiar el tipo. Intenta de nuevo.';
        }
      }

      // ===== BLOQUE 3: Presupuestos y metas =====

      case 'eliminar_presupuesto': {
        try {
          const catElimP = datos.categoria;
          if (!catElimP) return '¿De qué categoría quieres eliminar el presupuesto? Ej: _"quita el límite de comida"_';
          const { data: presElim } = await supabase.from('presupuestos').select('*')
            .eq('usuario_id', usuario.id).ilike('categoria', '%' + catElimP + '%')
            .eq('mes', mesActual).eq('anio', anioActual);
          if (!presElim || !presElim.length) return 'No tienes presupuesto de *' + catElimP + '* este mes.';
          await supabase.from('presupuestos').delete().eq('id', presElim[0].id);
          return '✅ Eliminé el presupuesto de *' + presElim[0].categoria + '* (era S/ ' + parseFloat(presElim[0].monto_limite).toFixed(0) + ').\n\n_Ya no recibirás alertas de esa categoría._';
        } catch(e) {
          log.error({ tag: 'ELIM_PRES', err: e.message }, 'Error eliminar presupuesto');
          return 'No pude eliminar el presupuesto. Intenta de nuevo.';
        }
      }

      case 'editar_meta': {
        try {
          const { data: metasEdit } = await supabase.from('metas_ahorro').select('*')
            .eq('usuario_id', usuario.id).order('created_at', { ascending: false });
          if (!metasEdit || !metasEdit.length) return 'No tienes metas de ahorro. Crea una con _"quiero ahorrar S/2000 para julio"_.';
          let metaTarget = metasEdit[0];
          if (datos.nombre && metasEdit.length > 1) {
            const found = metasEdit.find(m => m.nombre.toLowerCase().includes(datos.nombre.toLowerCase()));
            if (found) metaTarget = found;
          }
          const updates = {};
          if (datos.monto_nuevo) updates.monto_objetivo = parseFloat(datos.monto_nuevo);
          if (datos.fecha_nueva) updates.fecha_limite = datos.fecha_nueva;
          if (Object.keys(updates).length === 0) return 'Dime qué quieres cambiar. Ej: _"sube mi meta a 3000"_ o _"cambia la fecha al 30 de junio"_.';
          await supabase.from('metas_ahorro').update(updates).eq('id', metaTarget.id);
          const montoObj = updates.monto_objetivo || metaTarget.monto_objetivo;
          return '✅ Meta *' + metaTarget.nombre + '* actualizada.\n\n🎯 Objetivo: S/ ' + parseFloat(montoObj).toFixed(0) + '\n📅 Fecha límite: ' + (updates.fecha_limite || metaTarget.fecha_limite || 'Sin fecha') + '\n💰 Ahorrado: S/ ' + parseFloat(metaTarget.monto_actual || 0).toFixed(0);
        } catch(e) {
          log.error({ tag: 'EDIT_META', err: e.message }, 'Error editar meta');
          return 'No pude editar la meta. Intenta de nuevo.';
        }
      }

      case 'eliminar_meta': {
        try {
          const { data: metasDel } = await supabase.from('metas_ahorro').select('*')
            .eq('usuario_id', usuario.id).order('created_at', { ascending: false });
          if (!metasDel || !metasDel.length) return 'No tienes metas de ahorro para eliminar.';
          let metaDel = metasDel[0];
          if (datos.nombre && metasDel.length > 1) {
            const found = metasDel.find(m => m.nombre.toLowerCase().includes(datos.nombre.toLowerCase()));
            if (found) metaDel = found;
          }
          await supabase.from('metas_ahorro').delete().eq('id', metaDel.id);
          return '✅ Eliminé la meta *' + metaDel.nombre + '* (S/ ' + parseFloat(metaDel.monto_actual || 0).toFixed(0) + ' de S/ ' + parseFloat(metaDel.monto_objetivo).toFixed(0) + ').\n\n_Puedes crear otra cuando quieras._';
        } catch(e) {
          log.error({ tag: 'DEL_META', err: e.message }, 'Error eliminar meta');
          return 'No pude eliminar la meta. Intenta de nuevo.';
        }
      }

      case 'abonar_meta': {
        try {
          const montoAbono = parseFloat(datos.monto);
          if (!montoAbono || montoAbono <= 0) return 'Dime cuánto quieres abonar. Ej: _"aboné 500 a mi meta"_.';
          // Detectar retiro
          const esRetiro = /\b(saqu[eé]|retir[eé]|quit[eé]|us[eé]|tom[eé])\b/i.test(msg);
          const nombreMeta = datos.nombre_meta || datos.nombre || null;
          const resultado = await abonarMetaService(usuario.id, nombreMeta, montoAbono, esRetiro ? 'retiro' : 'aporte', datos.nota || null);
          if (!resultado) return 'No tienes metas de ahorro activas. Crea una con _"quiero ahorrar S/2000 para julio"_.';
          const { meta, completada, porcentaje, milestone } = resultado;
          const nuevoActual = parseFloat(meta.monto_actual || 0);
          const objetivo = parseFloat(meta.monto_objetivo);
          const faltante = Math.max(0, objetivo - nuevoActual);

          let respMeta = '';
          if (esRetiro) {
            respMeta = '📤 *Retiro registrado*\n\n🎯 ' + meta.nombre + '\n💰 S/ ' + nuevoActual.toFixed(0) + ' de S/ ' + objetivo.toFixed(0) + ' (' + porcentaje + '%)';
          } else if (completada) {
            respMeta = '🎉 *¡META CUMPLIDA!*\n\n🎯 ' + meta.nombre + '\n💰 S/ ' + nuevoActual.toFixed(0) + ' de S/ ' + objetivo.toFixed(0) + ' (100%)\n\n¡Felicitaciones! Lograste tu meta. 🏆';
            try { await registrarLogro(usuario.id, 'meta_cumplida', meta.id); } catch(e) { /* silent */ }
          } else {
            respMeta = '✅ *Abono registrado*\n\n🎯 ' + meta.nombre + '\n💰 S/ ' + nuevoActual.toFixed(0) + ' de S/ ' + objetivo.toFixed(0) + ' (' + porcentaje + '%)\n_Te falta S/ ' + faltante.toFixed(0) + '._';
          }

          // Ritmo de ahorro si hay fecha límite
          if (meta.fecha_limite && !completada && !esRetiro) {
            const ritmo = calcularRitmoAhorro(meta);
            if (ritmo.montoMensual !== null && ritmo.montoMensual > 0) {
              respMeta += '\n📊 Necesitas S/ ' + ritmo.montoMensual.toFixed(0) + '/mes para llegar a tiempo ' + (ritmo.enRitmo ? '✅' : '⚠️');
            }
          }

          // Milestones (gamificación)
          if (milestone && milestone !== 100) {
            respMeta += '\n\n🏅 *¡Llegaste al ' + milestone + '%!* Sigue así.';
            try { await registrarLogro(usuario.id, 'milestone_' + milestone, meta.id); } catch(e) { /* silent */ }
          }

          // Racha
          try {
            const racha = await verificarRachaAportes(usuario.id, meta.id);
            if (racha >= 3) {
              respMeta += '\n🔥 Racha: ' + racha + ' semanas seguidas ahorrando!';
              if (racha % 3 === 0) { try { await registrarLogro(usuario.id, 'racha_' + racha, meta.id, { semanas: racha }); } catch(e) { /* silent */ } }
            }
          } catch(e) { /* silent */ }

          return respMeta;
        } catch(e) {
          log.error({ tag: 'ABONAR_META', err: e.message }, 'Error abonar meta');
          return 'No pude registrar el abono. Intenta de nuevo.';
        }
      }

      // ===== BLOQUE 4: Contexto peruano =====

      case 'consulta_financiera': {
        const ctxFinanciero = 'El usuario hace una pregunta sobre conceptos financieros. Responde como educador financiero peruano: breve, claro, con ejemplos locales (bancos peruanos, montos en soles). Máximo 6 líneas. Si es sobre CTS, AFP, ONP, gratificación, etc., explica el contexto peruano específico.';
        const respFinanciero = await redactarConNETO(netoPrompt, ctxFinanciero, msg, historialConv);
        return respFinanciero || 'Buena pregunta. Te recomiendo consultar con tu banco o la SBS (sbs.gob.pe) para información detallada.\n\n¿Necesitas algo más con tus finanzas?';
      }

      case 'calcular_cuotas': {
        try {
          const montoCuota = parseFloat(datos.monto);
          if (!montoCuota || montoCuota <= 0) return 'Dime el monto y las cuotas. Ej: _"cuotas de 3000 en 12 meses"_.';
          const numCuotas = parseInt(datos.cuotas) || 12;
          const teaAnual = parseFloat(datos.tasa) || 45; // TEA promedio tarjetas Perú
          const temMensual = Math.pow(1 + teaAnual / 100, 1 / 12) - 1;
          const cuotaMensual = montoCuota * (temMensual * Math.pow(1 + temMensual, numCuotas)) / (Math.pow(1 + temMensual, numCuotas) - 1);
          const totalPagar = cuotaMensual * numCuotas;
          const totalInteres = totalPagar - montoCuota;
          return '🧮 *Cálculo de cuotas:*\n\n💰 Monto: S/ ' + montoCuota.toFixed(2) + '\n📅 Cuotas: ' + numCuotas + ' meses\n📊 TEA: ' + teaAnual + '%\n\n💳 Cuota mensual: *S/ ' + cuotaMensual.toFixed(2) + '*\n💸 Total a pagar: S/ ' + totalPagar.toFixed(2) + '\n⚠️ Total intereses: S/ ' + totalInteres.toFixed(2) + '\n\n_TEA estimada. Consulta con tu banco la tasa real._';
        } catch(e) {
          log.error({ tag: 'CUOTAS', err: e.message }, 'Error calcular cuotas');
          return 'No pude calcular las cuotas. Intenta con _"cuotas de 3000 en 12 meses"_.';
        }
      }

      case 'recordatorio_pago': {
        return '⏰ *Recordatorios de pago*\n\nPor ahora puedes configurar tus recordatorios desde la webapp:\n\n🔗 https://app.neto.pe/dashboard/configuracion\n\nAhí puedes activar/desactivar los recordatorios diarios.\n\n_Pronto podrás crear recordatorios personalizados por WhatsApp._';
      }

      case 'convertir_moneda': {
        try {
          const montoConv = parseFloat(datos.monto);
          if (!montoConv || montoConv <= 0) return 'Dime cuánto quieres convertir. Ej: _"cuánto es 100 dólares en soles"_.';
          const tc = await obtenerTipoCambio();
          const origenConv = (datos.moneda_origen || 'USD').toUpperCase();
          let resultado, textoConv;
          if (origenConv === 'USD') {
            resultado = montoConv * tc.venta;
            textoConv = '$' + montoConv.toFixed(2) + ' = *S/ ' + resultado.toFixed(2) + '*';
          } else {
            resultado = montoConv / tc.compra;
            textoConv = 'S/ ' + montoConv.toFixed(2) + ' = *$' + resultado.toFixed(2) + '*';
          }
          return '💱 *Conversión:*\n\n' + textoConv + '\n\n📊 TC Compra: S/ ' + tc.compra.toFixed(4) + '\n📊 TC Venta: S/ ' + tc.venta.toFixed(4) + '\n\n_Fuente: dolar.pe_';
        } catch(e) {
          log.error({ tag: 'CONVERTIR', err: e.message }, 'Error convertir moneda');
          return 'No pude obtener el tipo de cambio. Intenta de nuevo.';
        }
      }

      // ===== BLOQUE 5: Social, navegación y engagement =====

      case 'feedback': {
        // Guardar feedback para revisión admin
        supabase.from('nlp_errors').insert({
          usuario_id: usuario.id, whatsapp: from,
          mensaje: msg.substring(0, 500), intencion: 'feedback',
          error_tipo: 'feedback', error_detalle: 'Sugerencia del usuario'
        }).then(() => {}).catch(() => {});
        return '💡 *¡Gracias por tu sugerencia!*\n\nLa recibimos y la vamos a evaluar. Tu feedback nos ayuda a mejorar Neto.\n\n_Si quieres contarnos más, escríbenos al 970398192._';
      }

      case 'estado_cuenta': {
        try {
          const cuentasEst = await obtenerCuentasGmail(usuario.id);
          const esPremium = usuario.plan === 'premium';
          const vencimiento = usuario.premium_vence || usuario.fecha_vencimiento || null;
          const nombre = usuario.nombre || 'Usuario';
          let resp = '👤 *Tu cuenta, ' + nombre + ':*\n\n';
          resp += '📋 Plan: *' + (esPremium ? 'Pro ⭐' : 'Free') + '*\n';
          if (esPremium && vencimiento) resp += '📅 Vence: ' + new Date(vencimiento).toLocaleDateString('es-PE') + '\n';
          if (!esPremium) resp += '\n💡 _Escribe /premium para ver los beneficios Pro._\n';
          resp += '📧 Gmail: ' + (cuentasEst.length > 0 ? cuentasEst.map(c => c.email).join(', ') : 'No conectado') + '\n';
          resp += '🔔 Recordatorios: ' + (usuario.recordatorios_activos !== false ? 'Activos ✅' : 'Silenciados 🔇') + '\n';
          resp += '\n🔗 Más detalles en https://app.neto.pe/dashboard/configuracion';
          return resp;
        } catch(e) {
          log.error({ tag: 'ESTADO_CUENTA', err: e.message }, 'Error estado cuenta');
          return 'No pude consultar tu cuenta. Intenta de nuevo.';
        }
      }

      case 'silenciar': {
        try {
          await supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id);
          return '🔇 *Recordatorios desactivados.*\n\nNo te enviaré más resúmenes diarios ni recordatorios.\n\n_Cuando quieras reactivarlos, escribe "activa los recordatorios"._';
        } catch(e) {
          log.error({ tag: 'SILENCIAR', err: e.message }, 'Error silenciar');
          return 'No pude desactivar los recordatorios. Intenta de nuevo.';
        }
      }

      case 'reactivar_recordatorios': {
        try {
          await supabase.from('usuarios').update({ recordatorios_activos: true }).eq('id', usuario.id);
          return '🔔 *Recordatorios activados.*\n\nVolverás a recibir tu resumen diario a las 8pm y alertas de presupuesto.\n\n_Si quieres silenciarlos, escribe "silencia"._';
        } catch(e) {
          log.error({ tag: 'REACTIVAR', err: e.message }, 'Error reactivar recordatorios');
          return 'No pude activar los recordatorios. Intenta de nuevo.';
        }
      }

      case 'como_empezar': {
        const ctxEmpezar = 'El usuario es nuevo o quiere saber cómo empezar. Guíalo paso a paso de forma amigable: 1) Registrar gastos manualmente ("gasté 50 en taxi"), enviar fotos de comprobantes Yape/Plin, o cargar un Excel, 2) Ver su resumen con "mis gastos del mes" o entrar a https://app.neto.pe, 3) Menciona que con el Plan Pro (S/10/mes) puede conectar su Gmail y Neto lee sus correos bancarios automáticamente. Máximo 8 líneas, tono motivador.';
        const respEmpezar = await redactarConNETO(netoPrompt, ctxEmpezar, msg, historialConv);
        return respEmpezar || '¡Bienvenido a Neto! 🎉\n\n*3 pasos para empezar:*\n\n1️⃣ Registra un gasto → _"gasté 50 en taxi"_\n2️⃣ Envía una foto Yape/Plin 📸\n3️⃣ Ve tu resumen → _"mis gastos del mes"_\n\n📊 Dashboard: https://app.neto.pe\n⭐ *Pro (S/10/mes):* Neto lee tus correos bancarios automáticamente\n\n_¿Empezamos? Dime tu primer gasto._';
      }

      case 'gastos_hormiga': {
        // Buscar gastos pequeños (≤S/20) del mes actual
        const hoyGH = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
        const mesInicioGH = hoyGH.getFullYear() + '-' + String(hoyGH.getMonth() + 1).padStart(2, '0') + '-01';
        const { data: gastosGH } = await supabase.from('transacciones').select('monto, monto_pen, comercio, categoria')
          .eq('usuario_id', usuario.id).eq('tipo', 'gasto')
          .gte('fecha', mesInicioGH).lte('monto', 20).order('fecha', { ascending: false });

        if (!gastosGH || gastosGH.length < 3) {
          // Usuario nuevo o con pocos datos → guiarlo a registrar
          return '🐜 *¡Buena decisión! Los gastos hormiga son los que más duelen.*\n\n' +
            'Son esos gastos chiquitos (café, delivery, taxi, snacks) que parecen nada pero suman S/200-400 al mes.\n\n' +
            'Para calcular los tuyos necesito que registres tus gastos:\n\n' +
            '1️⃣ *Registra manual* → _"gasté 8 en café"_\n' +
            '2️⃣ *Envía foto* de tu comprobante Yape/Plin\n' +
            '3️⃣ *Plan Pro:* conecto tu Gmail y leo tus notificaciones bancarias automáticamente\n\n' +
            'Con una semana de datos ya puedo decirte exactamente cuánto pierdes en gastos hormiga. 📊\n\n' +
            '_¿Empezamos? Dime tu primer gasto del día._';
        }

        // Usuario con datos → mostrar análisis real
        const totalGH = gastosGH.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
        const porCatGH = {};
        gastosGH.forEach(t => { const c = t.categoria || 'Otros'; porCatGH[c] = (porCatGH[c] || 0) + parseFloat(t.monto_pen || t.monto); });
        const topCatsGH = Object.entries(porCatGH).sort((a, b) => b[1] - a[1]).slice(0, 3);
        const proyAnualGH = (totalGH / hoyGH.getDate()) * 365;

        let respGH = '🐜 *Tus gastos hormiga este mes:*\n\n';
        respGH += '💸 *' + gastosGH.length + ' gastos* menores a S/20 = *S/ ' + totalGH.toFixed(2) + '*\n\n';
        if (topCatsGH.length > 0) {
          respGH += '*¿En qué se van?*\n';
          topCatsGH.forEach(([cat, monto]) => { respGH += '• ' + cat + ': S/ ' + monto.toFixed(2) + '\n'; });
          respGH += '\n';
        }
        respGH += '📈 A ese ritmo serían ~*S/ ' + proyAnualGH.toFixed(0) + ' al año* en gastos hormiga.\n\n';
        respGH += '_Tip: Pon un presupuesto para controlarlos → "pon límite de 200 en ' + (topCatsGH[0] ? topCatsGH[0][0] : 'Delivery') + '"_';
        return respGH;
      }

      case 'ver_historial_cambios': {
        try {
          const hoyStr = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).toISOString().split('T')[0];
          const { data: txsModif } = await supabase.from('transacciones').select('*')
            .eq('usuario_id', usuario.id)
            .gte('updated_at', hoyStr + 'T00:00:00')
            .order('updated_at', { ascending: false }).limit(10);
          if (!txsModif || !txsModif.length) return 'No hiciste cambios hoy. Todo está igual que ayer. 👍';
          let respHist = '📝 *Cambios recientes (hoy):*\n\n';
          txsModif.forEach(t => {
            const m = t.moneda === 'USD' ? '$' + parseFloat(t.monto).toFixed(2) : 'S/ ' + parseFloat(t.monto).toFixed(2);
            respHist += '• ' + (t.comercio || 'N/D') + ' — ' + m + ' (' + (t.categoria || 'S/C') + ')\n';
          });
          return respHist + '\n_Mostrando las últimas ' + txsModif.length + ' transacciones modificadas hoy._';
        } catch(e) {
          log.error({ tag: 'HISTORIAL', err: e.message }, 'Error historial cambios');
          return 'No pude consultar los cambios recientes. Intenta de nuevo.';
        }
      }

      case 'compartir_resumen': {
        return '📤 *Compartir tu resumen:*\n\n1️⃣ Pide tu reporte → _"dame mi reporte"_\n2️⃣ Neto te envía el PDF por WhatsApp\n3️⃣ Reenvíalo a quien quieras\n\nTambién puedes descargar y compartir desde:\n🔗 https://app.neto.pe/dashboard/reportes\n\n_El PDF incluye gráficos, categorías y tu score financiero._';
      }

      case 'hablar_con_humano': {
        try {
          // Crear ticket en estado 'esperando_mensaje'
          await supabase.from('tickets_soporte').insert({
            usuario_id: usuario.id,
            whatsapp: from,
            nombre_usuario: usuario.nombre || null,
            estado: 'esperando_mensaje'
          });
          return '👤 *Soporte humano*\n\nCuéntame tu problema o consulta en un mensaje y se lo paso al equipo.\n\n_Escríbelo a continuación ⬇️_';
        } catch(e) {
          log.error({ tag: 'SOPORTE', err: e.message }, 'Error creando ticket');
          return '👤 *Soporte humano:*\n\nEscríbenos a:\n📧 hola@neto.pe\n📱 WhatsApp: 970398192';
        }
      }

      case 'registrar_deuda': {
        try {
          const tipo = datos.tipo || (/\bme debe\b|le prest[eé]/i.test(msg) ? 'me_deben' : 'debo');
          let contraparte = datos.contraparte;
          let montoClasif = parseFloat(datos.monto);
          let monedaClasif = datos.moneda || 'PEN';
          const descripcion = datos.descripcion || null;

          // Fallback: extraer contraparte del mensaje si el clasificador no la encontró
          if (!contraparte) {
            const mNombre = msg.match(/(?:^|\b)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\s+me\s+debe/i)
              || msg.match(/(?:debo|le debo|prest[eé])\s+.*?\s+a\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i);
            if (mNombre) contraparte = mNombre[1].trim();
          }

          // Extraer fecha_vencimiento del mensaje
          let fechaVenc = null;
          const numPalabras = { 'un':1, 'uno':1, 'dos':2, 'tres':3, 'cuatro':4, 'cinco':5, 'seis':6, 'siete':7, 'ocho':8, 'nueve':9, 'diez':10 };
          const mDias = msg.match(/(?:en|dentro de)\s+(\d+|un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+d[ií]as?/i);
          if (mDias) { const n = numPalabras[mDias[1].toLowerCase()] || parseInt(mDias[1]); if (n > 0) { const d = new Date(); d.setDate(d.getDate() + n); fechaVenc = d.toISOString().split('T')[0]; } }
          if (!fechaVenc && /\bma[nñ]ana\b/i.test(msg)) { const d = new Date(); d.setDate(d.getDate() + 1); fechaVenc = d.toISOString().split('T')[0]; }
          if (!fechaVenc && /\bpasado\s+ma[nñ]ana\b/i.test(msg)) { const d = new Date(); d.setDate(d.getDate() + 2); fechaVenc = d.toISOString().split('T')[0]; }
          const mSem = !fechaVenc && msg.match(/(?:en|dentro de)\s+(\d+|una?|dos|tres|cuatro)\s+semanas?/i);
          if (mSem) { const n = numPalabras[mSem[1].toLowerCase()] || parseInt(mSem[1]); if (n > 0) { const d = new Date(); d.setDate(d.getDate() + n * 7); fechaVenc = d.toISOString().split('T')[0]; } }
          const mMes = !fechaVenc && msg.match(/(?:en|dentro de)\s+(\d+|un[oa]?|dos|tres)\s+mes(?:es)?/i);
          if (mMes) { const n = numPalabras[mMes[1].toLowerCase()] || parseInt(mMes[1]); if (n > 0) { const d = new Date(); d.setMonth(d.getMonth() + n); fechaVenc = d.toISOString().split('T')[0]; } }

          // Detectar multi-moneda: "100 soles y 10 dólares"
          const montos = [];
          const reMontos = /(\d+(?:[.,]\d+)?)\s*(?:soles?|pen|s\/)/gi;
          const reMontosUsd = /(\d+(?:[.,]\d+)?)\s*(?:d[oó]lares?|usd|\$)|(?:\$)\s*(\d+(?:[.,]\d+)?)/gi;
          let mPen;
          while ((mPen = reMontos.exec(msg)) !== null) {
            montos.push({ monto: parseFloat(mPen[1].replace(',', '.')), moneda: 'PEN' });
          }
          let mUsd;
          while ((mUsd = reMontosUsd.exec(msg)) !== null) {
            montos.push({ monto: parseFloat((mUsd[1] || mUsd[2]).replace(',', '.')), moneda: 'USD' });
          }

          // Helper para mostrar fecha de vencimiento en la respuesta
          const fmtVenc = fechaVenc ? '\n📅 Vence: ' + new Date(fechaVenc + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

          // Si encontramos múltiples montos, registrar cada uno
          if (montos.length >= 2 && contraparte) {
            const registros = [];
            for (const m of montos) {
              await registrarDeuda(usuario.id, tipo, contraparte, m.monto, m.moneda, descripcion, fechaVenc);
              const sym = m.moneda === 'USD' ? '$' : 'S/';
              registros.push(sym + ' ' + m.monto.toFixed(2));
            }
            if (tipo === 'debo') {
              return 'Listo, anoté que le debes a *' + contraparte + '*: ' + registros.join(' + ') + '.' + fmtVenc + '\n\n_Escribe "mis deudas" para ver todo._';
            } else {
              return 'Listo, anoté que *' + contraparte + '* te debe: ' + registros.join(' + ') + '.' + fmtVenc + '\n\n_Escribe "mis deudas" para ver todo._';
            }
          }

          // Caso normal: un solo monto
          // Si no teníamos monto del clasificador pero sí detectamos uno con regex
          if ((!montoClasif || isNaN(montoClasif)) && montos.length === 1) {
            montoClasif = montos[0].monto;
            monedaClasif = montos[0].moneda;
          }

          if (!contraparte || !montoClasif || montoClasif <= 0 || isNaN(montoClasif)) {
            return 'Mmm, no pillé bien los datos. Dime algo como:\n_"debo S/200 a Juan"_\n_"Pedro me debe S/150 por la cena"_';
          }
          await registrarDeuda(usuario.id, tipo, contraparte, montoClasif, monedaClasif, descripcion, fechaVenc);
          const sym = monedaClasif === 'USD' ? '$' : 'S/';
          if (tipo === 'debo') {
            return 'Anotado. Le debes *' + sym + ' ' + montoClasif.toFixed(2) + '* a *' + contraparte + '*.' + (descripcion ? ' (' + descripcion + ')' : '') + fmtVenc + '\n\n_Escribe "mis deudas" para ver el resumen._';
          } else {
            return 'Anotado. *' + contraparte + '* te debe *' + sym + ' ' + montoClasif.toFixed(2) + '*.' + (descripcion ? ' (' + descripcion + ')' : '') + fmtVenc + '\n\n_Escribe "mis deudas" para ver el resumen._';
          }
        } catch(e) {
          log.error({ tag: 'DEUDA_REGISTRAR', err: e.message }, 'Error al registrar deuda');
          return 'Ups, algo falló al registrar la deuda. Inténtalo de nuevo.';
        }
      }

      case 'ver_deudas': {
        try {
          return await formatearResumenDeudas(usuario.id);
        } catch(e) {
          log.error({ tag: 'DEUDA_VER', err: e.message }, 'Error al obtener deudas');
          return 'No pude obtener tus deudas. Intenta de nuevo.';
        }
      }

      case 'abonar_deuda': {
        try {
          let contraparte = datos.contraparte;
          let montoAbono = parseFloat(datos.monto);

          // Fallback: extraer contraparte de frases como "Annie me dio 50"
          if (!contraparte) {
            const mNombreAbono = msg.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\s+me\s+(dio|transfiri[oó]|deposit[oó]|pas[oó])/i)
              || msg.match(/(?:pagu[eé]|abon[eé]|di)\s+.*?\s+a\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i);
            if (mNombreAbono) contraparte = (mNombreAbono[1] || '').trim();
          }

          // Soporte fracciones: "la mitad", "un tercio", "X%"
          if ((!montoAbono || isNaN(montoAbono)) && contraparte) {
            const { data: deudasCalc } = await supabase.from('deudas')
              .select('monto_pendiente')
              .eq('usuario_id', usuario.id).eq('estado', 'activa')
              .ilike('contraparte', '%' + contraparte.trim() + '%')
              .order('created_at', { ascending: false }).limit(1);
            if (deudasCalc && deudasCalc.length > 0) {
              const pendiente = parseFloat(deudasCalc[0].monto_pendiente);
              if (/\b(la mitad|medio)\b/i.test(msg)) montoAbono = pendiente * 0.5;
              else if (/\b(un tercio|la tercera parte)\b/i.test(msg)) montoAbono = pendiente / 3;
              else if (/\b(un cuarto|la cuarta parte)\b/i.test(msg)) montoAbono = pendiente * 0.25;
              else {
                const pctMatch = msg.match(/(\d+)\s*%/);
                if (pctMatch) montoAbono = pendiente * (parseInt(pctMatch[1]) / 100);
              }
              if (montoAbono) montoAbono = Math.round(montoAbono * 100) / 100;
            }
          }

          // Fallback: extraer monto del mensaje si el clasificador no lo capturó
          if ((!montoAbono || isNaN(montoAbono))) {
            const mMontoFb = msg.match(/(\d+(?:[.,]\d+)?)/);
            if (mMontoFb) montoAbono = parseFloat(mMontoFb[1].replace(',', '.'));
          }

          if (!contraparte || !montoAbono || montoAbono <= 0 || isNaN(montoAbono)) {
            return '¿A quién le pagaste y cuánto? Dime algo como:\n_"le pagué 100 a Juan"_\n_"Annie me dio la mitad"_';
          }
          const resultado = await abonarDeuda(usuario.id, contraparte, montoAbono);
          if (!resultado) {
            return 'No encontré deuda activa con *' + contraparte + '*. Revisa con _"mis deudas"_ a ver si el nombre está bien.';
          }
          const { deuda, completada } = resultado;
          const sym = deuda.moneda === 'USD' ? '$' : 'S/';
          if (completada) {
            return 'Listo, la deuda con *' + deuda.contraparte + '* quedó saldada. 🎉';
          }
          const pct = Math.round(((parseFloat(deuda.monto_original) - parseFloat(deuda.monto_pendiente)) / parseFloat(deuda.monto_original)) * 100);
          return 'Abono anotado con *' + deuda.contraparte + '*.\nLlevas ' + sym + ' ' + (parseFloat(deuda.monto_original) - parseFloat(deuda.monto_pendiente)).toFixed(2) + ' pagado (' + pct + '%), te falta *' + sym + ' ' + parseFloat(deuda.monto_pendiente).toFixed(2) + '*.';
        } catch(e) {
          log.error({ tag: 'DEUDA_ABONAR', err: e.message }, 'Error al abonar deuda');
          return 'Algo falló al registrar el abono. Inténtalo de nuevo.';
        }
      }

      case 'marcar_deuda_pagada': {
        try {
          const contraparte = datos.contraparte;
          if (!contraparte) {
            return '¿Con quién quedó saldada? Dime algo como:\n_"ya le pagué a Juan"_ o _"Renzo ya me pagó"_';
          }
          const deuda = await marcarDeudaPagada(usuario.id, contraparte);
          if (!deuda) {
            return 'No encontré deuda activa con *' + contraparte + '*. Revisa con _"mis deudas"_.';
          }
          return 'Listo, la deuda con *' + deuda.contraparte + '* (' + (deuda.moneda === 'USD' ? '$' : 'S/') + ' ' + parseFloat(deuda.monto_original).toFixed(2) + ') quedó saldada. 🎉';
        } catch(e) {
          log.error({ tag: 'DEUDA_PAGAR', err: e.message }, 'Error al marcar deuda pagada');
          return 'No pude marcar la deuda como pagada. Intenta de nuevo.';
        }
      }

      case 'consolidar_deudas': {
        try {
          const cpCons = datos.contraparte;
          if (!cpCons) return '¿De quién quieres ver el total? Ej: _"cuánto le debo a Juan en total"_';
          const resCons = await consolidarDeudasPorContraparte(usuario.id, cpCons);
          if (!resCons) return 'No encontré deudas activas con *' + cpCons + '*.';
          let msgCons = '📊 *Resumen con ' + resCons.contraparte + '* (' + resCons.deudas.length + ' deuda' + (resCons.deudas.length > 1 ? 's' : '') + ')\n\n';
          if (resCons.debo.PEN > 0 || resCons.debo.USD > 0) {
            msgCons += '📤 *Le debes:*';
            if (resCons.debo.PEN > 0) msgCons += ' S/ ' + resCons.debo.PEN.toFixed(2);
            if (resCons.debo.USD > 0) msgCons += (resCons.debo.PEN > 0 ? ' +' : '') + ' $ ' + resCons.debo.USD.toFixed(2);
            msgCons += '\n';
          }
          if (resCons.meDeben.PEN > 0 || resCons.meDeben.USD > 0) {
            msgCons += '📥 *Te debe:*';
            if (resCons.meDeben.PEN > 0) msgCons += ' S/ ' + resCons.meDeben.PEN.toFixed(2);
            if (resCons.meDeben.USD > 0) msgCons += (resCons.meDeben.PEN > 0 ? ' +' : '') + ' $ ' + resCons.meDeben.USD.toFixed(2);
            msgCons += '\n';
          }
          msgCons += '\n_Escribe "salda todo con ' + resCons.contraparte + '" para cerrar todas._';
          return msgCons;
        } catch(e) {
          log.error({ tag: 'CONSOLIDAR', err: e.message }, 'Error consolidar deudas');
          return 'No pude consultar el total. Intenta de nuevo.';
        }
      }

      case 'saldar_todo_contraparte': {
        try {
          let cpSaldar = datos.contraparte;
          if (!cpSaldar) {
            const mCp = msg.match(/(?:salda|liquida|arregla|cancela)\s+todo\s+(?:con|de)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i);
            if (mCp) cpSaldar = mCp[1].trim();
          }
          if (!cpSaldar) return '¿Con quién quedó todo saldado? Ej: _"salda todo con Juan"_';
          const count = await saldarTodasDeudas(usuario.id, cpSaldar);
          if (!count) return 'No encontré deudas activas con *' + cpSaldar + '*.';
          return '✅ Listo, ' + count + ' deuda' + (count > 1 ? 's' : '') + ' con *' + cpSaldar + '* quedaron saldadas. 🎉';
        } catch(e) {
          log.error({ tag: 'SALDAR_TODO', err: e.message }, 'Error saldar todo');
          return 'No pude saldar las deudas. Intenta de nuevo.';
        }
      }

      case 'compartir_meta': {
        try {
          // Find an active goal to share
          const { data: metasComp } = await supabase
            .from('metas_ahorro')
            .select('id, nombre, icono, monto_objetivo, monto_actual, invite_code, colaborativa')
            .eq('usuario_id', usuario.id)
            .eq('completada', false)
            .order('created_at', { ascending: false });
          if (!metasComp || metasComp.length === 0) return 'No tienes metas activas. Crea una primero: _"quiero ahorrar 3000 para un viaje"_';
          // Use first active goal or try to match by name
          let targetMeta = metasComp[0];
          const mNombre = msg.match(/(?:meta|ahorro)\s+(?:de\s+)?(?:mi\s+)?(.+)/i);
          if (mNombre) {
            const buscar = mNombre[1].trim().toLowerCase();
            const found = metasComp.find(m => m.nombre.toLowerCase().includes(buscar));
            if (found) targetMeta = found;
          }
          // Generate invite code if not exists
          let inviteCode = targetMeta.invite_code;
          if (!inviteCode) {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
            inviteCode = '';
            for (let i = 0; i < 8; i++) inviteCode += chars[Math.floor(Math.random() * chars.length)];
            await supabase.from('metas_ahorro').update({ invite_code: inviteCode, colaborativa: true }).eq('id', targetMeta.id);
            // Ensure creator is in meta_participantes
            await supabase.from('meta_participantes').upsert({ meta_id: targetMeta.id, usuario_id: usuario.id, rol: 'creador' }, { onConflict: 'meta_id,usuario_id' });
          }
          const link = 'https://app.neto.pe/join/meta/' + inviteCode;
          const pct = targetMeta.monto_objetivo > 0 ? Math.round((targetMeta.monto_actual / targetMeta.monto_objetivo) * 100) : 0;
          return '👥 *Meta colaborativa activada*\n\n' + (targetMeta.icono || '🎯') + ' ' + targetMeta.nombre + '\n📊 Progreso: ' + pct + '%\n\n🔗 *Link de invitación:*\n' + link + '\n\n_Comparte este link con quien quieras que aporte a tu meta._';
        } catch(e) {
          log.error({ tag: 'COMPARTIR_META', err: e.message }, 'Error compartir meta');
          return 'No pude generar el link. Intenta de nuevo.';
        }
      }

      case 'dividir_gasto_grupal': {
        try {
          // Support both "entre N" and "con N amigos/personas"
          const mSplit = msg.match(/(\d+[\d,.]*)\b.+?\bentre\s+(\d+)/i) ||
                         msg.match(/(\d+[\d,.]*)\b.+?\bcon\s+(\d+)\s+(?:amigos?|personas?)/i);
          if (!mSplit) return '¿Cuánto pagaste y entre cuántos? Ej: _"pagué 300 la cena entre 4"_';
          const montoTotal = parseFloat(mSplit[1].replace(',', '.'));
          const numPersonas = parseInt(mSplit[2]);
          if (isNaN(montoTotal) || montoTotal <= 0 || numPersonas < 2) return 'Necesito un monto válido y al menos 2 personas.';
          const perPerson = Math.round((montoTotal / numPersonas) * 100) / 100;
          // Extract description - skip bare currency words
          const mDesc = msg.match(/(?:pagu[eé]|divid[eiír]|split)\s+\d+[\d,.]*\s+(?:soles?\s+|d[oó]lares?\s+|USD\s+)?(?:(?:con|de|la|el|por|en\s+una?)\s+)?(.+?)(?:\s+(?:entre|con)\s+\d+)/i);
          let descripcion = mDesc ? mDesc[1].trim() : '';
          descripcion = descripcion.replace(/^(?:soles?|d[oó]lares?|USD|PEN)\s*/i, '').replace(/\s+(?:con|entre)\s+\d+.*$/i, '').trim();
          if (!descripcion || /^(?:amigos?|personas?|gente)$/i.test(descripcion)) descripcion = 'Gasto compartido';
          // Extract participant names: "con Annie, Diego y Cesar"
          const nombresExtraidos = [];
          const mNombres = msg.match(/\b(?:con|entre)\s+([A-Za-záéíóúÁÉÍÓÚüÜñÑ][\wáéíóúüñÁÉÍÓÚÜÑ ,]+?)(?:\s+(?:en|por|para|entre|\d)|$)/i);
          if (mNombres) {
            const partes = mNombres[1].split(/,\s*|\s+y\s+/i)
              .map(n => n.trim())
              .filter(n => n.length > 1 && !/^(\d+|amigos?|personas?|gente|mis|los|sus|unos?|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)$/i.test(n));
            nombresExtraidos.push(...partes);
          }
          // Create the shared expense
          const { data: gastoComp, error: gcErr } = await supabase
            .from('gastos_compartidos')
            .insert({ creador_id: usuario.id, descripcion, monto_total: montoTotal, moneda: 'PEN', fecha: hoyPeru() })
            .select().single();
          if (gcErr) throw gcErr;
          // Create participants - use extracted names when available
          const participantes = [];
          for (let i = 0; i < numPersonas - 1; i++) {
            participantes.push({ gasto_id: gastoComp.id, nombre: nombresExtraidos[i] || ('Persona ' + (i + 1)), monto_debe: perPerson, pagado: false });
          }
          await supabase.from('gasto_participantes').insert(participantes);
          const nombresStr = participantes.map(p => p.nombre).join(', ');
          return '✅ *Gasto compartido creado*\n\n📝 ' + descripcion + '\n💰 Total: S/ ' + montoTotal.toFixed(2) + '\n👥 ' + numPersonas + ' personas (' + nombresStr + ')\n💳 Cada uno: *S/ ' + perPerson.toFixed(2) + '*\n\n_Ve a app.neto.pe > Deudas > Compartidos para editar y marcar pagos._';
        } catch(e) {
          log.error({ tag: 'DIVIDIR_GASTO', err: e.message }, 'Error dividir gasto');
          return 'No pude crear el gasto compartido. Intenta de nuevo.';
        }
      }

      default: {
        if (/\d/.test(msg) && msg.length > 8) {
          try {
            const resultado = await parsearCorreoBancario(msg);
            if (resultado.monto && resultado.monto > 0) {
              await guardarTransaccion(usuario.id, resultado);
              let resp = '\uD83D\uDCB3 *Transaccion registrada*\n' + (resultado.tipo === 'gasto' ? 'Gasto' : 'Ingreso') + ': S/ ' + resultado.monto + '\nComercio: ' + (resultado.comercio || 'No detectado') + '\nCategoria: ' + (resultado.categoria || 'Sin categoria');
              if (resultado.tipo === 'gasto' && resultado.categoria) { const alerta = await verificarAlertaPresupuesto(usuario.id, resultado.categoria, null); if (alerta) resp += '\n\n' + alerta; }
              return resp + '\n\n_Escribe "mis gastos del mes" para ver el resumen._';
            }
          } catch(e) { log.warn({ tag: 'FALLBACK_TX', err: e.message }, 'Error en fallback transaccion'); }
        }
        // Log NLP desconocido para revisión admin
        supabase.from('nlp_errors').insert({
          usuario_id: usuario.id, whatsapp: from,
          mensaje: msg.substring(0, 500), intencion: intencion || 'desconocido',
          error_tipo: 'desconocido', error_detalle: 'Mensaje no clasificado por NLP'
        }).then(() => {}).catch(() => {});
        const ctxDef = 'El usuario envio un mensaje que no encaja claramente con ninguna intencion: "' + msg + '". Responde en tono NETO: reconoce el mensaje, ofrece ayuda concreta con los gastos o finanzas del usuario.';
        const respDef = await redactarConNETO(netoPrompt, ctxDef, msg, historialConv);
        return respDef || 'No entendi bien, pero estoy aqui. Escribe _"cuanto gaste esta semana"_ o _"dame mi reporte"_ y arrancamos. \u00bfQue necesitas?';
      }
    }
  } catch(e) {
    log.error({ tag: 'NLP', err: e.message }, 'Error en procesamiento NLP'); notificarErrorAdmin('NLP', e.message); registrarError('NLP', e.message, { stack: e.stack, whatsapp: from });
    // Log NLP error para revisión admin
    supabase.from('nlp_errors').insert({
      usuario_id: usuario ? usuario.id : null, whatsapp: from,
      mensaje: msg.substring(0, 500), intencion: null,
      error_tipo: 'error', error_detalle: e.message
    }).then(() => {}).catch(() => {});
    return 'Tuve un problema. Intenta de nuevo.';
  }
}

// enviarAlertaTransaccion → services/notifications.js
// escaneoAutomatico → services/gmail-scanner.js
// generarResumenSemanal, generarResumenMensual → services/summaries.js

async function checkResumenMensual() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  // Solo el día 1 del mes, entre 9:00 y 9:14 AM Lima
  if (horaLima.getDate() !== 1 || horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenMensual(usuario);
        if (resumen) await enviarWhatsapp(usuario.whatsapp, resumen);
      } catch(e) { log.error({ tag: 'MENSUAL', whatsapp: usuario.whatsapp, err: e.message }, 'Error resumen mensual usuario'); }
    }
  } catch(e) { log.error({ tag: 'MENSUAL', err: e.message }, 'Error general resumen mensual'); }
}

async function checkResumenSemanal() {
  const horaLima = new Date(Date.now() - 5 * 60 * 60 * 1000);
  if (horaLima.getUTCDay() !== 1 || horaLima.getUTCHours() !== 8 || horaLima.getUTCMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resumen = await generarResumenSemanal(usuario);
        if (resumen) await enviarWhatsapp(usuario.whatsapp, resumen);
      } catch(e) { log.error({ tag: 'SEMANAL', whatsapp: usuario.whatsapp, err: e.message }, 'Error resumen semanal usuario'); }
    }
  } catch(e) { log.error({ tag: 'SEMANAL', err: e.message }, 'Error general resumen semanal'); }
}

async function checkRecordatorioDiario() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  // Solo a las 20:00-20:14 Lima
  if (horaLima.getHours() !== 20 || horaLima.getMinutes() > 14) return;
  const hoy = hoyPeru();
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, plan, recordatorios_activos, created_at')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        // Respetar preferencia del usuario (default: activos)
        if (usuario.recordatorios_activos === false) continue;
        // Recordatorios diarios solo para premium (PLAN_CONFIG.free.recordatorios = false)
        const planConfig = getUserPlanConfig(usuario);
        if (!planConfig.recordatorios) {
          // Upsell: si el usuario free cumple ~30 días, enviar invitación a Pro (una sola vez)
          if (usuario.created_at) {
            const diasDesdeRegistro = Math.floor((Date.now() - new Date(usuario.created_at).getTime()) / 86400000);
            if (diasDesdeRegistro >= 28 && diasDesdeRegistro <= 30) {
              const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
              await enviarWhatsapp(usuario.whatsapp, '🎉 ' + (primerNombre ? primerNombre + ', ¡' : '¡') + 'llevas 1 mes usando Neto!\n\nCon *NETO Pro* desbloqueas:\n\n✅ Historial completo (no solo este mes)\n✅ Lectura automática de correos bancarios\n✅ Recordatorios diarios + consejos IA\n✅ Exportar tus datos\n\n💰 *S/10/mes* o *S/99/año*\n\n📲 Yapea al *970398192* y envíame la captura.\n\n_Escribe /premium para más info._');
            }
          }
          continue;
        }
        // Verificar si tiene transacciones hoy
        const { data: txsHoy } = await supabase.from('transacciones').select('id')
          .eq('usuario_id', usuario.id).eq('fecha', hoy).limit(1);
        if (txsHoy && txsHoy.length > 0) continue; // Ya tiene gastos hoy
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
        const msg = '📝 ' + (primerNombre ? primerNombre + ', ¿' : '¿') + 'registraste tus gastos de hoy?\n\n' +
          'Escríbeme así:\n_"gasté 30 en almuerzo"_\n_"taxi 15 soles"_\n\nO envía una foto de tu Yape/Plin.\n\n' +
          '_Para desactivar recordatorios escribe /silenciar_';
        await enviarWhatsapp(usuario.whatsapp, msg);
      } catch(e) { /* silencioso por usuario */ }
    }
  } catch(e) { log.error({ tag: 'RECORDATORIO', err: e.message }, 'Error recordatorio diario'); }
}

async function checkPremiumExpiry() {
  try {
    const hoy = hoyPeru();
    // Encontrar usuarios premium cuyo plan venció
    const { data: expirados } = await supabase.from('usuarios').select('id, whatsapp, nombre, premium_vence')
      .eq('plan', 'premium').not('premium_vence', 'is', null).lt('premium_vence', hoy);
    if (!expirados || expirados.length === 0) return;
    for (const usuario of expirados) {
      try {
        await supabase.from('usuarios').update({ plan: 'free' }).eq('id', usuario.id);
        const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
        await enviarWhatsapp(usuario.whatsapp, '⏰ ' + (primerNombre ? primerNombre + ', t' : 'T') + 'u plan *NETO Pro* venció.\n\nAhora estás en el plan Free (historial limitado a 1 mes).\n\n¿Quieres renovar?\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.\n\n_Tus datos siguen guardados. Al renovar recuperas acceso completo._');
        log.info({ tag: 'EXPIRY', userId: usuario.id }, 'Premium expirado, downgradeado a free');
      } catch(e) { log.error({ tag: 'EXPIRY', userId: usuario.id, err: e.message }, 'Error downgradeando usuario'); }
    }
  } catch(e) { log.error({ tag: 'EXPIRY', err: e.message }, 'Error general check premium expiry'); }
}

async function checkAlertasProactivas() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  // Miércoles a las 10:00-10:14 AM Lima (mitad de semana)
  if (horaLima.getDay() !== 3 || horaLima.getHours() !== 10 || horaLima.getMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, recordatorios_activos')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        if (usuario.recordatorios_activos === false) continue;
        const alerta = await verificarAlertasProactivas(usuario.id, usuario.nombre);
        if (alerta) await enviarWhatsapp(usuario.whatsapp, alerta);
      } catch (e) { /* silencioso por usuario */ }
    }
  } catch (e) { log.error({ tag: 'ALERTA_PROACTIVA', err: e.message }, 'Error alertas proactivas'); }
}

async function checkRecordatorioOnboarding() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  // Solo entre 9am y 9pm Lima
  if (horaLima.getHours() < 9 || horaLima.getHours() >= 21) return;
  try {
    // Usuarios que se registraron hace 3-6 horas y no completaron onboarding
    const hace6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const hace3h = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, onboarding_paso, onboarding_completado')
      .or('onboarding_completado.is.null,onboarding_completado.eq.false')
      .gte('created_at', hace6h)
      .lte('created_at', hace3h)
      .in('onboarding_paso', [0, 100, 101]);
    if (!usuarios || usuarios.length === 0) return;
    for (const u of usuarios) {
      try {
        const primerNombre = u.nombre ? u.nombre.split(' ')[0] : null;
        let nudge = '';
        if (u.onboarding_paso === 0 || u.onboarding_paso === 100) {
          // No dio su nombre aún
          nudge = '👋 ' + (primerNombre ? primerNombre + ', t' : 'T') + 'e faltó completar tu registro en Neto.\n\n' +
            '¿Cómo te llamas? Escríbeme tu nombre y empezamos. 😊\n\n' +
            '_Solo toma 1 minuto._';
        } else if (u.onboarding_paso === 101) {
          // Dio nombre pero no email
          nudge = '👋 ' + (primerNombre || 'Hola') + ', te faltó tu correo para completar el registro.\n\n' +
            '¿Cuál es tu email? Ej: _"juan@gmail.com"_\n\n' +
            '_Es el último paso, prometido._';
        }
        if (nudge) {
          await enviarWhatsapp(u.whatsapp, nudge);
          // Mover a paso 100 o mantener en 101 para que al responder continúe el flujo
          if (u.onboarding_paso === 0) {
            await supabase.from('usuarios').update({ onboarding_paso: 100 }).eq('id', u.id);
          }
        }
      } catch(e) { /* silencioso por usuario */ }
    }
  } catch(e) { log.error({ tag: 'ONBOARDING_REMINDER', err: e.message }, 'Error recordatorio onboarding'); }
}

// === Cron: Recordatorios inteligentes de deudas (diario 9am Lima) ===
async function checkRecordatorioDeudas() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  if (horaLima.getHours() !== 9 || horaLima.getMinutes() > 14) return;
  try {
    const hoy = hoyPeru();
    const hoyDate = new Date(hoy + 'T12:00:00');
    const deudasProximas = await obtenerDeudasProximasVencer();
    if (!deudasProximas.length) return;

    for (const deuda of deudasProximas) {
      try {
        if (deuda.usuarios.recordatorios_activos === false) continue;
        const venc = new Date(deuda.fecha_vencimiento + 'T12:00:00');
        const diffDias = Math.round((venc - hoyDate) / 86400000);
        const sym = deuda.moneda === 'USD' ? '$' : 'S/';
        const primerNombre = deuda.usuarios.nombre ? deuda.usuarios.nombre.split(' ')[0] : null;
        const saludo = primerNombre ? primerNombre + ', ' : '';
        const montoStr = sym + ' ' + parseFloat(deuda.monto_pendiente).toFixed(2);

        let msgDeuda = null;
        if (diffDias === 3) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '📅 ' + saludo + 'en 3 días vence lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Ya te pagó?'
            : '📅 ' + saludo + 'en 3 días vence tu deuda con *' + deuda.contraparte + '* (' + montoStr + '). ¡No te olvides!';
        } else if (diffDias === 1) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '⏰ ' + saludo + 'mañana vence lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Ya te pagó?\n\n_Responde "sí, ya me pagó" o "todavía no"._'
            : '⏰ ' + saludo + 'mañana vence tu deuda con *' + deuda.contraparte + '* (' + montoStr + '). ¡Que no se te pase!';
        } else if (diffDias === 0) {
          msgDeuda = '🔴 ' + saludo + '¡Hoy vence ' + (deuda.tipo === 'me_deben' ? 'lo que te debe' : 'tu deuda con') + ' *' + deuda.contraparte + '* (' + montoStr + ')!';
        } else if (diffDias === -3) {
          msgDeuda = deuda.tipo === 'me_deben'
            ? '⚠️ ' + saludo + 'ya pasaron 3 días desde que venció lo de *' + deuda.contraparte + '* (' + montoStr + '). ¿Le recuerdas?'
            : '⚠️ ' + saludo + 'tu deuda con *' + deuda.contraparte + '* lleva 3 días vencida (' + montoStr + '). ¿Ya pagaste?';
        }

        if (msgDeuda) {
          await enviarWhatsapp(deuda.usuarios.whatsapp, msgDeuda);
        }
      } catch (e) { /* silent per debt */ }
    }
  } catch (e) { log.error({ tag: 'DEUDA_REMINDER', err: e.message }, 'Error recordatorio deudas'); }
}

// Middleware centralizado de errores (debe estar después de todas las rutas)
app.use((err, req, res, next) => {
  log.error({ tag: 'EXPRESS', err: err.message, stack: err.stack, path: req.path, method: req.method }, 'Error no manejado');
  notificarErrorAdmin('EXPRESS', err.message, req.method + ' ' + req.path);
  registrarError('EXPRESS', err.message, { detalle: req.method + ' ' + req.path, stack: err.stack });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const PORT = process.env.PORT || 3000;
const INTERVALO_HORAS = parseFloat(process.env.SCAN_INTERVAL_HOURS || '0.25');
const INTERVALO_MS = INTERVALO_HORAS * 60 * 60 * 1000;

// Solo levantar servidor si se ejecuta directamente (no en tests)
if (require.main === module) {
  app.listen(PORT, () => {
    log.info({ tag: 'SERVER', port: PORT }, 'NETO v5 iniciado');
    setTimeout(() => {
      // Tareas programadas solo en producción (evita enviar WhatsApps reales en dev/test)
      if (process.env.NODE_ENV === 'production') {
        escaneoAutomatico();
        setInterval(escaneoAutomatico, INTERVALO_MS);
        log.info({ tag: 'AUTO', intervaloHoras: INTERVALO_HORAS }, 'Escaneo automático activo');
        setInterval(checkResumenSemanal, 15 * 60 * 1000);
        log.info({ tag: 'SEMANAL' }, 'Resumen semanal activo (lunes 8am Lima)');
        setInterval(checkResumenMensual, 15 * 60 * 1000);
        log.info({ tag: 'MENSUAL' }, 'Resumen mensual activo (1ro de cada mes 9am Lima)');
        setInterval(checkRecordatorioDiario, 15 * 60 * 1000);
        log.info({ tag: 'RECORDATORIO' }, 'Recordatorios diarios activos (8pm Lima)');
        setInterval(checkAlertasProactivas, 15 * 60 * 1000);
        log.info({ tag: 'ALERTAS' }, 'Alertas proactivas activas (miércoles 10am Lima)');
        setInterval(checkPremiumExpiry, 60 * 60 * 1000); // Cada hora
        log.info({ tag: 'EXPIRY' }, 'Check expiración premium activo (cada 1h)');
        setInterval(checkRecordatorioOnboarding, 15 * 60 * 1000);
        log.info({ tag: 'ONBOARDING' }, 'Recordatorio onboarding activo (3h después de registro, 9am-9pm Lima)');
        setInterval(checkRecordatorioDeudas, 15 * 60 * 1000);
        log.info({ tag: 'DEUDAS' }, 'Recordatorios de deudas activos (diario 9am Lima)');
        setTimeout(runBackup, 60000); // primer backup 1 min después de arrancar
        setInterval(runBackup, 7 * 24 * 60 * 60 * 1000); // backup semanal
        log.info({ tag: 'BACKUP' }, 'Backup semanal activo');
      } else {
        log.warn({ tag: 'SERVER' }, 'Tareas programadas desactivadas (NODE_ENV !== production)');
      }
      setInterval(limpiarContadores, 60 * 60 * 1000);
      log.info({ tag: 'MONITOR' }, 'Monitor de errores activo');
    }, 30000);
  });
}

// Exports para tests
module.exports = {
  validarMonto, normalizarCategoria, formatFecha, barraProgreso,
  fechaHoyPeru, fechaAyerPeru, ultimoDiaMes,
  CATEGORIAS_VALIDAS, CATEGORIA_MAP, MESES,
  parsearCorreoBancario, parsearRegistroManual,
  app
};