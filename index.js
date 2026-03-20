require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { generarReporteHTML, generarDashboardHTML } = require('./reporte_html');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { generarUrlAutorizacion, guardarTokens, leerCorreosBancarios, oauth2Client, obtenerPerfilGoogle } = require('./gmail');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Ã¢â€â‚¬Ã¢â€â‚¬ Historial de conversacion Ã¢â€â‚¬Ã¢â€â‚¬
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

async function guardarTransaccion(usuarioId, datos) {
  const _moneda = datos.moneda || 'PEN';
  let _montoPen = parseFloat(datos.monto); let _tcUsado = null;
  if (_moneda === 'USD') { try { const _tc = await obtenerTipoCambio(); _tcUsado = _tc.venta; _montoPen = parseFloat((parseFloat(datos.monto) * _tc.venta).toFixed(2)); } catch(e) {} }
  const { data, error } = await supabase.from('transacciones').insert({
    usuario_id: usuarioId, tipo: datos.tipo || 'gasto', monto: parseFloat(datos.monto), moneda: _moneda,
    monto_pen: _montoPen, tipo_cambio: _tcUsado, metodo_pago: datos.metodo_pago || null,
    comercio: datos.comercio, categoria: normalizarCategoria(datos.categoria), banco: datos.banco,
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
Entretenimiento: streaming | cine | juegos | bares_clubs | eventos | hobbies
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
- DLOCAL*NETFLIX / Netflix / Disney+ / HBO / Spotify / YouTube Premium / Apple Music / Apple TV → Entretenimiento > streaming
- Apple.com/bill / Apple iCloud / Google One / Google Drive → Entretenimiento > streaming
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
  const hasta = anio + '-' + String(mes).padStart(2,'0') + '-31';
  const { data: txs } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
  if (!txs || txs.length === 0) return { ok: false, msg: 'No hay transacciones registradas para ese mes.' };
  const { data: presupData } = await supabase.from('presupuestos').select('*').eq('usuario_id', usuario.id).eq('mes', mes).eq('anio', anio);
  const presupuestos = {};
  if (presupData) presupData.forEach(p => { presupuestos[p.categoria] = parseFloat(p.monto_limite); });
  // Obtener historial 3 meses anteriores para grafico de evolucion
  const historial = [];
  for (let i = 3; i >= 1; i--) {
    const d = new Date(anio, mes - 1 - i, 1); const hm = d.getMonth()+1; const ha = d.getFullYear();
    const { data: ht } = await supabase.from('transacciones').select('monto,monto_pen').eq('usuario_id', usuario.id).eq('tipo','gasto').gte('fecha', ha+'-'+String(hm).padStart(2,'0')+'-01').lte('fecha', ha+'-'+String(hm).padStart(2,'0')+'-31');
    const tot = (ht||[]).reduce((s,t) => s+parseFloat(t.monto_pen||t.monto||0), 0);
    if (tot > 0) historial.push({ mes: hm, anio: ha, total: tot });
  }
  const html = generarReporteHTML({ nombre: usuario.nombre || 'Usuario', mes, anio, transacciones: txs, presupuestos, historialMeses: historial });
  const reporteId = String(Date.now());
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // Guardar en Supabase en vez de memoria — sobrevive redeployos
  const { error: cacheErr } = await supabase.from('reporte_cache').upsert({
    id: reporteId, usuario_id: usuario.id, html, expires_at: expiresAt
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
  return tx.comercio && genericos.indexOf(tx.comercio.toLowerCase()) >= 0 && (!tx.categoria || tx.categoria === 'Otro' || tx.categoria === 'Transferencia');
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
  await supabase.from('transacciones').update({ categoria: catFinal, subcategoria: subFinal, comercio: parsed.descripcion||consulta.banco }).eq('id', consulta.transaccion_id);
  await resolverConsulta(consulta.id);
  var resto = pendientes.length > 1 ? '\n\nAun tienes ' + (pendientes.length-1) + ' gasto(s) pendiente(s). Escribe */pendientes*.' : '';
  return 'Listo! Actualice *'+(consulta.banco||'el pago')+'* (S/ '+parseFloat(consulta.monto).toFixed(2)+') a *'+catFinal+'*'+(subFinal?' > '+subFinal:'')+'.'+resto;
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
async function crearCategoriaLibreUsuario(usuarioId, nombre) {
  try {
    const { data: existe } = await supabase.from('categorias_usuario')
      .select('id').eq('usuario_id', usuarioId).eq('nombre', nombre).is('padre_id', null).single();
    if (existe) return;
    await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre, emoji: '\uD83D\uDCC1', activa: true });
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

// Servir archivos estÃƒÂ¡ticos
app.use(express.static(path.join(__dirname, 'public')));

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ RUTAS WEB Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/privacidad', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

app.get('/terminos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminos.html'));
});

app.get('/faq', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'faq.html'));
});
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
    if (message.type !== 'text') return;
    const from = message.from;
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
            else { const mE = ['','Enero','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']; await enviarWhatsapp(from, '\uD83D\uDCC4 *Reporte ' + mE[mesR] + ' ' + anioR + ' listo!*\n\n' + result.txCount + ' transacciones.\nDisponible 30 min:\n' + railwayUrl + '/reporte/' + result.reporteId + (planUsuario === 'free' ? '\n\n_Reporte gratuito del mes usado._' : '')); }
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
      const ahora = new Date();
      const hace3meses = new Date(ahora.getFullYear(), ahora.getMonth() - 2, 1);
      const { data: txsDash } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', hace3meses.toISOString().split('T')[0]).order('fecha', { ascending: true });
      const dashHtml = generarDashboardHTML(usuario, txsDash || []);
      const dashId = crypto.randomUUID();
      const dashExp = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await supabase.from('reporte_cache').insert({ id: dashId, usuario_id: usuario.id, html: dashHtml, expires_at: dashExp });
      const railwayUrl = process.env.RAILWAY_URL || 'https://neto.pe';
      respuesta = '\uD83D\uDCCA *Tu dashboard esta listo!*\n\n' + railwayUrl + '/dashboard/' + dashId + '\n\n_Disponible 24 horas. Actualiza con */dashboard* cuando quieras._';
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

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send('<h2>Error: ' + error + '</h2>');
  if (!code) return res.send('<h2>No se recibio el codigo</h2>');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    let whatsappNum = null;
    if (req.query.state) { try { whatsappNum = Buffer.from(req.query.state, 'base64').toString('utf8'); } catch(e) {} }
    let usuario = null;
    if (whatsappNum) { const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', whatsappNum).single(); usuario = data; }
    if (!usuario) { const { data } = await supabase.from('usuarios').select('*').is('gmail_access_token', null).order('created_at', { ascending: false }).limit(1).single(); usuario = data; }
    if (!usuario) return res.send('<h2>No se encontro el usuario. Escribe /conectar en WhatsApp.</h2>');
    await guardarTokens(usuario.id, tokens);
    const perfil = await obtenerPerfilGoogle(oauth2Client);
    if (perfil.nombre || perfil.email) { await supabase.from('usuarios').update({ nombre: perfil.nombre, email: perfil.email }).eq('id', usuario.id); usuario.nombre = perfil.nombre; }
    const nombre = usuario.nombre ? ', ' + usuario.nombre : '';
    res.send('<html><body style="font-family:Arial;text-align:center;padding:50px;background:#0d1b2a;color:white"><h1 style="color:#4CAF50">Gmail conectado' + nombre + '!</h1><p style="font-size:18px">Vuelve a WhatsApp, el bot te escribira en un momento.</p></body></html>');
    const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : 'por ahi';
    await enviarWhatsapp(usuario.whatsapp, '\u2705 *Gmail conectado, ' + primerNombre + '!*\n\nEscaneando tus correos bancarios... \uD83D\uDD0D');
    setTimeout(async () => {
      try {
        const resultado = await escanearGmailYRegistrar(usuario);
        if (resultado) {
          await enviarWhatsapp(usuario.whatsapp, resultado);
          await new Promise(r => setTimeout(r, 2000));
          await enviarWhatsapp(usuario.whatsapp, '*Paso 2 de 2: Elige tus categorias* \uD83C\uDFF7\uFE0F\n\n' + CATEGORIAS_SUGERIDAS.map((c,i) => (i+1)+'. '+c.emoji+' '+c.nombre).join('\n') + '\n\n_Responde con los numeros (ej: 1 3 5) o escribe "todas"_');
          await supabase.from('usuarios').update({ onboarding_paso: 10 }).eq('id', usuario.id);
        } else {
          await enviarWhatsapp(usuario.whatsapp, '\uD83D\uDCED No encontre correos bancarios recientes.\n\nTe avisare cuando llegue uno.\n\nMientras tanto puedes escribirme:\n_"cuanto gaste esta semana"_');
          await supabase.from('usuarios').update({ onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
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


// Ã¢â€â‚¬Ã¢â€â‚¬ NETO: Redactar respuesta con GPT usando el system prompt de NETO Ã¢â€â‚¬Ã¢â€â‚¬
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
        content: 'Eres el clasificador de intenciones de NETO, bot de finanzas personales por WhatsApp para usuarios peruanos.\nEl mes actual es ' + mE[mesActual] + ' ' + anioActual + '.\n\nAnaliza el mensaje y devuelve SOLO JSON.\n\nINTENCIONES:\n1. "listar_gastos_mes" - ver resumen/lista de gastos del mes\n   Ej: "cuales son mis gastos", "que gaste este mes", "gastos registrados", "que tengo registrado", "mis compras", "transacciones"\n   Datos: mes (numero, default=mes_actual), anio\n\n2. "listar_gastos_semana" - gastos de los ultimos 7 dias\n   Ej: "que gaste esta semana", "gastos recientes", "mis compras de los ultimos dias"\n\n3. "listar_gastos_categoria" - gastos de UNA categoria especifica\n   Ej: "que hay en Otros", "gastos de Alimentación", "que esta en Transporte", "detalle de Hogar", "cuales estan en otros"\n   Datos: categoria (nombre exacto), mes (default=mes_actual)\n\n4. "ver_total_gastado" - saber el TOTAL numerico gastado\n   Ej: "cuanto gaste", "cuanto llevo gastado", "total de gastos"\n   Datos: periodo ("semana" o "mes"), categoria (o null)\n\n5. "ver_presupuesto" - ver estado del presupuesto\n   Ej: "como va mi presupuesto", "cuanto me queda", "mis limites"\n\n6. "configurar_presupuesto" - configurar limite de gasto\n   Ej: "pon limite de 500 en comida", "presupuesto de 300 para transporte"\n   Datos: categoria, monto\n\n7. "ver_categorias" - ver categorias configuradas del sistema\n   Ej: "que categorias hay", "muestra las categorias del sistema"\n   IMPORTANTE: Si el historial muestra que NETO estaba hablando de gastos por categoria, NO usar esta intencion\n\n8. "ver_reporte" - reporte PDF\n   Ej: "dame mi reporte", "informe mensual", "reporte de marzo", "genera pdf"\n   Datos: mes (default=mes_actual), anio\n\n9. "corregir_categoria" - cambiar categoria de un gasto\n   Ej: "netflix es streaming", "cambia uber a transporte", "ponlo en Hogar", "muevelo a Delivery", "este gasto es de Comida", "ponlo en la categoria NETO", "categorizalo en Trabajo", "muevelo a Herramientas"\n   IMPORTANTE: Usar cuando el usuario quiere mover/cambiar/reclasificar un gasto a cualquier categoria (incluso una categoría personalizada no canónica como "NETO", "Mascota", etc). comercio puede ser null.\n   Datos: comercio (null si no se menciona), categoria_nueva (el nombre exacto que dijo el usuario)\n\n10. "ver_pendientes" - gastos sin identificar\n    Ej: "gastos pendientes", "que no identificaste", "gastos sin categoria"\n\n11. "escanear_gmail" - escanear correos\n    Ej: "escanea mi correo", "busca transacciones nuevas", "hay correos nuevos"\n\n12. "ver_premium" - info del plan premium\n    Ej: "cuanto cuesta premium", "que incluye el plan"\n\n13. "saludo" - saludo sin intencion especifica\n    Ej: "buenos dias", "que tal", "como estas"\n\n14. "ayuda" - pide ayuda\n    Ej: "que puedes hacer", "ayuda", "como funciona"\n\n15. "registrar_manual" - el usuario quiere registrar un gasto o ingreso NUEVO\n   Ej: "gaste 50 soles en farmacia", "anota S/120 en ropa", "mi sueldo fue S/4500", "cobré S/800 de honorarios", "registra un ingreso de S/3500", "pague 200 en gasolina ayer"\n   IMPORTANTE: NO usar si el historial muestra que NETO acaba de notificar un gasto existente y el usuario está corrigiendo su moneda o monto (ej: "el gasto es USD 95", "son dolares", "el importe es 25 USD" → usar corregir_monto_moneda).\n   Datos: ninguno (se parsea el mensaje completo)\n\n16. "desconocido" - no encaja con ninguna intencion clara, o es continuacion de conversacion\n    Usar cuando: el mensaje es "si", "no", "dale", "ok", "mas", o cualquier respuesta corta a algo que NETO pregunto\n\n17. "corregir_monto_moneda" - el usuario indica que la moneda o monto de un gasto YA REGISTRADO está incorrecto\n   Ej: "el gasto es en dolares", "es en USD no en soles", "corrígelo son $25", "el monto es USD 25", "son 25 dolares", "el importe es en dolares", "eso es en USD", "el gasto es USD 95.07", "cambiale la moneda a dolares", "es dolar no sol"\n   IMPORTANTE: Solo cuando el historial muestra que se habla de un gasto existente ya notificado por NETO.\n   Datos: monto (numero o null), moneda ("USD" o "PEN" o null)\n\nREGLAS CRITICAS:\n- Si el historial muestra que NETO hizo una pregunta y el usuario responde con "si", "no", "dale", "ok", "mas detalle", "eso", "las dos", o cualquier respuesta corta -> usar "desconocido" para que NETO maneje la continuacion\n- Si NETO acaba de notificar "Nuevo gasto" y el usuario dice algo como "el gasto es USD X" o "son dolares" -> usar "corregir_monto_moneda", NO "registrar_manual"\n- Si el historial muestra que NETO hablaba de gastos por categoria y el usuario dice "otras categorias" o similar -> usar "desconocido" no "ver_categorias"\n- "otros" como categoria de gasto -> listar_gastos_categoria con categoria="Otros"\n- "cuanto gaste" sin periodo -> ver_total_gastado con periodo="mes"\n- "gastos registrados"/"que tengo" -> listar_gastos_mes\n- mes: enero=1, febrero=2, marzo=3, ..., diciembre=12\n- Si no especifica mes -> usar mes_actual' + histCtx
      }, {
        role: 'user',
        content: msg
      }],
      temperature: 0
    });

    const rawClasif = clasificacion.choices[0].message.content.trim();
    const clean = rawClasif.startsWith('{') ? rawClasif : rawClasif.slice(rawClasif.indexOf('{'), rawClasif.lastIndexOf('}')+1);
    const _nlp = JSON.parse(clean); const intencion = _nlp.intencion; const datos = _nlp.datos || _nlp.data || {};
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
        const mes = datos.mes || mesActual;
        const anio = datos.anio || anioActual;
        let txsMes;
        if (mes === mesActual && anio === anioActual) {
          txsMes = await obtenerGastosMes(usuario.id);
        } else {
          const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
          const hasta = anio + '-' + String(mes).padStart(2,'0') + '-31';
          const { data } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
          txsMes = data || [];
        }
        const totalMesN = txsMes.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const porCatMes = {};
        txsMes.forEach(t => { const cat = t.categoria || 'Otros'; porCatMes[cat] = (porCatMes[cat]||0) + parseFloat(t.monto_pen || t.monto || 0); });
        const catMesStr = Object.entries(porCatMes).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([c,m]) => c + ': S/ ' + m.toFixed(0)).join(', ');
        const ctxMes = mE[mes] + ' ' + anio + ': ' + txsMes.length + ' movimientos. Total: S/ ' + totalMesN.toFixed(0) + '. Categorias: ' + (catMesStr || 'sin datos');
        const respMes = await redactarConNETO(netoPrompt, ctxMes, msg, historialConv);
        return respMes || formatearResumen(txsMes, 'en ' + mE[mes]);
      }

      case 'listar_gastos_semana': {
        const txsSem = await obtenerGastosSemana(usuario.id);
        const totalSemN = txsSem.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const porCatSem = {};
        txsSem.forEach(t => { const cat = t.categoria || 'Otros'; porCatSem[cat] = (porCatSem[cat]||0) + parseFloat(t.monto_pen || t.monto || 0); });
        const catSemStr = Object.entries(porCatSem).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([c,m]) => c + ': S/ ' + m.toFixed(0)).join(', ');
        // Comparativa semana anterior
        const hace14 = new Date(); hace14.setDate(hace14.getDate()-14);
        const hace7 = new Date(); hace7.setDate(hace7.getDate()-7);
        const { data: txsAnt } = await supabase.from('transacciones').select('monto,monto_pen').eq('usuario_id', usuario.id).eq('tipo','gasto').gte('fecha', hace14.toISOString().split('T')[0]).lte('fecha', hace7.toISOString().split('T')[0]);
        const totalAnt = (txsAnt||[]).reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const diffSem = totalSemN - totalAnt;
        const ctxSem = 'Semana: ' + txsSem.length + ' movimientos. Total: S/ ' + totalSemN.toFixed(0) + '. ' +
          (totalAnt > 0 ? 'Semana anterior: S/ ' + totalAnt.toFixed(0) + '. Diferencia: ' + (diffSem >= 0 ? '+' : '') + 'S/ ' + diffSem.toFixed(0) + '. ' : '') +
          'Top categorias: ' + (catSemStr || 'sin datos') + '. ' +
          'Dia mas caro: ' + (txsSem.length > 0 ? txsSem.reduce((max,t) => parseFloat(t.monto_pen||t.monto||0) > parseFloat(max.monto_pen||max.monto||0) ? t : max, txsSem[0]).fecha : 'sin datos');
        const respSem = await redactarConNETO(netoPrompt, ctxSem, msg, historialConv);
        return respSem || formatearResumen(txsSem, 'esta semana');
      }
            case 'listar_gastos_categoria': {
        const cat = datos.categoria;
        if (!cat) return 'Dime la categoria. Ej: _"gastos de Alimentación"_, _"que hay en Transporte"_';
        const mes = datos.mes || mesActual;
        const anio = datos.anio || anioActual;
        const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
        const hasta = anio + '-' + String(mes).padStart(2,'0') + '-31';
        const { data: txs } = await supabase.from('transacciones').select('*')
          .eq('usuario_id', usuario.id).ilike('categoria', '%' + cat + '%')
          .gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
        if (!txs || txs.length === 0) return 'No encontre gastos en *' + cat + '* para ' + mE[mes] + ' ' + anio + '.';
        const total = txs.reduce((s,t) => s + parseFloat(t.monto), 0);
        let msgCat = '*Gastos en ' + cat + '* (' + mE[mes] + ' ' + anio + ')\n---------------\nTotal: *S/ ' + total.toFixed(2) + '*\n' + txs.length + ' transacciones\n\n';
        txs.slice(0,10).forEach(t => { msgCat += '\u2022 ' + (t.comercio || t.banco || 'Sin nombre') + ' \u2014 S/ ' + parseFloat(t.monto).toFixed(2) + ' (' + t.fecha + ')\n'; });
        if (txs.length > 10) msgCat += '_...y ' + (txs.length-10) + ' mas_';
        return msgCat;
      }

      case 'ver_total_gastado': {
        const periodoVt = datos.periodo || 'mes';
        const catVt = datos.categoria;
        let txsVt = periodoVt === 'semana' ? await obtenerGastosSemana(usuario.id) : await obtenerGastosMes(usuario.id);
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
          await guardarPresupuesto(usuario.id, datos.categoria, datos.monto);
          await supabase.from('presupuestos').update({ alerta_porcentaje: 80 }).eq('usuario_id', usuario.id).eq('categoria', datos.categoria);
          return '\u2705 Presupuesto configurado:\n*' + datos.categoria + ':* S/ ' + parseFloat(datos.monto).toFixed(2) + '/mes\nTe aviso cuando llegues al 80%.';
        }
        return 'Dime la categoria y el monto.\nEj: _"limite de 500 soles en Comida"_';
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
          else { await enviarWhatsapp(from, '\uD83D\uDCC4 *Reporte ' + mE[mesR] + ' ' + anioR + ' listo!*\n\n' + result.txCount + ' transacciones.\nDisponible 30 min:\n' + railwayUrl + '/reporte/' + result.reporteId + (planUsuario2 === 'free' ? '\n\n_Reporte gratuito del mes usado._' : '')); }
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
      case 'ver_pendientes': {
        const lpend = await obtenerConsultasPendientes(usuario.id);
        return lpend.length === 0 ? 'No tienes gastos pendientes. Todo al dia! \uD83D\uDC4D' : formatearPendientes(lpend);
      }

      case 'escanear_gmail':
        return (await escanearGmailYRegistrar(usuario)) || 'No encontre correos bancarios nuevos. Te aviso automaticamente cuando llegue uno.';

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