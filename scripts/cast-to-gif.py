#!/usr/bin/env python3
"""Render gitmancer docs/demo.cast (asciinema v2) into docs/demo.gif.
Frames = real cast output accumulated over time. Zero network, deterministic."""
import json
import os
from PIL import Image, ImageDraw, ImageFont

CAST = "/home/z/my-project/gitmancer/docs/demo.cast"
OUT = "/home/z/my-project/gitmancer/docs/demo.gif"
COLS, ROWS = 96, 28
SCALE = 2  # supersample then downscale for crisp text
FONT_SIZE = 12 * SCALE
CHAR_W = 7.2 * SCALE  # DejaVu Sans Mono advance ≈ 0.602em → 7.2px @12px; measured below if possible
LINE_H = 15 * SCALE
PAD = 10 * SCALE
BG = (7, 11, 20)
FG = (200, 214, 232)
DIM = (110, 124, 150)
GREEN = (74, 222, 128)
RED = (248, 113, 113)
CYAN = (103, 232, 249)

font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", FONT_SIZE)
# measure real advance
tmp = Image.new("RGB", (8, 8))
d = ImageDraw.Draw(tmp)
bbox = d.textbbox((0, 0), "M", font=font)
CHAR_W = bbox[2] - bbox[0] or 8
W = int(COLS * CHAR_W + PAD * 2)
H = int(ROWS * LINE_H + PAD * 2)

events = []
header = None
for line in open(CAST):
    line = line.strip()
    if not line:
        continue
    j = json.loads(line)
    if isinstance(j, list):
        events.append(j)
    elif isinstance(j, dict):
        header = j

# build frames: accumulate output; new frame when a line boundary is completed
frames = []  # list of list-of-lines (each list[str])
buf = ""
MIN_DELTA = 0.02
last_t = 0.0
for ev in events:
    t, kind, data = ev[0], ev[1], ev[2]
    if kind != "o":
        continue
    buf += str(data)
    if buf.endswith("\n") or (t - last_t) >= MIN_DELTA:
        lines = buf.split("\n")
        frames.append((t, lines[-ROWS:]))
        last_t = t
if buf:
    frames.append((events[-1][0], buf.split("\n")[-ROWS:]))
if not frames:
    raise SystemExit("no frames parsed from cast")

# colorize a line (tiny honest highlighter: prompt $ green, ⚡ cyan, ✖/error red, table borders dim)
def color_for(line):
    s = line.strip()
    if s.startswith("$ "):
        return GREEN
    if "⚡" in line:
        return CYAN
    if s.startswith(("✖", "ERROR")) or "exit 1" in line:
        return RED
    if s.startswith(("│", "┌", "└", "─")):
        return DIM
    return FG

durations = []
images = []
prev = None
for i, (t, lines) in enumerate(frames):
    if prev is None:
        durations.append(120)
    else:
        durations.append(int(max(min((t - prev) * 1000, 400), 40)))
    prev = t
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)
    y = PAD
    for line in lines:
        if line:
            dr.text((PAD, y), line[:COLS], font=font, fill=color_for(line))
        y += LINE_H
    # title bar strip
    dr.rectangle([0, 0, W, int(4 * SCALE)], fill=(34, 211, 238))
    images.append(img.resize((W // SCALE, H // SCALE), Image.LANCZOS))

images[0].save(
    OUT,
    save_all=True,
    append_images=images[1:],
    duration=durations,
    loop=0,
    optimize=True,
)
kb = os.path.getsize(OUT) / 1024
print(f"demo.gif written: {len(images)} frames, {kb:.0f}kb, {COLS}x{ROWS} cols")
