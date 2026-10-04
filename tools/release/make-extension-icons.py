#!/usr/bin/env python3
"""Draw the bundled extensions' icons.

YouTube Manager is three bars stepping down to nothing: sound going quiet.
Cyberswine is a pig's head: ears, snout, two nostrils.

The blocker was a newspaper front page while it was called Media Control.

Everything is a rectangle on a filled chip, for one reason: the icon has to
survive 16x16 in a toolbar, where strokes, gradients and detail turn to mush.
The chip also guarantees contrast — a bare dark mark disappears on a dark
toolbar and a bare light one disappears on a light one.

    python3 tools/release/make-extension-icons.py
"""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SIZES = (16, 32, 48, 96, 128)
# Drawn big and shrunk, which is what keeps the chip's corners clean at 16px.
SUPERSAMPLE = 8

# Geometry in fractions of the icon, so every size is the same picture.
RADIUS = 0.22
BAR = 0.18          # thickness
GAP = 0.07
MARGIN = 0.16
STEPS = (0.54, 0.38, 0.22)   # the ramp, longest first


def chip(size: int, colour: str) -> tuple:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=size * RADIUS, fill=colour
    )
    return image, draw


def vertical(draw, size: int) -> None:
    """Three columns standing on one baseline, each shorter than the last."""
    baseline = size * (1 - 0.16)
    x = size * MARGIN
    for length in STEPS:
        draw.rounded_rectangle(
            (x, baseline - size * length, x + size * BAR, baseline),
            radius=size * BAR / 2,
            fill="white",
        )
        x += size * (BAR + GAP)


def pig(draw, size: int, ink: str) -> None:
    """A pig's head: two ears, a wide face, a snout with two nostrils.

    The nostrils are what make it a pig. Without them the same drawing reads
    as a cat — pointed ears over a round face — and three attempts at fixing
    that by reshaping the ears all stayed cat. Two holes punched out of the
    snout settle it at a glance, and they are the only detail here fine enough
    to blur at 16px, where they merge into a lighter patch that still reads as
    a snout.

    Ears first, then the face over them, so the face's own curve cuts them
    into triangles sitting ON the head rather than beside it.
    """

    def block(x0, y0, x1, y1, radius, fill):
        draw.rounded_rectangle(
            (size * x0, size * y0, size * x1, size * y1),
            radius=size * radius,
            fill=fill,
        )

    draw.polygon(
        [(size * 0.12, size * 0.46), (size * 0.15, size * 0.13), (size * 0.43, size * 0.33)],
        fill="white",
    )
    draw.polygon(
        [(size * 0.88, size * 0.46), (size * 0.85, size * 0.13), (size * 0.57, size * 0.33)],
        fill="white",
    )
    block(0.10, 0.30, 0.90, 0.84, 0.27, "white")        # the face
    block(0.33, 0.53, 0.67, 0.78, 0.12, ink)            # the snout
    block(0.405, 0.605, 0.465, 0.715, 0.03, "white")    # nostrils
    block(0.535, 0.605, 0.595, 0.715, 0.03, "white")
    block(0.23, 0.40, 0.335, 0.49, 0.05, ink)           # eyes
    block(0.665, 0.40, 0.77, 0.49, 0.05, ink)


ICONS = {
    "youtube-manager": ("#F97316", lambda draw, size, ink: vertical(draw, size)),
    "media-control": ("#EC4899", pig),
}


def main() -> None:
    for name, (colour, mark) in ICONS.items():
        out = ROOT / "browser-features" / "extensions" / name / "icons"
        out.mkdir(parents=True, exist_ok=True)
        for size in SIZES:
            big = size * SUPERSAMPLE
            image, draw = chip(big, colour)
            mark(draw, big, colour)
            image.resize((size, size), Image.LANCZOS).save(out / f"icon-{size}.png")
        print(f"{name}: {', '.join(str(s) for s in SIZES)}")


if __name__ == "__main__":
    main()
