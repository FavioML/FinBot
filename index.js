require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { generarReporteHTML, generarDashboardHTML, generarReporteJSON } = require('./reporte_html');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { generarUrlAutorizacion, guardarTokens, leerCorreosBancarios, oauth2Client, obtenerPerfilGoogle, obtenerCuentasGmail } = require('./gmail');

// Helper: último día real del mes (evita fechas inválidas como 02-31)
function ultimoDiaMes(anio, mes) {
  return new Date(anio, mes, 0).getDate();
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
  } catch(e) { console.error('[HISTORIAL] Error:', e.message); }
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
// Tipo de cambio USD/PEN — API dolar.pe con cache 1h y fallback
let _tcCache = null, _tcCacheTime = 0;
async function obtenerTipoCambio() {
  const FALLBACK = { compra: 3.82, venta: 3.85 };
  const now = Date.now();
  if (_tcCache && (now - _tcCacheTime) < 3600000) return _tcCache;
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const resp = await fetch('https://dolar.pe/api/public/series?from=' + hoy + '&to=' + hoy, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4000)
    });
    if (!resp.ok) return _tcCache || FALLBACK;
    const json = await resp.json();
    if (json.series) {
      for (const serie of Object.values(json.series)) {
        const vals = serie.data || [];
        const last = vals[vals.length - 1];
        if (typeof last === 'number' && last > 3.5 && last < 4.5) {
          _tcCache = { compra: parseFloat((last * 0.998).toFixed(4)), venta: last };
          _tcCacheTime = now; return _tcCache;
        }
        if (last && typeof last === 'object' && parseFloat(last.venta) > 3.5) {
          _tcCache = { compra: parseFloat(last.compra), venta: parseFloat(last.venta) };
          _tcCacheTime = now; return _tcCache;
        }
      }
    }
    return _tcCache || FALLBACK;
  } catch(e) {
    console.error('[TC]', e.message);
    return _tcCache || FALLBACK;
  }
}

// Árbol canónico de categorías — única fuente de verdad
// 10 categorías: Alimentación, Transporte, Vivienda, Salud, Entretenimiento,
//                Compras, Educación, Finanzas, Trabajo_Negocio, Otros
const CATEGORIAS_VALIDAS = new Set([
  'Alimentación', 'Transporte', 'Vivienda', 'Salud', 'Entretenimiento',
  'Compras', 'Educación', 'Finanzas', 'Trabajo_Negocio', 'Otros'
]);

// Mapeo de variantes → canónico (retrocompatibilidad + correcciones automáticas)
const CATEGORIA_MAP = {
  // Árbol anterior → canónico
  'Comida': 'Alimentación', 'comida': 'Alimentación',
  'Alimentacion': 'Alimentación', 'alimentacion': 'Alimentación', 'alimentación': 'Alimentación',
  'Hogar': 'Vivienda', 'hogar': 'Vivienda', 'vivienda': 'Vivienda',
  'Auto': 'Transporte', 'auto': 'Transporte',
  'Streaming': 'Entretenimiento', 'streaming': 'Entretenimiento',
  'Viajes': 'Otros', 'viajes': 'Otros',
  'Educacion': 'Educación', 'educacion': 'Educación',
  'Transferencia': 'Otros', 'transferencia': 'Otros',
  // Capitalización incorrecta
  'transporte': 'Transporte', 'salud': 'Salud',
  'entretenimiento': 'Entretenimiento', 'compras': 'Compras',
  'finanzas': 'Finanzas', 'trabajo_negocio': 'Trabajo_Negocio',
  'otros': 'Otros',
};

function normalizarCategoria(cat) {
  if (!cat) return 'Otros';
  const mapped = CATEGORIA_MAP[cat];
  if (mapped) return mapped;
  if (CATEGORIAS_VALIDAS.has(cat)) return cat;
  const cap = cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
  if (CATEGORIAS_VALIDAS.has(cap)) return cap;
  return 'Otros';
}

// ─── Freemium Configuration ─────────────────────────────────────────
const FREEMIUM_ACTIVE = false; // Master switch: false = todos acceden a todo (fase de prueba)

const PLAN_CONFIG = {
  free: {
    historyMonths: 3,            // Solo últimos 3 meses visibles en queries
    reportesPerMonth: 1,         // 1 reporte por mes
    excelUpload: false,          // Sin carga de gastos históricos
    dashboardTTL: 1,             // 1 hora de expiración
    weeklyResumen: false,        // Sin resumen semanal automático
    scoreFinanciero: false,      // Sin score de salud financiera
    resumenesConfig: false,      // Sin resúmenes configurables
  },
  premium: {
    historyMonths: null,         // Ilimitado
    reportesPerMonth: Infinity,  // Ilimitado
    excelUpload: true,           // Carga de gastos históricos
    dashboardTTL: 24,            // 24 horas de expiración
    weeklyResumen: true,         // Resumen semanal automático
    scoreFinanciero: true,       // Score de salud financiera
    resumenesConfig: true,       // Resúmenes configurables
  }
};

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

async function guardarTransaccion(usuarioId, datos) {
  const _moneda = datos.moneda || 'PEN';
  let _montoPen = parseFloat(datos.monto); let _tcUsado = null;
  if (_moneda === 'USD') { try { const _tc = await obtenerTipoCambio(); _tcUsado = _tc.venta; _montoPen = parseFloat((parseFloat(datos.monto) * _tc.venta).toFixed(2)); } catch(e) {} }
  // Aplicar regla aprendida si existe
  let catFinal = normalizarCategoria(datos.categoria);
  let subFinal = datos.subcategoria || 'sin_categoria';
  if (datos.comercio) {
    const regla = await buscarReglaComercio(usuarioId, datos.comercio);
    if (regla) { catFinal = regla.categoria; if (regla.subcategoria) subFinal = regla.subcategoria; }
  }
  const { data, error } = await supabase.from('transacciones').insert({
    usuario_id: usuarioId, tipo: datos.tipo || 'gasto', monto: parseFloat(datos.monto), moneda: _moneda,
    monto_pen: _montoPen, tipo_cambio: _tcUsado, metodo_pago: datos.metodo_pago || null,
    comercio: datos.comercio, categoria: catFinal,
    subcategoria: subFinal, banco: datos.banco,
    fecha: datos.fecha || new Date().toISOString().split('T')[0],
    descripcion_original: datos.descripcion_original, confirmado: false
  }).select().single();
  if (error) throw error;
  return data;
}

async function obtenerGastosMes(usuarioId, fechaMinima) {
  const hoy = new Date();
  const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];
  const desde = fechaMinima && fechaMinima > primero ? fechaMinima : primero;
  const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto').gte('fecha', desde).order('fecha', { ascending: false });
  return data || [];
}

async function obtenerGastosSemana(usuarioId, fechaMinima) {
  const hace7 = new Date();
  hace7.setDate(hace7.getDate() - 7);
  const desdeStr = hace7.toISOString().split('T')[0];
  const desde = fechaMinima && fechaMinima > desdeStr ? fechaMinima : desdeStr;
  const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto').gte('fecha', desde).order('fecha', { ascending: false });
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

async function verificarAlertaPresupuesto(usuarioId, categoria, subcategoria) {
  const hoy = new Date();
  const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];
  const alertas = [];
  const { data: presCat } = await supabase.from('presupuestos').select('*')
    .eq('usuario_id', usuarioId).eq('categoria', categoria)
    .is('subcategoria', null).eq('mes', hoy.getMonth()+1).eq('anio', hoy.getFullYear()).single();
  if (presCat) {
    const { data: txsCat } = await supabase.from('transacciones').select('monto')
      .eq('usuario_id', usuarioId).eq('categoria', categoria).eq('tipo', 'gasto').gte('fecha', primero);
    const totalCat = (txsCat||[]).reduce((s,t)=>s+parseFloat(t.monto),0);
    const limiteCat = parseFloat(presCat.monto_limite);
    const pctCat = (totalCat/limiteCat)*100;
    if (pctCat>=100) alertas.push('\uD83D\uDEA8 Limite de *'+categoria+'* superado: S/ '+totalCat.toFixed(2)+' / S/ '+limiteCat.toFixed(2));
    else if (pctCat>=(presCat.alerta_porcentaje||80)) alertas.push('\u26A0\uFE0F *'+categoria+'*: llevas S/ '+totalCat.toFixed(2)+' de S/ '+limiteCat.toFixed(2)+' ('+pctCat.toFixed(0)+'%)');
  }
  if (subcategoria) {
    const { data: presSub } = await supabase.from('presupuestos').select('*')
      .eq('usuario_id', usuarioId).eq('categoria', categoria).eq('subcategoria', subcategoria)
      .eq('mes', hoy.getMonth()+1).eq('anio', hoy.getFullYear()).single();
    if (presSub) {
      const { data: txsSub } = await supabase.from('transacciones').select('monto')
        .eq('usuario_id', usuarioId).eq('categoria', categoria).eq('subcategoria', subcategoria).eq('tipo', 'gasto').gte('fecha', primero);
      const totalSub = (txsSub||[]).reduce((s,t)=>s+parseFloat(t.monto),0);
      const limiteSub = parseFloat(presSub.monto_limite);
      const pctSub = (totalSub/limiteSub)*100;
      if (pctSub>=100) alertas.push('\uD83D\uDEA8 Limite de *'+subcategoria+'* superado: S/ '+totalSub.toFixed(2)+' / S/ '+limiteSub.toFixed(2));
      else if (pctSub>=(presSub.alerta_porcentaje||80)) alertas.push('\u26A0\uFE0F *'+subcategoria+'*: llevas S/ '+totalSub.toFixed(2)+' de S/ '+limiteSub.toFixed(2)+' ('+pctSub.toFixed(0)+'%)');
    }
  }
  return alertas.length > 0 ? alertas.join('\n') : null;
}

async function parsearCorreoBancario(texto, contexto) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Eres un parser experto de notificaciones bancarias peruanas. Devuelve SOLO JSON sin markdown:
{ "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"nombre limpio del comercio", "categoria":"ver lista", "subcategoria":"ver lista", "banco":"BCP|Interbank|BBVA|Scotiabank|Yape|Plin|Otro", "metodo_pago":"Debito|Credito|Yape|Plin|Efectivo|Otro", "fecha":"YYYY-MM-DD", "descripcion_original":"texto original" }

CATEGORÍAS Y SUBCATEGORÍAS OBLIGATORIAS (usa EXACTAMENTE estos valores, sin variantes):

Alimentación:    delivery | restaurante | supermercado | mercado | cafeteria | snacks
Transporte:      uber_cabify | taxi | bus_micro | metro_bus | gasolina | peaje | estacionamiento
Vivienda:        alquiler | mantenimiento | electricidad | agua | gas | internet | cable
Salud:           farmacia | medico | clinica | laboratorio | seguro_salud | optica
Entretenimiento: streaming | suscripciones | cine | juegos | bares_clubs | eventos | hobbies
Compras:         ropa | calzado | electronico | hogar | belleza | mascotas
Educación:       universidad | instituto | curso_online | utiles | idiomas | colegios
Finanzas:        prestamo | tarjeta_credito | seguro | ahorro | inversion | comision_banco
Trabajo_Negocio: herramientas | publicidad | oficina | logistica | contador
Otros:           regalo | donacion | multa | viaje | sin_categoria

REGLAS DE NORMALIZACIÓN DE COMERCIOS:
- Rappi / PedidosYa / Glovo / DLC*PedidosYa → comercio limpio, categoria: Alimentación, subcategoria: delivery
- McDonald's / KFC / Bembos / Pizza Hut / restaurantes / huariques → Alimentación > restaurante
- SPSA / SPSA TOTTUS / Wong / Metro / Plaza Vea / Tottus / supermercados → Alimentación > supermercado
- Starbucks / Juan Valdez / café → Alimentación > cafeteria
- Uber / Cabify / InDriver / Beat → Transporte > uber_cabify
- Repsol / Primax / Pecsa / Petroperu / Grifo / gasolineras → Transporte > gasolina
- Peajes / Telepeaje / RUTAS → Transporte > peaje
- Estacionamiento / playa de estacionamiento → Transporte > estacionamiento
- Metropolitano / bus / combi / micro → Transporte > metro_bus
- Luz del Sur / Enel / Electrodunas / Hidrandina → Vivienda > electricidad
- SEDAPAL / EPS → Vivienda > agua
- Claro / Entel / Movistar hogar / Bitel / internet → Vivienda > internet
- TV cable / cableoperadora → Vivienda > cable
- Gas LP / GLP / Zeta Gas → Vivienda > gas
- DLOCAL*NETFLIX / Netflix / Disney+ / HBO / Spotify / YouTube Premium / Apple Music / Apple TV → Entretenimiento > suscripciones
- Apple.com/bill / Apple iCloud / Google One / Google Drive / Google Storage → Entretenimiento > suscripciones
- Claude / ChatGPT / OpenAI / suscripciones de software / apps recurrentes → Entretenimiento > suscripciones
- Cineplanet / Cinemark / UVK → Entretenimiento > cine
- Google Play / App Store / Steam / Xbox / PlayStation → Entretenimiento > juegos
- Bares / discotecas / pubs → Entretenimiento > bares_clubs
- Saga / Ripley / H&M / Zara / Forever 21 → Compras > ropa
- Bata / Marathon / Adidas / Nike → Compras > calzado
- Hiraoka / Falabella / Mercado Libre / Amazon / electrónica → Compras > electronico
- Promart / Sodimac / Maestro → Compras > hogar
- Natura / Unique / Perfumerías / salón / spa / barbería → Compras > belleza
- Veterinaria / mascotas / Petco → Compras > mascotas
- Inkafarma / MiFarma / Boticas / Farmacéxito → Salud > farmacia
- Clínicas / hospitales / emergencias → Salud > clinica
- Laboratorio / análisis → Salud > laboratorio
- Coursera / Udemy / Platzi / Duolingo → Educación > curso_online
- ICPNA / Británico / Berlitz / idiomas → Educación > idiomas
- Universidad / instituto / SENATI / ISEP → Educación > universidad
- Colegio / pensión escolar → Educación > colegios
- Cuota préstamo BCP/BBVA/Interbank → Finanzas > prestamo
- Pago tarjeta crédito / TC → Finanzas > tarjeta_credito
- SOAT / seguro vehicular / seguro de vida → Finanzas > seguro
- Comisión banco / ITF / porte → Finanzas > comision_banco
- Software / SaaS / herramientas trabajo → Trabajo_Negocio > herramientas
- Meta Ads / Google Ads / publicidad → Trabajo_Negocio > publicidad

REGLAS POR BANCO:
- BCP débito/crédito: buscar campo "Empresa" o descripción del consumo
- BBVA: buscar campo "Comercio" o descripción de consumo
- Interbank: buscar campo "Empresa" para pagos de servicio
- Scotiabank: buscar campo "Empresa o institución" para el comercio real
- YAPE: extraer monto después de "S/", comercio del campo "Nombre del Beneficiario",
  fecha del campo "Fecha y Hora de la operación", banco: Yape, tipo: gasto,
  categoria: Otros, subcategoria: sin_categoria (a menos que sea comercio conocido)
- Plin: similar a Yape

REGLA CRÍTICA DE MONEDA (aplicar SIEMPRE antes de asignar moneda):
- Si el correo contiene "$", "USD", "US$" → moneda: "USD" sin excepción
- Si el correo dice "S/", "PEN", "soles" → moneda: "PEN"
- Comercios internacionales que SIEMPRE son USD: Netflix, NETFLIX.COM, DLOCAL*NETFLIX, Spotify, Disney+, Amazon Prime, YouTube Premium, Apple, Steam, Xbox, PlayStation, Google One, iCloud, ChatGPT, OpenAI, Claude, Claude.AI, Anthropic, Canva, Dropbox, Adobe, Microsoft 365, GitHub, Notion, Figma, Slack, Zoom, Shopify
- Si ves "$ 8.73" o "$8.73" en el correo → monto: 8.73, moneda: "USD"
- Tarjeta de crédito BCP/BBVA/Interbank con símbolo "$" → moneda: "USD"
- NUNCA registres en PEN un gasto que tenga símbolo "$" en el cuerpo del correo

REGLAS GENERALES:
- fecha en formato YYYY-MM-DD (año actual 2026)
- monto siempre número sin símbolos
- tipo=ingreso solo si es depósito, sueldo, abono recibido, transferencia entrante
- tipo=gasto para consumos, pagos, transferencias enviadas
- subcategoria NUNCA puede ser null — usar sin_categoria si no sabes
- comercio: nombre limpio sin códigos (no "DLC*PEDIDOSYA" sino "PedidosYa")` },
      { role: 'user', content: 'Parsea este correo bancario' + (contexto ? ' (asunto: ' + contexto + ')' : '') + ':\n\n' + texto }
    ],
    temperature: 0
  });
  const raw = res.choices[0].message.content.trim();
  const clean = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  return JSON.parse(clean);
}

async function parsearRegistroManual(msg, fechaHoy) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Extrae datos de un registro manual de gasto o ingreso en lenguaje natural. Devuelve SOLO JSON:
{ "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"descripcion breve", "categoria":"ver lista", "subcategoria":"ver lista", "fecha":"YYYY-MM-DD", "ok":true|false }

Si no puedes extraer un monto claro, devuelve { "ok": false }.

Hoy es ${fechaHoy}. Si el usuario dice "ayer" restar 1 día. Si dice "el lunes", "la semana pasada", etc., calcular la fecha correcta.

tipo=ingreso: sueldo, salario, honorarios, abono recibido, ingreso, cobré, me pagaron, depósito recibido.
tipo=gasto: gasté, pagué, compré, anota un gasto, registra gasto.

CATEGORÍAS (usa exactamente):
Alimentación: delivery|restaurante|supermercado|mercado|cafeteria|snacks
Transporte: uber_cabify|taxi|bus_micro|metro_bus|gasolina|peaje|estacionamiento
Vivienda: alquiler|mantenimiento|electricidad|agua|gas|internet|cable
Salud: farmacia|medico|clinica|laboratorio|seguro_salud|optica
Entretenimiento: streaming|cine|juegos|bares_clubs|eventos|hobbies
Compras: ropa|calzado|electronico|hogar|belleza|mascotas
Educación: universidad|instituto|curso_online|utiles|idiomas|colegios
Finanzas: prestamo|tarjeta_credito|seguro|ahorro|inversion|comision_banco
Trabajo_Negocio: herramientas|publicidad|oficina|logistica|contador
Otros: regalo|donacion|multa|viaje|sin_categoria

Para ingresos: comercio="Sueldo" o la fuente del ingreso, categoria="Finanzas", subcategoria="sin_categoria".` },
      { role: 'user', content: msg }
    ],
    temperature: 0
  });
  const raw2 = res.choices[0].message.content.trim();
  const clean2 = raw2.startsWith('{') ? raw2 : raw2.slice(raw2.indexOf('{'), raw2.lastIndexOf('}') + 1);
  return JSON.parse(clean2);
}

function formatearResumen(txs, periodo) {
  if (!txs || !txs.length) return 'No hay gastos registrados ' + periodo + '.';
  const total = txs.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
  const porCat = {};
  txs.forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || t.monto || 0); });
  const txsUsd = txs.filter(t => t.moneda === 'USD');
  const totalUsd = txsUsd.reduce((s, t) => s + parseFloat(t.monto || 0), 0);
  const notaUsd = txsUsd.length > 0 ? ' (incl. USD ' + totalUsd.toFixed(2) + ')' : '';
  let msg = '📊 *' + periodo + '*\nTotal: *S/ ' + total.toFixed(0) + '*' + notaUsd + ' • ' + txs.length + ' movimientos\n\n';
  Object.entries(porCat).sort((a, b) => b[1] - a[1]).forEach(([cat, monto]) => {
    const em = getEmojiCategoria(cat) || '📋';
    msg += em + ' ' + cat + ': *S/ ' + monto.toFixed(0) + '* (' + ((monto / total) * 100).toFixed(0) + '%)\n';
  });
  return msg;
}

async function formatearEstadoPresupuesto(usuarioId) {
  const presupuestos = await obtenerPresupuestosMes(usuarioId);
  if (!presupuestos.length) return 'No tienes presupuestos configurados.\n\nEj: _"pon limite de 500 en Comida"_';
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
        try { await enviarAlertaTransaccion(usuario, txGuardada, resultado); } catch(e) { console.error("[ALERTA]", e.message); }
        // Verificar si el usuario referido ahora está activo (>=3 txs)
        try {
          const { data: miRef } = await supabase.from('referidos').select('referrer_id').eq('referido_id', usuario.id).single();
          if (miRef) verificarProReferidos(miRef.referrer_id);
        } catch(e) {}
      }, 5000);
    } catch (e) { console.error('Error procesando correo:', e.message); }
  }
  if (registradas === 0) { if (ignoradas > 0) return '*Sin correos nuevos*\n\n' + ignoradas + ' correo(s) ya estaban registrados.'; return null; }
  if (txsConsultar.length > 0) {
    setTimeout(async function() {
      for (var ii=0; ii<txsConsultar.length; ii++) {
        try { await guardarConsultaPendiente(usuario, txsConsultar[ii]); await enviarWhatsapp(usuario.whatsapp, mensajeConsulta(txsConsultar[ii])); await new Promise(function(r){setTimeout(r,2000);}); }
        catch(e) { console.error('[CONSULTA]', e.message); }
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
  if (cacheErr) { console.error('[REPORTE] Error guardando cache:', cacheErr.message); }
  // Limpiar reportes expirados del mismo usuario (housekeeping silencioso)
  supabase.from('reporte_cache').delete().eq('usuario_id', usuario.id).lt('expires_at', new Date().toISOString()).then(() => {}).catch(() => {});
  return { ok: true, reporteId, txCount: txs.length };
}
async function recategorizarTransaccion(usuarioId, comercio, categoriaNueva) {
  const { data: txs } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId).ilike('comercio', '%' + comercio + '%')
    .order('created_at', { ascending: false }).limit(5);
  if (!txs || txs.length === 0) return { ok: false, msg: 'No encontre ninguna transaccion de *' + comercio + '*.' };
  const tx = txs[0];
  const categoriaAnterior = tx.categoria || 'Sin categoria';
  const { error } = await supabase.from('transacciones').update({ categoria: categoriaNueva }).eq('id', tx.id);
  if (error) return { ok: false, msg: 'Error actualizando: ' + error.message };
  return { ok: true, msg: 'Listo! Movi *' + (tx.comercio || comercio) + '* (S/ ' + tx.monto + ') de *' + categoriaAnterior + '* a *' + categoriaNueva + '*.' };
}
async function recategorizarPorId(transaccionId, categoriaNueva) {
  const { error } = await supabase.from('transacciones').update({ categoria: categoriaNueva }).eq('id', transaccionId);
  if (error) return { ok: false, msg: 'Error actualizando.' };
  return { ok: true };
}

async function parsearCorreccionesMultiples(msg) {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: `Eres un parser de correcciones de gastos financieros. La fecha de hoy es ${hoy}.
El usuario lista varios gastos que quiere reclasificar en un solo mensaje.
Extrae TODAS las correcciones y devuelve SOLO un array JSON con este formato:
[
  {
    "comercio": "nombre del comercio tal como aparece",
    "monto": numero o null,
    "fecha": "YYYY-MM-DD" o null,
    "categoria_nueva": "nombre de la categoria en español, capitalizada",
    "subcategoria_nueva": "subcategoria si se menciona, sino null"
  }
]
Reglas:
- "menu" o "almuerzo" → categoria_nueva="Alimentación"
- "gasolina" o "combustible" → categoria_nueva="Transporte", subcategoria_nueva="Gasolina"
- "uber", "taxi", "bus" → categoria_nueva="Transporte"
- "farmacia", "médico", "clinica" → categoria_nueva="Salud"
- Si dice "pasalo a X" o "ponlo en X" o "es de X" → categoria_nueva=X
- Si solo dice una palabra sin "pasalo"/"ponlo", esa palabra es la categoria o subcategoria
- Capitaliza la primera letra de categoria_nueva
IMPORTANTE: Devuelve SOLO el array JSON, sin texto adicional.`
      }, {
        role: 'user',
        content: msg
      }],
      temperature: 0
    });
    const raw = res.choices[0].message.content.trim();
    const arr = JSON.parse(raw.startsWith('[') ? raw : raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
    return Array.isArray(arr) ? arr : [];
  } catch(e) {
    console.error('[PARSE_MULT]', e.message);
    return [];
  }
}

async function corregirTransaccionEspecifica(usuarioId, comercio, monto, fecha, categoriaNueva) {
  let query = supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId)
    .ilike('comercio', '%' + comercio + '%')
    .order('fecha', { ascending: false })
    .limit(10);
  const { data: txs } = await query;
  if (!txs || txs.length === 0) return { ok: false, comercio };
  let tx = txs[0];
  // Afinar match por fecha y monto si se proporcionan
  if (fecha || monto) {
    const match = txs.find(t => {
      const fechaOk = !fecha || (t.fecha && t.fecha.startsWith(fecha));
      const montoOk = !monto || Math.abs(parseFloat(t.monto) - monto) < 0.5;
      return fechaOk && montoOk;
    });
    if (match) tx = match;
  }
  const { error } = await supabase.from('transacciones').update({ categoria: categoriaNueva }).eq('id', tx.id);
  if (error) return { ok: false, comercio };
  return { ok: true, comercio: tx.comercio || comercio, monto: tx.monto_pen || tx.monto, moneda: tx.moneda || 'PEN' };
}

async function interpretarComandoPresupuesto(texto) {
  try {
    var aiRes = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Extrae datos de presupuesto. SOLO JSON: {"es_presupuesto":true/false,"categoria":"nombre","monto":numero,"alerta_porcentaje":numero 1-100 default 80}' }, { role: 'user', content: texto }], temperature: 0 });
    var raw = aiRes.choices[0].message.content.trim();
    return JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
  } catch(e) { return { es_presupuesto: false }; }
}

function necesitaConsulta(tx) {
  if (!tx || tx.tipo !== 'gasto') return false;
  var genericos = ['yape','plin','transferencia','bcp','bbva','interbank','scotiabank'];
  const esGenerico = tx.comercio && genericos.indexOf(tx.comercio.toLowerCase()) >= 0;
  const esOtros = !tx.categoria || tx.categoria === 'Otro' || tx.categoria === 'Transferencia' || tx.categoria === 'Otros';
  return esGenerico || (esOtros && tx.comercio);
}

async function guardarReglaComercio(usuarioId, comercio, categoria, subcategoria) {
  if (!comercio || !categoria) return;
  const patron = comercio.toLowerCase().trim();
  try {
    await supabase.from('reglas_comercio').upsert({
      usuario_id: usuarioId,
      comercio_pattern: patron,
      categoria,
      subcategoria: subcategoria || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'usuario_id,comercio_pattern' });
  } catch(e) { console.error('[REGLA]', e.message); }
}

async function buscarReglaComercio(usuarioId, comercio) {
  if (!comercio) return null;
  const patron = comercio.toLowerCase().trim();
  const { data } = await supabase.from('reglas_comercio').select('categoria,subcategoria')
    .eq('usuario_id', usuarioId)
    .eq('comercio_pattern', patron)
    .single();
  return data || null;
}

async function retroaplicarRegla(usuarioId, comercio, categoria, subcategoria) {
  if (!comercio || !categoria) return;
  try {
    const updates = { categoria };
    if (subcategoria) updates.subcategoria = subcategoria;
    await supabase.from('transacciones').update(updates)
      .eq('usuario_id', usuarioId)
      .ilike('comercio', '%' + comercio + '%')
      .neq('categoria', categoria);
    console.log('[REGLA] Retroaplicada:', comercio, '->', categoria);
  } catch(e) { console.error('[RETROAPLICAR]', e.message); }
}

function mensajeConsulta(tx) {
  var monto = parseFloat(tx.monto||0).toFixed(2), banco = tx.banco || tx.comercio || 'Pago', fecha = tx.fecha || 'hoy';
  return '\uD83D\uDCB8 ' + banco + ' \u2014 S/ ' + monto + ' (' + fecha + ')\n\n\u00bfPara qu\u00e9 fue ese pago?\nDime con tus palabras: _"almuerzo"_, _"taxi"_, _"supermercado"_...';
}

async function guardarConsultaPendiente(usuario, tx) {
  try { await supabase.from('consultas_pendientes').insert({ usuario_id: usuario.id, transaccion_id: tx.id, monto: tx.monto, banco: tx.banco||tx.comercio, fecha: tx.fecha, estado: 'pendiente' }); }
  catch(e) { console.error('[CONSULTA] Error guardando:', e.message); }
}

async function obtenerConsultasPendientes(usuarioId) {
  var res = await supabase.from('consultas_pendientes').select('*').eq('usuario_id', usuarioId).eq('estado', 'pendiente').order('created_at', { ascending: true });
  return res.data || [];
}

async function resolverConsulta(consultaId) {
  await supabase.from('consultas_pendientes').update({ estado: 'respondida', respondida_at: new Date().toISOString() }).eq('id', consultaId);
}

function formatearPendientes(consultas) {
  var ahora = Date.now();
  var items = consultas.map(function(c, i) {
    var ms = ahora - new Date(c.created_at).getTime(), horas = Math.round(ms/3600000);
    return (i+1) + '. *' + (c.banco||'Pago') + '* S/ ' + parseFloat(c.monto||0).toFixed(2) + ' (' + (c.fecha||'') + ') -- ' + (ms<3600000?'hace menos de 1h':horas<24?horas+'h atras':Math.round(horas/24)+'d atras');
  });
  return '*Tienes ' + consultas.length + ' gasto(s) sin identificar:*\n\n' + items.join('\n') + '\n\nPara categorizar responde:\n_"El 1 fue para almuerzo"_ o _"/cambiar Yape Comida"_';
}

async function intentarResolverConsulta(usuario, texto) {
  var pendientes = await obtenerConsultasPendientes(usuario.id);
  if (pendientes.length === 0) return null;
  var ctx = pendientes.map(function(c,i){ return (i+1)+'. '+(c.banco||'Pago')+' S/'+c.monto+' del '+c.fecha; }).join('; ');
  var parsed;
  try {
    var aiRes = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Gastos pendientes: '+ctx+'. Usuario respondio: "'+texto+'". SOLO JSON: {"resuelve":true/false,"numero":1/2/null,"categoria":"Alimentación|Transporte|Vivienda|Salud|Entretenimiento|Compras|Educación|Finanzas|Trabajo_Negocio|Otros","descripcion":"descripcion corta"}' }], temperature: 0 });
    var raw = aiRes.choices[0].message.content.trim();
    parsed = JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
  } catch(e) { return null; }
  if (!parsed.resuelve || !parsed.numero) return null;
  var consulta = pendientes[parsed.numero-1]; if (!consulta) return null;
  var detCat = await detectarCategoriaIA(texto, usuario.id);
  var catFinal = detCat.categoria || parsed.categoria;
  var subFinal = detCat.subcategoria || null;
  const comercioFinal = parsed.descripcion || consulta.banco;
  await supabase.from('transacciones').update({ categoria: catFinal, subcategoria: subFinal, comercio: comercioFinal }).eq('id', consulta.transaccion_id);
  await resolverConsulta(consulta.id);
  // Guardar regla y retroaplicar a transacciones pasadas del mismo comercio
  if (comercioFinal) {
    guardarReglaComercio(usuario.id, comercioFinal, catFinal, subFinal);
    retroaplicarRegla(usuario.id, comercioFinal, catFinal, subFinal);
  }
  var resto = pendientes.length > 1 ? '\n\nAun tienes ' + (pendientes.length-1) + ' gasto(s) pendiente(s). Escribe */pendientes*.' : '';
  return 'Listo! Actualice *'+(comercioFinal||'el pago')+'* (S/ '+parseFloat(consulta.monto).toFixed(2)+') a *'+catFinal+'*'+(subFinal?' > '+subFinal:'')+'.'+resto;
}

const CATEGORIAS_SUGERIDAS = [
  { nombre: 'Alimentaci\u00f3n', emoji: '\uD83C\uDF7D\uFE0F', subs: ['delivery','restaurante','supermercado','mercado','cafeteria','snacks'] },
  { nombre: 'Transporte',    emoji: '\uD83D\uDE8C',         subs: ['uber_cabify','taxi','bus_micro','metro_bus','gasolina','peaje','estacionamiento'] },
  { nombre: 'Vivienda',      emoji: '\uD83C\uDFE0',         subs: ['alquiler','mantenimiento','electricidad','agua','gas','internet','cable'] },
  { nombre: 'Salud',         emoji: '\uD83D\uDC8A',         subs: ['farmacia','medico','clinica','laboratorio','seguro_salud','optica'] },
  { nombre: 'Entretenimiento', emoji: '\uD83C\uDFB0',       subs: ['streaming','cine','juegos','bares_clubs','eventos','hobbies'] },
  { nombre: 'Compras',       emoji: '\uD83D\uDED2',         subs: ['ropa','calzado','electronico','hogar','belleza','mascotas'] },
  { nombre: 'Educaci\u00f3n',     emoji: '\uD83D\uDCDA',         subs: ['universidad','instituto','curso_online','utiles','idiomas','colegios'] },
  { nombre: 'Finanzas',      emoji: '\uD83D\uDCB3',         subs: ['prestamo','tarjeta_credito','seguro','ahorro','inversion','comision_banco'] },
  { nombre: 'Trabajo_Negocio', emoji: '\uD83D\uDCBC',       subs: ['herramientas','publicidad','oficina','logistica','contador'] },
  { nombre: 'Otros',         emoji: '\uD83D\uDCCB',         subs: ['regalo','donacion','multa','viaje','sin_categoria'] }
];

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

function formatearCategoriasMsg(categorias) {
  if (!categorias || categorias.length === 0) {
    return '*No tienes categorias personalizadas.*\n\nResponde con los numeros para activar:\n\n' + CATEGORIAS_SUGERIDAS.map(function(c,i){ return (i+1)+'. '+c.emoji+' '+c.nombre; }).join('\n') + '\n\n_(ej: 1 3 5 o "todas")_';
  }
  var msg = '*Tus categorias activas:*\n\n';
  for (var ci = 0; ci < categorias.length; ci++) {
    var cat = categorias[ci];
    msg += cat.emoji + ' *' + cat.nombre + '*';
    if (cat.subcategorias && cat.subcategorias.length > 0) msg += '\n   -> ' + cat.subcategorias.map(function(s){ return s.nombre; }).join(', ');
    msg += '\n';
  }
  msg += '\n*/categorias agregar* -- activar mas categorias';
  return msg;
}

function parsearIndicesRespuesta(texto, max) {
  const t = texto.trim().toLowerCase();
  if (t === 'todas' || t === 'all') return Array.from({length: max}, (_,i) => i+1);
  const nums = t.split(/\s+/).map(Number).filter(n => n >= 1 && n <= max && !isNaN(n));
  return [...new Set(nums)];
}

async function detectarCategoriaIA(texto, usuarioId) {
  const cats = await obtenerCategoriasUsuario(usuarioId);
  let contexto;
  if (cats && cats.length > 0) {
    contexto = cats.map(c => c.nombre + (c.subcategorias.length > 0 ? ' (subs: '+c.subcategorias.map(s=>s.nombre).join(',')+')' : '')).join('; ');
  } else {
    contexto = CATEGORIAS_SUGERIDAS.map(c => c.nombre + (c.subs.length > 0 ? ' (subs: '+c.subs.join(',')+')' : '')).join('; ');
  }
  try {
    const res = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Categorias: '+contexto+'. Para el gasto "'+texto+'", elige la mas apropiada. SOLO JSON: {"categoria":"nombre exacto","subcategoria":"nombre exacto o null"}' }], temperature: 0 });
    const raw = res.choices[0].message.content.trim();
    return JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
  } catch(e) { return { categoria: null, subcategoria: null }; }
}


// Crea una categoría personalizada para el usuario si no existe
function getEmojiCategoria(nombre) {
  const cat = CATEGORIAS_SUGERIDAS.find(c => c.nombre.toLowerCase() === (nombre||'').toLowerCase());
  return cat ? cat.emoji : null;
}

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

// --- Referidos ---
function generarRefCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function registrarReferido(referrerId, referidoId) {
  try {
    const { data: existe } = await supabase.from('referidos').select('id').eq('referrer_id', referrerId).eq('referido_id', referidoId).single();
    if (existe) return;
    const { data: referrer } = await supabase.from('usuarios').select('ref_code').eq('id', referrerId).single();
    if (!referrer) return;
    await supabase.from('referidos').insert({ ref_code: referrer.ref_code, referrer_id: referrerId, referido_id: referidoId });
  } catch(e) { console.error('[REFERIDO] Error registrando:', e.message); }
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
    if (totalActivos >= 3) {
      const { data: referrer } = await supabase.from('usuarios').select('plan, whatsapp').eq('id', referrerId).single();
      if (referrer && referrer.plan !== 'premium') {
        const vence = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        await supabase.from('usuarios').update({ plan: 'premium', premium_desde: new Date().toISOString().split('T')[0], premium_vence: vence }).eq('id', referrerId);
        await enviarWhatsapp(referrer.whatsapp, '\u2B50 *\u00bfReferidos que funcionan!*\n\n3 de tus amigos ya usan NETO activamente.\n\nTe hemos activado *1 mes de NETO Pro gratis* \uD83C\uDF89\n\nVence: ' + vence + '\n\n_Gracias por crecer con nosotros._');
      }
    }
  } catch(e) { console.error('[REFERIDO] Error verificando Pro:', e.message); }
}

// Servir archivos estaticos
app.use(express.static(path.join(__dirname, 'public')));

// === RUTAS WEB ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/privacidad', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

app.get('/terminos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminos.html'));
});

app.get('/contacto', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contacto.html'));
});

app.get('/faq', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'faq.html'));
});
// ============================================================
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'NETO', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verificado por Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
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
      const mediaId = message.image && message.image.id;
      const phoneId = process.env.META_PHONE_NUMBER_ID;
      const metaToken = process.env.META_ACCESS_TOKEN;
      console.log('[IMAGEN] media_id:', mediaId, 'phone_id:', phoneId, 'token_ok:', !!metaToken);
      if (!mediaId) { await enviarWhatsapp(from, 'No pude recibir la imagen. Intenta de nuevo.'); return; }
      try {
        // 1. Obtener URL de la imagen desde Meta API
        const metaUrl = 'https://graph.facebook.com/v19.0/' + mediaId + '?phone_number_id=' + phoneId;
        const metaRes = await fetch(metaUrl, {
          headers: { Authorization: 'Bearer ' + metaToken }
        });
        const metaJson = await metaRes.json();
        console.log('[IMAGEN] metaJson:', JSON.stringify(metaJson).slice(0, 200));
        if (!metaJson.url) throw new Error('Meta no devolvió URL: ' + JSON.stringify(metaJson).slice(0, 100));

        // 2. Descargar imagen como base64
        const imgRes = await fetch(metaJson.url, {
          headers: { Authorization: 'Bearer ' + metaToken }
        });
        if (!imgRes.ok) throw new Error('Error descargando imagen: ' + imgRes.status);
        const imgBuffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(imgBuffer).toString('base64');
        const mimeType = metaJson.mime_type || message.image.mime_type || 'image/jpeg';
        console.log('[IMAGEN] Descargada OK, mime:', mimeType, 'size:', imgBuffer.byteLength);

        // 3. Parsear con GPT-4o vision
        const hoy = new Date().toISOString().split('T')[0];
        const visionRes = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Esta imagen es una captura de pantalla de un pago (Yape, Plin, banco peruano). Extrae los datos y devuelve SOLO JSON válido, sin texto extra:\n{"tipo":"gasto","monto":numero,"moneda":"PEN","comercio":"nombre del destinatario o descripcion del pago","categoria":"Alimentación|Transporte|Vivienda|Salud|Entretenimiento|Compras|Educación|Finanzas|Trabajo_Negocio|Otros","subcategoria":"descripcion breve","fecha":"YYYY-MM-DD","descripcion_original":"texto clave de la imagen"}\nSi la imagen NO muestra ningún pago o transacción, devuelve: {"tipo":"no_pago"}\nFecha de hoy si no se ve en la imagen: ' + hoy },
              { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64, detail: 'high' } }
            ]
          }],
          temperature: 0, max_tokens: 400
        });
        const rawV = visionRes.choices[0].message.content.trim();
        console.log('[IMAGEN] GPT response:', rawV.slice(0, 200));

        // Parsear JSON de la respuesta
        let parsed;
        try {
          const start = rawV.indexOf('{'); const end = rawV.lastIndexOf('}');
          parsed = JSON.parse(start >= 0 ? rawV.slice(start, end + 1) : rawV);
        } catch(pe) { throw new Error('GPT no devolvió JSON válido: ' + rawV.slice(0, 100)); }

        if (parsed.tipo === 'no_pago') {
          await enviarWhatsapp(from, 'No reconocí ningún pago en esa imagen. Envíame la captura de la notificación de Yape o tu banco (la pantalla que dice "¡Yapeaste!" o similar).');
          return;
        }
        if (!parsed.monto || isNaN(parseFloat(parsed.monto))) {
          throw new Error('No se detectó monto en la imagen');
        }
        parsed.fecha = parsed.fecha || hoy;
        await guardarTransaccion(usuario.id, parsed);
        const montoStr = parsed.moneda === 'USD' ? '$' + parseFloat(parsed.monto).toFixed(2) : 'S/ ' + parseFloat(parsed.monto).toFixed(2);
        const emoji = getEmojiCategoria(parsed.categoria) || '📋';
        await enviarWhatsapp(from, '📸 ¡Listo! Registré desde la imagen:\n\n' + emoji + ' *' + (parsed.comercio || 'Pago') + '* — ' + montoStr + '\nCategoría: ' + parsed.categoria + (parsed.subcategoria && parsed.subcategoria !== 'sin_categoria' ? ' > ' + parsed.subcategoria : '') + '\nFecha: ' + parsed.fecha + '\n\n_¿Algo está mal? Dímelo y lo corrijo._');
      } catch(e) {
        console.error('[IMAGEN] Error:', e.message);
        await enviarWhatsapp(from, 'No pude procesar la imagen. Asegúrate de enviar la captura de la notificación de pago (la pantalla que muestra el monto y destinatario).');
      }
      return;
    }

    // --- Manejo de documentos (Excel para carga de gastos históricos) ---
    if (message.type === 'document') {
      const usuario = await obtenerOCrearUsuario(from);
      const config = getUserPlanConfig(usuario);

      if (!config.excelUpload) {
        await enviarWhatsapp(from, '📄 La carga de gastos históricos es una función *Pro*.\n\nEscribe */premium* para activarla.');
        return;
      }

      const doc = message.document;
      const fileName = (doc && doc.filename) || '';
      const docMime = (doc && doc.mime_type) || '';

      if (!fileName.endsWith('.xlsx') && !docMime.includes('spreadsheet') && !docMime.includes('excel') && !docMime.includes('officedocument')) {
        await enviarWhatsapp(from, '📄 Solo acepto archivos Excel (.xlsx).\n\nDescarga la plantilla en: neto.pe/plantilla_gastos.xlsx');
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
        console.log('[EXCEL] Archivo descargado, size:', fileBuffer.byteLength);

        // 2. Parsear con exceljs
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(fileBuffer);
        const sheet = workbook.getWorksheet(1);
        if (!sheet) throw new Error('El archivo no tiene hojas de cálculo');

        // 3. Detectar header row y formato de columnas (auto-detect)
        const rows = [];
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

        if (rows.length === 0) throw new Error('No encontré datos válidos en el archivo. Asegúrate de usar la plantilla correcta.');
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
              console.error('[EXCEL] Error categorizando batch:', catErr.message);
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
            console.error('[EXCEL] Error insertando fila:', insErr.message);
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
        console.log('[EXCEL] Carga completada: ' + insertados + ' ok, ' + errores + ' errores');
      } catch(e) {
        console.error('[EXCEL] Error:', e.message);
        await enviarWhatsapp(from, '❌ Error procesando el archivo: ' + e.message + '\n\nDescarga la plantilla correcta en: neto.pe/plantilla_gastos.xlsx');
      }
      return;
    }

    if (message.type !== 'text') return;
    const msg = (message.text.body || '').trim();
    console.log('[MSG] [' + from + ']: ' + msg);

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

    if (!cmd.startsWith('/') && cmd !== 'hola' && cmd !== 'hi' && cmd !== 'inicio') {
      var pendInter = await obtenerConsultasPendientes(usuario.id);
      if (pendInter.length > 0) {
        var resC = await intentarResolverConsulta(usuario, msg);
        if (resC) { await enviarWhatsapp(from, resC); return; }
        var hayViejos = pendInter.some(function(c) { return (Date.now() - new Date(c.created_at).getTime()) > 3600000; });
        if (hayViejos) { var consol = formatearPendientes(pendInter); await enviarWhatsapp(from, consol); return; }
      }
    }

    const esUsuarioNuevo = !usuario.gmail_access_token;
    if (cmd === 'hola' || cmd === 'hi' || cmd === 'inicio') {
      var tieneGmail = !!usuario.gmail_access_token;
      var primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
      if (!tieneGmail) {
        var urlOAuth = generarUrlAutorizacion(from);
        await supabase.from('usuarios').update({ onboarding_paso: 1 }).eq('id', usuario.id);
        respuesta = '\uD83D\uDC4B Hola' + (primerNombre ? ', ' + primerNombre : '') + '. Soy NETO, tu asistente financiero.\n\nLeo tus correos de BCP, Interbank, BBVA, Scotiabank, Yape y Plin automaticamente.\n\nPara empezar, conecta tu Gmail:\n\n' + urlOAuth + '\n\n_Solo leemos notificaciones bancarias. Sin contrasenas bancarias._ \uD83D\uDD12';
      } else {
        var gastosMesHola = await obtenerGastosMes(usuario.id);
        var totalMesHola = gastosMesHola.reduce(function(s,t){return s+parseFloat(t.monto);},0);
        var pendHola = await obtenerConsultasPendientes(usuario.id);
        var alertaPend = pendHola.length > 0 ? '\n\n\u2757 *' + pendHola.length + ' gasto(s) sin identificar.* Escribe */pendientes*.' : '';
        var catsHola = await obtenerCategoriasUsuario(usuario.id);
        var tipCats = (!usuario.onboarding_completado && !catsHola) ? '\n\n\uD83D\uDCA1 Escribe */categorias* para personalizar tus categorias.' : '';
        var saludo = primerNombre ? 'Hola, ' + primerNombre + '!' : 'Hola!';
        respuesta = '\uD83D\uDC4B Hola' + (primerNombre ? ', ' + primerNombre : '') + '. Soy NETO.\n\n' +
          (gastosMesHola.length > 0 ? 'Este mes llevas *S/ ' + totalMesHola.toFixed(0) + '* en ' + gastosMesHola.length + ' movimientos.' : 'Sin movimientos este mes aun.') +
          (pendHola.length > 0 ? '\n\n\u2757 ' + pendHola.length + ' gasto(s) sin identificar. Escribe */pendientes*.' : '') +
          '\n\n\u00bfQue revisamos?';
      }
    } else if (esUsuarioNuevo && !cmd.startsWith('/')) {
      respuesta = '\uD83D\uDC4B Hola. Soy NETO, tu asistente financiero.\n\nEscribe *hola* para empezar.';
    } else if (cmd === '/conectar') {
      respuesta = 'Para conectar tu Gmail, abre este enlace:\n\n' + generarUrlAutorizacion(from) + '\n\n_Solo leemos notificaciones bancarias. Sin contrasenas bancarias._';
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
        const planUsuario = usuario.plan || 'free';
        const mesActualNum = ahoraR.getMonth() + 1;
        const anioActualNum = ahoraR.getFullYear();
        let puedeGenerar = false;
        if (planUsuario === 'premium') {
          puedeGenerar = true;
        } else {
          const resetDate = usuario.reporte_reset_mes;
          const resetMes = resetDate ? parseInt(String(resetDate).slice(5,7)) : null;
          const resetAnio = resetDate ? parseInt(String(resetDate).slice(0,4)) : null;
          const esMesNuevo = !resetDate || resetMes !== mesActualNum || resetAnio !== anioActualNum;
          if (esMesNuevo) { await supabase.from('usuarios').update({ reporte_usos_mes: 0, reporte_reset_mes: anioActualNum + '-' + String(mesActualNum).padStart(2,'0') + '-01' }).eq('id', usuario.id); usuario.reporte_usos_mes = 0; }
          if ((usuario.reporte_usos_mes || 0) < 1) { puedeGenerar = true; }
          else { respuesta = '\uD83D\uDCCA Ya usaste tu *reporte gratuito* de este mes.\n\n\u2B50 *NETO Pro* \u2014 reportes ilimitados + resumen semanal + categorias personalizadas.\n\n*Solo S/10/mes*\n\nEscribe */premium* para activarlo.'; }
        }
        if (puedeGenerar) {
          await enviarWhatsapp(from, 'Preparando tu reporte de ' + MESES[mesR] + '... \u23F3');
          if (planUsuario === 'free') { await supabase.from('usuarios').update({ reporte_usos_mes: (usuario.reporte_usos_mes || 0) + 1 }).eq('id', usuario.id); }
          const railwayUrl = process.env.RAILWAY_URL || 'https://neto.pe';
          generarYEnviarReporte(usuario, mesR, anioR).then(async (result) => {
            if (!result.ok) { await enviarWhatsapp(from, result.msg); }
            else { const mE = ['','Enero','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']; const ttl = planUsuario === 'premium' ? '24 horas' : '1 hora'; await enviarWhatsapp(from, '\uD83D\uDCCA *Tu dashboard de ' + mE[mesR] + ' ' + anioR + ' esta listo!*\n\n' + result.txCount + ' transacciones analizadas.\n\n\uD83D\uDD17 ' + railwayUrl + '/mi-reporte/' + result.reporteId + '\n\n_Disponible ' + ttl + '. Incluye salud financiera, proyecciones y acciones._' + (planUsuario === 'free' ? '\n\n_Reporte gratuito del mes usado._' : '')); }
          }).catch(async (e) => { await enviarWhatsapp(from, 'Error: ' + e.message); });
          return;
        }
      }
    } else if (cmd === '/premium') {
      const planActual = usuario.plan || 'free';
      if (planActual === 'premium') {
        respuesta = '\u2B50 *Ya tienes NETO Pro activo*\n\n\u2705 Reportes PDF ilimitados\n\u2705 Resumen semanal automatico\n\u2705 Categorias personalizadas\n\u2705 Sin restricciones\n\n_Gracias por tu apoyo!_ \uD83D\uDC9A';
      } else {
        respuesta = '\u2B50 *NETO Pro \u2014 S/10/mes*\n\n\u2705 Reportes PDF ilimitados\n\u2705 Resumen semanal automatico\n\u2705 Categorias personalizadas\n\u2705 Sin restricciones\n\n*\u00bfC\u00f3mo pagar?*\n\n\uD83D\uDCB8 *Opcion 1 \u2014 Yape*\nYapea S/ 10 al:\n*+51970398192* (Favio M.)\n\nLuego env\u00edame el comprobante o escribe:\n_"ya pague por yape, operacion 12345678"_\n\n_Activacion en menos de 1 hora._';
        // Marcar que usuario esta en flujo de pago
        await supabase.from('usuarios').update({ pago_pendiente: true }).eq('id', usuario.id);
      }
    } else if (cmd === '/referir') {
      let refCode = usuario.ref_code;
      if (!refCode) {
        refCode = generarRefCode();
        await supabase.from('usuarios').update({ ref_code: refCode }).eq('id', usuario.id);
        usuario.ref_code = refCode;
      }
      const { data: misRefs } = await supabase.from('referidos').select('activo').eq('referrer_id', usuario.id);
      const totalRefs = (misRefs || []).length;
      const activos = (misRefs || []).filter(r => r.activo).length;
      const railwayUrl = process.env.RAILWAY_URL || 'https://neto.pe';
      respuesta = '\uD83C\uDF81 *Tu link de referido:*\n\n' + railwayUrl + '/r/' + refCode + '\n\nComparte con amigos. Cuando *3 de ellos usen NETO activamente*, recibes *1 mes Pro gratis* \uD83C\uDF89\n\n_Referidos: ' + totalRefs + ' | Activos: ' + activos + '/3_';
    } else if (cmd === '/dashboard') {
      // /dashboard ahora genera el mismo dashboard interactivo que /reporte (mes actual)
      const ahora = new Date();
      const mesActual = ahora.getMonth() + 1;
      const anioActual = ahora.getFullYear();
      const result = await generarYEnviarReporte(usuario, mesActual, anioActual);
      const railwayUrl = process.env.RAILWAY_URL || 'https://neto.pe';
      if (!result.ok) {
        respuesta = result.msg;
      } else {
        respuesta = '\uD83D\uDCCA *Tu dashboard esta listo!*\n\n' + result.txCount + ' transacciones analizadas.\n\n\uD83D\uDD17 ' + railwayUrl + '/mi-reporte/' + result.reporteId + '\n\n_Disponible ' + (usuario.plan === 'premium' ? '24 horas' : '1 hora') + '. Incluye salud financiera, proyecciones y acciones._';
      }
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
    } else if (cmd === '/usuarios' || cmd === '/admin') {
      // Panel admin rapido
      const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || '51970398192';
      if (from !== ADMIN_NUMBER) {
        respuesta = 'No tienes permiso para usar este comando.';
      } else {
        const { data: todos } = await supabase.from('usuarios').select('whatsapp, nombre, plan, pago_pendiente, created_at').order('created_at', { ascending: false }).limit(20);
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
            msg += plan + ' ' + (u.nombre || u.whatsapp) + pend + '\n';
          });
          if (pendientes > 0) msg += '\n_Usa /activar <numero> para activar un pago._';
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
      respuesta = '*Comandos NETO:*\n*/semana* -- gastos 7 dias\n*/mes* -- gastos del mes\n*/presupuesto* -- ver/configurar presupuesto\n*/categorias* -- categorias\n*/conectar* -- vincular Gmail\n*/escanear* -- leer correos ahora\n*/cambiar [comercio] [cat]* -- corregir categoria\n*/reporte* -- PDF del mes\n*/reporte ' + mesActual + '* -- PDF mes especifico\n*/pendientes* -- gastos sin identificar\n*/dashboard* -- ver graficos de gastos\n*/referir* -- invitar amigos y ganar Pro\n*/premium* -- plan premium\n*hola* -- estado general\n\n_Tambien puedes escribirme en lenguaje natural!_';
    } else {
      respuesta = await procesarMensajeLibre(msg, usuario, from);
    }
    if (respuesta) {
      await enviarWhatsapp(from, respuesta);
      // Guardar respuesta de NETO en historial
      try { await guardarMensaje(usuario.id, 'neto', respuesta); } catch(e) {}
    }
  } catch (error) { console.error('ERROR:', error.message); }
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
    console.error('[REPORTE] Error leyendo cache:', e.message);
    res.status(500).send('<h2>Error cargando el reporte. Intenta de nuevo.</h2>');
  }
});


// Ruta de referido: redirige a WhatsApp con el ref_code pre-cargado
app.get('/r/:code', async (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const { data: referrer } = await supabase.from('usuarios').select('id').eq('ref_code', code).single();
  const waNum = '51970398192';
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
    console.error('[DASHBOARD] Error:', e.message);
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
    console.error('[API/REPORTE] Error:', e.message);
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
    console.error('[API/REPORTE/MES] Error:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Fallback para dashboard interactivo — sirve el shell estatico de Next.js
// La pagina esta en /mi-reporte.html, el ID se lee del path en el cliente
app.get('/mi-reporte/:id', (req, res) => {
  const shellPath = path.join(__dirname, 'public', 'mi-reporte.html');
  if (fs.existsSync(shellPath)) return res.sendFile(shellPath);
  res.status(404).send('<h2>Dashboard no disponible. Genera uno nuevo con /reporte</h2>');
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
      await supabase.from('usuarios').update({ nombre: usuario.nombre || perfil.nombre, email: emailConectado }).eq('id', usuario.id);
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
          await new Promise(r => setTimeout(r, 2000));
          if (modoConexion === 'inicial') {
            await enviarWhatsapp(usuario.whatsapp, '*Paso 2 de 2: Elige tus categorias* 🏷️\n\n' + CATEGORIAS_SUGERIDAS.map((c,i) => (i+1)+'. '+c.emoji+' '+c.nombre).join('\n') + '\n\n_Responde con los numeros (ej: 1 3 5) o escribe "todas"_');
            await supabase.from('usuarios').update({ onboarding_paso: 10 }).eq('id', usuario.id);
          }
        } else {
          await enviarWhatsapp(usuario.whatsapp, '🔍 No encontré correos bancarios recientes.\n\nTe avisaré cuando llegue uno.');
          if (modoConexion === 'inicial') await supabase.from('usuarios').update({ onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
        }
      } catch(e) { console.error('[CALLBACK]', e.message); }
    }, 2000);
  } catch (err) { res.send('<h2>Error: ' + err.message + '</h2>'); }
});

app.post('/test-parser', async (req, res) => {
  const { correo } = req.body;
  if (!correo) return res.status(400).json({ error: 'Falta correo' });
  try { const r = await parsearCorreoBancario(correo); res.json({ ok: true, resultado: r }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (req, res) => res.send('NETO v5'));

// Endpoint admin: activar premium via web
// POST /admin/activar { whatsapp: "51970398192", clave: "ADMIN_KEY" }
app.post('/admin/activar', async (req, res) => {
  const { whatsapp, clave } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (!ADMIN_KEY || clave !== ADMIN_KEY) return res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
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
app.get('/admin/pendientes', async (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (!ADMIN_KEY || req.query.clave !== ADMIN_KEY) return res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
  const { data } = await supabase.from('usuarios').select('whatsapp, nombre, plan, pago_pendiente, pago_referencia, created_at').eq('pago_pendiente', true);
  res.json({ ok: true, pendientes: data || [] });
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
    mensajes.push({ role: 'user', content: 'Mensaje del usuario: "' + mensajeOriginal + '"\n\nDatos disponibles:\n' + contexto + '\n\nRedacta la respuesta de NETO. Maximo 8 lineas. Sin markdown pesado. Termina con pregunta o accion concreta si aplica.' });
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      temperature: 0.7,
      messages: mensajes
    });
    return res.choices[0].message.content.trim();
  } catch(e) {
    console.error('[NETO GPT] Error:', e.message);
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
    } catch(e) { console.error('[NETO] Error cargando system prompt:', e.message); }

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
        content: 'Eres el clasificador de intenciones de NETO, bot de finanzas personales por WhatsApp para usuarios peruanos.\nEl mes actual es ' + mE[mesActual] + ' ' + anioActual + '.\n\nAnaliza el mensaje y devuelve SOLO JSON.\n\nINTENCIONES:\n1. "listar_gastos_mes" - ver resumen/lista de gastos del mes\n   Ej: "cuales son mis gastos", "que gaste este mes", "gastos registrados", "que tengo registrado", "mis compras", "transacciones"\n   Datos: mes (numero, default=mes_actual), anio\n\n2. "listar_gastos_semana" - gastos de los ultimos 7 dias\n   Ej: "que gaste esta semana", "gastos recientes", "mis compras de los ultimos dias"\n\n3. "listar_gastos_categoria" - gastos de UNA categoria especifica\n   Ej: "que hay en Otros", "gastos de Alimentación", "que esta en Transporte", "detalle de Hogar", "cuales estan en otros"\n   Datos: categoria (nombre exacto), mes (default=mes_actual)\n\n4. "ver_total_gastado" - saber el TOTAL numerico gastado\n   Ej: "cuanto gaste", "cuanto llevo gastado", "total de gastos"\n   Datos: periodo ("semana" o "mes"), categoria (o null)\n\n5. "ver_presupuesto" - ver estado del presupuesto\n   Ej: "como va mi presupuesto", "cuanto me queda", "mis limites"\n\n6. "configurar_presupuesto" - configurar limite de gasto\n   Ej: "pon limite de 500 en comida", "presupuesto de 300 para transporte"\n   Datos: categoria, monto\n\n7. "ver_categorias" - ver categorias configuradas del sistema\n   Ej: "que categorias hay", "muestra las categorias del sistema"\n   IMPORTANTE: Si el historial muestra que NETO estaba hablando de gastos por categoria, NO usar esta intencion\n\n8. "ver_reporte" - reporte PDF\n   Ej: "dame mi reporte", "informe mensual", "reporte de marzo", "genera pdf"\n   Datos: mes (default=mes_actual), anio\n\n9. "corregir_categoria" - cambiar categoria de un gasto\n   Ej: "netflix es streaming", "cambia uber a transporte", "ponlo en Hogar", "muevelo a Delivery", "este gasto es de Comida", "ponlo en la categoria NETO", "categorizalo en Trabajo", "muevelo a Herramientas", "regístralo en alimentación", "es alimentación porque compré pan", "ponlo en comida", "es de transporte"\n   IMPORTANTE: Usar cuando el usuario quiere mover/cambiar/reclasificar un gasto a cualquier categoria (incluso una categoría personalizada no canónica como "NETO", "Mascota", etc). comercio puede ser null. También usar cuando el historial muestra que NETO acaba de registrar un gasto (desde imagen o notificación) y el usuario corrige la categoría.\n   Datos: comercio (null si no se menciona), categoria_nueva (el nombre exacto que dijo el usuario)\n\n10. "ver_pendientes" - gastos sin identificar\n    Ej: "gastos pendientes", "que no identificaste", "gastos sin categoria"\n\n11. "escanear_gmail" - escanear correos\n    Ej: "escanea mi correo", "busca transacciones nuevas", "hay correos nuevos"\n\n12. "ver_premium" - info del plan premium\n    Ej: "cuanto cuesta premium", "que incluye el plan"\n\n13. "saludo" - saludo sin intencion especifica\n    Ej: "buenos dias", "que tal", "como estas"\n\n14. "ayuda" - pide ayuda\n    Ej: "que puedes hacer", "ayuda", "como funciona"\n\n15. "registrar_manual" - el usuario quiere registrar un gasto o ingreso NUEVO\n   Ej: "gaste 50 soles en farmacia", "anota S/120 en ropa", "mi sueldo fue S/4500", "cobré S/800 de honorarios", "registra un ingreso de S/3500", "pague 200 en gasolina ayer"\n   IMPORTANTE: NO usar si el historial muestra que NETO acaba de notificar un gasto existente y el usuario está corrigiendo su moneda o monto (ej: "el gasto es USD 95", "son dolares", "el importe es 25 USD" → usar corregir_monto_moneda).\n   Datos: ninguno (se parsea el mensaje completo)\n\n16. "desconocido" - no encaja con ninguna intencion clara, o es continuacion de conversacion\n    Usar cuando: el mensaje es "si", "no", "dale", "ok", "mas", o cualquier respuesta corta a algo que NETO pregunto\n\n17. "corregir_monto_moneda" - el usuario indica que la moneda o monto de un gasto YA REGISTRADO está incorrecto\n   Ej: "el gasto es en dolares", "es en USD no en soles", "corrígelo son $25", "el monto es USD 25", "son 25 dolares", "el importe es en dolares", "eso es en USD", "el gasto es USD 95.07", "cambiale la moneda a dolares", "es dolar no sol"\n   IMPORTANTE: Solo cuando el historial muestra que se habla de un gasto existente ya notificado por NETO.\n   Datos: monto (numero o null), moneda ("USD" o "PEN" o null)\n\n18. "corregir_multiple" - el usuario da 2 o más instrucciones de corrección de categoría en el mismo mensaje, cada una referenciando un comercio/gasto diferente\n   Ej: "Netflix pasalo a Entretenimiento · Uber a Transporte · BCP comision a Finanzas", "E S NEUQUEN pasalo a gasolina\\nEdita Pal menu\\nEdita Pal (18/03) pasalo a menu"\n   IMPORTANTE: Usar cuando hay CLARAMENTE múltiples correcciones distintas en el mensaje (2+). Si solo hay una, usar corregir_categoria.\n   Datos: ninguno (se parsea el mensaje completo)\n\n19. "agregar_gmail" - el usuario quiere conectar una cuenta Gmail adicional (ya tiene una conectada)\n   Ej: "quiero agregar otro correo", "conectar una segunda cuenta de gmail", "agregar otro gmail", "tengo otro correo que quiero añadir"\n   Datos: ninguno\n\n20. "cambiar_gmail" - el usuario quiere reemplazar/cambiar su cuenta Gmail actual\n   Ej: "quiero cambiar mi cuenta", "me equivoqué de correo", "cambiar el gmail", "reconectar mi correo", "el correo que puse está mal", "quiero usar otro gmail"\n   Datos: ninguno\n\n21. "preferencia_reporte_gmail" - el usuario quiere configurar si sus reportes son unificados o separados por cuenta Gmail\n   Ej: "quiero los reportes separados por cuenta", "unifica mis correos en un solo reporte", "muéstrame por separado cada gmail"\n   Datos: modo ("unificado" o "separado")\n\n22. "cargar_excel" - el usuario quiere cargar gastos historicos desde un archivo Excel o quiere la plantilla\n   Ej: "quiero cargar mis gastos", "como subo mi historial", "tengo un Excel con mis gastos", "plantilla de gastos", "cargar gastos antiguos", "importar gastos"\n   Datos: ninguno\n\nREGLAS CRITICAS:\n- Si el historial muestra que NETO hizo una pregunta y el usuario responde con "si", "no", "dale", "ok", "mas detalle", "eso", "las dos", o cualquier respuesta corta -> usar "desconocido" para que NETO maneje la continuacion\n- Si NETO acaba de notificar "Nuevo gasto" y el usuario dice algo como "el gasto es USD X" o "son dolares" -> usar "corregir_monto_moneda", NO "registrar_manual"\n- Si NETO acaba de registrar un gasto desde una imagen (historial muestra "Registré desde la imagen" o "📸") y el usuario dice la categoría o cómo corregirlo -> usar "corregir_categoria", NO "registrar_manual". Ej: "regístralo en alimentación", "ponlo en comida", "es alimentación porque compré pan", "cambialo a transporte"\n- Si el historial muestra que NETO hablaba de gastos por categoria y el usuario dice "otras categorias" o similar -> usar "desconocido" no "ver_categorias"\n- "otros" como categoria de gasto -> listar_gastos_categoria con categoria="Otros"\n- "cuanto gaste" sin periodo -> ver_total_gastado con periodo="mes"\n- "gastos registrados"/"que tengo" -> listar_gastos_mes\n- mes: enero=1, febrero=2, marzo=3, ..., diciembre=12\n- Si no especifica mes -> usar mes_actual' + histCtx
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
    console.log('[NLP] Intencion:', intencion, '| Datos:', JSON.stringify(datos));

    // Deteccion de comprobante de pago Yape ANTES del switch
    const planActualNlp = usuario.plan || 'free';
    if (planActualNlp !== 'premium') {
      const msgLower = msg.toLowerCase();
      const esPago = (msgLower.includes('pagu') || msgLower.includes('yapee') || msgLower.includes('yape') || msgLower.includes('operacion') || msgLower.includes('comprobante') || msgLower.includes('transfer')) &&
                     (msgLower.includes('pague') || msgLower.includes('yape') || /\d{6,}/.test(msg));
      if (esPago) {
        // Extraer numero de operacion si viene en el mensaje
        const numOp = msg.match(/\d{6,}/);
        const opStr = numOp ? numOp[0] : 'sin numero';
        // Guardar pago pendiente en Supabase
        await supabase.from('usuarios').update({ pago_pendiente: true, pago_referencia: opStr }).eq('id', usuario.id);
        // Notificar al admin
        const ADMIN_WA = process.env.ADMIN_WHATSAPP || '51970398192';
        await enviarWhatsapp(ADMIN_WA,
          '\uD83D\uDCB8 *Pago recibido*\n\n' +
          'Usuario: ' + (usuario.nombre || from) + ' (' + from + ')\n' +
          'Operacion: ' + opStr + '\n' +
          'Monto: S/ 9.90\n\n' +
          '_Usa /activar ' + from.replace(/^whatsapp:/i,'').replace(/^\+/,'') + ' para confirmar._'
        );
        return '\uD83D\uDD0D *Recibimos tu comprobante*\n\n' +
          'Numero de operacion: *' + opStr + '*\n\n' +
          'Estamos verificando tu pago. Te confirmaremos en menos de *1 hora*. \uD83D\uDE0A\n\n' +
          '_Si tienes dudas escribe al +51970398192_';
      }
    }

    switch (intencion) {

      case 'listar_gastos_mes': {
        const fechaMinLgm = getHistoryDateLimit(usuario);
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
            respSep += '📧 *' + c.email + '*: S/ ' + totalC.toFixed(0) + ' (' + txsCuenta.length + ' movs)\n';
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
        const catMesStr = Object.entries(porCatMes).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([c,m]) => (getEmojiCategoria(c)||'') + ' ' + c + ': S/ ' + m.toFixed(0)).join(', ');
        const subMesStr = Object.entries(porCatMes).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([c]) => {
          const subs = Object.entries(porSubMes[c]||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,m])=>s+' S/'+m.toFixed(0)).join(', ');
          return (getEmojiCategoria(c)||'') + c + ': ' + subs;
        }).join(' | ');
        const ctxMes = mE[mes] + ' ' + anio + ': ' + txsMes.length + ' movimientos. Total: S/ ' + totalMesN.toFixed(0) + '. Categorias con emoji: ' + (catMesStr || 'sin datos') + '. Subcategorias: ' + (subMesStr || 'sin datos') + '. Al final de tu respuesta, agrega en una nueva linea: "¿Quieres ver el detalle por subcategorías? 📊"';
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
        const catSemStr = Object.entries(porCatSem).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([c,m]) => (getEmojiCategoria(c)||'') + ' ' + c + ': S/ ' + m.toFixed(0)).join(', ');
        // Comparativa semana anterior
        const hace14 = new Date(); hace14.setDate(hace14.getDate()-14);
        const hace7 = new Date(); hace7.setDate(hace7.getDate()-7);
        const { data: txsAnt } = await supabase.from('transacciones').select('monto,monto_pen').eq('usuario_id', usuario.id).eq('tipo','gasto').gte('fecha', hace14.toISOString().split('T')[0]).lte('fecha', hace7.toISOString().split('T')[0]);
        const totalAnt = (txsAnt||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const diffSem = totalSemN - totalAnt;
        const subSemStr = Object.entries(porCatSem).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c]) => {
          const subs = Object.entries(porSubSem[c]||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,m])=>s+' S/'+m.toFixed(0)).join(', ');
          return (getEmojiCategoria(c)||'') + c + ': ' + subs;
        }).join(' | ');
        const ctxSem = 'Semana: ' + txsSem.length + ' movimientos. Total: S/ ' + totalSemN.toFixed(0) + '. ' +
          (totalAnt > 0 ? 'Semana anterior: S/ ' + totalAnt.toFixed(0) + '. Diferencia: ' + (diffSem >= 0 ? '+' : '') + 'S/ ' + diffSem.toFixed(0) + '. ' : '') +
          'Top categorias con emoji: ' + (catSemStr || 'sin datos') + '. Subcategorias: ' + (subSemStr || 'sin datos') + '. ' +
          'Dia mas caro: ' + (txsSem.length > 0 ? txsSem.reduce((max,t) => parseFloat(t.monto_pen||t.monto||0) > parseFloat(max.monto_pen||max.monto||0) ? t : max, txsSem[0]).fecha : 'sin datos') +
          '. Al final de tu respuesta agrega: "¿Quieres ver el detalle por subcategorías? 📊"';
        const respSem = await redactarConNETO(netoPrompt, ctxSem, msg, historialConv);
        return respSem || formatearResumen(txsSem, 'esta semana');
      }
            case 'listar_gastos_categoria': {
        const fechaMinLgc = getHistoryDateLimit(usuario);
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
            msgCat += '*' + sub + '* — S/ ' + totalSub.toFixed(0) + '\n';
            txsSub.slice(0,4).forEach(t => { msgCat += '  • ' + (t.comercio || t.banco || 'Sin nombre') + ' S/ ' + parseFloat(t.monto_pen || t.monto).toFixed(0) + ' (' + t.fecha + ')\n'; });
          });
        } else {
          txs.slice(0,10).forEach(t => { msgCat += '• ' + (t.comercio || t.banco || 'Sin nombre') + ' — S/ ' + parseFloat(t.monto_pen || t.monto).toFixed(2) + ' (' + t.fecha + ')\n'; });
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
        const ctxVt = (catVt ? 'Categoria ' + catVt + ' en ' : 'Total ') + periodoVt + ': S/ ' + totalVt.toFixed(0) + ' en ' + txsVt.length + ' movimientos.';
        const respVt = await redactarConNETO(netoPrompt, ctxVt, msg, historialConv);
        return respVt || 'Llevas *S/ ' + totalVt.toFixed(0) + '* ' + (catVt ? 'en ' + catVt + ' ' : '') + 'esta ' + periodoVt + ' (' + txsVt.length + ' movimientos).';
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
        const planUsuario2 = usuario.plan || 'free';
        if (planUsuario2 !== 'premium') {
          const resetDate = usuario.reporte_reset_mes;
          const resetMes = resetDate ? parseInt(String(resetDate).slice(5,7)) : null;
          const resetAnio = resetDate ? parseInt(String(resetDate).slice(0,4)) : null;
          const esMesNuevo = !resetDate || resetMes !== mesActual || resetAnio !== anioActual;
          if (esMesNuevo) { await supabase.from('usuarios').update({ reporte_usos_mes: 0, reporte_reset_mes: anioActual + '-' + String(mesActual).padStart(2,'0') + '-01' }).eq('id', usuario.id); usuario.reporte_usos_mes = 0; }
          if ((usuario.reporte_usos_mes || 0) >= 1) return '\uD83D\uDCCA Ya usaste tu *reporte gratuito* de este mes.\n\n\u2B50 *NETO Pro* \u2014 reportes ilimitados + resumen semanal + categorias personalizadas.\n\n*Solo S/10/mes*\n\nEscribe */premium* para activarlo.';
        }
        await enviarWhatsapp(from, 'Generando tu reporte PDF... \u23F3');
        if (planUsuario2 === 'free') { await supabase.from('usuarios').update({ reporte_usos_mes: (usuario.reporte_usos_mes || 0) + 1 }).eq('id', usuario.id); }
        const railwayUrl = process.env.RAILWAY_URL || 'https://neto.pe';
        generarYEnviarReporte(usuario, mesR, anioR).then(async (result) => {
          if (!result.ok) { await enviarWhatsapp(from, result.msg); }
          else { const ttl2 = planUsuario2 === 'premium' ? '24 horas' : '1 hora'; await enviarWhatsapp(from, '\uD83D\uDCCA *Tu dashboard de ' + mE[mesR] + ' ' + anioR + ' esta listo!*\n\n' + result.txCount + ' transacciones analizadas.\n\n\uD83D\uDD17 ' + railwayUrl + '/mi-reporte/' + result.reporteId + '\n\n_Disponible ' + ttl2 + '. Incluye salud financiera, proyecciones y acciones._' + (planUsuario2 === 'free' ? '\n\n_Reporte gratuito del mes usado._' : '')); }
        }).catch(async (e) => { await enviarWhatsapp(from, 'Error: ' + e.message); });
        return null;
      }

      case 'corregir_categoria': {
        try {
          const catRaw = datos.categoria_nueva || datos.categoria || null;
          const comercioRaw = datos.comercio || null;
          if (catRaw) {
            const catLibre = catRaw.charAt(0).toUpperCase() + catRaw.slice(1);
            let txActualizada = null;
            if (comercioRaw) {
              const res = await recategorizarTransaccion(usuario.id, comercioRaw, catLibre);
              if (res.ok) txActualizada = { comercio: comercioRaw, monto: null, moneda: 'PEN' };
              if (!res.ok) return res.msg;
            } else {
              txActualizada = await obtenerUltimaTransaccion(usuario.id);
              if (txActualizada) {
                await supabase.from('transacciones').update({ categoria: catLibre }).eq('id', txActualizada.id);
              } else {
                return '\u00bfDe qu\u00e9 gasto hablamos? D\u00edme el comercio y lo muevo.';
              }
            }
            // Crear categoría en categorias_usuario si es libre (no canónica)
            if (!CATEGORIAS_VALIDAS.has(catLibre) && !CATEGORIA_MAP[catLibre]) {
              crearCategoriaLibreUsuario(usuario.id, catLibre);
            }
            // Guardar regla de aprendizaje y retroaplicar a transacciones pasadas
            const comercioParaRegla = comercioRaw || txActualizada?.comercio;
            if (comercioParaRegla) {
              guardarReglaComercio(usuario.id, comercioParaRegla, catLibre, null);
              retroaplicarRegla(usuario.id, comercioParaRegla, catLibre, null);
            }
            // Respuesta con moneda correcta
            const monedaTxCorr = txActualizada.moneda || 'PEN';
            const montoMostrar = monedaTxCorr === 'USD'
              ? '$' + parseFloat(txActualizada.monto || 0).toFixed(2) + (txActualizada.monto_pen ? ' (~S/' + parseFloat(txActualizada.monto_pen).toFixed(2) + ')' : '')
              : 'S/ ' + parseFloat(txActualizada.monto_pen || txActualizada.monto || 0).toFixed(2);
            return 'Listo! Movi *' + (txActualizada.comercio || 'el gasto') + '* (' + montoMostrar + ') a *' + catLibre + '*.';
          }
          const ultimaTx2 = await obtenerUltimaTransaccion(usuario.id);
          const _ctxCorr = 'El usuario quiere mover un gasto pero no especifico la categoria. Ultimo gasto: ' + (ultimaTx2 ? ultimaTx2.comercio + ' ' + (ultimaTx2.moneda === 'USD' ? '$' : 'S/') + ultimaTx2.monto : 'sin datos') + '. Pregunta a que categoria moverlo. Puede ser una categoria personalizada.';
          const _respCorr = await redactarConNETO(netoPrompt, _ctxCorr, msg, historialConv);
          return _respCorr || '\u00bfA qu\u00e9 categor\u00eda lo muevo? D\u00edme y lo cambio.';
        } catch(e) {
          console.error('[CORREGIR]', e.message);
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
            if (res.ok) {
              guardarReglaComercio(usuario.id, corr.comercio, catLibre, corr.subcategoria_nueva || null);
              retroaplicarRegla(usuario.id, corr.comercio, catLibre, corr.subcategoria_nueva || null);
              const montoStr = res.moneda === 'USD' ? '$' + parseFloat(res.monto).toFixed(2) : 'S/ ' + parseFloat(res.monto).toFixed(2);
              resultados.push('✅ *' + res.comercio + '* (' + montoStr + ') → ' + catLibre);
            } else {
              resultados.push('❌ No encontré gasto de *' + corr.comercio + '*');
            }
          }
          if (resultados.length === 0) return 'No pude aplicar ninguna corrección.';
          return 'Listo! Actualicé ' + resultados.length + ' gastos:\n\n' + resultados.join('\n');
        } catch(e) {
          console.error('[MULT]', e.message);
          return 'No pude procesar las correcciones. Intenta una por una.';
        }
      }

      case 'ver_pendientes': {
        const lpend = await obtenerConsultasPendientes(usuario.id);
        return lpend.length === 0 ? 'No tienes gastos pendientes. Todo al dia! \uD83D\uDC4D' : formatearPendientes(lpend);
      }

      case 'escanear_gmail':
        return (await escanearGmailYRegistrar(usuario)) || 'No encontre correos bancarios nuevos. Te aviso automaticamente cuando llegue uno.';

      case 'agregar_gmail': {
        const cuentasAct = await obtenerCuentasGmail(usuario.id);
        const urlAdd = generarUrlAutorizacion(usuario.whatsapp, 'agregar');
        const listaCuentas = cuentasAct.length > 0
          ? '\n\nActualmente tienes: ' + cuentasAct.map(c => '📧 ' + c.email).join(', ')
          : '';
        return '➕ *Agregar cuenta Gmail adicional*' + listaCuentas + '\n\nHaz clic para conectar:\n' + urlAdd + '\n\n_Una vez conectada, escanearé ambas cuentas automáticamente._';
      }

      case 'cambiar_gmail': {
        const urlChange = generarUrlAutorizacion(usuario.whatsapp, 'reemplazar');
        return '🔄 *Cambiar cuenta Gmail*\n\nHaz clic para reconectar con la cuenta correcta:\n' + urlChange + '\n\n_La cuenta anterior quedará desactivada._';
      }

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
        const planActual2 = usuario.plan || 'free';
        if (planActual2 === 'premium') return '\u2B50 *Ya tienes NETO Pro activo*\n\n\u2705 Reportes PDF ilimitados\n\u2705 Resumen semanal automatico\n\u2705 Categorias personalizadas\n\n_Gracias por tu apoyo!_';
        return '\u2B50 *NETO Pro \u2014 S/10/mes*\n\n\u2705 Reportes PDF ilimitados\n\u2705 Resumen semanal automatico\n\u2705 Categorias personalizadas\n\u2705 Sin restricciones\n\nEscribenos para activarlo:\n+51970398192';
      }

      case 'registrar_manual': {
        try {
          const fechaHoy = new Date().toISOString().split('T')[0];
          const parsed = await parsearRegistroManual(msg, fechaHoy);
          if (!parsed.ok || !parsed.monto || parsed.monto <= 0) {
            return 'No pude extraer el monto. Dime algo como: "gasté S/50 en farmacia" o "mi sueldo fue S/4500".';
          }
          const tx = await guardarTransaccion(usuario.id, parsed);
          const esIngreso = parsed.tipo === 'ingreso';
          const montoStr = parsed.moneda === 'USD' ? '$' + parsed.monto : 'S/' + parseFloat(parsed.monto).toFixed(0);
          let respReg = 'Anotado. ' + montoStr + ' en ' + (esIngreso ? 'Ingresos' : (parsed.categoria || 'Otros') + ' > ' + (parsed.subcategoria || 'sin_categoria')) + ' el ' + parsed.fecha + '.';
          if (!esIngreso && parsed.categoria) {
            const alerta = await verificarAlertaPresupuesto(usuario.id, parsed.categoria, null);
            if (alerta) respReg += '\n\n' + alerta;
          }
          respReg += '\n\n\u00bfHay otro que quieras anotar?';
          return respReg;
        } catch(e) {
          console.error('[REGISTRAR_MANUAL]', e.message);
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
          console.error('[CORREGIR_MONEDA]', e.message);
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
          console.error('[ELIMINAR]', e.message);
          return 'No pude eliminarlo. \u00bfDe cu\u00e1l gasto se trata?';
        }
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
        const configCe = getUserPlanConfig(usuario);
        if (!configCe.excelUpload) {
          return '📄 La carga de gastos históricos es una función *Pro*.\n\nEscribe */premium* para activarla.';
        }
        return '📊 *Carga de gastos e ingresos históricos*\n\n' +
          '1️⃣ Descarga la plantilla: neto.pe/plantilla_gastos.xlsx\n' +
          '2️⃣ Completa tus movimientos (máximo 500)\n' +
          '3️⃣ Envíame el archivo por este chat\n\n' +
          '_Tipo, categoría y método de pago son opcionales — NETO los asigna automáticamente con IA._ 🤖';
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
        const ctxDef = 'El usuario envio un mensaje que no encaja claramente con ninguna intencion: "' + msg + '". Responde en tono NETO: reconoce el mensaje, ofrece ayuda concreta con los gastos o finanzas del usuario.';
        const respDef = await redactarConNETO(netoPrompt, ctxDef, msg, historialConv);
        return respDef || 'No entendi bien, pero estoy aqui. Escribe _"cuanto gaste esta semana"_ o _"dame mi reporte"_ y arrancamos. \u00bfQue necesitas?';
      }
    }
  } catch(e) {
    console.error('[NLP] Error:', e.message);
    return 'Tuve un problema. Intenta de nuevo.';
  }
}

async function enviarWhatsapp(numero, mensaje) {
  try {
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_ACCESS_TOKEN;
    const dest = numero.replace(/^whatsapp:/i, '').replace(/^\+/, '');
    const response = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: dest, type: 'text', text: { body: mensaje } })
    });
    const data = await response.json();
    if (data.messages && data.messages[0]) { console.log('[META] Enviado a', dest, '- ID:', data.messages[0].id); }
    else { console.error('[META] Error enviando:', JSON.stringify(data)); }
  } catch (e) { console.error('[META] Error enviando WhatsApp:', e.message); }
}

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
  msg += '\uD83D\uDCC5 ' + (resultado.fecha || new Date().toISOString().split('T')[0]);
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
    } catch(e) { console.error('[INUSUAL]', e.message); }
  }

  msg += '\n\n_Escr\u00edbeme si quieres ver el detalle del mes._';
  await enviarWhatsapp(usuario.whatsapp, msg);
}


// Obtener la última transacción registrada del usuario (para contexto de respuestas)
async function obtenerUltimaTransaccion(usuarioId) {
  const { data } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId)
    .order('created_at', { ascending: false }).limit(1).single();
  return data || null;
}
async function escaneoAutomatico() {
  console.log('[AUTO] Escaneo -', new Date().toLocaleString('es-PE'));
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resultado = await escanearGmailYRegistrar(usuario);
        if (resultado && resultado.includes('Registre')) { await enviarWhatsapp(usuario.whatsapp, '\uD83D\uDD04 *Escaneo automatico*\n\n' + resultado); }
      } catch (e) { console.error('[AUTO] Error usuario', usuario.whatsapp, ':', e.message); }
    }
  } catch (e) { console.error('[AUTO] Error general:', e.message); }
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
  msg += '\n_Escribe /mes para el detalle o /reporte para tu PDF._';
  return msg;
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
      } catch(e) { console.error('[SEMANAL] Error para', usuario.whatsapp, ':', e.message); }
    }
  } catch(e) { console.error('[SEMANAL] Error general:', e.message); }
}

const PORT = process.env.PORT || 3000;
const INTERVALO_HORAS = parseFloat(process.env.SCAN_INTERVAL_HOURS || '0.25');
const INTERVALO_MS = INTERVALO_HORAS * 60 * 60 * 1000;

app.listen(PORT, () => {
  console.log('NETO v5 en http://localhost:' + PORT);
  setTimeout(() => {
    escaneoAutomatico();
    setInterval(escaneoAutomatico, INTERVALO_MS);
    console.log('[AUTO] Escaneo activo cada', INTERVALO_HORAS, 'hora(s).');
    setInterval(checkResumenSemanal, 15 * 60 * 1000);
    console.log('[SEMANAL] Resumen semanal activo (lunes 8am Lima).');
  }, 30000);
});


// Obtener la última transacción registrada del usuario (para contexto de respuestas)
async function obtenerUltimaTransaccion(usuarioId) {
  const { data } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', usuarioId)
    .order('created_at', { ascending: false }).limit(1).single();
  return data || null;
}