/**
 * Carga del system prompt maestro de NETO.
 *
 * FUENTE ÚNICA DE VERDAD: `docs/NETO_system_prompt.txt` (versionado en git, referenciado
 * por docs/BRAND-VOICE.md). No duplicar el archivo en handlers/ ni en ningún otro lado.
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

const PROMPT_PATH = path.join(__dirname, '..', 'docs', 'NETO_system_prompt.txt');

// Contrato: estos son los únicos placeholders que el código inyecta. Deben existir en el
// archivo y el archivo no debe declarar otros en el bloque de contexto dinámico.
const PLACEHOLDERS = ['NOMBRE_USUARIO', 'PLAN_USUARIO', 'MESES_HISTORIAL', 'PARSERS_ACTIVOS', 'ULTIMA_SYNC'];

// Marca del bloque final donde viven las variables inyectadas. Los {PLACEHOLDER} que
// aparecen antes son parte de ejemplos de respuesta y se dejan literales a propósito.
const MARCA_CONTEXTO = 'DATOS DEL USUARIO (CONTEXTO DINÁMICO)';

const PARSERS_ACTIVOS = ['BCP', 'Interbank', 'BBVA', 'Scotiabank', 'Yape', 'Plin'].join(', ');

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
 * @param {{ nombre?: string, plan?: string, mesesHistorial?: number|string, ultimaSync?: string }} datos
 * @returns {string}
 */
function construirNetoPrompt(datos = {}) {
  const prompt = RAW_PROMPT
    .replace(/\{NOMBRE_USUARIO\}/g, datos.nombre || 'amigo')
    .replace(/\{PLAN_USUARIO\}/g, datos.plan || 'free')
    .replace(/\{MESES_HISTORIAL\}/g, String(datos.mesesHistorial != null ? datos.mesesHistorial : 3))
    .replace(/\{PARSERS_ACTIVOS\}/g, PARSERS_ACTIVOS)
    .replace(/\{ULTIMA_SYNC\}/g, datos.ultimaSync || 'hoy');

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
