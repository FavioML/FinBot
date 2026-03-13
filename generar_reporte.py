#!/usr/bin/env python3
"""
FinBot Peru - Generador de Reporte Mensual PDF
Uso: python3 generar_reporte.py '<json_data>' <output_path>
"""
import sys
import json
import os
from datetime import datetime

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether
)
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.graphics import renderPDF

VERDE      = colors.HexColor('#25D366')
VERDE_OSC  = colors.HexColor('#128C7E')
GRIS_OSC   = colors.HexColor('#2C3E50')
GRIS_MED   = colors.HexColor('#7F8C8D')
GRIS_CLAR  = colors.HexColor('#ECF0F1')
ROJO       = colors.HexColor('#E74C3C')
AMARILLO   = colors.HexColor('#F39C12')
BLANCO     = colors.white

MESES_ES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
            'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

def grafico_barras(categorias, montos, ancho=420, alto=160):
    d = Drawing(ancho, alto)
    if not categorias:
        return d
    max_monto = max(montos) if montos else 1
    margen_izq = 110
    margen_inf  = 20
    area_ancho  = ancho - margen_izq - 10
    area_alto   = alto - margen_inf - 10
    barra_alto  = max(8, area_alto // len(categorias) - 6)
    gap         = (area_alto - barra_alto * len(categorias)) // (len(categorias) + 1)
    for i, (cat, monto) in enumerate(zip(categorias, montos)):
        y = margen_inf + gap * (i + 1) + barra_alto * i
        pct = monto / max_monto if max_monto > 0 else 0
        bar_w = max(2, int(area_ancho * pct))
        d.add(String(margen_izq - 5, y + barra_alto // 2 - 4,
                     cat[:15], fontSize=7, fillColor=GRIS_OSC, textAnchor='end'))
        d.add(Rect(margen_izq, y, bar_w, barra_alto,
                   fillColor=VERDE, strokeColor=None))
        d.add(String(margen_izq + bar_w + 3, y + barra_alto // 2 - 4,
                     'S/ ' + str(int(monto)), fontSize=7, fillColor=GRIS_MED))
    return d

def generar_pdf(data, output_path):
    nombre   = data.get('nombre', 'Usuario')
    mes      = data.get('mes', datetime.now().month)
    anio     = data.get('anio', datetime.now().year)
    txs      = data.get('transacciones', [])
    presups  = data.get('presupuestos', {})

    doc = SimpleDocTemplate(output_path, pagesize=A4,
        leftMargin=1.8*cm, rightMargin=1.8*cm,
        topMargin=1.5*cm, bottomMargin=1.5*cm)

    styles = getSampleStyleSheet()
    W = A4[0] - 3.6*cm

    titulo_sty = ParagraphStyle('T', fontName='Helvetica-Bold', fontSize=22,
        textColor=BLANCO, alignment=TA_CENTER, leading=26)
    sub_sty = ParagraphStyle('S', fontName='Helvetica', fontSize=10,
        textColor=BLANCO, alignment=TA_CENTER, leading=14)
    h1_sty = ParagraphStyle('H1', fontName='Helvetica-Bold', fontSize=13,
        textColor=GRIS_OSC, spaceBefore=14, spaceAfter=6)
    normal_sty = ParagraphStyle('N', fontName='Helvetica', fontSize=9,
        textColor=GRIS_OSC, leading=13)
    small_sty = ParagraphStyle('Sm', fontName='Helvetica', fontSize=8,
        textColor=GRIS_OSC, leading=11)
    bold_sty = ParagraphStyle('B', fontName='Helvetica-Bold', fontSize=9,
        textColor=GRIS_OSC)
    num_sty = ParagraphStyle('Num', fontName='Helvetica-Bold', fontSize=18,
        textColor=VERDE_OSC, alignment=TA_CENTER)
    lbl_sty = ParagraphStyle('Lbl', fontName='Helvetica', fontSize=8,
        textColor=GRIS_MED, alignment=TA_CENTER)

    story = []

    ht = Table([[Paragraph('<font color="white"><b>FinBot Peru</b></font>', titulo_sty)]], colWidths=[W])
    ht.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),VERDE_OSC),('TOPPADDING',(0,0),(-1,-1),16),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
    story.append(ht)

    st = Table([[Paragraph('Reporte mensual de gastos e ingresos', sub_sty)],[Paragraph(MESES_ES[mes]+' '+str(anio)+'  |  '+nombre, sub_sty)]], colWidths=[W])
    st.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),VERDE),('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),10)]))
    story.append(st)
    story.append(Spacer(1, 14))

    gastos   = [t for t in txs if t.get('tipo') == 'gasto']
    ingresos = [t for t in txs if t.get('tipo') == 'ingreso']
    total_g  = sum(float(t.get('monto',0)) for t in gastos)
    total_i  = sum(float(t.get('monto',0)) for t in ingresos)
    balance  = total_i - total_g
    bal_col  = VERDE_OSC if balance >= 0 else ROJO
    bal_sty  = ParagraphStyle('Bal', fontName='Helvetica-Bold', fontSize=18,
                               textColor=bal_col, alignment=TA_CENTER)

    por_cat = {}
    for t in gastos:
        cat = t.get('categoria') or 'Otro'
        por_cat[cat] = por_cat.get(cat, 0) + float(t.get('monto',0))
    por_cat_ord = sorted(por_cat.items(), key=lambda x: x[1], reverse=True)

    card_w = W / 4
    cards = Table([
        [Paragraph('S/ '+'{:,.2f}'.format(total_g), num_sty),
         Paragraph('S/ '+'{:,.2f}'.format(total_i), num_sty),
         Paragraph('S/ '+'{:,.2f}'.format(abs(balance)), bal_sty),
         Paragraph(str(len(txs)), num_sty)],
        [Paragraph('Total Gastos', lbl_sty),
         Paragraph('Total Ingresos', lbl_sty),
         Paragraph('Balance '+('(+)' if balance >= 0 else '(-)'), lbl_sty),
         Paragraph('Transacciones', lbl_sty)]
    ], colWidths=[card_w]*4)
    cards.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),GRIS_CLAR),
        ('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),8),
        ('LINEAFTER',(0,0),(2,-1),1,BLANCO)]))
    story.append(cards)
    story.append(Spacer(1, 16))

    if por_cat_ord:
        story.append(Paragraph('Gastos por categoria', h1_sty))
        story.append(HRFlowable(width=W, thickness=1, color=GRIS_CLAR))
        story.append(Spacer(1, 8))
        cats = [c for c,_ in por_cat_ord[:8]]
        montos = [m for _,m in por_cat_ord[:8]]
        story.append(grafico_barras(cats, montos, ancho=int(W), alto=max(120, len(cats)*22+20)))
        story.append(Spacer(1, 14))

        story.append(Paragraph('Detalle por categoria', h1_sty))
        story.append(HRFlowable(width=W, thickness=1, color=GRIS_CLAR))
        story.append(Spacer(1, 6))

        rows = [[Paragraph('<b>Categoria</b>',bold_sty),Paragraph('<b>Monto</b>',bold_sty),
                 Paragraph('<b>%</b>',bold_sty),Paragraph('<b>Presupuesto</b>',bold_sty),
                 Paragraph('<b>Estado</b>',bold_sty)]]
        for cat, monto in por_cat_ord:
            pct_t = (monto/total_g*100) if total_g > 0 else 0
            lim = presups.get(cat, 0)
            if lim > 0:
                pp = monto/lim*100
                et = str(int(pp))+'%'
                ec = ROJO if pp >= 100 else (AMARILLO if pp >= 80 else VERDE)
                pt = 'S/ '+'{:,.2f}'.format(lim)
            else:
                et = 'Sin limite'; ec = GRIS_MED; pt = '-'
            rows.append([
                Paragraph(cat, normal_sty),
                Paragraph('S/ '+'{:,.2f}'.format(monto), normal_sty),
                Paragraph('{:.1f}%'.format(pct_t), normal_sty),
                Paragraph(pt, normal_sty),
                Paragraph('<font color="#'+ec.hexval()[2:]+'"><b>'+et+'</b></font>', normal_sty)
            ])
        rows.append([Paragraph('<b>TOTAL</b>',bold_sty),
                     Paragraph('<b>S/ '+'{:,.2f}'.format(total_g)+'</b>',bold_sty),
                     Paragraph('<b>100%</b>',bold_sty),
                     Paragraph('',normal_sty),Paragraph('',normal_sty)])

        cw = [W*0.28,W*0.20,W*0.12,W*0.22,W*0.18]
        ct = Table(rows, colWidths=cw)
        ct.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,0),VERDE_OSC),('TEXTCOLOR',(0,0),(-1,0),BLANCO),
            ('ROWBACKGROUNDS',(0,1),(-1,-2),[BLANCO,GRIS_CLAR]),
            ('BACKGROUND',(0,-1),(-1,-1),colors.HexColor('#D5F5E3')),
            ('GRID',(0,0),(-1,-1),0.3,GRIS_CLAR),
            ('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5),
            ('LEFTPADDING',(0,0),(-1,-1),6)
        ]))
        story.append(ct)
        story.append(Spacer(1, 16))

    if txs:
        story.append(Paragraph('Ultimas transacciones', h1_sty))
        story.append(HRFlowable(width=W, thickness=1, color=GRIS_CLAR))
        story.append(Spacer(1, 6))
        tx_rows = [[Paragraph('<b>Fecha</b>',bold_sty),Paragraph('<b>Comercio</b>',bold_sty),
                    Paragraph('<b>Categoria</b>',bold_sty),Paragraph('<b>Banco</b>',bold_sty),
                    Paragraph('<b>Monto</b>',bold_sty)]]
        for t in sorted(txs, key=lambda x: x.get('fecha',''), reverse=True)[:20]:
            eg = t.get('tipo') == 'gasto'
            mt = ('-' if eg else '+') + ' S/ ' + '{:,.2f}'.format(float(t.get('monto',0)))
            mc = ROJO if eg else VERDE_OSC
            tx_rows.append([
                Paragraph((t.get('fecha','')[:10] or '-'), small_sty),
                Paragraph((t.get('comercio') or '-')[:25], small_sty),
                Paragraph((t.get('categoria') or 'Otro')[:18], small_sty),
                Paragraph((t.get('banco') or '-')[:12], small_sty),
                Paragraph('<font color="#'+mc.hexval()[2:]+'"><b>'+mt+'</b></font>', small_sty)
            ])
        tt = Table(tx_rows, colWidths=[W*0.14,W*0.30,W*0.20,W*0.16,W*0.20])
        tt.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,0),GRIS_OSC),('TEXTCOLOR',(0,0),(-1,0),BLANCO),
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[BLANCO,GRIS_CLAR]),
            ('GRID',(0,0),(-1,-1),0.3,GRIS_CLAR),
            ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4),
            ('LEFTPADDING',(0,0),(-1,-1),5)
        ]))
        story.append(tt)
        story.append(Spacer(1, 16))

    ft = Table([[Paragraph('<font color="white">FinBot Peru  |  Generado el '+datetime.now().strftime('%d/%m/%Y %H:%M')+'  |  finbot.pe</font>',
        ParagraphStyle('F',fontName='Helvetica',fontSize=8,textColor=BLANCO,alignment=TA_CENTER))]], colWidths=[W])
    ft.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),VERDE_OSC),
        ('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8)]))
    story.append(ft)
    doc.build(story)
    print('PDF generado: '+output_path)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Uso: python3 generar_reporte.py <json_data> <output_path>')
        sys.exit(1)
    generar_pdf(json.loads(sys.argv[1]), sys.argv[2])