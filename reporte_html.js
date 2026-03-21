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
  const metodos = Object.entries(porMetodo).sort((a,b) => b[1]-a[1]);
  const maxMetodo = metodos.length > 0 ? metodos[0][1] : 1;

  const subsSubcatsH = ['streaming', 'suscripciones', 'suscripcion'];
  const suscripciones = gastos.filter(t => subsSubcatsH.includes((t.subcategoria||'').toLowerCase()) || (t.categoria||'').toLowerCase() === 'suscripciones');
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

  // Score SVG ring
  const circumference = 2 * Math.PI * 42;
  const scoreOffset = circumference * (1 - score / 100);

  // Color barra segun presupuesto
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0E0E0C;--bg2:#141412;--bg3:#1A1A17;--bg4:#222220;
  --glass:rgba(255,255,255,.03);--border:rgba(255,255,255,.07);--border2:rgba(255,255,255,.1);
  --txt:#F0EFE8;--txt2:#C8C6BC;--txt3:#8A8880;
  --g:#1D9E75;--a:#EF9F27;--r:#D85A30;--b:#378ADD;
}
body{font-family:'Space Grotesk',sans-serif;color:var(--txt);background:var(--bg);padding:16px;line-height:1.5}

/* Header global */
.report-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:0 4px}
.report-header .brand{display:flex;align-items:center;gap:10px}
.report-header .brand-name{font-size:22px;font-weight:700;color:var(--g)}
.report-header .brand-sub{font-size:12px;color:var(--txt3)}
.report-header .user-info{text-align:right}
.report-header .user-name{font-size:13px;font-weight:500;color:var(--txt)}
.report-header .gen-date{font-size:11px;color:var(--txt3)}

/* Page card */
.page{background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:22px;margin-bottom:16px;position:relative;overflow:hidden}
.page::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--g),var(--a),var(--b));opacity:.6}
.page-label{font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px}
.page-title{font-size:17px;font-weight:600;color:var(--txt);margin-bottom:14px;letter-spacing:-.3px}

/* KPI cards */
.row-3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
.row-2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.kpi{background:var(--glass);border:1px solid var(--border);border-radius:14px;padding:14px 16px;position:relative;overflow:hidden}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:2px}
.kpi.kpi-income::before{background:var(--g)}
.kpi.kpi-expense::before{background:var(--r)}
.kpi.kpi-savings::before{background:${ahorro >= 0 ? 'var(--g)' : 'var(--r)'}}
.kpi-label{font-size:11px;color:var(--txt3);margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em}
.kpi-value{font-size:24px;font-weight:600;letter-spacing:-.5px}
.kpi-delta{font-size:11px;margin-top:4px;color:var(--txt3)}
.green{color:var(--g)}.red{color:var(--r)}.amber{color:var(--a)}.blue{color:var(--b)}

/* Section containers */
.section{background:var(--glass);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:12px}
.section-title{font-size:11px;font-weight:600;color:var(--txt3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}

/* Bar rows */
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.bar-label{min-width:95px;color:var(--txt2);font-size:12px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{flex:1;height:8px;background:rgba(255,255,255,.06);border-radius:6px;overflow:visible;position:relative}
.bar-fill{height:100%;border-radius:6px;transition:width .3s}
.bar-amount{min-width:58px;text-align:right;font-size:12px;font-weight:500;color:var(--txt)}

/* Insight / Alert boxes */
.insight{background:rgba(29,158,117,.08);border-left:3px solid var(--g);border-radius:0 10px 10px 0;padding:12px 14px;font-size:13px;color:#7DCEAE;margin-top:10px;line-height:1.6}
.alert-box{background:rgba(216,90,48,.08);border-left:3px solid var(--r);border-radius:0 10px 10px 0;padding:12px 14px;font-size:13px;color:#E8A088;margin-top:10px;line-height:1.6}

.divider{border:none;border-top:1px solid var(--border);margin:12px 0}

/* Rec items */
.rec-item{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;color:var(--txt2)}
.rec-item:last-child{border-bottom:none}

/* Pills */
.pill{display:inline-block;font-size:10px;padding:3px 10px;border-radius:100px;font-weight:500}
.pill-green{background:rgba(29,158,117,.12);color:#5DC9A0}
.pill-red{background:rgba(216,90,48,.12);color:#E8A088}
.pill-amber{background:rgba(239,159,39,.12);color:#E8B85C}
.pill-blue{background:rgba(55,138,221,.12);color:#6DB3EE}

/* Month bars */
.month-bars{display:flex;align-items:flex-end;gap:10px;height:80px;margin-bottom:8px}
.mb-col{flex:1;display:flex;flex-direction:column;align-items:center}
.mb-bar{width:100%;border-radius:6px 6px 0 0;min-height:4px}
.mb-label{font-size:10px;color:var(--txt3);margin-top:5px;text-align:center}
.mb-val{font-size:10px;color:var(--txt3);margin-top:2px;text-align:center}

/* Score ring */
.score-wrap{display:flex;align-items:center;gap:16px}
.score-ring{flex-shrink:0}
.score-factors{font-size:12px;color:var(--txt2);line-height:2}
.factor-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:middle}

/* Projection rows */
.proj-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;font-size:13px;color:var(--txt2);border-bottom:1px solid var(--border)}
.proj-row:last-child{border-bottom:none}

/* Action items */
.action-item{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px;color:var(--txt2)}
.action-item:last-child{border-bottom:none}
.num-badge{width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#fff;margin-right:10px;flex-shrink:0}

/* Footer */
.report-footer{text-align:center;font-size:11px;color:var(--txt3);margin-top:10px;padding-top:12px;border-top:1px solid var(--border)}

/* Print override — light theme for printing */
@media print{
  :root{--bg:#fff;--bg2:#fff;--bg3:#f8f8f8;--bg4:#f0f0f0;--glass:#f8f8f8;--border:#e8e8e8;--border2:#ddd;--txt:#1a1a1a;--txt2:#555;--txt3:#888}
  body{background:#fff;color:#1a1a1a;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{box-shadow:none;page-break-after:always;border-color:#e8e8e8}
  .page::before{display:none}
  .insight{background:#e8f8f2;color:#085041}
  .alert-box{background:#faece7;color:#4a1b0c}
  .kpi{background:#f8f8f8}
  .section{background:#f8f8f8}
  .pill-green{background:#eaf3de;color:#3b6d11}
  .pill-red{background:#fcebeb;color:#a32d2d}
  .pill-amber{background:#faeeda;color:#854f0b}
}
</style>
</head>
<body>

<!-- HEADER GLOBAL -->
<div class="report-header">
  <div>
    <div class="brand">
      <svg width="28" height="28" viewBox="0 0 80 80" fill="none"><rect width="80" height="80" rx="20" fill="#1D9E75"/><text x="40" y="54" text-anchor="middle" font-family="Arial" font-size="36" font-weight="700" fill="white">N</text><polyline points="16,60 30,44 42,52 64,26" stroke="#EF9F27" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="64" cy="26" r="3.5" fill="#EF9F27"/></svg>
      <span class="brand-name">NETO</span>
    </div>
    <div class="brand-sub">Reporte mensual &middot; ${MESES[mesNum]} ${anioNum}</div>
  </div>
  <div class="user-info">
    <div class="user-name">${nombre}</div>
    <div class="gen-date">Generado el ${fechaGen}</div>
  </div>
</div>

<!-- PAGINA 1 -->
<div class="page">
  <div class="page-label">Pagina 1 de 3 &middot; Resumen del mes</div>
  <div class="page-title">Como me fue en ${MESES[mesNum]}?</div>

  <div class="row-3">
    <div class="kpi kpi-income">
      <div class="kpi-label">Ingresos</div>
      <div class="kpi-value green">${totalI > 0 ? 'S/ ' + totalI.toFixed(0) : 'S/ 0'}</div>
      <div class="kpi-delta">${transacciones.filter(t=>t.tipo==='ingreso').length} registros</div>
    </div>
    <div class="kpi kpi-expense">
      <div class="kpi-label">Gastos</div>
      <div class="kpi-value red">S/ ${totalG.toFixed(0)}</div>
      <div class="kpi-delta">${gastos.length} transacciones</div>
    </div>
    <div class="kpi kpi-savings">
      <div class="kpi-label">Ahorrado</div>
      <div class="kpi-value ${ahorro >= 0 ? 'green' : 'red'}">${ahorro >= 0 ? 'S/ ' + ahorro.toFixed(0) : '-S/ ' + Math.abs(ahorro).toFixed(0)}</div>
      <div class="kpi-delta ${ahorro >= 0 ? 'green' : 'red'}">${totalI > 0 ? pctAhorro + '% del ingreso' : 'Sin ingresos registrados'}</div>
    </div>
  </div>

  <div class="${tipoInsight === 'alert' ? 'alert-box' : 'insight'}">${insightMes}</div>

  <hr class="divider">
  <div class="section-title" style="margin-top:4px">En que gaste?</div>

  ${catOrd.slice(0,8).map(([cat, monto]) => {
    const pct = maxCat > 0 ? (monto/maxCat*100).toFixed(0) : 0;
    const color = colorBarra(cat, monto);
    const lim = presupuestos[cat] || 0;
    const limPct = lim > 0 && maxCat > 0 ? Math.min(100, (lim/maxCat*100)) : 0;
    return `<div class="bar-row">
      <div class="bar-label">${cat.substring(0,16)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${pct}%;background:linear-gradient(90deg,${color},${color}dd)"></div>
        ${lim > 0 ? `<div style="position:absolute;top:-3px;left:${limPct}%;width:2px;height:14px;background:var(--a);border-radius:1px"></div>` : ''}
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
  <div class="page-label">Pagina 2 de 3 &middot; Detalle y habitos</div>
  <div class="page-title">Donde exactamente gaste?</div>

  <div class="row-2">
    <div class="section" style="margin-bottom:0">
      <div class="section-title">Top 5 comercios</div>
      ${topComercio.map(([com, monto], i) => `
      <div class="rec-item">
        <span style="display:flex;align-items:center;gap:8px">
          <span class="num-badge" style="background:var(--b);width:20px;height:20px;font-size:10px">${i+1}</span>
          ${com.substring(0,20)}
        </span>
        <span style="font-weight:500;color:var(--txt)">S/ ${monto.toFixed(0)}</span>
      </div>`).join('')}
    </div>

    <div class="section" style="margin-bottom:0">
      <div class="section-title">Como pague</div>
      ${metodos.slice(0,4).map(([mp, monto]) => {
        const pct = maxMetodo > 0 ? (monto/maxMetodo*100).toFixed(0) : 0;
        return `<div class="bar-row">
          <div class="bar-label">${mp.substring(0,14)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:linear-gradient(90deg,var(--b),#5AADE6)"></div></div>
          <div class="bar-amount">S/ ${monto.toFixed(0)}</div>
        </div>`;
      }).join('')}
      ${metodos.length === 0 ? '<div style="font-size:12px;color:var(--txt3)">Sin datos de metodo de pago</div>' : ''}
    </div>
  </div>

  ${suscripciones.length > 0 ? `
  <div class="section">
    <div class="section-title">Gastos fijos detectados</div>
    ${suscripciones.slice(0,5).map(t => `
    <div class="rec-item">
      <span>${(t.comercio || 'Entretenimiento').substring(0,24)}</span>
      <span><span class="pill pill-green">recurrente</span></span>
      <span style="font-weight:500;color:var(--txt)">${t.moneda === 'USD' ? '$' : 'S/ '}${parseFloat(t.monto||0).toFixed(2)}/mes</span>
    </div>`).join('')}
    <div style="font-size:12px;color:var(--txt3);margin-top:10px">
      Total suscripciones: <strong style="color:var(--txt)">S/ ${totalSubs.toFixed(0)}/mes</strong> &middot; S/ ${(totalSubs*12).toFixed(0)} al anio
    </div>
  </div>` : ''}

  <div class="section">
    <div class="section-title">Evolucion de gastos (ultimos 4 meses)</div>
    <div style="display:flex;gap:14px;align-items:flex-end">
      <div style="flex:1">
        <div class="month-bars">
          ${historial.map((h, i) => {
            const heightPct = maxHist > 0 ? (h.total/maxHist*100) : 0;
            const isActual = i === historial.length - 1;
            return `<div class="mb-col">
              <div class="mb-bar" style="height:${Math.max(4, heightPct*0.65).toFixed(0)}px;background:${isActual ? 'linear-gradient(180deg,var(--g),#0F6E56)' : 'linear-gradient(180deg,rgba(55,138,221,.5),rgba(55,138,221,.2))'}"></div>
              <div class="mb-label" style="${isActual ? 'font-weight:600;color:var(--txt)' : ''}">${MESES[h.mes].substring(0,3)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div style="font-size:12px;color:var(--txt3);min-width:120px">
        ${historial.map((h, i) => {
          const isActual = i === historial.length - 1;
          return `<div style="${isActual ? 'font-weight:500;color:var(--txt)' : ''}">${MESES[h.mes].substring(0,3)}: S/ ${h.total.toFixed(0)}</div>`;
        }).join('')}
      </div>
    </div>
  </div>
</div>

<!-- PAGINA 3 -->
<div class="page">
  <div class="page-label">Pagina 3 de 3 &middot; Salud financiera y proximo mes</div>
  <div class="page-title">Y ahora que?</div>

  <div class="row-2">
    <div class="section" style="margin-bottom:0">
      <div class="section-title">Tu salud financiera</div>
      <div class="score-wrap">
        <svg class="score-ring" width="96" height="96" viewBox="0 0 96 96">
          <circle cx="48" cy="48" r="42" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="6"/>
          <circle cx="48" cy="48" r="42" fill="none" stroke="${scoreColor(score)}" stroke-width="6"
            stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${scoreOffset.toFixed(1)}"
            transform="rotate(-90 48 48)" stroke-linecap="round" style="transition:stroke-dashoffset .8s ease"/>
          <text x="48" y="44" text-anchor="middle" font-family="Space Grotesk,sans-serif" font-size="26" font-weight="700" fill="${scoreColor(score)}">${score}</text>
          <text x="48" y="60" text-anchor="middle" font-family="Space Grotesk,sans-serif" font-size="10" fill="#8A8880">/100</text>
        </svg>
        <div class="score-factors">
          <div style="font-weight:600;color:${scoreColor(score)};margin-bottom:4px;font-size:14px">${scoreLabel(score)}</div>
          ${totalI > 0 && totalG <= totalI ? '<div><span class="factor-dot" style="background:var(--g)"></span>Gastas dentro de tus ingresos</div>' : totalI > 0 ? '<div><span class="factor-dot" style="background:var(--r)"></span>Gastos superan ingresos</div>' : '<div><span class="factor-dot" style="background:var(--txt3)"></span>Sin ingresos registrados</div>'}
          ${catOrd.filter(([c,m]) => presupuestos[c] && m > presupuestos[c]).length === 0 && catOrd.length > 0 ? '<div><span class="factor-dot" style="background:var(--g)"></span>Sin presupuestos superados</div>' : catOrd.filter(([c,m]) => presupuestos[c] && m > presupuestos[c]).length > 0 ? `<div><span class="factor-dot" style="background:var(--r)"></span>${catOrd.filter(([c,m]) => presupuestos[c] && m > presupuestos[c]).length} presupuesto(s) superado(s)</div>` : ''}
          ${totalSubs > totalG * 0.12 ? `<div><span class="factor-dot" style="background:var(--a)"></span>Suscripciones elevadas (${(totalSubs/totalG*100).toFixed(0)}%)</div>` : totalSubs > 0 ? '<div><span class="factor-dot" style="background:var(--g)"></span>Suscripciones bajo control</div>' : ''}
        </div>
      </div>
    </div>

    ${txsUsd.length > 0 ? `
    <div class="section" style="margin-bottom:0">
      <div class="section-title">Gastos en dolares</div>
      ${txsUsd.slice(0,4).map(t => `
      <div class="rec-item">
        <span>${(t.comercio || 'USD').substring(0,20)}</span>
        <span style="font-weight:500;color:var(--txt)">$${parseFloat(t.monto||0).toFixed(2)}</span>
      </div>`).join('')}
      <hr class="divider">
      <div style="font-size:12px;color:var(--txt3)">Total: <strong style="color:var(--txt)">$${totalUsd.toFixed(2)}</strong></div>
      <div style="font-size:11px;color:var(--txt3)">TC promedio: S/ ${tcProm.toFixed(3)} &middot; Equiv. S/ ${totalUsdPen.toFixed(0)}</div>
    </div>` : `
    <div class="section" style="margin-bottom:0">
      <div class="section-title">Gastos en dolares</div>
      <div style="font-size:12px;color:var(--txt3);padding:10px 0">Sin gastos en USD este mes</div>
    </div>`}
  </div>

  <div class="section">
    <div class="section-title">Proyeccion para el proximo mes</div>
    <div class="proj-row"><span>Gastos fijos estimados</span><span style="font-weight:500;color:var(--txt)">S/ ${gastosFijos.toFixed(0)}</span></div>
    <div class="proj-row"><span>Gastos variables (promedio)</span><span style="font-weight:500;color:var(--txt)">S/ ${gastoVar.toFixed(0)}</span></div>
    <div class="proj-row" style="${proyeccion > totalI && totalI > 0 ? 'color:var(--r)' : ''}">
      <span>Proyeccion total del mes</span>
      <span style="font-weight:500;color:var(--txt)">S/ ${proyeccion.toFixed(0)}</span>
    </div>
    ${totalI > 0 ? `<div class="${ahorro >= 0 ? 'insight' : 'alert-box'}" style="margin-top:8px">
      ${ahorro >= 0 ? 'Si mantienes este ritmo, ahorraras S/ ' + ahorro.toFixed(0) + ' el proximo mes.' : 'Para equilibrar, reduce tus gastos variables en S/ ' + Math.abs(ahorro).toFixed(0) + '.'}
    </div>` : ''}
  </div>

  <div class="section">
    <div class="section-title">3 acciones concretas para este mes</div>
    ${acciones.slice(0,3).map((a, i) => {
      const bgColors = ['var(--g)','var(--a)','var(--b)'];
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

  <div class="report-footer">
    NETO &middot; neto.pe &middot; Reporte generado automaticamente &middot; Los datos provienen de tus correos bancarios
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

  const col = ['#1D9E75','#378ADD','#EF9F27','#D85A30','#9B59B6','#1ABC9C','#E67E22','#2ECC71'];

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NETO Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0E0E0C;--bg2:#141412;--bg3:#1A1A17;
  --glass:rgba(255,255,255,.03);--border:rgba(255,255,255,.07);
  --txt:#F0EFE8;--txt2:#C8C6BC;--txt3:#8A8880;
  --g:#1D9E75;--a:#EF9F27;--r:#D85A30;--b:#378ADD;
}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--txt)}
.hdr{background:var(--bg2);border-bottom:1px solid var(--border);padding:24px 20px 20px;display:flex;align-items:center;gap:12px}
.hdr-logo{flex-shrink:0}
.hdr h1{font-size:20px;font-weight:700;letter-spacing:-.3px}
.hdr h1 span{color:var(--g)}
.hdr p{font-size:12px;color:var(--txt3);margin-top:3px}
.wrap{max-width:480px;margin:0 auto;padding:16px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
.card{background:var(--glass);border:1px solid var(--border);border-radius:16px;padding:18px;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--g);opacity:.5}
.card.full{grid-column:1/-1}
.lbl{font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px}
.val{font-size:24px;font-weight:700;color:var(--g);letter-spacing:-.5px}
.sub{font-size:12px;color:var(--txt3);margin-top:4px}
.ch{position:relative;height:200px}
.ch2{position:relative;height:170px}
.stitle{font-size:11px;font-weight:600;color:var(--txt3);text-transform:uppercase;letter-spacing:.06em;margin:16px 0 10px}
.row{display:flex;align-items:center;gap:10px;margin-bottom:9px;font-size:13px}
.rlbl{width:110px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--txt2)}
.trk{flex:1;height:8px;background:rgba(255,255,255,.06);border-radius:6px}
.fill{height:100%;border-radius:6px}
.rval{width:65px;text-align:right;font-weight:600;flex-shrink:0;color:var(--txt)}
.ft{text-align:center;font-size:11px;color:var(--txt3);padding:24px 0 32px}
</style></head><body>
<div class="hdr">
  <div class="hdr-logo">
    <svg width="32" height="32" viewBox="0 0 80 80" fill="none"><rect width="80" height="80" rx="20" fill="#1D9E75"/><text x="40" y="54" text-anchor="middle" font-family="Arial" font-size="36" font-weight="700" fill="white">N</text><polyline points="16,60 30,44 42,52 64,26" stroke="#EF9F27" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="64" cy="26" r="3.5" fill="#EF9F27"/></svg>
  </div>
  <div>
    <h1><span>Dashboard</span> &mdash; ${nombre}</h1>
    <p>Ultimos 3 meses &middot; ${fechaGen}</p>
  </div>
</div>
<div class="wrap">
<div class="grid">
  <div class="card"><div class="lbl">Mes actual</div><div class="val">S/ ${mesActual.total.toFixed(0)}</div><div class="sub">${mesActual.label}</div></div>
  <div class="card"><div class="lbl">Promedio/mes</div><div class="val">S/ ${promMensual.toFixed(0)}</div><div class="sub">3 meses</div></div>
  <div class="card full"><div class="lbl">Gastos por mes</div><div class="ch"><canvas id="barC"></canvas></div></div>
  ${catOrd.length > 0 ? `<div class="card full"><div class="lbl">Por categoria &mdash; ${mesActual.label}</div><div class="ch2"><canvas id="donutC"></canvas></div></div>` : ''}
</div>
${catOrd.length > 0 ? `<div class="stitle">Desglose categorias</div>${catOrd.map(([c,m],i)=>`<div class="row"><div class="rlbl">${c}</div><div class="trk"><div class="fill" style="width:${Math.min(100,m/mesActual.total*100).toFixed(0)}%;background:${col[i%col.length]}"></div></div><div class="rval">S/ ${m.toFixed(0)}</div></div>`).join('')}` : ''}
${topComercio.length > 0 ? `<div class="stitle">Top comercios (3 meses)</div>${topComercio.map(([c,m],i)=>`<div class="row"><div class="rlbl">${c.substring(0,16)}</div><div class="trk"><div class="fill" style="width:${Math.min(100,totalTresMeses>0?m/totalTresMeses*100:0).toFixed(0)}%;background:${col[i%col.length]}"></div></div><div class="rval">S/ ${m.toFixed(0)}</div></div>`).join('')}` : ''}
<div class="ft">NETO &middot; neto.pe &middot; Datos de tus correos bancarios</div>
</div>
<script>
Chart.defaults.color='#8A8880';
Chart.defaults.borderColor='rgba(255,255,255,.06)';
new Chart(document.getElementById('barC'),{type:'bar',data:{labels:${JSON.stringify(meses.map(m=>m.label))},datasets:[{data:${JSON.stringify(meses.map(m=>parseFloat(m.total.toFixed(2))))},backgroundColor:['rgba(55,138,221,.4)','rgba(55,138,221,.4)','#1D9E75'],borderRadius:8,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{color:'rgba(255,255,255,.04)'},ticks:{callback:v=>'S/ '+v,font:{family:'Space Grotesk'}}},x:{grid:{display:false},ticks:{font:{family:'Space Grotesk'}}}}}});
${catOrd.length > 0 ? `new Chart(document.getElementById('donutC'),{type:'doughnut',data:{labels:${JSON.stringify(catOrd.map(([c])=>c))},datasets:[{data:${JSON.stringify(catOrd.map(([,m])=>parseFloat(m.toFixed(2))))},backgroundColor:${JSON.stringify(col.slice(0,catOrd.length))},borderWidth:2,borderColor:'#141412'}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{position:'right',labels:{font:{size:11,family:'Space Grotesk'},color:'#C8C6BC',padding:12,usePointStyle:true,pointStyleWidth:8}}}}});` : ''}
<\/script></body></html>`;
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

module.exports = { generarReporteHTML, generarDashboardHTML, generarReporteJSON };
