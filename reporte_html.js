// reporte_html.js - Reporte mensual HTML dinamico - NETO
// Diseno dark premium con glass morphism, inspirado en Mooned Finance Dashboard

const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function scoreColor(s) { return s >= 80 ? '#1D9E75' : s >= 60 ? '#EF9F27' : '#D85A30'; }
function scoreLabel(s) { return s >= 80 ? 'Excelente' : s >= 60 ? 'En camino' : 'Atencion'; }

function calcularScore(totalG, totalI, catOrd, presupuestos) {
  let score = 75;
  if (totalI > 0) {
    if (totalG <= totalI * 0.7) score += 15;
    else if (totalG <= totalI) score += 5;
    else score -= 20;
  }
  let superados = catOrd.filter(([cat, m]) => presupuestos[cat] && m > presupuestos[cat]).length;
  score -= superados * 8;
  return Math.max(0, Math.min(100, score));
}

// --- NUEVA FUNCION: genera JSON para el dashboard interactivo ---
function generarReporteJSON(data) {
  const {
    nombre = 'Usuario', mes, anio,
    transacciones = [], presupuestos = {},
    historialMeses = [], todosMeses = []
  } = data;

  const mesNum  = mes  || new Date().getMonth() + 1;
  const anioNum = anio || new Date().getFullYear();
  const fechaGen = new Date().toISOString();

  // Calculos base
  const gastos   = transacciones.filter(t => t.tipo === 'gasto');
  const ingresos = transacciones.filter(t => t.tipo === 'ingreso');
  const totalG   = gastos.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
  const totalI   = ingresos.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
  const ahorro   = totalI - totalG;
  const pctAhorro = totalI > 0 ? parseFloat((ahorro / totalI * 100).toFixed(1)) : 0;

  // Categorias + subcategorias
  const porCat = {};
  const porCatSub = {};
  gastos.forEach(t => {
    const cat = t.categoria || 'Otros';
    const sub = t.subcategoria && t.subcategoria !== 'sin_categoria' ? t.subcategoria : (t.comercio || 'General');
    porCat[cat] = (porCat[cat] || 0) + parseFloat(t.monto_pen || t.monto || 0);
    if (!porCatSub[cat]) porCatSub[cat] = {};
    porCatSub[cat][sub] = (porCatSub[cat][sub] || 0) + parseFloat(t.monto_pen || t.monto || 0);
  });
  const catOrd = Object.entries(porCat).sort((a,b) => b[1]-a[1]);

  const categorias = catOrd.map(([nombre, monto]) => {
    const lim = presupuestos[nombre] || 0;
    const pct = lim > 0 ? parseFloat((monto / lim * 100).toFixed(1)) : 0;
    let color = '#1D9E75';
    if (lim > 0 && monto >= lim) color = '#D85A30';
    else if (lim > 0 && monto >= lim * 0.8) color = '#EF9F27';
    const subcategorias = Object.entries(porCatSub[nombre] || {}).sort((a,b) => b[1]-a[1])
      .map(([n, m]) => ({ nombre: n, monto: parseFloat(m.toFixed(2)) }));
    return { nombre, monto: parseFloat(monto.toFixed(2)), presupuesto: lim, pctPresupuesto: pct, color, subcategorias };
  });

  // Comercios
  const porComercio = {};
  gastos.forEach(t => {
    const c = t.comercio || t.banco || 'Sin nombre';
    porComercio[c] = (porComercio[c] || 0) + parseFloat(t.monto_pen || t.monto || 0);
  });
  const comercios = Object.entries(porComercio).sort((a,b) => b[1]-a[1]).slice(0,5)
    .map(([nombre, monto]) => ({ nombre, monto: parseFloat(monto.toFixed(2)) }));

  // Metodos de pago (combinar banco + tipo para Débito/Crédito)
  const porMetodo = {};
  gastos.forEach(t => {
    const metodo = t.metodo_pago || '';
    const banco = t.banco || '';
    let mp;
    if (metodo === 'Debito' || metodo === 'Credito') {
      mp = banco ? `${banco} ${metodo === 'Debito' ? 'Débito' : 'Crédito'}` : (metodo === 'Debito' ? 'Débito' : 'Crédito');
    } else if (metodo) {
      mp = metodo;
    } else if (banco) {
      mp = banco;
    } else {
      mp = 'Otro';
    }
    porMetodo[mp] = (porMetodo[mp] || 0) + parseFloat(t.monto_pen || t.monto || 0);
  });
  const metodosPago = Object.entries(porMetodo).sort((a,b) => b[1]-a[1])
    .map(([nombre, monto]) => ({ nombre, monto: parseFloat(monto.toFixed(2)) }));

  // Suscripciones — detectar por subcategoria (streaming, suscripciones) o categoria Suscripciones
  const subsSubcats = ['streaming', 'suscripciones', 'suscripcion'];
  const subsTxs = gastos.filter(t =>
    subsSubcats.includes((t.subcategoria || '').toLowerCase()) ||
    (t.categoria || '').toLowerCase() === 'suscripciones'
  );
  // Deduplicar por comercio (mostrar monto unitario, no repetidos)
  const subsMap = {};
  subsTxs.forEach(t => {
    const key = (t.comercio || 'Suscripcion').toLowerCase().trim();
    if (!subsMap[key]) subsMap[key] = { comercio: t.comercio || 'Suscripcion', monto: 0, moneda: t.moneda || 'PEN', count: 0 };
    subsMap[key].monto += parseFloat(t.monto_pen || t.monto || 0);
    subsMap[key].count++;
  });
  const suscripciones = Object.values(subsMap).map(s => ({
    comercio: s.comercio,
    monto: parseFloat((s.monto / s.count).toFixed(2)),
    moneda: s.moneda
  }));
  const totalSubs = suscripciones.reduce((s,t) => s + t.monto, 0);

  // USD
  const txsUsd = gastos.filter(t => t.moneda === 'USD');
  const totalUsd = txsUsd.reduce((s,t) => s + parseFloat(t.monto || 0), 0);
  const totalUsdPen = txsUsd.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
  const tcProm = txsUsd.length > 0 ? txsUsd.reduce((s,t) => s + parseFloat(t.tipo_cambio || 3.85), 0) / txsUsd.length : 3.85;

  // Score
  const score = calcularScore(totalG, totalI, catOrd, presupuestos);
  const factores = [];
  if (totalI > 0) {
    if (totalG <= totalI * 0.7) factores.push({ texto: 'Gastos dentro del 70% del ingreso', estado: 'green' });
    else if (totalG <= totalI) factores.push({ texto: 'Gastos dentro del ingreso', estado: 'amber' });
    else factores.push({ texto: 'Gastos superan el ingreso', estado: 'red' });
  }
  const superados = catOrd.filter(([cat, m]) => presupuestos[cat] && m > presupuestos[cat]).length;
  if (superados > 0) factores.push({ texto: superados + ' presupuesto(s) superado(s)', estado: 'red' });
  else if (Object.keys(presupuestos).length > 0) factores.push({ texto: 'Presupuestos bajo control', estado: 'green' });
  if (totalSubs > totalG * 0.12) factores.push({ texto: 'Suscripciones > 12% del gasto', estado: 'amber' });
  else if (totalSubs > 0) factores.push({ texto: 'Suscripciones controladas', estado: 'green' });

  // Proyeccion
  const hoy = new Date();
  const diasMes = new Date(anioNum, mesNum, 0).getDate();
  const diaActual = (mesNum === hoy.getMonth()+1 && anioNum === hoy.getFullYear()) ? hoy.getDate() : diasMes;
  const proyTotal = diaActual > 0 ? (totalG / diaActual) * diasMes : totalG;
  const gastosFijos = totalSubs + catOrd.filter(([c]) => c === 'Vivienda').reduce((s,[,m]) => s+m, 0);
  const gastoVar = catOrd.filter(([c]) => c !== 'Vivienda' && c !== 'Entretenimiento' && c !== 'Streaming').reduce((s,[,m]) => s+m, 0);

  let proyInsight = '';
  if (totalI > 0 && proyTotal <= totalI) {
    proyInsight = 'Si mantienes este ritmo, ahorraras aprox. S/ ' + (totalI - proyTotal).toFixed(0) + ' este mes.';
  } else if (totalI > 0) {
    proyInsight = 'A este ritmo, excederias tu ingreso en S/ ' + (proyTotal - totalI).toFixed(0) + '. Ajusta tus gastos variables.';
  } else {
    proyInsight = 'Registra tus ingresos para ver si vas a ahorrar este mes.';
  }

  // Insight
  let insightTexto = '';
  let insightTipo = 'green';
  if (totalG > totalI && totalI > 0) {
    insightTexto = 'Tus gastos superaron tus ingresos este mes en S/ ' + (totalG - totalI).toFixed(0) + '. Revisa tu categoria principal: ' + (catOrd[0] ? catOrd[0][0] : 'Otros') + '.';
    insightTipo = 'alert';
  } else if (catOrd[0] && presupuestos[catOrd[0][0]] && catOrd[0][1] >= presupuestos[catOrd[0][0]] * 0.9) {
    insightTexto = 'Tu categoria ' + catOrd[0][0] + ' esta cerca del limite. Llevas S/ ' + catOrd[0][1].toFixed(0) + ' de S/ ' + presupuestos[catOrd[0][0]].toFixed(0) + '.';
    insightTipo = 'alert';
  } else if (ahorro > 0) {
    insightTexto = 'Ahorraste el ' + pctAhorro.toFixed(0) + '% de tus ingresos este mes. Tu mayor gasto fue ' + (catOrd[0] ? catOrd[0][0] : 'Otros') + ' con S/ ' + (catOrd[0] ? catOrd[0][1].toFixed(0) : '0') + '.';
  } else {
    insightTexto = 'Este mes registraste ' + transacciones.length + ' transacciones. Agrega tus ingresos para un analisis completo.';
  }

  // Acciones
  const acciones = [];
  if (catOrd[0]) {
    const lim = presupuestos[catOrd[0][0]] || 0;
    if (lim > 0 && catOrd[0][1] > lim) {
      acciones.push({ texto: 'Reducir ' + catOrd[0][0] + ' en S/ ' + (catOrd[0][1] - lim).toFixed(0), pill: 'Para estar en presupuesto', color: 'amber' });
    } else {
      acciones.push({ texto: 'Asignar presupuesto a ' + catOrd[0][0], pill: 'Tu mayor gasto: S/ ' + catOrd[0][1].toFixed(0), color: 'green' });
    }
  }
  if (totalSubs > totalG * 0.1) {
    acciones.push({ texto: 'Revisar suscripciones activas', pill: 'S/ ' + totalSubs.toFixed(0) + '/mes en streaming', color: 'amber' });
  } else if (catOrd[1]) {
    acciones.push({ texto: 'Monitorear ' + catOrd[1][0], pill: 'Segunda categoria: S/ ' + catOrd[1][1].toFixed(0), color: 'green' });
  }
  if (ahorro < 0 && totalI > 0) {
    acciones.push({ texto: 'Ajustar gastos para el proximo mes', pill: 'Meta: max S/ ' + (totalI * 0.85).toFixed(0), color: 'red' });
  } else if (totalI > 0) {
    acciones.push({ texto: 'Mantener nivel de ahorro', pill: pctAhorro.toFixed(0) + '% del ingreso ahorrado', color: 'green' });
  } else {
    acciones.push({ texto: 'Registrar ingresos en NETO', pill: 'Para analisis completo', color: 'green' });
  }

  // Historial (incluye ingresos para el area chart dual)
  const historialRaw = [...(historialMeses || []).slice(-3)];
  const historial = historialRaw.map(h => ({
    mes: h.mes,
    anio: h.anio,
    label: MESES[h.mes] ? MESES[h.mes].substring(0,3) : 'Mes',
    totalGastos: parseFloat((h.total || 0).toFixed(2)),
    totalIngresos: parseFloat((h.totalIngresos || 0).toFixed(2))
  }));
  // Agregar mes actual
  historial.push({
    mes: mesNum,
    anio: anioNum,
    label: MESES[mesNum] ? MESES[mesNum].substring(0,3) : 'Mes',
    totalGastos: parseFloat(totalG.toFixed(2)),
    totalIngresos: parseFloat(totalI.toFixed(2))
  });

  // Delta vs mes anterior
  const mesAnteriorGasto = historialRaw.length > 0 ? (historialRaw[historialRaw.length - 1].total || 0) : 0;
  const mesAnteriorIngreso = historialRaw.length > 0 ? (historialRaw[historialRaw.length - 1].totalIngresos || 0) : 0;
  const deltaGasto = mesAnteriorGasto > 0 ? parseFloat(((totalG - mesAnteriorGasto) / mesAnteriorGasto * 100).toFixed(1)) : 0;
  const deltaIngreso = mesAnteriorIngreso > 0 ? parseFloat(((totalI - mesAnteriorIngreso) / mesAnteriorIngreso * 100).toFixed(1)) : 0;

  // Transacciones individuales (ultimas 20)
  const txsRecientes = transacciones
    .sort((a,b) => (b.fecha || '').localeCompare(a.fecha || ''))
    .slice(0, 20)
    .map(t => ({
      fecha: t.fecha,
      comercio: t.comercio || t.banco || 'Sin nombre',
      categoria: t.categoria || 'Otros',
      monto: parseFloat(t.monto_pen || t.monto || 0),
      moneda: t.moneda || 'PEN',
      tipo: t.tipo,
      metodo_pago: t.metodo_pago || t.banco || 'Otro'
    }));

  // Meses disponibles para el selector — usa todosMeses (todos los meses con data del usuario)
  const mesesSet = new Set();
  // Fuente principal: todos los meses con transacciones del usuario (query directa)
  (todosMeses || []).forEach(h => {
    if (h.mes && h.anio) mesesSet.add(h.anio + '-' + String(h.mes).padStart(2, '0'));
  });
  // Fallback: extraer de transacciones del mes actual + historial
  transacciones.forEach(t => {
    const parts = (t.fecha || '').split('-');
    if (parts.length >= 2) mesesSet.add(parts[0] + '-' + parts[1]);
  });
  (historialMeses || []).forEach(h => {
    if (h.mes && h.anio) mesesSet.add(h.anio + '-' + String(h.mes).padStart(2, '0'));
  });
  mesesSet.add(anioNum + '-' + String(mesNum).padStart(2, '0'));
  const mesesDisponibles = [...mesesSet].sort().map(s => {
    const [a, m] = s.split('-').map(Number);
    return { mes: m, anio: a, label: MESES[m] ? MESES[m].substring(0,3) + ' ' + a : s };
  });

  return {
    nombre: nombre.split(' ')[0],
    mes: mesNum,
    anio: anioNum,
    mesLabel: MESES[mesNum] || '',
    fechaGeneracion: fechaGen,
    kpis: {
      totalIngresos: parseFloat(totalI.toFixed(2)),
      totalGastos: parseFloat(totalG.toFixed(2)),
      ahorro: parseFloat(ahorro.toFixed(2)),
      pctAhorro,
      deltaGasto,
      deltaIngreso
    },
    categorias,
    comercios,
    metodosPago,
    suscripciones,
    totalSuscripciones: parseFloat(totalSubs.toFixed(2)),
    historial,
    score: {
      valor: score,
      label: scoreLabel(score),
      color: scoreColor(score),
      factores
    },
    proyeccion: {
      fijos: parseFloat(gastosFijos.toFixed(2)),
      variables: parseFloat(gastoVar.toFixed(2)),
      total: parseFloat(proyTotal.toFixed(2)),
      insight: proyInsight
    },
    acciones,
    transacciones: txsRecientes,
    gastosUsd: {
      total: parseFloat(totalUsd.toFixed(2)),
      totalPen: parseFloat(totalUsdPen.toFixed(2)),
      tcPromedio: parseFloat(tcProm.toFixed(4)),
      detalle: txsUsd.map(t => ({
        comercio: t.comercio || 'USD',
        monto: parseFloat(t.monto || 0),
        montoPen: parseFloat(t.monto_pen || t.monto || 0),
        tc: parseFloat(t.tipo_cambio || 3.85)
      }))
    },
    mesesDisponibles,
    insightMes: { texto: insightTexto, tipo: insightTipo }
  };
}

module.exports = { generarReporteJSON };
