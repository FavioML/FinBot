const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { hoyPeru } = require('../lib/dates');
const { construirDatosUsuario } = require('./recommendations');

// ═══════════════════════════════════════════════════════════════
// DETECTORS — Each returns array of alert objects
// ═══════════════════════════════════════════════════════════════

/**
 * Detect categories that spiked +30% vs previous month.
 */
function detectarSpikesCategoria(datosUsuario) {
  const alertas = [];
  for (const cat of datosUsuario.categorias) {
    if (cat.variacion_porcentual !== null && cat.variacion_porcentual >= 30 && cat.monto > 50) {
      alertas.push({
        type: 'spike',
        category: cat.nombre,
        amount: cat.monto,
        comparison_amount: cat.monto_mes_anterior,
        detail: {
          variacion: cat.variacion_porcentual,
          diff: Math.round(cat.monto - cat.monto_mes_anterior),
        },
      });
    }
  }
  return alertas;
}

/**
 * Detect ant expenses (gastos hormiga): many small transactions that add up.
 */
function detectarGastosHormiga(datosUsuario) {
  const { cantidad, total } = datosUsuario.gastos_hormiga;
  if (total > 200 || (cantidad >= 15 && total > 150)) {
    return [{
      type: 'ant',
      category: null,
      amount: total,
      comparison_amount: cantidad,
      detail: { cantidad, total },
    }];
  }
  return [];
}

/**
 * Detect recurring patterns: merchants appearing 3+ times this month.
 */
function detectarPatronesRecurrentes(datosUsuario) {
  const alertas = [];
  for (const c of datosUsuario.comercios_top) {
    if (c.frecuencia >= 3 && c.monto_total > 50) {
      alertas.push({
        type: 'recurring',
        category: null,
        amount: c.monto_total,
        comparison_amount: c.frecuencia,
        detail: {
          comercio: c.nombre,
          frecuencia: c.frecuencia,
          ticket_promedio: c.ticket_promedio,
        },
      });
    }
  }
  return alertas.slice(0, 3); // Top 3 recurring
}

/**
 * Project month-end spending vs budget (Pro only).
 */
function detectarProyeccionExceso(datosUsuario) {
  const alertas = [];
  const { proyeccion_cierre, dias_transcurridos } = datosUsuario.mes_actual;

  if (dias_transcurridos < 5) return []; // Too early to project

  for (const p of datosUsuario.presupuestos) {
    if (p.estado === 'ok') {
      // Project: if current pace continues, will they exceed?
      const gastoActual = p.gastado;
      const diasMes = dias_transcurridos + datosUsuario.mes_actual.dias_restantes;
      const proyeccion = (gastoActual / dias_transcurridos) * diasMes;
      const exceso = proyeccion - p.limite;

      if (exceso > 0 && proyeccion / p.limite > 1.15) {
        alertas.push({
          type: 'projection',
          category: p.categoria,
          amount: Math.round(proyeccion),
          comparison_amount: p.limite,
          detail: {
            gastado: p.gastado,
            limite: p.limite,
            proyeccion: Math.round(proyeccion),
            exceso_proyectado: Math.round(exceso),
            dia_actual: dias_transcurridos,
          },
        });
      }
    }
  }
  return alertas;
}

// ═══════════════════════════════════════════════════════════════
// ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Run all detectors and return consolidated alerts.
 * @param {string} usuarioId
 * @param {boolean} isPro - Pro users get projections
 * @returns {Array} alerts sorted by priority
 */
async function generarAlertasFugas(usuarioId, isPro = false) {
  const datosUsuario = await construirDatosUsuario(usuarioId);

  const alertas = [
    ...detectarSpikesCategoria(datosUsuario),
    ...detectarGastosHormiga(datosUsuario),
    ...detectarPatronesRecurrentes(datosUsuario),
    ...(isPro ? detectarProyeccionExceso(datosUsuario) : []),
  ];

  // Sort by amount descending (biggest leaks first)
  alertas.sort((a, b) => b.amount - a.amount);

  return alertas;
}

/**
 * Generate a WhatsApp-formatted message for detected leaks.
 * Uses OpenAI for casual Neto tone.
 */
async function generarMensajeFugas(alertas, nombreUsuario, isPro) {
  if (alertas.length === 0) return null;

  // Build a data summary for GPT
  const resumen = alertas.slice(0, 5).map(a => {
    switch (a.type) {
      case 'spike':
        return `Categoría ${a.category}: S/${a.amount} este mes, +${a.detail.variacion}% vs mes anterior (S/${a.detail.diff} más)`;
      case 'ant':
        return `Gastos hormiga: ${a.detail.cantidad} compras menores a S/20 suman S/${a.detail.total}`;
      case 'recurring':
        return `${a.detail.comercio}: ${a.detail.frecuencia} veces este mes, S/${a.amount} total (promedio S/${a.detail.ticket_promedio})`;
      case 'projection':
        return `Proyección ${a.category}: al ritmo actual llegarás a S/${a.detail.proyeccion} (presupuesto: S/${a.detail.limite})`;
      default:
        return '';
    }
  }).join('\n');

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Eres Neto, asistente financiero peruano. Genera un mensaje corto (máx 6 líneas) alertando al usuario sobre fugas de dinero detectadas. Sé casual, directo, no regañón. Usa jerga peruana moderada. Empieza con un dato curioso o impactante. ${isPro ? 'Incluye 1 recomendación concreta.' : 'Termina invitando a pasar a Pro para más detalles.'} No uses markdown.`
        },
        {
          role: 'user',
          content: `Nombre: ${nombreUsuario || 'amigo'}\n\nFugas detectadas:\n${resumen}`
        }
      ],
      temperature: 0.7,
      max_tokens: 300,
    });

    return res.choices[0].message.content.trim();
  } catch (e) {
    log.error({ tag: 'FUGAS_MSG', err: e.message }, 'Error generando mensaje de fugas');
    // Fallback: simple formatted message
    const primera = alertas[0];
    if (primera.type === 'spike') {
      return `📊 ${nombreUsuario || 'Oe'}, tus gastos en ${primera.category} subieron ${primera.detail.variacion}% este mes (S/${primera.amount}). ¿Todo bajo control?`;
    }
    return `📊 Detecté algunos patrones en tus gastos este mes. Escribe "mis fugas" para ver el detalle.`;
  }
}

/**
 * Persist alerts to spending_alerts table.
 */
async function guardarAlertas(usuarioId, alertas, mensaje) {
  const rows = alertas.slice(0, 5).map(a => ({
    user_id: usuarioId,
    type: a.type,
    category: a.category,
    amount: a.amount,
    comparison_amount: a.comparison_amount,
    message: mensaje,
  }));

  const { error } = await supabase.from('spending_alerts').insert(rows);
  if (error) log.error({ tag: 'FUGAS_SAVE', err: error.message }, 'Error guardando alertas');
}

/**
 * Get alert history for a user.
 */
async function obtenerHistorialAlertas(usuarioId, limit = 20) {
  const { data } = await supabase
    .from('spending_alerts')
    .select('*')
    .eq('user_id', usuarioId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

module.exports = {
  generarAlertasFugas,
  generarMensajeFugas,
  guardarAlertas,
  obtenerHistorialAlertas,
  // Exposed for testing
  detectarSpikesCategoria,
  detectarGastosHormiga,
  detectarPatronesRecurrentes,
  detectarProyeccionExceso,
};
