<script lang="ts">
  /** The 4k7 resistor: yellow, violet, red bands. A slim glossy pill, cropped to the part so the bands read at bar size. */
  let { size = 22 }: { size?: number } = $props();
  const uid = $props.id();
  const clip = `logo-clip-${uid}`;
  const gloss = `logo-gloss-${uid}`;
  const wire = `logo-wire-${uid}`;
</script>

<svg width={Math.round(size * 2.6)} height={Math.round(size * 0.5)} viewBox="-10 24 84 16" aria-hidden="true">
  <defs>
    <clipPath id={clip}><rect x="6" y="25" width="52" height="14" rx="7" /></clipPath>
    <linearGradient id={gloss} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".55" />
      <stop offset=".45" stop-color="#fff" stop-opacity="0" />
      <stop offset="1" stop-color="#000" stop-opacity=".18" />
    </linearGradient>
    <linearGradient id={wire} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e4e1dc" />
      <stop offset=".35" stop-color="#fbfaf8" />
      <stop offset="1" stop-color="#7f7a72" />
    </linearGradient>
  </defs>
  <rect x="-10" y="30.5" width="84" height="3" rx="1.5" fill="url(#{wire})" />
  <g clip-path="url(#{clip})">
    <rect x="6" y="25" width="52" height="14" fill="#e9dcc3" />
    <rect x="15" y="25" width="8" height="14" fill="#f2c230" />
    <rect x="26" y="25" width="8" height="14" fill="#8a4fd0" />
    <rect x="37" y="25" width="8" height="14" fill="#e0443a" />
    <rect x="49" y="25" width="3.5" height="14" fill="#d7a63a" />
    <rect x="6" y="25" width="52" height="14" fill="url(#{gloss})" />
  </g>
</svg>
