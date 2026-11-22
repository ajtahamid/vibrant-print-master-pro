// Paint model: every colour in the app is CMYK. Screen colours are previews only.
import { cmykCss, deepClone } from './util.js';

export const PROPS = ['vpFill', 'vpStroke', 'name', 'fontId', 'vpLocked', 'vpHidden', 'selectable', 'evented', 'visible',
  'lockMovementX', 'lockMovementY', 'lockScalingX', 'lockScalingY', 'lockRotation', 'hasControls', 'strokeUniform', 'vpClip', 'vpPolySides', 'vpStar'];

export const solid = (cmyk) => ({ type: 'solid', cmyk: [...cmyk] });
export const DEFAULT_FILL = solid([0, 0, 0, 0]);
export const DEFAULT_STROKE = solid([0, 0, 0, 100]);

export function paintCss(p) {
  if (!p) return null;
  if (p.type === 'solid') return cmykCss(p.cmyk);
  const stops = [...p.stops].sort((a, b) => a.o - b.o).map((s) => `${cmykCss(s.cmyk)} ${s.o * 100}%`).join(', ');
  return p.type === 'lin' ? `linear-gradient(${90 - (p.angle || 0)}deg, ${stops})` : `radial-gradient(circle, ${stops})`;
}

export function gradientCoords(p, w, h) {
  if (p.type === 'lin') {
    const a = (p.angle || 0) * Math.PI / 180;
    const L = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const dx = Math.cos(a) * L / 2; const dy = -Math.sin(a) * L / 2;
    return { x1: w / 2 - dx, y1: h / 2 - dy, x2: w / 2 + dx, y2: h / 2 + dy };
  }
  const r = Math.max(w, h) / 2;
  return { x1: w / 2, y1: h / 2, r1: 0, x2: w / 2, y2: h / 2, r2: r };
}

function toFabric(p, obj) {
  if (!p) return null;
  if (p.type === 'solid') return cmykCss(p.cmyk);
  const w = obj.width || 1; const h = obj.height || 1;
  return new fabric.Gradient({
    type: p.type === 'lin' ? 'linear' : 'radial',
    gradientUnits: 'pixels',
    coords: gradientCoords(p, w, h),
    colorStops: [...p.stops].sort((a, b) => a.o - b.o).map((s) => ({ offset: s.o, color: cmykCss(s.cmyk) })),
  });
}

export function isPaintable(o) { return o && !['image', 'group', 'activeselection', 'activeSelection'].includes(o.type); }

export function applyPaint(obj) {
  if (!obj) return;
  if (obj.type === 'group' || obj.type === 'activeselection' || obj.type === 'activeSelection') {
    obj.getObjects().forEach(applyPaint);
    if (obj.clipPath) { obj.clipPath.set({ fill: '#000' }); }
    obj.dirty = true;
    return;
  }
  if (obj.type === 'image') return;
  const isLine = obj.type === 'line' || obj.type === 'polyline';
  obj.set({
    fill: isLine ? null : toFabric(obj.vpFill, obj),
    stroke: toFabric(obj.vpStroke, obj),
    strokeUniform: true,
  });
  obj.dirty = true;
}

export function refreshAllPaints(canvas) {
  canvas.getObjects().forEach(applyPaint);
  canvas.requestRenderAll();
}

export function collectCmyk(objs, out = []) {
  for (const o of objs) {
    if (o.type === 'group') collectCmyk(o.getObjects(), out);
    for (const p of [o.vpFill, o.vpStroke]) {
      if (!p) continue;
      if (p.type === 'solid') out.push(p.cmyk); else p.stops.forEach((s) => out.push(s.cmyk));
    }
  }
  return out;
}

export const clonePaint = (p) => (p ? deepClone(p) : null);

export const SWATCHES = [
  ['None', null],
  ['White', [0, 0, 0, 0]], ['Black (K100)', [0, 0, 0, 100]], ['Rich Black', [60, 40, 40, 100]],
  ['K80', [0, 0, 0, 80]], ['K60', [0, 0, 0, 60]], ['K40', [0, 0, 0, 40]], ['K20', [0, 0, 0, 20]], ['K10', [0, 0, 0, 10]],
  ['Cyan', [100, 0, 0, 0]], ['Magenta', [0, 100, 0, 0]], ['Yellow', [0, 0, 100, 0]],
  ['Red', [0, 100, 100, 0]], ['Orange', [0, 60, 100, 0]], ['Gold', [0, 20, 100, 0]],
  ['Green', [100, 0, 100, 0]], ['Leaf', [75, 0, 100, 0]], ['Teal', [100, 0, 40, 0]],
  ['Blue', [100, 100, 0, 0]], ['Royal', [100, 70, 0, 0]], ['Sky', [60, 0, 0, 0]],
  ['Purple', [70, 100, 0, 0]], ['Pink', [0, 80, 0, 0]], ['Maroon', [0, 100, 80, 40]],
  ['Brown', [30, 60, 90, 30]], ['Navy', [100, 90, 20, 30]], ['Bottle Green', [90, 30, 90, 30]],
];
