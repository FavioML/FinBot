const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { enviarWhatsapp } = require('../lib/whatsapp');
const { generarReporteJSON } = require('../reporte_html');
const { oauth2Client, obtenerPerfilGoogle, guardarTokens, obtenerCuentasGmail, verificarState } = require('../gmail');
const { parsearCorreoBancario } = require('../services/parsers');
const { escanearGmailYRegistrar, escanearHistoricoInicial } = require('../services/gmail-scanner');
const analytics = require('../lib/analytics');

const { ultimoDiaMes } = require('../lib/dates');

const router = express.Router();

// GET /reporte/:id
router.get('/reporte/:id', async (req, res) => {
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

// GET /r/:code — redirige a WhatsApp con ref_code
router.get('/r/:code', async (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const { data: referrer } = await supabase.from('usuarios').select('id').eq('ref_code', code).single();
  const waNum = process.env.WA_PHONE_NUMBER || '51933014505';
  const waText = encodeURIComponent('Hola NETO ref:' + code);
  if (!referrer) return res.redirect('https://wa.me/' + waNum);
  res.redirect('https://wa.me/' + waNum + '?text=' + waText);
});

// GET /dashboard/:id
router.get('/dashboard/:id', async (req, res) => {
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

// GET /api/reporte/:id — JSON para dashboard interactivo
router.get('/api/reporte/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const { data: entry, error } = await supabase
      .from('reporte_cache').select('html, expires_at').eq('id', id).single();
    if (error || !entry) return res.status(404).json({ error: 'Reporte no encontrado o expirado.' });
    if (new Date(entry.expires_at) < new Date()) {
      await supabase.from('reporte_cache').delete().eq('id', id);
      return res.status(410).json({ error: 'El link del reporte expiro. Genera uno nuevo con /reporte' });
    }
    try {
      const jsonData = JSON.parse(entry.html);
      res.json(jsonData);
    } catch {
      res.status(400).json({ error: 'Este reporte usa el formato anterior. Genera uno nuevo con /reporte' });
    }
  } catch(e) {
    log.error({ tag: 'API_REPORTE', err: e.message }, 'Error API reporte');
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/reporte/:id/mes/:mes/:anio — datos de un mes específico
router.get('/api/reporte/:id/mes/:mes/:anio', async (req, res) => {
  const { id, mes, anio } = req.params;
  const mesNum = parseInt(mes);
  const anioNum = parseInt(anio);
  if (!mesNum || mesNum < 1 || mesNum > 12 || !anioNum) {
    return res.status(400).json({ error: 'Mes o anio invalido' });
  }
  try {
    const { data: entry } = await supabase
      .from('reporte_cache').select('usuario_id, expires_at').eq('id', id).single();
    if (!entry) return res.status(404).json({ error: 'Reporte no encontrado' });
    if (new Date(entry.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Sesion expirada. Genera un nuevo reporte.' });
    }
    const usuarioId = entry.usuario_id;
    const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', usuarioId).single();
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    const desde = anioNum + '-' + String(mesNum).padStart(2,'0') + '-01';
    const hasta = anioNum + '-' + String(mesNum).padStart(2,'0') + '-' + String(ultimoDiaMes(anioNum, mesNum)).padStart(2,'0');
    const { data: txs } = await supabase.from('transacciones').select('*').eq('usuario_id', usuarioId).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
    if (!txs || txs.length === 0) return res.json({ error: 'Sin transacciones para ese mes', empty: true });

    const { data: presupData } = await supabase.from('presupuestos').select('*').eq('usuario_id', usuarioId).eq('mes', mesNum).eq('anio', anioNum);
    const presupuestos = {};
    if (presupData) presupData.forEach(p => { presupuestos[p.categoria] = parseFloat(p.monto_limite); });

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

// GET /mi-reporte/:id — redirige a landing
router.get('/mi-reporte/:id', (req, res) => {
  res.redirect(301, 'https://neto.pe/mi-reporte/' + req.params.id);
});

// GET /auth/callback — OAuth2 callback de Gmail
router.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  // No reflejar req.query.error crudo en el HTML (XSS reflejado). Lo logueamos y mostramos texto fijo.
  if (error) { log.warn({ tag: 'OAUTH', code: String(error).slice(0, 60) }, 'Google devolvió error en el callback OAuth'); return res.status(400).send('<h2>No se pudo conectar Gmail.</h2><p>Vuelve a WhatsApp e intenta de nuevo.</p>'); }
  if (!code) return res.status(400).send('<h2>No se recibió el código.</h2><p>Vuelve a WhatsApp e intenta de nuevo.</p>');
  // Verifica el state firmado (HMAC, ver gmail.js) ANTES de canjear el code: no gastamos
  // un token exchange en un callback forjado y NUNCA adivinamos el usuario. Sin esta guarda,
  // un state ausente/forjado permitía asignar los tokens de Gmail de la víctima a la cuenta
  // del atacante (robo de datos bancarios).
  const stateObj = verificarState(req.query.state);
  if (!stateObj) {
    log.warn({ tag: 'OAUTH' }, 'State OAuth ausente, inválido o vencido — callback abortado');
    return res.status(400).send('<h2>El enlace de conexión expiró o no es válido.</h2><p>Vuelve a WhatsApp y escribe */conectar* para generar uno nuevo.</p>');
  }
  const whatsappNum = stateObj.num;
  const modoConexion = stateObj.modo || 'inicial';
  const origenConexion = stateObj.origen || null;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    let usuario = null;
    if (whatsappNum) { const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', whatsappNum).single(); usuario = data; }
    if (!usuario) return res.status(404).send('<h2>No se encontró tu cuenta.</h2><p>Escribe */conectar* en WhatsApp.</p>');

    const perfil = await obtenerPerfilGoogle(oauth2Client);
    const emailConectado = perfil.email;
    await guardarTokens(usuario.id, tokens, emailConectado, modoConexion);
    if (perfil.nombre || emailConectado) {
      const updateUser = { nombre: usuario.nombre || perfil.nombre };
      if (!usuario.email && emailConectado) updateUser.email = emailConectado;
      await supabase.from('usuarios').update(updateUser).eq('id', usuario.id);
      usuario.nombre = usuario.nombre || perfil.nombre;
    }

    const nombre = usuario.nombre ? ', ' + usuario.nombre : '';
    const emailMsg = emailConectado ? ' (' + emailConectado + ')' : '';
    // Origen 'web' (conexión iniciada desde la webapp): redirigir de vuelta al dashboard.
    // El escaneo asíncrono de abajo corre igual.
    if (origenConexion === 'web') {
      res.redirect('https://app.neto.pe/dashboard?gmail=conectado');
    } else {
      res.send('<html><body style="font-family:Arial;text-align:center;padding:50px;background:#0d1b2a;color:white"><h1 style="color:#4CAF50">Gmail conectado' + nombre + '!</h1><p style="font-size:18px">' + emailMsg + '</p><p>Vuelve a WhatsApp, el bot te escribira en un momento.</p></body></html>');
    }
    const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : 'por ahi';

    setTimeout(async () => {
      try {
        if (modoConexion === 'agregar') {
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
        // Primera conexión de Gmail → barrido único de 30 días para poblar el dashboard.
        // 'agregar' ya retornó arriba; el flag historico_importado evita repetirlo.
        const debeHistorico = modoConexion !== 'agregar' && !usuario.historico_importado;
        const resultado = debeHistorico
          ? await escanearHistoricoInicial(usuario)
          : await escanearGmailYRegistrar(usuario);
        if (resultado && typeof resultado === 'string') {
          await enviarWhatsapp(usuario.whatsapp, resultado);
        }
        if (modoConexion === 'inicial') {
          await supabase.from('usuarios').update({ onboarding_paso: 0, onboarding_completado: true }).eq('id', usuario.id);
          analytics.capture(usuario.id, 'wa_onboarding_completed', { via: 'gmail' });
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
  } catch (err) { log.error({ tag: 'CALLBACK', err: err.message }, 'Error en OAuth callback'); res.status(500).send('<h2>Ocurrió un error al conectar Gmail.</h2><p>Vuelve a WhatsApp e intenta de nuevo.</p>'); }
});

// POST /test-parser — admin tool to test email parser
router.post('/test-parser', async (req, res) => {
  const { correo, clave } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (!ADMIN_KEY || !clave || clave.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(ADMIN_KEY))) return res.status(401).json({ error: 'No autorizado' });
  if (!correo) return res.status(400).json({ error: 'Falta correo' });
  try { const r = await parsearCorreoBancario(correo); res.json({ ok: true, resultado: r }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET / — root
router.get('/', (req, res) => res.send('NETO v5'));

module.exports = router;
