// Colour management (LittleCMS via WASM) — runs in the main process.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  instantiate, TYPE_RGB_8, TYPE_CMYK_8, INTENT_RELATIVE_COLORIMETRIC,
  INTENT_PERCEPTUAL, cmsFLAGS_BLACKPOINTCOMPENSATION, cmsInfoDescription,
} from 'lcms-wasm';

let lcms = null;
let srgb = 0;
let current = null; // { path, name, bytes, handle, toCmyk, toRgb }
const rgbCache = new Map();

export async function initColor() {
  if (!lcms) {
    lcms = await instantiate();
    srgb = lcms.cmsCreate_sRGBProfile();
  }
}

function profileDirs(appDir) {
  const home = os.homedir();
  return [
    '/Library/Application Support/Adobe/Color/Profiles/Recommended',
    '/Library/Application Support/Adobe/Color/Profiles',
    '/Library/ColorSync/Profiles',
    path.join(home, 'Library/ColorSync/Profiles'),
    '/System/Library/ColorSync/Profiles',
    '/usr/share/color/icc',
    path.join(appDir, 'assets', 'profiles'),
  ];
}

function walk(dir, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out);
    else if (/\.(icc|icm)$/i.test(e.name)) out.push(p);
  }
}

// Returns every CMYK output profile found on this computer.
export async function listCmykProfiles(appDir) {
  await initColor();
  const files = [];
  for (const d of profileDirs(appDir)) walk(d, 2, files);
  const seen = new Set();
  const out = [];
  for (const f of files) {
    try {
      const bytes = new Uint8Array(fs.readFileSync(f));
      const h = lcms.cmsOpenProfileFromMem(bytes, bytes.byteLength);
      if (!h) continue;
      const space = lcms.cmsGetColorSpaceASCII(h);
      const name = (lcms.cmsGetProfileInfoASCII(h, cmsInfoDescription, 'en', 'US') || path.basename(f)).trim();
      lcms.cmsCloseProfile(h);
      if (!/CMYK/i.test(space) || seen.has(name)) continue;
      seen.add(name);
      out.push({ path: f, name });
    } catch { /* unreadable profile */ }
  }
  out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return out;
}

function rank(n) {
  if (/fogra39/i.test(n)) return 0;
  if (/fogra51|psocoated|iso coated/i.test(n)) return 1;
  if (/swop/i.test(n)) return 2;
  if (/japan color/i.test(n)) return 3;
  if (/generic cmyk/i.test(n)) return 4;
  return 5;
}

export async function setProfile(file) {
  await initColor();
  if (current && current.path === file) return current.name;
  const bytes = new Uint8Array(fs.readFileSync(file));
  const h = lcms.cmsOpenProfileFromMem(bytes, bytes.byteLength);
  if (!h) throw new Error('Cannot open ICC profile: ' + file);
  const name = (lcms.cmsGetProfileInfoASCII(h, cmsInfoDescription, 'en', 'US') || path.basename(file)).trim();
  const flags = cmsFLAGS_BLACKPOINTCOMPENSATION;
  const toCmyk = lcms.cmsCreateTransform(srgb, TYPE_RGB_8, h, TYPE_CMYK_8, INTENT_PERCEPTUAL, flags);
  const toCmykRel = lcms.cmsCreateTransform(srgb, TYPE_RGB_8, h, TYPE_CMYK_8, INTENT_RELATIVE_COLORIMETRIC, flags);
  const toRgb = lcms.cmsCreateTransform(h, TYPE_CMYK_8, srgb, TYPE_RGB_8, INTENT_RELATIVE_COLORIMETRIC, flags);
  if (current) {
    try {
      lcms.cmsDeleteTransform(current.toCmyk); lcms.cmsDeleteTransform(current.toCmykRel);
      lcms.cmsDeleteTransform(current.toRgb); lcms.cmsCloseProfile(current.handle);
    } catch { /* ignore */ }
  }
  current = { path: file, name, bytes: Buffer.from(bytes), handle: h, toCmyk, toCmykRel, toRgb };
  rgbCache.clear();
  return name;
}

export function profileInfo() {
  return current ? { path: current.path, name: current.name } : null;
}
export function profileBytes() { return current ? current.bytes : null; }

// cmyk values are 0..100 percentages. Returns [r,g,b] 0..255 for screen preview.
export function cmykToRgb(list) {
  const out = [];
  const need = [];
  for (const c of list) {
    const key = c.join(',');
    if (rgbCache.has(key)) out.push(rgbCache.get(key));
    else { out.push(null); need.push(c); }
  }
  if (need.length) {
    const inp = new Uint8Array(need.length * 4);
    need.forEach((c, i) => c.forEach((v, j) => { inp[i * 4 + j] = Math.round(Math.max(0, Math.min(100, v)) * 2.55); }));
    const res = lcms.cmsDoTransform(current.toRgb, inp, need.length);
    let k = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i]) continue;
      const rgb = [res[k * 3], res[k * 3 + 1], res[k * 3 + 2]];
      rgbCache.set(need[k].join(','), rgb);
      out[i] = rgb; k++;
    }
  }
  return out;
}

// rgb 0..255 -> cmyk 0..100 (relative colorimetric — used for colour pickers / SVG import)
export function rgbToCmyk(list) {
  const inp = new Uint8Array(list.length * 3);
  list.forEach((c, i) => { inp[i * 3] = c[0]; inp[i * 3 + 1] = c[1]; inp[i * 3 + 2] = c[2]; });
  const res = lcms.cmsDoTransform(current.toCmykRel, inp, list.length);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const c = [0, 1, 2, 3].map((j) => Math.round(res[i * 4 + j] / 2.55));
    // keep pure greys/black clean: neutral rgb -> K only (Illustrator-like "pure black")
    const [r, g, b] = list[i];
    if (r === g && g === b) { out.push([0, 0, 0, Math.round((255 - r) / 2.55)]); continue; }
    out.push(c);
  }
  return out;
}

// RGBA pixel buffer -> { cmyk: Uint8Array (4ch), alpha: Uint8Array|null }
// Transparent pixels are composited on white for the colour channels (alpha kept separately).
export function imageToCmyk(rgba, width, height, composite = false) {
  const n = width * height;
  const cmyk = new Uint8Array(n * 4);
  let hasAlpha = false;
  const alpha = new Uint8Array(n);
  const CH = 1 << 20;
  for (let start = 0; start < n; start += CH) {
    const cnt = Math.min(CH, n - start);
    const rgb = new Uint8Array(cnt * 3);
    for (let i = 0; i < cnt; i++) {
      const s = (start + i) * 4;
      const a = rgba[s + 3];
      alpha[start + i] = a;
      if (a !== 255) hasAlpha = true;
      // un-premultiply against white
      const f = composite ? a / 255 : 1;
      rgb[i * 3] = Math.round(rgba[s] * f + 255 * (1 - f));
      rgb[i * 3 + 1] = Math.round(rgba[s + 1] * f + 255 * (1 - f));
      rgb[i * 3 + 2] = Math.round(rgba[s + 2] * f + 255 * (1 - f));
    }
    const res = lcms.cmsDoTransform(current.toCmyk, rgb, cnt);
    cmyk.set(res, start * 4);
  }
  return { cmyk, alpha: hasAlpha ? alpha : null };
}
