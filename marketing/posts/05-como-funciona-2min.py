"""
Neto — Post 5: Cómo saber a dónde va tu plata en 2 min
Design philosophy: Nocturnal Precision
1080x1080 Instagram/Facebook post
"""

from PIL import Image, ImageDraw, ImageFont
import math

W, H = 1080, 1080
img = Image.new("RGB", (W, H), "#0D0D0B")
draw = ImageDraw.Draw(img)

FONT_DIR = r"C:\Users\USUARIO\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\d7a5aef4-75cf-41e5-8490-8d9904bf00a0\31a84bc0-6b40-4b71-a583-696fec21ef19\skills\canvas-design\canvas-fonts"

f_headline = ImageFont.truetype(f"{FONT_DIR}/BigShoulders-Bold.ttf", 95)
f_sub = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 24)
f_step_num = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Bold.ttf", 40)
f_step_title = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Bold.ttf", 24)
f_step_desc = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 17)
f_time = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Bold.ttf", 18)
f_cta = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Bold.ttf", 20)
f_logo = ImageFont.truetype(f"{FONT_DIR}/WorkSans-Bold.ttf", 22)
f_tag = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 14)
f_badge = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Regular.ttf", 11)

GREEN = (29, 158, 117)
GREEN_L = (104, 219, 174)
AMBER = (239, 159, 39)
WHITE = (229, 226, 222)
GRAY = (135, 148, 140)
GRAY_DK = (90, 101, 96)
CARD = (22, 22, 20)
BORDER = (42, 42, 40)
BG = (13, 13, 11)

def tw(text, font):
    b = font.getbbox(text)
    return b[2] - b[0]

def ct(text, font, y, color):
    w = tw(text, font)
    draw.text(((W - w) // 2, y), text, fill=color, font=font)

def rr(xy, r, fill, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)

# ── Background ──
for x in range(20, W, 36):
    for y in range(20, H, 36):
        d = math.sqrt(((x - W/2)/(W/2))**2 + ((y - H/2)/(H/2))**2)
        if d < 1.1:
            op = max(0, int(16 * (1 - d / 1.1)))
            draw.ellipse([x-1, y-1, x+1, y+1], fill=(BG[0]+op, BG[1]+op, BG[2]+op))

for r in range(400, 0, -3):
    f = r / 400
    i = int(18 * (1 - f**1.5))
    draw.ellipse([W//2-r, -150-r//3, W//2+r, -150+r//3],
                 fill=(BG[0]+i//3, BG[1]+i, BG[2]+i//2))

for x in range(0, W):
    d = abs(x - W//2) / (W//2)
    if d < 0.5:
        op = int(60 * (1 - d / 0.5))
        draw.point((x, 0), fill=(GREEN[0]*op//60, GREEN[1]*op//60, GREEN[2]*op//60))

# ── Badge ──
bt = "TUTORIAL RÁPIDO"
bw = tw(bt, f_badge)
bx = (W - bw - 32) // 2
by = 55
rr([bx, by, bx+bw+32, by+26], r=13, fill=(22,22,19), outline=BORDER)
draw.ellipse([bx+10, by+8, bx+18, by+16], fill=GREEN)
draw.text((bx+22, by+6), bt, fill=GRAY, font=f_badge)

# ── Headline ──
ct("A DÓNDE SE", f_headline, 100, WHITE)
ct("VA TU PLATA", f_headline, 195, GREEN_L)

# ── Subtitle ──
ct("Setup en 2 minutos. Resultados al instante.", f_sub, 305, GRAY)

# ── Three steps ──
steps = [
    ("01", "Escríbele a Neto", "Manda un 'Hola' al +51 933 014 505", "30 seg"),
    ("02", "Conecta tu Gmail", "Un clic. Solo lee correos de tu banco.", "60 seg"),
    ("03", "Recibe tu resumen", "Neto te manda tus gastos por WhatsApp.", "30 seg"),
]

sy = 380
step_h = 160
left_margin = 100

for idx, (num, title, desc, time) in enumerate(steps):
    y = sy + idx * step_h

    # Step card
    card_x = left_margin
    card_w = W - 2 * left_margin
    rr([card_x, y, card_x + card_w, y + step_h - 20], r=20, fill=CARD, outline=BORDER)

    # Step number circle
    cx = card_x + 45
    cy = y + (step_h - 20) // 2
    draw.ellipse([cx-24, cy-24, cx+24, cy+24], fill=(13, 51, 37), outline=GREEN, width=2)
    nw = tw(num, f_step_num)
    draw.text((cx - nw//2, cy - 18), num, fill=GREEN_L, font=f_step_num)

    # Title + description
    draw.text((card_x + 90, y + 28), title, fill=WHITE, font=f_step_title)
    draw.text((card_x + 90, y + 62), desc, fill=GRAY, font=f_step_desc)

    # Time badge
    time_w = tw(time, f_time)
    tx = card_x + card_w - time_w - 30
    ty = y + 35
    rr([tx - 10, ty - 5, tx + time_w + 10, ty + 22], r=10, fill=(20, 45, 35))
    draw.text((tx, ty), time, fill=GREEN_L, font=f_time)

    # Connecting line between steps
    if idx < 2:
        line_y = y + step_h - 20
        draw.line([(cx, line_y), (cx, line_y + 20)], fill=GREEN, width=2)

# ── Total time ──
total_y = sy + 3 * step_h + 10
ct("Tiempo total: 2 minutos", f_sub, total_y, AMBER)

# ── Divider ──
dy = total_y + 45
for x in range(W//2 - 80, W//2 + 80):
    d = abs(x - W//2) / 80
    op = max(0, int(50 * (1 - d)))
    draw.point((x, dy), fill=(GREEN[0]*op//50, GREEN[1]*op//50, GREEN[2]*op//50))

# ── CTA ──
cy2 = dy + 20
ct_text = "Empieza ahora  →"
ctw_val = tw(ct_text, f_cta)
cp = 36
cw_total = ctw_val + cp * 2
ch2 = 52
cx2 = (W - cw_total) // 2

for r in range(25, 0, -1):
    f = r / 25
    i = int(6 * (1 - f**2))
    rr([cx2-r//2, cy2-r//3, cx2+cw_total+r//2, cy2+ch2+r//3],
       r=26+r//2, fill=(BG[0]+i//3, BG[1]+i, BG[2]+i//2))

rr([cx2, cy2, cx2+cw_total, cy2+ch2], r=26, fill=(13,51,37), outline=GREEN, width=1)
draw.text((cx2+cp, cy2+14), ct_text, fill=GREEN_L, font=f_cta)

# Logo
ly = cy2 + ch2 + 20
ct("neto", f_logo, ly, GREEN)
ty2 = ly + 28
ct("Tu asistente financiero por WhatsApp", f_tag, ty2, GRAY_DK)

# Bottom edge
for x in range(0, W):
    d = abs(x - W//2) / (W//2)
    if d < 0.3:
        op = int(25 * (1 - d / 0.3))
        draw.point((x, H-1), fill=(GREEN[0]*op//25, GREEN[1]*op//25, GREEN[2]*op//25))

out = r"C:\Neto.pe\marketing\posts\05-como-funciona-2min.png"
img.save(out, "PNG", quality=100)
print(f"Done: {out} ({img.size})")
