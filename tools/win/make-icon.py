#!/usr/bin/env python3
"""
make-icon.py —— 生成 Markdown Observer 的图标（.ico + 预览图）。

用法：
  python3 tools/win/make-icon.py            生成图标（用下面 FONT 指定的那个字体）
  python3 tools/win/make-icon.py --variants 生成"字体对照表"（挑字体时用）
  python3 tools/win/make-icon.py --font <字体文件> [--stroke 0.05]   临时换一个试试

配色是莫兰迪蓝灰（上浅下深）；中间的 M 由下到上从纯白渐变到浅灰。
想换字体/加粗：改 FONT 和 STROKE 两个常量。
"""
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))

# ── 配色（莫兰迪蓝灰：比纯灰多一点蓝，但仍然很"静"）────────────────────
BG_TOP = (136, 198, 230)       # #88C6E6 上缘：浅天蓝
BG_BOTTOM = (32, 107, 163)     # #206BA3 下缘：深蓝
INK_BOTTOM = (255, 255, 255)   # M 的下端：纯白
INK_TOP = (226, 234, 243)      # #E2EAF3 M 的上端：很浅的冷灰
                               # （原来用了 151,161,190，和背景上端亮度只差 0.10 —— 16px 下字底糊在一起，这就是"乱"的原因）

# ── 形状 ───────────────────────────────────────────────────────────────
INSET = 0.055                  # 方块四周留边
CORNER = 0.21                  # 圆角半径
INK_SCALE = 0.62               # M 占方块的比例（留出四周的呼吸）
STROKE = 0.012                 # 给字描边加粗（相对字号；0 = 不描边。太大会糊成一团）
FONT = "/mnt/c/Windows/Fonts/segoeprb.ttf"
SIZES = [16, 24, 32, 48, 64, 128, 256]
SUPER = 8                      # 超采样倍数（画大再缩 = 抗锯齿）

# 手绘的"飘逸 M"：四笔，每一笔起收粗细不同（就是笔锋），端点圆润
HAND_M = [
    (0.235, 0.215, 0.315, 0.795, 0.075, 0.042),   # 左竖：上粗下细，微微外撇
    (0.315, 0.795, 0.470, 0.315, 0.042, 0.062),   # 中间斜挑（两道合起来是个 V）
    (0.470, 0.315, 0.625, 0.795, 0.062, 0.042),   # 再斜下
    (0.625, 0.795, 0.700, 0.250, 0.042, 0.070),   # 右竖：下细上粗（收笔带一点挑起）
    (0.700, 0.250, 0.775, 0.375, 0.070, 0.030),   # 收笔的那一挑（"飘逸"就在这一下）
]

# 挑字体时摆出来的候选（对照表按这个顺序编号 1..N）
CANDIDATES = [
    ("Gabriola", "/mnt/c/Windows/Fonts/Gabriola.ttf"),
    ("Ink Free", "/mnt/c/Windows/Fonts/Inkfree.ttf"),
    ("Segoe Print Bold", "/mnt/c/Windows/Fonts/segoeprb.ttf"),
    ("Brush Script MT", "/mnt/c/Windows/Fonts/BRUSHSCI.TTF"),
    ("Freestyle Script", "/mnt/c/Windows/Fonts/FREESCPT.TTF"),
    ("Vladimir Script", "/mnt/c/Windows/Fonts/VLADIMIR.TTF"),
    ("Lucida Handwriting", "/mnt/c/Windows/Fonts/LHANDW.TTF"),
    ("Book Antiqua Bold Italic", "/mnt/c/Windows/Fonts/BOOKOSBI.TTF"),
    ("Palatino Bold Italic", "/mnt/c/Windows/Fonts/palabi.ttf"),
    ("手绘（不用字体）", None),
]


def vertical_gradient(size, top, bottom):
    image = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        image.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return image.resize((size, size), Image.NEAREST)


def rounded_mask(n):
    mask = Image.new("L", (n, n), 0)
    inset = round(n * INSET)
    ImageDraw.Draw(mask).rounded_rectangle(
        [inset, inset, n - inset, n - inset], radius=round(n * CORNER), fill=255)
    return mask


def draw_hand_m(draw, n, scale):
    """手绘 M：每一笔用一串圆点画出来，半径从粗到细（就是笔锋）。"""
    for x0, y0, x1, y1, w0, w1 in HAND_M:
        length = max(abs(x1 - x0), abs(y1 - y0)) * n
        steps = max(8, int(length * 1.2))
        for i in range(steps + 1):
            t = i / steps
            x = (x0 + (x1 - x0) * t) * n
            y = (y0 + (y1 - y0) * t) * n
            r = (w0 + (w1 - w0) * t) * n * scale / 2
            draw.ellipse([x - r, y - r, x + r, y + r], fill=255)


def render(size, font_path=FONT, stroke=STROKE, hand=False):
    """画一张 size×size 的 RGBA 图标。"""
    n = size * SUPER
    mask = rounded_mask(n)
    canvas = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    canvas.paste(vertical_gradient(n, BG_TOP, BG_BOTTOM), (0, 0), mask)

    text_mask = Image.new("L", (n, n), 0)
    draw = ImageDraw.Draw(text_mask)
    if hand:
        draw_hand_m(draw, n, INK_SCALE / 0.72)
    else:
        font = ImageFont.truetype(font_path, round(n * INK_SCALE))
        box = draw.textbbox((0, 0), "M", font=font, stroke_width=round(n * stroke))
        x = (n - (box[2] - box[0])) / 2 - box[0]
        y = (n - (box[3] - box[1])) / 2 - box[1]
        draw.text((x, y), "M", font=font, fill=255,
                  stroke_width=round(n * stroke), stroke_fill=255)
    text_mask = Image.composite(text_mask, Image.new("L", (n, n), 0), mask)

    canvas.paste(vertical_gradient(n, INK_TOP, INK_BOTTOM).convert("RGBA"), (0, 0), text_mask)
    return canvas.resize((size, size), Image.LANCZOS)


def make_variants():
    """字体对照表：一行一个候选，每行摆 128 / 48 / 32 / 16 四种尺寸。"""
    columns = [128, 48, 32, 16]
    pad = 18
    label_w = 150
    width = label_w + sum(c + pad for c in columns) + pad
    row_h = 128 + pad
    height = pad + len(CANDIDATES) * row_h
    sheet = Image.new("RGB", (width, height), (245, 246, 248))
    draw = ImageDraw.Draw(sheet)
    try:
        label_font = ImageFont.truetype("/mnt/c/Windows/Fonts/msyh.ttc", 15)
    except OSError:
        label_font = ImageFont.load_default()
    for index, (name, path) in enumerate(CANDIDATES):
        top = pad + index * row_h
        draw.text((14, top + 50), str(index + 1) + ". " + name, font=label_font, fill=(40, 44, 52))
        x = label_w
        for size in columns:
            icon = render(size, font_path=path or FONT, hand=path is None)
            sheet.paste(icon, (x, top + (128 - size) // 2), icon)
            x += size + pad
    out = os.path.join(HERE, "icon-fonts.png")
    sheet.save(out)
    print("variants -> " + out)


def bmp_entry(image):
    """
    把一张 RGBA 图写成 ICO 里的 BMP(DIB) 数据：BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码。

    为什么不用 Pillow 的 save(sizes=...)：它会把每一档都存成 PNG 条目。
    实测外壳程序对这种 ico 经常直接显示空白（连 256px 都读不出来），
    而 BMP 条目是老牌写法，从 Win95 到 Win11 都认。
    """
    width, height = image.size
    header = struct.pack('<IiiHHIIiiII', 40, width, height * 2, 1, 32, 0, width * height * 4, 0, 0, 0, 0)
    pixels = image.load()
    rows = []
    for y in range(height - 1, -1, -1):
        row = bytearray()
        for x in range(width):
            r, g, b, a = pixels[x, y]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    mask_row = ((width + 31) // 32) * 4
    return header + b''.join(rows) + b'\x00' * (mask_row * height)


def write_ico(path, images):
    """按 ICO 格式拼一个多尺寸图标（每一档都是 BMP 条目）。"""
    entries = [(image.size[0], bmp_entry(image)) for image in images]
    directory = b''
    offset = 6 + 16 * len(entries)
    for size, blob in entries:
        directory += struct.pack('<BBBBHHII', size if size < 256 else 0, size if size < 256 else 0,
                                 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    with open(path, 'wb') as handle:
        handle.write(struct.pack('<HHH', 0, 1, len(entries)) + directory + b''.join(b for _, b in entries))


def main():
    args = sys.argv[1:]
    if "--variants" in args:
        make_variants()
        return
    font = FONT
    stroke = STROKE
    if "--font" in args:
        font = args[args.index("--font") + 1]
    if "--stroke" in args:
        stroke = float(args[args.index("--stroke") + 1])

    ico = os.path.join(HERE, "markdown-observer.ico")
    write_ico(ico, [render(s, font_path=font, stroke=stroke) for s in SIZES])
    print("icon    -> " + ico + " (" + str(os.path.getsize(ico) // 1024) + " KB)")

    shown = [16, 24, 32, 48, 64, 128]
    pad = 18
    width = pad + sum(s + pad for s in shown)
    height = pad * 3 + 128 + 72
    sheet = Image.new("RGB", (width, height), (245, 246, 248))
    x = pad
    for s in shown:
        icon = render(s, font_path=font, stroke=stroke)
        sheet.paste(icon, (x, pad + (128 - s) // 2), icon)
        x += s + pad
    dark_top = pad * 2 + 128
    ImageDraw.Draw(sheet).rectangle([0, dark_top - pad // 2, width, dark_top + 72], fill=(28, 31, 38))
    x = pad
    for s in shown:
        icon = render(s, font_path=font, stroke=stroke)
        sheet.paste(icon, (x, dark_top + (72 - s) // 2), icon)
        x += s + pad
    preview = os.path.join(HERE, "icon-preview.png")
    sheet.save(preview)
    print("preview -> " + preview)


main()
