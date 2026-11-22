// Rulers (in document units, origin = artboard top-left). Drag from a ruler to create a guide.
import { state } from './state.js';
import { $, UNITS } from './util.js';
import { startGuideDrag } from './tools.js';

const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

function prep(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.fillStyle = '#1f2023'; ctx.fillRect(0, 0, r.width, r.height);
  return { ctx, w: r.width, h: r.height };
}

export function drawRulers() {
  if (!state.canvas || !state.doc || !state.showRulers) return;
  const v = state.canvas.viewportTransform;
  const z = v[0];
  const per = UNITS[state.doc.units].per; // pt per unit
  const pxPerUnit = per * z;
  let step = NICE.find((n) => n * pxPerUnit >= 50) || 5000;
  if (state.doc.units === 'in' || state.doc.units === 'ft') step = [0.125, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].find((n) => n * pxPerUnit >= 50) || 100;
  if (state.doc.units === 'cm') step = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100].find((n) => n * pxPerUnit >= 50) || 100;
  const sub = step / (state.doc.units === 'in' ? 8 : 10);
  for (const axis of ['h', 'v']) {
    const cv = $('#ruler-' + axis);
    const { ctx, w, h } = prep(cv);
    const len = axis === 'h' ? w : h;
    const off = axis === 'h' ? v[4] : v[5];
    ctx.strokeStyle = '#6c7078'; ctx.fillStyle = '#9a9ea6'; ctx.lineWidth = 1;
    ctx.font = '9px -apple-system, "Segoe UI", sans-serif';
    const u0 = (-off) / pxPerUnit; const u1 = (len - off) / pxPerUnit;
    const s0 = Math.floor(u0 / sub) * sub;
    ctx.beginPath();
    for (let u = s0; u <= u1; u += sub) {
      const p = Math.round(off + u * pxPerUnit) + 0.5;
      const major = Math.abs(u / step - Math.round(u / step)) < 1e-6;
      const half = !major && Math.abs((u / step) * 2 - Math.round((u / step) * 2)) < 1e-6;
      const t = major ? 20 : half ? 7 : 4;
      if (axis === 'h') { ctx.moveTo(p, 20); ctx.lineTo(p, 20 - t); } else { ctx.moveTo(20, p); ctx.lineTo(20 - t, p); }
      if (major) {
        const label = String(Math.round(u * 1000) / 1000);
        if (axis === 'h') ctx.fillText(label, p + 3, 9);
        else { ctx.save(); ctx.translate(9, p + 3); ctx.rotate(-Math.PI / 2); ctx.fillText(label, 0, 0); ctx.restore(); }
      }
    }
    ctx.stroke();
  }
  const { ctx } = prep($('#ruler-corner'));
  ctx.fillStyle = '#6c7078'; ctx.font = '8px sans-serif'; ctx.fillText(state.doc.units, 3, 13);
}

export function initRulers() {
  $('#ruler-h').addEventListener('mousedown', (e) => { e.preventDefault(); startGuideDrag('h'); });
  $('#ruler-v').addEventListener('mousedown', (e) => { e.preventDefault(); startGuideDrag('v'); });
  drawRulers();
}
