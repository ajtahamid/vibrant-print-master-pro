// Shared helpers: units, colour preview cache, DOM.
export const UNITS = {
  pt: { per: 1, label: 'pt', dp: 2 },
  mm: { per: 72 / 25.4, label: 'mm', dp: 2 },
  cm: { per: 72 / 2.54, label: 'cm', dp: 3 },
  in: { per: 72, label: 'in', dp: 3 },
  ft: { per: 864, label: 'ft', dp: 3 },
  px: { per: 1, label: 'px', dp: 1 },
};
export const toPt = (v, u) => v * UNITS[u].per;
export const fromPt = (v, u) => v / UNITS[u].per;
export const fmt = (v, u) => {
  const d = UNITS[u].dp;
  return String(Math.round(fromPt(v, u) * 10 ** d) / 10 ** d);
};

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- CMYK preview colours (converted with the ICC profile in the main process) ----
const rgbCache = new Map();
let pending = new Map();
let flushTimer = 0;
let onUpdate = () => {};
export function setColorUpdateHandler(fn) { onUpdate = fn; }
export function clearColorCache() { rgbCache.clear(); }

function naive(c) {
  const [C, M, Y, K] = c.map((v) => v / 100);
  return [255 * (1 - C) * (1 - K), 255 * (1 - M) * (1 - K), 255 * (1 - Y) * (1 - K)].map(Math.round);
}
const key = (c) => c.map((v) => Math.round(v * 10) / 10).join(',');

export function cmykCss(c) {
  if (!c) return 'transparent';
  const k = key(c);
  let rgb = rgbCache.get(k);
  if (!rgb) {
    rgb = naive(c);
    if (!pending.has(k)) pending.set(k, c.map((v) => Math.round(v * 10) / 10));
    if (!flushTimer) flushTimer = setTimeout(flush, 0);
  }
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

async function flush() {
  flushTimer = 0;
  const batch = pending;
  pending = new Map();
  if (!batch.size) return;
  const keys = [...batch.keys()];
  const res = await window.vpm.invoke('color:cmyk-to-rgb', [...batch.values()]);
  keys.forEach((k, i) => rgbCache.set(k, res[i]));
  onUpdate();
}

export async function preloadCmyk(list) {
  const need = list.filter((c) => !rgbCache.has(key(c)));
  if (!need.length) return;
  const res = await window.vpm.invoke('color:cmyk-to-rgb', need);
  need.forEach((c, i) => rgbCache.set(key(c), res[i]));
}

export async function rgbToCmyk(list) {
  return window.vpm.invoke('color:rgb-to-cmyk', list);
}

export function parseCssColor(str) {
  if (!str || str === 'none' || str === 'transparent') return null;
  const c = new fabric.Color(str);
  const s = c.getSource();
  if (!s || s[3] === 0) return null;
  return [s[0], s[1], s[2]];
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const deepClone = (o) => JSON.parse(JSON.stringify(o));
export const inkTotal = (c) => (c ? c.reduce((a, b) => a + b, 0) : 0);
