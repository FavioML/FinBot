const { openai } = require('../lib/ai');
const log = require('../lib/logger');

// `opciones.model` permite subir de modelo en los pocos intents donde la exactitud importa
// más que el costo. gpt-4o-mini falla en los específicos del sistema financiero peruano
// (dice que la CTS se deposita en julio/diciembre, que la administran las AFP, que la
// gratificación aporta a AFP); gpt-4o acierta esos cuatro casos. Medido el 2026-07-22.
async function redactarConNETO(netoPrompt, contexto, mensajeOriginal, historial, opciones = {}) {
  try {
    const mensajes = [{ role: 'system', content: netoPrompt }];
    if (historial && historial.length > 0) {
      historial.forEach(h => {
        mensajes.push({ role: h.rol === 'neto' ? 'assistant' : 'user', content: h.mensaje });
      });
    }
    mensajes.push({ role: 'user', content: 'Mensaje del usuario: "' + mensajeOriginal + '"\n\nDatos disponibles:\n' + contexto + '\n\nRedacta la respuesta de NETO. Maximo 6 lineas. Sé directo y breve. NO hagas preguntas al final. Sin markdown pesado.' });
    // `timeout` es request option del SDK (2do argumento), NO un parámetro del API. Dentro
    // del body el endpoint responde 400 "Unrecognized request argument supplied: timeout"
    // y esta función devolvía null SIEMPRE, así que el usuario solo veía los textos fijos
    // de cada handler y el system prompt de NETO nunca llegaba a redactar nada.
    const res = await openai.chat.completions.create({
      model: opciones.model || 'gpt-4o-mini',
      max_tokens: 400,
      temperature: 0.7,
      messages: mensajes,
    }, { timeout: 30000 });
    return res.choices[0].message.content.trim();
  } catch(e) {
    log.error({ tag: 'NETO_GPT', err: e.message }, 'Error redactando con GPT');
    return null;
  }
}

module.exports = { redactarConNETO };
