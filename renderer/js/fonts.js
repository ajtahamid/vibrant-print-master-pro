// Font list + on-screen font loading. Each face is registered under a unique alias via local(),
// so the canvas uses exactly the same font file that HarfBuzz outlines on export.
import { state } from './state.js';

const loaded = new Map(); // fontId -> Promise<alias>

export async function loadFontList() {
  state.fonts = await window.vpm.invoke('fonts:list');
  state.fontById = new Map(state.fonts.map((f) => [f.id, f]));
  const pref = ['Helvetica', 'HelveticaNeue', 'ArialMT', 'Arial', 'NotoSans-Regular', 'DejaVuSans', 'NotoSansBengali-Regular'];
  state.defaults.fontId = pref.find((p) => state.fontById.has(p)) || (state.fonts[0] && state.fonts[0].id) || null;
  try { state.bnFallback = (await window.vpm.invoke('fonts:bn')).fallback; } catch { state.bnFallback = null; }
  return state.fonts;
}

export const aliasOf = (id) => 'vpf_' + String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

export function ensureFont(id) {
  if (!id) return Promise.resolve('sans-serif');
  if (loaded.has(id)) return loaded.get(id);
  const meta = state.fontById.get(id);
  const alias = aliasOf(id);
  const p = (async () => {
    if (!meta) return alias;
    const srcs = [meta.postscript, meta.fullName].filter(Boolean).map((n) => `local("${n.replace(/"/g, '')}")`).join(', ');
    try {
      const ff = new FontFace(alias, srcs);
      await ff.load();
      document.fonts.add(ff);
    } catch (e) {
      console.warn('font load failed', id, e);
    }
    return alias;
  })();
  loaded.set(id, p);
  return p;
}

// CSS font stack: chosen face first, then the Bangla fallback (the same font the exporter uses for Bengali runs)
export async function fontStack(id) {
  const a = await ensureFont(id);
  const fb = state.bnFallback;
  if (!fb || fb === id) return `"${a}"`;
  const b = await ensureFont(fb);
  return `"${a}", "${b}"`;
}

export function familiesList() {
  const fam = new Map();
  for (const f of state.fonts) {
    if (!fam.has(f.family)) fam.set(f.family, []);
    fam.get(f.family).push(f);
  }
  return fam;
}

// make sure every text object in the canvas has its font loaded, then re-measure
export async function ensureCanvasFonts(objs) {
  const texts = [];
  const walk = (list) => list.forEach((o) => { if (o.type === 'group') walk(o.getObjects()); else if (['text', 'i-text', 'textbox'].includes(o.type)) texts.push(o); });
  walk(objs);
  await Promise.all(texts.map(async (t) => {
    if (!t.fontId || !state.fontById.has(t.fontId)) t.fontId = state.defaults.fontId;
    const alias = await fontStack(t.fontId);
    t.set({ fontFamily: alias, fontWeight: 'normal', fontStyle: 'normal' });
    t.initDimensions && t.initDimensions();
    t.setCoords();
    t.dirty = true;
  }));
  return texts.length;
}
