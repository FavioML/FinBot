"""
Neto — Post 1: Gastos Hormiga
Design philosophy: Nocturnal Precision
1080x1080 Instagram/Facebook post — FINAL v3
"""

from PIL import Image, ImageDraw, ImageFont
import math

W, H = 1080, 1080
img = Image.new("RGB", (W, H), "#0D0D0B")
draw = ImageDraw.Draw(img)

FONT_DIR = r"C:\Users\USUARIO\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\d7a5aef4-75cf-41e5-8490-8d9904bf00a0\31a84bc0-6b40-4b71-a583-696fec21ef19\skills\canvas-design\canvas-fonts"

# Fonts
f_headline = ImageFont.truetype(f"{FONT_DIR}/BigShoulders-Bold.ttf", 130)
f_sub = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 27)
f_val1 = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Bold.ttf", 36)
f_val2 = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Bold.ttf", 40)
f_val3 = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Bold.ttf", 52)
f_label = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 16)
f_explain = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Italic.ttf", 18)
f_cta = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Bold.ttf", 20)
f_logo = ImageFont.truetype(f"{FONT_DIR}/WorkSans-Bold.ttf", 22)
f_tag = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 14)
f_link = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Regular.ttf", 12)
f_badge = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Regular.ttf", 11)

# Colors
GREEN = (29, 158, 117)
GREEN_L = (104, 219, 174)
AMBER = (239, 159, 39)
AMBER_DK = (196, 126, 26)
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
# Dot grid
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
bt = "EDUCACIÓN FINANCIERA"
bw = tw(bt, f_badge)
bx = (W - bw - 32) // 2
by = 62
rr([bx, by, bx+bw+32, by+26], r=13, fill=(22,22,19), outline=BORDER)
draw.ellipse([bx+10, by+8, bx+18, by+16], fill=GREEN)
draw.text((bx+22, by+6), bt, fill=GRAY, font=f_badge)

# ── Headline ──
hy = 112
ct("GASTOS", f_headline, hy, WHITE)
ct("HORMIGA", f_headline, hy + 115, WHITE)

# ── Subheadline ──
ct("El enemigo invisible de tu plata", f_sub, hy + 250, GREEN_L)

# ── Coin rain visual (abstract, geometric) ──
# Scattered coins falling — sizes increase top to bottom
rain_y = 395
cx = W // 2

coins = [
    # (offset_x, offset_y, radius, color)
    (-90, -20, 6, AMBER_DK), (-55, -30, 7, AMBER), (-25, -10, 8, AMBER_DK),
    (0, -25, 9, AMBER), (30, -15, 7, AMBER_DK), (60, -28, 8, AMBER),
    (85, -8, 6, AMBER_DK),
    # second row — slightly bigger
    (-65, 5, 9, AMBER), (-30, 12, 10, AMBER), (5, 8, 11, AMBER),
    (40, 15, 10, AMBER_DK), (75, 3, 9, AMBER),
    # third row — bigger still
    (-40, 35, 12, AMBER), (0, 40, 14, AMBER), (45, 32, 12, AMBER_DK),
]

for ox, oy, r, color in coins:
    x, y = cx + ox, rain_y + oy
    draw.ellipse([x-r, y-r, x+r, y+r], fill=color)
    # Inner highlight
    if r >= 10:
        draw.ellipse([x-r+3, y-r+3, x+r-3, y+r-3], outline=AMBER_DK, width=1)

# Down arrows below coins
for i in range(3):
    ay = rain_y + 60 + i * 16
    op = max(20, 70 - i * 22)
    c = (GREEN[0]*op//70, GREEN[1]*op//70, GREEN[2]*op//70)
    draw.line([(cx-12, ay), (cx, ay+8)], fill=c, width=2)
    draw.line([(cx, ay+8), (cx+12, ay)], fill=c, width=2)

# ── Escalation Stats ──
sy = 520
ch = 115

# Calculate widths
cw1, cw2, cw3 = 190, 220, 270
arrow_w = 44
total = cw1 + cw2 + cw3 + arrow_w * 2
sx = (W - total) // 2

# Card 1: S/8 al dia
x1 = sx
rr([x1, sy, x1+cw1, sy+ch], r=16, fill=CARD, outline=BORDER)
v = "S/8"
draw.text((x1 + (cw1 - tw(v, f_val1))//2, sy + 25), v, fill=WHITE, font=f_val1)
l = "al día"
draw.text((x1 + (cw1 - tw(l, f_label))//2, sy + 75), l, fill=GRAY, font=f_label)

# Arrow 1
ax1 = x1 + cw1
acy = sy + ch // 2
draw.line([(ax1+8, acy), (ax1+36, acy)], fill=GREEN_L, width=2)
draw.polygon([(ax1+36, acy-5), (ax1+44, acy), (ax1+36, acy+5)], fill=GREEN_L)

# Card 2: S/240 al mes
x2 = ax1 + arrow_w
rr([x2, sy, x2+cw2, sy+ch], r=16, fill=CARD, outline=BORDER)
v = "S/240"
draw.text((x2 + (cw2 - tw(v, f_val2))//2, sy + 22), v, fill=WHITE, font=f_val2)
l = "al mes"
draw.text((x2 + (cw2 - tw(l, f_label))//2, sy + 75), l, fill=GRAY, font=f_label)

# Arrow 2
ax2 = x2 + cw2
draw.line([(ax2+8, acy), (ax2+36, acy)], fill=GREEN_L, width=2)
draw.polygon([(ax2+36, acy-5), (ax2+44, acy), (ax2+36, acy+5)], fill=GREEN_L)

# Card 3: S/2,880 al ano (highlighted)
x3 = ax2 + arrow_w
# Subtle amber glow behind card
for r in range(40, 0, -2):
    f = r / 40
    i = int(8 * (1 - f**2))
    glow_c = (BG[0]+i, BG[1]+i//2, BG[2])
    rr([x3-r//2, sy-r//3, x3+cw3+r//2, sy+ch+r//3],
       r=16+r//2, fill=glow_c)

rr([x3, sy, x3+cw3, sy+ch], r=16, fill=(26,23,17), outline=AMBER, width=2)
v = "S/2,880"
draw.text((x3 + (cw3 - tw(v, f_val3))//2, sy + 16), v, fill=AMBER, font=f_val3)
l = "al año"
draw.text((x3 + (cw3 - tw(l, f_label))//2, sy + 78), l, fill=GRAY, font=f_label)

# ── Explanatory text ──
ey = sy + ch + 28
ct("Solo en café. Ahora suma Rappi, taxis, antojos...", f_explain, ey, GRAY_DK)

# ── Divider ──
dy = ey + 42
for x in range(W//2 - 80, W//2 + 80):
    d = abs(x - W//2) / 80
    op = max(0, int(50 * (1 - d)))
    draw.point((x, dy), fill=(GREEN[0]*op//50, GREEN[1]*op//50, GREEN[2]*op//50))

# ── CTA Button ──
cy2 = dy + 22
ct_text = "Descubre a dónde se va tu plata  →"
ctw_val = tw(ct_text, f_cta)
cp = 36
cw_total = ctw_val + cp * 2
ch2 = 52
cx2 = (W - cw_total) // 2

# Button glow
for r in range(25, 0, -1):
    f = r / 25
    i = int(6 * (1 - f**2))
    rr([cx2-r//2, cy2-r//3, cx2+cw_total+r//2, cy2+ch2+r//3],
       r=26+r//2, fill=(BG[0]+i//3, BG[1]+i, BG[2]+i//2))

rr([cx2, cy2, cx2+cw_total, cy2+ch2], r=26, fill=(13,51,37), outline=GREEN, width=1)
draw.text((cx2+cp, cy2+14), ct_text, fill=GREEN_L, font=f_cta)

# ── Logo ──
ly = cy2 + ch2 + 28
lt = "neto"
lw2 = tw(lt, f_logo)
lx = (W - lw2) // 2
draw.text((lx, ly), lt, fill=GREEN, font=f_logo)

# Tagline
ty = ly + 30
ct("Tu asistente financiero por WhatsApp", f_tag, ty, GRAY_DK)

# Link en bio
lky = ty + 24
ct("Link en bio", f_link, lky, (70, 80, 75))

# Bottom edge
for x in range(0, W):
    d = abs(x - W//2) / (W//2)
    if d < 0.3:
        op = int(25 * (1 - d / 0.3))
        draw.point((x, H-1), fill=(GREEN[0]*op//25, GREEN[1]*op//25, GREEN[2]*op//25))

# ── Save ──
out = r"C:\Neto.pe\marketing\posts\01-gastos-hormiga.png"
img.save(out, "PNG", quality=100)
print(f"Done: {out} ({img.size})")
