// E2E — la superficie de soporte: la queja SE GUARDA y nadie reparte el celular personal.
//
// Por qué existe. El 28-ago-2026 un usuario llegó al celular PERSONAL de Favio. La hipótesis
// era que lo había sacado de vortik.dev; midiendo, se lo había dado Neto: el intent `feedback`
// cerraba con *"escríbenos al 970398192"* y el de `queja` con lo mismo. Y la queja **no dejaba
// ninguna fila**: 0 quejas registradas en la vida del producto, o sea que la persona que peor
// la estaba pasando era la única que no aparecía en ningún panel.
//
// Los tests unitarios ya cubren la lógica contra un doble de Supabase. Lo que ESTE archivo
// agrega es lo que un doble no puede: que la BASE REAL acepte la fila. Es la lección del
// defecto del 27-ago (`survey_events.channel` era un ENUM, los 2543 tests pasaron en verde y
// el INSERT reventaba en producción con 22P02). Acá se verificó que `nlp_errors.error_tipo`
// es `text` sin CHECK — pero eso se comprueba, no se asume, y por eso el harness inserta de
// verdad por el código de producción en vez de leer el esquema.
//
// NO manda WhatsApp: los intents de `social.js` devuelven texto, no envían.
//
// Correr:  node qa-e2e/qa-soporte-feedback.mjs   (desde app/)  → exit 0 si todo pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';

const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));
const social = require(path.join(appRoot, 'handlers/intents/social.js'));
const { ADMIN_NUMBER } = require(path.join(appRoot, 'lib/config.js'));

// La misma normalización por TOKEN que el guard de la suite: borrar todos los no-dígitos del
// mensaje entero fabrica el número juntando cifras sueltas de un monto.
const PERSONAL = '51970398192';
const LOCAL = '970398192';
const configurado = String(ADMIN_NUMBER || '').replace(/[^0-9]/g, '');
const AGUJAS = [PERSONAL, LOCAL].concat(configurado.length >= 9 ? [configurado] : []);
function tieneNumeroPersonal(t) {
  const tokens = String(t || '').match(/\+?\d[\d\s\-().+]{6,}\d/g) || [];
  return tokens.some((tok) => {
    const d = tok.replace(/[^0-9]/g, '');
    return AGUJAS.some((n) => d.includes(n));
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

const creadas = [];

async function correrIntent(intencion, msg) {
  const usuario = { id: QA_ID, nombre: 'QA', plan: 'premium' };
  return social.handle({
    intencion, msg, datos: {}, usuario, from: QA_WHATSAPP,
    ctx: { supabase, netoPrompt: '', historialConv: [], redactarConNETO: async () => null, obtenerGastosMes: async () => [] },
  });
}

async function main() {
  // Guarda de identidad: sin esto el harness podría estar escribiendo sobre un usuario real.
  const { data: u0 } = await supabase.from('usuarios').select('is_test_user').eq('id', QA_ID).single();
  check('el usuario del harness es de prueba', u0 && u0.is_test_user === true, 'is_test_user=' + (u0 && u0.is_test_user));
  if (!u0 || u0.is_test_user !== true) return;

  const antes = new Date().toISOString();

  // ── 1. La QUEJA deja fila ───────────────────────────────────────────────────
  const rQueja = await correrIntent('queja', 'qa-e2e: me cobraron dos veces y nadie responde');
  check('la queja confirma que quedó anotada', /revisar el equipo|anot/i.test(rQueja), rQueja.slice(0, 60).replace(/\n/g, ' '));
  check('la queja NO reparte el celular personal', !tieneNumeroPersonal(rQueja), '');

  const { data: qFilas } = await supabase.from('nlp_errors')
    .select('id, error_tipo, mensaje, usuario_id')
    .eq('usuario_id', QA_ID).eq('error_tipo', 'queja').gte('created_at', antes);
  // **La re-lectura es lo único que el copy no puede fingir.** El mensaje de arriba lo devuelve
  // el handler pase lo que pase con la escritura; esta consulta es la que dice si entró.
  check('la queja ENTRÓ en nlp_errors (re-leída de la base)', (qFilas || []).length === 1,
    'filas=' + (qFilas || []).length);
  for (const f of qFilas || []) creadas.push(f.id);

  // ── 2. El FEEDBACK sigue entrando, y tampoco reparte el número ──────────────
  const rFeed = await correrIntent('feedback', 'qa-e2e: sería bueno que leas los SMS');
  check('el feedback confirma', /sugerencia/i.test(rFeed), rFeed.slice(0, 60).replace(/\n/g, ' '));
  check('el feedback NO reparte el celular personal', !tieneNumeroPersonal(rFeed), '');

  const { data: fFilas } = await supabase.from('nlp_errors')
    .select('id').eq('usuario_id', QA_ID).eq('error_tipo', 'feedback').gte('created_at', antes);
  check('el feedback ENTRÓ en nlp_errors', (fFilas || []).length === 1, 'filas=' + (fFilas || []).length);
  for (const f of fFilas || []) creadas.push(f.id);

  // ── 3. El CONTROL del detector ──────────────────────────────────────────────
  // Sin esto, un detector roto pone en verde los dos checks de arriba sin mirar nada — que es
  // exactamente el defecto que se registró hoy en docs/DEFECTOS.md.
  check('el detector VE el número (control)', tieneNumeroPersonal('Yapea al *' + LOCAL + '*'), '');
  check('el detector no lo inventa (control)', !tieneNumeroPersonal('Escribe */soporte* y seguimos por acá'), '');

  // ── 4. El hilo existe y acepta las dos puntas ───────────────────────────────
  const { error: errHilo } = await supabase.from('tickets_mensajes')
    .select('id').limit(1);
  check('tickets_mensajes es legible (migración 079)', !errHilo, errHilo ? errHilo.message : '');
}

async function limpiar() {
  // Por ID: fija el sujeto. Un DELETE con `like` sobre esta tabla alcanzaría filas de usuarios
  // reales, y por eso el guard lo rechaza.
  for (const id of creadas) {
    await supabase.from('nlp_errors').delete().eq('id', id);
  }
  const { data: quedan } = await supabase.from('nlp_errors')
    .select('id').in('id', creadas.length ? creadas : ['00000000-0000-0000-0000-000000000000']);
  check('el harness limpió sus filas', (quedan || []).length === 0, 'quedan=' + (quedan || []).length);
}

main()
  .then(limpiar)
  .catch(async (e) => { console.error('ERROR: ' + e.message); results.push({ name: 'excepción', pass: false }); await limpiar().catch(() => {}); })
  .finally(() => {
    const fallos = results.filter((r) => !r.pass);
    console.log('\n' + (results.length - fallos.length) + '/' + results.length + ' checks OK');
    process.exit(fallos.length ? 1 : 0);
  });
