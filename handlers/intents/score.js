const {
  calcularNetoScore,
  upsertScore,
  obtenerHistorialScore,
  obtenerTendenciaScore,
  scoreLabel,
  factorMasDebil,
} = require('../../services/neto-score');
const { checkProWall } = require('../../helpers/pro-wall');
const { openai } = require('../../lib/ai');
const log = require('../../lib/logger');

const intents = ['ver_neto_score', 'tips_neto_score', 'historial_neto_score'];

async function handle({ intencion, datos, usuario, from, ctx }) {
  const usuarioId = usuario.id;

  switch (intencion) {
    case 'ver_neto_score': {
      // Calculate fresh score and persist
      const result = await upsertScore(usuarioId);
      if (!result) return '❌ No pude calcular tu score. Intenta de nuevo.';

      const trend = await obtenerTendenciaScore(usuarioId);
      const label = scoreLabel(result.score);
      const weakest = factorMasDebil({
        consistency: result.factor_consistency,
        budget: result.factor_budget,
        savings: result.factor_savings,
        goals: result.factor_goals,
        debts: result.factor_debts,
        visibility: result.factor_visibility,
      });

      let trendText = '';
      if (trend && trend.diff !== 0) {
        const arrow = trend.diff > 0 ? '↑' : '↓';
        const sign = trend.diff > 0 ? '+' : '';
        trendText = ` ${arrow} (${sign}${trend.diff} vs semana pasada)`;
      }

      let msg = `📊 *Tu Neto Score es ${result.score}/100* — ${label}${trendText}`;

      // Pro: show factor breakdown and weakest factor
      const { blocked } = checkProWall(usuario, 'netoScoreDetail');
      if (!blocked) {
        msg += '\n\n📋 *Desglose:*';
        msg += `\n• Consistencia: ${result.factor_consistency}/100`;
        msg += `\n• Presupuesto: ${result.factor_budget}/100`;
        msg += `\n• Ahorro: ${result.factor_savings}/100`;
        msg += `\n• Planes: ${result.factor_goals}/100`;
        msg += `\n• Deudas: ${result.factor_debts}/100`;
        msg += `\n• Visibilidad: ${result.factor_visibility}/100`;
        msg += `\n\n💡 Tu punto más débil: *${weakest.label}* (${weakest.score}/100)`;
        msg += '\n\nEscribe "tips score" para consejos personalizados.';
      } else {
        msg += '\n\n🔓 _Pasa a Pro para ver el desglose completo y tips para mejorar._';
      }

      return msg;
    }

    case 'tips_neto_score': {
      const { blocked } = checkProWall(usuario, 'netoScoreTips');
      if (blocked) {
        return '🔒 Los tips personalizados son una función Pro.\n\nCon Pro, Neto analiza tus factores y te dice exactamente qué hacer para subir tu score.\n\n👉 Escribe "ver plan" para más info.';
      }

      const result = await upsertScore(usuarioId);
      if (!result) return '❌ No pude calcular tu score. Intenta de nuevo.';

      const factors = {
        consistency: result.factor_consistency,
        budget: result.factor_budget,
        savings: result.factor_savings,
        goals: result.factor_goals,
        debts: result.factor_debts,
        visibility: result.factor_visibility,
      };

      try {
        const res = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Eres Neto, asistente financiero peruano. Genera 3 tips concretos y accionables para mejorar el Neto Score del usuario. Sé directo, casual y motivador. Usa jerga peruana moderada. Cada tip debe ser específico basado en los factores débiles. Formato: emoji + tip en 1-2 líneas. Sin introducción larga.`
            },
            {
              role: 'user',
              content: `Score actual: ${result.score}/100\nFactores:\n- Consistencia de registro: ${factors.consistency}/100\n- Control de presupuesto: ${factors.budget}/100\n- Capacidad de ahorro: ${factors.savings}/100\n- Progreso en planes: ${factors.goals}/100\n- Gestión de deudas: ${factors.debts}/100\n- Visibilidad financiera: ${factors.visibility}/100\n\nNombre: ${usuario.nombre || 'amigo'}`
            }
          ],
          temperature: 0.7,
          max_tokens: 400,
        });

        const tips = res.choices[0].message.content.trim();
        return `💡 *Tips para subir tu score (${result.score}/100):*\n\n${tips}`;
      } catch (e) {
        log.error({ tag: 'SCORE_TIPS', err: e.message }, 'Error generating tips');
        return '❌ No pude generar los tips. Intenta de nuevo en un momento.';
      }
    }

    case 'historial_neto_score': {
      const { value: maxMonths } = checkProWall(usuario, 'netoScoreHistory');
      const months = maxMonths || 1;
      const historial = await obtenerHistorialScore(usuarioId, months);

      if (historial.length === 0) {
        return '📊 Aún no tengo historial de tu score.\n\nEscribe "mi score" para calcular tu primer Neto Score.';
      }

      let msg = `📈 *Evolución de tu Neto Score (últimos ${months} mes${months > 1 ? 'es' : ''}):*\n`;

      for (const entry of historial) {
        const date = entry.period;
        const label = scoreLabel(entry.score);
        msg += `\n• ${date}: *${entry.score}* — ${label}`;
      }

      if (months <= 1) {
        msg += '\n\n🔓 _Pasa a Pro para ver tu evolución de los últimos 6 meses._';
      }

      return msg;
    }

    default:
      return '❓ No entendí qué quieres saber del score. Prueba con "mi score", "tips score" o "historial score".';
  }
}

module.exports = { intents, handle };
