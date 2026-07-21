// E2E — los avisos de reparto despues de extraer `avisarAMiembros`, contra PRODUCCION.
//
// El cambio que esto verifica hizo dos cosas: agrego el aviso de las reglas por
// categoria (`PUT split-rules`, que antes movia plata futura en silencio) y saco
// la fontaneria comun de los avisos a `avisarAMiembros`. Ese refactor toca una
// ruta VIVA del pipeline de mensajes: unirse a un espacio por WhatsApp llama a
// `notificarNuevoMiembro` desde `handlers/intents/espacios.js`.
//
// Que verifica:
//   1. WEBHOOK REAL (firma HMAC, dedup, intercepts) + NLP REAL + Supabase REAL:
//      el usuario QA se une a un espacio escribiendo por WhatsApp, con historial
//      adverso sembrado (produccion usa historialConv.slice(-4)). Se asserta la
//      respuesta que REALMENTE ve el usuario, no la pieza aislada.
//   2. Que ese mismo flujo le avisa a los que ya estaban con su % efectivo — o
//      sea que el refactor no dejo mudo el camino de WhatsApp.
//   3. El aviso nuevo de reglas por categoria: nombra la categoria, anuncia el %
//      efectivo de ESA categoria, no le escribe al que edito y avisa cuando una
//      categoria vuelve al reparto por defecto.
//   4. El endpoint `POST /admin/espacio-reglas-cambiadas` esta VIVO en Railway
//      (no basta health 200: eso no distingue version).
//
// `enviarWhatsapp` se stubea: aca se prueban el flujo y el texto, no la
// mensajeria, y no hay por que mandarle WhatsApps a nadie por una corrida de QA.
// Limpia todo lo que crea.
//
// Correr:  node qa-e2e/qa-espacios-reglas-aviso.mjs   (desde app/)  → exit 0 si pasa.

import 'dotenv/config';
import crypto from 'crypto';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnv(file) {
  const out = {};
  for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const qaEnv = parseEnv(path.join(homedir(), '.config', 'neto', 'qa.env'));
const QA_ID = qaEnv.NETO_QA_USUARIO_ID;
const FREE = qaEnv.NETO_QA_FREE_USUARIO_ID;
const M3 = qaEnv.NETO_QA_M3_USUARIO_ID;
if (!QA_ID || !FREE || !M3) {
  console.error('Faltan NETO_QA_USUARIO_ID / NETO_QA_FREE_USUARIO_ID / NETO_QA_M3_USUARIO_ID en ~/.config/neto/qa.env');
  process.exit(1);
}
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'qa-probe-secret';

// ── Stub de salida: capturar todo enviarWhatsapp ANTES de cargar nada ────────
const sent = [];
const waPath = require.resolve(path.join(appRoot, 'lib/whatsapp.js'));
require.cache[waPath] = {
  id: waPath, filename: waPath, loaded: true,
  exports: { enviarWhatsapp: async (to, msg) => { sent.push({ to, msg }); return true; } },
};

const createWebhookHandler = require(path.join(appRoot, 'handlers/webhook.js'));
const { procesarMensajeLibre } = require(path.join(appRoot, 'handlers/message-processor.js'));
const { supabase } = require(path.join(appRoot, 'lib/db.js'));
const { notificarReglasEditadas } = require(path.join(appRoot, 'services/shared-spaces.js'));
const { effectiveSplitPercents } = require(path.join(appRoot, 'services/spaces-split.js'));

// El webhook real, con el NLP real detras: si un intercept secuestrara el
// mensaje, el intent de espacios no correria y el join no pasaria.
let nlpCalls = 0;
const handler = createWebhookHandler(async (...args) => { nlpCalls++; return procesarMensajeLibre(...args); });

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
};

let wamidSeq = 0;
async function enviarWA(texto, from) {
  const before = sent.length;
  const body = { entry: [{ changes: [{ value: { messages: [{
    from, id: 'qa-reglas-' + Date.now() + '-' + (wamidSeq++), type: 'text', text: { body: texto },
  }] } }] }] };
  const rawBody = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex');
  await handler({ headers: { 'x-hub-signature-256': sig }, rawBody, body }, { sendStatus: () => {} });
  return sent.slice(before);
}

const creados = [];
const invite = () => 'QA' + Math.random().toString(36).slice(2, 8).toUpperCase();

async function crearEspacio(nombre, pesos, splitRules = []) {
  const code = invite();
  const { data: sp, error } = await supabase.from('shared_spaces').insert({
    name: nombre, type: 'custom', invite_code: code, created_by: M3, split_rules: splitRules,
  }).select().single();
  if (error) throw error;
  creados.push(sp.id);
  const filas = Object.entries(pesos).map(([user_id, split_percentage], i) => ({
    space_id: sp.id, user_id, split_percentage, role: i === 0 ? 'owner' : 'member',
  }));
  const { error: eM } = await supabase.from('space_members').insert(filas);
  if (eM) throw eM;
  return sp;
}

const miembros = async (spaceId) => {
  const { data } = await supabase.from('space_members')
    .select('user_id, split_percentage').eq('space_id', spaceId).order('user_id');
  return data || [];
};

const conversacionesSembradas = [];

/** Historial adverso: produccion manda historialConv.slice(-4) al NLP. */
async function sembrarHistorialAdverso() {
  const ruido = [
    ['user', 'gaste 40 en taxi'],
    ['assistant', 'Anotado: S/40 en Transporte 🚕'],
    ['user', 'cuanto llevo este mes'],
    ['assistant', 'Vas S/1,240 este mes. Tu mayor gasto es Alimentación.'],
    ['user', 'ya no quiero registrar nada mas'],
    ['assistant', 'Listo, acá estoy cuando lo necesites.'],
  ];
  for (const [rol, mensaje] of ruido) {
    // Se guardan los ids para borrar SOLO lo sembrado: el usuario QA tiene
    // historial propio y un delete por usuario_id se llevaria puesto el real.
    const { data } = await supabase.from('conversaciones')
      .insert({ usuario_id: QA_ID, rol, mensaje }).select('id').single();
    if (data?.id) conversacionesSembradas.push(data.id);
  }
}

async function main() {
  const { data: u0 } = await supabase.from('usuarios')
    .select('id, whatsapp, plan, is_test_user').eq('id', QA_ID).single();
  check('guarda de identidad: es el usuario QA de prueba', !!u0 && u0.is_test_user === true,
    JSON.stringify({ id: u0?.id, is_test_user: u0?.is_test_user, plan: u0?.plan }));
  if (!u0?.is_test_user) throw new Error('El usuario objetivo NO es is_test_user — abortando');
  const QA_WA = u0.whatsapp;

  // ── 1. FLUJO COMPLETO: unirse a un espacio escribiendo por WhatsApp ────────
  await sembrarHistorialAdverso();
  const sp = await crearEspacio('QA reglas aviso wa', { [M3]: 80, [FREE]: 40 });
  const { data: spCode } = await supabase.from('shared_spaces')
    .select('invite_code').eq('id', sp.id).single();

  const nlpAntes = nlpCalls;
  const salida = await enviarWA('quiero unirme al espacio ' + spCode.invite_code, QA_WA);
  const respuesta = salida.filter(s => s.to === QA_WA).map(s => s.msg).join('\n');

  check('el mensaje llego al NLP (ningun intercept lo secuestro)', nlpCalls > nlpAntes, 'nlpCalls=' + nlpCalls);
  check('el webhook respondio algo al usuario', respuesta.length > 0, 'sin respuesta');

  const trasJoin = await miembros(sp.id);
  check('el join por WhatsApp entro de verdad (3 miembros en DB)', trasJoin.length === 3,
    JSON.stringify(trasJoin.map(m => [m.user_id.slice(0, 8), Number(m.split_percentage)])));
  check('la respuesta que ve el usuario confirma el espacio',
    /espacio|uniste|unido/i.test(respuesta) && respuesta.includes('QA reglas aviso wa'),
    JSON.stringify(respuesta.slice(0, 220)));

  // Y a los que YA estaban se les aviso con su % efectivo. Esto es lo que el
  // refactor de `avisarAMiembros` podia romper sin que ningun unit test lo note.
  const pct = effectiveSplitPercents(trasJoin);
  const avisos = salida.filter(s => s.to !== QA_WA);
  const textoAvisos = avisos.map(a => a.msg).join('\n---\n');
  check('se les aviso a los que ya estaban, no al que entro', avisos.length >= 1,
    'avisos=' + avisos.length);
  check('el aviso anuncia el % EFECTIVO, no el peso crudo',
    textoAvisos.includes('a ' + pct[M3] + '%') || textoAvisos.includes('a ' + pct[FREE] + '%'),
    JSON.stringify({ pct, textoAvisos: textoAvisos.slice(0, 300) }));
  check('el aviso NO muestra el peso crudo (80%) como si fuera la parte',
    !/pasó de 80% a/.test(textoAvisos), textoAvisos.slice(0, 200));

  // ── 2. Aviso de reglas por categoria (el hueco que este cambio cierra) ─────
  const antesReglas = [{ id: 'r-Alimentación', category: 'Alimentación', splits: { [M3]: 50, [FREE]: 50 } }];
  const sp2 = await crearEspacio('QA reglas aviso cat', { [M3]: 50, [FREE]: 50 },
    [{ id: 'r-Alimentación', category: 'Alimentación', splits: { [M3]: 80, [FREE]: 20 } }]);

  sent.length = 0;
  await notificarReglasEditadas(sp2.id, M3, antesReglas);
  const paraFree = sent.map(s => s.msg).join('\n');
  check('el aviso de reglas nombra la categoria y su % efectivo',
    paraFree.includes('En Alimentación tu parte pasó de 50% a 20%.'), JSON.stringify(paraFree.slice(0, 300)));
  check('el aviso de reglas no le escribe al que edito', sent.length === 1, 'enviados=' + sent.length);

  // Regla borrada: la categoria vuelve al reparto por defecto y hay que decirlo.
  await supabase.from('shared_spaces').update({ split_rules: [] }).eq('id', sp2.id);
  sent.length = 0;
  await notificarReglasEditadas(sp2.id, M3,
    [{ id: 'r-Alimentación', category: 'Alimentación', splits: { [M3]: 80, [FREE]: 20 } }]);
  check('borrar una regla avisa la vuelta al reparto por defecto',
    sent.map(s => s.msg).join('\n').includes('de 20% a 50% (vuelve al reparto por defecto)'),
    JSON.stringify(sent.map(s => s.msg.slice(0, 200))));

  // Guardar sin cambiar nada no molesta a nadie.
  await supabase.from('shared_spaces')
    .update({ split_rules: antesReglas }).eq('id', sp2.id);
  sent.length = 0;
  await notificarReglasEditadas(sp2.id, M3, antesReglas);
  check('guardar sin cambios reales no manda ningun aviso', sent.length === 0, 'enviados=' + sent.length);

  // ── 3. El endpoint nuevo esta vivo en Railway (health 200 no distingue version)
  const API = 'https://api.neto.pe';
  const sinKey = await fetch(API + '/admin/espacio-reglas-cambiadas', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check('la ruta existe en produccion y exige ADMIN_KEY',
    sinKey.status === 401 || sinKey.status === 403, 'status ' + sinKey.status);

  // El contraste es lo que prueba la VERSION desplegada: una ruta que no existe
  // muere en el 404 de Express, asi que un 401 solo puede venir de un handler que
  // esta ahi y llego a `verificarAdmin`. ADMIN_KEY vive en Railway/Vercel y no
  // hace falta traerla para saberlo.
  const inexistente = await fetch(API + '/admin/ruta-que-no-existe-qa', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check('el 401 distingue version: una ruta inexistente da 404',
    inexistente.status === 404 && sinKey.status === 401,
    `nueva=${sinKey.status} inexistente=${inexistente.status}`);
}

try {
  await main();
} catch (e) {
  check('corrida sin excepciones', false, e.message);
} finally {
  for (const id of creados) {
    await supabase.from('space_expenses').delete().eq('space_id', id);
    await supabase.from('space_settlements').delete().eq('space_id', id);
    await supabase.from('space_members').delete().eq('space_id', id);
    await supabase.from('shared_spaces').delete().eq('id', id);
  }
  if (conversacionesSembradas.length) {
    await supabase.from('conversaciones').delete().in('id', conversacionesSembradas);
  }
}

const fails = results.filter(r => !r.pass);
console.log(fails.length ? `\nFAIL (${fails.length}): ${fails.map(f => f.name).join(', ')}` : '\nOK — todos los checks pasaron');
process.exit(fails.length ? 1 : 0);
