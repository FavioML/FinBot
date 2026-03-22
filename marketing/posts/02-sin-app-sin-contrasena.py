"""
Neto — Post 2: Sin app. Sin contraseña. Solo WhatsApp.
Design philosophy: Nocturnal Precision
1080x1080 Instagram/Facebook post
"""

from PIL import Image, ImageDraw, ImageFont
import math

W, H = 1080, 1080
img = Image.new("RGB", (W, H), "#0D0D0B")
draw = ImageDraw.Draw(img)

FONT_DIR = r"C:\Users\USUARIO\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\d7a5aef4-75cf-41e5-8490-8d9904bf00a0\31a84bc0-6b40-4b71-a583-696fec21ef19\skills\canvas-design\canvas-fonts"

f_headline = ImageFont.truetype(f"{FONT_DIR}/BigShoulders-Bold.ttf", 110)
f_sub = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 28)
f_item_num = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Bold.ttf", 48)
f_item_label = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Bold.ttf", 22)
f_item_desc = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 17)
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
RED = (216, 90, 48)

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
            op = max(0, int(18 * (1 - d / 1.1)))
            draw.ellipse([x-1, y-1, x+1, y+1], fill=(BG[0]+op, BG[1]+op, BG[2]+op))

# Green glow top
for r in range(400, 0, -3):
    f = r / 400
    i = int(20 * (1 - f**1.5))
    draw.ellipse([W//2-r, -150-r//3, W//2+r, -150+r//3],
                 fill=(BG[0]+i//3, BG[1]+i, BG[2]+i//2))

# Top edge accent
for x in range(0, W):
    d = abs(x - W//2) / (W//2)
    if d < 0.5:
        op = int(60 * (1 - d / 0.5))
        draw.point((x, 0), fill=(GREEN[0]*op//60, GREEN[1]*op//60, GREEN[2]*op//60))

# ── Badge ──
bt = "LO QUE NO NECESITAS"  # ASCII ok for badge
bw = tw(bt, f_badge)
bx = (W - bw - 32) // 2
by = 60
rr([bx, by, bx+bw+32, by+26], r=13, fill=(22,22,19), outline=BORDER)
draw.ellipse([bx+10, by+8, bx+18, by+16], fill=GREEN)
draw.text((bx+22, by+6), bt, fill=GRAY, font=f_badge)

# ── Headline ──
hy = 110
ct("SIN APP.", f_headline, hy, WHITE)
ct("SIN CLAVE.", f_headline, hy + 105, WHITE)
ct("SOLO", f_headline, hy + 210, GRAY_DK)
ct("WHATSAPP.", f_headline, hy + 315, GREEN_L)

# ── Three "no" items with X marks ──
items = [
    ("Apps que descargar", "Neto vive en WhatsApp"),
    ("Contraseñas bancarias", "Solo lee correos de tu banco"),
    ("Ingresar datos a mano", "La IA categoriza todo por ti"),
]

# Note: "Contraseñas" has ñ — PIL renders it correctly with these fonts

sy = 580
spacing = 100

for idx, (label, desc) in enumerate(items):
    y = sy + idx * spacing

    # X mark in red circle
    cx = 100
    draw.ellipse([cx-18, y-18, cx+18, y+18], fill=(40, 20, 15), outline=RED, width=2)
    draw.line([(cx-8, y-8), (cx+8, y+8)], fill=RED, width=3)
    draw.line([(cx-8, y+8), (cx+8, y-8)], fill=RED, width=3)

    # Label
    draw.text((140, y - 16), label, fill=WHITE, font=f_item_label)
    draw.text((140, y + 14), desc, fill=GRAY_DK, font=f_item_desc)

# ── Divider ──
dy = sy + 3 * spacing + 10
for x in range(W//2 - 80, W//2 + 80):
    d = abs(x - W//2) / 80
    op = max(0, int(50 * (1 - d)))
    draw.point((x, dy), fill=(GREEN[0]*op//50, GREEN[1]*op//50, GREEN[2]*op//50))

# ── CTA ──
cy2 = dy + 22
ct_text = "Empieza gratis por WhatsApp  →"
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

# ── Logo ──
ly = cy2 + ch2 + 28
ct("neto", f_logo, ly, GREEN)
ty = ly + 30
ct("Tu asistente financiero por WhatsApp", f_tag, ty, GRAY_DK)

# Bottom edge
for x in range(0, W):
    d = abs(x - W//2) / (W//2)
    if d < 0.3:
        op = int(25 * (1 - d / 0.3))
        draw.point((x, H-1), fill=(GREEN[0]*op//25, GREEN[1]*op//25, GREEN[2]*op//25))

out = r"C:\Neto.pe\marketing\posts\02-sin-app-sin-contrasena.png"
img.save(out, "PNG", quality=100)
print(f"Done: {out} ({img.size})")
