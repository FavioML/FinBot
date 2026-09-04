const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const fs = require('fs');
const path = require('path');
const { detectarSuscripciones } = require('./subscriptions');
const { subcategoriaUtil } = require('../lib/subcategoria');

/**
 * Prompt de recomendaciones. Misma doctrina que `lib/neto-prompt.js`: se lee UNA vez al
 * require y si falta se lanza, para que un deploy roto sea visible en vez de degradarse.
 *
 * Historia: el archivo se movió de `prompts/` a `docs/` en 7941cb0 (31-mar-2026) y esta ruta
 * quedó apuntando al directorio viejo. El ENOENT caía en un `catch` que devolvía `null`, y
 * los dos call sites tenían fallback (mini-recomendación heurística en `ver_recomendaciones`,
 * bloque omitido en el resumen mensual). Resultado: `generarRecomendaciones` devolvió `null`
 * en el 100% de las llamadas durante ~4 meses sin que nada lo delatara.
 */
const PROMPT_RECOM_PATH = path.join(__dirname, '..', 'prompts', 'NETO_recomendaciones_prompt.md');

function cargarPromptRecomendaciones() {
  let raw;
  try {
    raw = fs.readFileSync(PROMPT_RECOM_PATH, 'utf8');
  } catch (e) {
    throw new Error('No se pudo leer el prompt de recomendaciones en ' + PROMPT_RECOM_PATH + ': '
      + e.message + ' — sin él, las recomendaciones IA caen en silencio al fallback.');
  }
  // Los 3 placeholders que el código inyecta abajo. Si el archivo pierde alguno, el modelo
  // recibiría un "{SCORE_ACTUAL}" literal y hablaría del score equivocado.
  const faltantes = ['NOMBRE_USUARIO', 'SCORE_ACTUAL', 'SCORE_MES_ANTERIOR']
    .filter(p => !raw.includes('{' + p + '}'));
  if (faltantes.length) {
    throw new Error('Prompt de recomendaciones sin los placeholders esperados: ' + faltantes.join(', '));
  }
  return raw;
}

const PROMPT_RECOM = cargarPromptRecomendaciones();
log.info({ tag: 'RECOM', bytes: PROMPT_RECOM.length, path: PROMPT_RECOM_PATH }, 'Prompt de recomendaciones cargado');

// Benchmarks peruanos de gasto saludable (% del total)
const BENCHMARKS = {
  'Vivienda': { min: 25, max: 35 },
  'Alimentación': { min: 20, max: 30 },
  'Transporte': { min: 8, max: 15 },
  'Finanzas': { min: 0, max: 15 },
  'Entretenimiento': { min: 5, max: 10 },
  'Salud': { min: 3, max: 8 },
  'Educación': { min: 5, max: 10 },
  'Compras': { min: 5, max: 10 },
};

// ═══════════════════════════════════════════════════════════════
// SCORE CALCULATOR (replica exacta del reporte_html.js)
// ═══════════════════════════════════════════════════════════════
function calcularScore(gastos, ingresos, presupuestosExcedidos) {
  let score = 75;
  if (ingresos > 0) {
    const ratio = gastos / ingresos;
    if (ratio <= 0.7) score += 15;
    else if (ratio <= 1.0) score += 5;
    else score -= 20;
  }
  score -= (presupuestosExcedidos || 0) * 8;
  return Math.max(0, Math.min(100, score));
}

function scoreLabel(score) {
  if (score >= 80) return 'Excelente';
  if (score >= 60) return 'En camino';
  return 'Atención';
}

// Simula score si el usuario reduce gasto en una categoría
function simularScore(gastosActuales, ingresos, presExcedidos, reduccion, quitaExceso) {
  const nuevosGastos = gastosActuales - reduccion;
  const nuevosExcedidos = Math.max(0, presExcedidos - (quitaExceso ? 1 : 0));
  return calcularScore(nuevosGastos, ingresos, nuevosExcedidos);
}

// ═══════════════════════════════════════════════════════════════
// DATA BUILDER — Arma el JSON completo del usuario desde Supabase
// ═══════════════════════════════════════════════════════════════
async function construirDatosUsuario(usuarioId) {
  const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const mesActual = hoy.getMonth() + 1;
  const anioActual = hoy.getFullYear();
  const primeroDeMes = anioActual + '-' + String(mesActual).padStart(2, '0') + '-01';
  const diasMes = new Date(anioActual, mesActual, 0).getDate();
  const diaActual = hoy.getDate();
  const diasRestantes = diasMes - diaActual;
  // Cota SUPERIOR del mes en curso. Sin ella, `.gte(primeroDeMes)` metía una tx con
  // fecha FUTURA (un ingreso tipeado con el año siguiente, un gasto de agosto) dentro
  // del mes actual: inflaba ingresos/gastos y, por ahí, los factores savings y budget
  // del Neto Score que el cron persiste. El webapp fresh-calc (api/score/route.ts) ya
  // acota el mes con `.lt(monthEnd)`, así que este era el origen de la divergencia
  // backend↔webapp. `fecha` es DATE: `<= último día` ≡ `< primero del mes siguiente`.
  const finDeMes = anioActual + '-' + String(mesActual).padStart(2, '0') + '-' + String(diasMes).padStart(2, '0');

  // Mes anterior
  const mesAnt = mesActual === 1 ? 12 : mesActual - 1;
  const anioAnt = mesActual === 1 ? anioActual - 1 : anioActual;
  const primeroMesAnt = anioAnt + '-' + String(mesAnt).padStart(2, '0') + '-01';
  const ultimoDiaAnt = new Date(anioAnt, mesAnt, 0).getDate();
  const finMesAnt = anioAnt + '-' + String(mesAnt).padStart(2, '0') + '-' + String(ultimoDiaAnt).padStart(2, '0');

  // Queries paralelas.
  // Los `error` NO se descartan: este objeto alimenta el 45% del Neto Score
  // (calcFactorBudget 0.25 + calcFactorSavings 0.20), la viabilidad de metas y las alertas
  // de fugas. Una lectura caída devuelve `data: null`, que aguas arriba es indistinguible de
  // "el usuario no tiene nada", y el número resultante no falla: se MUEVE, y el cron lo
  // persiste. Los tres casos medidos sobre un usuario sano (ver tests):
  //   - presupuestos cae  -> factor budget 100 -> 50  (-12.5 pts)
  //   - ingresos cae      -> factor savings 100 -> 50 (-12.5 pts)
  //   - gastos cae        -> factor savings sube a 100 y analizarViabilidad declara
  //                          "alcanzable" una cuota que no lo es (falla HACIA ARRIBA)
  // Misma doctrina que eea8d1c en neto-score.js: se corta y no se persiste nada.
  const [
    { data: txsMes, error: eTxs },
    { data: txsMesAnt, error: eTxsAnt },
    { data: ingresosMes, error: eIng },
    { data: ingresosMesAnt, error: eIngAnt },
    { data: presupuestos, error: ePres },
  ] = await Promise.all([
    supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
      .eq('tipo', 'gasto').gte('fecha', primeroDeMes).lte('fecha', finDeMes).order('fecha', { ascending: false }),
    supabase.from('transacciones').select('*').eq('usuario_id', usuarioId)
      .eq('tipo', 'gasto').gte('fecha', primeroMesAnt).lte('fecha', finMesAnt),
    supabase.from('transacciones').select('monto, monto_pen').eq('usuario_id', usuarioId)
      .eq('tipo', 'ingreso').gte('fecha', primeroDeMes).lte('fecha', finDeMes),
    supabase.from('transacciones').select('monto, monto_pen').eq('usuario_id', usuarioId)
      .eq('tipo', 'ingreso').gte('fecha', primeroMesAnt).lte('fecha', finMesAnt),
    supabase.from('presupuestos').select('*').eq('usuario_id', usuarioId)
      .eq('mes', mesActual).eq('anio', anioActual),
  ]);

  const errLectura = eTxs || eTxsAnt || eIng || eIngAnt || ePres;
  if (errLectura) {
    log.error({ tag: 'RECOM_DATOS', err: errLectura.message, usuarioId },
      'No se pudieron leer los datos del usuario');
    throw new Error('No se pudieron leer los datos del usuario: ' + errLectura.message);
  }

  const gastos = txsMes || [];
  const gastosAnt = txsMesAnt || [];
  const totalGastos = gastos.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const totalIngresos = (ingresosMes || []).reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const totalGastosAnt = gastosAnt.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);
  const totalIngresosAnt = (ingresosMesAnt || []).reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);

  // Categorías del mes actual
  const porCat = {};
  gastos.forEach(t => {
    const c = t.categoria || 'Otros';
    if (!porCat[c]) porCat[c] = { monto: 0, txs: 0, subs: {} };
    const m = parseFloat(t.monto_pen || t.monto);
    porCat[c].monto += m;
    porCat[c].txs += 1;
    const sub = subcategoriaUtil(t.subcategoria) || '(General)';
    porCat[c].subs[sub] = (porCat[c].subs[sub] || 0) + m;
  });

  // Categorías del mes anterior
  const porCatAnt = {};
  gastosAnt.forEach(t => {
    const c = t.categoria || 'Otros';
    porCatAnt[c] = (porCatAnt[c] || 0) + parseFloat(t.monto_pen || t.monto);
  });

  // Presupuestos con estado.
  // El gasto se busca sin distinguir mayusculas: un gasto "comida" tiene que contar
  // contra el presupuesto "Comida" (mismo criterio que el dashboard desde e46610a).
  // Con la busqueda por clave exacta, una diferencia de mayusculas hacia que el
  // presupuesto viera gastado=0: nunca alertaba "excedido" e inflaba el factor de
  // presupuesto del score.
  const gastoPorCatLower = {};
  for (const [nombre, data] of Object.entries(porCat)) {
    const k = nombre.toLowerCase();
    gastoPorCatLower[k] = (gastoPorCatLower[k] || 0) + data.monto;
  }
  const presConEstado = (presupuestos || []).map(p => {
    const limite = parseFloat(p.monto_limite);
    const gastado = gastoPorCatLower[(p.categoria || '').toLowerCase()] || 0;
    const pct = limite > 0 ? (gastado / limite) * 100 : 0;
    return {
      categoria: p.categoria,
      limite,
      gastado: Math.round(gastado * 100) / 100,
      porcentaje_usado: Math.round(pct),
      estado: pct >= 100 ? 'excedido' : pct >= (p.alerta_porcentaje || 80) ? 'alerta' : 'ok'
    };
  });
  const presExcedidos = presConEstado.filter(p => p.estado === 'excedido').length;

  // Categorías enriquecidas
  const categorias = Object.entries(porCat)
    .sort((a, b) => b[1].monto - a[1].monto)
    .map(([nombre, data]) => {
      const montoAnt = porCatAnt[nombre] || 0;
      const variacion = montoAnt > 0 ? Math.round(((data.monto - montoAnt) / montoAnt) * 100) : null;
      const pres = presConEstado.find(p => p.categoria === nombre);
      const subsTop = Object.entries(data.subs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([n, m]) => ({ nombre: n, monto: Math.round(m * 100) / 100 }));
      return {
        nombre,
        monto: Math.round(data.monto * 100) / 100,
        porcentaje_del_total: totalGastos > 0 ? Math.round((data.monto / totalGastos) * 100) : 0,
        monto_mes_anterior: Math.round(montoAnt * 100) / 100,
        variacion_porcentual: variacion,
        presupuesto: pres ? pres.limite : null,
        presupuesto_usado_pct: pres ? pres.porcentaje_usado : null,
        transacciones: data.txs,
        subcategorias_top: subsTop
      };
    });

  // Patrones temporales — día de la semana
  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const gastoPorDia = {};
  const contPorDia = {};
  gastos.forEach(t => {
    const d = new Date(t.fecha + 'T12:00:00');
    const dia = dias[d.getDay()];
    gastoPorDia[dia] = (gastoPorDia[dia] || 0) + parseFloat(t.monto_pen || t.monto);
    contPorDia[dia] = (contPorDia[dia] || 0) + 1;
  });
  const diasSemana = Object.entries(gastoPorDia)
    .map(([dia, total]) => ({ dia, promedio: Math.round((total / (contPorDia[dia] || 1)) * 100) / 100, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);

  // Semanas del mes
  const semanasMap = {};
  gastos.forEach(t => {
    const d = new Date(t.fecha + 'T12:00:00').getDate();
    const sem = Math.ceil(d / 7);
    semanasMap[sem] = (semanasMap[sem] || 0) + parseFloat(t.monto_pen || t.monto);
  });
  const semanas = Object.entries(semanasMap)
    .map(([s, total]) => ({ semana: parseInt(s), total: Math.round(total * 100) / 100 }))
    .sort((a, b) => a.semana - b.semana);

  // Gastos recurrentes (comercios que aparecen 2+ meses)
  const comerciosRecurrentes = [];
  const comerciosMes = {};
  gastos.forEach(t => {
    const c = t.comercio || t.banco || '';
    if (c) comerciosMes[c.toLowerCase()] = { nombre: c, monto: (comerciosMes[c.toLowerCase()]?.monto || 0) + parseFloat(t.monto_pen || t.monto), cat: t.categoria };
  });
  const comerciosMesAnt = {};
  gastosAnt.forEach(t => {
    const c = t.comercio || t.banco || '';
    if (c) comerciosMesAnt[c.toLowerCase()] = true;
  });
  Object.entries(comerciosMes).forEach(([key, data]) => {
    if (comerciosMesAnt[key]) {
      comerciosRecurrentes.push({
        comercio: data.nombre,
        monto_mensual: Math.round(data.monto * 100) / 100,
        categoria: data.cat,
        meses_consecutivos: 2
      });
    }
  });

  // Comercios top
  const topComercios = {};
  gastos.forEach(t => {
    const c = t.comercio || t.banco || 'Sin nombre';
    if (!topComercios[c]) topComercios[c] = { monto: 0, freq: 0 };
    topComercios[c].monto += parseFloat(t.monto_pen || t.monto);
    topComercios[c].freq += 1;
  });
  const comerciosTop = Object.entries(topComercios)
    .sort((a, b) => b[1].monto - a[1].monto)
    .slice(0, 5)
    .map(([nombre, d]) => ({
      nombre,
      monto_total: Math.round(d.monto * 100) / 100,
      frecuencia: d.freq,
      ticket_promedio: Math.round((d.monto / d.freq) * 100) / 100
    }));

  // Gastos hormiga
  const hormiga = gastos.filter(t => parseFloat(t.monto_pen || t.monto) <= 20);
  const totalHormiga = hormiga.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto), 0);

  // Score actual y anterior
  const presExcedidosAnt = 0; // simplificación: no tenemos presupuestos del mes anterior
  const scoreActual = calcularScore(totalGastos, totalIngresos, presExcedidos);
  const scoreAnterior = totalIngresosAnt > 0 || totalGastosAnt > 0
    ? calcularScore(totalGastosAnt, totalIngresosAnt, presExcedidosAnt)
    : null;

  const gastoDiarioPromedio = diaActual > 0 ? totalGastos / diaActual : 0;
  const proyeccionCierre = gastoDiarioPromedio * diasMes;

  // Detectar suscripciones activas
  let suscripcionesData = { suscripciones_detectadas: [], total_mensual_pen: 0, total_mensual_usd: 0 };
  try {
    suscripcionesData = await detectarSuscripciones(usuarioId);
  } catch (e) {
    log.warn({ tag: 'RECOM', err: e.message }, 'No se pudieron detectar suscripciones');
  }

  return {
    usuario: {
      score_actual: scoreActual,
      score_mes_anterior: scoreAnterior,
      score_tendencia: scoreAnterior === null ? 'nuevo' : scoreActual > scoreAnterior ? 'subiendo' : scoreActual < scoreAnterior ? 'bajando' : 'estable'
    },
    mes_actual: {
      ingresos: Math.round(totalIngresos * 100) / 100,
      gastos: Math.round(totalGastos * 100) / 100,
      balance: Math.round((totalIngresos - totalGastos) * 100) / 100,
      ratio_gastos_ingresos: totalIngresos > 0 ? Math.round((totalGastos / totalIngresos) * 100) / 100 : null,
      dias_transcurridos: diaActual,
      dias_restantes: diasRestantes,
      gasto_diario_promedio: Math.round(gastoDiarioPromedio * 100) / 100,
      proyeccion_cierre: Math.round(proyeccionCierre * 100) / 100
    },
    categorias,
    patrones_temporales: {
      dias_semana_mas_gasto: diasSemana.slice(0, 3),
      semanas_del_mes: semanas
    },
    presupuestos: presConEstado,
    gastos_recurrentes: comerciosRecurrentes.sort((a, b) => b.monto_mensual - a.monto_mensual).slice(0, 10),
    comercios_top: comerciosTop,
    gastos_hormiga: {
      cantidad: hormiga.length,
      total: Math.round(totalHormiga * 100) / 100
    },
    suscripciones: {
      detectadas: suscripcionesData.suscripciones_detectadas.map(s => ({
        nombre: s.nombre,
        tipo: s.tipo,
        moneda: s.moneda,
        monto_mensual: s.monto_detectado,
        monto_pen: s.monto_pen,
        tiene_plan_familiar: s.tiene_plan_familiar,
        meses_consecutivos: s.meses_detectados,
      })),
      total_mensual_pen: suscripcionesData.total_mensual_pen,
      total_mensual_usd: suscripcionesData.total_mensual_usd,
      cantidad: suscripcionesData.suscripciones_detectadas.length,
    },
    comparativa_mensual: {
      mes_actual_vs_anterior: totalGastosAnt > 0 ? Math.round(((totalGastos - totalGastosAnt) / totalGastosAnt) * 100) : null,
      gastos_mes_anterior: Math.round(totalGastosAnt * 100) / 100
    },
    _internos: {
      totalGastos,
      totalIngresos,
      presExcedidos,
      scoreActual,
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// GENERADOR DE RECOMENDACIONES — Llama GPT con el prompt + datos
// ═══════════════════════════════════════════════════════════════
async function generarRecomendaciones(usuarioId, nombreUsuario, variante) {
  try {
    const datos = await construirDatosUsuario(usuarioId);

    // Adaptar instrucción según variante
    let instruccionVariante = '';
    switch (variante) {
      case 'semanal':
        instruccionVariante = 'VARIANTE: Recomendación semanal. Máximo 2 hallazgos + 1 recomendación. Formato corto (3-5 líneas de recomendación). Foco en cambios recientes.';
        break;
      case 'mensual':
        instruccionVariante = 'VARIANTE: Recomendación mensual completa. 3 hallazgos + 3 recomendaciones. Incluir comparativa con mes anterior.';
        break;
      case 'on_demand_score':
        instruccionVariante = 'VARIANTE: El usuario preguntó cómo subir su score. Foco en diagnóstico de score + acciones concretas para mejorar.';
        break;
      case 'on_demand_excesos':
        instruccionVariante = 'VARIANTE: El usuario preguntó dónde se excede. Foco en excesos + patrones temporales.';
        break;
      case 'on_demand_general':
      default:
        instruccionVariante = 'VARIANTE: El usuario pide recomendaciones generales. Top 3 hallazgos + 3 recomendaciones priorizadas por impacto.';
        break;
    }

    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: PROMPT_RECOM
            .replace(/\{NOMBRE_USUARIO\}/g, nombreUsuario || 'amigo')
            .replace(/\{SCORE_ACTUAL\}/g, String(datos.usuario.score_actual))
            .replace(/\{SCORE_MES_ANTERIOR\}/g, String(datos.usuario.score_mes_anterior || 'N/A'))
        },
        {
          role: 'user',
          content: instruccionVariante + '\n\nDATOS DEL USUARIO:\n' + JSON.stringify(datos, null, 2)
        }
      ],
      temperature: 0.7,
      max_tokens: 1200,
      response_format: { type: 'json_object' }
    });

    const raw = res.choices[0].message.content.trim();
    const resultado = JSON.parse(raw);

    // Extraer solo el mensaje para WhatsApp
    return {
      mensaje: resultado.mensaje_neto || resultado.mensaje || null,
      datos: resultado,
      scoreActual: datos.usuario.score_actual,
      scoreAnterior: datos.usuario.score_mes_anterior,
    };
  } catch (e) {
    log.error({ tag: 'RECOM', err: e.message }, 'Error generando recomendaciones');
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// GENERADOR RÁPIDO — Para insertar en resumen semanal/mensual
// sin llamada extra a GPT (basado solo en datos)
// ═══════════════════════════════════════════════════════════════
function generarMiniRecomendacion(datos, nombreUsuario) {
  const { _internos, categorias, presupuestos, patrones_temporales, gastos_hormiga, mes_actual } = datos;
  const { scoreActual, totalGastos, totalIngresos, presExcedidos } = _internos;
  const nombre = nombreUsuario ? nombreUsuario.split(' ')[0] : null;
  const hallazgos = [];

  // Excesos de categoría vs mes anterior
  for (const cat of categorias.slice(0, 5)) {
    if (cat.variacion_porcentual !== null && cat.variacion_porcentual > 30 && cat.monto > 50) {
      const diff = cat.monto - cat.monto_mes_anterior;
      hallazgos.push({
        prioridad: diff,
        texto: cat.nombre + ' subió S/' + diff.toFixed(0) + ' (+' + cat.variacion_porcentual + '% vs mes pasado)'
      });
    }
  }

  // Presupuestos excedidos
  for (const p of presupuestos) {
    if (p.estado === 'excedido') {
      const exceso = p.gastado - p.limite;
      hallazgos.push({
        prioridad: exceso + 100, // prioridad alta
        texto: p.categoria + ' excedió presupuesto por S/' + exceso.toFixed(0) + ' (S/' + p.gastado.toFixed(0) + ' de S/' + p.limite.toFixed(0) + ')'
      });
    }
  }

  // Gastos hormiga
  if (gastos_hormiga.total > 200 && gastos_hormiga.cantidad >= 10) {
    hallazgos.push({
      prioridad: gastos_hormiga.total,
      texto: gastos_hormiga.cantidad + ' gastos menores a S/20 suman S/' + gastos_hormiga.total.toFixed(0) + ' este mes'
    });
  }

  // Día más caro
  const diaMasCaro = patrones_temporales.dias_semana_mas_gasto[0];
  const diaBarato = patrones_temporales.dias_semana_mas_gasto[patrones_temporales.dias_semana_mas_gasto.length - 1];
  if (diaMasCaro && diaBarato && diaMasCaro.total > diaBarato.total * 1.8) {
    hallazgos.push({
      prioridad: diaMasCaro.total - diaBarato.total,
      texto: 'Los ' + diaMasCaro.dia.toLowerCase() + ' gastas S/' + diaMasCaro.promedio.toFixed(0) + ' promedio — el doble que otros días'
    });
  }

  // Ordenar por prioridad y tomar top 2
  hallazgos.sort((a, b) => b.prioridad - a.prioridad);
  const top = hallazgos.slice(0, 2);

  if (top.length === 0) return null;

  // Construir acción principal
  let accion = '';
  const excedidos = presupuestos.filter(p => p.estado === 'excedido');
  if (excedidos.length > 0) {
    const cat = excedidos[0].categoria;
    const scoreSi = simularScore(totalGastos, totalIngresos, presExcedidos, 0, true);
    if (scoreSi > scoreActual) {
      accion = 'Si controlamos ' + cat + ', tu score sube a ' + scoreSi + ' (' + scoreLabel(scoreSi) + ')';
    }
  } else if (totalIngresos > 0 && totalGastos / totalIngresos > 0.7) {
    const reducir = totalGastos - (totalIngresos * 0.7);
    accion = 'Reduciendo S/' + reducir.toFixed(0) + ' tu score pasa a Excelente';
  }

  let msg = '📊 Score: ' + scoreActual + '/100 (' + scoreLabel(scoreActual) + ')\n\n';
  top.forEach(h => { msg += '→ ' + h.texto + '\n'; });
  if (accion) msg += '\n💡 ' + accion;

  return msg;
}

// ═══════════════════════════════════════════════════════════════
// DETECTORES DE ALERTAS PROACTIVAS
// ═══════════════════════════════════════════════════════════════
async function verificarAlertasProactivas(usuarioId, nombreUsuario) {
  try {
    const datos = await construirDatosUsuario(usuarioId);
    const alertas = [];
    const nombre = nombreUsuario ? nombreUsuario.split(' ')[0] : '';

    // Alerta: presupuesto al 80%+
    for (const p of datos.presupuestos) {
      if (p.estado === 'alerta' && p.porcentaje_usado < 100) {
        alertas.push(
          'Llevas S/' + p.gastado.toFixed(0) + ' de S/' + p.limite.toFixed(0) +
          ' en ' + p.categoria + '. Quedan ' + datos.mes_actual.dias_restantes + ' días. ¿Le bajamos el ritmo?'
        );
      }
    }

    // Alerta: score bajó 10+ puntos vs mes anterior
    if (datos.usuario.score_mes_anterior !== null &&
        datos.usuario.score_actual < datos.usuario.score_mes_anterior - 10) {
      alertas.push(
        (nombre ? nombre + ', e' : 'E') + 'l score bajó de ' +
        datos.usuario.score_mes_anterior + ' a ' + datos.usuario.score_actual +
        '. ' + (datos.presupuestos.filter(p => p.estado === 'excedido').length > 0
          ? 'Hay presupuestos excedidos.'
          : 'Los gastos superan el ritmo del mes pasado.') +
        ' ¿Lo revisamos?'
      );
    }

    return alertas.length > 0 ? alertas[0] : null; // Solo la alerta más importante
  } catch (e) {
    log.error({ tag: 'RECOM_ALERTA', err: e.message }, 'Error verificando alertas proactivas');
    return null;
  }
}

module.exports = {
  construirDatosUsuario,
  generarRecomendaciones,
  generarMiniRecomendacion,
  verificarAlertasProactivas,
  calcularScore,
  simularScore,
  scoreLabel,
  PROMPT_RECOM_PATH,
};
