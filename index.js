require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { generarReporteHTML } = require('./reporte_html');
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
    await supabase.from('conversaciones').insert({ usuario_id: usuarioId, rol: rol, mensaje: mensaje.substring(0, 500) });
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
  try {
    const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', numeroWhatsapp).single();
    if (data) return data;
  } catch (e) {}
  const { data: nuevo, error } = await supabase.from('usuarios').insert({ whatsapp: numeroWhatsapp }).select().single();
  if (error) throw new Error('Error creando usuario: ' + error.message);
  return nuevo;
}
async function guardarTransaccion(usuarioId, datos) {
  const _moneda = datos.moneda || 'PEN';
  let _montoPen = parseFloat(datos.monto); let _tcUsado = null;
  if (_moneda === 'USD') { try { const _tc = await obtenerTipoCambio(); _tcUsado = _tc.venta; _montoPen = parseFloat((parseFloat(datos.monto) * _tc.venta).toFixed(2)); } catch(e) {} }
  const { data, error } = await supabase.from('transacciones').insert({
    usuario_id: usuarioId, tipo: datos.tipo || 'gasto', monto: parseFloat(datos.monto), moneda: _moneda,
    monto_pen: _montoPen, tipo_cambio: _tcUsado, metodo_pago: datos.metodo_pago || null,
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
      { role: 'system', content: 'Eres un parser experto de notificaciones bancarias peruanas. Devuelve SOLO JSON sin markdown:\n{ "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"nombre limpio del comercio", "categoria":"Comida|Auto|Transporte|Hogar|Entretenimiento|Streaming|Salud|Educacion|Compras|Viajes|Transferencia|Otros", "subcategoria":"nombre o null", "banco":"BCP|Interbank|BBVA|Scotiabank|Yape|Plin|Otro", "metodo_pago":"Debito|Credito|Yape|Plin|Efectivo|Otro", "fecha":"YYYY-MM-DD", "descripcion_original":"texto original" }\n\nREGLAS DE NORMALIZACION:\n- SPSA / SPSA TOTTUS = Plaza Vea\n- DLOCAL*NETFLIX / NETFLIX = Netflix (Streaming > Netflix)\n- PRIMAX / REPSOL / PECSA = Grifo (Auto > Gasolina)\n- APPLE.COM/BILL / APPLE.COM = Apple Suscripcion (Streaming)\n- SPOTIFY = Spotify (Streaming)\n- AMAZON PRIME / AMZN = Amazon Prime (Streaming)\n- UBER / CABIFY / INDRIVER = Taxi (Transporte > Taxi)\n- RAPPI / PEDIDOSYA / GLOVO = Delivery (Comida > Restaurante)\n- Entel / Claro / Movistar / Bitel = [nombre operadora] (Hogar, subcategoria: Celular)\n- Hidrandina / Luz del Sur / Enel / Electro Sur = [nombre empresa] (Hogar, subcategoria: Servicios)\n- Sedapal / EMAPA / EPS = [nombre empresa] (Hogar, subcategoria: Servicios)\n- Cineplanet / Cinemark / UVK = [nombre cine] (Entretenimiento > Cine)\n- Wong / Metro / Plaza Vea / Tottus / Vivanda = [nombre supermercado] (Hogar > Supermercado)\n\nREGLAS POR BANCO:\n- BBVA: buscar campo Comercio o descripcion de consumo\n- Interbank: buscar campo Empresa para pagos de servicio\n- Scotiabank: buscar campo "Empresa o institucion" para el comercio real\n- YAPE (correo de yapeo): texto viene concatenado. Extraer:\n  * monto: numero despues de "S/" o "Monto de yapeo"\n  * comercio: campo "Nombre del Beneficiario" (puede tener * al final)\n  * fecha: campo "Fecha y Hora de la operacion" (ej: "15 marzo 2026" -> 2026-03-15)\n  * banco: Yape, tipo: gasto, categoria: Transferencia\n  * IGNORAR el nombre del Yapero (es el dueno de la cuenta, no el destinatario)\n- Plin/Yape entre personas: tipo=gasto, categoria=Transferencia, comercio=nombre del destinatario\n- Plin/Yape a comercio: usar nombre del comercio si aparece\n\nREGLAS GENERALES:\n- fecha en formato YYYY-MM-DD (convertir dd/mm/yyyy o "02 mar." usando anio actual 2026)\n- monto siempre numero sin simbolos\n- tipo=ingreso solo si es deposito, sueldo, abono recibido\n- tipo=gasto para consumos, pagos, transferencias enviadas' },
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
  const total = txs.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const porCat = {};
  txs.forEach(t => { const c = t.categoria || 'Otro'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || t.monto); });
  const _txsUsd = txs.filter(t => t.moneda === 'USD'); const _totalUsd = _txsUsd.reduce((s,t) => s+parseFloat(t.monto), 0);
  const _notaUsd = _txsUsd.length > 0 ? ' (incl USD ' + _totalUsd.toFixed(2) + ')' : '';
  const _emojiCat = {'Comida':'\uD83C\uDF54','Delivery':'\uD83C\uDF54','Restaurantes':'\u2615','Supermercados':'\uD83D\uDED2','Transporte':'\uD83D\uDE97','Auto':'\uD83D\uDE97','Streaming':'\uD83D\uDCF1','Suscripciones':'\uD83D\uDCF1','Entretenimiento':'\uD83C\uDFAE','Salud':'\uD83D\uDC8A','Farmacia':'\uD83D\uDC8A','Educacion':'\uD83D\uDCDA','Viajes':'\u2708\uFE0F','Compras':'\uD83D\uDC55','Hogar':'\uD83C\uDFE0','Transferencia':'\uD83D\uDCB8','Servicios':'\u26A1','Otros':'\uD83D\uDCCB'};
  let msg = '\uD83D\uDCCA *' + periodo + '*\nTotal: *S/ ' + total.toFixed(0) + '*' + _notaUsd + ' \u2022 ' + txs.length + ' movimientos\n\n';
  Object.entries(porCat).sort((a, b) => b[1] - a[1]).forEach(([cat, monto]) => {
    const _em = _emojiCat[cat] || '\uD83D\uDCCB';
    msg += _em + ' ' + cat + ': *S/ ' + monto.toFixed(0) + '* (' + ((monto/total)*100).toFixed(0) + '%)\n';
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
  return '\uD83D\uDCEC Revise tu Gmail \u2014 *' + registradas + ' movimiento(s) nuevo(s)*:\n\n' + resumen + '\n\u00bfLo revisamos con /mes?';
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
  const reporteId = Date.now();
  global.reportesTemp = global.reportesTemp || {};
  global.reportesTemp[reporteId] = { html: html, expires: Date.now() + 60 * 60 * 1000 };
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
  return '\u2753 *Gasto sin identificar*\n\nRegistre un *' + banco + '* de *S/ ' + monto + '* (' + fecha + ') pero no tengo info del destinatario.\n\n*Para que fue este gasto?*\nResponde por ejemplo:\n_"Compre almuerzo"_ -> Comida\n_"Le pague al casero"_ -> Hogar\n\nO usa: */cambiar ' + banco + ' [categoria]*';
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

const CATEGORIAS_SUGERIDAS = [
  { nombre: 'Comida', emoji: '\uD83C\uDF7D\uFE0F', subs: ['Almuerzo','Cena','Desayuno','Snacks','Ingredientes','Restaurante','Compartir'] },
  { nombre: 'Auto', emoji: '\uD83D\uDE97', subs: ['Gasolina','Peaje','Estacionamiento','Mantenimiento','Seguro','Impuesto vehicular','Lavado','Accesorios'] },
  { nombre: 'Transporte', emoji: '\uD83D\uDE8C', subs: ['Taxi','Metro','Bus'] },
  { nombre: 'Hogar', emoji: '\uD83C\uDFE0', subs: ['Alquiler','Supermercado','Servicios','Internet','Celular','Limpieza','Articulos de hogar'] },
  { nombre: 'Entretenimiento', emoji: '\uD83C\uDFB0', subs: ['Baile','Cine','Teatro','Conciertos','Futbol','Salidas/Tragos'] },
  { nombre: 'Streaming', emoji: '\uD83D\uDCFA', subs: ['Netflix','Disney+','Amazon Prime','YouTube Premium','Apple Music','Google Storage','Apple Cloud'] },
  { nombre: 'Salud', emoji: '\uD83D\uDC8A', subs: ['Hospital','Medicina','Farmacia','Psicologo','Seguro','Gimnasio','Higiene','Barberia'] },
  { nombre: 'Educacion', emoji: '\uD83D\uDCDA', subs: ['Cursos','Libros','Certificaciones'] },
  { nombre: 'Compras', emoji: '\uD83D\uDED2', subs: ['Ropa','Accesorios','Regalos','Tecnologia'] },
  { nombre: 'Viajes', emoji: '\u2708\uFE0F', subs: ['Vuelo','Hospedaje','Comida','Movilidad','Turismo','Tragos'] },
  { nombre: 'Otros', emoji: '\uD83D\uDCCB', subs: [] }
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
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
          else { respuesta = '\uD83D\uDCCA Ya usaste tu *reporte gratuito* de este mes.\n\n\u2B50 *NETO Pro* \u2014 reportes ilimitados + resumen semanal + categorias personalizadas.\n\n*Solo S/ 9.90/mes*\n\nEscribe */premium* para activarlo.'; }
        }
        if (puedeGenerar) {
          await enviarWhatsapp(from, 'Preparando tu reporte de ' + MESES[mesR] + '... \u23F3');
          if (planUsuario === 'free') { await supabase.from('usuarios').update({ reporte_usos_mes: (usuario.reporte_usos_mes || 0) + 1 }).eq('id', usuario.id); }
          const railwayUrl = process.env.RAILWAY_URL || 'https://finbot-production-c662.up.railway.app';
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
        respuesta = '\u2B50 *NETO Pro \u2014 S/ 9.90/mes*\n\n\u2705 Reportes PDF ilimitados\n\u2705 Resumen semanal automatico\n\u2705 Categorias personalizadas\n\u2705 Sin restricciones\n\n*\u00bfC\u00f3mo pagar?*\n\n\uD83D\uDCB8 *Opcion 1 \u2014 Yape*\nYapea S/ 9.90 al:\n*+51970398192* (Favio M.)\n\nLuego env\u00edame el comprobante o escribe:\n_"ya pague por yape, operacion 12345678"_\n\n_Activacion en menos de 1 hora._';
        // Marcar que usuario esta en flujo de pago
        await supabase.from('usuarios').update({ pago_pendiente: true }).eq('id', usuario.id);
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
      respuesta = '*Comandos NETO:*\n*/semana* -- gastos 7 dias\n*/mes* -- gastos del mes\n*/presupuesto* -- ver/configurar presupuesto\n*/categorias* -- categorias\n*/conectar* -- vincular Gmail\n*/escanear* -- leer correos ahora\n*/cambiar [comercio] [cat]* -- corregir categoria\n*/reporte* -- PDF del mes\n*/reporte ' + mesActual + '* -- PDF mes especifico\n*/pendientes* -- gastos sin identificar\n*/premium* -- plan premium\n*hola* -- estado general\n\n_Tambien puedes escribirme en lenguaje natural!_';
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

app.get('/reporte/:id', (req, res) => {
  const id = req.params.id;
  global.reportesTemp = global.reportesTemp || {};
  const entry = global.reportesTemp[id];
  if (!entry) return res.status(404).send('<h2>Reporte no encontrado o expirado.</h2><p>El link es valido por 1 hora. Genera uno nuevo con /reporte</p>');
  if (Date.now() > entry.expires) { delete global.reportesTemp[id]; return res.status(404).send('<h2>El link del reporte expiro.</h2><p>Genera uno nuevo escribiendo /reporte</p>'); }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(entry.html);
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
  const ADMIN_KEY = process.env.ADMIN_KEY || 'finbot2026';
  if (clave !== ADMIN_KEY) return res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
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
  const ADMIN_KEY = process.env.ADMIN_KEY || 'finbot2026';
  if (req.query.clave !== ADMIN_KEY) return res.status(401).json({ ok: false, msg: 'Clave incorrecta' });
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
        content: 'Eres el clasificador de intenciones de NETO, bot de finanzas personales por WhatsApp para usuarios peruanos.\nEl mes actual es ' + mE[mesActual] + ' ' + anioActual + '.\n\nAnaliza el mensaje y devuelve SOLO JSON.\n\nINTENCIONES:\n1. "listar_gastos_mes" - ver resumen/lista de gastos del mes\n   Ej: "cuales son mis gastos", "que gaste este mes", "gastos registrados", "que tengo registrado", "mis compras", "transacciones"\n   Datos: mes (numero, default=mes_actual), anio\n\n2. "listar_gastos_semana" - gastos de los ultimos 7 dias\n   Ej: "que gaste esta semana", "gastos recientes", "mis compras de los ultimos dias"\n\n3. "listar_gastos_categoria" - gastos de UNA categoria especifica\n   Ej: "que hay en Otros", "gastos de Comida", "que esta en Transporte", "detalle de Hogar", "cuales estan en otros"\n   Datos: categoria (nombre exacto), mes (default=mes_actual)\n\n4. "ver_total_gastado" - saber el TOTAL numerico gastado\n   Ej: "cuanto gaste", "cuanto llevo gastado", "total de gastos"\n   Datos: periodo ("semana" o "mes"), categoria (o null)\n\n5. "ver_presupuesto" - ver estado del presupuesto\n   Ej: "como va mi presupuesto", "cuanto me queda", "mis limites"\n\n6. "configurar_presupuesto" - configurar limite de gasto\n   Ej: "pon limite de 500 en comida", "presupuesto de 300 para transporte"\n   Datos: categoria, monto\n\n7. "ver_categorias" - ver categorias configuradas del sistema\n   Ej: "que categorias hay", "muestra las categorias del sistema"\n   IMPORTANTE: Si el historial muestra que NETO estaba hablando de gastos por categoria, NO usar esta intencion\n\n8. "ver_reporte" - reporte PDF\n   Ej: "dame mi reporte", "informe mensual", "reporte de marzo", "genera pdf"\n   Datos: mes (default=mes_actual), anio\n\n9. "corregir_categoria" - cambiar categoria de un gasto\n   Ej: "netflix es streaming", "cambia uber a transporte", "mover gasto de punto.pe a NETO", "ponlo en Hogar", "muevelo a Delivery", "este gasto es de Comida"\n   IMPORTANTE: Usar cuando el usuario quiere mover/cambiar/reclasificar un gasto a cualquier categoria (incluso nueva). comercio puede ser null.\n   Datos: comercio (null si no se menciona), categoria_nueva\n\n10. "ver_pendientes" - gastos sin identificar\n    Ej: "gastos pendientes", "que no identificaste", "gastos sin categoria"\n\n11. "escanear_gmail" - escanear correos\n    Ej: "escanea mi correo", "busca transacciones nuevas", "hay correos nuevos"\n\n12. "ver_premium" - info del plan premium\n    Ej: "cuanto cuesta premium", "que incluye el plan"\n\n13. "saludo" - saludo sin intencion especifica\n    Ej: "buenos dias", "que tal", "como estas"\n\n14. "ayuda" - pide ayuda\n    Ej: "que puedes hacer", "ayuda", "como funciona"\n\n15. "desconocido" - no encaja con ninguna intencion clara, o es continuacion de conversacion\n    Usar cuando: el mensaje es "si", "no", "dale", "ok", "mas", o cualquier respuesta corta a algo que NETO pregunto\n\nREGLAS CRITICAS:\n- Si el historial muestra que NETO hizo una pregunta y el usuario responde con "si", "no", "dale", "ok", "mas detalle", "eso", "las dos", o cualquier respuesta corta -> usar "desconocido" para que NETO maneje la continuacion\n- Si el historial muestra que NETO hablaba de gastos por categoria y el usuario dice "otras categorias" o similar -> usar "desconocido" no "ver_categorias"\n- "otros" como categoria de gasto -> listar_gastos_categoria con categoria="Otros"\n- "cuanto gaste" sin periodo -> ver_total_gastado con periodo="mes"\n- "gastos registrados"/"que tengo" -> listar_gastos_mes\n- mes: enero=1, febrero=2, marzo=3, ..., diciembre=12\n- Si no especifica mes -> usar mes_actual' + histCtx
      }, {
        role: 'user',
        content: msg
      }],
      temperature: 0
    });

    const rawClasif = clasificacion.choices[0].message.content.trim();
    const clean = rawClasif.startsWith('{') ? rawClasif : rawClasif.slice(rawClasif.indexOf('{'), rawClasif.lastIndexOf('}')+1);
    const { intencion, datos } = JSON.parse(clean);
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
        if (!cat) return 'Dime la categoria. Ej: _"gastos de Comida"_, _"que hay en Transporte"_';
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
          if ((usuario.reporte_usos_mes || 0) >= 1) return '\uD83D\uDCCA Ya usaste tu *reporte gratuito* de este mes.\n\n\u2B50 *NETO Pro* \u2014 reportes ilimitados + resumen semanal + categorias personalizadas.\n\n*Solo S/ 9.90/mes*\n\nEscribe */premium* para activarlo.';
        }
        await enviarWhatsapp(from, 'Generando tu reporte PDF... \u23F3');
        if (planUsuario2 === 'free') { await supabase.from('usuarios').update({ reporte_usos_mes: (usuario.reporte_usos_mes || 0) + 1 }).eq('id', usuario.id); }
        const railwayUrl = process.env.RAILWAY_URL || 'https://finbot-production-c662.up.railway.app';
        generarYEnviarReporte(usuario, mesR, anioR).then(async (result) => {
          if (!result.ok) { await enviarWhatsapp(from, result.msg); }
          else { await enviarWhatsapp(from, '\uD83D\uDCC4 *Reporte ' + mE[mesR] + ' ' + anioR + ' listo!*\n\n' + result.txCount + ' transacciones.\nDisponible 30 min:\n' + railwayUrl + '/reporte/' + result.reporteId + (planUsuario2 === 'free' ? '\n\n_Reporte gratuito del mes usado._' : '')); }
        }).catch(async (e) => { await enviarWhatsapp(from, 'Error: ' + e.message); });
        return null;
      }

      case 'corregir_categoria': {
        if (datos.comercio && datos.categoria_nueva) return (await recategorizarTransaccion(usuario.id, datos.comercio, datos.categoria_nueva)).msg;
        return 'Dime el comercio y la nueva categoria.\nEj: _"Netflix es Streaming"_';
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
        return '\u2B50 *NETO Pro \u2014 S/ 9.90/mes*\n\n\u2705 Reportes PDF ilimitados\n\u2705 Resumen semanal automatico\n\u2705 Categorias personalizadas\n\u2705 Sin restricciones\n\nEscribenos para activarlo:\n+51970398192';
      }

      case 'saludo': {
        const gastosSaludo = await obtenerGastosMes(usuario.id);
        const totalSaludo = gastosSaludo.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
        const pendSaludo = await obtenerConsultasPendientes(usuario.id);
        const ctxSaludo = 'El usuario saluda. Contexto: este mes lleva S/ ' + totalSaludo.toFixed(0) + ' en ' + gastosSaludo.length + ' movimientos.' +
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
  let msg = emoji + ' *' + tipoStr + '*\n';
  msg += '\uD83C\uDFEA ' + comercio + '\n';
  msg += '\uD83D\uDCB0 *S/ ' + monto.toFixed(2) + '*\n';
  msg += '\uD83C\uDFF7\uFE0F ' + categoria + '\n';
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

  msg += '\n\n_Escribe /mes para ver todos tus gastos._';
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
