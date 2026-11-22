// Open Adobe Illustrator (.ai, PDF-compatible) and PDF files as editable vector objects.
// pdf.js parses the file; its worker is patched so original CMYK / grey values survive,
// then this interpreter turns the drawing operators into Fabric objects with CMYK paints.
import * as pdfjs from '../../node_modules/pdfjs-dist/build/pdf.mjs';
import { state } from './state.js';
import { rgbToCmyk, preloadCmyk } from './util.js';
import { applyPaint, PROPS } from './paint.js';

const OPS = pdfjs.OPS;
const BASE = new URL('../../node_modules/pdfjs-dist/', import.meta.url).href;
let workerReady = null;

function setupWorker() {
  if (workerReady) return workerReady;
  workerReady = (async () => {
    let src = await (await fetch(BASE + 'build/pdf.worker.mjs')).text();
    const tag = 'function __vpmTag(cs,a){try{if(cs&&cs.numComps===4&&!/separation|devicen/i.test(cs.name||""))return "|cmyk:"+Array.from(a).slice(0,4).join(",");if(cs&&cs.numComps===1&&/gray/i.test(cs.name||""))return "|gray:"+a[0];}catch(e){}return "";}\n';
    src = src
      .replaceAll('args = [cs.getRgbHex(args, 0)];', 'args = [cs.getRgbHex(args, 0) + __vpmTag(cs, args)];')
      .replaceAll('args = [ColorSpaceUtils.cmyk.getRgbHex(args, 0)];', 'args = [ColorSpaceUtils.cmyk.getRgbHex(args, 0) + "|cmyk:" + Array.from(args).join(",")];')
      .replaceAll('args = [ColorSpaceUtils.gray.getRgbHex(args, 0)];', 'args = [ColorSpaceUtils.gray.getRgbHex(args, 0) + "|gray:" + args[0]];');
    const url = URL.createObjectURL(new Blob([tag + src], { type: 'text/javascript' }));
    pdfjs.GlobalWorkerOptions.workerSrc = url;
  })();
  return workerReady;
}

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const tp = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
const r3 = (v) => Math.round(v * 1000) / 1000;

function parseColor(s) {
  if (!s || s === 'transparent') return null;
  const [hex, extra] = String(s).split('|');
  const out = { hex };
  if (extra && extra.startsWith('cmyk:')) out.cmyk = extra.slice(5).split(',').map((v) => Math.round(parseFloat(v) * 1000) / 10);
  else if (extra && extra.startsWith('gray:')) out.cmyk = [0, 0, 0, Math.round((1 - parseFloat(extra.slice(5))) * 1000) / 10];
  return out;
}
const hexRgb = (hex) => {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
};

function objGet(store, id) {
  return new Promise((res) => {
    try { store.get(id, (v) => res(v)); } catch { res(null); }
  });
}

// ---------- public API ----------
export async function loadPdf(bytes) {
  await setupWorker();
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024));
  if (!head.includes('%PDF')) {
    throw new Error('This file has no PDF-compatible content.\n\nIn Illustrator, re-save it with File → Save As → Illustrator (.ai) and keep “Create PDF Compatible File” ticked (it is on by default), or save a PDF.\nEPS files cannot be opened.');
  }
  return pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: BASE + 'standard_fonts/',
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    wasmUrl: BASE + 'wasm/',
    iccUrl: BASE + 'iccs/',
    fontExtraProperties: true,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
}

// Build Fabric objects for one page. Returns { width, height, objects, stats }.
export async function pageToObjects(pdf, pageNo, registerAsset) {
  const page = await pdf.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const VT = vp.transform;
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const stats = { paths: 0, text: 0, images: 0, skipped: 0 };

  // ---- pass 1: collect resources ----
  const fontIds = new Set(); const imgIds = new Set(); const patIds = new Set();
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]; const a = argsArray[i];
    if (fn === OPS.setFont) fontIds.add(a[0]);
    else if (fn === OPS.setGState) for (const [k, v] of a[0]) { if (k === 'Font') fontIds.add(v[0]); }
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) imgIds.add(a[0]);
    else if (fn === OPS.shadingFill) patIds.add(a[0]);
    else if ((fn === OPS.setFillColorN || fn === OPS.setStrokeColorN) && a[0] === 'Shading') patIds.add(a[1]);
  }
  const store = (id) => (String(id).startsWith('g_') ? page.commonObjs : page.objs);
  const fonts = new Map();
  for (const id of fontIds) fonts.set(id, await objGet(page.commonObjs, id));
  const images = new Map();
  for (const id of imgIds) images.set(id, await objGet(store(id), id));
  const patterns = new Map();
  for (const id of patIds) patterns.set(id, await objGet(store(id), id));

  // glyph outlines: ask the main process to read pdf.js' converted font programs
  const wanted = new Map(); // fontId -> Set(chars)
  {
    let cur = null;
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i]; const a = argsArray[i];
      if (fn === OPS.setFont) cur = a[0];
      else if (fn === OPS.setGState) { for (const [k, v] of a[0]) if (k === 'Font') cur = v[0]; }
      else if (fn === OPS.showText && cur) {
        if (!wanted.has(cur)) wanted.set(cur, new Set());
        for (const g of a[0]) if (g && typeof g === 'object' && g.fontChar) { wanted.get(cur).add(g.fontChar); if (g.accent) wanted.get(cur).add(g.accent.fontChar); }
      }
    }
  }
  const glyphs = new Map(); // fontId -> { upem, map: {char: cmds} }
  for (const [fid, set] of wanted) {
    const f = fonts.get(fid);
    if (!f || !f.data || f.isType3Font) continue;
    try {
      const res = await window.vpm.invoke('fonts:pdf-glyphs', { key: fid + ':' + (f.loadedName || ''), data: f.data, chars: [...set] });
      if (res) glyphs.set(fid, res);
    } catch (e) { console.warn('glyphs failed', e); }
  }

  // ---- pass 2: interpret ----
  const root = { children: [], depth: -1, clip: null };
  const containers = [root];
  const pendingRgb = [];
  let st = {
    ctm: [1, 0, 0, 1, 0, 0], fill: { hex: '#000000', cmyk: [0, 0, 0, 100] }, stroke: { hex: '#000000', cmyk: [0, 0, 0, 100] },
    fillPat: null, strokePat: null, lw: 1, cap: 0, join: 0, miter: 10, dash: null, ca: 1, CA: 1,
    font: null, fontId: null, fontSize: 0, cs: 0, ws: 0, hs: 1, leading: 0, rise: 0, mode: 0, tm: null, x: 0, y: 0, lx: 0, ly: 0,
  };
  const stack = [];
  let pendingClip = null;
  const W = vp.width; const H = vp.height;

  const toPaint = (c) => {
    if (!c) return null;
    if (c.cmyk) return { type: 'solid', cmyk: c.cmyk.map((v) => Math.max(0, Math.min(100, v))) };
    const p = { type: 'solid', cmyk: [0, 0, 0, 100] };
    pendingRgb.push([p, hexRgb(c.hex)]);
    return p;
  };
  const patPaint = (pat, M) => {
    // pat: { ir, matrix }
    const ir = pat.ir;
    if (!ir || ir[0] !== 'RadialAxial') return null;
    const [, type, , stopsRaw, p0, p1] = ir;
    const PM = pat.matrix ? mul(M, pat.matrix) : M;
    const a = tp(PM, p0[0], p0[1]); const b = tp(PM, p1[0], p1[1]);
    const stops = stopsRaw.map(([o, col]) => {
      const s = { o, cmyk: [0, 0, 0, 0] };
      const c = parseColor(col);
      if (c && c.cmyk) s.cmyk = c.cmyk; else pendingRgb.push([s, hexRgb(c ? c.hex : '#000')]);
      return s;
    });
    if (type === 'radial') return { type: 'rad', stops };
    return { type: 'lin', angle: Math.round(Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180 / Math.PI), stops };
  };

  const buildSubs = (data, M) => {
    const subs = []; let cur = null;
    if (!data) return subs;
    let px = 0; let py = 0;
    for (let i = 0; i < data.length;) {
      const op = data[i++];
      if (op === 0) { const p = tp(M, data[i++], data[i++]); cur = { closed: false, pts: [['M', ...p]] }; subs.push(cur); px = p[0]; py = p[1]; }
      else if (op === 1) { const p = tp(M, data[i++], data[i++]); if (!cur) { cur = { closed: false, pts: [['M', ...p]] }; subs.push(cur); } else cur.pts.push(['L', ...p]); px = p[0]; py = p[1]; }
      else if (op === 2) { const a = tp(M, data[i++], data[i++]); const b = tp(M, data[i++], data[i++]); const c = tp(M, data[i++], data[i++]); if (cur) cur.pts.push(['C', ...a, ...b, ...c]); px = c[0]; py = c[1]; }
      else if (op === 3) {
        const q = tp(M, data[i++], data[i++]); const e = tp(M, data[i++], data[i++]);
        if (cur) cur.pts.push(['C', px + 2 / 3 * (q[0] - px), py + 2 / 3 * (q[1] - py), e[0] + 2 / 3 * (q[0] - e[0]), e[1] + 2 / 3 * (q[1] - e[1]), ...e]);
        px = e[0]; py = e[1];
      } else if (op === 4) { if (cur) { cur.closed = true; const m0 = cur.pts[0]; px = m0[1]; py = m0[2]; } }
      else break;
    }
    return subs.filter((s) => s.pts.length > 1 || s.closed);
  };
  const subsD = (subs) => subs.map((s) => s.pts.map((p) => p[0] + ' ' + p.slice(1).map(r3).join(' ')).join(' ') + (s.closed ? ' Z' : '')).join(' ');

  const add = (o) => { containers[containers.length - 1].children.push(o); };

  const isPageRect = (subs) => {
    if (subs.length !== 1) return false;
    const pts = subs[0].pts;
    if (pts.some((p) => p[0] === 'C') || pts.length < 4 || pts.length > 5) return false;
    const xs = pts.map((p) => p[1]); const ys = pts.map((p) => p[2]);
    const x0 = Math.min(...xs); const x1 = Math.max(...xs); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
    const axis = pts.every((p) => [x0, x1].some((v) => Math.abs(v - p[1]) < 0.01) && [y0, y1].some((v) => Math.abs(v - p[2]) < 0.01));
    return axis && x0 <= 1 && y0 <= 1 && x1 >= W - 1 && y1 >= H - 1;
  };

  const pushClip = (subs, rule) => {
    if (!subs.length || isPageRect(subs)) return;
    containers.push({ children: [], depth: stack.length, clip: { subs, rule } });
  };
  const closeContainer = () => {
    const c = containers.pop();
    if (!c.children.length) return;
    const g = new fabric.Group(c.children);
    const cp = new fabric.Path(subsD(c.clip.subs) || 'M 0 0', { fillRule: c.clip.rule });
    const rel = mul(fabric.util.invertTransform(g.calcTransformMatrix()), cp.calcTransformMatrix());
    fabric.util.applyTransformToObject(cp, rel);
    cp.set({ absolutePositioned: false, fill: '#000', stroke: null });
    g.clipPath = cp;
    g.vpClip = true;
    g.name = 'Clip Group';
    add(g);
  };

  const makePath = (subs, doFill, doStroke, evenOdd) => {
    if (!subs.length) return;
    const M = mul(VT, st.ctm);
    const p = new fabric.Path(subsD(subs), { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
    p.vpFill = doFill ? (st.fillPat ? patPaint(st.fillPat, M) || toPaint(st.fill) : toPaint(st.fill)) : null;
    p.vpStroke = doStroke ? toPaint(st.stroke) : null;
    p.strokeWidth = doStroke ? Math.max(0.01, st.lw * scaleOf(M)) : 0;
    p.strokeLineCap = ['butt', 'round', 'square'][st.cap] || 'butt';
    p.strokeLineJoin = ['miter', 'round', 'bevel'][st.join] || 'miter';
    p.strokeMiterLimit = st.miter || 10;
    if (doStroke && st.dash && st.dash[0] && st.dash[0].length) p.strokeDashArray = st.dash[0].map((v) => v * scaleOf(M));
    const op = doFill ? st.ca : st.CA;
    if (op < 1) p.opacity = op;
    p.name = doFill ? 'Path' : 'Stroke';
    add(p);
    stats.paths++;
  };

  const save = () => { stack.push({ ...st, ctm: [...st.ctm] }); };
  const restore = () => {
    if (stack.length) st = stack.pop();
    while (containers.length > 1 && containers[containers.length - 1].depth > stack.length) closeContainer();
  };

  const showText = (glyphList) => {
    const f = st.font; const fs = st.fontSize;
    if (!f || !fs) return;
    const gl = glyphs.get(st.fontId);
    const fm = f.fontMatrix || [0.001, 0, 0, 0.001, 0, 0];
    const adv = fs * fm[0];
    const hs = st.hs;
    let x = 0;
    const local = [];
    for (const g of glyphList) {
      if (typeof g === 'number') { x -= g * fs / 1000; continue; }
      if (!g) continue;
      const spacing = (g.isSpace ? st.ws : 0) + st.cs;
      const draw = (ch, ox, oy) => {
        const cmds = gl && gl.map[ch];
        if (!cmds || !cmds.length) return;
        const s = fs / gl.upem;
        let cur = null;
        const P = (u, v) => [st.x + (x + ox + u * s) * hs, st.y + st.rise + oy + v * s];
        let px = 0; let py = 0;
        for (const c of cmds) {
          const a = c[1];
          if (c[0] === 'M') { cur = { closed: false, pts: [['M', ...P(a[0], a[1])]] }; local.push(cur); px = a[0]; py = a[1]; }
          else if (c[0] === 'L') { cur && cur.pts.push(['L', ...P(a[0], a[1])]); px = a[0]; py = a[1]; }
          else if (c[0] === 'Q') {
            const c1 = P(px + 2 / 3 * (a[0] - px), py + 2 / 3 * (a[1] - py)); const c2 = P(a[2] + 2 / 3 * (a[0] - a[2]), a[3] + 2 / 3 * (a[1] - a[3])); const e = P(a[2], a[3]);
            cur && cur.pts.push(['C', ...c1, ...c2, ...e]); px = a[2]; py = a[3];
          } else if (c[0] === 'C') { cur && cur.pts.push(['C', ...P(a[0], a[1]), ...P(a[2], a[3]), ...P(a[4], a[5])]); px = a[4]; py = a[5]; }
          else if (c[0] === 'Z') { if (cur) cur.closed = true; }
        }
      };
      if (g.fontChar) draw(g.fontChar, 0, 0);
      if (g.accent) draw(g.accent.fontChar, fs * g.accent.offset.x, fs * g.accent.offset.y);
      x += g.width * adv + spacing;
    }
    st.x += x * hs;
    const mode = st.mode & 3;
    if (mode === 3 || !local.length) return;
    const M = mul(VT, st.tm ? mul(st.ctm, st.tm) : st.ctm);
    const subs = local.map((s) => ({ closed: s.closed, pts: s.pts.map((p) => (p[0] === 'C' ? ['C', ...tp(M, p[1], p[2]), ...tp(M, p[3], p[4]), ...tp(M, p[5], p[6])] : [p[0], ...tp(M, p[1], p[2])])) }));
    const p = new fabric.Path(subsD(subs), { fillRule: 'nonzero' });
    const fillIt = mode === 0 || mode === 2; const strokeIt = mode === 1 || mode === 2;
    p.vpFill = fillIt ? (st.fillPat ? patPaint(st.fillPat, M) || toPaint(st.fill) : toPaint(st.fill)) : null;
    p.vpStroke = strokeIt ? toPaint(st.stroke) : null;
    p.strokeWidth = strokeIt ? Math.max(0.01, st.lw * scaleOf(mul(VT, st.ctm))) : 0;
    if (st.ca < 1) p.opacity = st.ca;
    const uni = glyphList.filter((g) => g && typeof g === 'object').map((g) => g.unicode || '').join('');
    p.name = (uni.trim() || 'Text').slice(0, 28) + ' (outlines)';
    add(p);
    stats.text++;
  };

  const paintImage = async (img) => {
    if (!img) { stats.skipped++; return; }
    const w = img.width; const h = img.height;
    if (!w || !h) return;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
    else if (img.data) {
      const id = ctx.createImageData(w, h); const d = id.data; const s = img.data;
      if (img.kind === 3 || s.length === w * h * 4) d.set(s.subarray ? s.subarray(0, d.length) : s);
      else if (img.kind === 2 || s.length === w * h * 3) { for (let i = 0, j = 0; i < w * h; i++, j += 3) { d[i * 4] = s[j]; d[i * 4 + 1] = s[j + 1]; d[i * 4 + 2] = s[j + 2]; d[i * 4 + 3] = 255; } }
      else if (img.kind === 1) { const rb = (w + 7) >> 3; for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) { const bit = (s[y * rb + (xx >> 3)] >> (7 - (xx & 7))) & 1; const v = bit ? 255 : 0; const k = (y * w + xx) * 4; d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255; } }
      else { stats.skipped++; return; }
      ctx.putImageData(id, 0, 0);
    } else { stats.skipped++; return; }
    const url = cv.toDataURL('image/png');
    const fimg = await fabric.FabricImage.fromURL(url);
    fimg.vpAssetId = registerAsset(url);
    const M = mul(mul(VT, st.ctm), [1 / w, 0, 0, -1 / h, 0.5, 0.5]);
    fabric.util.applyTransformToObject(fimg, M);
    fimg.name = 'Image';
    if (st.ca < 1) fimg.opacity = st.ca;
    add(fimg);
    stats.images++;
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]; const a = argsArray[i] || [];
    switch (fn) {
      case OPS.save: save(); break;
      case OPS.restore: restore(); break;
      case OPS.transform: st.ctm = mul(st.ctm, a); break;
      case OPS.setLineWidth: st.lw = a[0]; break;
      case OPS.setLineCap: st.cap = a[0]; break;
      case OPS.setLineJoin: st.join = a[0]; break;
      case OPS.setMiterLimit: st.miter = a[0]; break;
      case OPS.setDash: st.dash = [a[0], a[1]]; break;
      case OPS.setGState:
        for (const [k, v] of a[0]) {
          if (k === 'LW') st.lw = v; else if (k === 'LC') st.cap = v; else if (k === 'LJ') st.join = v; else if (k === 'ML') st.miter = v;
          else if (k === 'D') st.dash = v; else if (k === 'CA') st.CA = v; else if (k === 'ca') st.ca = v;
          else if (k === 'Font') { st.fontId = v[0]; st.font = fonts.get(v[0]); st.fontSize = v[1]; }
        }
        break;
      case OPS.setFillRGBColor: st.fill = parseColor(a[0]); st.fillPat = null; break;
      case OPS.setStrokeRGBColor: st.stroke = parseColor(a[0]); st.strokePat = null; break;
      case OPS.setFillTransparent: st.fill = null; st.fillPat = null; break;
      case OPS.setStrokeTransparent: st.stroke = null; st.strokePat = null; break;
      case OPS.setFillColorN:
        if (a[0] === 'Shading') st.fillPat = { ir: patterns.get(a[1]), matrix: a[2] };
        else st.fillPat = null; // tiling patterns: keep last solid colour
        break;
      case OPS.setStrokeColorN: break;
      case OPS.clip: pendingClip = 'nonzero'; break;
      case OPS.eoClip: pendingClip = 'evenodd'; break;
      case OPS.constructPath: {
        const [op, data] = a;
        const M = mul(VT, st.ctm);
        const subs = buildSubs(data && data[0], M);
        const closeAll = () => subs.forEach((s) => { s.closed = true; });
        switch (op) {
          case OPS.fill: makePath(subs, true, false, false); break;
          case OPS.eoFill: makePath(subs, true, false, true); break;
          case OPS.stroke: makePath(subs, false, true, false); break;
          case OPS.closeStroke: closeAll(); makePath(subs, false, true, false); break;
          case OPS.fillStroke: makePath(subs, true, true, false); break;
          case OPS.eoFillStroke: makePath(subs, true, true, true); break;
          case OPS.closeFillStroke: closeAll(); makePath(subs, true, true, false); break;
          case OPS.closeEOFillStroke: closeAll(); makePath(subs, true, true, true); break;
          default: break; // endPath
        }
        if (pendingClip) { subs.forEach((s) => { s.closed = true; }); pushClip(subs, pendingClip); pendingClip = null; }
        break;
      }
      case OPS.beginText: st.tm = [1, 0, 0, 1, 0, 0]; st.x = st.lx = 0; st.y = st.ly = 0; break;
      case OPS.endText: break;
      case OPS.setFont: st.fontId = a[0]; st.font = fonts.get(a[0]); st.fontSize = Math.abs(a[1]); break;
      case OPS.setCharSpacing: st.cs = a[0]; break;
      case OPS.setWordSpacing: st.ws = a[0]; break;
      case OPS.setHScale: st.hs = a[0] / 100; break;
      case OPS.setLeading: st.leading = -a[0]; break;
      case OPS.setTextRise: st.rise = a[0]; break;
      case OPS.setTextRenderingMode: st.mode = a[0]; break;
      case OPS.setTextMatrix: st.tm = Array.isArray(a[0]) || ArrayBuffer.isView(a[0]) ? [...a[0]] : [...a]; st.x = st.lx = 0; st.y = st.ly = 0; break;
      case OPS.moveText: st.x = st.lx += a[0]; st.y = st.ly += a[1]; break;
      case OPS.setLeadingMoveText: st.leading = a[1]; st.x = st.lx += a[0]; st.y = st.ly += a[1]; break;
      case OPS.nextLine: st.x = st.lx += 0; st.y = st.ly += st.leading; break;
      case OPS.showText: showText(a[0]); break;
      case OPS.showSpacedText: showText(a[0]); break;
      case OPS.nextLineShowText: st.y = st.ly += st.leading; st.x = st.lx; showText(a[0]); break;
      case OPS.nextLineSetSpacingShowText: st.ws = a[0]; st.cs = a[1]; st.y = st.ly += st.leading; st.x = st.lx; showText(a[2]); break;
      case OPS.paintImageXObject: await paintImage(images.get(a[0])); break;
      case OPS.paintInlineImageXObject: await paintImage(a[0]); break;
      case OPS.paintSolidColorImageMask: {
        const M = mul(VT, st.ctm);
        makePath([{ closed: true, pts: [['M', ...tp(M, 0, 0)], ['L', ...tp(M, 1, 0)], ['L', ...tp(M, 1, 1)], ['L', ...tp(M, 0, 1)]] }], true, false, false);
        break;
      }
      case OPS.shadingFill: {
        const top = containers[containers.length - 1];
        const subs = top.clip ? top.clip.subs : [{ closed: true, pts: [['M', 0, 0], ['L', W, 0], ['L', W, H], ['L', 0, H]] }];
        const M = mul(VT, st.ctm);
        const paint = patPaint({ ir: patterns.get(a[0]), matrix: null }, M);
        if (paint) {
          const p = new fabric.Path(subsD(subs));
          p.vpFill = paint; p.vpStroke = null; p.strokeWidth = 0; p.name = 'Gradient';
          if (st.ca < 1) p.opacity = st.ca;
          add(p); stats.paths++;
        }
        break;
      }
      case OPS.paintFormXObjectBegin: save(); if (a[0]) st.ctm = mul(st.ctm, a[0]); break;
      case OPS.paintFormXObjectEnd: restore(); break;
      case OPS.beginGroup: save(); if (a[0] && a[0].matrix) st.ctm = mul(st.ctm, a[0].matrix); break;
      case OPS.endGroup: restore(); break;
      case OPS.paintImageMaskXObject: case OPS.paintImageMaskXObjectGroup: case OPS.paintImageMaskXObjectRepeat: case OPS.paintImageXObjectRepeat:
        stats.skipped++; break;
      default: break;
    }
  }
  while (containers.length > 1) closeContainer();

  // convert RGB-only colours to CMYK with the working profile
  if (pendingRgb.length) {
    const res = await rgbToCmyk(pendingRgb.map(([, rgb]) => rgb));
    pendingRgb.forEach(([obj], k) => { obj.cmyk = res[k]; });
  }
  const objs = root.children;
  const allCmyk = [];
  const walk = (list) => list.forEach((o) => {
    if (o.type === 'group') walk(o.getObjects());
    for (const p of [o.vpFill, o.vpStroke]) if (p) { if (p.type === 'solid') allCmyk.push(p.cmyk); else p.stops.forEach((s) => allCmyk.push(s.cmyk)); }
  });
  walk(objs);
  await preloadCmyk(allCmyk);
  objs.forEach(applyPaint);
  page.cleanup();
  return { width: vp.width, height: vp.height, objects: objs, stats, rgbConverted: pendingRgb.length };
}

export { PROPS };
