require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { generarReportePDF } = require('./reporte_pdf');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { generarUrlAutorizacion, guardarTokens, leerCorreosBancarios, oauth2Client, obtenerPerfilGoogle } = require('./gmail');

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
    if (pctCat>=100) alertas.push('ÃƒÂ°Ã…Â¸Ã…Â¡Ã‚Â¨ Limite de *'+categoria+'* superado: S/ '+totalCat.toFixed(2)+' / S/ '+limiteCat.toFixed(2));
    else if (pctCat>=(presCat.alerta_porcentaje||80)) alertas.push('ÃƒÂ¢Ã…Â¡Ã‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â *'+categoria+'*: llevas S/ '+totalCat.toFixed(2)+' de S/ '+limiteCat.toFixed(2)+' ('+pctCat.toFixed(0)+'%)');
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
      if (pctSub>=100) alertas.push('ÃƒÂ°Ã…Â¸Ã…Â¡Ã‚Â¨ Limite de *'+subcategoria+'* superado: S/ '+totalSub.toFixed(2)+' / S/ '+limiteSub.toFixed(2));
      else if (pctSub>=(presSub.alerta_porcentaje||80)) alertas.push('ÃƒÂ¢Ã…Â¡Ã‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â *'+subcategoria+'*: llevas S/ '+totalSub.toFixed(2)+' de S/ '+limiteSub.toFixed(2)+' ('+pctSub.toFixed(0)+'%)');
    }
  }
  return alertas.length > 0 ? alertas.join('\n') : null;
}

async function parsearCorreoBancario(texto, contexto) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Eres un parser de notificaciones bancarias peruanas. Devuelve SOLO JSON sin markdown: { "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"nombre del comercio", "categoria":"Comida|Auto|Transporte|Hogar|Entretenimiento|Streaming|Salud|Educacion|Compras|Viajes|Otros", "banco":"BCP|Interbank|BBVA|Scotiabank|Yape|Plin|Otro", "fecha":"YYYY-MM-DD", "descripcion_original":"texto original" }. Normaliza: SPSA=Plaza Vea, DLOCAL*NETFLIX=Netflix, PRIMAX=Grifo.' },
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
      resumen += '- ' + (resultado.tipo === 'ingreso' ? 'Ingreso' : 'Gasto') + ': ' + (resultado.comercio || resultado.banco || 'Sin nombre') + ' S/ ' + resultado.monto + (msg.esReenviado ? ' (reenviado)' : '') + '\n';
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
  return '*FinBot escaneo tu Gmail*\n\nRegistre *' + registradas + '* transaccion(es):\n' + resumen + '\nEscribe */mes* para ver tu resumen.';
}

async function generarYEnviarReporte(usuario, mes, anio) {
  const desde = anio + '-' + String(mes).padStart(2,'0') + '-01';
  const hasta = anio + '-' + String(mes).padStart(2,'0') + '-31';
  const { data: txs } = await supabase.from('transacciones').select('*').eq('usuario_id', usuario.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
  if (!txs || txs.length === 0) return { ok: false, msg: 'No hay transacciones registradas para ese mes.' };
  const { data: presupData } = await supabase.from('presupuestos').select('*').eq('usuario_id', usuario.id).eq('mes', mes).eq('anio', anio);
  const presupuestos = {};
  if (presupData) presupData.forEach(p => { presupuestos[p.categoria] = parseFloat(p.monto_limite); });
  const tmpPath = path.join(os.tmpdir(), 'finbot_reporte_' + usuario.id + '_' + mes + '_' + anio + '.pdf');
  await generarReportePDF({ nombre: usuario.nombre || 'Usuario', mes, anio, transacciones: txs, presupuestos }, tmpPath);
  const pdfBuffer = fs.readFileSync(tmpPath);
  const reporteId = Date.now();
  global.reportesTemp = global.reportesTemp || {};
  global.reportesTemp[reporteId] = { buffer: pdfBuffer, expires: Date.now() + 30 * 60 * 1000 };
  return { ok: true, reporteId, txCount: txs.length, tmpPath };
}

const CATEGORIAS = ['Supermercados','Restaurantes','Transporte','Streaming','Educacion','Salud','Transferencia','Entretenimiento','Servicios','Farmacia','Otro'];

async function interpretarCorreccion(texto) {
  const res = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Interpreta correcciones de categoria de gastos. SOLO JSON: {"comercio":"nombre o null","categoria_nueva":"Supermercados|Restaurantes|Transporte|Streaming|Educacion|Salud|Transferencia|Entretenimiento|Servicios|Farmacia|Otro","es_correccion":true/false}' }, { role: 'user', content: texto }], temperature: 0 });
  const raw = res.choices[0].message.content.trim();
  return JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
}

async function recategorizarTransaccion(usuarioId, comercio, categoriaNueva) {
  const { data: txs } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId).ilike('comercio', '%' + comercio + '%').order('created_at', { ascending: false }).limit(5);
  if (!txs || txs.length === 0) return { ok: false, msg: 'No encontre ninguna transaccion de *' + comercio + '*.' };
  const tx = txs[0];
  const { error } = await supabase.from('transacciones').update({ categoria: categoriaNueva }).eq('id', tx.id);
  if (error) return { ok: false, msg: 'Error actualizando: ' + error.message };
  return { ok: true, msg: 'Listo! Cambie la categoria de *' + (tx.comercio || comercio) + '* (S/ ' + tx.monto + ') de *' + (tx.categoria || 'Sin categoria') + '* a *' + categoriaNueva + '*.' };
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
  return '? *Gasto sin identificar*\n\nRegistre un *' + banco + '* de *S/ ' + monto + '* (' + fecha + ') pero no tengo info del destinatario.\n\n*Para que fue este gasto?*\nResponde por ejemplo:\n_"Compre almuerzo"_ -> Comida\n_"Le pague al casero"_ -> Hogar\n\nO usa: */cambiar ' + banco + ' [categoria]*';
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
    var aiRes = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Gastos pendientes: '+ctx+'. Usuario respondio: "'+texto+'". SOLO JSON: {"resuelve":true/false,"numero":1/2/null,"categoria":"Comida|Auto|Transporte|Hogar|Entretenimiento|Streaming|Salud|Educacion|Compras|Viajes|Otros","descripcion":"descripcion corta"}' }], temperature: 0 });
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

// =================================================================
// CATEGORIAS Y SUBCATEGORIAS
// =================================================================
const CATEGORIAS_SUGERIDAS = [
  { nombre: 'Comida', emoji: 'ÃƒÂ°Ã…Â¸Ã‚ÂÃ‚Â½ÃƒÂ¯Ã‚Â¸Ã‚Â', subs: ['Almuerzo','Cena','Desayuno','Snacks','Ingredientes','Restaurante','Compartir'] },
  { nombre: 'Auto', emoji: 'ÃƒÂ°Ã…Â¸Ã…Â¡Ã¢â‚¬â€', subs: ['Gasolina','Peaje','Estacionamiento','Mantenimiento','Seguro','Impuesto vehicular','Lavado','Accesorios'] },
  { nombre: 'Transporte', emoji: 'ÃƒÂ°Ã…Â¸Ã…Â¡Ã…â€™', subs: ['Taxi','Metro','Bus'] },
  { nombre: 'Hogar', emoji: 'ÃƒÂ°Ã…Â¸Ã‚ÂÃ‚Â ', subs: ['Alquiler','Supermercado','Servicios','Internet','Celular','Limpieza','ArtÃƒÆ’Ã‚Â­culos de hogar'] },
  { nombre: 'Entretenimiento', emoji: 'ÃƒÂ°Ã…Â¸Ã…Â½Ã¢â‚¬Â°', subs: ['Baile','Cine','Teatro','Conciertos','FÃƒÆ’Ã‚Âºtbol','Salidas/Tragos'] },
  { nombre: 'Streaming', emoji: 'ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Âº', subs: ['Netflix','Disney+','Amazon Prime','YouTube Premium','Apple Music','Google Storage','Apple Cloud'] },
  { nombre: 'Salud', emoji: 'ÃƒÂ°Ã…Â¸Ã¢â‚¬â„¢Ã…Â ', subs: ['Hospital','Medicina','Farmacia','PsicÃƒÆ’Ã‚Â³logo','Seguro','Gimnasio','Higiene','BarberÃƒÆ’Ã‚Â­a'] },
  { nombre: 'EducaciÃƒÆ’Ã‚Â³n', emoji: 'ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã…Â¡', subs: ['Cursos','Libros','Certificaciones'] },
  { nombre: 'Compras', emoji: 'ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂºÃ‚ÂÃƒÂ¯Ã‚Â¸Ã‚Â', subs: ['Ropa','Accesorios','Regalos','TecnologÃƒÆ’Ã‚Â­a'] },
  { nombre: 'Viajes', emoji: 'ÃƒÂ¢Ã…â€œÃ‹â€ ÃƒÂ¯Ã‚Â¸Ã‚Â', subs: ['Vuelo','Hospedaje','Comida','Movilidad','Turismo','Tragos'] },
  { nombre: 'Otros', emoji: 'ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â¦', subs: [] }
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
// =================================================================

// GET /webhook - verificacion Meta
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

    const usuario = await obtenerOCrearUsuario(from);

    const cmd = msg.toLowerCase().trim();

    // == Interceptor: seleccion de categorias ==
    if (usuario.onboarding_paso === 10 && !cmd.startsWith('/')) {
      var idxResp = parsearIndicesRespuesta(msg, CATEGORIAS_SUGERIDAS.length);
      if (idxResp.length > 0) {
        await crearCategoriasDesdeIndices(usuario.id, idxResp);
        await supabase.from('usuarios').update({ onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
        var nombresAct = idxResp.map(function(i){ return CATEGORIAS_SUGERIDAS[i-1].emoji+' '+CATEGORIAS_SUGERIDAS[i-1].nombre; }).join(', ');
        var rspCat = 'Listo! Active tus categorias:\n' + nombresAct + '\n\nCada una ya tiene subcategorias sugeridas activadas.\nUsa */categorias* para verlas o editarlas. ÃƒÂ°Ã…Â¸Ã…Â½Ã¢â‚¬Â°';
        await enviarWhatsapp(from, rspCat); return;
      }
    }

    // == Interceptor: respuestas a consultas pendientes ==
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
    if (esUsuarioNuevo && cmd !== 'hola' && cmd !== 'hi' && cmd !== 'inicio' && !cmd.startsWith('/') && msg.length < 30) {
      respuesta = 'Bienvenido a *FinBot Peru*!\n\nEscribe *hola* para empezar o */conectar* para vincular tu Gmail.';
    } else if (cmd === 'hola' || cmd === 'hi' || cmd === 'inicio') {
      var tieneGmail = !!usuario.gmail_access_token;
      var primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : null;
      if (!tieneGmail) {
        var urlOAuth = generarUrlAutorizacion(from);
        respuesta = '*Hola' + (primerNombre ? ', ' + primerNombre : '') + '! Bienvenido a FinBot Peru*\n\nSoy tu asistente de finanzas personales.\n\n*Bancos:* BCP, Interbank, BBVA, Scotiabank, Yape, Plin\n\nConecta tu Gmail:\n\n' + urlOAuth + '\n\n_Solo leemos notificaciones bancarias. 100% seguro._';
      } else {
        var gastosMesHola = await obtenerGastosMes(usuario.id);
        var totalMesHola = gastosMesHola.reduce(function(s,t){return s+parseFloat(t.monto);},0);
        var pendHola = await obtenerConsultasPendientes(usuario.id);
        var alertaPend = pendHola.length > 0 ? '\n\n? *' + pendHola.length + ' gasto(s) sin identificar.* Escribe */pendientes*.' : '';
        var catsHola = await obtenerCategoriasUsuario(usuario.id);
        var tipCats = (!usuario.onboarding_completado && !catsHola) ? '\n\nÃƒÂ°Ã…Â¸Ã¢â‚¬â„¢Ã‚Â¡ Escribe */categorias* para personalizar tus categorias.' : '';
        var saludo = primerNombre ? 'Hola, ' + primerNombre + '!' : 'Hola!';
        respuesta = '*' + saludo + ' Soy FinBot Peru*\n\nGmail: Conectado\n' +
          (gastosMesHola.length > 0 ? '*Este mes:* S/ ' + totalMesHola.toFixed(2) + ' en ' + gastosMesHola.length + ' transacciones' : 'Sin transacciones este mes.') +
          alertaPend + tipCats +
          '\n\n*/semana* -- gastos 7 dias\n*/mes* -- gastos del mes\n*/presupuesto* -- presupuesto\n*/categorias* -- mis categorias\n*/reporte* -- PDF del mes\n*/pendientes* -- gastos sin identificar\n*/ayuda* -- todos los comandos';
      }
    } else if (cmd === '/conectar') {
      respuesta = '*Conectar Gmail a FinBot*\n\nAbre este enlace:\n\n' + generarUrlAutorizacion(from) + '\n\n_Solo leeremos correos bancarios. Proceso seguro._';
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
      respuesta = formatearResumen(gastos, 'esta semana') + (top3 ? '\nÃƒÂ°Ã…Â¸Ã‚ÂÃ¢â‚¬Â  *Top:* ' + top3 : '');
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
        const catNormalizada = CATEGORIAS.find(c => c.toLowerCase() === categoriaInput.toLowerCase());
        if (!catNormalizada) { respuesta = 'Categoria no valida. Usa: ' + CATEGORIAS.join(' | '); }
        else { const resultado = await recategorizarTransaccion(usuario.id, comercioInput, catNormalizada); respuesta = resultado.msg; }
      } else { respuesta = 'Formato: /cambiar [comercio] [categoria]'; }
    } else if (cmd === '/reporte' || cmd.startsWith('/reporte ')) {
      const ahoraR = new Date(), partesR = cmd.split(' ');
      const mesR = partesR[1] ? parseInt(partesR[1]) : (ahoraR.getMonth() + 1);
      const anioR = partesR[2] ? parseInt(partesR[2]) : ahoraR.getFullYear();
      if (mesR < 1 || mesR > 12 || isNaN(mesR)) { respuesta = 'Formato: /reporte [mes] [anio]\nEj: /reporte 3 2026'; }
      else {
        // FREEMIUM
        const planUsuario = usuario.plan || 'free';
        const mesActualNum = ahoraR.getMonth() + 1;
        const anioActualNum = ahoraR.getFullYear();
        let puedeGenerarReporte = false;
        if (planUsuario === 'premium') {
          puedeGenerarReporte = true;
        } else {
          const resetDate = usuario.reporte_reset_mes;
          const resetMes = resetDate ? parseInt(String(resetDate).slice(5,7)) : null;
          const resetAnio = resetDate ? parseInt(String(resetDate).slice(0,4)) : null;
          const esMesNuevo = !resetDate || resetMes !== mesActualNum || resetAnio !== anioActualNum;
          if (esMesNuevo) {
            await supabase.from('usuarios').update({ reporte_usos_mes: 0, reporte_reset_mes: anioActualNum + '-' + String(mesActualNum).padStart(2,'0') + '-01' }).eq('id', usuario.id);
            usuario.reporte_usos_mes = 0;
          }
          const usosActuales = usuario.reporte_usos_mes || 0;
          if (usosActuales < 1) {
            puedeGenerarReporte = true;
          } else {
            respuesta = 'Ya usaste tu reporte gratuito de este mes.\n\nFinBot Premium te da reportes ilimitados + resumen semanal automatico + categorias personalizadas.\n\nSolo S/ 9.90/mes\n\nEscribe /premium para activarlo.';
          }
        }
        if (puedeGenerarReporte) {
          await enviarWhatsapp(from, 'Generando tu reporte PDF... un momento.');
          if (planUsuario === 'free') {
            await supabase.from('usuarios').update({ reporte_usos_mes: (usuario.reporte_usos_mes || 0) + 1 }).eq('id', usuario.id);
          }
          const railwayUrl = process.env.RAILWAY_URL || 'https://finbot-production-c662.up.railway.app';
          generarYEnviarReporte(usuario, mesR, anioR).then(async (result) => {
            if (!result.ok) { await enviarWhatsapp(from, result.msg); }
            else { const mE = ['','Enero','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']; await enviarWhatsapp(from, 'Reporte ' + mE[mesR] + ' ' + anioR + ' listo!' + '\n\n' + result.txCount + ' transacciones.\nDisponible 30 min:\n' + railwayUrl + '/reporte/' + result.reporteId + (planUsuario === 'free' ? '\n\n_Reporte gratuito del mes usado._' : '')); }
          }).catch(async (e) => { await enviarWhatsapp(from, 'Error generando reporte: ' + e.message); });
          return;
        }
      }
    } else if (cmd === '/categorias' || cmd === '/categorias agregar') {
      var catsCmd = await obtenerCategoriasUsuario(usuario.id);
      if (cmd === '/categorias agregar' || !catsCmd) {
        var menuCatsStr = CATEGORIAS_SUGERIDAS.map(function(c,i){ return (i+1)+'. '+c.emoji+' '+c.nombre; }).join('\n');
        respuesta = '*Personaliza tus categorias*\n\nResponde con los numeros que usas:\n\n' + menuCatsStr + '\n\n_Ej: 1 3 5 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â o escribe "todas"_';
        await supabase.from('usuarios').update({ onboarding_paso: 10 }).eq('id', usuario.id);
      } else { respuesta = formatearCategoriasMsg(catsCmd); }
    } else if (cmd === '/pendientes') {
      var lpend = await obtenerConsultasPendientes(usuario.id);
      respuesta = lpend.length === 0 ? 'No tienes gastos pendientes de identificar.' : formatearPendientes(lpend);
    } else if (cmd === '/ayuda') {
      const mesActual = new Date().getMonth() + 1;
      respuesta = '*Comandos FinBot Peru:*\n*/semana* o */resumen* -- gastos 7 dias\n*/mes* -- gastos del mes\n*/presupuesto* -- ver/configurar presupuesto\n*/categorias* -- ver y editar categorias\n*/conectar* -- vincular Gmail\n*/escanear* -- leer correos ahora\n*/cambiar [comercio] [categoria]* -- corregir categoria\n*/reporte* -- PDF del mes actual\n*/reporte ' + mesActual + '* -- PDF de un mes especifico\n*/pendientes* -- gastos sin identificar\n*hola* -- estado general';
    } else if (msg.length > 30) {
      let esCorreccion = false;
      var keysPres = ['presupuesto','limite','budget','alerta','no gastar'];
      if (keysPres.some(function(p){return msg.toLowerCase().includes(p);})) {
        try {
          var interpPres = await interpretarComandoPresupuesto(msg);
          if (interpPres.es_presupuesto && interpPres.categoria && interpPres.monto) {
            esCorreccion = true;
            var alertaPct = interpPres.alerta_porcentaje || 80;
            await guardarPresupuesto(usuario.id, interpPres.categoria, interpPres.monto);
            await supabase.from('presupuestos').update({ alerta_porcentaje: alertaPct }).eq('usuario_id', usuario.id).eq('categoria', interpPres.categoria);
            respuesta = 'Listo! Configure el presupuesto de *' + interpPres.categoria + '*:\nLimite: *S/ ' + interpPres.monto.toFixed(2) + '/mes*\nAlerta al: *' + alertaPct + '%*';
          }
        } catch(e) { console.error('Error presupuesto NL:', e.message); }
      }
      const palabrasCorreccion = ['era', 'fue', 'es', 'cambiar', 'cambia', 'categoria', 'no es', 'no era', 'corregir', 'corrige'];
      if (!esCorreccion && palabrasCorreccion.some(p => msg.toLowerCase().includes(p))) {
        try {
          const interp = await interpretarCorreccion(msg);
          if (interp.es_correccion && interp.comercio && interp.categoria_nueva) { esCorreccion = true; const resultado = await recategorizarTransaccion(usuario.id, interp.comercio, interp.categoria_nueva); respuesta = resultado.msg; }
        } catch(e) { console.error('Error correccion:', e.message); }
      }
      if (!esCorreccion) {
        const resultado = await parsearCorreoBancario(msg);
        const tx = await guardarTransaccion(usuario.id, resultado);
        respuesta = '*Transaccion registrada*\nTipo: ' + resultado.tipo + '\nMonto: S/ ' + resultado.monto + '\nComercio: ' + (resultado.comercio || 'No detectado') + '\nCategoria: ' + (resultado.categoria || 'No detectado') + '\nBanco: ' + (resultado.banco || 'No detectado');
        if (resultado.tipo === 'gasto' && resultado.categoria) { const alerta = await verificarAlertaPresupuesto(usuario.id, resultado.categoria, null); if (alerta) respuesta += '\n\n' + alerta; }
        respuesta += '\n\n_Escribe /mes o /presupuesto_';
      }
    } else {
      respuesta = 'No entendi ese mensaje. Escribe *hola* para ver los comandos.';
    }
  } catch (error) { console.error('ERROR:', error.message); respuesta = 'Error: ' + error.message; }
  await enviarWhatsapp(from, respuesta);
});

app.get('/reporte/:id', (req, res) => {
  const id = req.params.id;
  global.reportesTemp = global.reportesTemp || {};
  const entry = global.reportesTemp[id];
  if (!entry) return res.status(404).send('Reporte no encontrado o expirado.');
  if (Date.now() > entry.expires) { delete global.reportesTemp[id]; return res.status(404).send('El link del reporte expiro.'); }
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="finbot_reporte.pdf"');
  res.send(entry.buffer);
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
    res.send('<html><body style="font-family:Arial;text-align:center;padding:50px;background:#0d1b2a;color:white"><h1 style="color:#4CAF50">Gmail conectado' + nombre + '!</h1><p style="font-size:18px">Vuelve a WhatsApp y escribe <strong>/escanear</strong> para leer tus correos bancarios.</p></body></html>');
  } catch (err) { res.send('<h2>Error: ' + err.message + '</h2>'); }
});

app.post('/test-parser', async (req, res) => {
  const { correo } = req.body;
  if (!correo) return res.status(400).json({ error: 'Falta correo' });
  try { const r = await parsearCorreoBancario(correo); res.json({ ok: true, resultado: r }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (req, res) => res.send('FinBot Peru v4'));

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

async function escaneoAutomatico() {
  console.log('[AUTO] Escaneo -', new Date().toLocaleString('es-PE'));
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const resultado = await escanearGmailYRegistrar(usuario);
        if (resultado && resultado.includes('Registre')) { await enviarWhatsapp(usuario.whatsapp, 'ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ¢â‚¬Å¾ *Escaneo automatico*\n\n' + resultado); }
      } catch (e) { console.error('[AUTO] Error usuario', usuario.whatsapp, ':', e.message); }
    }
  } catch (e) { console.error('[AUTO] Error general:', e.message); }
}

async function checkResumenSemanal() {
  const horaLima = new Date(Date.now() - 5 * 60 * 60 * 1000);
  if (horaLima.getUTCDay() !== 1 || horaLima.getUTCHours() !== 8 || horaLima.getUTCMinutes() > 14) return;
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('*').not('gmail_access_token', 'is', null);
    if (!usuarios || usuarios.length === 0) return;
    for (const usuario of usuarios) {
      try {
        const gastos = await obtenerGastosSemana(usuario.id); if (!gastos.length) continue;
        const porCat = {}; gastos.forEach(function(t){ var c=t.categoria||'Otro'; porCat[c]=(porCat[c]||0)+parseFloat(t.monto); });
        const top3 = Object.entries(porCat).sort(function(a,b){return b[1]-a[1];}).slice(0,3).map(function(x){return x[0]+': S/ '+x[1].toFixed(2);}).join(' | ');
        const fechaDesde = new Date(Date.now()-7*24*60*60*1000).toLocaleDateString('es-PE',{day:'numeric',month:'short'});
        await enviarWhatsapp(usuario.whatsapp, '*[FinBot] Resumen semanal*\n_Semana del ' + fechaDesde + ' al ' + new Date().toLocaleDateString('es-PE',{day:'numeric',month:'short'}) + '_\n\n' + formatearResumen(gastos,'esta semana') + '\n*Top:* ' + top3 + '\n\n_Escribe /mes para el detalle._');
      } catch(e) { console.error('[SEMANAL] Error para', usuario.whatsapp, ':', e.message); }
    }
  } catch(e) { console.error('[SEMANAL] Error general:', e.message); }
}

const PORT = process.env.PORT || 3000;
const INTERVALO_HORAS = parseFloat(process.env.SCAN_INTERVAL_HOURS || '0.25');
const INTERVALO_MS = INTERVALO_HORAS * 60 * 60 * 1000;

app.listen(PORT, () => {
  console.log('FinBot Peru v4 en http://localhost:' + PORT);
  setTimeout(() => {
    escaneoAutomatico();
    setInterval(escaneoAutomatico, INTERVALO_MS);
    console.log('[AUTO] Escaneo activo cada', INTERVALO_HORAS, 'hora(s).');
    setInterval(checkResumenSemanal, 15 * 60 * 1000);
    console.log('[SEMANAL] Resumen semanal activo (lunes 8am Lima).');
  }, 30000);
});