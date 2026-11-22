// Drawing & interaction tools.
import { state, on, emit } from './state.js';
import { $, $$, toast } from './util.js';
import { applyPaint, clonePaint, isPaintable } from './paint.js';
import { fontStack } from './fonts.js';
import { isText } from './geometry.js';
import { commit, setZoom, panBy, convertToPath, selectObjects } from './app.js';

let canvas;
const DRAW_TOOLS = ['pen', 'text', 'rect', 'roundrect', 'ellipse', 'polygon', 'star', 'line', 'eyedropper', 'zoom', 'hand'];
const CURSORS = { pen: 'crosshair', text: 'text', rect: 'crosshair', roundrect: 'crosshair', ellipse: 'crosshair', polygon: 'crosshair', star: 'crosshair', line: 'crosshair', eyedropper: 'copy', zoom: 'zoom-in', hand: 'grab', select: 'default', direct: 'default' };
const HINTS = {
  pen: 'Click to add corner points · drag for curves · click the first point to close · Enter/Esc to finish',
  text: 'Click for point text · drag a box for area text',
  rect: 'Drag to draw · Shift = square · Alt = from centre', roundrect: 'Drag to draw · Shift = square', ellipse: 'Drag to draw · Shift = circle · Alt = from centre',
  polygon: 'Drag to draw a hexagon (change sides in Properties)', star: 'Drag to draw a star (change points in Properties)', line: 'Drag to draw · Shift = 45° steps',
  eyedropper: 'Click an object to copy its fill & stroke to the selection',
  direct: 'Click a shape to edit its anchor points & handles',
  zoom: 'Click to zoom in · Alt-click to zoom out', hand: 'Drag to move the view',
};

export function setTool(t, temp) {
  if (state.tool === 'pen' && t !== 'pen') finishPen(false);
  if (state.tool === 'direct' && t !== 'direct') exitPathEdit();
  state.tool = t;
  $$('#toolbar .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  const drawing = DRAW_TOOLS.includes(t);
  canvas.selection = !drawing;
  canvas.skipTargetFind = drawing && t !== 'eyedropper' && t !== 'text';
  canvas.defaultCursor = CURSORS[t] || 'default';
  canvas.hoverCursor = drawing ? (CURSORS[t] || 'crosshair') : 'move';
  if (drawing && t !== 'text') { canvas.discardActiveObject(); }
  canvas.requestRenderAll();
  const hint = $('#hint');
  if (HINTS[t] && !temp) { hint.textContent = HINTS[t]; hint.style.display = 'block'; } else hint.style.display = 'none';
}

const sp = (e) => e.scenePoint || canvas.getScenePoint(e.e);

// ---------- shapes ----------
let drag = null;
function newPaints(o) {
  o.vpFill = clonePaint(state.defaults.fill);
  o.vpStroke = clonePaint(state.defaults.stroke);
  o.strokeWidth = state.defaults.strokeWidth;
  o.strokeUniform = true;
  return o;
}
function regularPoints(n, w, h, star, inner = 0.5) {
  const pts = []; const cnt = star ? n * 2 : n;
  for (let i = 0; i < cnt; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / cnt;
    const r = star && i % 2 ? inner : 1;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  // normalise to the box
  const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  return pts.map((p) => ({ x: ((p.x - minX) / (maxX - minX)) * w, y: ((p.y - minY) / (maxY - minY)) * h }));
}
export function regenPolygon(o, sides) {
  const w = o.width; const h = o.height;
  const pts = regularPoints(sides, w, h, !!o.vpStar, o.vpStar || 0.5);
  const c = o.getCenterPoint();
  o.set({ points: pts });
  o.setDimensions ? o.setDimensions() : o._setPositionDimensions({});
  o.setPositionByOrigin(c, 'center', 'center');
  o.vpPolySides = sides;
  o.setCoords();
}

function rectFrom(a, b, e) {
  let x1 = a.x; let y1 = a.y; let w = b.x - a.x; let h = b.y - a.y;
  if (e.shiftKey) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
  if (e.altKey) { x1 = a.x - w; y1 = a.y - h; w *= 2; h *= 2; }
  return { left: Math.min(x1, x1 + w), top: Math.min(y1, y1 + h), width: Math.abs(w), height: Math.abs(h) };
}

function startShape(e) {
  const p = sp(e);
  const t = state.tool;
  let o;
  if (t === 'rect' || t === 'roundrect') o = new fabric.Rect({ left: p.x, top: p.y, width: 0.1, height: 0.1, rx: t === 'roundrect' ? 12 : 0, ry: t === 'roundrect' ? 12 : 0 });
  else if (t === 'ellipse') o = new fabric.Ellipse({ left: p.x, top: p.y, rx: 0.05, ry: 0.05 });
  else if (t === 'polygon' || t === 'star') {
    o = new fabric.Polygon(regularPoints(t === 'star' ? 5 : 6, 1, 1, t === 'star'), { left: p.x, top: p.y });
    o.vpPolySides = t === 'star' ? 5 : 6;
    if (t === 'star') o.vpStar = 0.5;
  } else if (t === 'line') o = new fabric.Line([p.x, p.y, p.x, p.y]);
  newPaints(o);
  if (t === 'line') { o.vpFill = null; if (!o.vpStroke) o.vpStroke = { type: 'solid', cmyk: [0, 0, 0, 100] }; if (!o.strokeWidth) o.strokeWidth = 1; }
  o.name = { rect: 'Rectangle', roundrect: 'Rounded Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', line: 'Line' }[t];
  applyPaint(o);
  canvas.add(o);
  drag = { o, start: p, tool: t };
}
function moveShape(e) {
  const { o, start, tool } = drag;
  const p = sp(e);
  if (tool === 'line') {
    let x2 = p.x; let y2 = p.y;
    if (e.e.shiftKey) {
      const ang = Math.round(Math.atan2(y2 - start.y, x2 - start.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(x2 - start.x, y2 - start.y);
      x2 = start.x + Math.cos(ang) * len; y2 = start.y + Math.sin(ang) * len;
    }
    o.set({ x2, y2 });
  } else {
    const r = rectFrom(start, p, e.e);
    if (tool === 'ellipse') o.set({ left: r.left, top: r.top, rx: r.width / 2, ry: r.height / 2 });
    else if (tool === 'polygon' || tool === 'star') {
      o.set({ points: regularPoints(o.vpPolySides, Math.max(r.width, 0.1), Math.max(r.height, 0.1), tool === 'star') });
      o.setDimensions();
      o.set({ left: r.left, top: r.top });
    } else o.set(r);
  }
  o.setCoords();
  canvas.requestRenderAll();
}
function endShape() {
  const { o, start, tool } = drag;
  drag = null;
  // click without drag -> default size
  const tiny = tool === 'line' ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 1 : (o.getScaledWidth() < 1 && o.getScaledHeight() < 1);
  if (tiny) {
    const s = 72;
    if (tool === 'line') o.set({ x2: start.x + s });
    else if (tool === 'ellipse') o.set({ rx: s / 2, ry: s / 2 });
    else if (tool === 'polygon' || tool === 'star') { o.set({ points: regularPoints(o.vpPolySides, s, s, tool === 'star') }); o.setDimensions(); o.set({ left: start.x, top: start.y }); }
    else o.set({ width: s, height: s });
  }
  applyPaint(o);
  o.setCoords();
  canvas.setActiveObject(o);
  canvas.requestRenderAll();
  commit(true);
  emit('object-created', o);
}

// ---------- text ----------
async function textDown(e) {
  if (e.target && isText(e.target)) {
    const t = e.target;
    canvas.setActiveObject(t);
    t.enterEditing();
    t.setCursorByClick && t.setCursorByClick(e.e);
    return;
  }
  drag = { tool: 'text', start: sp(e), rect: null };
}
function textMove(e) {
  const p = sp(e);
  const s = drag.start;
  if (!drag.rect && Math.hypot(p.x - s.x, p.y - s.y) * state.zoom > 6) {
    drag.rect = new fabric.Rect({ left: s.x, top: s.y, width: 1, height: 1, fill: 'rgba(61,139,255,0.06)', stroke: '#3d8bff', strokeWidth: 1, strokeUniform: true, strokeDashArray: [4, 3], selectable: false, evented: false, excludeFromExport: true, vpGuide: true });
    canvas.add(drag.rect);
  }
  if (drag.rect) {
    drag.rect.set({ left: Math.min(s.x, p.x), top: Math.min(s.y, p.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) });
    canvas.requestRenderAll();
  }
}
async function textUp() {
  const d = drag; drag = null;
  const fontId = state.defaults.fontId;
  const alias = await fontStack(fontId);
  const common = {
    fontFamily: alias, fontSize: state.defaults.fontSize, lineHeight: 1.2, charSpacing: 0, textAlign: 'left',
    strokeWidth: 1, strokeUniform: true, paintFirst: 'fill',
  };
  let t;
  if (d.rect) {
    const r = d.rect; canvas.remove(r);
    t = new fabric.Textbox('', { ...common, left: r.left, top: r.top, width: Math.max(r.width, 20), splitByGrapheme: false });
    t.name = 'Area Text';
  } else {
    t = new fabric.IText('', { ...common, left: d.start.x, top: d.start.y - state.defaults.fontSize * 0.9 });
    t.name = 'Text';
  }
  t.fontId = fontId;
  t.vpFill = state.defaults.fill && state.defaults.fill.type === 'solid' && state.defaults.fill.cmyk.join() === '0,0,0,0'
    ? { type: 'solid', cmyk: [0, 0, 0, 100] } : clonePaint(state.defaults.fill) || { type: 'solid', cmyk: [0, 0, 0, 100] };
  t.vpStroke = null;
  applyPaint(t);
  canvas.add(t);
  canvas.setActiveObject(t);
  t.enterEditing();
  canvas.requestRenderAll();
  setTimeout(() => setTool('select', true), 0);
  $('#hint').style.display = 'none';
}

// ---------- pen ----------
let pen = null; // { pts:[{x,y,hin,hout}], dragging, closed }
function penDown(e) {
  const p = sp(e);
  if (!pen) pen = { pts: [] };
  const first = pen.pts[0];
  if (first && pen.pts.length > 1 && Math.hypot(p.x - first.x, p.y - first.y) * state.zoom < 8) {
    pen.closed = true;
    finishPen(true);
    return;
  }
  pen.pts.push({ x: p.x, y: p.y, hin: null, hout: null });
  pen.dragging = true;
  canvas.requestRenderAll();
}
function penMove(e) {
  if (!pen) return;
  const p = sp(e);
  pen.mouse = p;
  if (pen.dragging) {
    const pt = pen.pts[pen.pts.length - 1];
    if (Math.hypot(p.x - pt.x, p.y - pt.y) * state.zoom > 2) {
      pt.hout = { x: p.x, y: p.y };
      pt.hin = { x: 2 * pt.x - p.x, y: 2 * pt.y - p.y };
    }
  }
  canvas.requestRenderAll();
}
function penUp() { if (pen) pen.dragging = false; }

function penD(pts, closed) {
  const f = (v) => Math.round(v * 1000) / 1000;
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  const seg = (a, b) => {
    const c1 = a.hout || a; const c2 = b.hin || b;
    if (!a.hout && !b.hin) d += ` L ${f(b.x)} ${f(b.y)}`;
    else d += ` C ${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}`;
  };
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
  if (closed) { seg(pts[pts.length - 1], pts[0]); d += ' Z'; }
  return d;
}

export function finishPen() {
  if (!pen) return;
  const p = pen; pen = null;
  if (p.pts.length < 2) { canvas.requestRenderAll(); return; }
  const path = new fabric.Path(penD(p.pts, p.closed));
  newPaints(path);
  if (!p.closed) path.vpFill = null;
  if (!path.vpStroke && !p.closed) path.vpStroke = { type: 'solid', cmyk: [0, 0, 0, 100] };
  path.name = 'Path';
  applyPaint(path);
  canvas.add(path);
  canvas.setActiveObject(path);
  canvas.requestRenderAll();
  commit(true);
}

on('overlay', (ctx, z) => {
  if (!pen || !pen.pts.length) return;
  ctx.lineWidth = 1 / z;
  ctx.strokeStyle = '#3d8bff';
  const pts = pen.mouse && !pen.dragging ? [...pen.pts, { x: pen.mouse.x, y: pen.mouse.y }] : pen.pts;
  const path = new Path2D(penD(pts, false));
  ctx.stroke(path);
  const s = 3.5 / z;
  for (const p of pen.pts) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(p.x - s, p.y - s, 2 * s, 2 * s);
    ctx.strokeRect(p.x - s, p.y - s, 2 * s, 2 * s);
    for (const hdl of [p.hin, p.hout]) {
      if (!hdl) continue;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(hdl.x, hdl.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(hdl.x, hdl.y, s * 0.8, 0, Math.PI * 2); ctx.fillStyle = '#3d8bff'; ctx.fill();
    }
  }
});

// ---------- direct selection (anchor editing) ----------
let editing = null;
const defaultControls = () => fabric.controlsUtils.createObjectDefaultControls();
export function exitPathEdit() {
  if (!editing) return;
  const o = editing; editing = null;
  o.controls = defaultControls();
  o.hasBorders = true;
  o.setCoords();
  canvas.requestRenderAll();
}
function enterPathEdit(o) {
  if (isText(o) || o.type === 'image' || o.type === 'group') { canvas.setActiveObject(o); return; }
  exitPathEdit();
  if (o.type !== 'path') o = convertToPath(o);
  o.controls = fabric.controlsUtils.createPathControls(o, {
    controlPointStyle: { controlFill: '#ffffff', controlStroke: '#3d8bff', controlSize: 7 },
    pointStyle: { controlFill: '#3d8bff', controlStroke: '#ffffff', controlSize: 8 },
  });
  o.hasBorders = false;
  editing = o;
  canvas.setActiveObject(o);
  canvas.requestRenderAll();
}

// ---------- eyedropper / zoom / hand ----------
function eyedrop(e) {
  const src = e.target;
  if (!src || !isPaintable(src)) return;
  const targets = canvas.getActiveObjects().filter((o) => o !== src && isPaintable(o));
  if (!targets.length) {
    state.defaults.fill = clonePaint(src.vpFill);
    state.defaults.stroke = clonePaint(src.vpStroke);
    state.defaults.strokeWidth = src.strokeWidth;
    emit('defaults-changed');
    toast('Picked colours as the default for new objects');
    return;
  }
  for (const t of targets) {
    t.vpFill = clonePaint(src.vpFill); t.vpStroke = clonePaint(src.vpStroke); t.strokeWidth = src.strokeWidth;
    applyPaint(t);
  }
  canvas.requestRenderAll();
  commit(true);
}

let panning = null;

// ---------- snapping ----------
function snapMove(e) {
  state.snapLines = [];
  if (!state.snap) return;
  const o = e.target;
  const tol = 5 / state.zoom;
  const d = state.doc;
  const xs = [0, d.width / 2, d.width, -d.bleed, d.width + d.bleed, ...d.guides.v];
  const ys = [0, d.height / 2, d.height, -d.bleed, d.height + d.bleed, ...d.guides.h];
  if (d.safe > 0) { xs.push(d.safe, d.width - d.safe); ys.push(d.safe, d.height - d.safe); }
  const moving = new Set(canvas.getActiveObjects());
  for (const other of canvas.getObjects()) {
    if (moving.has(other) || other === o || !other.visible || other.vpGuide) continue;
    const b = other.getBoundingRect();
    xs.push(b.left, b.left + b.width / 2, b.left + b.width);
    ys.push(b.top, b.top + b.height / 2, b.top + b.height);
  }
  const b = o.getBoundingRect();
  const cx = [b.left, b.left + b.width / 2, b.left + b.width];
  const cy = [b.top, b.top + b.height / 2, b.top + b.height];
  let best = null;
  for (const c of cx) for (const x of xs) { const dd = x - c; if (Math.abs(dd) < tol && (!best || Math.abs(dd) < Math.abs(best.d))) best = { d: dd, v: x }; }
  let bestY = null;
  for (const c of cy) for (const y of ys) { const dd = y - c; if (Math.abs(dd) < tol && (!bestY || Math.abs(dd) < Math.abs(bestY.d))) bestY = { d: dd, h: y }; }
  if (best) { o.left += best.d; state.snapLines.push({ v: best.v }); }
  if (bestY) { o.top += bestY.d; state.snapLines.push({ h: bestY.h }); }
  if (best || bestY) o.setCoords();
}

// ---------- guides (drag from rulers, drag to move, drag back to ruler to delete) ----------
let guideDrag = null;
export function startGuideDrag(kind) { guideDrag = { kind, idx: -1, pos: null }; }
function hitGuide(p) {
  if (!state.showGuides) return null;
  const tol = 4 / state.zoom; const g = state.doc.guides;
  for (let i = 0; i < g.v.length; i++) if (Math.abs(g.v[i] - p.x) < tol) return { kind: 'v', idx: i };
  for (let i = 0; i < g.h.length; i++) if (Math.abs(g.h[i] - p.y) < tol) return { kind: 'h', idx: i };
  return null;
}
window.addEventListener('mousemove', (e) => {
  if (!guideDrag) return;
  const r = $('#canvas-wrap').getBoundingClientRect();
  const p = fabric.util.transformPoint(new fabric.Point(e.clientX - r.left, e.clientY - r.top), fabric.util.invertTransform(canvas.viewportTransform));
  const g = state.doc.guides[guideDrag.kind];
  const v = guideDrag.kind === 'v' ? p.x : p.y;
  if (guideDrag.idx < 0) { g.push(v); guideDrag.idx = g.length - 1; } else g[guideDrag.idx] = v;
  guideDrag.out = guideDrag.kind === 'v' ? e.clientX < r.left : e.clientY < r.top;
  canvas.requestRenderAll();
});
window.addEventListener('mouseup', () => {
  if (!guideDrag) return;
  const g = state.doc.guides[guideDrag.kind];
  if (guideDrag.out && guideDrag.idx >= 0) g.splice(guideDrag.idx, 1);
  guideDrag = null;
  state.dirty = true; emit('title');
  canvas.requestRenderAll();
});

// ---------- wiring ----------
export function initTools() {
  canvas = state.canvas;
  $$('#toolbar .tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  canvas.on('mouse:down', (e) => {
    const t = state.tool;
    if (t === 'hand') { panning = { x: e.e.clientX, y: e.e.clientY }; canvas.setCursor('grabbing'); return; }
    if (t === 'zoom') { const r = $('#canvas-wrap').getBoundingClientRect(); setZoom(state.zoom * (e.e.altKey ? 0.5 : 2), new fabric.Point(e.e.clientX - r.left, e.e.clientY - r.top)); return; }
    if (t === 'eyedropper') { eyedrop(e); return; }
    if (t === 'pen') { penDown(e); return; }
    if (t === 'text') { textDown(e); return; }
    if (['rect', 'roundrect', 'ellipse', 'polygon', 'star', 'line'].includes(t)) { startShape(e); return; }
    if (t === 'direct') {
      if (e.target && e.target !== editing && !(e.transform && e.transform.corner)) enterPathEdit(e.target);
      else if (!e.target) exitPathEdit();
      return;
    }
    if (t === 'select' && !e.target) {
      const hit = hitGuide(sp(e));
      if (hit) { guideDrag = { ...hit }; canvas.selection = false; setTimeout(() => { canvas.selection = true; }, 0); }
    }
  });
  canvas.on('mouse:move', (e) => {
    if (panning) { panBy(e.e.clientX - panning.x, e.e.clientY - panning.y); panning = { x: e.e.clientX, y: e.e.clientY }; return; }
    if (state.tool === 'pen') { penMove(e); return; }
    if (drag && drag.tool === 'text') { textMove(e); return; }
    if (drag) moveShape(e);
  });
  canvas.on('mouse:up', (e) => {
    if (panning) { panning = null; canvas.setCursor('grab'); return; }
    if (state.tool === 'pen') { penUp(e); return; }
    if (drag && drag.tool === 'text') { textUp(e); return; }
    if (drag) endShape(e);
  });
  canvas.on('mouse:dblclick', (e) => {
    if (state.tool === 'pen') { finishPen(); return; }
    const t = e.target;
    if (t && isText(t) && state.tool === 'select') { t.enterEditing(); t.selectAll(); canvas.requestRenderAll(); }
    else if (t && state.tool === 'select' && t.type === 'path') { setTool('direct'); enterPathEdit(t); }
  });
  canvas.on('object:moving', snapMove);
  canvas.on('object:modified', () => { state.snapLines = []; canvas.requestRenderAll(); });
  canvas.on('mouse:up', () => { if (state.snapLines.length) { state.snapLines = []; canvas.requestRenderAll(); } });
  canvas.on('selection:cleared', () => { if (editing && state.tool === 'direct') exitPathEdit(); });
}
