// reporte_html.js - Reporte mensual HTML dinamico - NETO
// Basado en diseno aprobado: 3 paginas, paleta verde/ambar/rojo/azul

const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function scoreColor(s) { return s >= 80 ? '#1D9E75' : s >= 60 ? '#BA7517' : '#D85A30'; }
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

function generarReporteHTML(data) {
  const {
    nombre = 'Usuario', mes, anio,
    transacciones = [], presupuestos = {},
    historialMeses = []
  } = data;

  const mesNum  = mes  || new Date().getMonth() + 1;
  const anioNum = anio || new Date().getFullYear();
  const fechaGen = new Date().toLocaleDateString('es-PE', { day:'2-digit', month:'short', year:'numeric' });

  // Calculos
  const gastos   = transacciones.filter(t => t.tipo === 'gasto');
  const ingresos = transacciones.filter(t => t.tipo === 'ingreso');
  const totalG   = gastos.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
  const totalI   = ingresos.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
  const ahorro   = totalI - totalG;
  const pctAhorro = totalI > 0 ? (ahorro / totalI * 100).toFixed(0) : 0;

  const porCat = {};
  gastos.forEach(t => {
    const cat = t.categoria || 'Otros';
    porCat[cat] = (porCat[cat] || 0) + parseFloat(t.monto_pen || t.monto || 0);
  });
  const catOrd = Object.entries(porCat).sort((a,b) => b[1]-a[1]);
  const maxCat  = catOrd.length > 0 ? catOrd[0][1] : 1;

  const porComercio = {};
  gastos.forEach(t => {
    const c = t.comercio || t.banco || 'Sin nombre';
    porComercio[c] = (porComercio[c] || 0) + parseFloat(t.monto_pen || t.monto || 0);
  });
  const topComercio = Object.entries(porComercio).sort((a,b) => b[1]-a[1]).slice(0,5);

  const porMetodo = {};
  gastos.forEach(t => {
    const mp = t.metodo_pago || t.banco || 'Otro';
    porMetodo[mp] = (porMetodo[mp] || 0) + parseFloat(t.monto_pen || t.monto || 0);
  });
  const metodos = Object.entries(porMetodo).sort((a,b) => b[1]-a[1]);
  const maxMetodo = metodos.length > 0 ? metodos[0][1] : 1;

  const suscripciones = gastos.filter(t => t.categoria === 'Entretenimiento' || t.categoria === 'Streaming');
  const totalSubs = suscripciones.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);

  const txsUsd = gastos.filter(t => t.moneda === 'USD');
  const totalUsd = txsUsd.reduce((s,t) => s + parseFloat(t.monto || 0), 0);
  const totalUsdPen = txsUsd.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
  const tcProm = txsUsd.length > 0 ? txsUsd.reduce((s,t) => s + parseFloat(t.tipo_cambio || 3.85), 0) / txsUsd.length : 3.85;

  const score = calcularScore(totalG, totalI, catOrd, presupuestos);

  // Proyeccion
  const hoy = new Date();
  const diasMes = new Date(anioNum, mesNum, 0).getDate();
  const diaActual = (mesNum === hoy.getMonth()+1 && anioNum === hoy.getFullYear()) ? hoy.getDate() : diasMes;
  const proyeccion = diaActual > 0 ? (totalG / diaActual) * diasMes : totalG;
  const gastosFijos = totalSubs + catOrd.filter(([c]) => c === 'Vivienda').reduce((s,[,m]) => s+m, 0);
  const gastoVar = catOrd.filter(([c]) => c !== 'Vivienda' && c !== 'Entretenimiento' && c !== 'Streaming').reduce((s,[,m]) => s+m, 0);

  // Insight del mes
  let insightMes = '';
  let tipoInsight = 'green';
  if (totalG > totalI && totalI > 0) {
    insightMes = 'Tus gastos superaron tus ingresos este mes en S/ ' + (totalG - totalI).toFixed(0) + '. Revisa tu categoria principal: ' + (catOrd[0] ? catOrd[0][0] : 'Otros') + '.';
    tipoInsight = 'alert';
  } else if (catOrd[0] && presupuestos[catOrd[0][0]] && catOrd[0][1] >= presupuestos[catOrd[0][0]] * 0.9) {
    insightMes = 'Tu categoria ' + catOrd[0][0] + ' esta cerca del limite. Llevas S/ ' + catOrd[0][1].toFixed(0) + ' de S/ ' + presupuestos[catOrd[0][0]].toFixed(0) + '.';
    tipoInsight = 'alert';
  } else if (ahorro > 0) {
    insightMes = 'Ahorraste el ' + pctAhorro + '% de tus ingresos este mes. Tu mayor gasto fue ' + (catOrd[0] ? catOrd[0][0] : 'Otros') + ' con S/ ' + (catOrd[0] ? catOrd[0][1].toFixed(0) : '0') + '.';
  } else {
    insightMes = 'Este mes registraste ' + transacciones.length + ' transacciones. Agrega tus ingresos para un analisis completo.';
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
    acciones.push({ texto: 'Mantener nivel de ahorro', pill: pctAhorro + '% del ingreso ahorrado', color: 'green' });
  } else {
    acciones.push({ texto: 'Registrar ingresos en NETO', pill: 'Para analisis completo', color: 'green' });
  }

  // Historial para grafico
  const historial = [...(historialMeses || []).slice(-3), { mes: mesNum, anio: anioNum, total: totalG }];
  const maxHist = Math.max(...historial.map(h => h.total), 1);

  // Barras de categoria - color segun presupuesto
  function colorBarra(cat, monto) {
    const lim = presupuestos[cat] || 0;
    if (lim > 0 && monto >= lim) return '#D85A30';
    if (lim > 0 && monto >= lim * 0.8) return '#EF9F27';
    return '#1D9E75';
  }

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reporte ${MESES[mesNum]} ${anioNum} - NETO</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2C3E50;background:#F0F2F5;padding:16px}
.page{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.page-label{font-size:11px;color:#95A5A6;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
.page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
.page-title{font-size:18px;font-weight:500;color:#1A1A2E}
.page-sub{font-size:13px;color:#7F8C8D;margin-top:2px}
.gen-date{text-align:right;font-size:11px;color:#95A5A6}
.gen-date strong{display:block;font-size:12px;color:#2C3E50}
.row-3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.row-2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.kpi{background:#F4F6F7;border-radius:10px;padding:12px 14px}
.kpi-label{font-size:11px;color:#7F8C8D;margin-bottom:4px}
.kpi-value{font-size:22px;font-weight:500}
.kpi-delta{font-size:11px;margin-top:3px}
.green{color:#1D9E75}.red{color:#D85A30}.amber{color:#BA7517}.blue{color:#378ADD}
.section{border:1px solid #ECF0F1;border-radius:10px;padding:14px;margin-bottom:12px}
.section-title{font-size:11px;font-weight:500;color:#7F8C8D;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:7px}
.bar-label{min-width:100px;color:#7F8C8D;font-size:12px;text-align:right}
.bar-track{flex:1;height:8px;background:#F4F6F7;border-radius:4px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .3s}
.bar-amount{min-width:54px;text-align:right;font-size:12px;font-weight:500;color:#2C3E50}
.insight{background:#E8F8F2;border-left:3px solid #1D9E75;border-radius:0 8px 8px 0;padding:10px 12px;font-size:13px;color:#085041;margin-top:10px;line-height:1.5}
.alert-box{background:#FAECE7;border-left:3px solid #D85A30;border-radius:0 8px 8px 0;padding:10px 12px;font-size:13px;color:#4A1B0C;margin-top:10px;line-height:1.5}
.divider{border:none;border-top:1px solid #F4F6F7;margin:10px 0}
.rec-item{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #F4F6F7;font-size:13px}
.rec-item:last-child{border-bottom:none}
.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:12px;font-weight:500}
.pill-green{background:#EAF3DE;color:#3B6D11}
.pill-red{background:#FCEBEB;color:#A32D2D}
.pill-amber{background:#FAEEDA;color:#854F0B}
.pill-blue{background:#EBF5FB;color:#1A5276}
.month-bars{display:flex;align-items:flex-end;gap:8px;height:70px;margin-bottom:6px}
.mb-col{flex:1;display:flex;flex-direction:column;align-items:center}
.mb-bar{width:100%;border-radius:4px 4px 0 0;min-height:4px}
.mb-label{font-size:10px;color:#95A5A6;margin-top:4px;text-align:center}
.mb-val{font-size:10px;color:#7F8C8D;margin-top:2px;text-align:center}
.score-wrap{display:flex;align-items:center;gap:14px}
.score-circle{width:68px;height:68px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0}
.score-num{font-size:24px;font-weight:500}
.score-lbl{font-size:9px;color:#95A5A6}
.score-factors{font-size:12px;color:#7F8C8D;line-height:1.8}
.proj-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:13px;border-bottom:1px solid #F4F6F7}
.proj-row:last-child{border-bottom:none}
.action-item{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #F4F6F7;font-size:13px}
.action-item:last-child{border-bottom:none}
.num-badge{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;color:#fff;margin-right:8px;flex-shrink:0}
.footer{text-align:center;font-size:11px;color:#BDC3C7;margin-top:8px;padding-top:10px;border-top:1px solid #F4F6F7}
@media print{body{background:#fff;padding:0}.page{box-shadow:none;page-break-after:always}}
</style>
</head>
<body>

<!-- HEADER GLOBAL -->
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding:0 4px">
  <div>
    <div style="font-size:20px;font-weight:600;color:#1D9E75">NETO</div>
    <div style="font-size:12px;color:#95A5A6">Reporte mensual · ${MESES[mesNum]} ${anioNum}</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:12px;color:#2C3E50;font-weight:500">${nombre}</div>
    <div style="font-size:11px;color:#95A5A6">Generado el ${fechaGen}</div>
  </div>
</div>

<!-- PAGINA 1 -->
<div class="page">
  <div class="page-label">Pagina 1 de 3 · Resumen del mes</div>
  <div style="font-size:16px;font-weight:500;margin-bottom:12px">¿Como me fue en ${MESES[mesNum]}?</div>

  <div class="row-3">
    <div class="kpi">
      <div class="kpi-label">Ingresos</div>
      <div class="kpi-value">${totalI > 0 ? 'S/ ' + totalI.toFixed(0) : 'S/ 0'}</div>
      <div class="kpi-delta" style="color:#95A5A6">${transacciones.filter(t=>t.tipo==='ingreso').length} registros</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Gastos</div>
      <div class="kpi-value red">S/ ${totalG.toFixed(0)}</div>
      <div class="kpi-delta" style="color:#95A5A6">${gastos.length} transacciones</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Ahorrado</div>
      <div class="kpi-value ${ahorro >= 0 ? 'green' : 'red'}">${ahorro >= 0 ? 'S/ ' + ahorro.toFixed(0) : '-S/ ' + Math.abs(ahorro).toFixed(0)}</div>
      <div class="kpi-delta ${ahorro >= 0 ? 'green' : 'red'}">${totalI > 0 ? pctAhorro + '% del ingreso' : 'Sin ingresos registrados'}</div>
    </div>
  </div>

  <div class="${tipoInsight === 'alert' ? 'alert-box' : 'insight'}">${insightMes}</div>

  <hr class="divider">
  <div class="section-title" style="margin-top:4px">¿En que gaste?</div>

  ${catOrd.slice(0,8).map(([cat, monto]) => {
    const pct = maxCat > 0 ? (monto/maxCat*100).toFixed(0) : 0;
    const color = colorBarra(cat, monto);
    const lim = presupuestos[cat] || 0;
    const limPct = lim > 0 && maxCat > 0 ? Math.min(100, (lim/maxCat*100)) : 0;
    return `<div class="bar-row">
      <div class="bar-label">${cat.substring(0,16)}</div>
      <div class="bar-track" style="position:relative">
        <div class="bar-fill" style="width:${pct}%;background:${color}"></div>
        ${lim > 0 ? `<div style="position:absolute;top:-2px;left:${limPct}%;width:2px;height:12px;background:#EF9F27;border-radius:1px"></div>` : ''}
      </div>
      <div class="bar-amount">S/ ${monto.toFixed(0)}</div>
    </div>`;
  }).join('')}

  ${catOrd.some(([c,m]) => presupuestos[c] && m > presupuestos[c]) ?
    `<div class="alert-box" style="margin-top:10px">Superaste el presupuesto en: ${catOrd.filter(([c,m]) => presupuestos[c] && m > presupuestos[c]).map(([c,m]) => c + ' (+S/ ' + (m - presupuestos[c]).toFixed(0) + ')').join(', ')}.</div>` :
    catOrd.length > 0 ? `<div class="insight" style="margin-top:10px">Sin presupuestos superados este mes. La linea vertical naranja indica el limite de cada categoria.</div>` : ''
  }
</div>

<!-- PAGINA 2 -->
<div class="page">
  <div class="page-label">Pagina 2 de 3 · Detalle y habitos</div>
  <div style="font-size:16px;font-weight:500;margin-bottom:12px">¿Donde exactamente gaste?</div>

  <div class="row-2">
    <div class="section" style="margin-bottom:0">
      <div class="section-title">Top 5 comercios</div>
      ${topComercio.map(([com, monto], i) => `
      <div class="rec-item">
        <span style="display:flex;align-items:center;gap:6px">
          <span style="width:18px;height:18px;border-radius:50%;background:#378ADD;color:#fff;font-size:10px;font-weight:500;display:inline-flex;align-items:center;justify-content:center">${i+1}</span>
          ${com.substring(0,20)}
        </span>
        <span style="font-weight:500">S/ ${monto.toFixed(0)}</span>
      </div>`).join('')}
    </div>

    <div class="section" style="margin-bottom:0">
      <div class="section-title">Como pague</div>
      ${metodos.slice(0,4).map(([mp, monto]) => {
        const pct = maxMetodo > 0 ? (monto/maxMetodo*100).toFixed(0) : 0;
        return `<div class="bar-row">
          <div class="bar-label">${mp.substring(0,14)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:#378ADD"></div></div>
          <div class="bar-amount">S/ ${monto.toFixed(0)}</div>
        </div>`;
      }).join('')}
      ${metodos.length === 0 ? '<div style="font-size:12px;color:#95A5A6">Sin datos de metodo de pago</div>' : ''}
    </div>
  </div>

  ${suscripciones.length > 0 ? `
  <div class="section">
    <div class="section-title">Gastos fijos detectados</div>
    ${suscripciones.slice(0,5).map(t => `
    <div class="rec-item">
      <span>${(t.comercio || 'Entretenimiento').substring(0,24)}</span>
      <span><span class="pill pill-green">recurrente</span></span>
      <span style="font-weight:500">${t.moneda === 'USD' ? '$' : 'S/ '}${parseFloat(t.monto||0).toFixed(2)}/mes</span>
    </div>`).join('')}
    <div style="font-size:12px;color:#7F8C8D;margin-top:8px">
      Total suscripciones: <strong>S/ ${totalSubs.toFixed(0)}/mes</strong> · S/ ${(totalSubs*12).toFixed(0)} al anio
    </div>
  </div>` : ''}

  <div class="section">
    <div class="section-title">Evolucion de gastos (ultimos 4 meses)</div>
    <div style="display:flex;gap:12px;align-items:flex-end">
      <div style="flex:1">
        <div class="month-bars">
          ${historial.map((h, i) => {
            const heightPct = maxHist > 0 ? (h.total/maxHist*100) : 0;
            const isActual = i === historial.length - 1;
            return `<div class="mb-col">
              <div class="mb-bar" style="height:${Math.max(4, heightPct*0.62).toFixed(0)}px;background:${isActual ? '#1D9E75' : '#B5D4F4'}"></div>
              <div class="mb-label" style="${isActual ? 'font-weight:500;color:#2C3E50' : ''}">${MESES[h.mes].substring(0,3)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div style="font-size:12px;color:#7F8C8D;min-width:120px">
        ${historial.map((h, i) => {
          const isActual = i === historial.length - 1;
          return `<div style="${isActual ? 'font-weight:500;color:#2C3E50' : ''}">${MESES[h.mes].substring(0,3)}: S/ ${h.total.toFixed(0)}</div>`;
        }).join('')}
      </div>
    </div>
  </div>
</div>

<!-- PAGINA 3 -->
<div class="page">
  <div class="page-label">Pagina 3 de 3 · Salud financiera y proximo mes</div>
  <div style="font-size:16px;font-weight:500;margin-bottom:12px">¿Y ahora que?</div>

  <div class="row-2">
    <div class="section" style="margin-bottom:0">
      <div class="section-title">Tu salud financiera</div>
      <div class="score-wrap">
        <div class="score-circle" style="border:3px solid ${scoreColor(score)}">
          <div class="score-num" style="color:${scoreColor(score)}">${score}</div>
          <div class="score-lbl">/100</div>
        </div>
        <div class="score-factors">
          <div style="font-weight:500;color:${scoreColor(score)};margin-bottom:4px">${scoreLabel(score)}</div>
          ${totalI > 0 && totalG <= totalI ? '<div class="green">✓ Gastas dentro de tus ingresos</div>' : totalI > 0 ? '<div class="red">✗ Gastos superan ingresos</div>' : '<div style="color:#95A5A6">~ Sin ingresos registrados</div>'}
          ${catOrd.filter(([c,m]) => presupuestos[c] && m > presupuestos[c]).length === 0 && catOrd.length > 0 ? '<div class="green">✓ Sin presupuestos superados</div>' : catOrd.filter(([c,m]) => presupuestos[c] && m > presupuestos[c]).length > 0 ? `<div class="red">✗ ${catOrd.filter(([c,m]) => presupuestos[c] && m > presupuestos[c]).length} presupuesto(s) superado(s)</div>` : ''}
          ${totalSubs > totalG * 0.12 ? `<div class="amber">~ Suscripciones elevadas (${(totalSubs/totalG*100).toFixed(0)}%)</div>` : totalSubs > 0 ? '<div class="green">✓ Suscripciones bajo control</div>' : ''}
        </div>
      </div>
    </div>

    ${txsUsd.length > 0 ? `
    <div class="section" style="margin-bottom:0">
      <div class="section-title">Gastos en dolares</div>
      ${txsUsd.slice(0,4).map(t => `
      <div class="rec-item">
        <span>${(t.comercio || 'USD').substring(0,20)}</span>
        <span style="font-weight:500">$${parseFloat(t.monto||0).toFixed(2)}</span>
      </div>`).join('')}
      <hr class="divider">
      <div style="font-size:12px;color:#7F8C8D">Total: <strong>$${totalUsd.toFixed(2)}</strong></div>
      <div style="font-size:11px;color:#95A5A6">TC promedio: S/ ${tcProm.toFixed(3)} · Equiv. S/ ${totalUsdPen.toFixed(0)}</div>
    </div>` : `
    <div class="section" style="margin-bottom:0">
      <div class="section-title">Gastos en dolares</div>
      <div style="font-size:12px;color:#95A5A6;padding:10px 0">Sin gastos en USD este mes</div>
    </div>`}
  </div>

  <div class="section">
    <div class="section-title">Proyeccion para el proximo mes</div>
    <div class="proj-row"><span>Gastos fijos estimados</span><span style="font-weight:500">S/ ${gastosFijos.toFixed(0)}</span></div>
    <div class="proj-row"><span>Gastos variables (promedio)</span><span style="font-weight:500">S/ ${gastoVar.toFixed(0)}</span></div>
    <div class="proj-row" style="${proyeccion > totalI && totalI > 0 ? 'color:#D85A30' : ''}">
      <span>Proyeccion total del mes</span>
      <span style="font-weight:500">S/ ${proyeccion.toFixed(0)}</span>
    </div>
    ${totalI > 0 ? `<div class="${ahorro >= 0 ? 'insight' : 'alert-box'}" style="margin-top:8px">
      ${ahorro >= 0 ? 'Si mantienes este ritmo, ahorraras S/ ' + ahorro.toFixed(0) + ' el proximo mes.' : 'Para equilibrar, reduce tus gastos variables en S/ ' + Math.abs(ahorro).toFixed(0) + '.'}
    </div>` : ''}
  </div>

  <div class="section">
    <div class="section-title">3 acciones concretas para este mes</div>
    ${acciones.slice(0,3).map((a, i) => {
      const bgColors = ['#1D9E75','#EF9F27','#378ADD'];
      const pillClass = a.color === 'red' ? 'pill-red' : a.color === 'amber' ? 'pill-amber' : a.color === 'blue' ? 'pill-blue' : 'pill-green';
      return `<div class="action-item">
        <span style="display:flex;align-items:center">
          <span class="num-badge" style="background:${bgColors[i]}">${i+1}</span>
          ${a.texto}
        </span>
        <span class="pill ${pillClass}">${a.pill}</span>
      </div>`;
    }).join('')}
  </div>

  <div class="footer">
    NETO · Reporte generado automaticamente · Los datos provienen de tus correos bancarios
  </div>
</div>

</body>
</html>`;
}

function generarDashboardHTML(usuario, transacciones) {
  const nombre = (usuario.nombre || 'Usuario').split(' ')[0];
  const ahora = new Date();
  const fechaGen = ahora.toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' });

  const meses = [];
  for (let i = 2; i >= 0; i--) {
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
    meses.push({ mes: d.getMonth() + 1, anio: d.getFullYear(), label: d.toLocaleDateString('es-PE', { month: 'short', year: 'numeric' }), total: 0 });
  }
  transacciones.forEach(t => {
    const parts = (t.fecha || '').split('-');
    if (parts.length < 2) return;
    const y = parseInt(parts[0]), m = parseInt(parts[1]);
    const idx = meses.findIndex(mx => mx.mes === m && mx.anio === y);
    if (idx >= 0) meses[idx].total += parseFloat(t.monto_pen || t.monto || 0);
  });
  const mesActual = meses[2];
  const totalTresMeses = meses.reduce((s, m) => s + m.total, 0);
  const promMensual = totalTresMeses / 3;

  const porCat = {};
  transacciones.filter(t => { const parts = (t.fecha||'').split('-'); return parseInt(parts[1]) === mesActual.mes && parseInt(parts[0]) === mesActual.anio; })
    .forEach(t => { const c = t.categoria || 'Otros'; porCat[c] = (porCat[c] || 0) + parseFloat(t.monto_pen || t.monto || 0); });
  const catOrd = Object.entries(porCat).sort((a, b) => b[1] - a[1]);

  const porComercio = {};
  transacciones.forEach(t => { const c = t.comercio || t.banco || 'Sin nombre'; porComercio[c] = (porComercio[c] || 0) + parseFloat(t.monto_pen || t.monto || 0); });
  const topComercio = Object.entries(porComercio).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const col = ['#1D9E75','#3498DB','#F39C12','#E74C3C','#9B59B6','#1ABC9C','#E67E22','#2ECC71'];

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NETO Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F0F4F8;color:#2C3E50}
.hdr{background:linear-gradient(135deg,#1D9E75,#16A085);color:#fff;padding:24px 20px 18px}
.hdr h1{font-size:21px;font-weight:700}.hdr p{font-size:13px;opacity:.85;margin-top:4px}
.wrap{max-width:480px;margin:0 auto;padding:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.card.full{grid-column:1/-1}
.lbl{font-size:11px;color:#7F8C8D;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.val{font-size:22px;font-weight:700;color:#1D9E75}
.sub{font-size:12px;color:#95A5A6;margin-top:4px}
.ch{position:relative;height:200px}
.ch2{position:relative;height:170px}
.stitle{font-size:12px;font-weight:600;color:#7F8C8D;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px}
.row{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:13px}
.rlbl{width:110px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trk{flex:1;height:8px;background:#ECF0F1;border-radius:4px}
.fill{height:100%;border-radius:4px}
.rval{width:65px;text-align:right;font-weight:600;flex-shrink:0}
.ft{text-align:center;font-size:11px;color:#BDC3C7;padding:20px 0 32px}
</style></head><body>
<div class="hdr"><h1>📊 Dashboard — ${nombre}</h1><p>Últimos 3 meses · ${fechaGen}</p></div>
<div class="wrap">
<div class="grid">
  <div class="card"><div class="lbl">Mes actual</div><div class="val">S/ ${mesActual.total.toFixed(0)}</div><div class="sub">${mesActual.label}</div></div>
  <div class="card"><div class="lbl">Promedio/mes</div><div class="val">S/ ${promMensual.toFixed(0)}</div><div class="sub">3 meses</div></div>
  <div class="card full"><div class="lbl">Gastos por mes</div><div class="ch"><canvas id="barC"></canvas></div></div>
  ${catOrd.length > 0 ? `<div class="card full"><div class="lbl">Por categoría — ${mesActual.label}</div><div class="ch2"><canvas id="donutC"></canvas></div></div>` : ''}
</div>
${catOrd.length > 0 ? `<div class="stitle">Desglose categorías</div>${catOrd.map(([c,m],i)=>`<div class="row"><div class="rlbl">${c}</div><div class="trk"><div class="fill" style="width:${Math.min(100,m/mesActual.total*100).toFixed(0)}%;background:${col[i%col.length]}"></div></div><div class="rval">S/ ${m.toFixed(0)}</div></div>`).join('')}` : ''}
${topComercio.length > 0 ? `<div class="stitle">Top comercios (3 meses)</div>${topComercio.map(([c,m],i)=>`<div class="row"><div class="rlbl">${c.substring(0,16)}</div><div class="trk"><div class="fill" style="width:${Math.min(100,totalTresMeses>0?m/totalTresMeses*100:0).toFixed(0)}%;background:${col[i%col.length]}"></div></div><div class="rval">S/ ${m.toFixed(0)}</div></div>`).join('')}` : ''}
<div class="ft">NETO · neto.pe · Datos de tus correos bancarios</div>
</div>
<script>
new Chart(document.getElementById('barC'),{type:'bar',data:{labels:${JSON.stringify(meses.map(m=>m.label))},datasets:[{data:${JSON.stringify(meses.map(m=>parseFloat(m.total.toFixed(2))))},backgroundColor:['#BDC3C7','#BDC3C7','#1D9E75'],borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{color:'#F0F4F8'},ticks:{callback:v=>'S/ '+v}},x:{grid:{display:false}}}}});
${catOrd.length > 0 ? `new Chart(document.getElementById('donutC'),{type:'doughnut',data:{labels:${JSON.stringify(catOrd.map(([c])=>c))},datasets:[{data:${JSON.stringify(catOrd.map(([,m])=>parseFloat(m.toFixed(2))))},backgroundColor:${JSON.stringify(col.slice(0,catOrd.length))},borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{font:{size:11}}}}}});` : ''}
</script></body></html>`;
}

module.exports = { generarReporteHTML, generarDashboardHTML };
