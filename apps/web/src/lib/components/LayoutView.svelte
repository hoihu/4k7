<script lang="ts">
  import { app } from '../app.svelte.ts';
</script>

<div class="lay">
  <div class="card">
    <h3>Board layout arrives in M2</h3>
    <p>
      The layout workspace will follow proposal B: the board fills the screen, layers and DRC float on top, and a command bar
      takes hints. Dragging a part creates a placement constraint in the ledger.
    </p>
    <p class="muted">
      Placement hints you give now ({app.k?.ledger.filter((k) => k.text.startsWith('near') || k.text.startsWith('layer')).length ?? 0} in the ledger)
      are already stored and will be applied by the placer.
    </p>
    <p class="muted">Design preview: <code>docs/ui/prototype.html#lay</code> in the repository.</p>
  </div>
</div>

<style>
  .lay { display: grid; place-items: center; height: 100%; background: var(--canvas); background-image: radial-gradient(var(--grid) 1px, transparent 1px); background-size: 16px 16px; padding: 16px; }
  .card { max-width: 460px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; box-shadow: var(--shadow); }
  h3 { margin: 0 0 6px; font-size: 15px; }
  p { margin: 0 0 8px; color: var(--txt-2); }
</style>
