/**
 * Cross-checks between the schematic, the board and the fab files (XCHK.*): the symbol's pins
 * against the footprint's pads, the nets against the pads that carry them, the `package`
 * parameter against the footprint built, the board's own objects against the nets, and the parts
 * the BOM and pick-and-place leave out. A pure function of the design: the board and both files
 * are made from the same parts, so what they will hold is worked out here without placing the board.
 */
import { footprintFor, packageOf, standardPackage } from '@4k7/parts';
import type { Component, Design, Diagnostic, EditOp, PartCard, Severity } from '@4k7/schema';
import { padPins } from '@4k7/schema';
import { applyWaivers, cardOf, componentsSorted, natCmp } from './doc.ts';

/** The pads of a footprint as far as they are known: whether or not it passed the generator's own checks. */
interface Land {
  pads: { number: string; also?: string[]; drill?: number }[];
  /** Why the part is not on the board (absent: it is). */
  reason?: string;
}

const list = (xs: string[], max = 8) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));
const names = (d: Design, c: Component, pins: string[]) => pins.map((n) => (d.nets[c.pins[n] ?? '']?.name ? `${n} (${d.nets[c.pins[n]!]!.name})` : n));
/** A package name compared by what it says: 0603 and R_0603 are one package, SOT-23-5 and SOT23-5 too. */
const canon = (name: string, pins: number) => (standardPackage(name, pins)?.name ?? name).toUpperCase().replace(/[^A-Z0-9.]/g, '');

export function crossChecks(d: Design): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (severity: Severity, code: string, entities: string[], message: string, fixHints?: EditOp[]) =>
    out.push({ code, severity, entities, message, ...(fixHints ? { fixHints } : {}) });

  const lands = new Map<string, Land>();
  const landOf = (card: PartCard, c: Component): { land: Land | null; pkgName: string | null } => {
    const pkg = packageOf(card, c.params, d.packageDefaults);
    if (!pkg) return { land: null, pkgName: null };
    const key = `${card.id}|${pkg.name}|${pkg.pins}`;
    let land = lands.get(key);
    if (!land) {
      const fp = footprintFor(pkg, card.pins.map((p) => p.number));
      // a footprint the generator refused still has its pads, when they were given by hand
      land = fp.ok ? { pads: fp.footprint.pads } : { pads: pkg.pads ?? [], reason: fp.reason };
      lands.set(key, land);
    }
    return { land, pkgName: pkg.name };
  };

  /** Net id → the pins that the board lost, as "U1.4". */
  const lost = new Map<string, string[]>();

  for (const c of componentsSorted(d)) {
    const card = cardOf(d, c.part);
    if (!card?.pins.length) continue;
    const { land, pkgName } = landOf(card, c);
    const pinNums = card.pins.map((p) => p.number);

    /* ---- the part itself: on the board, in the BOM and the pick-and-place? ---- */
    if (!land || land.reason) {
      const nets = [...new Set(Object.values(c.pins).map((id) => d.nets[id]?.name).filter((n): n is string => !!n))].sort(natCmp);
      const why = !land ? 'it has no package data' : `its ${pkgName} footprint is unusable (${land.reason})`;
      push('warning', 'XCHK.NOT_IN_BOM', [c.refdes],
        `${c.refdes} (${card.id}) is in the schematic but not on the board: ${why}. The BOM and the pick-and-place are made from the board, so it is in neither and the order would lack it${nets.length ? `; ${list(nets, 6)} lose${nets.length === 1 ? 's' : ''} its pad` : ''}. Give it a footprint with set_footprint (pads from the datasheet's package drawing, one for every pin).`);
    }

    /* ---- the symbol's pins against the footprint's pads ---- */
    if (land?.pads.length) {
      const claimed = new Map<string, string[]>(); // pin (as the pad names it) → pads naming it
      for (const pad of land.pads) for (const n of padPins(pad)) claimed.set(n, [...(claimed.get(n) ?? []), pad.number]);
      const exact = (n: string) => claimed.has(n);
      const folded = (n: string) => [...claimed.keys()].find((q) => q !== n && q.toUpperCase() === n.toUpperCase());
      const pkgLabel = pkgName ?? 'footprint';

      const noPad = pinNums.filter((n) => !exact(n) && !folded(n));
      const connected = noPad.filter((n) => c.pins[n]);
      if (noPad.length) {
        const pads = [...new Set(land.pads.map((p) => p.number))];
        push(connected.length ? 'error' : 'info', 'XCHK.PIN_NO_PAD', [c.refdes],
          `${c.refdes}: ${noPad.length === 1 ? 'pin' : 'pins'} ${list(names(d, c, noPad))} of the symbol ${noPad.length === 1 ? 'has' : 'have'} no pad in the ${pkgLabel} footprint (pads: ${list(pads, 12)})${connected.length ? '; the board cannot connect them' : ''}. ` +
            `Compare the part's pin numbers with the package drawing: correct the pins, use the right package (set_param package), or give the part its own footprint with set_footprint (a pad for every pin).`);
        for (const n of connected) lost.set(c.pins[n]!, [...(lost.get(c.pins[n]!) ?? []), `${c.refdes}.${n}`]);
      }

      // a pad whose number matches a pin in another case only: the footprint passes, the board does not connect it
      const cased = pinNums.filter((n) => !exact(n) && folded(n));
      if (cased.length) {
        push(cased.some((n) => c.pins[n]) ? 'error' : 'warning', 'XCHK.PIN_PAD_MAP', [c.refdes],
          `${c.refdes}: ${cased.map((n) => `pin ${n} matches pad ${folded(n)} only in upper/lower case`).join('; ')}, so the board does not connect ${cased.length === 1 ? 'it' : 'them'}. Make the pin numbers and the pad numbers spell alike (the part's pins, or set_footprint with the pad numbers spelled as the pins).`);
        for (const n of cased) if (c.pins[n]) lost.set(c.pins[n]!, [...(lost.get(c.pins[n]!) ?? []), `${c.refdes}.${n}`]);
      }

      // one pin claimed by two different pads: which one is it?
      const twice = pinNums.filter((n) => new Set(claimed.get(n)).size > 1);
      if (twice.length) {
        push('warning', 'XCHK.PIN_PAD_MAP', [c.refdes],
          `${c.refdes}: ${twice.map((n) => `pin ${n} is on pads ${[...new Set(claimed.get(n))].join(' and ')}`).join('; ')} (its own number on one, "also" of the other), so it is not clear which pad is the pin. Give each pin one pad: pins that share a pad are listed on that pad once (set_footprint also).`);
      }

      // a pad no pin of the symbol is on, unless the pin is declared not connected (type nc)
      const strays = [...new Set(land.pads.flatMap(padPins).filter((q) => !pinNums.some((n) => n.toUpperCase() === q.toUpperCase())))];
      if (strays.length) {
        push('warning', 'XCHK.PAD_NO_PIN', [c.refdes],
          `${c.refdes}: the ${pkgLabel} footprint has ${strays.length === 1 ? 'a pad' : 'pads'} ${list(strays)} that no pin of the symbol is on, so ${strays.length === 1 ? 'it is' : 'they are'} soldered to nothing${strays.some((s) => /^(EP|PAD)$/i.test(s)) ? ' (an exposed pad is usually a ground or thermal pin the part card should list)' : ''}. ` +
            `Add the missing pin to the part (an exposed pad as pin EP, type nc if it is internally open), use a package with the right pin count (set_param package), or correct the footprint with set_footprint.`);
      }
    }

    /* ---- the package parameter against the footprint that is built ---- */
    const asked = c.params.package?.trim();
    if (asked && land && pkgName && canon(asked, card.pins.length) !== canon(pkgName, card.pins.length)) {
      const why = card.packageInfo ? `the part card carries its own package data (${card.packageInfo.name}), which wins over the parameter` : `"${asked}" is not a package the generator knows, so the card's ${pkgName} was used`;
      push('warning', 'XCHK.PACKAGE_MISMATCH', [c.refdes],
        `${c.refdes}: the package parameter says ${asked}, but its footprint is ${pkgName}: ${why}. The BOM and the pick-and-place say ${pkgName}, a part bought for ${asked} will not fit the pads. ` +
          `Remove the parameter if ${pkgName} is right (set_param package null), or give the part a footprint for ${asked} (set_footprint).`,
        [{ op: 'set_param', ref: c.refdes, params: { package: null } }]);
    }
  }

  /* ---- the nets against the pads that carry them ---- */
  for (const [id, pins] of [...lost].sort((a, b) => natCmp(d.nets[a[0]]?.name ?? '', d.nets[b[0]]?.name ?? ''))) {
    const net = d.nets[id];
    if (!net) continue;
    const total = Object.values(d.components).reduce((n, c) => n + Object.values(c.pins).filter((x) => x === id).length, 0);
    const left = total - pins.length;
    push('error', 'XCHK.NET_INCOMPLETE', [`net:${net.name}`],
      `Net ${net.name} joins ${total} pins in the schematic, but ${list(pins)} ${pins.length === 1 ? 'has' : 'have'} no pad on the board, so it reaches only ${Math.max(left, 0)} pad${left === 1 ? '' : 's'}${left < 2 ? ' and nothing can be routed' : ''}. Fix the pin-to-pad mismatch reported for ${[...new Set(pins.map((p) => p.split('.')[0]))].join(', ')}.`);
  }

  /* ---- the board's own objects on nets the schematic no longer has ---- */
  const b = d.board;
  if (b) {
    const unknown = (what: string, items: { id?: string; netId?: string }[], fix: string, key = (x: { id?: string }) => x.id ?? '?') => {
      const bad = items.filter((x) => x.netId && !d.nets[x.netId]);
      if (bad.length) {
        push('warning', 'XCHK.BOARD_NET_UNKNOWN', bad.map(key).slice(0, 8),
          `${what} ${list(bad.map(key), 6)} ${bad.length === 1 ? 'is' : 'are'} on a net the schematic does not have (${list([...new Set(bad.map((x) => x.netId!))], 4)}), probably a net that was deleted or renamed away. ${fix}`);
      }
    };
    unknown('Mounting hole', b.holes ?? [], 'Remove it (remove_hole) and add it again on the right net (add_hole).');
    unknown('Plane', (b.planes ?? []).map((p) => ({ id: `${p.layer} plane`, netId: p.netId })), 'Set the plane again on an existing net (set_plane).');
    unknown('Via group', b.vias ?? [], 'Remove it (remove_vias) and add it again on the right net (add_vias).');
    unknown('Drawn track', b.drawn?.tracks ?? [], 'Erase it (erase_copper) and draw the connection again on the right net.');
    unknown('Drawn via', b.drawn?.vias ?? [], 'Erase it (erase_copper) and draw it again on the right net.');
  }

  applyWaivers(d, out);
  return out;
}
