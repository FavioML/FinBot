"""
Neto — Post 3: Demo conversación WhatsApp
Design philosophy: Nocturnal Precision
1080x1080 Instagram/Facebook post
"""

from PIL import Image, ImageDraw, ImageFont
import math

W, H = 1080, 1080
img = Image.new("RGB", (W, H), "#0D0D0B")
draw = ImageDraw.Draw(img)

FONT_DIR = r"C:\Users\USUARIO\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin\d7a5aef4-75cf-41e5-8490-8d9904bf00a0\31a84bc0-6b40-4b71-a583-696fec21ef19\skills\canvas-design\canvas-fonts"

f_headline = ImageFont.truetype(f"{FONT_DIR}/BigShoulders-Bold.ttf", 90)
f_sub = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 24)
f_chat = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 18)
f_chat_bold = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Bold.ttf", 18)
f_chat_sm = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 14)
f_emoji = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 22)
f_cta = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Bold.ttf", 20)
f_logo = ImageFont.truetype(f"{FONT_DIR}/WorkSans-Bold.ttf", 22)
f_tag = ImageFont.truetype(f"{FONT_DIR}/InstrumentSans-Regular.ttf", 14)
f_badge = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Regular.ttf", 11)
f_time = ImageFont.truetype(f"{FONT_DIR}/GeistMono-Regular.ttf", 11)

GREEN = (29, 158, 117)
GREEN_L = (104, 219, 174)
GREEN_CHAT = (0, 92, 75)
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
            op = max(0, int(14 * (1 - d / 1.1)))
            draw.ellipse([x-1, y-1, x+1, y+1], fill=(BG[0]+op, BG[1]+op, BG[2]+op))

# Top glow
for r in range(350, 0, -3):
    f = r / 350
    i = int(16 * (1 - f**1.5))
    draw.ellipse([W//2-r, -120-r//3, W//2+r, -120+r//3],
                 fill=(BG[0]+i//3, BG[1]+i, BG[2]+i//2))

# ── Badge ──
bt = "ASI SE VE NETO"
bw = tw(bt, f_badge)
bx = (W - bw - 32) // 2
by = 50
rr([bx, by, bx+bw+32, by+26], r=13, fill=(22,22,19), outline=BORDER)
draw.ellipse([bx+10, by+8, bx+18, by+16], fill=GREEN)
draw.text((bx+22, by+6), bt, fill=GRAY, font=f_badge)

# ── Headline ──
ct("NETO TE HABLA", f_headline, 100, WHITE)
ct("POR WHATSAPP", f_headline, 185, GREEN_L)

# ── Chat mockup ──
chat_x = 120
chat_w = W - 240
chat_y = 300

# WhatsApp-style chat header
rr([chat_x, chat_y, chat_x + chat_w, chat_y + 50], r=16, fill=(18, 30, 26))
draw.ellipse([chat_x + 14, chat_y + 11, chat_x + 38, chat_y + 35], fill=GREEN)
draw.text((chat_x + 22, chat_y + 12), "N", fill=WHITE, font=f_chat_bold)
draw.text((chat_x + 48, chat_y + 14), "Neto", fill=WHITE, font=f_chat_bold)
draw.text((chat_x + chat_w - 80, chat_y + 18), "en linea", fill=GREEN_L, font=f_chat_sm)

# Chat area
chat_bg = (15, 15, 13)
rr([chat_x, chat_y + 50, chat_x + chat_w, chat_y + 500], r=0, fill=chat_bg)

# Neto message 1 (left aligned)
def draw_bubble_left(y, lines, time_str):
    max_w = max(tw(l, f_chat) for l in lines) + 40
    bh = len(lines) * 26 + 24
    bx = chat_x + 20
    rr([bx, y, bx + max_w, y + bh], r=14, fill=(28, 28, 25), outline=(38, 38, 35))
    for i, line in enumerate(lines):
        draw.text((bx + 16, y + 10 + i * 26), line, fill=WHITE, font=f_chat)
    draw.text((bx + max_w - 50, y + bh - 18), time_str, fill=GRAY_DK, font=f_time)
    return y + bh + 12

# User message (right aligned)
def draw_bubble_right(y, lines, time_str):
    max_w = max(tw(l, f_chat) for l in lines) + 40
    bh = len(lines) * 26 + 24
    bx = chat_x + chat_w - 20 - max_w
    rr([bx, y, bx + max_w, y + bh], r=14, fill=(13, 51, 37), outline=(20, 70, 50))
    for i, line in enumerate(lines):
        draw.text((bx + 16, y + 10 + i * 26), line, fill=GREEN_L, font=f_chat)
    draw.text((bx + max_w - 50, y + bh - 18), time_str, fill=(60, 100, 80), font=f_time)
    return y + bh + 12

my = chat_y + 70
my = draw_bubble_left(my, [
    "Hoy gastaste S/45 en Rappi.",
    "Llevas S/847 esta semana.",
    "Te quedan S/403 de presupuesto."
], "9:15")

my = draw_bubble_right(my, [
    "¿En qué más gasté esta semana?"
], "9:16")

my = draw_bubble_left(my, [
    "Tu top 3 esta semana:",
    "  Comida: S/380 (45%)",
    "  Transporte: S/220 (26%)",
    "  Entretenimiento: S/150 (18%)",
    "",
    "Tip: Comida subió 20% vs la",
    "semana pasada."
], "9:16")

# Chat bottom border
rr([chat_x, chat_y + 500, chat_x + chat_w, chat_y + 510], r=16, fill=(18, 30, 26))

# ── Subtext ──
ct("Real. Automático. Sin ingresar nada.", f_sub, chat_y + 535, GRAY)

# ── CTA ──
cy2 = chat_y + 580
ct_text = "Escríbele a Neto  →"
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
ly = cy2 + ch2 + 24
ct("neto", f_logo, ly, GREEN)

# Bottom edge
for x in range(0, W):
    d = abs(x - W//2) / (W//2)
    if d < 0.3:
        op = int(25 * (1 - d / 0.3))
        draw.point((x, H-1), fill=(GREEN[0]*op//25, GREEN[1]*op//25, GREEN[2]*op//25))

out = r"C:\Neto.pe\marketing\posts\03-demo-whatsapp.png"
img.save(out, "PNG", quality=100)
print(f"Done: {out} ({img.size})")
