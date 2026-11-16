# Extension icons

`icon.svg` is the master file. The design is deliberately reduced to three shapes —
navy tile, cyan media card, white download arrow — with a thin navy gap between the
arrow and the card so the arrow keeps a hard edge at small sizes. No inner panel, no
photo detail, no decorative underline: at 16 px those were turning into noise.

Production sizes: 16, 32, 48, 128 PNG, all rendered from the same SVG.

Regenerate the PNGs after editing `icon.svg`:

```sh
pip install --user cairosvg   # or use rsvg-convert if installed

python3 - <<'PY'
import cairosvg

for size in (16, 32, 48, 128):
    cairosvg.svg2png(
        url="extension/icons/icon.svg",
        write_to=f"extension/icons/icon{size}.png",
        output_width=size,
        output_height=size,
    )
PY
```

Render each size from the SVG instead of downscaling `icon128.png`; a plain resize
blurs the 2 px arrow stroke the 16 px icon depends on.

Keep `store-assets/images/store-icon-128.png` identical to `icon128.png`.
