from PIL import Image, ImageDraw
import math

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# --- shield geometry (scaled from a 256 grid) -------------------------------
def q(p0, p1, p2, t):
    x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0]
    y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1]
    return (x, y)

scale = SIZE / 256.0
pts = [(44, 30), (212, 30), (212, 118)]
for i in range(1, 25):
    pts.append(q((212, 118), (206, 178), (128, 228), i / 24))
for i in range(1, 25):
    pts.append(q((128, 228), (50, 178), (44, 118), i / 24))
pts = [(x * scale, y * scale) for x, y in pts]

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).polygon(pts, fill=255)

# --- vertical gradient fill -------------------------------------------------
grad = Image.new("RGBA", (SIZE, SIZE))
gd = ImageDraw.Draw(grad)
top = (18, 34, 58)
bottom = (37, 99, 235)
for y in range(SIZE):
    t = y / (SIZE - 1)
    color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    gd.line([(0, y), (SIZE, y)], fill=color)
img.paste(grad, (0, 0), mask)

# --- border -----------------------------------------------------------------
border = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bd = ImageDraw.Draw(border)
bd.line(pts + [pts[0]], fill=(56, 189, 248, 255), width=int(7 * scale), joint="curve")
img = Image.alpha_composite(img, border)

# --- circular rollback arrow ------------------------------------------------
draw = ImageDraw.Draw(img)
box = (74 * scale, 74 * scale, 182 * scale, 182 * scale)
width = int(13 * scale)
draw.arc(box, start=42, end=318, fill=(224, 242, 254, 255), width=width)

# arrow head at the start of the arc, pointing along the arc
cx = (box[0] + box[2]) / 2
cy = (box[1] + box[3]) / 2
rx = (box[2] - box[0]) / 2
ry = (box[3] - box[1]) / 2
ang = math.radians(42)
px = cx + rx * math.cos(ang)
py = cy + ry * math.sin(ang)
# tangent (increasing angle) and outward normal
tx, ty = -rx * math.sin(ang), ry * math.cos(ang)
nx, ny = rx * math.cos(ang), ry * math.sin(ang)
tl = math.hypot(tx, ty) or 1
nl = math.hypot(nx, ny) or 1
tx, ty = tx / tl, ty / tl
nx, ny = nx / nl, ny / nl
head_len = 34 * scale
head_half = 19 * scale
tip = (px + tx * head_len, py + ty * head_len)
base = (px - tx * 4 * scale, py - ty * 4 * scale)
p1 = (base[0] + nx * head_half, base[1] + ny * head_half)
p2 = (base[0] - nx * head_half, base[1] - ny * head_half)
draw.polygon([tip, p1, p2], fill=(224, 242, 254, 255))

# --- small pulse dot --------------------------------------------------------
r = 9 * scale
draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=(34, 197, 94, 255))

img = img.resize((256, 256), Image.LANCZOS)
img.save("guardian/assets/guardian-icon-256.png")
img.save(
    "guardian/assets/guardian.ico",
    format="ICO",
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
)
print("generated guardian/assets/guardian.ico")
