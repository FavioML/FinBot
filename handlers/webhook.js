const crypto = require('crypto');
const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { CATEGORIAS_SUGERIDAS, MESES } = require('../lib/constants');
const { getEmojiCategoria, formatearResumen, formatearPendientes, formatearCategoriasMsg, parsearIndicesRespuesta, generarRefCode } = require('../lib/formatters');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { ADMIN_NUMBER } = require('../lib/config');
const { guardarTransaccion, obtenerGastosMes, recategorizarTransaccion, obtenerConsultasPendientes } = require('../services/transactions');
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
const { intentarResolverConsulta } = require('../helpers/consultas');

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
    } else if (cmd.startsWith('/activar ')) {
      // Comando admin: /activar <numero_whatsapp> - solo Favio puede usarlo
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

  };
}

module.exports = createWebhookHandler;
