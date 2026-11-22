// Object geometry -> vector outlines + the print display list sent to the exporter.
import { gradientCoords } from './paint.js';

const K = 0.5522847498;
const mult = (a, b) => fabric.util.multiplyTransformMatrices(a, b);
const tp = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function ellipseSubs(cx, cy, rx, ry) {
  const kx = rx * K; const ky = ry * K;
  return [{
    closed: true,
    pts: [
      ['M', cx + rx, cy],
      ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
      ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
      ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
      ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ],
  }];
}

function rectSubs(w, h, rx, ry) {
  const x = -w / 2; const y = -h / 2;
  rx = Math.min(rx || 0, w / 2); ry = Math.min(ry || rx || 0, h / 2);
  if (!rx || !ry) return [{ closed: true, pts: [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h]] }];
  const kx = rx * K; const ky = ry * K;
  return [{
    closed: true,
    pts: [
      ['M', x + rx, y], ['L', x + w - rx, y],
      ['C', x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry], ['L', x + w, y + h - ry],
      ['C', x + w, y + h - ry + ky, x + w - rx + kx, y + h, x + w - rx, y + h], ['L', x + rx, y + h],
      ['C', x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry], ['L', x, y + ry],
      ['C', x, y + ry - ky, x + rx - kx, y, x + rx, y],
    ],
  }];
}

function pathSubs(obj) {
  const off = obj.pathOffset || { x: 0, y: 0 };
  const subs = []; let cur = null; let px = 0; let py = 0; let sx = 0; let sy = 0;
  for (const c of obj.path) {
    const t = c[0];
    if (t === 'M') { cur = { closed: false, pts: [['M', c[1] - off.x, c[2] - off.y]] }; subs.push(cur); px = sx = c[1]; py = sy = c[2]; }
    else if (t === 'L') { if (!cur) continue; cur.pts.push(['L', c[1] - off.x, c[2] - off.y]); px = c[1]; py = c[2]; }
    else if (t === 'C') { if (!cur) continue; cur.pts.push(['C', c[1] - off.x, c[2] - off.y, c[3] - off.x, c[4] - off.y, c[5] - off.x, c[6] - off.y]); px = c[5]; py = c[6]; }
    else if (t === 'Q') {
      if (!cur) continue;
      const c1x = px + 2 / 3 * (c[1] - px); const c1y = py + 2 / 3 * (c[2] - py);
      const c2x = c[3] + 2 / 3 * (c[1] - c[3]); const c2y = c[4] + 2 / 3 * (c[2] - c[4]);
      cur.pts.push(['C', c1x - off.x, c1y - off.y, c2x - off.x, c2y - off.y, c[3] - off.x, c[4] - off.y]); px = c[3]; py = c[4];
    } else if (t === 'Z' || t === 'z') { if (cur) { cur.closed = true; px = sx; py = sy; } }
  }
  return subs;
}

// Local-space outline of a non-text, non-image, non-group object.
export function localSubs(obj) {
  switch (obj.type) {
    case 'rect': return rectSubs(obj.width, obj.height, obj.rx, obj.ry);
    case 'ellipse': return ellipseSubs(0, 0, obj.rx, obj.ry);
    case 'circle': return ellipseSubs(0, 0, obj.radius, obj.radius);
    case 'triangle': return [{ closed: true, pts: [['M', 0, -obj.height / 2], ['L', obj.width / 2, obj.height / 2], ['L', -obj.width / 2, obj.height / 2]] }];
    case 'line': {
      const p = obj.calcLinePoints();
      return [{ closed: false, pts: [['M', p.x1, p.y1], ['L', p.x2, p.y2]] }];
    }
    case 'polygon': case 'polyline': {
      const off = obj.pathOffset;
      const pts = obj.points.map((p, i) => [i ? 'L' : 'M', p.x - off.x, p.y - off.y]);
      return [{ closed: obj.type === 'polygon', pts }];
    }
    case 'path': return pathSubs(obj);
    default: return [];
  }
}

export function transformSubs(subs, m) {
  return subs.map((s) => ({
    closed: s.closed,
    pts: s.pts.map((p) => (p[0] === 'C' ? ['C', ...tp(m, p[1], p[2]), ...tp(m, p[3], p[4]), ...tp(m, p[5], p[6])] : [p[0], ...tp(m, p[1], p[2])])),
  }));
}

export function subsToD(subs) {
  const r = (v) => Math.round(v * 1000) / 1000;
  return subs.map((s) => s.pts.map((p) => p[0] + ' ' + p.slice(1).map(r).join(' ')).join(' ') + (s.closed ? ' Z' : '')).join(' ');
}

const isText = (o) => ['text', 'i-text', 'textbox'].includes(o.type);
export { isText };

function exportPaint(p, obj, m) {
  if (!p) return null;
  if (p.type === 'solid') return { type: 'solid', cmyk: p.cmyk };
  const w = obj.width || 1; const h = obj.height || 1;
  const c = gradientCoords(p, w, h);
  const stops = p.stops.map((s) => ({ o: s.o, cmyk: s.cmyk }));
  if (p.type === 'lin') {
    return { type: 'linear', x1: c.x1 - w / 2, y1: c.y1 - h / 2, x2: c.x2 - w / 2, y2: c.y2 - h / 2, stops, matrix: m };
  }
  return { type: 'radial', cx: c.x1 - w / 2, cy: c.y1 - h / 2, r: c.r2, stops, matrix: m };
}

function strokeOf(obj, m) {
  if (!obj.vpStroke || !(obj.strokeWidth > 0)) return null;
  return {
    paint: exportPaint(obj.vpStroke, obj, m),
    width: obj.strokeWidth,
    cap: obj.strokeLineCap || 'butt',
    join: obj.strokeLineJoin || 'miter',
    miter: obj.strokeMiterLimit || 4,
    dash: obj.strokeDashArray || null,
  };
}

export function textLines(obj) {
  const lines = [];
  let lh = 0;
  const w = obj.width; const hgt = obj.height;
  for (let i = 0; i < obj._textLines.length; i++) {
    const impl = obj.getHeightOfLineImpl(i);
    lines.push({
      text: obj._textLines[i].join(''),
      x: -w / 2 + obj._getLineLeftOffset(i),
      y: -hgt / 2 + lh + impl * (1 - obj._fontSizeFraction),
    });
    lh += obj.getHeightOfLine(i);
  }
  return lines;
}

function imageRGBA(obj) {
  const el = obj.getElement();
  const pw = el.naturalWidth || el.width; const ph = el.naturalHeight || el.height;
  const cv = document.createElement('canvas');
  cv.width = pw; cv.height = ph;
  const ctx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(el, 0, 0);
  const data = ctx.getImageData(0, 0, pw, ph, { colorSpace: 'srgb' }).data;
  return { rgba: new Uint8Array(data.buffer), pw, ph };
}

// Build the print display list for a set of objects (document coordinates, pt, y-down).
export function buildDisplayList(objects, out = [], parentOpacity = 1, warnings = []) {
  for (const obj of objects) {
    if (!obj.visible || obj.vpGuide) continue;
    const op = parentOpacity * (obj.opacity ?? 1);
    const m = obj.calcTransformMatrix();
    if (obj.type === 'group') {
      if (obj.clipPath) {
        const cm = mult(m, obj.clipPath.calcOwnMatrix());
        out.push({ t: 'clipPush', subs: transformSubs(localSubs(obj.clipPath), cm), rule: obj.clipPath.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' });
        buildDisplayList(obj.getObjects(), out, op, warnings);
        out.push({ t: 'clipPop' });
      } else buildDisplayList(obj.getObjects(), out, op, warnings);
      continue;
    }
    if (obj.type === 'image') {
      const { rgba, pw, ph } = imageRGBA(obj);
      out.push({ t: 'image', matrix: m, w: obj.width, h: obj.height, pw, ph, rgba, opacity: op });
      continue;
    }
    if (isText(obj)) {
      if (!obj.text) continue;
      out.push({
        t: 'text', fontId: obj.fontId, size: obj.fontSize, tracking: obj.charSpacing || 0, skewX: 0,
        lines: textLines(obj), matrix: m,
        fill: exportPaint(obj.vpFill, obj, m), stroke: strokeOf(obj, m), opacity: op,
        strokeFirst: obj.paintFirst === 'stroke',
      });
      continue;
    }
    const subs = transformSubs(localSubs(obj), m);
    if (!subs.length) continue;
    const isOpen = obj.type === 'line' || obj.type === 'polyline';
    out.push({
      t: 'path', subs,
      fill: isOpen ? null : exportPaint(obj.vpFill, obj, m),
      stroke: strokeOf(obj, m), opacity: op,
      rule: obj.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
      strokeFirst: obj.paintFirst === 'stroke',
    });
  }
  return out;
}

// Absolute outline (doc coords) of any object — text is shaped by HarfBuzz in the main process.
export async function absoluteSubs(obj) {
  const m = obj.calcTransformMatrix();
  if (isText(obj)) {
    let subs = [];
    for (const ln of textLines(obj)) {
      if (!ln.text) continue;
      const s = await window.vpm.invoke('fonts:shape', { fontId: obj.fontId, text: ln.text, size: obj.fontSize, tracking: obj.charSpacing || 0 });
      subs.push(...transformSubs(s.subpaths, [1, 0, 0, 1, ln.x, ln.y]));
    }
    return transformSubs(subs, m);
  }
  if (obj.type === 'group') {
    const all = [];
    for (const o of obj.getObjects()) all.push(...await absoluteSubs(o));
    return all;
  }
  if (obj.type === 'image') {
    const w = obj.width / 2; const hh = obj.height / 2;
    return transformSubs([{ closed: true, pts: [['M', -w, -hh], ['L', w, -hh], ['L', w, hh], ['L', -w, hh]] }], m);
  }
  return transformSubs(localSubs(obj), m);
}

export function bboxOfSubs(subs) {
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const s of subs) for (const p of s.pts) for (let i = 1; i < p.length; i += 2) {
    x1 = Math.min(x1, p[i]); x2 = Math.max(x2, p[i]); y1 = Math.min(y1, p[i + 1]); y2 = Math.max(y2, p[i + 1]);
  }
  return { x1, y1, x2, y2 };
}
