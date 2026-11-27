# A board saved by KiCad 10.0

`pic_programmer-excerpt.kicad_pcb` is an excerpt of `demos/pic_programmer/pic_programmer.kicad_pcb` from
KiCad's source, [KiCad/kicad-source-mirror](https://github.com/KiCad/kicad-source-mirror) at tag `10.0.0`
(commit 0feeca2a807f428ad2b3fa7c1e39625cb769f02c; the whole file's SHA-256 is
1ca70b620506818eb0227e2863bbd573d1fec1672072dc43d0dbe8475e69c8fb). That board was saved by KiCad 10.0:
`(version 20260206)`, `(generator_version "10.0")`.

Kept: its lines 1–34 (the header, `general`, `paper`, `title_block` and the layer table), its first
`segment` and its first `via`, and the closing `(embedded_fonts no)`. Everything else is left out, so the
excerpt is a board without footprints, outline or zones. The KiCad export's tests read it to hold the
writer's tokens, its layer table and the order of its sections against KiCad's own
(`packages/fab/test/kicad.test.ts`, docs/design/kicad-export.md §2).

Licence: KiCad's demo files are licensed under CC BY-SA 4.0 (KiCad's `LICENSE.README`:
"Licensed under CC BY-SA 4.0: All the demo files provided in demos/*"). This excerpt is shared under the
same licence, © the KiCad developers; it is not under 4k7's MIT licence.
