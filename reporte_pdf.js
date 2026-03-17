// reporte_pdf.js - Reporte mensual 3 paginas - FinBot Peru
// Diseno aprobado: Pag1 Como me fue / Pag2 Donde exactamente / Pag3 Y ahora que
const PDFDocument = require('pdfkit');
const fs = require('fs');

const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// Paleta aprobada
const C = {
  verde:    '#1D9E75',
  ambar:    '#EF9F27',
  rojo:     '#D85A30',
  azul:     '#378ADD',
  grisOsc:  '#2C3E50',
  grisMed:  '#7F8C8D',
  grisClar: '#F4F6F7',
  blanco:   '#FFFFFF',
  negro:    '#1A1A2E',
};

function hex2rgb(hex) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  return [r,g,b];
}

function scoreColor(score) {
  if (score >= 80) return C.verde;
  if (score >= 60) return C.ambar;
  return C.rojo;
}

function scoreLabel(score) {
  if (score >= 80) return 'Excelente';
  if (score >= 60) return 'En camino';
  return 'Atencion';
}

function calcularScore(totalG, totalI, catOrd, presupuestos, txsUsd) {
  let score = 100;
  // Penalizar si gasto > ingreso
  if (totalI > 0 && totalG > totalI) score -= 25;
  else if (totalI > 0 && totalG > totalI * 0.9) score -= 10;
  // Penalizar si supera presupuestos
  let superados = 0;
  catOrd.forEach(([cat, monto]) => {
    const lim = presupuestos[cat] || 0;
    if (lim > 0 && monto > lim) superados++;
  });
  score -= superados * 10;
  // Penalizar gastos USD sin control
  if (txsUsd.length > 5) score -= 5;
  return Math.max(0, Math.min(100, score));
}

function generarReportePDF(data, outputPath) {
  return new Promise((resolve, reject) => {
    const {
      nombre = 'Usuario', mes, anio,
      transacciones = [], presupuestos = {},
      historialMeses = [] // array de {mes, anio, total} ultimos 4 meses
    } = data;

    const mesNum  = mes  || new Date().getMonth() + 1;
    const anioNum = anio || new Date().getFullYear();
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const PW = doc.page.width;   // 595
    const PH = doc.page.height;  // 842
    const M  = 36;               // margen
    const W  = PW - M * 2;
    const fechaGen = new Date().toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });

    // ============================================================
    // CALCULOS COMPARTIDOS
    // ============================================================
    const gastos   = transacciones.filter(t => t.tipo === 'gasto');
    const ingresos = transacciones.filter(t => t.tipo === 'ingreso');
    const totalG   = gastos.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
    const totalI   = ingresos.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
    const ahorro   = totalI - totalG;
    const n        = transacciones.length;

    const porCat = {};
    gastos.forEach(t => {
      const cat = t.categoria || 'Otros';
      porCat[cat] = (porCat[cat] || 0) + parseFloat(t.monto_pen || t.monto || 0);
    });
    const catOrd = Object.entries(porCat).sort((a, b) => b[1] - a[1]);

    // Top comercios
    const porComercio = {};
    gastos.forEach(t => {
      const c = t.comercio || t.banco || 'Sin nombre';
      porComercio[c] = (porComercio[c] || 0) + parseFloat(t.monto_pen || t.monto || 0);
    });
    const topComercio = Object.entries(porComercio).sort((a,b) => b[1]-a[1]).slice(0,5);

    // Metodo de pago
    const porMetodo = {};
    gastos.forEach(t => {
      const mp = t.metodo_pago || t.banco || 'Otro';
      porMetodo[mp] = (porMetodo[mp] || 0) + parseFloat(t.monto_pen || t.monto || 0);
    });

    // Suscripciones (categoria Streaming)
    const suscripciones = gastos.filter(t => t.categoria === 'Streaming');
    const totalSubs = suscripciones.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);

    // Gastos USD
    const txsUsd = gastos.filter(t => t.moneda === 'USD');
    const totalUsd = txsUsd.reduce((s,t) => s + parseFloat(t.monto || 0), 0);
    const totalUsdPen = txsUsd.reduce((s,t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);

    // Score
    const score = calcularScore(totalG, totalI, catOrd, presupuestos, txsUsd);

    // Proyeccion (dias transcurridos del mes)
    const hoy = new Date();
    const diasMes = new Date(anioNum, mesNum, 0).getDate();
    const diaActual = (mesNum === hoy.getMonth()+1 && anioNum === hoy.getFullYear()) ? hoy.getDate() : diasMes;
    const proyeccion = diaActual > 0 ? (totalG / diaActual) * diasMes : totalG;

    // Helper: header de pagina
    function dibujarHeader(tituloIzq, tituloDer, color) {
      doc.rect(0, 0, PW, 52).fill(color || C.verde);
      doc.fontSize(18).fillColor(C.blanco).font('Helvetica-Bold')
         .text('FinBot Peru', M, 14, { width: W/2 });
      doc.fontSize(9).fillColor(C.blanco).font('Helvetica')
         .text(tituloIzq, M, 36, { width: W/2 });
      doc.fontSize(9).fillColor(C.blanco).font('Helvetica')
         .text(tituloDer, M + W/2, 36, { width: W/2, align: 'right' });
    }

    // Helper: footer
    function dibujarFooter(pagina) {
      doc.rect(0, PH - 32, PW, 32).fill(C.negro);
      doc.fontSize(7).fillColor(C.grisMed).font('Helvetica')
         .text('FinBot Peru  |  Generado el ' + fechaGen + '  |  Pagina ' + pagina + ' de 3', M, PH - 20, { width: W, align: 'center' });
    }

    // Helper: barra horizontal
    function barraHorizontal(x, y, ancho, pct, color) {
      doc.rect(x, y, ancho, 8).fill(C.grisClar);
      doc.rect(x, y, Math.max(2, ancho * Math.min(pct, 1)), 8).fill(color || C.verde);
    }

    // Helper: KPI card
    function kpiCard(x, y, w, h, label, valor, sub, colorValor) {
      doc.rect(x, y, w, h).fill(C.grisClar);
      doc.rect(x, y, 3, h).fill(colorValor || C.verde);
      doc.fontSize(7).fillColor(C.grisMed).font('Helvetica')
         .text(label.toUpperCase(), x + 8, y + 6, { width: w - 12 });
      doc.fontSize(18).fillColor(colorValor || C.grisOsc).font('Helvetica-Bold')
         .text(valor, x + 8, y + 16, { width: w - 12 });
      if (sub) {
        doc.fontSize(7).fillColor(C.grisMed).font('Helvetica')
           .text(sub, x + 8, y + 38, { width: w - 12 });
      }
    }

    // ============================================================
    // PAGINA 1 — Como me fue este mes
    // ============================================================
    dibujarHeader(
      MESES[mesNum] + ' ' + anioNum + '  |  ' + nombre,
      n + ' transacciones registradas',
      C.verde
    );

    let Y = 68;

    // Titulo pagina
    doc.fontSize(16).fillColor(C.grisOsc).font('Helvetica-Bold')
       .text('¿Como me fue este mes?', M, Y);
    doc.fontSize(9).fillColor(C.grisMed).font('Helvetica')
       .text('Resumen ejecutivo de tus finanzas en ' + MESES[mesNum], M, Y + 20);
    Y += 42;

    // 3 KPIs principales
    const kW = (W - 16) / 3;
    kpiCard(M,           Y, kW, 56, 'Gastos del mes',   'S/ ' + totalG.toFixed(0),  n + ' transacciones', C.rojo);
    kpiCard(M + kW + 8,  Y, kW, 56, 'Ingresos del mes', 'S/ ' + totalI.toFixed(0),  totalI > 0 ? 'Registrados' : 'Sin ingresos', C.verde);
    kpiCard(M + kW*2+16, Y, kW, 56, 'Ahorro neto',      (ahorro >= 0 ? '+' : '') + 'S/ ' + ahorro.toFixed(0), ahorro >= 0 ? 'Buen trabajo' : 'Gastos mayores a ingresos', ahorro >= 0 ? C.verde : C.rojo);
    Y += 68;

    // Barras por categoria
    doc.fontSize(11).fillColor(C.grisOsc).font('Helvetica-Bold')
       .text('Gastos por categoria', M, Y);
    doc.moveTo(M, Y + 16).lineTo(M + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
    Y += 22;

    const topCats = catOrd.slice(0, 8);
    const maxCat  = topCats.length > 0 ? topCats[0][1] : 1;
    const barW    = W - 160;

    topCats.forEach(([cat, monto]) => {
      const pct    = totalG > 0 ? monto / totalG : 0;
      const pctMax = monto / maxCat;
      const lim    = presupuestos[cat] || 0;
      let barColor = C.verde;
      if (lim > 0 && monto >= lim) barColor = C.rojo;
      else if (lim > 0 && monto >= lim * 0.8) barColor = C.ambar;

      doc.fontSize(8).fillColor(C.grisOsc).font('Helvetica')
         .text(cat.substring(0, 18), M, Y + 2, { width: 110, align: 'right' });
      barraHorizontal(M + 116, Y, barW, pctMax, barColor);
      doc.fontSize(8).fillColor(C.grisMed).font('Helvetica')
         .text('S/ ' + monto.toFixed(0) + '  (' + (pct*100).toFixed(0) + '%)', M + 116 + barW + 6, Y + 1);
      // Linea de limite si existe
      if (lim > 0) {
        const limX = M + 116 + Math.min(barW, (lim / maxCat) * barW);
        doc.moveTo(limX, Y - 1).lineTo(limX, Y + 9).lineWidth(1).stroke(C.ambar);
      }
      Y += 18;
    });
    Y += 10;

    // Alerta IA — insight del mes
    if (Y < PH - 130) {
      const insightMes = totalG > totalI && totalI > 0
        ? 'Tus gastos superaron tus ingresos este mes. Considera revisar tu categoria principal: ' + (catOrd[0] ? catOrd[0][0] : 'Otros') + '.'
        : catOrd[0] && presupuestos[catOrd[0][0]] && catOrd[0][1] >= presupuestos[catOrd[0][0]] * 0.9
          ? 'Tu categoria ' + catOrd[0][0] + ' esta cerca del limite. Llevas S/ ' + catOrd[0][1].toFixed(0) + ' de S/ ' + presupuestos[catOrd[0][0]].toFixed(0) + '.'
          : totalG > 0 ? 'Buen control este mes. Tu mayor gasto fue ' + (catOrd[0] ? catOrd[0][0] : 'Otros') + ' con S/ ' + (catOrd[0] ? catOrd[0][1].toFixed(0) : '0') + '.' : 'Sin gastos registrados este mes.';

      doc.rect(M, Y, W, 42).fill('#FEF9EC');
      doc.rect(M, Y, 3, 42).fill(C.ambar);
      doc.fontSize(8).fillColor(C.ambar).font('Helvetica-Bold')
         .text('INSIGHT DEL MES', M + 10, Y + 7);
      doc.fontSize(9).fillColor(C.grisOsc).font('Helvetica')
         .text(insightMes, M + 10, Y + 19, { width: W - 20 });
      Y += 52;
    }

    dibujarFooter(1);

    // ============================================================
    // PAGINA 2 — Donde exactamente
    // ============================================================
    doc.addPage();
    dibujarHeader(
      MESES[mesNum] + ' ' + anioNum + '  |  ' + nombre,
      'Detalle de gastos',
      C.azul
    );
    Y = 68;

    doc.fontSize(16).fillColor(C.grisOsc).font('Helvetica-Bold')
       .text('¿Donde exactamente?', M, Y);
    doc.fontSize(9).fillColor(C.grisMed).font('Helvetica')
       .text('Top comercios, metodo de pago y suscripciones', M, Y + 20);
    Y += 42;

    // Top 5 comercios
    doc.fontSize(11).fillColor(C.grisOsc).font('Helvetica-Bold')
       .text('Top 5 comercios', M, Y);
    doc.moveTo(M, Y + 16).lineTo(M + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
    Y += 22;

    const maxCom = topComercio.length > 0 ? topComercio[0][1] : 1;
    const barWC  = W - 160;
    topComercio.forEach(([com, monto], i) => {
      const pctMax = monto / maxCom;
      doc.rect(M, Y, 14, 14).fill(C.azul);
      doc.fontSize(7).fillColor(C.blanco).font('Helvetica-Bold')
         .text(String(i+1), M + 4, Y + 3);
      doc.fontSize(8).fillColor(C.grisOsc).font('Helvetica')
         .text(com.substring(0, 24), M + 18, Y + 3, { width: 96 });
      barraHorizontal(M + 116, Y + 2, barWC, pctMax, C.azul);
      doc.fontSize(8).fillColor(C.grisMed).font('Helvetica')
         .text('S/ ' + monto.toFixed(0), M + 116 + barWC + 6, Y + 3);
      Y += 20;
    });
    Y += 12;

    // Metodo de pago
    doc.fontSize(11).fillColor(C.grisOsc).font('Helvetica-Bold')
       .text('Por metodo de pago', M, Y);
    doc.moveTo(M, Y + 16).lineTo(M + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
    Y += 22;

    const metodos = Object.entries(porMetodo).sort((a,b) => b[1]-a[1]);
    const colMP = W / Math.min(metodos.length, 4);
    metodos.slice(0,4).forEach(([mp, monto], i) => {
      const pct = totalG > 0 ? (monto/totalG*100).toFixed(0) : '0';
      doc.rect(M + i * colMP, Y, colMP - 6, 52).fill(C.grisClar);
      doc.fontSize(14).fillColor(C.azul).font('Helvetica-Bold')
         .text(pct + '%', M + i * colMP + 6, Y + 8, { width: colMP - 18 });
      doc.fontSize(7).fillColor(C.grisOsc).font('Helvetica')
         .text(mp.substring(0, 16), M + i * colMP + 6, Y + 28, { width: colMP - 18 });
      doc.fontSize(7).fillColor(C.grisMed).font('Helvetica')
         .text('S/ ' + monto.toFixed(0), M + i * colMP + 6, Y + 40, { width: colMP - 18 });
    });
    Y += 64;

    // Suscripciones detectadas
    if (suscripciones.length > 0) {
      doc.fontSize(11).fillColor(C.grisOsc).font('Helvetica-Bold')
         .text('Suscripciones detectadas', M, Y);
      doc.moveTo(M, Y + 16).lineTo(M + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
      Y += 22;

      // Tabla suscripciones
      const cols = [W*0.40, W*0.25, W*0.20, W*0.15];
      doc.rect(M, Y, W, 16).fill(C.azul);
      ['Servicio', 'Fecha', 'Moneda', 'Monto'].forEach((h, i) => {
        doc.fontSize(7).fillColor(C.blanco).font('Helvetica-Bold')
           .text(h, M + 4 + cols.slice(0,i).reduce((s,c) => s+c, 0), Y + 5, { width: cols[i] });
      });
      Y += 16;

      suscripciones.slice(0, 6).forEach((t, idx) => {
        const bg = idx % 2 === 0 ? C.blanco : C.grisClar;
        doc.rect(M, Y, W, 14).fill(bg);
        const row = [
          (t.comercio || 'Streaming').substring(0, 26),
          t.fecha || '-',
          t.moneda || 'PEN',
          (t.moneda === 'USD' ? '$' : 'S/ ') + parseFloat(t.monto || 0).toFixed(2)
        ];
        row.forEach((val, i) => {
          doc.fontSize(7).fillColor(C.grisOsc).font('Helvetica')
             .text(val, M + 4 + cols.slice(0,i).reduce((s,c) => s+c, 0), Y + 4, { width: cols[i] });
        });
        Y += 14;
      });

      doc.rect(M, Y, W, 14).fill('#EBF5FB');
      doc.fontSize(7).fillColor(C.azul).font('Helvetica-Bold')
         .text('TOTAL SUSCRIPCIONES: S/ ' + totalSubs.toFixed(2), M + 4, Y + 4);
      Y += 22;
    }

    // Evolucion 4 meses
    if (historialMeses && historialMeses.length > 0) {
      Y += 4;
      doc.fontSize(11).fillColor(C.grisOsc).font('Helvetica-Bold')
         .text('Evolucion de gastos', M, Y);
      doc.moveTo(M, Y + 16).lineTo(M + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
      Y += 22;

      const todos = [...historialMeses, { mes: mesNum, anio: anioNum, total: totalG }].slice(-4);
      const maxH = Math.max(...todos.map(m => m.total), 1);
      const colH = W / todos.length;
      const maxBarH = 60;

      todos.forEach((m, i) => {
        const bh = Math.max(4, (m.total / maxH) * maxBarH);
        const cx = M + i * colH;
        const color = i === todos.length - 1 ? C.verde : C.grisMed;
        doc.rect(cx + colH/2 - 16, Y + maxBarH - bh, 32, bh).fill(color);
        doc.fontSize(7).fillColor(C.grisOsc).font('Helvetica')
           .text('S/ ' + m.total.toFixed(0), cx, Y + maxBarH + 4, { width: colH, align: 'center' });
        doc.fontSize(7).fillColor(C.grisMed).font('Helvetica')
           .text(MESES[m.mes].substring(0,3), cx, Y + maxBarH + 14, { width: colH, align: 'center' });
      });
      Y += maxBarH + 28;
    }

    dibujarFooter(2);

    // ============================================================
    // PAGINA 3 — Y ahora que
    // ============================================================
    doc.addPage();
    dibujarHeader(
      MESES[mesNum] + ' ' + anioNum + '  |  ' + nombre,
      'Recomendaciones y proyeccion',
      C.ambar
    );
    Y = 68;

    doc.fontSize(16).fillColor(C.grisOsc).font('Helvetica-Bold')
       .text('¿Y ahora que?', M, Y);
    doc.fontSize(9).fillColor(C.grisMed).font('Helvetica')
       .text('Tu score financiero, proyecciones y acciones concretas', M, Y + 20);
    Y += 42;

    // Score de salud financiera
    doc.fontSize(11).fillColor(C.grisOsc).font('Helvetica-Bold')
       .text('Score de salud financiera', M, Y);
    doc.moveTo(M, Y + 16).lineTo(M + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
    Y += 22;

    const sColor = scoreColor(score);
    const sLabel = scoreLabel(score);
    // Barra de score
    doc.rect(M, Y, W, 28).fill(C.grisClar);
    doc.rect(M, Y, (score / 100) * W, 28).fill(sColor);
    doc.fontSize(14).fillColor(C.blanco).font('Helvetica-Bold')
       .text(score + ' / 100  —  ' + sLabel, M + 8, Y + 7, { width: W - 16 });
    Y += 38;

    // Factores del score
    const factores = [];
    if (totalI > 0 && totalG <= totalI) factores.push({ texto: 'Gastos dentro de ingresos', ok: true });
    else if (totalI > 0) factores.push({ texto: 'Gastos superan ingresos en S/ ' + (totalG - totalI).toFixed(0), ok: false });
    let superados = 0;
    catOrd.forEach(([cat, monto]) => { if (presupuestos[cat] && monto > presupuestos[cat]) superados++; });
    if (superados === 0 && catOrd.length > 0) factores.push({ texto: 'Sin presupuestos superados', ok: true });
    else if (superados > 0) factores.push({ texto: superados + ' categoria(s) superaron su presupuesto', ok: false });
    if (totalSubs > 0) factores.push({ texto: 'Suscripciones: S/ ' + totalSubs.toFixed(0) + '/mes', ok: totalSubs < totalG * 0.15 });

    factores.forEach(f => {
      doc.rect(M, Y, 12, 12).fill(f.ok ? C.verde : C.rojo);
      doc.fontSize(8).fillColor(f.ok ? C.verde : C.rojo).font('Helvetica-Bold')
         .text(f.ok ? '✓' : '✗', M + 2, Y + 2);
      doc.fontSize(8).fillColor(C.grisOsc).font('Helvetica')
         .text(f.texto, M + 18, Y + 2, { width: W - 20 });
      Y += 16;
    });
    Y += 12;

    // Gastos en dolares con tipo de cambio
    if (txsUsd.length > 0) {
      doc.fontSize(11).fillColor(C.grisOsc).font('Helvetica-Bold')
         .text('Gastos en dolares (USD)', M, Y);
      doc.moveTo(M, Y + 16).lineTo(M + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
      Y += 22;

      // Promedio TC
      const tcPromedio = txsUsd.reduce((s,t) => s + parseFloat(t.tipo_cambio || 3.85), 0) / txsUsd.length;

      doc.rect(M, Y, W, 44).fill(C.grisClar);
      doc.rect(M, Y, 3, 44).fill(C.azul);
      doc.fontSize(8).fillColor(C.grisMed).font('Helvetica')
         .text('TOTAL EN USD', M + 10, Y + 7);
      doc.fontSize(18).fillColor(C.azul).font('Helvetica-Bold')
         .text('$' + totalUsd.toFixed(2), M + 10, Y + 17);
      doc.fontSize(8).fillColor(C.grisMed).font('Helvetica')
         .text('= S/ ' + totalUsdPen.toFixed(2) + ' al tipo de cambio promedio S/ ' + tcPromedio.toFixed(3), M + 10, Y + 38);
      Y += 54;
    }

    // Proyeccion mes siguiente
    doc.fontSize(11).fillColor(C.grisOsc).font('Helvetica-Bold')
       .text('Proyeccion del mes', M, Y);
    doc.moveTo(M, Y + 16).lineTo(M + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
    Y += 22;

    const diffProy = totalI > 0 ? totalI - proyeccion : 0;
    const colP = W / 2 - 4;
    kpiCard(M,          Y, colP, 52, 'Proyeccion de gastos', 'S/ ' + proyeccion.toFixed(0), 'Basado en ritmo actual del mes', proyeccion > totalI && totalI > 0 ? C.rojo : C.ambar);
    kpiCard(M+colP+8,   Y, colP, 52, 'Margen disponible', (diffProy >= 0 ? '+' : '') + 'S/ ' + diffProy.toFixed(0), totalI > 0 ? 'vs ingresos registrados' : 'Sin ingresos registrados', diffProy >= 0 ? C.verde : C.rojo);
    Y += 64;

    // 3 acciones concretas
    doc.fontSize(11).fillColor(C.grisOsc).font('Helvetica-Bold')
       .text('3 acciones para el proximo mes', M, Y);
    doc.moveTo(M, Y + 16).lineTo(M + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
    Y += 22;

    // Generar acciones basadas en datos reales
    const acciones = [];
    if (catOrd[0]) {
      const top1 = catOrd[0];
      const lim1 = presupuestos[top1[0]] || 0;
      if (lim1 > 0 && top1[1] > lim1) {
        acciones.push('Reduce ' + top1[0] + ' en S/ ' + (top1[1] - lim1).toFixed(0) + ' para estar dentro de tu presupuesto.');
      } else {
        acciones.push('Tu mayor gasto es ' + top1[0] + ' (S/ ' + top1[1].toFixed(0) + '). Considera asignarle un presupuesto si no tienes uno.');
      }
    }
    if (totalSubs > 0 && totalSubs > totalG * 0.12) {
      acciones.push('Tus suscripciones suman S/ ' + totalSubs.toFixed(0) + '/mes. Revisa si usas todos los servicios activamente.');
    } else if (catOrd.length > 1) {
      const top2 = catOrd[1];
      acciones.push('Monitorea ' + top2[0] + ' (S/ ' + top2[1].toFixed(0) + '). Es tu segunda categoria de mayor gasto.');
    }
    if (ahorro < 0 && totalI > 0) {
      acciones.push('Tus gastos superaron tus ingresos en S/ ' + Math.abs(ahorro).toFixed(0) + '. Para el proximo mes apunta a gastar maximo S/ ' + (totalI * 0.9).toFixed(0) + '.');
    } else if (ahorro >= 0 && totalI > 0) {
      acciones.push('Ahorraste S/ ' + ahorro.toFixed(0) + ' este mes. Mantiene ese ritmo el proximo mes.');
    } else {
      acciones.push('Registra tus ingresos en FinBot para un analisis financiero completo.');
    }

    acciones.slice(0, 3).forEach((accion, i) => {
      doc.rect(M, Y, W, 36).fill(i % 2 === 0 ? '#EBF5FB' : '#FDFEFE');
      doc.rect(M, Y, 28, 36).fill(i === 0 ? C.verde : i === 1 ? C.ambar : C.azul);
      doc.fontSize(13).fillColor(C.blanco).font('Helvetica-Bold')
         .text(String(i+1), M + 8, Y + 10);
      doc.fontSize(8).fillColor(C.grisOsc).font('Helvetica')
         .text(accion, M + 36, Y + 6, { width: W - 42, lineGap: 2 });
      Y += 44;
    });

    // Footer pagina 3
    dibujarFooter(3);

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generarReportePDF };
