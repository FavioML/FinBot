/**
 * Carga del system prompt maestro de NETO.
 *
 * FUENTE ÚNICA DE VERDAD: `prompts/NETO_system_prompt.txt` (versionado en git, referenciado
 * por docs/BRAND-VOICE.md). No duplicar el archivo en handlers/ ni en ningún otro lado.
 *
 * VIVE EN `prompts/` Y NO EN `docs/` POR DEPLOYABILIDAD, no por orden. `railway.json`
 * excluye `docs/**` de `watchPatterns` con el motivo "no los ejecuta nadie", y mientras
 * este archivo estuvo ahí (22-jul a 04-sep-2026) editarlo NO disparaba redeploy: producción
 * seguía sirviendo el prompt anterior, sin error y sin aviso. El invariante que lo impide
 * hacia adelante es `tests/runtime-desplegable.test.js`, que deriva de `railway.json` en
 * vez de fijar esta ruta como cadena.
 *
 * Historia: hasta 2026-07 message-processor.js lo leía desde `handlers/` (ruta inexistente)
 * dentro de un try/catch que solo logueaba. El ENOENT se tragaba en silencio y producción
 * corrió meses con un fallback de una línea en vez del prompt real. Por eso acá:
 *   1. Se lee UNA vez al require (no readFileSync sincrónico por mensaje).
 *   2. Si el archivo falta o está vacío, se lanza → el proceso NO arranca. Un prompt
 *      degradado en silencio es peor que un deploy que falla visible.
 *   3. `construirNetoPrompt` valida que no quede ningún {PLACEHOLDER} sin resolver en el
 *      bloque de contexto dinámico.
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'NETO_system_prompt.txt');

// Contrato: estos son los únicos placeholders que el código inyecta. Deben existir en el
// archivo y el archivo no debe declarar otros en el bloque de contexto dinámico.
const PLACEHOLDERS = ['NOMBRE_USUARIO', 'PLAN_USUARIO', 'MESES_HISTORIAL', 'PARSERS_ACTIVOS', 'ULTIMA_SYNC', 'MODO_INGESTA'];

// Marca del bloque final donde viven las variables inyectadas. Los {PLACEHOLDER} que
// aparecen antes son parte de ejemplos de respuesta y se dejan literales a propósito.
const MARCA_CONTEXTO = 'DATOS DEL USUARIO (CONTEXTO DINÁMICO)';

const BANCOS = ['BCP', 'Interbank', 'BBVA', 'Scotiabank', 'Yape', 'Plin'].join(', ');

// Cómo entran los gastos depende de si el usuario conectó su correo. Hoy 9 de cada 10 NO
// lo tienen conectado: afirmarles que les leemos los correos los deja creyendo que están
// cubiertos cuando en realidad no se registra nada si no lo escriben.
const INGESTA = {
  conCorreo: 'Operas 100% por WhatsApp. El usuario tiene su correo conectado: lees automáticamente\n'
    + 'sus correos de transacciones de ' + BANCOS + ', y los conviertes en\n'
    + 'información útil, análisis claros y recomendaciones concretas.',
  sinCorreo: 'Operas 100% por WhatsApp. El usuario NO tiene su correo conectado, así que sus gastos\n'
    + 'entran ÚNICAMENTE cuando él te los escribe o te manda la captura.\n'
    + 'NUNCA le digas que lees sus correos, que detectaste algo automáticamente, ni que\n'
    + 'tienes bancos sincronizados: sería falso. Si viene al caso, ofrécele conectar su\n'
    + 'correo para que sea automático, sin insistir.',
};

function cargarPrompt() {
  let raw;
  try {
    raw = fs.readFileSync(PROMPT_PATH, 'utf8');
  } catch (e) {
    throw new Error('No se pudo leer el system prompt de NETO en ' + PROMPT_PATH + ': ' + e.message
      + ' — el bot no puede arrancar sin él.');
  }
  if (raw.trim().length < 1000) {
    throw new Error('System prompt de NETO sospechosamente corto (' + raw.length + ' bytes) en ' + PROMPT_PATH);
  }
  const faltantes = PLACEHOLDERS.filter(p => !raw.includes('{' + p + '}'));
  if (faltantes.length) {
    throw new Error('System prompt de NETO sin los placeholders esperados: ' + faltantes.join(', '));
  }
  return raw;
}

const RAW_PROMPT = cargarPrompt();
log.info({ tag: 'NETO_PROMPT', bytes: RAW_PROMPT.length, path: PROMPT_PATH }, 'System prompt maestro cargado');

/**
 * Devuelve el system prompt con el contexto del usuario inyectado.
 * @param {{ nombre?: string, plan?: string, mesesHistorial?: number|string, ultimaSync?: string,
 *           correoConectado?: boolean }} datos
 * @returns {string}
 */
function construirNetoPrompt(datos = {}) {
  // Default conservador: sin evidencia de correo conectado, el bot NO afirma que lo lee.
  const correoConectado = datos.correoConectado === true;
  const prompt = RAW_PROMPT
    .replace(/\{MODO_INGESTA\}/g, correoConectado ? INGESTA.conCorreo : INGESTA.sinCorreo)
    .replace(/\{PARSERS_ACTIVOS\}/g, correoConectado
      ? BANCOS
      : 'ninguno (el usuario no conectó su correo; solo se registra lo que él escribe)')
    .replace(/\{NOMBRE_USUARIO\}/g, datos.nombre || 'amigo')
    .replace(/\{PLAN_USUARIO\}/g, datos.plan || 'free')
    .replace(/\{MESES_HISTORIAL\}/g, String(datos.mesesHistorial != null ? datos.mesesHistorial : 3))
    // Sin correo conectado no hay sincronización que reportar: una fecha acá haría que el
    // modelo hable de un escaneo que nunca ocurrió.
    .replace(/\{ULTIMA_SYNC\}/g, correoConectado ? (datos.ultimaSync || 'hoy') : 'no aplica (sin correo conectado)');

  // El bloque de contexto dinámico no puede quedar con variables sin resolver: si alguien
  // agrega {ALGO} al archivo sin cablearlo acá, el modelo lo leería literal y podría repetirlo.
  const bloque = prompt.slice(prompt.indexOf(MARCA_CONTEXTO));
  const sinResolver = bloque.match(/\{[A-Z_]+\}/g);
  if (sinResolver) {
    log.error({ tag: 'NETO_PROMPT', sinResolver: [...new Set(sinResolver)] },
      'Placeholders sin resolver en el bloque de contexto dinámico del system prompt');
  }
  return prompt;
}

module.exports = { construirNetoPrompt, PROMPT_PATH, PLACEHOLDERS, MARCA_CONTEXTO, RAW_PROMPT };
