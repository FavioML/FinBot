"""
Neto — Post 4: 11 bancos compatibles
Design philosophy: Nocturnal Precision
1080x1080 Instagram/Facebook post
"""

from PIL import Image, ImageDraw, ImageFont
import math

W, H = 1080, 1080
img = Image.new("RGB", (W, H), "#0D0D0B")
draw = ImageDraw.Draw(img)

FONT_DIR = r"C:\Users\USUARIO\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\d7a5aef4-75cf-41e5-8490-8d9904bf00a0\31a84bc0-6b40-4b71-a583-696fec21ef19\skills\canvas-design\canvas-fonts"

f_headline = ImageFont.truetype(f"{FONT_DIR}/BigShoulders-Bold.ttf", 100)
f_num = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Bold.ttf", 160)
f_sub = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 26)
f_bank = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Bold.ttf", 22)
f_bank_desc = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 15)
f_cta = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Bold.ttf", 20)
f_logo = ImageFont.truetype(f"{FONT_DIR}/WorkSans-Bold.ttf", 22)
f_tag = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 14)
f_badge = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Regular.ttf", 11)
f_plus = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 18)

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

def th(text, font):
    b = font.getbbox(text)
    return b[3] - b[1]

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

# Green glow
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
bt = "COMPATIBILIDAD"
bw = tw(bt, f_badge)
bx = (W - bw - 32) // 2
by = 55
rr([bx, by, bx+bw+32, by+26], r=13, fill=(22,22,19), outline=BORDER)
draw.ellipse([bx+10, by+8, bx+18, by+16], fill=GREEN)
draw.text((bx+22, by+6), bt, fill=GRAY, font=f_badge)

# ── Big number ──
num_text = "11"
num_w = tw(num_text, f_num)
draw.text(((W - num_w) // 2, 95), num_text, fill=GREEN_L, font=f_num)

# ── Headline ──
ct("BANCOS", f_headline, 270, WHITE)

# ── Subheadline ──
ct("Sin dar tu contraseña bancaria", f_sub, 375, GRAY)

# ── Bank grid (3 columns x 4 rows) ──
banks = [
    ("BCP", "Banca por internet"),
    ("BBVA", "Cuenta + tarjeta"),
    ("Interbank", "Cuenta + tarjeta"),
    ("Scotiabank", "Cuenta + tarjeta"),
    ("Yape", "Billetera digital"),
    ("Plin", "Billetera digital"),
    ("BanBif", "Cuenta + tarjeta"),
    ("Pichincha", "Cuenta"),
    ("Falabella", "Tarjeta CMR"),
    ("Ripley", "Tarjeta Ripley"),
    ("MiBanco", "Cuenta"),
]

grid_y = 435
col_w = 280
row_h = 80
margin_x = (W - col_w * 3 - 30) // 2

for idx, (name, desc) in enumerate(banks):
    col = idx % 3
    row = idx // 3
    x = margin_x + col * (col_w + 15)
    y = grid_y + row * row_h

    # Card
    rr([x, y, x + col_w, y + row_h - 10], r=14, fill=CARD, outline=BORDER)

    # Green dot
    draw.ellipse([x + 16, y + 22, x + 24, y + 30], fill=GREEN)

    # Bank name
    draw.text((x + 34, y + 14), name, fill=WHITE, font=f_bank)

    # Description
    draw.text((x + 34, y + 42), desc, fill=GRAY_DK, font=f_bank_desc)

# + more text
plus_y = grid_y + 4 * row_h + 5
ct("+ otros a solicitud", f_plus, plus_y, GRAY_DK)

# ── CTA ──
cy2 = plus_y + 40
ct_text = "Conecta tu banco gratis  →"
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
ly = cy2 + ch2 + 22
ct("neto", f_logo, ly, GREEN)

# Bottom edge
for x in range(0, W):
    d = abs(x - W//2) / (W//2)
    if d < 0.3:
        op = int(25 * (1 - d / 0.3))
        draw.point((x, H-1), fill=(GREEN[0]*op//25, GREEN[1]*op//25, GREEN[2]*op//25))

out = r"C:\Neto.pe\marketing\posts\04-bancos-compatibles.png"
img.save(out, "PNG", quality=100)
print(f"Done: {out} ({img.size})")
