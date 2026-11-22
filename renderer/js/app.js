// Vibrant Print Master Pro — editor bootstrap & commands. Created by Tahamid.
import { state, emit, on, markDirty } from './state.js';
import { $, $$, h, toast, fmt, toPt, setColorUpdateHandler, clearColorCache, preloadCmyk, rgbToCmyk, parseCssColor, deepClone } from './util.js';
import { PROPS, applyPaint, refreshAllPaints, collectCmyk, solid, clonePaint, isPaintable } from './paint.js';
import { buildDisplayList, absoluteSubs, subsToD, isText, transformSubs, localSubs } from './geometry.js';
import { loadFontList, ensureCanvasFonts, ensureFont } from './fonts.js';
import { initTools, setTool, finishPen, exitPathEdit } from './tools.js';
import { initPanels, refreshPanels } from './panels.js';
import { initRulers, drawRulers } from './rulers.js';
import * as dlg from './dialogs.js';
import { runPreflight } from './preflight.js';
import { loadPdf, pageToObjects } from './pdfimport.js';

document.body.classList.add('platform-' + window.vpm.platform);
const isMac = window.vpm.platform === 'darwin';
export const modKey = (e) => (isMac ? e.metaKey : e.ctrlKey);

// ---------------- fabric defaults ----------------
Object.assign(fabric.FabricObject.ownDefaults, {
  borderColor: '#3d8bff', cornerColor: '#ffffff', cornerStrokeColor: '#3d8bff', cornerSize: 8,
  transparentCorners: false, cornerStyle: 'rect', borderScaleFactor: 1, strokeUniform: true,
  padding: 0, objectCaching: true, noScaleCache: false,
});
Object.assign(fabric.InteractiveFabricObject.ownDefaults, {
  borderColor: '#3d8bff', cornerColor: '#ffffff', cornerStrokeColor: '#3d8bff', cornerSize: 8, transparentCorners: false,
});
fabric.IText.ownDefaults.cursorColor = '#3d8bff';
fabric.IText.ownDefaults.selectionColor = 'rgba(61,139,255,0.3)';
fabric.IText.ownDefaults.editingBorderColor = '#3d8bff';

// keep embedded images out of history snapshots (stored once in the asset table)
const imgToObject = fabric.FabricImage.prototype.toObject;
fabric.FabricImage.prototype.toObject = function (p) {
  const o = imgToObject.call(this, p);
  if (this.vpAssetId) { o.src = 'vpasset:' + this.vpAssetId; o.vpAssetId = this.vpAssetId; }
  return o;
};

// ---------------- canvas ----------------
const canvas = new fabric.Canvas('c', {
  preserveObjectStacking: true, uniformScaling: false, uniScaleKey: 'shiftKey', centeredKey: 'altKey',
  stopContextMenu: true, fireRightClick: false, targetFindTolerance: 5,
  selectionColor: 'rgba(61,139,255,0.08)', selectionBorderColor: '#3d8bff', selectionLineWidth: 1,
  enableRetinaScaling: true, renderOnAddRemove: false, imageSmoothingEnabled: true,
});
state.canvas = canvas;
window.__vpm = { state, canvas };

const wrap = $('#canvas-wrap');
function resizeCanvas() {
  canvas.setDimensions({ width: wrap.clientWidth, height: wrap.clientHeight });
  drawRulers();
  canvas.requestRenderAll();
}
new ResizeObserver(resizeCanvas).observe(wrap);

// ---------------- rendering hooks ----------------
canvas.on('before:render', ({ ctx }) => {
  const live = ctx === canvas.contextContainer;
  if (!live) {
    if (state.exporting === 'jpg') { ctx.save(); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1e5, 1e5); ctx.restore(); }
    return;
  }
  const d = state.doc; const v = canvas.viewportTransform;
  ctx.save();
  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.transform(...v);
  ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, d.width, d.height);
  ctx.restore();
});

canvas.on('after:render', ({ ctx }) => {
  if (ctx !== canvas.contextContainer) return;
  const d = state.doc; const v = canvas.viewportTransform; const z = v[0];
  ctx.save();
  ctx.transform(...v);
  ctx.lineWidth = 1 / z;
  // artboard edge
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.strokeRect(0, 0, d.width, d.height);
  if (state.showBleed) {
    if (d.bleed > 0) {
      ctx.strokeStyle = '#ff3b30';
      ctx.strokeRect(-d.bleed, -d.bleed, d.width + 2 * d.bleed, d.height + 2 * d.bleed);
    }
    if (d.safe > 0) {
      ctx.setLineDash([4 / z, 3 / z]);
      ctx.strokeStyle = '#00a2ff';
      ctx.strokeRect(d.safe, d.safe, d.width - 2 * d.safe, d.height - 2 * d.safe);
      ctx.setLineDash([]);
    }
  }
  if (state.showGuides) {
    ctx.strokeStyle = '#00e5ff';
    const big = 1e5;
    for (const x of d.guides.v) { ctx.beginPath(); ctx.moveTo(x, -big); ctx.lineTo(x, big); ctx.stroke(); }
    for (const y of d.guides.h) { ctx.beginPath(); ctx.moveTo(-big, y); ctx.lineTo(big, y); ctx.stroke(); }
  }
  if (state.snapLines.length) {
    ctx.strokeStyle = '#ff2bd6';
    for (const s of state.snapLines) {
      ctx.beginPath();
      if (s.v != null) { ctx.moveTo(s.v, -1e5); ctx.lineTo(s.v, 1e5); } else { ctx.moveTo(-1e5, s.h); ctx.lineTo(1e5, s.h); }
      ctx.stroke();
    }
  }
  emit('overlay', ctx, z);
  ctx.restore();
});

// ---------------- viewport ----------------
export function setZoom(z, pt) {
  z = Math.max(0.02, Math.min(64, z));
  const p = pt || new fabric.Point(canvas.width / 2, canvas.height / 2);
  canvas.zoomToPoint(p, z);
  state.zoom = z;
  afterViewport();
}
export function zoomFit() {
  const d = state.doc; const m = 48;
  const W = d.width + 2 * d.bleed; const H = d.height + 2 * d.bleed;
  const z = Math.min((canvas.width - 2 * m) / W, (canvas.height - 2 * m) / H);
  canvas.setViewportTransform([z, 0, 0, z, (canvas.width - d.width * z) / 2, (canvas.height - d.height * z) / 2]);
  state.zoom = z;
  afterViewport();
}
export function zoom100() {
  const d = state.doc;
  canvas.setViewportTransform([1, 0, 0, 1, (canvas.width - d.width) / 2, (canvas.height - d.height) / 2]);
  state.zoom = 1;
  afterViewport();
}
export function panBy(dx, dy) {
  const v = canvas.viewportTransform.slice();
  v[4] += dx; v[5] += dy;
  canvas.setViewportTransform(v);
  afterViewport();
}
function afterViewport() {
  $('#st-zoom').textContent = Math.round(state.zoom * 100) + '%';
  canvas.getObjects().forEach((o) => o.setCoords());
  drawRulers();
  canvas.requestRenderAll();
}

wrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey || e.altKey) {
    const factor = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0025));
    const r = wrap.getBoundingClientRect();
    setZoom(state.zoom * factor, new fabric.Point(e.clientX - r.left, e.clientY - r.top));
  } else {
    panBy(-(e.shiftKey ? e.deltaY : e.deltaX), -(e.shiftKey ? 0 : e.deltaY));
  }
}, { passive: false });

// ---------------- history ----------------
const hist = { stack: [], idx: -1, lock: false, timer: 0 };
function snapshot() {
  return JSON.stringify(canvas.toObject(PROPS).objects);
}
export function commit(immediate) {
  if (hist.lock) return;
  clearTimeout(hist.timer);
  const run = () => {
    const s = snapshot();
    if (hist.stack[hist.idx] === s) return;
    hist.stack.splice(hist.idx + 1);
    hist.stack.push(s);
    if (hist.stack.length > 60) hist.stack.shift();
    hist.idx = hist.stack.length - 1;
    markDirty();
    refreshPanels();
  };
  if (immediate) run(); else hist.timer = setTimeout(run, 180);
}
function resetHistory() { hist.stack = [snapshot()]; hist.idx = 0; }
async function restore(idx) {
  hist.lock = true;
  hist.idx = idx;
  await loadObjects(JSON.parse(hist.stack[idx]));
  hist.lock = false;
  markDirty();
}
export async function undo() { if (hist.idx > 0) await restore(hist.idx - 1); }
export async function redo() { if (hist.idx < hist.stack.length - 1) await restore(hist.idx + 1); }

function withAssets(objs) {
  const fix = (o) => {
    if (o.type && /image/i.test(o.type) && typeof o.src === 'string' && o.src.startsWith('vpasset:')) {
      o.src = state.doc.assets[o.src.slice(8)] || '';
    }
    if (o.objects) o.objects.forEach(fix);
    if (o.clipPath) fix(o.clipPath);
  };
  objs.forEach(fix);
  return objs;
}

export async function enliven(jsonObjs) {
  const objs = await fabric.util.enlivenObjects(withAssets(deepClone(jsonObjs)));
  await ensureCanvasFonts(objs);
  objs.forEach(applyPaint);
  return objs;
}

async function loadObjects(jsonObjs) {
  const wasLock = hist.lock;
  hist.lock = true;
  canvas.discardActiveObject();
  canvas.remove(...canvas.getObjects());
  const objs = await enliven(jsonObjs);
  objs.forEach((o) => canvas.add(o));
  canvas.requestRenderAll();
  hist.lock = wasLock;
  refreshPanels();
}

['object:modified', 'object:added', 'object:removed', 'text:changed'].forEach((ev) => canvas.on(ev, () => commit()));
canvas.on('text:changed', (e) => { const t = e.target; if (t && t.vpFill && t.vpFill.type !== 'solid') applyPaint(t); });
canvas.on('text:editing:exited', (e) => {
  const t = e.target;
  if (t && !t.text.trim()) { canvas.remove(t); canvas.requestRenderAll(); }
});

// ---------------- document ----------------
export function newDoc(opts) {
  state.doc = {
    name: opts.name || 'Untitled',
    file: null,
    width: opts.width, height: opts.height,
    bleed: opts.bleed ?? toPt(3, 'mm'),
    safe: opts.safe ?? toPt(5, 'mm'),
    units: opts.units || 'mm',
    pages: [{ name: 'Page 1', objects: [] }],
    page: 0,
    guides: { v: [], h: [] },
    swatches: [],
    assets: {},
  };
  hist.lock = true;
  canvas.discardActiveObject();
  canvas.remove(...canvas.getObjects());
  hist.lock = false;
  resetHistory();
  state.dirty = false;
  emit('title');
  emit('doc');
  zoomFit();
  refreshPanels();
}

export function storeCurrentPage() {
  state.doc.pages[state.doc.page].objects = canvas.toObject(PROPS).objects;
}

export async function switchPage(i) {
  if (i === state.doc.page) return;
  exitPathEdit();
  storeCurrentPage();
  state.doc.page = i;
  hist.lock = true;
  await loadObjects(state.doc.pages[i].objects);
  hist.lock = false;
  resetHistory();
  emit('doc');
}
export async function addPage() {
  storeCurrentPage();
  state.doc.pages.push({ name: 'Page ' + (state.doc.pages.length + 1), objects: [] });
  await switchPage(state.doc.pages.length - 1);
  markDirty();
}
export async function deletePage(i) {
  if (state.doc.pages.length < 2) return;
  storeCurrentPage();
  state.doc.pages.splice(i, 1);
  state.doc.pages.forEach((p, k) => { p.name = 'Page ' + (k + 1); });
  state.doc.page = -1;
  await switchPage(Math.min(i, state.doc.pages.length - 1));
  markDirty();
}

function renderPageTabs() {
  const el = $('#pagetabs');
  el.innerHTML = '';
  state.doc.pages.forEach((p, i) => {
    el.append(h('div', {
      class: 'ptab' + (i === state.doc.page ? ' active' : ''),
      title: 'Artboard ' + (i + 1) + ' — right-click to delete',
      onclick: () => switchPage(i),
      oncontextmenu: async (e) => {
        e.preventDefault();
        if (state.doc.pages.length > 1 && await dlg.confirm(`Delete ${p.name}?`, 'This removes the artboard and everything on it.', ['Delete', 'Cancel']) === 0) deletePage(i);
      },
    }, p.name));
  });
  el.append(h('div', { class: 'ptab add', title: 'Add artboard', onclick: addPage }, '+'));
}
on('doc', renderPageTabs);
on('title', () => {
  $('#docname').textContent = state.doc.name + (state.dirty ? ' •' : '');
  window.vpm.setTitle(state.doc.name + ' — Vibrant Print Master Pro', state.dirty);
});

// ---------------- file I/O ----------------
export function serialize() {
  storeCurrentPage();
  const d = state.doc;
  return JSON.stringify({
    app: 'Vibrant Print Master Pro', format: 1, createdBy: 'Tahamid',
    doc: { name: d.name, width: d.width, height: d.height, bleed: d.bleed, safe: d.safe, units: d.units, guides: d.guides, swatches: d.swatches, page: d.page },
    pages: d.pages, assets: d.assets,
  });
}

export async function openFile(path) {
  try {
    const txt = await window.vpm.invoke('fs:read-text', path);
    const data = JSON.parse(txt);
    if (!data.pages) throw new Error('Not a Vibrant Print Master Pro file');
    const d = data.doc;
    state.doc = { ...d, file: path, name: path.split(/[\\/]/).pop().replace(/\.vpm$/i, ''), pages: data.pages, page: Math.min(d.page || 0, data.pages.length - 1), assets: data.assets || {}, guides: d.guides || { v: [], h: [] }, swatches: d.swatches || [] };
    await preloadCmyk(data.pages.flatMap((p) => collectJsonCmyk(p.objects)));
    await loadObjects(state.doc.pages[state.doc.page].objects);
    resetHistory();
    state.dirty = false;
    emit('title'); emit('doc');
    zoomFit();
    window.vpm.invoke('settings:set', {});
    return true;
  } catch (e) {
    dlg.alert('Could not open file', String(e.message || e));
    return false;
  }
}

function collectJsonCmyk(objs, out = []) {
  for (const o of objs || []) {
    for (const p of [o.vpFill, o.vpStroke]) if (p) { if (p.type === 'solid') out.push(p.cmyk); else p.stops.forEach((s) => out.push(s.cmyk)); }
    if (o.objects) collectJsonCmyk(o.objects, out);
  }
  return out;
}

export async function save(as) {
  let file = state.doc.file;
  if (!file || as) {
    file = await window.vpm.invoke('dialog:save', { title: 'Save', defaultPath: state.doc.name + '.vpm', filters: [{ name: 'Vibrant Print Master Pro', extensions: ['vpm'] }] });
    if (!file) return false;
    if (!/\.vpm$/i.test(file)) file += '.vpm';
  }
  await window.vpm.invoke('fs:write-text', file, serialize());
  state.doc.file = file;
  state.doc.name = file.split(/[\\/]/).pop().replace(/\.vpm$/i, '');
  state.dirty = false;
  emit('title');
  toast('Saved — ' + state.doc.name + '.vpm');
  return true;
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  const r = await dlg.confirm(`Save changes to “${state.doc.name}”?`, 'Your changes will be lost if you don’t save them.', ['Save', 'Don’t Save', 'Cancel']);
  if (r === 0) return save();
  return r === 1;
}

// ---------------- images / import ----------------
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };
function bytesToDataUrl(bytes, mime) {
  let bin = '';
  const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

export async function placeImageData(dataUrl, name, at) {
  const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.doc.assets[id] = dataUrl;
  const img = await fabric.FabricImage.fromURL(dataUrl);
  img.vpAssetId = id;
  img.name = name || 'Image';
  const d = state.doc;
  // place at 300 ppi when it fits, otherwise fit inside the artboard
  let s = 72 / 300;
  const maxW = d.width * 0.9; const maxH = d.height * 0.9;
  if (img.width * s > maxW || img.height * s > maxH) s = Math.min(maxW / img.width, maxH / img.height);
  img.scale(s);
  const p = at || { x: d.width / 2, y: d.height / 2 };
  img.set({ left: p.x - img.getScaledWidth() / 2, top: p.y - img.getScaledHeight() / 2 });
  canvas.add(img);
  canvas.setActiveObject(img);
  canvas.requestRenderAll();
  commit(true);
  const ppi = Math.round(72 / s);
  toast(`Placed ${img.name} — effective ${ppi} ppi${ppi < 250 ? ' (low for print!)' : ''}`);
}

async function placeImage() {
  const files = await window.vpm.invoke('dialog:open', { title: 'Place Image', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }] });
  if (!files) return;
  for (const f of files) await importPath(f);
}

export async function importPath(f, at) {
  const ext = f.split('.').pop().toLowerCase();
  if (ext === 'svg') return importSvgText(await window.vpm.invoke('fs:read-text', f), f.split(/[\\/]/).pop());
  if (ext === 'vpm') { if (await confirmDiscard()) return openFile(f); return; }
  if (ext === 'ai' || ext === 'pdf') return placePdf(f);
  if (ext === 'eps') { dlg.alert('EPS cannot be opened', 'EPS files can be saved but not opened. In Illustrator, save the file as .ai (keep “Create PDF Compatible File” ticked) or as PDF, then open that here.'); return; }
  if (!MIME[ext]) { toast('Unsupported file: ' + ext); return; }
  const bytes = await window.vpm.invoke('fs:read-bin', f);
  return placeImageData(bytesToDataUrl(bytes, MIME[ext]), f.split(/[\\/]/).pop(), at);
}

async function importSvgText(text, name) {
  const { objects } = await fabric.loadSVGFromString(text);
  const objs = objects.filter(Boolean);
  if (!objs.length) { toast('No shapes found in SVG'); return; }
  // convert all colours to CMYK
  const rgbs = []; const refs = [];
  const conv = (o) => {
    if (o.type === 'group') { o.getObjects().forEach(conv); return; }
    for (const k of ['fill', 'stroke']) {
      const v = o[k];
      if (v && typeof v === 'object' && v.colorStops) {
        const stops = v.colorStops.map((s) => { const c = parseCssColor(s.color); return { o: s.offset, rgb: c || [0, 0, 0] }; });
        stops.forEach((s) => { refs.push([s, 'cmyk']); rgbs.push(s.rgb); });
        const c = v.coords;
        const ang = v.type === 'linear' ? Math.round(Math.atan2(-(c.y2 - c.y1), c.x2 - c.x1) * 180 / Math.PI) : 0;
        o[k === 'fill' ? 'vpFill' : 'vpStroke'] = { type: v.type === 'linear' ? 'lin' : 'rad', angle: ang, stops };
      } else {
        const c = parseCssColor(typeof v === 'string' ? v : null);
        if (c) { const p = { type: 'solid', cmyk: null }; refs.push([p, 'cmyk']); rgbs.push(c); o[k === 'fill' ? 'vpFill' : 'vpStroke'] = p; }
        else o[k === 'fill' ? 'vpFill' : 'vpStroke'] = null;
      }
    }
  };
  objs.forEach(conv);
  const cm = rgbs.length ? await rgbToCmyk(rgbs) : [];
  refs.forEach(([obj, key], i) => { obj[key] = cm[i]; delete obj.rgb; });
  await preloadCmyk(cm);
  for (const o of objs) {
    if (isText(o)) { o.fontId = state.defaults.fontId; }
  }
  await ensureCanvasFonts(objs);
  objs.forEach(applyPaint);
  const g = objs.length > 1 ? new fabric.Group(objs) : objs[0];
  g.name = name || 'SVG';
  const d = state.doc;
  const s = Math.min(1, (d.width * 0.9) / g.getScaledWidth(), (d.height * 0.9) / g.getScaledHeight());
  g.scale(s * (g.scaleX || 1));
  g.set({ left: (d.width - g.getScaledWidth()) / 2, top: (d.height - g.getScaledHeight()) / 2 });
  canvas.add(g);
  canvas.setActiveObject(g);
  canvas.requestRenderAll();
  commit(true);
}

// ---------------- Illustrator (.ai) / PDF import ----------------
function registerAsset(url) {
  const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  state.doc.assets[id] = url;
  return id;
}
function importSummary(t) {
  const parts = [`${t.paths} shapes`, `${t.text} text runs (as outlines)`, `${t.images} images`];
  return parts.join(' · ') + (t.skipped ? ` · ${t.skipped} item(s) could not be converted` : '');
}
export async function openPdfDocument(path) {
  toast('Opening ' + path.split(/[\\/]/).pop() + '…', 120000);
  const bytes = new Uint8Array(await window.vpm.invoke('fs:read-bin', path));
  let pdf;
  try { pdf = await loadPdf(bytes); } catch (e) { toast(''); dlg.alert('Cannot open this file', String(e.message || e)); return false; }
  const first = await pdf.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  newDoc({ width: vp.width, height: vp.height, units: 'mm', name: path.split(/[\\/]/).pop().replace(/\.(ai|pdf)$/i, '') });
  const total = { paths: 0, text: 0, images: 0, skipped: 0 };
  for (let i = 1; i <= pdf.numPages; i++) {
    const res = await pageToObjects(pdf, i, registerAsset);
    for (const k of Object.keys(total)) total[k] += res.stats[k];
    if (i === 1) {
      hist.lock = true;
      res.objects.forEach((o) => canvas.add(o));
      hist.lock = false;
    } else {
      state.doc.pages.push({ name: 'Page ' + i, objects: res.objects.map((o) => o.toObject(PROPS)) });
    }
  }
  try { (pdf.loadingTask && pdf.loadingTask.destroy) ? pdf.loadingTask.destroy() : pdf.cleanup && pdf.cleanup(); } catch { /* ignore */ }
  canvas.requestRenderAll();
  resetHistory();
  state.dirty = false;
  emit('title'); emit('doc');
  zoomFit();
  refreshPanels();
  toast('Opened — ' + importSummary(total), 6000);
  return true;
}
async function placePdf(path) {
  toast('Importing…', 120000);
  const bytes = new Uint8Array(await window.vpm.invoke('fs:read-bin', path));
  let pdf;
  try { pdf = await loadPdf(bytes); } catch (e) { toast(''); dlg.alert('Cannot import this file', String(e.message || e)); return; }
  const res = await pageToObjects(pdf, 1, registerAsset);
  try { (pdf.loadingTask && pdf.loadingTask.destroy) ? pdf.loadingTask.destroy() : pdf.cleanup && pdf.cleanup(); } catch { /* ignore */ }
  if (!res.objects.length) { toast('Nothing to import'); return; }
  const g = res.objects.length > 1 ? new fabric.Group(res.objects) : res.objects[0];
  g.name = g.name && res.objects.length === 1 ? g.name : path.split(/[\\/]/).pop();
  canvas.add(g);
  canvas.setActiveObject(g);
  canvas.requestRenderAll();
  commit(true);
  toast('Imported — ' + importSummary(res.stats), 6000);
}

// drag & drop
wrap.addEventListener('dragover', (e) => { e.preventDefault(); });
wrap.addEventListener('drop', async (e) => {
  e.preventDefault();
  const r = wrap.getBoundingClientRect();
  const pt = fabric.util.transformPoint(new fabric.Point(e.clientX - r.left, e.clientY - r.top), fabric.util.invertTransform(canvas.viewportTransform));
  for (const f of e.dataTransfer.files) {
    const p = window.vpm.pathForFile(f);
    if (p) await importPath(p, pt);
  }
});

// ---------------- clipboard ----------------
let clip = null;
function selected() { return canvas.getActiveObjects(); }
function copySel() {
  const objs = selected();
  if (!objs.length) return false;
  const sel = canvas.getActiveObject();
  if (sel.type === 'activeselection' || sel.type === 'activeSelection') {
    // serialize with absolute coordinates
    canvas.discardActiveObject();
    clip = objs.map((o) => o.toObject(PROPS));
    canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
  } else clip = [sel.toObject(PROPS)];
  canvas.requestRenderAll();
  return true;
}
async function paste(inPlace) {
  if (!clip) return;
  const objs = await enliven(clip);
  canvas.discardActiveObject();
  objs.forEach((o) => {
    if (!inPlace) o.set({ left: o.left + 10, top: o.top + 10 });
    canvas.add(o);
  });
  if (!inPlace) clip = objs.map((o) => o.toObject(PROPS));
  selectObjects(objs);
  commit(true);
}
export function selectObjects(objs) {
  canvas.discardActiveObject();
  if (objs.length === 1) canvas.setActiveObject(objs[0]);
  else if (objs.length > 1) canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
  canvas.requestRenderAll();
}
function deleteSel() {
  const objs = selected();
  if (!objs.length) return;
  canvas.discardActiveObject();
  canvas.remove(...objs);
  canvas.requestRenderAll();
  commit(true);
}
async function duplicate() {
  if (copySel()) await paste(false);
}

const isField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
document.addEventListener('copy', (e) => { if (isField(document.activeElement)) return; if (copySel()) e.preventDefault(); });
document.addEventListener('cut', (e) => { if (isField(document.activeElement)) return; if (copySel()) { e.preventDefault(); deleteSel(); } });
document.addEventListener('paste', async (e) => {
  if (isField(document.activeElement)) return;
  e.preventDefault();
  const files = [...(e.clipboardData?.files || [])];
  const img = files.find((f) => f.type.startsWith('image/'));
  if (img && !clip) {
    const buf = await img.arrayBuffer();
    return placeImageData(bytesToDataUrl(buf, img.type), 'Pasted image');
  }
  const txt = e.clipboardData?.getData('text/plain');
  if (!clip && txt && /<svg[\s>]/i.test(txt)) return importSvgText(txt, 'Pasted SVG');
  paste(false);
});

// ---------------- object commands ----------------
function stackSorted(objs) { const all = canvas.getObjects(); return [...objs].sort((a, b) => all.indexOf(a) - all.indexOf(b)); }

function group() {
  const objs = stackSorted(selected());
  if (objs.length < 2) return;
  const idx = canvas.getObjects().indexOf(objs[objs.length - 1]);
  canvas.discardActiveObject();
  canvas.remove(...objs);
  const g = new fabric.Group(objs);
  g.name = 'Group';
  canvas.insertAt(Math.max(0, idx - objs.length + 1), g);
  canvas.setActiveObject(g);
  canvas.requestRenderAll();
  commit(true);
}
function ungroup() {
  const groups = selected().filter((o) => o.type === 'group');
  if (!groups.length) return;
  canvas.discardActiveObject();
  const out = [];
  for (const g of groups) {
    if (g.clipPath) { releaseClip(g, out); continue; }
    const idx = canvas.getObjects().indexOf(g);
    const kids = g.removeAll();
    canvas.remove(g);
    kids.forEach((k, i) => { canvas.insertAt(idx + i, k); k.setCoords(); out.push(k); });
  }
  selectObjects(out);
  commit(true);
}

async function makeClip() {
  const objs = stackSorted(selected());
  if (objs.length < 2) { toast('Select the artwork and a shape on top of it to use as the mask'); return; }
  const mask = objs[objs.length - 1];
  if (mask.type === 'image' || mask.type === 'group') { toast('The top object must be a shape or path to use as a mask'); return; }
  let maskObj = mask;
  if (isText(mask)) maskObj = await outlineObject(mask, true);
  const rest = objs.slice(0, -1);
  const idx = canvas.getObjects().indexOf(rest[0]);
  canvas.discardActiveObject();
  canvas.remove(...rest, mask);
  const g = new fabric.Group(rest);
  g.name = 'Clip Group';
  const rel = fabric.util.multiplyTransformMatrices(fabric.util.invertTransform(g.calcTransformMatrix()), maskObj.calcTransformMatrix());
  const cp = await maskObj.clone(PROPS);
  fabric.util.applyTransformToObject(cp, rel);
  cp.set({ absolutePositioned: false, vpFill: null, vpStroke: null, fill: '#000', stroke: null });
  g.clipPath = cp;
  g.vpClip = true;
  canvas.insertAt(idx, g);
  canvas.setActiveObject(g);
  canvas.requestRenderAll();
  commit(true);
}
function releaseClip(g, out = []) {
  const idx = canvas.getObjects().indexOf(g);
  const cp = g.clipPath;
  const m = fabric.util.multiplyTransformMatrices(g.calcTransformMatrix(), cp.calcOwnMatrix());
  g.clipPath = null;
  const kids = g.removeAll();
  canvas.remove(g);
  kids.forEach((k, i) => { canvas.insertAt(idx + i, k); out.push(k); });
  fabric.util.applyTransformToObject(cp, m);
  cp.set({ vpFill: null, vpStroke: solid([0, 0, 0, 0]), strokeWidth: 0 });
  cp.vpStroke = null;
  applyPaint(cp);
  canvas.insertAt(idx + kids.length, cp);
  out.push(cp);
  return out;
}
function releaseClipCmd() {
  const gs = selected().filter((o) => o.type === 'group' && o.clipPath);
  if (!gs.length) return;
  canvas.discardActiveObject();
  const out = [];
  gs.forEach((g) => releaseClip(g, out));
  selectObjects(out);
  commit(true);
}

function arrange(kind) {
  const objs = stackSorted(selected());
  if (!objs.length) return;
  const list = kind === 'front' || kind === 'backward' ? objs : [...objs].reverse();
  for (const o of (kind === 'front' || kind === 'forward' ? [...objs].reverse() : list)) {
    if (kind === 'front') canvas.bringObjectToFront(o);
    else if (kind === 'back') canvas.sendObjectToBack(o);
    else if (kind === 'forward') canvas.bringObjectForward(o);
    else canvas.sendObjectBackwards(o);
  }
  if (kind === 'front') objs.forEach((o) => canvas.bringObjectToFront(o));
  if (kind === 'back') [...objs].reverse().forEach((o) => canvas.sendObjectToBack(o));
  canvas.requestRenderAll();
  commit(true);
}

export function setLocked(o, v) {
  o.set({ selectable: !v, evented: !v, vpLocked: v, lockMovementX: v, lockMovementY: v });
}
function lockSel() { const objs = selected(); canvas.discardActiveObject(); objs.forEach((o) => setLocked(o, true)); canvas.requestRenderAll(); commit(true); }
function unlockAll() { canvas.getObjects().forEach((o) => { if (o.vpLocked) setLocked(o, false); }); canvas.requestRenderAll(); commit(true); }
function hideSel() { const objs = selected(); canvas.discardActiveObject(); objs.forEach((o) => o.set({ visible: false, vpHidden: true })); canvas.requestRenderAll(); commit(true); }
function showAll() { canvas.getObjects().forEach((o) => { if (!o.visible) o.set({ visible: true, vpHidden: false }); }); canvas.requestRenderAll(); commit(true); }

function flip(axis) {
  const objs = selected();
  if (!objs.length) return;
  const sel = canvas.getActiveObject();
  sel.set(axis === 'h' ? { flipX: !sel.flipX } : { flipY: !sel.flipY });
  sel.setCoords();
  canvas.requestRenderAll();
  canvas.fire('object:modified', { target: sel });
}

// Convert any shape (not text) to an editable path in place.
export function convertToPath(o) {
  if (o.type === 'path' || o.type === 'group' || o.type === 'image' || isText(o)) return o;
  const subs = transformSubs(localSubs(o), o.calcTransformMatrix());
  const p = new fabric.Path(subsToD(subs));
  for (const k of ['vpFill', 'vpStroke', 'strokeWidth', 'strokeLineCap', 'strokeLineJoin', 'strokeMiterLimit', 'strokeDashArray', 'opacity', 'name', 'paintFirst', 'visible']) p[k] = deepClone(o[k] ?? null) ?? p[k];
  if (!p.name || /Rect|Ellipse|Polygon|Line|Star/.test(p.name)) p.name = 'Path';
  if (o.type === 'line' || o.type === 'polyline') p.vpFill = null;
  applyPaint(p);
  const idx = canvas.getObjects().indexOf(o);
  if (o.group) return o;
  canvas.remove(o);
  canvas.insertAt(idx, p);
  return p;
}
function toPathCmd() {
  const objs = selected();
  canvas.discardActiveObject();
  const out = objs.map(convertToPath);
  selectObjects(out);
  commit(true);
}

// Type > Create Outlines
export async function outlineObject(t, detached) {
  const subs = await absoluteSubs(t);
  const p = new fabric.Path(subsToD(subs) || 'M 0 0');
  p.set({ fillRule: 'nonzero', strokeWidth: t.strokeWidth, opacity: t.opacity, paintFirst: t.paintFirst });
  p.vpFill = clonePaint(t.vpFill); p.vpStroke = clonePaint(t.vpStroke);
  p.name = (t.text || 'Text').slice(0, 24) + ' (outlines)';
  applyPaint(p);
  if (!detached) {
    const idx = canvas.getObjects().indexOf(t);
    canvas.remove(t);
    canvas.insertAt(idx, p);
  }
  return p;
}
async function outlineText() {
  const objs = selected().filter(isText);
  if (!objs.length) { toast('Select a text object first'); return; }
  canvas.discardActiveObject();
  const out = [];
  for (const t of objs) out.push(await outlineObject(t));
  selectObjects(out);
  commit(true);
}

// ---------------- export ----------------
async function objectsForPage(i) {
  if (i === state.doc.page) return canvas.getObjects();
  return enliven(state.doc.pages[i].objects);
}

export async function exportPrint(format) {
  exitPathEdit();
  const pf = await runPreflight(format);
  const opts = await dlg.exportDialog(format, pf);
  if (!opts) return;
  const ext = format === 'pdf' ? 'pdf' : format;
  let file = await window.vpm.invoke('dialog:save', {
    title: format === 'pdf' ? 'Export Print PDF' : format === 'ai' ? 'Save as Illustrator (.ai)' : 'Save as EPS',
    defaultPath: state.doc.name + '.' + ext,
    filters: [{ name: format.toUpperCase(), extensions: [ext] }],
  });
  if (!file) return;
  if (!file.toLowerCase().endsWith('.' + ext)) file += '.' + ext;
  toast('Exporting…', 60000);
  try {
    storeCurrentPage();
    const pageIdx = format === 'pdf' && opts.allPages ? state.doc.pages.map((p, i) => i) : [state.doc.page];
    const pages = [];
    for (const i of pageIdx) {
      const objs = await objectsForPage(i);
      pages.push({ width: state.doc.width, height: state.doc.height, items: buildDisplayList(objs) });
    }
    const res = await window.vpm.invoke('export:print', {
      format, file, pages,
      opts: { bleed: state.doc.bleed, includeBleed: opts.includeBleed, marks: opts.marks, title: state.doc.name },
    });
    toast(`Saved ${file.split(/[\\/]/).pop()} (${(res.bytes / 1048576).toFixed(2)} MB)`, 4000);
  } catch (e) {
    console.error(e);
    dlg.alert('Export failed', String(e.message || e));
  }
}

async function exportRaster() {
  const o = await dlg.rasterDialog();
  if (!o) return;
  let file = await window.vpm.invoke('dialog:save', { title: 'Export Image', defaultPath: state.doc.name + '.' + o.format, filters: [{ name: o.format.toUpperCase(), extensions: [o.format] }] });
  if (!file) return;
  if (!file.toLowerCase().endsWith('.' + o.format)) file += '.' + o.format;
  const d = state.doc; const B = o.includeBleed ? d.bleed : 0;
  const W = d.width + 2 * B; const H = d.height + 2 * B;
  let mult = o.dpi / 72;
  const maxSide = 16000;
  if (W * mult > maxSide || H * mult > maxSide || W * H * mult * mult > 200e6) {
    mult = Math.min(maxSide / W, maxSide / H, Math.sqrt(200e6 / (W * H)));
    toast(`Image too large at ${o.dpi} dpi — exported at ${Math.floor(mult * 72)} dpi`, 4000);
  }
  exitPathEdit();
  const sel = canvas.getActiveObject();
  canvas.discardActiveObject();
  const vpt = canvas.viewportTransform.slice();
  const ret = canvas.enableRetinaScaling;
  canvas.viewportTransform = [1, 0, 0, 1, B, B];
  canvas.enableRetinaScaling = false;
  state.exporting = o.format === 'jpg' ? 'jpg' : 'png';
  try {
    const url = canvas.toDataURL({ format: o.format === 'jpg' ? 'jpeg' : 'png', quality: 0.95, multiplier: mult, left: 0, top: 0, width: W, height: H });
    const bin = atob(url.split(',')[1]);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    await window.vpm.invoke('fs:write-bin', file, u8);
    toast('Saved ' + file.split(/[\\/]/).pop());
  } finally {
    state.exporting = false;
    canvas.enableRetinaScaling = ret;
    canvas.setViewportTransform(vpt);
    if (sel) canvas.setActiveObject(sel);
    canvas.requestRenderAll();
  }
}

async function exportSvg() {
  let file = await window.vpm.invoke('dialog:save', { title: 'Export SVG', defaultPath: state.doc.name + '.svg', filters: [{ name: 'SVG', extensions: ['svg'] }] });
  if (!file) return;
  if (!/\.svg$/i.test(file)) file += '.svg';
  const d = state.doc;
  exitPathEdit();
  canvas.discardActiveObject();
  const vpt = canvas.viewportTransform.slice();
  canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
  let svg = canvas.toSVG({ width: d.width + 'pt', height: d.height + 'pt', viewBox: { x: 0, y: 0, width: d.width, height: d.height } });
  canvas.setViewportTransform(vpt);
  svg = svg.replace(/vpf_[A-Za-z0-9_-]+/g, (a) => {
    const f = state.fonts.find((x) => 'vpf_' + x.id.replace(/[^a-zA-Z0-9_-]/g, '_') === a);
    return f ? f.family : a;
  });
  await window.vpm.invoke('fs:write-text', file, svg);
  toast('Saved ' + file.split(/[\\/]/).pop() + ' (screen RGB colours)');
}

// ---------------- command router ----------------
export const commands = {
  'new': async () => { if (await confirmDiscard()) { const o = await dlg.newDocDialog(); if (o) newDoc(o); } },
  'open': async () => {
    if (!await confirmDiscard()) return;
    const f = await window.vpm.invoke('dialog:open', { title: 'Open', properties: ['openFile'], filters: [{ name: 'All supported', extensions: ['vpm', 'ai', 'pdf', 'svg'] }, { name: 'Vibrant Print Master Pro', extensions: ['vpm'] }, { name: 'Adobe Illustrator', extensions: ['ai'] }, { name: 'PDF', extensions: ['pdf'] }, { name: 'SVG', extensions: ['svg'] }] });
    if (!f) return;
    if (/\.(ai|pdf)$/i.test(f[0])) await openPdfDocument(f[0]);
    else if (/\.svg$/i.test(f[0])) { newDoc({ width: toPt(210, 'mm'), height: toPt(297, 'mm'), name: f[0].split(/[\\/]/).pop().replace(/\.svg$/i, '') }); await importPath(f[0]); }
    else await openFile(f[0]);
  },
  'save': () => save(false),
  'save-as': () => save(true),
  'place': placeImage,
  'import-svg': async () => {
    const f = await window.vpm.invoke('dialog:open', { title: 'Import SVG / AI / PDF', properties: ['openFile'], filters: [{ name: 'SVG, AI, PDF', extensions: ['svg', 'ai', 'pdf'] }] });
    if (f) importPath(f[0]);
  },
  'export-pdf': () => exportPrint('pdf'),
  'export-ai': () => exportPrint('ai'),
  'export-eps': () => exportPrint('eps'),
  'export-raster': exportRaster,
  'export-svg': exportSvg,
  'preflight': async () => dlg.preflightDialog(await runPreflight()),
  'doc-setup': async () => { const o = await dlg.docSetupDialog(); if (o) { Object.assign(state.doc, o); markDirty(); emit('doc'); zoomFit(); refreshPanels(); } },
  'preferences': () => dlg.preferencesDialog(),
  'about': () => dlg.aboutDialog(),
  'shortcuts': () => dlg.shortcutsDialog(),
  'undo': () => (isField(document.activeElement) ? document.execCommand('undo') : undo()),
  'redo': () => (isField(document.activeElement) ? document.execCommand('redo') : redo()),
  'cut': () => document.execCommand('cut'),
  'copy': () => document.execCommand('copy'),
  'paste': () => { if (isField(document.activeElement)) document.execCommand('paste'); else paste(false); },
  'paste-in-place': () => paste(true),
  'duplicate': duplicate,
  'delete': deleteSel,
  'select-all': () => {
    const a = canvas.getActiveObject();
    if (a && a.isEditing) { a.selectAll(); canvas.requestRenderAll(); return; }
    if (isField(document.activeElement)) { document.execCommand('selectAll'); return; }
    setTool('select');
    selectObjects(canvas.getObjects().filter((o) => o.selectable && o.visible));
  },
  'deselect': () => { canvas.discardActiveObject(); canvas.requestRenderAll(); },
  'group': group,
  'ungroup': ungroup,
  'front': () => arrange('front'), 'forward': () => arrange('forward'), 'backward': () => arrange('backward'), 'back': () => arrange('back'),
  'lock': lockSel, 'unlock-all': unlockAll, 'hide': hideSel, 'show-all': showAll,
  'clip-make': makeClip, 'clip-release': releaseClipCmd,
  'to-path': toPathCmd,
  'flip-h': () => flip('h'), 'flip-v': () => flip('v'),
  'outline-text': outlineText,
  'zoom-in': () => setZoom(state.zoom * 1.25), 'zoom-out': () => setZoom(state.zoom / 1.25),
  'zoom-fit': zoomFit, 'zoom-100': zoom100,
  'toggle-rulers': () => { state.showRulers = !state.showRulers; $('#stage').classList.toggle('no-rulers', !state.showRulers); },
  'toggle-guides': () => { state.showGuides = !state.showGuides; canvas.requestRenderAll(); },
  'toggle-bleed': () => { state.showBleed = !state.showBleed; canvas.requestRenderAll(); },
  'toggle-snap': () => { state.snap = !state.snap; toast('Snapping ' + (state.snap ? 'on' : 'off')); },
  'clear-guides': () => { state.doc.guides = { v: [], h: [] }; markDirty(); canvas.requestRenderAll(); },
  'window-close-request': async () => { if (await confirmDiscard()) window.vpm.forceClose(); },
};
export function run(cmd) {
  const f = commands[cmd];
  if (f) Promise.resolve(f()).catch((e) => { console.error(e); dlg.alert('Error', String(e.message || e)); });
}
window.vpm.onMenu(run);
window.__vpmCmd = run;
$$('[data-cmd]').forEach((b) => b.addEventListener('click', () => run(b.dataset.cmd)));

// ---------------- keyboard ----------------
const TOOLKEYS = { v: 'select', a: 'direct', p: 'pen', t: 'text', m: 'rect', l: 'ellipse', '\\': 'line', i: 'eyedropper', h: 'hand', z: 'zoom' };
let spaceHand = null;
window.addEventListener('keydown', (e) => {
  const a = canvas.getActiveObject();
  if (a && a.isEditing) { if (e.key === 'Escape') { a.exitEditing(); canvas.requestRenderAll(); } return; }
  if (isField(document.activeElement)) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if ($('#modal-root').children.length) return;
  const mod = modKey(e);
  if (e.key === ' ' && !spaceHand) { spaceHand = state.tool; setTool('hand', true); e.preventDefault(); return; }
  if (mod) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'Escape') { if (state.tool === 'pen') finishPen(false); else { canvas.discardActiveObject(); canvas.requestRenderAll(); } return; }
  if (k === 'Enter') { if (state.tool === 'pen') finishPen(false); else if (a && isText(a)) { canvas.setActiveObject(a); a.enterEditing(); } return; }
  if (k === 'Delete' || k === 'Backspace') { deleteSel(); e.preventDefault(); return; }
  if (k.startsWith('Arrow')) {
    if (!a) return;
    const step = e.shiftKey ? 10 : 1;
    const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
    const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
    a.set({ left: a.left + dx, top: a.top + dy });
    a.setCoords();
    canvas.requestRenderAll();
    canvas.fire('object:modified', { target: a });
    e.preventDefault();
    return;
  }
  if (e.altKey) return;
  if (k === 'x' && e.shiftKey) { emit('swap-paint'); return; }
  if (k === 'x') { emit('toggle-paint'); return; }
  if (k === 'd') { emit('default-paint'); return; }
  if (k === '/') { emit('none-paint'); return; }
  if (TOOLKEYS[k]) { setTool(TOOLKEYS[k]); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && spaceHand) { const t = spaceHand; spaceHand = null; setTool(t, true); }
});

// ---------------- status bar ----------------
canvas.on('mouse:move', (e) => {
  const p = e.scenePoint || canvas.getScenePoint(e.e);
  const u = state.doc.units;
  $('#st-pos').textContent = `X ${fmt(p.x, u)}  Y ${fmt(p.y, u)} ${u}`;
});
function updateSelStatus() {
  const objs = canvas.getActiveObjects();
  $('#st-sel').textContent = objs.length ? (objs.length === 1 ? (objs[0].name || objs[0].type) : objs.length + ' objects') : 'No selection';
}
['selection:created', 'selection:updated', 'selection:cleared'].forEach((ev) => canvas.on(ev, () => { updateSelStatus(); refreshPanels(); }));

export async function setProfileStatus() {
  const r = await window.vpm.invoke('color:profiles');
  $('#st-profile').textContent = r.current ? 'CMYK · ' + r.current.name : 'CMYK · no ICC profile found';
}
$('#st-profile').addEventListener('click', () => run('preferences'));

export async function onProfileChanged() {
  clearColorCache();
  const all = collectCmyk(canvas.getObjects());
  await preloadCmyk(all);
  refreshAllPaints(canvas);
  refreshPanels();
  setProfileStatus();
}

setColorUpdateHandler(() => { refreshAllPaints(canvas); emit('colors-updated'); });

// ---------------- boot ----------------
async function boot() {
  newDoc({ width: toPt(210, 'mm'), height: toPt(297, 'mm'), units: 'mm', name: 'Untitled' });
  initTools();
  initPanels();
  initRulers();
  setTool('select');
  setProfileStatus();
  loadFontList().then(() => { emit('fonts'); if (state.defaults.fontId) ensureFont(state.defaults.fontId); });
  const params = new URLSearchParams(location.search);
  const open = params.get('open');
  if (open) await openFile(open);
  else if (!params.has('test')) {
    const o = await dlg.newDocDialog(true);
    if (o) newDoc(o);
  }
  Object.assign(window.__vpm, { openPdfDocument, placePdf, buildDisplayList, run, commands, newDoc, placeImageData, importSvgText, outlineObject, enliven, applyPaint, convertToPath, serialize, openFile, setZoom, zoomFit, undo, redo, commit, selectObjects, runPreflight });
  window.__vpmReady = true;
}
boot();

export { canvas };
