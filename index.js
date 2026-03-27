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
async function guardarMensaje(usuarioId, rol, mensaje) {
  try {
    // Sin límite práctico — columna es TEXT en Postgres (ilimitado)
  // 10000 chars cubre cualquier mensaje posible de NETO o del usuario
  const limiteChars = 10000;
  await supabase.from('conversaciones').insert({ usuario_id: usuarioId, rol: rol, mensaje: mensaje.substring(0, limiteChars) });
    // Limpiar mensajes viejos (mantener solo ultimos 10)
    const { data: viejos } = await supabase.from('conversaciones').select('id').eq('usuario_id', usuarioId).order('created_at', { ascending: false }).range(10, 100);
    if (viejos && viejos.length > 0) {
      await supabase.from('conversaciones').delete().in('id', viejos.map(v => v.id));
    }
  } catch(e) { log.error({ tag: 'HISTORIAL', err: e.message }, 'Error guardando historial'); }
}

async function obtenerHistorial(usuarioId) {
  try {
    const { data } = await supabase.from('conversaciones').select('rol, mensaje, created_at').eq('usuario_id', usuarioId).order('created_at', { ascending: false }).limit(6);
    if (!data || data.length === 0) return [];
    return data.reverse(); // cronologico
  } catch(e) { return []; }
}

async function obtenerOCrearUsuario(numeroWhatsapp) {
  // Normalizar formato: eliminar prefijo "whatsapp:" y "+" para consistencia
  const numeroNorm = numeroWhatsapp.replace(/^whatsapp:/i, '').replace(/^\+/, '');
  try {
    // Buscar tanto con el número normalizado como con el formato original (retrocompatibilidad)
    const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroNorm).single();
    if (data) return data;
  } catch (e) {}
  // Intentar con formato original por si ya existe con ese formato
  try {
    const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroWhatsapp).single();
    if (data) {
      // Migrar al formato normalizado
      await supabase.from('usuarios').update({ whatsapp: numeroNorm }).eq('whatsapp', numeroWhatsapp);
      data.whatsapp = numeroNorm;
      return data;
    }
  } catch (e) {}
  const { data: nuevo, error } = await supabase.from('usuarios').insert({ whatsapp: numeroNorm }).select().single();
  if (error) throw new Error('Error creando usuario: ' + error.message);
  return nuevo;
}
// obtenerTipoCambio movido a services/transactions.js

// ─── Freemium helpers ─────────────────────────────────────────

function getUserPlanConfig(usuario) {
  if (!FREEMIUM_ACTIVE) return PLAN_CONFIG.premium;
  const plan = usuario.plan || 'free';
  return PLAN_CONFIG[plan] || PLAN_CONFIG.free;
}

function getHistoryDateLimit(usuario) {
  const config = getUserPlanConfig(usuario);
  if (!config.historyMonths) return null;
  const limit = new Date();
  limit.setMonth(limit.getMonth() - config.historyMonths);
  return limit.toISOString().split('T')[0];
}
// ─── Fin Freemium Configuration ─────────────────────────────────────

// guardarTransaccion, obtenerGastos*, presupuestos movidos a services/transactions.js y services/budget.js
// formatearResumen movido a lib/formatters.js

// formatearEstadoPresupuesto movido a services/budget.js

async function escanearGmailYRegistrar(usuario) {
  const { error, mensajes } = await leerCorreosBancarios(usuario.id);
  if (error === 'no_auth') return null;
  if (!mensajes.length) return null;
  let registradas = 0; let ignoradas = 0; let resumen = '';
  const txsConsultar = [];
  for (const msg of mensajes) {
    try {
      const textoParseo = msg.texto || msg.snippet;
      const claveDedup = msg.id;
      const { data: existente } = await supabase.from('transacciones').select('id').eq('usuario_id', usuario.id).eq('descripcion_original', claveDedup).single();
      if (existente) { ignoradas++; continue; }
      const resultado = await parsearCorreoBancario(textoParseo, msg.asunto);
      if (!resultado.monto) continue;
      const txGuardada = await guardarTransaccion(usuario.id, { ...resultado, fecha: msg.fecha || resultado.fecha, descripcion_original: claveDedup });
      if (txGuardada && necesitaConsulta(txGuardada)) txsConsultar.push(txGuardada);
      registradas++;
      resumen += '- ' + (resultado.tipo === 'ingreso' ? 'Ingreso' : 'Gasto') + ': ' + (resultado.comercio || resultado.banco || 'Sin nombre') + ' S/ ' + resultado.monto + '\n';
      // Alerta inmediata por transaccion nueva
      setTimeout(async function() {
        try { await enviarAlertaTransaccion(usuario, txGuardada, resultado); } catch(e) { log.error({ tag: 'ALERTA', err: e.message }, 'Error alerta transacción'); }
        // Verificar si el usuario referido ahora está activo (>=3 txs)
        try {
          const { data: miRef } = await supabase.from('referidos').select('referrer_id').eq('referido_id', usuario.id).single();
          if (miRef) verificarProReferidos(miRef.referrer_id);
        } catch(e) {}
      }, 5000);
    } catch (e) { log.error({ tag: 'CORREO', err: e.message }, 'Error procesando correo'); registrarError('CORREO', e.message, { stack: e.stack, usuarioId: usuario.id }); }
  }
  if (registradas === 0) { if (ignoradas > 0) return '*Sin correos nuevos*\n\n' + ignoradas + ' correo(s) ya estaban registrados.'; return null; }
  if (txsConsultar.length > 0) {
    setTimeout(async function() {
      for (var ii=0; ii<txsConsultar.length; ii++) {
        try { await guardarConsultaPendiente(usuario, txsConsultar[ii]); await enviarWhatsapp(usuario.whatsapp, mensajeConsulta(txsConsultar[ii])); await new Promise(function(r){setTimeout(r,2000);}); }
        catch(e) { log.error({ tag: 'CONSULTA', err: e.message }, 'Error consulta pendiente'); }
      }
    }, 3000);
  }
  return '\uD83D\uDCEC Revise tu Gmail \u2014 *' + registradas + ' movimiento(s) nuevo(s)*:\n\n' + resumen + '\n\u00bfLo revisamos?';
}

async function generarYEnviarReporte(usuario, mes, anio) {
  const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
  const hasta = anio + '-' + String(mes).padStart(2,'0') + '-' + String(ultimoDiaMes(anio, mes)).padStart(2,'0');
  const { data: txs } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
  if (!txs || txs.length === 0) return { ok: false, msg: 'No hay transacciones registradas para ese mes.' };
  const { data: presupData } = await supabase.from('presupuestos').select('*').eq('usuario_id', usuario.id).eq('mes', mes).eq('anio', anio);
  const presupuestos = {};
  if (presupData) presupData.forEach(p => { presupuestos[p.categoria] = parseFloat(p.monto_limite); });
  // Obtener historial 3 meses anteriores para grafico de evolucion (gastos + ingresos)
  const historial = [];
  for (let i = 3; i >= 1; i--) {
    const d = new Date(anio, mes - 1 - i, 1); const hm = d.getMonth()+1; const ha = d.getFullYear();
    const { data: ht } = await supabase.from('transacciones').select('monto,monto_pen,tipo').eq('usuario_id', usuario.id).gte('fecha', ha+'-'+String(hm).padStart(2,'0')+'-01').lte('fecha', ha+'-'+String(hm).padStart(2,'0')+'-'+String(ultimoDiaMes(ha,hm)).padStart(2,'0'));
    const gastos = (ht||[]).filter(t => t.tipo === 'gasto');
    const ingr = (ht||[]).filter(t => t.tipo === 'ingreso');
    const totG = gastos.reduce((s,t) => s+parseFloat(t.monto_pen||t.monto||0), 0);
    const totI = ingr.reduce((s,t) => s+parseFloat(t.monto_pen||t.monto||0), 0);
    if (totG > 0 || totI > 0) historial.push({ mes: hm, anio: ha, total: totG, totalIngresos: totI });
  }
  // Obtener TODOS los meses con transacciones del usuario para el selector
  const { data: allMonths } = await supabase.from('transacciones').select('fecha').eq('usuario_id', usuario.id);
  const todosMeses = [];
  if (allMonths) {
    const mSet = new Set();
    allMonths.forEach(t => { const p = (t.fecha||'').split('-'); if (p.length>=2) mSet.add(p[0]+'-'+p[1]); });
    mSet.forEach(s => { const [a,m] = s.split('-').map(Number); todosMeses.push({ mes: m, anio: a }); });
  }
  // Generar JSON para dashboard interactivo
  const jsonData = generarReporteJSON({ nombre: usuario.nombre || 'Usuario', mes, anio, transacciones: txs, presupuestos, historialMeses: historial, todosMeses });
  const reporteId = crypto.randomUUID();
  const isPremium = usuario.plan === 'premium';
  const expiresAt = new Date(Date.now() + (isPremium ? 24 : 1) * 60 * 60 * 1000).toISOString();
  // Guardar JSON stringificado en campo html de reporte_cache
  const { error: cacheErr } = await supabase.from('reporte_cache').upsert({
    id: reporteId, usuario_id: usuario.id, html: JSON.stringify(jsonData), expires_at: expiresAt
  });
  if (cacheErr) { log.error({ tag: 'REPORTE', err: cacheErr.message }, 'Error guardando cache'); }
  // Limpiar reportes expirados del mismo usuario (housekeeping silencioso)
  supabase.from('reporte_cache').delete().eq('usuario_id', usuario.id).lt('expires_at', new Date().toISOString()).then(() => {}).catch(() => {});
  return { ok: true, reporteId, txCount: txs.length };
}
// recategorizarTransaccion, recategorizarPorId movidos a services/transactions.js
// corregirTransaccionEspecifica, reglas, consultas movidos a services/transactions.js
// formatearPendientes movido a lib/formatters.js

async function intentarResolverConsulta(usuario, texto) {
  var pendientes = await obtenerConsultasPendientes(usuario.id);
  if (pendientes.length === 0) return null;
  var ctx = pendientes.map(function(c,i){ return (i+1)+'. '+(c.banco||'Pago')+' S/'+c.monto+' del '+c.fecha; }).join('; ');
  var parsed;
  try {
    var aiRes = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Eres un clasificador de gastos pendientes. Responde SOLO con JSON valido: {"resuelve":true/false,"numero":1/2/null,"categoria":"Alimentación|Transporte|Vivienda|Salud|Entretenimiento|Compras|Educación|Finanzas|Trabajo_Negocio|Otros","subcategoria":"nombre de subcategoria si el usuario la menciona, sino null","descripcion":"descripcion corta"}' }, { role: 'user', content: 'Gastos pendientes: '+ctx+'\n\nEl usuario respondio: '+texto }], temperature: 0 });
    var raw = aiRes.choices[0].message.content.trim();
    parsed = JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
  } catch(e) { return null; }
  if (!parsed.resuelve || !parsed.numero) return null;
  var consulta = pendientes[parsed.numero-1]; if (!consulta) return null;
  var detCat = await detectarCategoriaIA(texto, usuario.id);
  var catFinal = detCat.categoria || parsed.categoria;
  var subFinal = detCat.subcategoria || parsed.subcategoria || null;
  // Capitalizar subcategoría
  if (subFinal) subFinal = subFinal.charAt(0).toUpperCase() + subFinal.slice(1);
  const comercioFinal = parsed.descripcion || consulta.banco;
  await supabase.from('transacciones').update({ categoria: catFinal, subcategoria: subFinal || 'sin_categoria', comercio: comercioFinal }).eq('id', consulta.transaccion_id);
  await resolverConsulta(consulta.id);
  // Crear subcategoría en categorias_usuario si es nueva
  if (subFinal && subFinal !== 'sin_categoria') {
    crearSubcategoriaLibreUsuario(usuario.id, catFinal, subFinal);
  }
  // Guardar regla y retroaplicar a transacciones pasadas del mismo comercio
  if (comercioFinal) {
    guardarReglaComercio(usuario.id, comercioFinal, catFinal, subFinal);
    retroaplicarRegla(usuario.id, comercioFinal, catFinal, subFinal);
  }
  var resto = pendientes.length > 1 ? '\n\nAun tienes ' + (pendientes.length-1) + ' gasto(s) pendiente(s). Escribe */pendientes*.' : '';
  return 'Listo! Actualice *'+(comercioFinal||'el pago')+'* (S/ '+parseFloat(consulta.monto).toFixed(2)+') a *'+catFinal+'*'+(subFinal?' > '+subFinal:'')+'.'+resto;
}

// CATEGORIAS_SUGERIDAS movido a lib/constants.js

async function obtenerCategoriasUsuario(usuarioId) {
  const { data: cats } = await supabase.from('categorias_usuario').select('*').eq('usuario_id', usuarioId).eq('activa', true).is('padre_id', null).order('nombre');
  if (!cats || cats.length === 0) return null;
  const resultado = [];
  for (const cat of cats) {
    const { data: subs } = await supabase.from('categorias_usuario').select('*').eq('usuario_id', usuarioId).eq('padre_id', cat.id).eq('activa', true).order('nombre');
    resultado.push({ ...cat, subcategorias: subs || [] });
  }
  return resultado;
}

async function crearCategoriasDesdeIndices(usuarioId, indices) {
  const seleccionadas = indices.map(i => CATEGORIAS_SUGERIDAS[i-1]).filter(Boolean);
  for (const cat of seleccionadas) {
    const { data: catCreada } = await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: cat.nombre, emoji: cat.emoji }).select().single();
    if (!catCreada) continue;
    for (const sub of cat.subs) { await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: sub, padre_id: catCreada.id }); }
  }
}

// formatearCategoriasMsg, parsearIndicesRespuesta movidos a lib/formatters.js

async function detectarCategoriaIA(texto, usuarioId) {
  const cats = await obtenerCategoriasUsuario(usuarioId);
  let contexto;
  if (cats && cats.length > 0) {
    contexto = cats.map(c => c.nombre + (c.subcategorias.length > 0 ? ' (subs: '+c.subcategorias.map(s=>s.nombre).join(',')+')' : '')).join('; ');
  } else {
    contexto = CATEGORIAS_SUGERIDAS.map(c => c.nombre + (c.subs.length > 0 ? ' (subs: '+c.subs.join(',')+')' : '')).join('; ');
  }
  try {
    const res = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Eres un clasificador de gastos. Elige la categoria mas apropiada de la lista proporcionada. Si el usuario menciona explicitamente una subcategoria, usa ese nombre exacto aunque no este en la lista. Responde SOLO con JSON: {"categoria":"nombre exacto","subcategoria":"nombre exacto o null"}' }, { role: 'user', content: 'Categorias disponibles: '+contexto+'\n\nGasto a clasificar: '+texto }], temperature: 0 });
    const raw = res.choices[0].message.content.trim();
    return JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
  } catch(e) { return { categoria: null, subcategoria: null }; }
}
// getEmojiCategoria movido a lib/formatters.js

async function sugerirEmojiConIA(nombreCategoria) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Dame UN solo emoji que mejor represente la categoría de gastos llamada "' + nombreCategoria + '". Responde SOLO con el emoji, sin texto.' }],
      temperature: 0, max_tokens: 10
    });
    const emoji = res.choices[0].message.content.trim();
    return emoji.length <= 4 ? emoji : '📁';
  } catch(e) { return '📁'; }
}

async function crearCategoriaLibreUsuario(usuarioId, nombre) {
  try {
    const { data: existe } = await supabase.from('categorias_usuario')
      .select('id').eq('usuario_id', usuarioId).eq('nombre', nombre).is('padre_id', null).single();
    if (existe) return;
    const emoji = getEmojiCategoria(nombre) || await sugerirEmojiConIA(nombre);
    await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre, emoji, activa: true });
  } catch(e) { /* silencioso */ }
}

async function crearSubcategoriaLibreUsuario(usuarioId, categoriaNombre, subcategoriaNombre) {
  if (!categoriaNombre || !subcategoriaNombre) return;
  try {
    // Buscar la categoría padre
    const { data: padre } = await supabase.from('categorias_usuario')
      .select('id').eq('usuario_id', usuarioId).eq('nombre', categoriaNombre).is('padre_id', null).single();
    if (!padre) {
      // Crear la categoría padre primero si no existe
      await crearCategoriaLibreUsuario(usuarioId, categoriaNombre);
      const { data: padreNuevo } = await supabase.from('categorias_usuario')
        .select('id').eq('usuario_id', usuarioId).eq('nombre', categoriaNombre).is('padre_id', null).single();
      if (!padreNuevo) return;
      // Crear la subcategoría bajo el padre recién creado
      await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: subcategoriaNombre, padre_id: padreNuevo.id, activa: true });
      return;
    }
    // Verificar que no exista ya (case-insensitive)
    const { data: existe } = await supabase.from('categorias_usuario')
      .select('id').eq('usuario_id', usuarioId).eq('padre_id', padre.id).ilike('nombre', subcategoriaNombre).single();
    if (existe) return;
    await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: subcategoriaNombre, padre_id: padre.id, activa: true });
  } catch(e) { /* silencioso */ }
}

// --- Referidos --- (generarRefCode movido a lib/formatters.js)

async function registrarReferido(referrerId, referidoId) {
  try {
    const { data: existe } = await supabase.from('referidos').select('id').eq('referrer_id', referrerId).eq('referido_id', referidoId).single();
    if (existe) return;
    const { data: referrer } = await supabase.from('usuarios').select('ref_code').eq('id', referrerId).single();
    if (!referrer) return;
    await supabase.from('referidos').insert({ ref_code: referrer.ref_code, referrer_id: referrerId, referido_id: referidoId });
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message }, 'Error registrando referido'); }
}

async function verificarProReferidos(referrerId) {
  try {
    // Contar referidos activos (con >= 3 transacciones)
    const { data: refs } = await supabase.from('referidos').select('referido_id, activo').eq('referrer_id', referrerId);
    if (!refs || refs.length === 0) return;
    for (const ref of refs) {
      if (ref.activo) continue;
      const { count } = await supabase.from('transacciones').select('*', { count: 'exact', head: true }).eq('usuario_id', ref.referido_id);
      if ((count || 0) >= 3) {
        await supabase.from('referidos').update({ activo: true }).eq('referrer_id', referrerId).eq('referido_id', ref.referido_id);
      }
    }
    // Recargar tras actualizar
    const { data: refsActualizados } = await supabase.from('referidos').select('activo').eq('referrer_id', referrerId);
    const totalActivos = (refsActualizados || []).filter(r => r.activo).length;
    const mesesGanados = Math.floor(totalActivos / 3);
    if (mesesGanados >= 1) {
      const { data: referrer } = await supabase.from('usuarios').select('plan, whatsapp, premium_vence').eq('id', referrerId).single();
      if (referrer) {
        // Calcular fecha de vencimiento: desde hoy (o desde vencimiento actual si aún vigente) + meses ganados
        const ahora = new Date();
        let base = ahora;
        if (referrer.premium_vence && new Date(referrer.premium_vence) > ahora) {
          base = new Date(referrer.premium_vence);
        }
        const vence = new Date(base);
        vence.setMonth(base.getMonth() + mesesGanados);
        // Solo recalcular si el vencimiento actual difiere
        const venceStr = vence.toISOString().split('T')[0];
        const venceActual = referrer.premium_vence || '';
        if (venceStr !== venceActual) {
          await supabase.from('usuarios').update({ plan: 'premium', premium_desde: hoyPeru(), premium_vence: venceStr }).eq('id', referrerId);
          const msgMeses = mesesGanados === 1 ? '1 mes' : mesesGanados + ' meses';
          await enviarWhatsapp(referrer.whatsapp, '⭐ *¡Referidos que funcionan!*\n\n' + totalActivos + ' de tus amigos ya usan Neto activamente.\n\nTe hemos dado *' + msgMeses + ' gratis*. 🎉\n\nVence: ' + venceStr + '\n\n_Sigue invitando — cada 3 referidos activos sumas 1 mes más._');
        }
      }
    }
  } catch(e) { log.error({ tag: 'REFERIDO', err: e.message }, 'Error verificando Pro por referidos'); }
}

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
  if (META_APP_SECRET) {
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
              { type: 'text', text: 'Esta imagen es una captura de pantalla de una transacción financiera (Yape, Plin, banco peruano). Puede ser un GASTO (pago enviado) o un INGRESO (dinero recibido). Extrae los datos y devuelve SOLO JSON válido, sin texto extra:\n{"tipo":"gasto"|"ingreso","monto":numero,"moneda":"PEN","comercio":"nombre del destinatario (si gasto) o remitente (si ingreso)","categoria":"Alimentación|Transporte|Vivienda|Salud|Entretenimiento|Compras|Educación|Finanzas|Trabajo_Negocio|Otros","subcategoria":"descripcion breve","fecha":"YYYY-MM-DD","descripcion_original":"texto clave de la imagen"}\n\nREGLAS PARA DETECTAR TIPO:\n- GASTO: "¡Yapeaste!", "Pago exitoso", "Enviado a", "Realizaste un yapeo/plin", monto enviado\n- INGRESO: "¡Te yapearon!", "Recibiste", "Yapeo recibido", "Plin recibido", "Enviado por" (alguien te envió dinero)\n- Para ingresos: categoria="Finanzas", subcategoria="sin_categoria", comercio=nombre de quien envía\n\nFORMATOS DE APPS:\n- Yape: pantalla verde con "¡Yapeaste!" (gasto) o "¡Te yapearon!" (ingreso), monto grande, nombre del destinatario/remitente\n- Plin: pantalla con "¡Pago exitoso!" y monto en verde, datos de "Enviado a" (gasto) o "Recibido de" (ingreso), código de operación\n- Bancos (BCP, BBVA, Interbank, etc.): notificación de consumo/depósito\n\nSi la imagen NO muestra ningún pago o transacción, devuelve: {"tipo":"no_pago"}\nFecha de hoy si no se ve en la imagen: ' + hoy },
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
          'Ya puedes usar Neto:\n\n' +
          '📝 Registra gastos aquí: _"gasté 50 en taxi"_\n' +
          '📸 Envía una foto de Yape o Plin\n' +
          '📊 Tu dashboard: *app.neto.pe*\n\n' +
          '_Escribe */help* para ver todos los comandos._';
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
    if (!cmd.startsWith('/') && cmd !== 'hola' && cmd !== 'hi' && cmd !== 'inicio') {
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
        await supabase.from('usuarios').update({ onboarding_paso: 1 }).eq('id', usuario.id);
        respuesta = '👋 Hola' + (primerNombre ? ', ' + primerNombre : '') + '. Soy *NETO*, tu asistente financiero.\n\n' +
          '📊 *¿Qué hace Neto?*\n' +
          '• Te dice en qué gastas tu plata por WhatsApp\n' +
          '• Dashboard con gráficos, metas y reportes\n' +
          '• Funciona con BCP, BBVA, Interbank, Yape, Plin y más\n\n' +
          '🆓 *Plan Free* — S/0\n' +
          '• Registra gastos manual o por foto\n' +
          '• 3 presupuestos, 1 meta de ahorro\n' +
          '• Dashboard del mes actual\n\n' +
          '⭐ *Plan Pro* — S/10/mes\n' +
          '• Lectura automática de correos bancarios\n' +
          '• Todo ilimitado + reportes PDF\n\n' +
          'Escribe *free* para empezar gratis o *pro* para activar Pro.';
      } else if (!tieneGmail && usuario.onboarding_completado) {
        // Usuario en modo manual — saludo normal
        var gastosMesHola = await obtenerGastosMes(usuario.id);
        var totalMesHola = gastosMesHola.reduce(function(s,t){return s+parseFloat(t.monto);},0);
        respuesta = '👋 Hola' + (primerNombre ? ', ' + primerNombre : '') + '.\n\n' +
          (gastosMesHola.length > 0 ? 'Este mes llevas *S/ ' + totalMesHola.toFixed(2) + '* en ' + gastosMesHola.length + ' movimientos.' : 'Sin movimientos este mes aun.') +
          '\n\n📝 Registra gastos así:\n_"gasté 50 en taxi"_\n_"almuerzo 25 soles"_\nO envía una foto de tu Yape/Plin.\n\n📊 *Tu dashboard:* app.neto.pe\n💡 _Escribe /conectar para lectura automática de correos._';
      } else {
        var gastosMesHola = await obtenerGastosMes(usuario.id);
        var totalMesHola = gastosMesHola.reduce(function(s,t){return s+parseFloat(t.monto);},0);
        var pendHola = await obtenerConsultasPendientes(usuario.id);
        var alertaPend = pendHola.length > 0 ? '\n\n\u2757 *' + pendHola.length + ' gasto(s) sin identificar.* Escribe */pendientes*.' : '';
        var catsHola = await obtenerCategoriasUsuario(usuario.id);
        var tipCats = (!usuario.onboarding_completado && !catsHola) ? '\n\n\uD83D\uDCA1 Escribe */categorias* para personalizar tus categorias.' : '';
        var saludo = primerNombre ? 'Hola, ' + primerNombre + '!' : 'Hola!';
        respuesta = '\uD83D\uDC4B Hola' + (primerNombre ? ', ' + primerNombre : '') + '. Soy NETO.\n\n' +
          (gastosMesHola.length > 0 ? 'Este mes llevas *S/ ' + totalMesHola.toFixed(2) + '* en ' + gastosMesHola.length + ' movimientos.' : 'Sin movimientos este mes aun.') +
          (pendHola.length > 0 ? '\n\n\u2757 ' + pendHola.length + ' gasto(s) sin identificar. Escribe */pendientes*.' : '') +
          '\n\n📊 Revisa tu dashboard en *app.neto.pe*\n\n\u00bfQue revisamos?';
      }
    } else if (cmd === '/manual') {
      // Onboarding sin Gmail — modo free
      await supabase.from('usuarios').update({ plan: 'free', onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
      respuesta = '✍️ *Modo Free activado*\n\nRegistra gastos así:\n📝 _"gasté 50 en taxi"_\n📸 Envía una foto de Yape o Plin\n\n📊 *Tu dashboard:* app.neto.pe\n\n¿Por dónde empezamos?';
    } else if (esUsuarioNuevo && !cmd.startsWith('/')) {
      respuesta = '👋 Hola. Soy *NETO*, tu asistente financiero.\n\nEscribe *hola* para empezar.';
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
          '🔗 https://app.neto.pe/dashboard/reporte\n\n' +
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
            'Tu pago fue confirmado. Ya tienes acceso a:\n\n' +
            '\u2705 Reportes PDF ilimitados\n' +
            '\u2705 Resumen semanal automatico\n' +
            '\u2705 Categorias personalizadas\n' +
            '\u2705 Sin restricciones\n\n' +
            '_Gracias por confiar en NETO._ \uD83D\uDC9A\n\n' +
            'Escribe */mes* para ver tu resumen o */reporte* para tu primer PDF ilimitado.'
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
    } else if (cmd === '/pendientes') {
      var lpend = await obtenerConsultasPendientes(usuario.id);
      respuesta = lpend.length === 0 ? 'No tienes gastos pendientes.' : formatearPendientes(lpend);
    } else if (cmd === '/ayuda') {
      const mesActual = new Date().getMonth() + 1;
      respuesta = '*Comandos NETO:*\n*/semana* -- gastos 7 dias\n*/mes* -- gastos del mes\n*/presupuesto* -- ver/configurar presupuesto\n*/categorias* -- categorias\n*/conectar* -- vincular Gmail\n*/escanear* -- leer correos ahora\n*/cambiar [comercio] [cat]* -- corregir categoria\n*/reporte* -- PDF del mes\n*/reporte ' + mesActual + '* -- PDF mes especifico\n*/pendientes* -- gastos sin identificar\n*/dashboard* -- ir a tu app (app.neto.pe)\n*/referir* -- invitar amigos y ganar Pro\n*/premium* -- plan premium\n*hola* -- estado general\n\n_Tambien puedes escribirme en lenguaje natural!_';
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
      } catch(e) {}
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
            '📊 *Tu dashboard:* app.neto.pe\n' +
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
  if (!ADMIN_KEY || !clave || clave !== ADMIN_KEY) return res.status(401).json({ error: 'No autorizado' });
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
async function redactarConNETO(netoPrompt, contexto, mensajeOriginal, historial) {
  try {
    // Construir mensajes con historial de conversacion
    const mensajes = [{ role: 'system', content: netoPrompt }];
    // Agregar historial previo para contexto
    if (historial && historial.length > 0) {
      historial.forEach(h => {
        mensajes.push({ role: h.rol === 'neto' ? 'assistant' : 'user', content: h.mensaje });
      });
    }
    // Mensaje actual con datos
    mensajes.push({ role: 'user', content: 'Mensaje del usuario: "' + mensajeOriginal + '"\n\nDatos disponibles:\n' + contexto + '\n\nRedacta la respuesta de NETO. Maximo 6 lineas. Sé directo y breve. NO hagas preguntas al final. Sin markdown pesado.' });
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      temperature: 0.7,
      messages: mensajes
    });
    return res.choices[0].message.content.trim();
  } catch(e) {
    log.error({ tag: 'NETO_GPT', err: e.message }, 'Error redactando con GPT');
    return null;
  }
}

async function procesarMensajeLibre(msg, usuario, from) {
  try {
    const hoy = new Date();
    const mesActual = hoy.getMonth() + 1;
    const anioActual = hoy.getFullYear();
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
        content: 'Eres el clasificador de intenciones de NETO, bot de finanzas personales por WhatsApp para usuarios peruanos.\nEl mes actual es ' + mE[mesActual] + ' ' + anioActual + '.\n\nAnaliza el mensaje y devuelve SOLO JSON.\n\nINTENCIONES:\n1. "listar_gastos_mes" - ver resumen/lista de gastos del mes\n   Ej: "cuales son mis gastos", "que gaste este mes", "gastos registrados", "que tengo registrado", "mis compras", "transacciones"\n   Datos: mes (numero, default=mes_actual), anio\n\n2. "listar_gastos_semana" - gastos de los ultimos 7 dias\n   Ej: "que gaste esta semana", "gastos recientes", "mis compras de los ultimos dias"\n\n2b. "listar_gastos_dia" - gastos de HOY o de un dia especifico\n   Ej: "que gaste hoy", "gastos de hoy", "resumen de hoy", "resumen del dia", "que compre hoy", "movimientos de hoy", "gastos de ayer", "que gaste ayer"\n   Datos: fecha (null si dice "hoy" o "del dia" — el sistema calcula la fecha real. Solo poner fecha YYYY-MM-DD si el usuario menciona una fecha especifica como "el 15 de marzo").\n\n3. "listar_gastos_categoria" - gastos de UNA categoria especifica\n   Ej: "que hay en Otros", "gastos de Alimentación", "que esta en Transporte", "detalle de Hogar", "cuales estan en otros"\n   Datos: categoria (nombre exacto), mes (default=mes_actual)\n\n4. "ver_total_gastado" - saber el TOTAL numerico gastado\n   Ej: "cuanto gaste", "cuanto llevo gastado", "total de gastos"\n   Datos: periodo ("semana" o "mes"), categoria (o null)\n\n5. "ver_presupuesto" - ver estado del presupuesto\n   Ej: "como va mi presupuesto", "cuanto me queda", "mis limites"\n\n6. "configurar_presupuesto" - configurar limite de gasto\n   Ej: "pon limite de 500 en comida", "presupuesto de 300 para transporte"\n   Datos: categoria, monto\n\n7. "ver_categorias" - ver categorias configuradas del sistema\n   Ej: "que categorias hay", "muestra las categorias del sistema"\n   IMPORTANTE: Si el historial muestra que NETO estaba hablando de gastos por categoria, NO usar esta intencion\n\n8. "ver_reporte" - reporte PDF\n   Ej: "dame mi reporte", "informe mensual", "reporte de marzo", "genera pdf"\n   Datos: mes (default=mes_actual), anio\n\n9. "corregir_categoria" - cambiar categoria de un gasto\n   Ej: "netflix es streaming", "cambia uber a transporte", "ponlo en Hogar", "muevelo a Delivery", "este gasto es de Comida", "ponlo en la categoria NETO", "categorizalo en Trabajo", "muevelo a Herramientas", "regístralo en alimentación", "es alimentación porque compré pan", "ponlo en comida", "es de transporte"\n   IMPORTANTE: Usar cuando el usuario quiere mover/cambiar/reclasificar un gasto a cualquier categoria (incluso una categoría personalizada no canónica como "NETO", "Mascota", etc). comercio puede ser null. También usar cuando el historial muestra que NETO acaba de registrar un gasto (desde imagen o notificación) y el usuario corrige la categoría.\n   Datos: comercio (null si no se menciona), categoria_nueva (el nombre de la categoria), subcategoria_nueva (null si no se menciona, o el nombre exacto de la subcategoria)\n\n10. "ver_pendientes" - gastos sin identificar\n    Ej: "gastos pendientes", "que no identificaste", "gastos sin categoria"\n\n11. "escanear_gmail" - escanear correos\n    Ej: "escanea mi correo", "busca transacciones nuevas", "hay correos nuevos"\n\n12. "ver_premium" - info del plan premium\n    Ej: "cuanto cuesta premium", "que incluye el plan"\n\n13. "saludo" - saludo sin intencion especifica\n    Ej: "buenos dias", "que tal", "como estas"\n\n14. "ayuda" - pide ayuda\n    Ej: "que puedes hacer", "ayuda", "como funciona"\n\n15. "registrar_manual" - el usuario quiere registrar un gasto o ingreso NUEVO\n   Ej: "gaste 50 soles en farmacia", "anota S/120 en ropa", "mi sueldo fue S/4500", "cobré S/800 de honorarios", "registra un ingreso de S/3500", "pague 200 en gasolina ayer"\n   IMPORTANTE: NO usar si el historial muestra que NETO acaba de notificar un gasto existente y el usuario está corrigiendo su moneda o monto (ej: "el gasto es USD 95", "son dolares", "el importe es 25 USD" → usar corregir_monto_moneda).\n   Datos: ninguno (se parsea el mensaje completo)\n\n16. "desconocido" - no encaja con ninguna intencion clara, o es continuacion de conversacion\n    Usar cuando: el mensaje es "si", "no", "dale", "ok", "mas", o cualquier respuesta corta a algo que NETO pregunto\n\n17. "corregir_monto_moneda" - el usuario indica que la moneda o monto de un gasto YA REGISTRADO está incorrecto\n   Ej: "el gasto es en dolares", "es en USD no en soles", "corrígelo son $25", "el monto es USD 25", "son 25 dolares", "el importe es en dolares", "eso es en USD", "el gasto es USD 95.07", "cambiale la moneda a dolares", "es dolar no sol"\n   IMPORTANTE: Solo cuando el historial muestra que se habla de un gasto existente ya notificado por NETO.\n   Datos: monto (numero o null), moneda ("USD" o "PEN" o null)\n\n18. "corregir_multiple" - el usuario da 2 o más instrucciones de corrección de categoría en el mismo mensaje, cada una referenciando un comercio/gasto diferente\n   Ej: "Netflix pasalo a Entretenimiento · Uber a Transporte · BCP comision a Finanzas", "E S NEUQUEN pasalo a gasolina\\nEdita Pal menu\\nEdita Pal (18/03) pasalo a menu"\n   IMPORTANTE: Usar cuando hay CLARAMENTE múltiples correcciones distintas en el mensaje (2+). Si solo hay una, usar corregir_categoria.\n   Datos: ninguno (se parsea el mensaje completo)\n\n19. "agregar_gmail" - el usuario quiere conectar una cuenta Gmail adicional (ya tiene una conectada)\n   Ej: "quiero agregar otro correo", "conectar una segunda cuenta de gmail", "agregar otro gmail", "tengo otro correo que quiero añadir"\n   Datos: ninguno\n\n20. "cambiar_gmail" - el usuario quiere reemplazar/cambiar su cuenta Gmail actual\n   Ej: "quiero cambiar mi cuenta", "me equivoqué de correo", "cambiar el gmail", "reconectar mi correo", "el correo que puse está mal", "quiero usar otro gmail"\n   Datos: ninguno\n\n21. "preferencia_reporte_gmail" - el usuario quiere configurar si sus reportes son unificados o separados por cuenta Gmail\n   Ej: "quiero los reportes separados por cuenta", "unifica mis correos en un solo reporte", "muéstrame por separado cada gmail"\n   Datos: modo ("unificado" o "separado")\n\n22. "cargar_excel" - el usuario quiere cargar gastos historicos desde un archivo Excel o quiere la plantilla\n   Ej: "quiero cargar mis gastos", "como subo mi historial", "tengo un Excel con mis gastos", "plantilla de gastos", "cargar gastos antiguos", "importar gastos"\n   Datos: ninguno\n\n23. "desconectar_cuenta" - el usuario quiere desconectar su cuenta, eliminar sus datos o darse de baja\n   Ej: "quiero desconectar mi cuenta", "eliminar mi cuenta", "borrar mis datos", "quiero darme de baja", "desconectar gmail", "eliminar todo", "ya no quiero usar Neto", "quiero salir", "desactivar mi cuenta"\n   Datos: ninguno\n\n24. "ver_referidos" - el usuario quiere referir amigos, ver su link de referido, o preguntar por el programa de referidos\n   Ej: "quiero referir a alguien", "mi link de referido", "como invito amigos", "programa de referidos", "quiero invitar a un amigo", "como refiero", "compartir neto", "recomendar neto", "mis referidos", "ganar pro gratis", "referir amigos", "como gano meses gratis"\n   Datos: ninguno\n\n25. "ver_recomendaciones" - el usuario quiere consejos financieros, saber como mejorar, donde se excede, como subir su score, o recomendaciones\n   Ej: "como mejoro mis finanzas", "donde me estoy excediendo", "como subo mi score", "dame recomendaciones", "en que puedo mejorar", "que dias gasto mas", "donde puedo ahorrar", "analiza mis gastos", "que ajusto", "tips para ahorrar", "como estoy financieramente", "que puedo mejorar"\n   Datos: tipo ("score" si pregunta por score, "excesos" si pregunta donde se excede, "general" si pide recomendaciones generales, "patrones" si pregunta por dias/patrones)\n\nREGLAS CRITICAS:\n- Si el historial muestra que NETO hizo una pregunta y el usuario responde con "si", "no", "dale", "ok", "mas detalle", "eso", "las dos", o cualquier respuesta corta -> usar "desconocido" para que NETO maneje la continuacion\n- Si NETO acaba de notificar "Nuevo gasto" y el usuario dice algo como "el gasto es USD X" o "son dolares" -> usar "corregir_monto_moneda", NO "registrar_manual"\n- Si NETO acaba de registrar un gasto desde una imagen (historial muestra "Registré desde la imagen" o "📸") y el usuario dice la categoría o cómo corregirlo -> usar "corregir_categoria", NO "registrar_manual". Ej: "regístralo en alimentación", "ponlo en comida", "es alimentación porque compré pan", "cambialo a transporte"\n- Si el historial muestra que NETO hablaba de gastos por categoria y el usuario dice "otras categorias" o similar -> usar "desconocido" no "ver_categorias"\n- "otros" como categoria de gasto -> listar_gastos_categoria con categoria="Otros"\n- "cuanto gaste" sin periodo -> ver_total_gastado con periodo="mes"\n- "gastos registrados"/"que tengo" -> listar_gastos_mes\n- mes: enero=1, febrero=2, marzo=3, ..., diciembre=12\n- Si no especifica mes -> usar mes_actual' + histCtx
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
    // "quiero ir a mi dashboard/app" → enviar link directo a app.neto.pe
    if (/\b(dashboard|mi app|la app|al app|mi panel|ver mis gr[aá]ficos|abrir app|entrar a la app|ir a mi app|ir al app|ir a la app|ir al dashboard|ver mi dashboard|abrir mi app|abrir la app|quiero ir al app|quiero ver mi app)\b/i.test(msg)) {
      intencion = 'ver_dashboard';
    }
    log.info({ tag: 'NLP', intencion, datos }, 'Intención clasificada');

    switch (intencion) {

      case 'ver_dashboard':
        return '📊 *Tu dashboard está en:*\n\n🔗 https://app.neto.pe\n\nAhí puedes ver gráficos, metas, reportes PDF, suscripciones y más.\n\n_Inicia sesión con tu cuenta de Google._';

      case 'listar_gastos_mes': {
        const fechaMinLgm = null; // All users are premium
        // Si tiene 2+ cuentas Gmail y modo separado, mostrar por cuenta
        const cuentasGm = await obtenerCuentasGmail(usuario.id);
        if (cuentasGm.length >= 2 && usuario.reporte_gmail_modo === 'separado') {
          const mes2 = datos.mes || mesActual; const anio2 = datos.anio || anioActual;
          const desde2 = anio2+'-'+String(mes2).padStart(2,'0')+'-01';
          if (fechaMinLgm && desde2 < fechaMinLgm) return '🔒 Tu plan gratuito solo muestra los últimos 3 meses de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
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
          if (fechaMinLgm && desde < fechaMinLgm) return '🔒 Tu plan gratuito solo muestra los últimos 3 meses de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
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
        const fechaMinLgc = null; // All users are premium
        const cat = datos.categoria;
        if (!cat) return 'Dime la categoria. Ej: _"gastos de Alimentación"_, _"que hay en Transporte"_';
        const mes = datos.mes || mesActual;
        const anio = datos.anio || anioActual;
        const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
        if (fechaMinLgc && desde < fechaMinLgc) return '🔒 Tu plan gratuito solo muestra los últimos 3 meses de historial.\n\nEscribe */premium* para desbloquear todo tu historial.';
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
        const fechaMinVt = null; // All users are premium
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
          '🔗 https://app.neto.pe/dashboard/reporte\n\n' +
          '_Inicia sesión con Google para ver tus datos._';
      }

      case 'corregir_categoria': {
        try {
          const catRaw = datos.categoria_nueva || datos.categoria || null;
          const subRaw = datos.subcategoria_nueva || datos.subcategoria || null;
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
            return 'Listo! Movi *' + (txActualizada.comercio || 'el gasto') + '* (' + montoMostrar + ') a *' + catLibre + (subLibre ? ' > ' + subLibre : '') + '*.\n\n_Aplique el cambio a todos los pagos anteriores de ' + (comercioParaRegla || 'ese comercio') + '._';
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
            const res = await corregirTransaccionEspecifica(usuario.id, corr.comercio, corr.monto, corr.fecha, catLibre);
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

      case 'escanear_gmail':
        return (await escanearGmailYRegistrar(usuario)) || 'No encontre correos bancarios nuevos. Te aviso automaticamente cuando llegue uno.';

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
        const tipoPlanVp = usuario.tipo_plan || 'mensual';
        const venceVp = usuario.fecha_vencimiento ? new Date(usuario.fecha_vencimiento).toLocaleDateString('es-PE') : null;
        return '\u2B50 *Tu plan NETO Pro*\n\nPlan: *' + (tipoPlanVp === 'anual' ? 'Anual' : 'Mensual') + '*' + (venceVp ? '\nVence: ' + venceVp : '') + '\n\n\u2705 Reportes PDF ilimitados\n\u2705 Lectura automática de correos\n\u2705 Dashboard completo\n\u2705 Consejos IA';
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
            const alerta = await verificarAlertaPresupuesto(usuario.id, parsed.categoria, null);
            if (alerta) respReg += '\n\n' + alerta;
          }
          // Cada 5 registros, recordar la app
          const { count: txCount } = await supabase.from('transacciones')
            .select('*', { count: 'exact', head: true })
            .eq('usuario_id', usuario.id);
          if (txCount && txCount % 5 === 0) {
            respReg += '\n\n💡 _Revisa tus gráficos en app.neto.pe_';
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
        const { data: ingresosSaludo } = await supabase.from('transacciones').select('monto_pen,monto').eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]);
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
          } catch(e) {}
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

// enviarWhatsapp movido a lib/whatsapp.js

async function enviarAlertaTransaccion(usuario, tx, resultado) {
  if (!tx || !resultado || !resultado.monto) return;
  const monto = parseFloat(resultado.monto);
  const comercio = resultado.comercio || resultado.banco || 'Sin nombre';
  const categoria = resultado.categoria || 'Otros';
  const tipo = resultado.tipo || 'gasto';
  const emoji = tipo === 'ingreso' ? '\uD83D\uDCB5' : '\uD83D\uDCB8';
  const tipoStr = tipo === 'ingreso' ? 'Ingreso recibido' : 'Nuevo gasto';

  // Mensaje base de notificacion inmediata
  // Formatear monto con moneda correcta
  const monedaTx = resultado.moneda || 'PEN';
  let montoStr;
  if (monedaTx === 'USD') {
    const montoPen = tx.monto_pen ? parseFloat(tx.monto_pen) : null;
    montoStr = '*$' + monto.toFixed(2) + '*' + (montoPen ? ' (~S/' + montoPen.toFixed(2) + ')' : '');
  } else {
    montoStr = '*S/' + monto.toFixed(2) + '*';
  }

  let msg = emoji + ' *' + tipoStr + '*\n';
  msg += '\uD83C\uDFEA ' + comercio + '\n';
  msg += '\uD83D\uDCB0 ' + montoStr + '\n';
  msg += '\uD83C\uDFF7\uFE0F ' + categoria + (resultado.subcategoria && resultado.subcategoria !== 'sin_categoria' ? ' > ' + resultado.subcategoria : '') + '\n';
  msg += '\uD83D\uDCC5 ' + (resultado.fecha || hoyPeru());
  // Verificar alerta de presupuesto
  if (tipo === 'gasto') {
    const alertaPres = await verificarAlertaPresupuesto(usuario.id, categoria, null);
    if (alertaPres) msg += '\n\n' + alertaPres;
  }

  // Detectar gasto inusual (opcion 3)
  if (tipo === 'gasto') {
    try {
      // Obtener promedio historico de esa categoria (ultimas 4 semanas)
      const hace28 = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const { data: historial } = await supabase.from('transacciones')
        .select('monto')
        .eq('usuario_id', usuario.id)
        .eq('tipo', 'gasto')
        .ilike('categoria', '%' + categoria + '%')
        .gte('fecha', hace28)
        .neq('id', tx.id);
      if (historial && historial.length >= 3) {
        const promedio = historial.reduce((s, t) => s + parseFloat(t.monto), 0) / historial.length;
        const factor = monto / promedio;
        if (factor >= 2.5 && monto > 30) {
          msg += '\n\n\u26A0\uFE0F *Gasto inusual:* Este gasto es ' + factor.toFixed(1) + 'x tu promedio en ' + categoria + ' (S/ ' + promedio.toFixed(2) + ')';
        }
      }
    } catch(e) { log.error({ tag: 'INUSUAL', err: e.message }, 'Error alerta inusual'); }
  }

  await enviarWhatsapp(usuario.whatsapp, msg);
}
// Obtener la última transacción registrada del usuario (para contexto de respuestas)
// obtenerUltimaTransaccion movido a services/transactions.js
async function escaneoAutomatico() {
  log.info({ tag: 'AUTO' }, 'Escaneo automático iniciado');
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resultado = await escanearGmailYRegistrar(usuario);
        if (resultado && resultado.includes('Registre')) { await enviarWhatsapp(usuario.whatsapp, '\uD83D\uDD04 *Escaneo automatico*\n\n' + resultado); }
      } catch (e) { log.error({ tag: 'AUTO', whatsapp: usuario.whatsapp, err: e.message }, 'Error escaneo usuario'); }
    }
  } catch (e) { log.error({ tag: 'AUTO', err: e.message }, 'Error general escaneo'); notificarErrorAdmin('AUTO_SCAN', e.message); registrarError('AUTO_SCAN', e.message, { stack: e.stack }); }
}

async function generarResumenSemanal(usuario) {
  const hoy = new Date();
  const gastosSemana = await obtenerGastosSemana(usuario.id);
  if (!gastosSemana.length) return null;

  const hace14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const hace7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const { data: gastosAnt } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuario.id).eq('tipo', 'gasto')
    .gte('fecha', hace14.toISOString().split('T')[0])
    .lt('fecha', hace7.toISOString().split('T')[0]);
  const gastosAnteriores = gastosAnt || [];

  const totalSemana = gastosSemana.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const totalAnterior = gastosAnteriores.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);

  const porCat = {};
  gastosSemana.forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || t.monto); });
  const top3 = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const porComercio = {};
  gastosSemana.forEach(t => { const c = t.comercio || t.banco || 'Sin nombre'; porComercio[c] = (porComercio[c] || 0) + 1; });
  const comercioTop = Object.entries(porComercio).sort((a, b) => b[1] - a[1])[0];

  const porDia = {};
  gastosSemana.forEach(t => { porDia[t.fecha] = (porDia[t.fecha] || 0) + parseFloat(t.monto); });
  const diaMasCaro = Object.entries(porDia).sort((a, b) => b[1] - a[1])[0];

  const hormiga = gastosSemana.filter(t => parseFloat(t.monto) <= 20);
  const totalHormiga = hormiga.reduce((s, t) => s + parseFloat(t.monto), 0);

  const diasMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  const diaActual = hoy.getDate();
  const { data: gastosMesData } = await supabase.from('transacciones').select('monto')
    .eq('usuario_id', usuario.id).eq('tipo', 'gasto')
    .gte('fecha', hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-01');
  const totalMes = (gastosMesData || []).reduce((s, t) => s + parseFloat(t.monto), 0);
  const proyeccionMes = diaActual > 0 ? (totalMes / diaActual) * diasMes : 0;

  const presupuestos = await obtenerPresupuestosMes(usuario.id);
  const limiteTotal = presupuestos.reduce((s, p) => s + parseFloat(p.monto_limite), 0);

  let comparativa = '';
  if (totalAnterior > 0) {
    const diff = totalSemana - totalAnterior;
    const pct = Math.abs((diff / totalAnterior) * 100).toFixed(0);
    if (diff > 0) comparativa = '\u2197\uFE0F *' + pct + '% mas* que la semana pasada (S/ ' + totalAnterior.toFixed(2) + ')';
    else if (diff < 0) comparativa = '\u2198\uFE0F *' + pct + '% menos* que la semana pasada (S/ ' + totalAnterior.toFixed(2) + ') \uD83D\uDC4F';
    else comparativa = '\u27A1\uFE0F Igual que la semana pasada';
  }

  let insight = '';
  try {
    const ctx = {
      totalSemana: totalSemana.toFixed(2),
      totalAnterior: totalAnterior > 0 ? totalAnterior.toFixed(2) : null,
      top1: top3[0] ? top3[0][0] + ' S/ ' + top3[0][1].toFixed(2) : null,
      top2: top3[1] ? top3[1][0] + ' S/ ' + top3[1][1].toFixed(2) : null,
      hormigaTotal: totalHormiga > 10 ? totalHormiga.toFixed(2) : null,
      proyeccionMes: proyeccionMes > 0 ? proyeccionMes.toFixed(2) : null,
      limiteTotal: limiteTotal > 0 ? limiteTotal.toFixed(2) : null,
      numTransacciones: gastosSemana.length
    };
    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'Eres el asistente financiero de NETO. Con los datos de gastos semanales genera UN insight accionable en 1-2 oraciones. Especifico, util, tono amigable. En espanol sin emojis al inicio.'
      }, {
        role: 'user',
        content: 'Datos: ' + JSON.stringify(ctx)
      }],
      temperature: 0.7,
      max_tokens: 100
    });
    insight = aiRes.choices[0].message.content.trim();
  } catch(e) {
    if (totalSemana > totalAnterior && totalAnterior > 0) insight = 'Esta semana gastaste mas que la anterior. Revisa tu categoria ' + (top3[0] ? top3[0][0] : 'principal') + ' para encontrar oportunidades de ahorro.';
    else if (totalHormiga > 30) insight = 'Tus gastos pequenos suman S/ ' + totalHormiga.toFixed(2) + '. Son los mas faciles de reducir.';
    else insight = 'Buen trabajo controlando tus gastos esta semana.';
  }

  const fechaDesde = hace7.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
  const fechaHasta = hoy.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
  const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
  const emojis = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];

  let msg = '\uD83D\uDCCA *Resumen semanal' + (primerNombre ? ', ' + primerNombre : '') + '*\n';
  msg += '_' + fechaDesde + ' \u2014 ' + fechaHasta + '_\n';
  msg += '---------------\n\n';
  msg += '\uD83D\uDCB0 *Total gastado:* S/ ' + totalSemana.toFixed(2) + '\n';
  if (comparativa) msg += comparativa + '\n';
  msg += '\n';
  msg += '\uD83D\uDD25 *Top categorias:*\n';
  top3.forEach(([cat, monto], i) => {
    const pct = ((monto / totalSemana) * 100).toFixed(0);
    msg += emojis[i] + ' ' + cat + ': *S/ ' + monto.toFixed(2) + '* (' + pct + '%)\n';
  });
  msg += '\n';
  if (comercioTop && comercioTop[1] >= 2) msg += '\uD83D\uDECD\uFE0F *Lugar favorito:* ' + comercioTop[0] + ' (' + comercioTop[1] + ' veces)\n';
  if (diaMasCaro) {
    const nombreDia = new Date(diaMasCaro[0] + 'T12:00:00').toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'short' });
    msg += '\uD83D\uDCC5 *Dia mas caro:* ' + nombreDia + ' (S/ ' + diaMasCaro[1].toFixed(2) + ')\n';
  }
  if (totalHormiga > 20 && hormiga.length >= 3) msg += '\uD83D\uDC1C *Gastos hormiga:* ' + hormiga.length + ' transacciones = S/ ' + totalHormiga.toFixed(2) + '\n';
  msg += '\n';
  if (proyeccionMes > 0) {
    msg += '\uD83D\uDCC8 *Proyeccion del mes:* S/ ' + proyeccionMes.toFixed(2);
    if (limiteTotal > 0) {
      const sobra = limiteTotal - proyeccionMes;
      msg += sobra > 0 ? ' \u2705 (dentro del presupuesto)' : ' \u26A0\uFE0F (superaria tu presupuesto en S/ ' + Math.abs(sobra).toFixed(2) + ')';
    }
    msg += '\n';
  }
  msg += '\n\uD83D\uDCA1 *Consejo:* ' + insight + '\n';

  // Mini-recomendación con score
  try {
    const datosRecom = await construirDatosUsuario(usuario.id);
    const miniRecom = generarMiniRecomendacion(datosRecom, usuario.nombre);
    if (miniRecom) msg += '\n' + miniRecom + '\n';
  } catch (e) { log.error({ tag: 'RECOM_SEM', err: e.message }, 'Error mini-recom semanal'); }

  msg += '\n_Escribe /mes para el detalle o /reporte para tu PDF._';
  return msg;
}

async function generarResumenMensual(usuario) {
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  // Mes anterior
  const mesAnt = ahora.getMonth() === 0 ? 12 : ahora.getMonth();
  const anioAnt = ahora.getMonth() === 0 ? ahora.getFullYear() - 1 : ahora.getFullYear();
  const desde = anioAnt + '-' + String(mesAnt).padStart(2, '0') + '-01';
  const hasta = anioAnt + '-' + String(mesAnt).padStart(2, '0') + '-' + String(ultimoDiaMes(anioAnt, mesAnt)).padStart(2, '0');

  const { data: txsMes } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desde).lte('fecha', hasta);
  if (!txsMes || txsMes.length === 0) return null;

  const { data: ingresos } = await supabase.from('transacciones').select('monto,monto_pen')
    .eq('usuario_id', usuario.id).eq('tipo', 'ingreso').gte('fecha', desde).lte('fecha', hasta);

  const totalGastos = txsMes.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const totalIngresos = (ingresos || []).reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const ahorro = totalIngresos - totalGastos;

  // Comparativa con mes anterior al anterior
  const mesAntAnt = mesAnt === 1 ? 12 : mesAnt - 1;
  const anioAntAnt = mesAnt === 1 ? anioAnt - 1 : anioAnt;
  const desdeAntAnt = anioAntAnt + '-' + String(mesAntAnt).padStart(2, '0') + '-01';
  const hastaAntAnt = anioAntAnt + '-' + String(mesAntAnt).padStart(2, '0') + '-' + String(ultimoDiaMes(anioAntAnt, mesAntAnt)).padStart(2, '0');
  const { data: txsAntAnt } = await supabase.from('transacciones').select('monto,monto_pen')
    .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', desdeAntAnt).lte('fecha', hastaAntAnt);
  const totalAntAnt = (txsAntAnt || []).reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);

  // Top categorías
  const porCat = {};
  txsMes.forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || t.monto); });
  const top5 = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const nombreMes = MESES[mesAnt];
  const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;

  let msg = '📊 *Resumen de ' + nombreMes + (primerNombre ? ', ' + primerNombre : '') + '*\n';
  msg += '===============\n\n';
  msg += '💰 *Total gastado:* S/ ' + totalGastos.toFixed(2) + '\n';
  if (totalIngresos > 0) {
    msg += '💵 *Ingresos:* S/ ' + totalIngresos.toFixed(2) + '\n';
    msg += (ahorro >= 0 ? '✅' : '⚠️') + ' *Balance:* S/ ' + ahorro.toFixed(2) + (ahorro >= 0 ? ' (ahorraste!)' : ' (gastaste más de lo que ganaste)') + '\n';
  }
  msg += '📋 *Transacciones:* ' + txsMes.length + '\n';

  // Comparativa
  if (totalAntAnt > 0) {
    const diff = totalGastos - totalAntAnt;
    const pct = Math.abs((diff / totalAntAnt) * 100).toFixed(0);
    if (diff > 0) msg += '\n↗️ *' + pct + '% más* que ' + MESES[mesAntAnt] + ' (S/ ' + totalAntAnt.toFixed(2) + ')';
    else if (diff < 0) msg += '\n↘️ *' + pct + '% menos* que ' + MESES[mesAntAnt] + ' (S/ ' + totalAntAnt.toFixed(2) + ') 👏';
  }

  msg += '\n\n🏆 *Top categorías:*\n';
  const medallas = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  top5.forEach(([cat, monto], i) => {
    const pct = ((monto / totalGastos) * 100).toFixed(0);
    msg += medallas[i] + ' ' + cat + ': *S/ ' + monto.toFixed(2) + '* (' + pct + '%)\n';
  });

  // Recomendaciones mensuales completas
  try {
    const recom = await generarRecomendaciones(usuario.id, usuario.nombre, 'mensual');
    if (recom && recom.mensaje) {
      msg += '\n\n─────────────\n' + recom.mensaje;
    }
  } catch (e) { log.error({ tag: 'RECOM_MENS', err: e.message }, 'Error recomendación mensual'); }

  msg += '\n\n_Escribe /reporte para tu dashboard detallado._';
  return msg;
}

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
    const { data: usuarios } = await supabase.from('usuarios').select('id, whatsapp, nombre, recordatorios_activos')
      .eq('onboarding_completado', true);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        // Respetar preferencia del usuario (default: activos)
        if (usuario.recordatorios_activos === false) continue;
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