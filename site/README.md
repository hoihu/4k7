# 4k7.dev

The landing page and brand assets. Plain HTML, no build step.

## Deploy (Cloudflare Pages)

Upload this `site/` folder as the project's assets (Workers & Pages → Create → Pages → Upload assets),
or point Pages at the repo with build output directory `site`. Custom domain: `4k7.dev`.

## Files

| File | Use |
|---|---|
| `index.html` | The page. Dark theme. |
| `favicon.svg` | Browser tab icon. |
| `brand/mark.svg` | The resistor alone, transparent. |
| `brand/logo.svg`, `brand/logo-light.svg` | Resistor + "4k7" wordmark, for light / dark backgrounds. |
| `brand/avatar.svg`, `brand/avatar.png` (1024 px), `brand/avatar-256.png` | Square avatar for GitHub, npm, social. Safe for circular crops. |
| `brand/og.html` → `brand/og.png` | 1200 × 630 social preview, linked from `index.html`. |

## Colours

The bands are the 4k7 colour code: yellow `#f2c230` (4), violet `#7a3fb0` (7), red `#d6382f` (×100),
gold `#d7a63a` (±5 %). Body `#e8d9bd`, leads `#b8b0a4`. Page palette matches the app (`docs/ui/prototype.html`).

## Re-rendering the PNGs

Open `brand/og.html` and `brand/avatar.svg` in a browser and screenshot at 1200 × 630 and 512 × 512 (2×),
or use Playwright with a headless Chromium.
