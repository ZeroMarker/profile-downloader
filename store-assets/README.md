# Chrome Web Store assets

Upload-ready files are under `images/`:

- `store-icon-128.png` — 128 × 128 store icon (identical to `extension/icons/icon128.png`)
- `promo-small-440x280.png` — required small promotional tile
- `promo-marquee-1400x560.png` — optional marquee tile
- `screenshot-01-overview-1280x800.png` — listing screenshot

`source/` contains the reproducible HTML used for every image:

- `screenshot-01-overview.html` — listing screenshot
- `promo-small.html` — small promotional tile
- `promo-marquee.html` — marquee tile

The promo pages reference `../../extension/icons/icon.svg`, so they pick up icon
changes automatically. Render at 2× and downsample to the exact store size:

```sh
chromium --headless --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=440,280 --screenshot=/tmp/promo-small@2x.png \
  "file://$PWD/store-assets/source/promo-small.html"

python3 -c "from PIL import Image; \
Image.open('/tmp/promo-small@2x.png').convert('RGB') \
  .resize((440, 280), Image.LANCZOS) \
  .save('store-assets/images/promo-small-440x280.png')"
```

Swap `440,280` / `440, 280` for `1400,560` when rendering the marquee.

Before submission, capture additional screenshots from a clean Chrome profile while the exact upload package is running on a public, non-sensitive profile page. Do not include adult content, private account details, copyrighted media, or credentials.
