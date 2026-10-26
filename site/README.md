# 4k7.dev

The landing page and brand assets. Plain HTML, no build step.

## Deploy (Cloudflare Workers)

Deployed automatically by Cloudflare Workers Builds: Workers & Pages → Create → Import a repository →
`hoihu/4k7`, project name `4k7`, no build command, deploy command `npx wrangler deploy`, and under
Advanced settings the **root directory** `site`. Every push to `main` then redeploys; other branches
get preview URLs via `npx wrangler preview`, which needs the (empty) `previews` block in the config.
`wrangler.jsonc` here names the Worker and marks this folder as its static assets
(`.assetsignore` keeps this README and the config out of the upload). Custom domain `4k7.dev`: Worker →
Settings → Domains & Routes.

By hand: `cd site && npx wrangler deploy` (after `npx wrangler login`).

## Files

| File | Use |
|---|---|
| `index.html` | The page. Dark theme. Four sections, one per band of the resistor: Schematic (yellow, 4), Board (violet, 7), Enclosure (red, ×100), Order (gold, ±5 %). |
| `shots/*.webp` | The screenshots and renders on the page, taken from the real app with a real design (the Sunflower lamp) at 1440 × 900, 2× (WebP, quality ~85). The renders (`exploded`, `lamp`) are the 3D views on a transparent background. The cost panels show live prices of 26 Oct 2026: retake them, or say when they are from, when they get old. |
| `shots/board.mp4` | The Layout view going 2D → 3D → 2D, as the app does it, with a drawn cursor: recorded frame by frame at 60 fps with the page's `requestAnimationFrame` and `performance.now` stepped by hand, so the camera flights run at their real speed (the moment the 3D view takes to build is left out). 2208 × 1380 H.264; `shots/board.webp` is its first frame, the poster. It loops without a seam because the 2D view comes back to the framing it starts from. It plays only while in view, and not with reduced motion. |
| `changelog.html` | 4k7.dev/changelog. The releases in it are written from `CHANGELOG.md` by `node scripts/changelog.mjs` (CI checks that it is up to date); the rest of the page is edited by hand. |
| `favicon.svg` | Browser tab icon. |
| `brand/mark.svg` | The resistor alone, transparent. |
| `brand/logo.svg`, `brand/logo-light.svg` | Resistor + "4k7" wordmark, for light / dark backgrounds. |
| `brand/avatar.svg`, `brand/avatar.png` (1024 px), `brand/avatar-256.png` | Square avatar for GitHub, npm, social. Safe for circular crops. |
| `brand/og.html` → `brand/og.png` | 1200 × 630 social preview, linked from `index.html` and `changelog.html`; it shows `shots/exploded.webp`. |

## Colours

The bands are the 4k7 colour code: yellow `#f2c230` (4), violet `#7a3fb0` (7), red `#d6382f` (×100),
gold `#d7a63a` (±5 %). Body `#e8d9bd`, leads `#b8b0a4`. Page palette matches the app (`docs/ui/prototype.html`).

## Re-rendering the PNGs

Open `brand/og.html` (served, so it finds `../shots/`) and `brand/avatar.svg` in a browser and screenshot at
1200 × 630 (1×) and 512 × 512 (2×), or use Playwright with a headless Chromium.
