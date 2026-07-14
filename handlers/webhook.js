const crypto = require('crypto');
const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { CATEGORIAS_SUGERIDAS, MESES } = require('../lib/constants');
const { getEmojiCategoria, formatearResumen, formatearCategoriasMsg, parsearIndicesRespuesta, generarRefCode } = require('../lib/formatters');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { ADMIN_NUMBER } = require('../lib/config');
const { guardarTransaccion, obtenerGastosMes, recategorizarTransaccion } = require('../services/transactions');
const { guardarPresupuesto, formatearEstadoPresupuesto } = require('../services/budget');
const { parsearCorreoBancario, interpretarComandoPresupuesto } = require('../services/parsers');
const { notificarErrorAdmin } = require('../lib/admin-notify');
const { registrarError } = require('../lib/error-monitor');
const { generarUrlAutorizacion, obtenerCuentasGmail } = require('../gmail');
const { registrarReferido, verificarProReferidos } = require('../services/referrals');
const { obtenerCategoriasUsuario, crearCategoriasDesdeIndices } = require('../services/categories');
const { escanearGmailYRegistrar } = require('../services/gmail-scanner');
const { generarResumenSemanal } = require('../services/summaries');
const { guardarMensaje, obtenerOCrearUsuario, getUserPlanConfig } = require('../helpers/db-helpers');
const { esperaComprobante, esPagoNeto, procesarComprobantePro, registrarPagoAprobado } = require('../lib/pro-payment');
const { procesarComandoAdmin } = require('./admin-commands');
const analytics = require('../lib/analytics');

// Idempotencia por wamid: Meta retransmite el webhook cada 30s si OpenAI demora >timeout.
// Map preserva orden de inserción → LRU. TTL 5 min, max 1000 entries.
// Cero delay, cero serialización: solo evita reprocesar el mismo message.id.
const WAMID_CACHE_TTL_MS = 5 * 60 * 1000;
const WAMID_CACHE_MAX = 1000;
const wamidCache = new Map();
function isDuplicateWamid(wamid) {
  if (!wamid) return false;
  const now = Date.now();
  const insertedAt = wamidCache.get(wamid);
  if (insertedAt !== undefined && now - insertedAt < WAMID_CACHE_TTL_MS) return true;
  if (insertedAt !== undefined) wamidCache.delete(wamid);
  if (wamidCache.size >= WAMID_CACHE_MAX) wamidCache.delete(wamidCache.keys().next().value);
  wamidCache.set(wamid, now);
  return false;
}

function createWebhookHandler(procesarMensajeLibre) {
  return async function webhookHandler(req, res) {
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
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  // Guarda de longitud: timingSafeEqual lanza RangeError si los buffers difieren en
  // largo. Sin esto, una firma malformada responde 500 (en vez de 403) y dispara la
  // notificación de error al admin. Mismo patrón que telegram-webhook.js.
  if (sigBuf.length !== expBuf.length) {
    log.warn({ tag: 'WEBHOOK' }, 'Firma HMAC con largo invalido');
    return res.sendStatus(403);
  }
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
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
    if (isDuplicateWamid(message.id)) {
      log.info({ tag: 'WEBHOOK', wamid: message.id, from }, 'Wamid duplicado — skip');
      return;
    }

    // --- Manejo de imágenes ---
    if (message.type === 'image') {
      const usuario = await obtenerOCrearUsuario(from);

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

        // Si el usuario está esperando enviar su comprobante Pro, tratar la captura como pago Pro
        // (cubre onboarding paso 2 y usuarios ya registrados que pidieron Pro por /premium o cron).
        if (esperaComprobante(usuario)) {
          if (parsed.tipo === 'no_pago' || !parsed.monto || isNaN(parseFloat(parsed.monto))) {
            await enviarWhatsapp(from, 'No reconocí un pago en esa imagen. Envíame la captura del Yape (S/10 mensual o S/99 anual a *Favio Mendoza*) para activar tu Pro. 📸');
            return;
          }
          if (!esPagoNeto(parsed)) {
            await enviarWhatsapp(from, 'Esa captura no parece el pago a Neto (S/10 mensual o S/99 anual a *Favio Mendoza*). Si ya pagaste, reenvíame la captura correcta. 📸');
            return;
          }
          parsed.fecha = parsed.fecha || hoy;
          await procesarComprobantePro({ usuario, parsed, imgBuffer, mimeType, from });
          // Registrar también el gasto de suscripción del usuario (se auto-categoriza a Suscripciones > Software)
          try { await guardarTransaccion(usuario.id, parsed); }
          catch(eTx) { log.error({ tag: 'PRO_PAGO', err: eTx.message }, 'Error registrando tx de comprobante'); }
          return;
        }

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

    // --- Manejo de notas de voz (audio) ---
    // Transcribimos con Whisper (OpenAI) y reinyectamos el texto en el pipeline de
    // texto: reasignamos message.type/text y dejamos caer el flujo hasta el bloque
    // de texto de abajo. Así una nota de voz "gasté 20 soles en el almuerzo" registra
    // el gasto igual que si se hubiera escrito, sin duplicar la lógica de NLP.
    if (message.type === 'audio') {
      const mediaId = message.audio && message.audio.id;
      const phoneId = process.env.META_PHONE_NUMBER_ID;
      const metaToken = process.env.META_ACCESS_TOKEN;
      log.info({ tag: 'AUDIO', mediaId, phoneId, tokenOk: !!metaToken }, 'Procesando nota de voz');
      if (!mediaId) { await enviarWhatsapp(from, 'No pude recibir tu nota de voz. Intenta de nuevo. 🎤'); return; }
      try {
        // 1. Obtener URL del audio desde Meta API (mismo patrón que imágenes)
        const metaUrl = 'https://graph.facebook.com/v19.0/' + mediaId + '?phone_number_id=' + phoneId;
        const metaRes = await fetch(metaUrl, { headers: { Authorization: 'Bearer ' + metaToken } });
        const metaJson = await metaRes.json();
        if (!metaJson.url) throw new Error('Meta no devolvió URL del audio: ' + JSON.stringify(metaJson).slice(0, 100));

        // 2. Descargar el audio (WhatsApp envía las notas de voz como audio/ogg opus)
        const audioRes = await fetch(metaJson.url, { headers: { Authorization: 'Bearer ' + metaToken } });
        if (!audioRes.ok) throw new Error('Error descargando audio: ' + audioRes.status);
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
        const mimeType = metaJson.mime_type || (message.audio && message.audio.mime_type) || 'audio/ogg';
        // La extensión debe coincidir con el contenedor o Whisper rechaza el archivo.
        const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
          : mimeType.includes('wav') ? 'wav' : mimeType.includes('amr') ? 'amr' : 'ogg';
        log.info({ tag: 'AUDIO', mimeType, ext, size: audioBuffer.byteLength }, 'Audio descargado');

        // 3. Transcribir con Whisper. gpt-4o-mini-transcribe: ~mitad del costo de
        // whisper-1 y mejor calidad en español. language:'es' ancla el idioma.
        const { toFile } = require('openai');
        const file = await toFile(audioBuffer, 'audio.' + ext, { type: mimeType });
        const transcripcion = await openai.audio.transcriptions.create({
          file,
          model: 'gpt-4o-mini-transcribe',
          language: 'es',
        });
        const texto = (transcripcion.text || '').trim();
        log.info({ tag: 'AUDIO', texto: texto.slice(0, 100) }, 'Nota de voz transcrita');

        if (!texto) {
          await enviarWhatsapp(from, 'No logré entender tu nota de voz. 🎤 Intenta de nuevo hablando claro, o escríbeme el gasto (ej: "gasté 20 soles en el almuerzo").');
          return;
        }

        // 4. Reinyectar en el pipeline de texto: el resto del handler procesa `message`
        // como si el usuario hubiera escrito la transcripción.
        message.type = 'text';
        message.text = { body: texto };
      } catch (e) {
        log.error({ tag: 'AUDIO', err: e.message }, 'Error procesando nota de voz'); registrarError('AUDIO', e.message, { stack: e.stack, whatsapp: from });
        await enviarWhatsapp(from, 'No pude procesar tu nota de voz. 🎤 Intenta de nuevo, o escríbeme el gasto (ej: "gasté 20 soles en el almuerzo").');
        return;
      }
    }

    if (message.type !== 'text') return;
    const msg = (message.text.body || '').trim();
    log.info({ tag: 'MSG', from, msg: msg.substring(0, 100) }, 'Mensaje recibido');

    let respuesta = '';
    const usuario = await obtenerOCrearUsuario(from);
    const cmd = msg.toLowerCase().trim();

    // Verificación de cuenta web (OTP inverso). El usuario se logueó con Google en
    // app.neto.pe y, para probar posesión de su número, envía este código pre-escrito
    // (wa.me deep link). Aquí `from` es el número REAL que envió → posesión probada.
    // Recién aquí se vincula la cuenta Google (cierra el hueco de account-linking del
    // onboarding webapp). Ver migrations/020_webapp_otp.sql.
    const otpMatch = msg.match(/NETO-(\d{6})/i);
    if (otpMatch) {
      const code = 'NETO-' + otpMatch[1];
      try {
        const { data: otp } = await supabase.from('webapp_otp')
          .select('id, supabase_auth_id, email, nombre, expires_at, verified_at')
          .eq('code', code).is('verified_at', null).maybeSingle();
        if (otp && new Date(otp.expires_at).getTime() > Date.now()) {
          const { error: linkErr } = await supabase.from('usuarios').update({
            supabase_auth_id: otp.supabase_auth_id,
            email: otp.email || usuario.email,
            nombre: usuario.nombre || otp.nombre,
            onboarding_completado: true,
          }).eq('id', usuario.id);
          if (linkErr) {
            // 23505: el correo de la cuenta web ya pertenece a otro WhatsApp
            // (índice usuarios_email_lower_unique). No marcamos verificado.
            if (linkErr.code === '23505') {
              await enviarWhatsapp(from, '⚠️ Ese correo ya está vinculado a otra cuenta de WhatsApp en Neto.\n\nSi es tuyo, escríbenos a soporte y lo resolvemos.');
              return;
            }
            throw linkErr;
          }
          await supabase.from('webapp_otp').update({
            verified_at: new Date().toISOString(),
            whatsapp_verified: from.replace(/^\+/, ''),
          }).eq('id', otp.id);
          const pn = (otp.nombre || usuario.nombre || '').split(' ')[0];
          await enviarWhatsapp(from, '✅ ' + (pn ? pn + ', t' : 'T') + 'u cuenta web quedó verificada y vinculada a este WhatsApp.\n\nYa puedes volver a app.neto.pe. 🎉');
          log.info({ tag: 'WEBAPP_OTP', usuarioId: usuario.id }, 'Cuenta web verificada');
        } else {
          await enviarWhatsapp(from, '⚠️ Ese código de verificación no es válido o ya expiró.\n\nVuelve a app.neto.pe y genera uno nuevo.');
        }
        return;
      } catch (e) {
        log.error({ tag: 'WEBAPP_OTP', err: e.message }, 'Error verificando cuenta web');
        // cae al flujo normal
      }
    }

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
      // El correo debe ser único: lo usaremos para vincular tu cuenta cuando pases a Pro.
      const { data: emailEnUso } = await supabase
        .from('usuarios')
        .select('id')
        .eq('email', emailInput)
        .neq('id', usuario.id)
        .limit(1);
      if (emailEnUso && emailEnUso.length > 0) {
        respuesta = 'Ese correo ya está registrado con otra cuenta. 🤔\n\nEscríbeme otro, porfa. Es importante que sea válido y tuyo porque lo usaremos para vincularte cuando quieras pasar a *Pro*.';
        await enviarWhatsapp(from, respuesta);
        return;
      }
      const { error: emailUpdErr } = await supabase.from('usuarios').update({ email: emailInput, onboarding_paso: 1 }).eq('id', usuario.id);
      if (emailUpdErr) {
        // 23505 = unique_violation: otro usuario tomó ese correo en la ventana
        // entre el chequeo de arriba y este update (índice usuarios_email_lower_unique).
        if (emailUpdErr.code === '23505') {
          respuesta = 'Ese correo ya está registrado con otra cuenta. 🤔\n\nEscríbeme otro, porfa. Es importante que sea válido y tuyo porque lo usaremos para vincularte cuando quieras pasar a *Pro*.';
          await enviarWhatsapp(from, respuesta);
          return;
        }
        throw emailUpdErr;
      }
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
        analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'free' });
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
        analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'categorias' });
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
        var catsHola = await obtenerCategoriasUsuario(usuario.id);
        var tipCats = (!usuario.onboarding_completado && !catsHola) ? '\n\n\uD83D\uDCA1 Escribe */categorias* para personalizar tus categorias.' : '';
        var saludo = primerNombre ? 'Hola, ' + primerNombre + '!' : 'Hola!';
        respuesta = '\uD83D\uDC4B Hola' + (primerNombre ? ', ' + primerNombre : '') + '. Soy NETO.\n\n' +
          (gastosMesHola.length > 0 ? 'Este mes llevas *S/ ' + totalMesHola.toFixed(2) + '* en ' + gastosMesHola.length + ' movimientos.' : 'Sin movimientos este mes aun.') +
          '\n\n📊 Revisa tu dashboard en *https://app.neto.pe*\n\n\u00bfQue revisamos?';
      }
    } else if (cmd === '/manual') {
      // Onboarding sin Gmail — modo free
      await supabase.from('usuarios').update({ plan: 'free', onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
      analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'manual' });
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
    } else if (cmd === '/manoslibres') {
      if (!getUserPlanConfig(usuario).resumenDiario) {
        respuesta = '⭐ *El Modo Manos Libres es una función Pro.*\n\nCada noche a las 9pm te mando un resumen de lo que gastaste en el día, sin que hagas nada.\n\n💰 *S/10/mes* o *S/99/año*\n📲 Yapea al *970398192* y envíame la captura.';
      } else {
        const nuevoEstado = !usuario.manos_libres;
        await supabase.from('usuarios').update({ manos_libres: nuevoEstado }).eq('id', usuario.id);
        respuesta = nuevoEstado
          ? '🌙 *Modo Manos Libres activado.*\n\nCada noche a las 9pm te mando un resumen de lo que gastaste en el día. Escribe */manoslibres* de nuevo para desactivarlo.'
          : '✅ Modo Manos Libres desactivado. Ya no te mandaré el resumen diario.';
      }
    } else if (cmd === '/alertas') {
      // Opt-out de la tarjeta "Nuevo gasto" que se manda al detectar un movimiento en Gmail.
      // Legacy/undefined cuenta como activada (default true en DB).
      const alertasActivas = usuario.alertas_transaccion !== false;
      const nuevoEstadoAlertas = !alertasActivas;
      const { error: errAlertas } = await supabase.from('usuarios').update({ alertas_transaccion: nuevoEstadoAlertas }).eq('id', usuario.id);
      if (errAlertas) {
        // Nunca confirmar un cambio que no se persistio (ej: columna ausente).
        log.error({ tag: 'ALERTAS', err: errAlertas.message }, 'No se pudo guardar preferencia de alertas');
        respuesta = 'No pude guardar ese cambio ahora. Intenta de nuevo en un momento.';
      } else {
        respuesta = nuevoEstadoAlertas
          ? '🔔 *Alertas activadas.*\n\nTe aviso por aquí cada vez que detecte un movimiento en tu correo. Escribe */alertas* de nuevo para apagarlas.'
          : '🔕 *Alertas desactivadas.*\n\nYa no te aviso por WhatsApp cuando detecte un movimiento. Neto los sigue registrando y los ves en https://app.neto.pe\n\nEscribe */alertas* para reactivarlas.';
      }
    } else if (cmd === '/pendientes') {
      respuesta = '✅ Ya no necesitas categorizar por aquí. Neto categoriza tus gastos automáticamente.\n\n📊 Revisa o ajusta las categorías en https://app.neto.pe/dashboard/transacciones';
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
        '_¿Dudas? Escribe al +' + ADMIN_NUMBER + '_';
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
    } else if (cmd.startsWith('/activar ') || cmd.startsWith('/pago ') || cmd === '/usuarios' || cmd === '/admin' || cmd === '/panel') {
      // Comandos admin (solo Favio). La logica vive en handlers/admin-commands.js,
      // compartida con el webhook de Telegram para que ambos canales se comporten igual.
      if (from !== ADMIN_NUMBER) {
        respuesta = 'No tienes permiso para usar este comando.';
      } else {
        respuesta = await procesarComandoAdmin(cmd);
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
    } else if (cmd === '/ayuda') {
      const mesActual = new Date().getMonth() + 1;
      respuesta = '*Comandos NETO:*\n*/semana* -- gastos 7 dias\n*/mes* -- gastos del mes\n*/presupuesto* -- ver/configurar presupuesto\n*/categorias* -- categorias\n*/conectar* -- vincular Gmail\n*/escanear* -- leer correos ahora\n*/cambiar [comercio] [cat]* -- corregir categoria\n*/reporte* -- PDF del mes\n*/reporte ' + mesActual + '* -- PDF mes especifico\n*/alertas* -- activar/desactivar avisos de Gmail\n*/dashboard* -- ir a tu app (https://app.neto.pe)\n*/referir* -- invitar amigos y ganar Pro\n*/premium* -- plan premium\n*hola* -- estado general\n\n_Tambien puedes escribirme en lenguaje natural!_';
    } else {
      respuesta = await procesarMensajeLibre(msg, usuario, from);
    }
    if (respuesta) {
      await enviarWhatsapp(from, respuesta);
      // Guardar respuesta de NETO en historial
      try { await guardarMensaje(usuario.id, 'neto', respuesta); } catch(e) {}
    }
  } catch (error) { log.error({ tag: 'WEBHOOK', err: error.message }, 'Error en webhook'); notificarErrorAdmin('WEBHOOK', error.message); registrarError('WEBHOOK', error.message, { stack: error.stack, whatsapp: from }); }

  };
}

module.exports = createWebhookHandler;
