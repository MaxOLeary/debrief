#!/usr/bin/env python3
"""Turn grid.txt into a one-glyph TTF that SketchyBar can tint like any letter.

An image in SketchyBar can't be recoloured, but an icon *font* inherits
icon.color for free -- so the red/amber/dim states keep working untouched.
"""
import sys, pathlib
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE   = pathlib.Path(__file__).parent
FAMILY = "DebriefIcons"
CODEPT = 0xE900              # Private Use Area - collides with nothing
UPM    = 1024                # power of two on purpose: 1024/16 = 64 exactly.
                             # With UPM=1000 a cell is 62.5 units, TrueType
                             # rounds outline points to integers, and the whole
                             # icon renders off-grid and blurry.
CELL   = UPM // 16           # 64 units per grid cell
BASE   = -2 * CELL           # sink the icon 2 whole cells below the baseline.
                             # MUST stay a whole multiple of CELL: a fractional
                             # offset puts the outline on half-pixels and the
                             # pixel art renders blurry. Pair it with a font
                             # size that is a multiple of 16 (see item.sh).

def read_grid(path):
    rows = [l.rstrip("\n") for l in path.read_text().splitlines()]
    rows = [r for r in rows if r and set(r) <= {"#", "."}]
    assert len(rows) == 16 and all(len(r) == 16 for r in rows), "grid must be 16x16"
    return rows

def draw(pen, rows):
    """One clockwise rectangle per horizontal run of ink.

    TrueType fills by non-zero winding, so same-direction rectangles that touch
    or overlap merge into one solid shape -- no seams, which is the whole point.
    """
    for y, row in enumerate(rows):
        run = 0
        for x in range(17):
            if x < 16 and row[x] == "#":
                run += 1
                continue
            if run:
                x0 = (x - run) * CELL
                x1 = x * CELL
                # y is flipped: grid row 0 is the top, font y grows upward
                y1 = BASE + (16 - y) * CELL
                y0 = BASE + (16 - y - 1) * CELL
                pen.moveTo((x0, y0)); pen.lineTo((x0, y1))
                pen.lineTo((x1, y1)); pen.lineTo((x1, y0))
                pen.closePath()
                run = 0

def main():
    rows = read_grid(HERE / "grid.txt")
    pen = TTGlyphPen(None)
    draw(pen, rows)

    order = [".notdef", "bubble"]
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({CODEPT: "bubble"})
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "bubble": pen.glyph()})
    fb.setupHorizontalMetrics({".notdef": (UPM, 0), "bubble": (UPM, 0)})
    fb.setupHorizontalHeader(ascent=14 * CELL, descent=-2 * CELL)
    fb.setupNameTable({
        "familyName": FAMILY, "styleName": "Regular",
        "uniqueFontIdentifier": f"{FAMILY};Regular;1.000",
        "fullName": f"{FAMILY} Regular", "psName": f"{FAMILY}-Regular",
        "version": "Version 1.000",
    })
    fb.setupOS2(sTypoAscender=14 * CELL, sTypoDescender=-2 * CELL,
            usWinAscent=14 * CELL, usWinDescent=2 * CELL)
    fb.setupPost()

    out = HERE / f"{FAMILY}.ttf"
    fb.save(out)
    print(f"wrote {out}  glyph U+{CODEPT:04X}")

if __name__ == "__main__":
    sys.exit(main())
