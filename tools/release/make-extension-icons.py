#!/usr/bin/env python3
"""Draw the bundled extensions' icons.

YouTube Control is three bars stepping down to nothing: sound going quiet.
Media Control is a front page — masthead, photo block, two columns.

The press one started as the same ramp lying down, which was wrong: rotating
one shape twice reads as one idea drawn twice, not as a newspaper. Two other
attempts, a pair of offset sheets and a page with a turned corner, both read as
"document" rather than "newspaper". Only the front page says press at a glance,
and it costs some clarity at 16px, which is the trade worth making.

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


def newspaper(draw, size: int, ink: str) -> None:
    """A front page: masthead, photo block, two columns.

    Deliberately few, fat elements. Anything finer — a strapline, a third
    column, a rule between them — is gone by 32px and mud by 16px.
    """
    def block(x0, y0, x1, y1, radius, fill):
        draw.rounded_rectangle(
            (size * x0, size * y0, size * x1, size * y1),
            radius=size * radius,
            fill=fill,
        )

    block(0.15, 0.18, 0.85, 0.82, 0.07, "white")      # the page
    block(0.23, 0.26, 0.77, 0.385, 0.02, ink)         # masthead
    block(0.23, 0.47, 0.47, 0.74, 0.02, ink)          # photo
    block(0.545, 0.47, 0.77, 0.565, 0.02, ink)        # column
    block(0.545, 0.645, 0.77, 0.74, 0.02, ink)


ICONS = {
    "youtube-control": ("#F97316", lambda draw, size, ink: vertical(draw, size)),
    "media-control": ("#4F46E5", newspaper),
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
