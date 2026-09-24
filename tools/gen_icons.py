#!/usr/bin/env python3
"""Generate the extension icons (dark rounded square with a light-green attention meter)."""
from PIL import Image, ImageDraw

def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = size * 0.22
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=(15, 20, 25, 255))
    # meter: 5 blocks, 3 lit
    n, gap = 5, size * 0.05
    m = size * 0.18
    w = (size - 2 * m - gap * (n - 1)) / n
    y0, y1 = size * 0.40, size * 0.60
    for i in range(n):
        x0 = m + i * (w + gap)
        col = (126, 231, 135, 255) if i < 3 else (58, 63, 68, 255)
        d.rounded_rectangle((x0, y0, x0 + w, y1), radius=max(1, size * 0.03), fill=col)
    return img

for s in (16, 48, 128):
    make(s).save(f"icons/icon{s}.png")
print("icons written")
