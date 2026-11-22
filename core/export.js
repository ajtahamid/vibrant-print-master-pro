// Turns the renderer's display list into print files (PDF / AI / EPS). Main process.
import zlib from 'zlib';
import fs from 'fs';
import { shapeLine } from './fonts.js';
import { imageToCmyk, profileBytes, profileInfo } from './color.js';

const r = (v) => {
  const s = (Math.round(v * 1000) / 1000).toString();
  return s === '-0' ? '0' : s;
};

function mul(a, b) { // affine [a,b,c,d,e,f]: result = a ∘ b (apply b first, then a)
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
const tp = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function transformSubs(subs, m) {
  return subs.map((s) => ({
    closed: s.closed,
    pts: s.pts.map((p) => {
      if (p[0] === 'C') {
        const a = tp(m, p[1], p[2]); const b = tp(m, p[3], p[4]); const c = tp(m, p[5], p[6]);
        return ['C', ...a, ...b, ...c];
      }
      return [p[0], ...tp(m, p[1], p[2])];
    }),
  }));
}

// Resolve text into outlined paths, images into CMYK pixel data.
export function resolveDisplayList(list, compositeWhite = false) {
  const out = [];
  for (const it of list) {
    if (it.t === 'text') {
      let subs = [];
      for (const ln of it.lines) {
        if (!ln.text) continue;
        const shaped = shapeLine(it.fontId, ln.text, it.size, it.tracking);
        const lm = [1, 0, 0, 1, ln.x + (ln.dx || 0), ln.y];
        subs.push(...transformSubs(shaped.subpaths, lm));
      }
      if (it.skewX) subs = transformSubs(subs, [1, 0, Math.tan(it.skewX * Math.PI / 180), 1, 0, 0]);
      subs = transformSubs(subs, it.matrix);
      if (subs.length) out.push({ t: 'path', subs, fill: it.fill, stroke: it.stroke, opacity: it.opacity, rule: 'nonzero', strokeFirst: it.strokeFirst });
    } else if (it.t === 'image') {
      const { cmyk, alpha } = imageToCmyk(it.rgba, it.pw, it.ph, compositeWhite);
      out.push({ ...it, rgba: null, cmyk, alpha });
    } else out.push(it);
  }
  return out;
}

// ---------- common paint helpers ----------
const k4 = (c) => c.map((v) => r(Math.max(0, Math.min(100, v)) / 100)).join(' ');

function pathOps(subs, ps) {
  const o = [];
  for (const s of subs) {
    for (const p of s.pts) {
      if (p[0] === 'M') o.push(`${r(p[1])} ${r(p[2])} ${ps ? 'moveto' : 'm'}`);
      else if (p[0] === 'L') o.push(`${r(p[1])} ${r(p[2])} ${ps ? 'lineto' : 'l'}`);
      else o.push(`${r(p[1])} ${r(p[2])} ${r(p[3])} ${r(p[4])} ${r(p[5])} ${r(p[6])} ${ps ? 'curveto' : 'c'}`);
    }
    if (s.closed) o.push(ps ? 'closepath' : 'h');
  }
  return o.join('\n');
}

function gradientFunction(stops) {
  const st = [...stops].sort((a, b) => a.o - b.o);
  if (st.length === 0) return null;
  if (st[0].o > 0) st.unshift({ o: 0, cmyk: st[0].cmyk });
  if (st[st.length - 1].o < 1) st.push({ o: 1, cmyk: st[st.length - 1].cmyk });
  const c = (cm) => '[' + k4(cm) + ']';
  if (st.length === 2) {
    return `<< /FunctionType 2 /Domain [0 1] /C0 ${c(st[0].cmyk)} /C1 ${c(st[1].cmyk)} /N 1 >>`;
  }
  const fns = []; const bounds = []; const enc = [];
  for (let i = 0; i < st.length - 1; i++) {
    fns.push(`<< /FunctionType 2 /Domain [0 1] /C0 ${c(st[i].cmyk)} /C1 ${c(st[i + 1].cmyk)} /N 1 >>`);
    if (i > 0) bounds.push(r(st[i].o));
    enc.push('0 1');
  }
  return `<< /FunctionType 3 /Domain [0 1] /Functions [${fns.join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${enc.join(' ')}] >>`;
}

function shadingDict(g) {
  const fn = gradientFunction(g.stops);
  if (g.type === 'linear') {
    return `<< /ShadingType 2 /ColorSpace /DeviceCMYK /Coords [${r(g.x1)} ${r(g.y1)} ${r(g.x2)} ${r(g.y2)}] /Function ${fn} /Extend [true true] >>`;
  }
  return `<< /ShadingType 3 /ColorSpace /DeviceCMYK /Coords [${r(g.fx ?? g.cx)} ${r(g.fy ?? g.cy)} 0 ${r(g.cx)} ${r(g.cy)} ${r(g.r)}] /Function ${fn} /Extend [true true] >>`;
}

const CAP = { butt: 0, round: 1, square: 2 };
const JOIN = { miter: 0, round: 1, bevel: 2 };

// ---------- PDF ----------
class PdfWriter {
  constructor() { this.objs = []; }
  alloc() { this.objs.push(null); return this.objs.length; }
  set(id, body) { this.objs[id - 1] = body; }
  add(body) { const id = this.alloc(); this.set(id, body); return id; }
  stream(dict, data, compress = true) {
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    let d = dict;
    if (compress) { buf = zlib.deflateSync(buf); d += ' /Filter /FlateDecode'; }
    return this.add({ dict: `<< ${d} /Length ${buf.length} >>`, data: buf });
  }
  build(rootId, infoId) {
    const parts = [Buffer.from('%PDF-1.6\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let off = parts[0].length;
    const offsets = [];
    this.objs.forEach((o, i) => {
      offsets.push(off);
      let chunk;
      if (o && o.dict) {
        chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      } else chunk = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
      parts.push(chunk); off += chunk.length;
    });
    let xref = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((o) => { xref += String(o).padStart(10, '0') + ' 00000 n \n'; });
    xref += `trailer\n<< /Size ${this.objs.length + 1} /Root ${rootId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${off}\n%%EOF\n`;
    parts.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(parts);
  }
}

const pdfStr = (s) => '(' + String(s).replace(/[\\()]/g, (m) => '\\' + m).replace(/[^\x20-\x7e]/g, '?') + ')';

function pdfDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// pages: [{ width, height, items }]   opts: { bleed, includeBleed, marks, mode:'pdf'|'ai', title }
export function writePdf(pages, opts) {
  const w = new PdfWriter();
  const catalogId = w.alloc();
  const pagesId = w.alloc();
  const pageIds = [];
  const iccData = profileBytes();
  let intentId = null;
  if (iccData) {
    const iccId = w.stream('/N 4 /Alternate /DeviceCMYK', iccData);
    const name = profileInfo() ? profileInfo().name : 'CMYK';
    intentId = w.add(`<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier ${pdfStr(name)} /Info ${pdfStr(name)} /RegistryName (http://www.color.org) /DestOutputProfile ${iccId} 0 R >>`);
  }
  for (const page of pages) {
    const B = opts.includeBleed ? (opts.bleed || 0) : 0;
    const markLen = 18; const markGap = 3;
    const M = opts.marks ? Math.max(B, 6) + markGap + markLen + 4 : B; // margin around trim
    const PW = page.width + 2 * M; const PH = page.height + 2 * M;
    const gs = []; const shades = []; const xobjs = [];
    const c = [];
    // doc space: origin at trim top-left, y down
    c.push(`1 0 0 -1 ${r(M)} ${r(PH - M)} cm`);
    emitItems(c, page.items, { gs, shades, xobjs, w });
    if (opts.marks) emitCropMarks(c, page.width, page.height, Math.max(B, 6) + markGap, markLen);
    const content = w.stream('', c.join('\n'));
    const res = [];
    if (gs.length) res.push('/ExtGState << ' + gs.map((g, i) => `/GS${i} ${g}`).join(' ') + ' >>');
    if (shades.length) res.push('/Shading << ' + shades.map((s, i) => `/Sh${i} ${s} 0 R`).join(' ') + ' >>');
    if (xobjs.length) res.push('/XObject << ' + xobjs.map((x, i) => `/Im${i} ${x} 0 R`).join(' ') + ' >>');
    const trim = `[${r(M)} ${r(M)} ${r(M + page.width)} ${r(M + page.height)}]`;
    const bleedBox = `[${r(M - B)} ${r(M - B)} ${r(M + page.width + B)} ${r(M + page.height + B)}]`;
    let boxes = `/MediaBox [0 0 ${r(PW)} ${r(PH)}] /BleedBox ${bleedBox} /TrimBox ${trim}`;
    if (opts.mode === 'ai') boxes += ` /CropBox ${opts.includeBleed ? bleedBox : trim} /ArtBox ${trim}`;
    pageIds.push(w.add(`<< /Type /Page /Parent ${pagesId} 0 R ${boxes} /Resources << ${res.join(' ')} >> /Contents ${content} 0 R >>`));
  }
  w.set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`);
  w.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R${intentId ? ` /OutputIntents [${intentId} 0 R]` : ''} >>`);
  const infoId = w.add(`<< /Title ${pdfStr(opts.title || 'Untitled')} /Creator (Vibrant Print Master Pro - Created by Tahamid) /Producer (Vibrant Print Master Pro 1.0) /CreationDate (${pdfDate()}) /ModDate (${pdfDate()}) /Trapped /False >>`);
  return w.build(catalogId, infoId);
}

function emitCropMarks(c, W, H, off, len) {
  c.push('q 0.25 w 0 J [] 0 d 1 1 1 1 K');
  const seg = (x1, y1, x2, y2) => c.push(`${r(x1)} ${r(y1)} m ${r(x2)} ${r(y2)} l S`);
  for (const [x, sx] of [[0, -1], [W, 1]]) {
    for (const [y, sy] of [[0, -1], [H, 1]]) {
      seg(x + sx * off, y, x + sx * (off + len), y); // horizontal
      seg(x, y + sy * off, x, y + sy * (off + len)); // vertical
    }
  }
  c.push('Q');
}

function gsFor(ctx, ca, CA) {
  const key = `<< /Type /ExtGState /ca ${r(ca)} /CA ${r(CA)} >>`;
  let i = ctx.gs.indexOf(key);
  if (i < 0) { ctx.gs.push(key); i = ctx.gs.length - 1; }
  return `/GS${i} gs`;
}

function strokeSetup(st) {
  const o = [`${r(st.width)} w`, `${CAP[st.cap] ?? 0} J`, `${JOIN[st.join] ?? 0} j`, `${r(st.miter || 4)} M`];
  o.push(st.dash && st.dash.length ? `[${st.dash.map(r).join(' ')}] 0 d` : '[] 0 d');
  return o.join(' ');
}

function emitItems(c, items, ctx) {
  for (const it of items) {
    if (it.t === 'clipPush') {
      c.push('q');
      c.push(pathOps(it.subs, false));
      c.push(it.rule === 'evenodd' ? 'W* n' : 'W n');
    } else if (it.t === 'clipPop') {
      c.push('Q');
    } else if (it.t === 'path') emitPath(c, it, ctx);
    else if (it.t === 'image') emitImage(c, it, ctx);
  }
}

function emitPath(c, it, ctx) {
  const op = it.opacity ?? 1;
  const fill = it.fill; const st = it.stroke && it.stroke.width > 0 ? it.stroke : null;
  if (!fill && !st) return;
  const ev = it.rule === 'evenodd';
  const geo = pathOps(it.subs, false);
  c.push('q');
  if (op < 1) c.push(gsFor(ctx, op, op));
  const doFill = () => {
    if (!fill) return;
    if (fill.type === 'solid') {
      c.push(`${k4(fill.cmyk)} k`);
      c.push(geo); c.push(ev ? 'f*' : 'f');
    } else {
      const sid = ctx.w.add(shadingDict(fill));
      ctx.shades.push(sid);
      c.push('q'); c.push(geo); c.push(ev ? 'W* n' : 'W n');
      if (fill.matrix) c.push(fill.matrix.map(r).join(' ') + ' cm');
      c.push(`/Sh${ctx.shades.length - 1} sh`); c.push('Q');
    }
  };
  const doStroke = () => {
    if (!st) return;
    c.push(strokeSetup(st));
    if (st.paint.type === 'solid') { c.push(`${k4(st.paint.cmyk)} K`); c.push(geo); c.push('S'); }
    else {
      // gradient stroke: approximate with first stop colour
      c.push(`${k4(st.paint.stops[0].cmyk)} K`); c.push(geo); c.push('S');
    }
  };
  if (it.strokeFirst) { doStroke(); doFill(); } else { doFill(); doStroke(); }
  c.push('Q');
}

function emitImage(c, it, ctx) {
  const n = it.pw * it.ph;
  let smask = '';
  if (it.alpha) {
    const aid = ctx.w.stream(`/Type /XObject /Subtype /Image /Width ${it.pw} /Height ${it.ph} /ColorSpace /DeviceGray /BitsPerComponent 8`, Buffer.from(it.alpha.buffer, it.alpha.byteOffset, n));
    smask = ` /SMask ${aid} 0 R`;
  }
  const id = ctx.w.stream(`/Type /XObject /Subtype /Image /Width ${it.pw} /Height ${it.ph} /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Interpolate true${smask}`, Buffer.from(it.cmyk.buffer, it.cmyk.byteOffset, n * 4));
  ctx.xobjs.push(id);
  c.push('q');
  if ((it.opacity ?? 1) < 1) c.push(gsFor(ctx, it.opacity, it.opacity));
  c.push(it.matrix.map(r).join(' ') + ' cm');
  c.push(`${r(it.w)} 0 0 ${r(-it.h)} ${r(-it.w / 2)} ${r(it.h / 2)} cm`);
  c.push(`/Im${ctx.xobjs.length - 1} Do`);
  c.push('Q');
}

// ---------- EPS ----------
function ascii85(buf) {
  const out = [];
  let line = 0;
  const push = (s) => { for (const ch of s) { out.push(ch); if (++line >= 72) { out.push('\n'); line = 0; } } };
  let i = 0;
  for (; i + 4 <= buf.length; i += 4) {
    const v = ((buf[i] << 24) >>> 0) + (buf[i + 1] << 16) + (buf[i + 2] << 8) + buf[i + 3];
    if (v === 0) { push('z'); continue; }
    let s = ''; let n = v;
    for (let k = 0; k < 5; k++) { s = String.fromCharCode(33 + (n % 85)) + s; n = Math.floor(n / 85); }
    push(s);
  }
  const rem = buf.length - i;
  if (rem > 0) {
    const t = [0, 0, 0, 0];
    for (let k = 0; k < rem; k++) t[k] = buf[i + k];
    let n = ((t[0] << 24) >>> 0) + (t[1] << 16) + (t[2] << 8) + t[3];
    let s = '';
    for (let k = 0; k < 5; k++) { s = String.fromCharCode(33 + (n % 85)) + s; n = Math.floor(n / 85); }
    push(s.slice(0, rem + 1));
  }
  return out.join('') + '~>';
}

export function writeEps(page, opts) {
  const B = opts.includeBleed ? (opts.bleed || 0) : 0;
  const W = page.width + 2 * B; const H = page.height + 2 * B;
  const L = [];
  L.push('%!PS-Adobe-3.0 EPSF-3.0');
  L.push('%%Creator: Vibrant Print Master Pro (Created by Tahamid)');
  L.push('%%Title: ' + (opts.title || 'Untitled').replace(/[^\x20-\x7e]/g, '_'));
  L.push('%%CreationDate: ' + new Date().toISOString());
  L.push(`%%BoundingBox: 0 0 ${Math.ceil(W)} ${Math.ceil(H)}`);
  L.push(`%%HiResBoundingBox: 0 0 ${r(W)} ${r(H)}`);
  L.push('%%DocumentProcessColors: Cyan Magenta Yellow Black');
  L.push('%%LanguageLevel: 2');
  L.push('%%Pages: 1');
  L.push('%%EndComments');
  L.push('%%BeginProlog');
  L.push('/VPMdict 20 dict def VPMdict begin /bd {bind def} bind def end');
  L.push('%%EndProlog');
  L.push('%%BeginSetup');
  L.push('%%EndSetup');
  L.push('%%Page: 1 1');
  L.push('save');
  L.push(`${r(B)} ${r(H - B)} translate 1 -1 scale`);
  for (const it of page.items) {
    if (it.t === 'clipPush') {
      L.push('gsave newpath'); L.push(pathOps(it.subs, true)); L.push(it.rule === 'evenodd' ? 'eoclip newpath' : 'clip newpath');
    } else if (it.t === 'clipPop') L.push('grestore');
    else if (it.t === 'path') epsPath(L, it);
    else if (it.t === 'image') epsImage(L, it);
  }
  L.push('restore');
  L.push('showpage');
  L.push('%%Trailer');
  L.push('%%EOF');
  return Buffer.from(L.join('\n') + '\n', 'latin1');
}

function colorAt(stops, t) {
  const st = [...stops].sort((a, b) => a.o - b.o);
  if (t <= st[0].o) return st[0].cmyk;
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i]; const b = st[i + 1];
    if (t <= b.o) { const k = (t - a.o) / ((b.o - a.o) || 1); return a.cmyk.map((v, j) => v + (b.cmyk[j] - v) * k); }
  }
  return st[st.length - 1].cmyk;
}

// Gradients as vector strips — works in every PostScript reader (no Level 3 shfill)
function epsGradient(L, g) {
  const N = 96;
  if (g.type === 'linear') {
    const dx = g.x2 - g.x1; const dy = g.y2 - g.y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len; const uy = dy / len; const px = -uy; const py = ux;
    const BIG = 1e4;
    const quad = (t0, t1, c) => {
      const ax = g.x1 + ux * t0; const ay = g.y1 + uy * t0; const bx = g.x1 + ux * t1; const by = g.y1 + uy * t1;
      L.push(`${k4(c)} setcmykcolor newpath ${r(ax + px * BIG)} ${r(ay + py * BIG)} moveto ${r(bx + px * BIG)} ${r(by + py * BIG)} lineto ${r(bx - px * BIG)} ${r(by - py * BIG)} lineto ${r(ax - px * BIG)} ${r(ay - py * BIG)} lineto closepath fill`);
    };
    quad(-BIG, 0, colorAt(g.stops, 0));
    for (let i = 0; i < N; i++) quad((len * i) / N - 0.05, (len * (i + 1)) / N + 0.05, colorAt(g.stops, (i + 0.5) / N));
    quad(len, len + BIG, colorAt(g.stops, 1));
  } else {
    L.push(`${k4(colorAt(g.stops, 1))} setcmykcolor newpath -10000 -10000 moveto 10000 -10000 lineto 10000 10000 lineto -10000 10000 lineto closepath fill`);
    for (let i = N; i >= 1; i--) {
      const rr = (g.r * i) / N;
      L.push(`${k4(colorAt(g.stops, (i - 0.5) / N))} setcmykcolor newpath ${r(g.cx + rr)} ${r(g.cy)} moveto ${r(g.cx)} ${r(g.cy)} ${r(rr)} 0 360 arc closepath fill`);
    }
  }
}

function runLength(buf) {
  const out = []; let i = 0; const n = buf.length;
  while (i < n) {
    let j = i + 1;
    while (j < n && j - i < 128 && buf[j] === buf[i]) j++;
    if (j - i >= 3) { out.push(257 - (j - i), buf[i]); i = j; continue; }
    j = i; const start = i;
    while (j < n && j - start < 128) {
      if (j + 2 < n && buf[j] === buf[j + 1] && buf[j] === buf[j + 2]) break;
      j++;
    }
    out.push(j - start - 1);
    for (let k = start; k < j; k++) out.push(buf[k]);
    i = j;
  }
  out.push(128);
  return Buffer.from(out);
}

function epsPath(L, it) {
  const fill = it.fill; const st = it.stroke && it.stroke.width > 0 ? it.stroke : null;
  if (!fill && !st) return;
  const geo = 'newpath\n' + pathOps(it.subs, true);
  const ev = it.rule === 'evenodd';
  const doFill = () => {
    if (!fill) return;
    if (fill.type === 'solid') { L.push('gsave'); L.push(`${k4(fill.cmyk)} setcmykcolor`); L.push(geo); L.push(ev ? 'eofill' : 'fill'); L.push('grestore'); }
    else {
      L.push('gsave'); L.push(geo); L.push(ev ? 'eoclip' : 'clip'); L.push('newpath');
      if (fill.matrix) L.push('[' + fill.matrix.map(r).join(' ') + '] concat');
      epsGradient(L, fill);
      L.push('grestore');
    }
  };
  const doStroke = () => {
    if (!st) return;
    const col = st.paint.type === 'solid' ? st.paint.cmyk : st.paint.stops[0].cmyk;
    L.push('gsave');
    L.push(`${k4(col)} setcmykcolor ${r(st.width)} setlinewidth ${CAP[st.cap] ?? 0} setlinecap ${JOIN[st.join] ?? 0} setlinejoin ${r(st.miter || 4)} setmiterlimit`);
    L.push(st.dash && st.dash.length ? `[${st.dash.map(r).join(' ')}] 0 setdash` : '[] 0 setdash');
    L.push(geo); L.push('stroke'); L.push('grestore');
  };
  if (it.strokeFirst) { doStroke(); doFill(); } else { doFill(); doStroke(); }
}

function epsImage(L, it) {
  const n = it.pw * it.ph;
  const cm = Buffer.from(it.cmyk.buffer, it.cmyk.byteOffset, n * 4);
  L.push('gsave');
  L.push('[' + it.matrix.map(r).join(' ') + '] concat');
  L.push(`${r(-it.w / 2)} ${r(-it.h / 2)} translate ${r(it.w)} ${r(it.h)} scale`);
  L.push('/DeviceCMYK setcolorspace');
  L.push(`<< /ImageType 1 /Width ${it.pw} /Height ${it.ph} /BitsPerComponent 8 /Decode [0 1 0 1 0 1 0 1] /ImageMatrix [${it.pw} 0 0 ${it.ph} 0 0] /DataSource currentfile /ASCII85Decode filter /RunLengthDecode filter >> image`);
  L.push(ascii85(runLength(cm)));
  L.push('grestore');
}

export function writeFileSafe(file, buf) {
  const tmp = file + '.tmp-vpm';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}
