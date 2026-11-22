// Font discovery (main process). Uses fontkit only to read names; shaping is done by HarfBuzz.
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as fontkit from 'fontkit';
import * as hb from 'harfbuzzjs';

const home = os.homedir();
const FONT_DIRS = [
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  '/Library/Fonts',
  path.join(home, 'Library/Fonts'),
  path.join(home, 'Library/Application Support/Adobe/CoreSync/plugins/livetype/.r'),
  '/usr/share/fonts',
  path.join(home, '.fonts'),
  path.join(home, '.local/share/fonts'),
];

let fonts = null; // [{ id, family, style, postscript, weight, italic, file, index }]

function walk(dir, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) walk(p, depth - 1, out); }
    else if (/\.(ttf|otf|ttc|otc)$/i.test(e.name) || /livetype/.test(dir)) out.push(p);
  }
}

function describe(f, file, index) {
  const family = f.getName ? (f.getName('preferredFamily') || f.familyName) : f.familyName;
  const style = (f.getName ? (f.getName('preferredSubfamily') || f.subfamilyName) : f.subfamilyName) || 'Regular';
  const os2 = f['OS/2'];
  return {
    family: String(family || f.postscriptName || path.basename(file)),
    style: String(style),
    postscript: String(f.postscriptName || ''),
    fullName: String(f.fullName || ''),
    weight: os2 ? os2.usWeightClass : 400,
    italic: /italic|oblique/i.test(style) || (os2 ? !!(os2.fsSelection && os2.fsSelection.italic) : false),
    file, index,
  };
}

let scanning = null;
export function scanFonts(cacheFile) {
  if (fonts) return Promise.resolve(fonts);
  if (!scanning) scanning = doScan(cacheFile);
  return scanning;
}
async function doScan(cacheFile) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* none */ }
  const files = [];
  for (const d of FONT_DIRS) walk(d, 3, files);
  const result = [];
  const newCache = {};
  let n = 0;
  for (const file of files) {
    if (++n % 15 === 0) await new Promise((r) => setImmediate(r));
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const key = file + '|' + st.mtimeMs + '|' + st.size;
    let entries = cache[key];
    if (!entries) {
      entries = [];
      try {
        const f = fontkit.openSync(file);
        if (f.fonts) f.fonts.forEach((sub, i) => { try { entries.push(describe(sub, file, i)); } catch { /* skip */ } });
        else entries.push(describe(f, file, 0));
      } catch { entries = []; }
    }
    newCache[key] = entries;
    result.push(...entries);
  }
  try { fs.writeFileSync(cacheFile, JSON.stringify(newCache)); } catch { /* ignore */ }
  const seen = new Set();
  fonts = [];
  for (const r of result) {
    if (!r.family || r.family.startsWith('.')) continue;
    const id = r.postscript || (r.family + '-' + r.style);
    if (seen.has(id)) continue;
    seen.add(id);
    fonts.push({ id, ...r });
  }
  fonts.sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || (a.italic - b.italic));
  return fonts;
}

export function findFont(id) {
  return (fonts || []).find((f) => f.id === id) || null;
}

// ---------- HarfBuzz shaping -> outlines ----------
const hbFonts = new Map();
function getHb(fontId) {
  if (hbFonts.has(fontId)) return hbFonts.get(fontId);
  const meta = findFont(fontId);
  if (!meta) throw new Error('Font not found: ' + fontId);
  const blob = new hb.Blob(fs.readFileSync(meta.file));
  const face = new hb.Face(blob, meta.index || 0);
  const font = new hb.Font(face);
  const entry = { face, font, upem: face.upem, glyphCache: new Map() };
  hbFonts.set(fontId, entry);
  return entry;
}

function glyphCommands(entry, gid) {
  if (!entry.glyphCache.has(gid)) entry.glyphCache.set(gid, entry.font.glyphToJson(gid));
  return entry.glyphCache.get(gid);
}

const BN = /[\u0980-\u09FF\u200C\u200D\u0964\u0965]/;
const covers = new Map();
export function coversBengali(fontId) {
  if (covers.has(fontId)) return covers.get(fontId);
  let ok = false;
  try {
    const e = getHb(fontId);
    const buf = new hb.Buffer(); buf.addText('\u0995\u09BE'); buf.guessSegmentProperties(); hb.shape(e.font, buf);
    ok = buf.getGlyphInfos().every((g) => g.codepoint !== 0);
  } catch { ok = false; }
  covers.set(fontId, ok);
  return ok;
}

const BN_PREF = ['SolaimanLipi', 'Kalpurush', 'Nikosh', 'Hind Siliguri', 'Noto Sans Bengali', 'Noto Serif Bengali', 'Bangla Sangam MN', 'Bangla MN', 'Shonar Bangla', 'Vrinda', 'Lohit Bengali'];
let bnFallback;
export function bengaliFallback() {
  if (bnFallback !== undefined) return bnFallback;
  bnFallback = null;
  const list = fonts || [];
  const regular = (f) => /^(regular|book|normal|roman)$/i.test(f.style);
  for (const fam of BN_PREF) {
    const cands = list.filter((f) => f.family === fam).sort((a, b) => regular(b) - regular(a));
    const hit = cands.find((f) => coversBengali(f.id));
    if (hit) { bnFallback = hit.id; return bnFallback; }
  }
  const any = list.find((f) => /bangla|bengali|beng/i.test(f.family) && coversBengali(f.id));
  bnFallback = any ? any.id : null;
  return bnFallback;
}

// split a line into runs: Bengali text (with spaces/punctuation between Bengali words) vs everything else
function splitRuns(text) {
  const runs = [];
  let cur = null;
  for (const ch of text) {
    const isBn = BN.test(ch);
    const neutral = /[\s.,;:!?'"()\-–—\d]/.test(ch);
    const kind = isBn ? 'bn' : neutral && cur ? cur.kind : 'x';
    if (!cur || cur.kind !== kind) { cur = { kind, text: '' }; runs.push(cur); }
    cur.text += ch;
  }
  return runs;
}

function shapeRun(fontId, text, size, track, x0, out) {
  const entry = getHb(fontId);
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(entry.font, buf);
  const gl = buf.getGlyphInfosAndPositions();
  const s = size / entry.upem;
  let x = x0;
  let lastCluster = -1;
  for (const g of gl) {
    if (track && g.cluster !== lastCluster && (lastCluster !== -1 || x0 > 0)) x += track;
    lastCluster = g.cluster;
    const gx = x + (g.xOffset || 0) * s; const gy = -(g.yOffset || 0) * s;
    x += (g.xAdvance || 0) * s;
    const cmds = glyphCommands(entry, g.codepoint);
    if (!cmds.length) continue;
    let cur = null; let px = 0; let py = 0;
    const X = (v) => gx + v * s;
    const Y = (v) => gy - v * s;
    for (const c of cmds) {
      const v = c.values;
      if (c.type === 'M') { cur = { pts: [['M', X(v[0]), Y(v[1])]], closed: false }; out.push(cur); px = v[0]; py = v[1]; }
      else if (c.type === 'L') { cur.pts.push(['L', X(v[0]), Y(v[1])]); px = v[0]; py = v[1]; }
      else if (c.type === 'Q') {
        const c1x = px + 2 / 3 * (v[0] - px), c1y = py + 2 / 3 * (v[1] - py);
        const c2x = v[2] + 2 / 3 * (v[0] - v[2]), c2y = v[3] + 2 / 3 * (v[1] - v[3]);
        cur.pts.push(['C', X(c1x), Y(c1y), X(c2x), Y(c2y), X(v[2]), Y(v[3])]); px = v[2]; py = v[3];
      } else if (c.type === 'C') { cur.pts.push(['C', X(v[0]), Y(v[1]), X(v[2]), Y(v[3]), X(v[4]), Y(v[5])]); px = v[4]; py = v[5]; }
      else if (c.type === 'Z') { if (cur) cur.closed = true; }
    }
  }
  return x;
}

// Shape one line of text -> { width, subpaths } (line space: baseline origin, y down).
// Bengali runs automatically use the Bangla fallback font when the chosen font has no Bengali glyphs.
export function shapeLine(fontId, text, size, tracking /* em/1000 */) {
  const track = (tracking || 0) / 1000 * size;
  const out = [];
  let x = 0;
  const primaryBn = coversBengali(fontId);
  for (const run of splitRuns(text)) {
    const fid = run.kind === 'bn' && !primaryBn ? (bengaliFallback() || fontId) : fontId;
    x = shapeRun(fid, run.text, size, track, x, out);
  }
  return { width: x, subpaths: out };
}
