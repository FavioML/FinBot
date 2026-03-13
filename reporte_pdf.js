// reporte_pdf.js - Generador de reporte mensual PDF con pdfkit
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

const C = {
  verde:    '#25D366',
  verdeOsc: '#128C7E',
  grisOsc:  '#2C3E50',
  grisMed:  '#7F8C8D',
  grisClar: '#ECF0F1',
  rojo:     '#E74C3C',
  amarillo: '#F39C12',
  blanco:   '#FFFFFF',
};

function generarReportePDF(data, outputPath) {
  return new Promise((resolve, reject) => {
    const { nombre = 'Usuario', mes, anio, transacciones = [], presupuestos = {} } = data;
    const mesNum  = mes  || new Date().getMonth() + 1;
    const anioNum = anio || new Date().getFullYear();

    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const W = doc.page.width  - 80;  // 40 margen c/lado
    const X0 = 40;
    let Y = 40;

    // ── HEADER ──────────────────────────────────────────────────────────────
    doc.rect(X0, Y, W, 56).fill(C.verdeOsc);
    doc.fontSize(24).fillColor(C.blanco).font('Helvetica-Bold')
       .text('FinBot Peru', X0, Y + 10, { width: W, align: 'center' });
    doc.fontSize(11).font('Helvetica')
       .text('Reporte mensual de gastos e ingresos', X0, Y + 38, { width: W, align: 'center' });
    Y += 56;
    doc.rect(X0, Y, W, 28).fill(C.verde);
    doc.fontSize(10).fillColor(C.blanco).font('Helvetica')
       .text(MESES[mesNum] + ' ' + anioNum + '  |  ' + nombre, X0, Y + 9, { width: W, align: 'center' });
    Y += 36;

    // ── CALCULOS ────────────────────────────────────────────────────────────
    const gastos   = transacciones.filter(t => t.tipo === 'gasto');
    const ingresos = transacciones.filter(t => t.tipo === 'ingreso');
    const totalG   = gastos.reduce((s, t) => s + parseFloat(t.monto || 0), 0);
    const totalI   = ingresos.reduce((s, t) => s + parseFloat(t.monto || 0), 0);
    const balance  = totalI - totalG;

    const porCat = {};
    gastos.forEach(t => {
      const cat = t.categoria || 'Otro';
      porCat[cat] = (porCat[cat] || 0) + parseFloat(t.monto || 0);
    });
    const catOrd = Object.entries(porCat).sort((a, b) => b[1] - a[1]);

    // ── TARJETAS RESUMEN ────────────────────────────────────────────────────
    const cW = W / 4;
    const cards = [
      { label: 'Total Gastos',    val: 'S/ ' + totalG.toFixed(2),        col: C.rojo },
      { label: 'Total Ingresos',  val: 'S/ ' + totalI.toFixed(2),        col: C.verdeOsc },
      { label: 'Balance',         val: (balance >= 0 ? '+' : '-') + 'S/ ' + Math.abs(balance).toFixed(2), col: balance >= 0 ? C.verdeOsc : C.rojo },
      { label: 'Transacciones',   val: String(transacciones.length),      col: C.grisOsc },
    ];
    doc.rect(X0, Y, W, 64).fill(C.grisClar);
    cards.forEach((card, i) => {
      const cx = X0 + cW * i;
      if (i > 0) doc.moveTo(cx, Y + 8).lineTo(cx, Y + 56).stroke(C.blanco);
      doc.fontSize(16).fillColor(card.col).font('Helvetica-Bold')
         .text(card.val, cx, Y + 10, { width: cW, align: 'center' });
      doc.fontSize(8).fillColor(C.grisMed).font('Helvetica')
         .text(card.label, cx, Y + 38, { width: cW, align: 'center' });
    });
    Y += 72;

    // ── GRAFICO BARRAS (categorias) ─────────────────────────────────────────
    if (catOrd.length > 0) {
      doc.fontSize(12).fillColor(C.grisOsc).font('Helvetica-Bold')
         .text('Gastos por categoria', X0, Y);
      doc.moveTo(X0, Y + 16).lineTo(X0 + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
      Y += 22;

      const top = catOrd.slice(0, 7);
      const maxM = top[0][1];
      const barH = 14;
      const barAreaW = W - 120;
      const labelW = 110;

      top.forEach(([cat, monto]) => {
        const barW = Math.max(2, (monto / maxM) * barAreaW);
        const pct  = totalG > 0 ? (monto / totalG * 100).toFixed(1) : '0';
        // label
        doc.fontSize(8).fillColor(C.grisOsc).font('Helvetica')
           .text(cat.substring(0, 16), X0, Y + 3, { width: labelW, align: 'right' });
        // barra
        doc.rect(X0 + labelW + 6, Y, barW, barH).fill(C.verde);
        // valor
        doc.fontSize(8).fillColor(C.grisMed)
           .text('S/ ' + monto.toFixed(0) + '  (' + pct + '%)', X0 + labelW + barW + 10, Y + 3);
        Y += barH + 6;
      });
      Y += 8;
    }

    // ── TABLA DETALLE CATEGORIAS ────────────────────────────────────────────
    if (catOrd.length > 0) {
      doc.fontSize(12).fillColor(C.grisOsc).font('Helvetica-Bold')
         .text('Detalle por categoria', X0, Y);
      doc.moveTo(X0, Y + 16).lineTo(X0 + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
      Y += 22;

      const cols = [W*0.28, W*0.20, W*0.12, W*0.22, W*0.18];
      const headers = ['Categoria', 'Monto', '%', 'Presupuesto', 'Estado'];

      // Header fila
      doc.rect(X0, Y, W, 18).fill(C.verdeOsc);
      let xh = X0 + 4;
      headers.forEach((h, i) => {
        doc.fontSize(8).fillColor(C.blanco).font('Helvetica-Bold').text(h, xh, Y + 5, { width: cols[i] });
        xh += cols[i];
      });
      Y += 18;

      catOrd.forEach(([cat, monto], idx) => {
        const bg = idx % 2 === 0 ? C.blanco : C.grisClar;
        doc.rect(X0, Y, W, 16).fill(bg);
        const pctT = totalG > 0 ? (monto / totalG * 100).toFixed(1) : '0';
        const lim  = presupuestos[cat] || 0;
        const presT = lim > 0 ? 'S/ ' + lim.toFixed(2) : '-';
        let estadoT = 'Sin limite', estadoCol = C.grisMed;
        if (lim > 0) {
          const pp = monto / lim * 100;
          estadoT = pp.toFixed(0) + '%';
          estadoCol = pp >= 100 ? C.rojo : (pp >= 80 ? C.amarillo : C.verde);
        }
        const row = [cat, 'S/ ' + monto.toFixed(2), pctT + '%', presT, estadoT];
        const rowCols = [C.grisOsc, C.grisOsc, C.grisOsc, C.grisOsc, estadoCol];
        let xr = X0 + 4;
        row.forEach((val, i) => {
          doc.fontSize(8).fillColor(rowCols[i]).font(i === 4 ? 'Helvetica-Bold' : 'Helvetica')
             .text(val, xr, Y + 4, { width: cols[i] });
          xr += cols[i];
        });
        Y += 16;
      });

      // Fila total
      doc.rect(X0, Y, W, 16).fill('#D5F5E3');
      doc.fontSize(8).fillColor(C.grisOsc).font('Helvetica-Bold').text('TOTAL', X0 + 4, Y + 4, { width: cols[0] });
      doc.text('S/ ' + totalG.toFixed(2), X0 + 4 + cols[0], Y + 4, { width: cols[1] });
      doc.text('100%', X0 + 4 + cols[0] + cols[1], Y + 4, { width: cols[2] });
      Y += 24;
    }

    // ── ULTIMAS TRANSACCIONES ───────────────────────────────────────────────
    if (transacciones.length > 0 && Y < doc.page.height - 200) {
      doc.fontSize(12).fillColor(C.grisOsc).font('Helvetica-Bold')
         .text('Ultimas transacciones', X0, Y);
      doc.moveTo(X0, Y + 16).lineTo(X0 + W, Y + 16).lineWidth(0.5).stroke(C.grisClar);
      Y += 22;

      const tcols = [W*0.14, W*0.30, W*0.20, W*0.16, W*0.20];
      const thead = ['Fecha', 'Comercio', 'Categoria', 'Banco', 'Monto'];
      doc.rect(X0, Y, W, 18).fill(C.grisOsc);
      let xth = X0 + 4;
      thead.forEach((h, i) => {
        doc.fontSize(8).fillColor(C.blanco).font('Helvetica-Bold').text(h, xth, Y + 5, { width: tcols[i] });
        xth += tcols[i];
      });
      Y += 18;

      const txOrd = [...transacciones].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')).slice(0, 15);
      txOrd.forEach((t, idx) => {
        if (Y > doc.page.height - 80) return;
        const bg = idx % 2 === 0 ? C.blanco : C.grisClar;
        doc.rect(X0, Y, W, 15).fill(bg);
        const eg = t.tipo === 'gasto';
        const mt = (eg ? '- ' : '+ ') + 'S/ ' + parseFloat(t.monto || 0).toFixed(2);
        const mc = eg ? C.rojo : C.verdeOsc;
        const row = [
          (t.fecha || '-').substring(0, 10),
          (t.comercio || '-').substring(0, 22),
          (t.categoria || 'Otro').substring(0, 16),
          (t.banco || '-').substring(0, 10),
          mt
        ];
        let xtr = X0 + 4;
        row.forEach((val, i) => {
          const col = i === 4 ? mc : C.grisOsc;
          doc.fontSize(7).fillColor(col).font(i === 4 ? 'Helvetica-Bold' : 'Helvetica')
             .text(val, xtr, Y + 4, { width: tcols[i] });
          xtr += tcols[i];
        });
        Y += 15;
      });
      Y += 8;
    }

    // ── FOOTER ──────────────────────────────────────────────────────────────
    const fY = doc.page.height - 50;
    doc.rect(X0, fY, W, 28).fill(C.verdeOsc);
    const fechaGen = new Date().toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });
    doc.fontSize(8).fillColor(C.blanco).font('Helvetica')
       .text('FinBot Peru  |  Generado el ' + fechaGen + '  |  finbot.pe', X0, fY + 10, { width: W, align: 'center' });

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generarReportePDF };