// Print preflight: catches the usual press problems before export.
import { state } from './state.js';
import { inkTotal, fmt } from './util.js';
import { isText } from './geometry.js';

export async function runPreflight(format) {
  const canvas = state.canvas;
  const d = state.doc; const u = d.units;
  const issues = [];
  const add = (sev, msg, obj) => issues.push({ sev, msg, obj });
  const paints = (o) => [o.vpFill, o.vpStroke].filter(Boolean).flatMap((p) => (p.type === 'solid' ? [p.cmyk] : p.stops.map((s) => s.cmyk)));
  const label = (o) => o.name || (isText(o) ? `“${(o.text || '').slice(0, 20)}”` : o.type);

  const walk = (list, parentOpacity = 1) => {
    for (const o of list) {
      if (!o.visible) continue;
      const op = parentOpacity * (o.opacity ?? 1);
      if (o.type === 'group') { walk(o.getObjects(), op); continue; }
      const b = o.getBoundingRect();
      // completely off the printable area
      if (b.left > d.width + d.bleed || b.top > d.height + d.bleed || b.left + b.width < -d.bleed || b.top + b.height < -d.bleed) {
        add('info', `${label(o)} is outside the artboard and will not print.`, o);
        continue;
      }
      if (o.type === 'image') {
        const el = o.getElement();
        const sx = o.getScaledWidth(); const sy = o.getScaledHeight();
        const ppi = Math.min((el.naturalWidth || o.width) / (sx / 72), (el.naturalHeight || o.height) / (sy / 72));
        if (ppi < 150) add('error', `Image ${label(o)} is only ${Math.round(ppi)} ppi — it will print blurry (need 300 ppi).`, o);
        else if (ppi < 250) add('warn', `Image ${label(o)} is ${Math.round(ppi)} ppi — 300 ppi is recommended for print.`, o);
        if (format === 'eps') add('info', `EPS has no transparency: transparent areas of ${label(o)} become white. Use AI or PDF to keep transparency.`, o);
      }
      if (op < 1 && format === 'eps') add('warn', `${label(o)} uses ${Math.round(op * 100)}% opacity — EPS cannot keep transparency, it will print solid. Use PDF or AI.`, o);
      for (const c of paints(o)) {
        if (inkTotal(c) > 300) { add('warn', `${label(o)} uses ${Math.round(inkTotal(c))}% total ink (C${c[0]} M${c[1]} Y${c[2]} K${c[3]}). Most presses need ≤ 300%.`, o); break; }
      }
      if (isText(o)) {
        if (!o.fontId || !state.fontById.has(o.fontId)) add('error', `Font for ${label(o)} is missing on this computer.`, o);
        const f = o.vpFill;
        const size = o.fontSize * Math.min(o.scaleX, o.scaleY);
        if (f && f.type === 'solid') {
          const [c, m, y, k] = f.cmyk;
          if (k >= 90 && c + m + y > 0 && size < 14) add('warn', `Small text ${label(o)} uses 4-colour black — set it to pure K100 so it prints sharp.`, o);
          if (c + m + y + k > 0 && [c, m, y, k].filter((v) => v > 0).length >= 3 && size < 7) add('warn', `Very small text ${label(o)} (${Math.round(size * 10) / 10} pt) uses several inks — may print fuzzy if plates mis-register.`, o);
        }
        if (size < 5) add('warn', `Text ${label(o)} is ${Math.round(size * 10) / 10} pt — below 5 pt may not be readable.`, o);
        if (d.safe > 0) {
          const inside = b.left >= d.safe - 0.5 && b.top >= d.safe - 0.5 && b.left + b.width <= d.width - d.safe + 0.5 && b.top + b.height <= d.height - d.safe + 0.5;
          const onArt = b.left < d.width && b.top < d.height && b.left + b.width > 0 && b.top + b.height > 0;
          if (onArt && !inside) add('warn', `Text ${label(o)} is outside the safe area (${fmt(d.safe, u)} ${u} from the edge) — it may get trimmed.`, o);
        }
      }
      if (o.vpStroke && o.strokeWidth > 0 && o.strokeWidth < 0.25) add('warn', `${label(o)} has a ${o.strokeWidth} pt hairline stroke — use at least 0.25 pt.`, o);
      // reaches the trim edge but not the bleed edge
      if (d.bleed > 0 && !isText(o)) {
        const e = 0.5;
        const short = [];
        if (b.left <= e && b.left > -d.bleed + e) short.push('left');
        if (b.top <= e && b.top > -d.bleed + e) short.push('top');
        if (b.left + b.width >= d.width - e && b.left + b.width < d.width + d.bleed - e) short.push('right');
        if (b.top + b.height >= d.height - e && b.top + b.height < d.height + d.bleed - e) short.push('bottom');
        if (short.length) add('warn', `${label(o)} touches the ${short.join('/')} edge but does not extend into the bleed — a white line may show after cutting.`, o);
      }
    }
  };
  const objs = canvas.getObjects();
  walk(objs);
  if (d.bleed <= 0) add('info', 'Document has no bleed. Add 3 mm bleed if anything prints to the edge.');
  if (!objs.length) add('info', 'The artboard is empty.');
  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.sev] - order[b.sev]);
  return issues;
}
