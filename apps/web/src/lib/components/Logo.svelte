<script lang="ts">
  /** The 4k7 resistor: yellow, violet, red bands. */
  let { size = 22 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true"><rect x="0" y="29" width="64" height="6" rx="3" fill="#b8b0a4"/><rect x="8" y="16" width="48" height="32" rx="12" fill="#e8d9bd"/><rect x="16" y="16" width="6" height="32" fill="#f2c230"/><rect x="25" y="16" width="6" height="32" fill="#7a3fb0"/><rect x="34" y="16" width="6" height="32" fill="#d6382f"/><rect x="45" y="16" width="6" height="32" fill="#d7a63a"/></svg>
