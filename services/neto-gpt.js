const { openai } = require('../lib/ai');
const log = require('../lib/logger');

async function redactarConNETO(netoPrompt, contexto, mensajeOriginal, historial) {
  try {
    const mensajes = [{ role: 'system', content: netoPrompt }];
    if (historial && historial.length > 0) {
      historial.forEach(h => {
        mensajes.push({ role: h.rol === 'neto' ? 'assistant' : 'user', content: h.mensaje });
      });
    }
    mensajes.push({ role: 'user', content: 'Mensaje del usuario: "' + mensajeOriginal + '"\n\nDatos disponibles:\n' + contexto + '\n\nRedacta la respuesta de NETO. Maximo 6 lineas. Sé directo y breve. NO hagas preguntas al final. Sin markdown pesado.' });
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      temperature: 0.7,
      messages: mensajes,
      timeout: 30000,
    });
    return res.choices[0].message.content.trim();
  } catch(e) {
    log.error({ tag: 'NETO_GPT', err: e.message }, 'Error redactando con GPT');
    return null;
  }
}

module.exports = { redactarConNETO };
