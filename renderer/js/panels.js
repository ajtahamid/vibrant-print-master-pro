// Right-hand panels: Properties, Colour, Swatches, Stroke, Character, Align, Pathfinder, Layers, Document.
import { state, on, emit, markDirty } from './state.js';
import { $, h, fmt, toPt, fromPt, UNITS, cmykCss, inkTotal, clamp, toast, rgbToCmyk, preloadCmyk } from './util.js';
import { applyPaint, paintCss, clonePaint, isPaintable, SWATCHES, solid } from './paint.js';
import { familiesList, fontStack } from './fonts.js';
import { isText } from './geometry.js';
import { commit, run, setLocked, selectObjects } from './app.js';
import { regenPolygon } from './tools.js';
import { pathfinder } from './pathfinder.js';

let canvas;
const panels = {};
const collapsed = new Set(JSON.parse(localStorage.getItem('vpm.collapsed') || '["pathfinder"]'));

function panel(id, title) {
  const body = h('div', { class: 'pbody' });
  const el = h('section', { class: 'panel' + (collapsed.has(id) ? ' collapsed' : '') },
    h('h3', { onclick: () => { el.classList.toggle('collapsed'); if (el.classList.contains('collapsed')) collapsed.add(id); else collapsed.delete(id); localStorage.setItem('vpm.collapsed', JSON.stringify([...collapsed])); } }, title),
    body);
  panels[id] = { el, body };
  $('#panels').append(el);
  return body;
}

const sel = () => canvas.getActiveObjects();
const paintTargets = () => {
  const out = [];
  const walk = (o) => { if (o.type === 'group') { if (!o.clipPath) o.getObjects().forEach(walk); else o.getObjects().forEach(walk); } else if (isPaintable(o)) out.push(o); };
  sel().forEach(walk);
  return out;
};

function numField(label, value, onchange, opts = {}) {
  const inp = h('input', { type: 'text', value, spellcheck: 'false' });
  const commitVal = () => {
    let v = inp.value.trim();
    try { v = Function('"use strict";return (' + v.replace(/[^0-9+\-*/(). ]/g, '') + ')')(); } catch { v = parseFloat(v); }
    if (Number.isFinite(v)) onchange(v);
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commitVal(); inp.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const v = (parseFloat(inp.value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : (opts.step || 1));
      inp.value = Math.round(v * 1000) / 1000; onchange(v);
    }
  });
  inp.addEventListener('change', commitVal);
  return h('label', { class: 'field', title: opts.title || '' }, h('span', {}, label), inp, opts.unit ? h('em', {}, opts.unit) : null);
}

function bounds(objs) {
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const o of objs) { const b = o.getBoundingRect(); x1 = Math.min(x1, b.left); y1 = Math.min(y1, b.top); x2 = Math.max(x2, b.left + b.width); y2 = Math.max(y2, b.top + b.height); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ---------- Properties ----------
function renderProps() {
  const b = panels.props.body; b.innerHTML = '';
  const a = canvas.getActiveObject();
  const u = state.doc.units;
  if (!a) {
    const d = state.doc;
    b.append(
      h('div', { class: 'muted' }, 'Artboard'),
      h('div', { class: 'grid2' },
        numField('W', fmt(d.width, u), (v) => { d.width = toPt(v, u); markDirty(); canvas.requestRenderAll(); emit('doc'); }, { unit: u }),
        numField('H', fmt(d.height, u), (v) => { d.height = toPt(v, u); markDirty(); canvas.requestRenderAll(); emit('doc'); }, { unit: u })),
      h('div', { class: 'grid2' },
        numField('Bleed', fmt(d.bleed, u), (v) => { d.bleed = Math.max(0, toPt(v, u)); markDirty(); canvas.requestRenderAll(); }, { unit: u }),
        numField('Safe', fmt(d.safe, u), (v) => { d.safe = Math.max(0, toPt(v, u)); markDirty(); canvas.requestRenderAll(); }, { unit: u })),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Units'),
        h('select', { onchange: (e) => { d.units = e.target.value; markDirty(); refreshPanels(); emit('doc'); } },
          ...Object.keys(UNITS).map((k) => h('option', { value: k, selected: k === u }, UNITS[k].label)))),
      h('button', { class: 'btn', onclick: () => run('doc-setup') }, 'Document Setup…'),
    );
    return;
  }
  const objs = sel();
  const bb = bounds(objs);
  const apply = (fn) => { fn(a); a.setCoords(); canvas.requestRenderAll(); canvas.fire('object:modified', { target: a }); renderProps(); };
  b.append(
    h('div', { class: 'grid2' },
      numField('X', fmt(bb.x, u), (v) => apply((o) => { o.left += toPt(v, u) - bb.x; }), { unit: u }),
      numField('Y', fmt(bb.y, u), (v) => apply((o) => { o.top += toPt(v, u) - bb.y; }), { unit: u }),
      numField('W', fmt(bb.w, u), (v) => apply((o) => { const k = toPt(v, u) / bb.w; if (k > 0 && Number.isFinite(k)) { const c = o.getCenterPoint(); o.scaleX *= k; if (lockRatio) o.scaleY *= k; o.setPositionByOrigin(c, 'center', 'center'); o.left += (bb.x - o.getBoundingRect().left); o.top += (bb.y - o.getBoundingRect().top); } }), { unit: u }),
      numField('H', fmt(bb.h, u), (v) => apply((o) => { const k = toPt(v, u) / bb.h; if (k > 0 && Number.isFinite(k)) { const c = o.getCenterPoint(); o.scaleY *= k; if (lockRatio) o.scaleX *= k; o.setPositionByOrigin(c, 'center', 'center'); o.left += (bb.x - o.getBoundingRect().left); o.top += (bb.y - o.getBoundingRect().top); } }), { unit: u }),
    ),
    h('div', { class: 'grid2' },
      numField('∠', Math.round((a.angle || 0) * 100) / 100, (v) => apply((o) => { o.rotate(((v % 360) + 360) % 360); }), { unit: '°', title: 'Rotation' }),
      h('div', { class: 'row' },
        h('button', { class: 'ibtn' + (lockRatio ? ' on' : ''), title: 'Constrain W/H proportions', onclick: () => { lockRatio = !lockRatio; renderProps(); } }, lockRatio ? '🔗' : '⛓︎'),
        h('button', { class: 'ibtn', title: 'Flip horizontal', onclick: () => run('flip-h') }, '⇋'),
        h('button', { class: 'ibtn', title: 'Flip vertical', onclick: () => run('flip-v') }, '⇵'))),
  );
  if (objs.length === 1 && a.type === 'rect') {
    b.append(numField('Corner', fmt(a.rx || 0, u), (v) => apply((o) => { const r = Math.max(0, toPt(v, u) / ((o.scaleX + o.scaleY) / 2)); o.set({ rx: r, ry: r }); }), { unit: u, title: 'Corner radius' }));
  }
  if (objs.length === 1 && a.type === 'polygon' && a.vpPolySides) {
    b.append(numField(a.vpStar ? 'Points' : 'Sides', a.vpPolySides, (v) => apply((o) => regenPolygon(o, clamp(Math.round(v), 3, 60)))));
  }
  if (objs.length === 1 && a.type === 'image') {
    const el = a.getElement();
    const ppiX = (el.naturalWidth || a.width) / (a.getScaledWidth() / 72);
    const ppi = Math.round(ppiX);
    b.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Effective resolution:'), h('b', { style: { color: ppi < 250 ? 'var(--danger)' : 'var(--ok)' } }, ppi + ' ppi')),
      h('div', { class: 'muted' }, `${el.naturalWidth} × ${el.naturalHeight} px · embedded · converted to CMYK on export`));
  }
  if (objs.length === 1) {
    b.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Name'),
      h('input', { type: 'text', value: a.name || '', onchange: (e) => { a.name = e.target.value; commit(); renderLayers(); } })));
  }
}
let lockRatio = true;

// ---------- Colour ----------
let selStop = 0;
function currentPaint() {
  const t = paintTargets();
  const key = state.activePaint === 'fill' ? 'vpFill' : 'vpStroke';
  if (t.length) return { paint: t[0][key], targets: t, key };
  return { paint: state.defaults[state.activePaint], targets: [], key };
}
function setPaint(p, live) {
  const { targets, key } = currentPaint();
  if (targets.length) {
    for (const o of targets) {
      o[key] = clonePaint(p);
      if (key === 'vpStroke' && p && !(o.strokeWidth > 0)) o.strokeWidth = 1;
      applyPaint(o);
    }
    canvas.requestRenderAll();
    commit(!live);
  } else {
    state.defaults[state.activePaint] = clonePaint(p);
  }
  renderFillStroke();
}

function renderColor() {
  const b = panels.color.body; b.innerHTML = '';
  const { paint, targets } = currentPaint();
  const t = targets[0];
  const fillP = t ? t.vpFill : state.defaults.fill;
  const strokeP = t ? t.vpStroke : state.defaults.stroke;
  const chip = (p, which) => h('div', {
    class: 'pchip' + (p ? '' : ' none') + (state.activePaint === which ? ' active' : ''),
    style: p ? { background: paintCss(p) } : {}, title: which === 'fill' ? 'Fill' : 'Stroke',
    onclick: () => { state.activePaint = which; renderColor(); renderFillStroke(); },
  });
  b.append(h('div', { class: 'paintrow' },
    h('span', { class: 'lbl' }, 'Fill'), chip(fillP, 'fill'),
    h('span', { class: 'lbl' }, 'Stroke'), chip(strokeP, 'stroke'),
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted' }, targets.length ? (targets.length > 1 ? targets.length + ' objects' : '') : 'New objects')));
  const type = paint ? paint.type : 'none';
  const seg = h('div', { class: 'seg' }, ...[['none', 'None'], ['solid', 'Solid'], ['lin', 'Linear'], ['rad', 'Radial']].map(([k, l]) => h('button', {
    class: type === k ? 'on' : '',
    onclick: () => {
      if (k === 'none') return setPaint(null);
      const base = paint ? (paint.type === 'solid' ? paint.cmyk : paint.stops[0].cmyk) : [0, 0, 0, 100];
      if (k === 'solid') return setPaint(solid(paint && paint.type !== 'solid' ? paint.stops[selStop]?.cmyk || base : base));
      const stops = paint && paint.stops ? paint.stops : [{ o: 0, cmyk: [...base] }, { o: 1, cmyk: [0, 0, 0, 0] }];
      selStop = 0;
      setPaint({ type: k, angle: paint && paint.angle != null ? paint.angle : 0, stops });
    },
  }, l)));
  b.append(seg);
  if (!paint) { renderColor.after && renderColor.after(); return; }
  let cm;
  if (paint.type === 'solid') cm = paint.cmyk;
  else {
    selStop = clamp(selStop, 0, paint.stops.length - 1);
    cm = paint.stops[selStop].cmyk;
    b.append(gradientEditor(paint));
  }
  const update = (newCm, live) => {
    const p = clonePaint(paint);
    if (p.type === 'solid') p.cmyk = newCm; else p.stops[selStop].cmyk = newCm;
    setPaint(p, live);
    if (!live) renderColor(); else updateSliders(newCm);
  };
  const rows = [];
  const names = ['C', 'M', 'Y', 'K'];
  const colors = [[100, 0, 0, 0], [0, 100, 0, 0], [0, 0, 100, 0], [0, 0, 0, 100]];
  names.forEach((n, i) => {
    const range = h('input', { type: 'range', min: 0, max: 100, step: 1, value: cm[i] });
    const num = h('input', { type: 'number', min: 0, max: 100, value: Math.round(cm[i] * 10) / 10 });
    range.addEventListener('input', () => { const c = [...curCm]; c[i] = +range.value; curCm = c; num.value = range.value; update(c, true); });
    range.addEventListener('change', () => { commit(true); renderColor(); });
    num.addEventListener('change', () => { const c = [...curCm]; c[i] = clamp(+num.value || 0, 0, 100); curCm = c; update(c, false); });
    rows.push({ range, num, i, base: colors[i] });
    b.append(h('div', { class: 'cmyk-row' }, h('b', {}, n), range, h('label', { class: 'field' }, num, h('em', {}, '%'))));
  });
  let curCm = [...cm];
  const ink = h('div', { class: 'ink' });
  const updateSliders = (c) => {
    rows.forEach((r) => {
      const lo = [...c]; lo[r.i] = 0; const hi = [...c]; hi[r.i] = 100;
      r.range.style.background = `linear-gradient(90deg, ${cmykCss(lo)}, ${cmykCss(hi)})`;
    });
    const tot = inkTotal(c);
    ink.className = 'ink' + (tot > 300 ? ' bad' : '');
    ink.textContent = `Total ink ${Math.round(tot)}%` + (tot > 300 ? ' — too high for most presses (max 300%)' : '');
  };
  updateSliders(cm);
  const hex = h('input', { type: 'text', placeholder: '#RRGGBB', title: 'Type a HEX/RGB colour — it is converted to CMYK with your ICC profile', style: { width: '90px' } });
  hex.addEventListener('change', async () => {
    const m = hex.value.trim().replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(m) && !/^[0-9a-f]{3}$/i.test(m)) { toast('Use HEX like #FF6A2B'); return; }
    const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
    const rgb = [0, 2, 4].map((k) => parseInt(full.slice(k, k + 2), 16));
    const [c] = await rgbToCmyk([rgb]);
    await preloadCmyk([c]);
    update(c, false);
    toast(`#${full.toUpperCase()} → C${c[0]} M${c[1]} Y${c[2]} K${c[3]}`);
  });
  b.append(h('div', { class: 'row' }, ink, h('span', { class: 'spacer' }), hex));
  if (state.activePaint === 'fill' && paint.type === 'solid' && targets.some(isText) && cm[3] >= 90 && (cm[0] + cm[1] + cm[2]) > 0) {
    b.append(h('div', { class: 'muted', style: { color: 'var(--warn)' } }, 'Tip: small black text prints sharper as pure K100 (C0 M0 Y0).'));
  }
  b.append(h('div', { class: 'row' },
    h('button', { class: 'btn', onclick: () => { state.doc.swatches.push(clonePaint(paint.type === 'solid' ? paint : solid(cm))); markDirty(); renderSwatches(); } }, '+ Add to swatches'),
    targets.length ? h('button', { class: 'btn', onclick: () => { state.defaults.fill = clonePaint(t.vpFill); state.defaults.stroke = clonePaint(t.vpStroke); toast('Set as default for new objects'); } }, 'Use as default') : null));
  // opacity
  if (targets.length || sel().length) {
    const a = canvas.getActiveObject();
    const objs = sel();
    b.append(numField('Opacity', Math.round((objs[0].opacity ?? 1) * 100), (v) => {
      objs.forEach((o) => o.set({ opacity: clamp(v, 0, 100) / 100 }));
      canvas.requestRenderAll(); commit(true);
    }, { unit: '%' }));
    if (a && (a.type === 'path' || a.type === 'group')) {
      // nothing extra
    }
  }
}

function gradientEditor(p) {
  const wrap = h('div', {});
  const bar = h('div', { class: 'gradbar', style: { background: paintCss({ ...p, type: 'lin', angle: 0 }) }, title: 'Click to add a colour stop' });
  const sorted = p.stops;
  sorted.forEach((s, i) => {
    const st = h('div', { class: 'gstop' + (i === selStop ? ' sel' : ''), style: { left: s.o * 100 + '%', background: cmykCss(s.cmyk) } });
    st.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      selStop = i;
      const r = bar.getBoundingClientRect();
      const mv = (ev) => {
        const q = clonePaint(p);
        q.stops[i].o = clamp((ev.clientX - r.left) / r.width, 0, 1);
        st.style.left = q.stops[i].o * 100 + '%';
        p.stops[i].o = q.stops[i].o;
        setPaint(q, true);
      };
      const upf = (ev) => {
        window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', upf);
        if (ev.clientY - r.bottom > 30 && p.stops.length > 2) { const q = clonePaint(p); q.stops.splice(i, 1); selStop = 0; setPaint(q); }
        commit(true); renderColor();
      };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', upf);
    });
    bar.append(st);
  });
  bar.addEventListener('mousedown', (e) => {
    const r = bar.getBoundingClientRect();
    const o = clamp((e.clientX - r.left) / r.width, 0, 1);
    const q = clonePaint(p);
    q.stops.push({ o, cmyk: [...p.stops[selStop].cmyk] });
    selStop = q.stops.length - 1;
    setPaint(q); renderColor();
  });
  wrap.append(bar);
  const row = h('div', { class: 'grid2' });
  if (p.type === 'lin') row.append(numField('∠', p.angle || 0, (v) => { const q = clonePaint(p); q.angle = v; setPaint(q); renderColor(); }, { unit: '°', title: 'Gradient angle' }));
  row.append(numField('Stop', Math.round(p.stops[selStop].o * 100), (v) => { const q = clonePaint(p); q.stops[selStop].o = clamp(v, 0, 100) / 100; setPaint(q); renderColor(); }, { unit: '%', title: 'Selected stop position' }));
  wrap.append(row, h('div', { class: 'muted' }, 'Drag a stop down to remove it.'));
  return wrap;
}

// ---------- Swatches ----------
function renderSwatches() {
  const b = panels.swatches.body; b.innerHTML = '';
  const grid = h('div', { class: 'swatches' });
  const pick = (cm) => {
    const { paint } = currentPaint();
    if (cm == null) return setPaint(null);
    if (paint && paint.type !== 'solid') { const q = clonePaint(paint); q.stops[selStop].cmyk = [...cm]; setPaint(q); }
    else setPaint(solid(cm));
    renderColor();
  };
  SWATCHES.forEach(([name, cm]) => grid.append(h('div', {
    class: 'sw' + (cm ? '' : ' none'), title: name + (cm ? ` — C${cm[0]} M${cm[1]} Y${cm[2]} K${cm[3]}` : ''),
    style: cm ? { background: cmykCss(cm) } : {}, onclick: () => pick(cm),
  })));
  state.doc.swatches.forEach((p, i) => grid.append(h('div', {
    class: 'sw', title: (p.type === 'solid' ? `C${p.cmyk[0]} M${p.cmyk[1]} Y${p.cmyk[2]} K${p.cmyk[3]}` : 'Gradient') + ' — right-click to delete',
    style: { background: paintCss(p) },
    onclick: () => (p.type === 'solid' ? pick(p.cmyk) : (setPaint(clonePaint(p)), renderColor())),
    oncontextmenu: (e) => { e.preventDefault(); state.doc.swatches.splice(i, 1); markDirty(); renderSwatches(); },
  })));
  b.append(grid, h('div', { class: 'muted' }, 'All swatches are CMYK process colours. Document swatches are saved with the file.'));
}

// ---------- Stroke ----------
function renderStroke() {
  const b = panels.stroke.body; b.innerHTML = '';
  const t = paintTargets();
  const o = t[0];
  const sw = o ? o.strokeWidth : state.defaults.strokeWidth;
  const setAll = (props) => {
    if (!t.length) { if (props.strokeWidth != null) state.defaults.strokeWidth = props.strokeWidth; renderStroke(); return; }
    t.forEach((x) => { x.set(props); if (props.strokeWidth > 0 && !x.vpStroke) { x.vpStroke = solid([0, 0, 0, 100]); applyPaint(x); } x.setCoords(); });
    canvas.requestRenderAll(); commit(true); renderStroke(); renderColor(); renderFillStroke();
  };
  b.append(h('div', { class: 'grid2' },
    numField('Weight', Math.round(sw * 100) / 100, (v) => setAll({ strokeWidth: Math.max(0, v) }), { unit: 'pt', step: 0.25 }),
    h('select', { title: 'Common weights', onchange: (e) => { if (e.target.value) setAll({ strokeWidth: +e.target.value }); } },
      h('option', { value: '' }, 'Presets'), ...[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10].map((v) => h('option', { value: v }, v + ' pt')))));
  if (!o) return;
  const segBtns = (prop, opts) => h('div', { class: 'seg' }, ...opts.map(([v, l, tt]) => h('button', { class: (o[prop] || opts[0][0]) === v ? 'on' : '', title: tt, onclick: () => setAll({ [prop]: v }) }, l)));
  b.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Cap'), segBtns('strokeLineCap', [['butt', 'Butt'], ['round', 'Round'], ['square', 'Square']])));
  b.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Join'), segBtns('strokeLineJoin', [['miter', 'Miter'], ['round', 'Round'], ['bevel', 'Bevel']])));
  const dash = h('input', { type: 'text', value: (o.strokeDashArray || []).join(' '), placeholder: 'e.g. 6 3', title: 'Dash and gap lengths in pt' });
  dash.addEventListener('change', () => { const arr = dash.value.trim().split(/[\s,]+/).map(Number).filter((v) => v > 0); setAll({ strokeDashArray: arr.length ? arr : null }); });
  b.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Dashes'), dash));
  b.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Order'), segBtns('paintFirst', [['fill', 'Stroke on top'], ['stroke', 'Stroke behind']])));
}

// ---------- Character ----------
function renderChar() {
  const b = panels.char.body; b.innerHTML = '';
  const texts = sel().filter(isText);
  const t = texts[0];
  const fontId = t ? t.fontId : state.defaults.fontId;
  const meta = state.fontById.get(fontId);
  const fams = familiesList();
  const setT = async (props, fid) => {
    if (!texts.length) {
      if (fid) state.defaults.fontId = fid;
      if (props.fontSize) state.defaults.fontSize = props.fontSize;
      renderChar(); return;
    }
    if (fid) {
      const alias = await fontStack(fid);
      texts.forEach((x) => { x.fontId = fid; x.set({ fontFamily: alias }); });
    }
    texts.forEach((x) => { x.set(props); x.initDimensions(); x.setCoords(); if (x.vpFill && x.vpFill.type !== 'solid') applyPaint(x); });
    canvas.requestRenderAll(); commit(true); renderChar();
  };
  // family picker with search
  const famInput = h('input', { type: 'text', value: meta ? meta.family : '(choose font)', spellcheck: 'false' });
  const list = h('div', { class: 'fontlist' });
  const fill = (q) => {
    list.innerHTML = '';
    const ql = q.toLowerCase();
    let n = 0;
    for (const [fam, faces] of fams) {
      if (ql && !fam.toLowerCase().includes(ql)) continue;
      if (n++ > 400) break;
      list.append(h('div', { onmousedown: (e) => { e.preventDefault(); const face = faces.find((f) => /^(regular|book|roman|normal)$/i.test(f.style)) || faces[0]; famInput.value = fam; list.style.display = 'none'; setT({}, face.id); } }, fam));
    }
  };
  famInput.addEventListener('focus', () => { famInput.select(); fill(''); list.style.display = 'block'; });
  famInput.addEventListener('input', () => fill(famInput.value));
  famInput.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 150));
  famInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = list.firstChild; if (f) f.dispatchEvent(new MouseEvent('mousedown')); famInput.blur(); } });
  b.append(h('div', { class: 'fontpick' }, famInput, list));
  if (!state.fonts.length) b.append(h('div', { class: 'muted' }, 'Loading fonts…'));
  if (meta) {
    const faces = fams.get(meta.family) || [];
    b.append(h('select', { onchange: (e) => setT({}, e.target.value) }, ...faces.map((f) => h('option', { value: f.id, selected: f.id === fontId }, f.style))));
  }
  const size = t ? t.fontSize : state.defaults.fontSize;
  b.append(h('div', { class: 'grid2' },
    numField('Size', Math.round(size * 100) / 100, (v) => setT({ fontSize: Math.max(1, v) }), { unit: 'pt' }),
    numField('Lead', Math.round((t ? t.lineHeight * t.fontSize * (t._fontSizeMult || 1.13) : size * 1.2 * 1.13) * 10) / 10, (v) => setT({ lineHeight: Math.max(0.1, v / ((t ? t.fontSize : size) * 1.13)) }), { unit: 'pt', title: 'Leading' })));
  if (!t) { b.append(h('div', { class: 'muted' }, 'Settings for new text. Bangla (বাংলা) is fully supported — conjuncts are shaped correctly on screen and in exports.')); return; }
  b.append(h('div', { class: 'grid2' },
    numField('Track', t.charSpacing || 0, (v) => setT({ charSpacing: v }), { unit: '/1000', title: 'Tracking' }),
    h('div', { class: 'seg' }, ...[['left', '⯇'], ['center', '≡'], ['right', '⯈'], ['justify', '☰']].map(([v, l]) => h('button', { class: t.textAlign === v ? 'on' : '', title: 'Align ' + v, onclick: () => setT({ textAlign: v }) }, l)))));
  b.append(h('button', { class: 'btn', onclick: () => run('outline-text') }, 'Create Outlines (⇧⌘O)'));
  if ((t.charSpacing || 0) !== 0 && /[ঀ-৿]/.test(t.text)) b.append(h('div', { class: 'muted', style: { color: 'var(--warn)' } }, 'Note: tracking on Bangla text can break conjuncts on screen; the exported file is shaped correctly.'));
}

// ---------- Align ----------
let alignTo = 'selection';
function renderAlign() {
  const b = panels.align.body; b.innerHTML = '';
  const icon = (d) => h('svg', { viewBox: '0 0 24 24', html: d });
  const doAlign = (mode) => {
    const objs = sel();
    if (!objs.length) return;
    const art = alignTo === 'artboard' || objs.length === 1;
    canvas.discardActiveObject();
    const ref = art ? { x: 0, y: 0, w: state.doc.width, h: state.doc.height } : bounds(objs);
    if (mode === 'dh' || mode === 'dv') {
      const arr = objs.map((o) => ({ o, b: o.getBoundingRect() })).sort((p, q) => (mode === 'dh' ? p.b.left - q.b.left : p.b.top - q.b.top));
      if (arr.length > 2) {
        const first = arr[0].b; const last = arr[arr.length - 1].b;
        const c0 = mode === 'dh' ? first.left + first.width / 2 : first.top + first.height / 2;
        const c1 = mode === 'dh' ? last.left + last.width / 2 : last.top + last.height / 2;
        arr.forEach((p, i) => {
          const c = c0 + ((c1 - c0) * i) / (arr.length - 1);
          if (mode === 'dh') p.o.left += c - (p.b.left + p.b.width / 2); else p.o.top += c - (p.b.top + p.b.height / 2);
          p.o.setCoords();
        });
      }
    } else {
      for (const o of objs) {
        const ob = o.getBoundingRect();
        if (mode === 'l') o.left += ref.x - ob.left;
        if (mode === 'hc') o.left += ref.x + ref.w / 2 - (ob.left + ob.width / 2);
        if (mode === 'r') o.left += ref.x + ref.w - (ob.left + ob.width);
        if (mode === 't') o.top += ref.y - ob.top;
        if (mode === 'vc') o.top += ref.y + ref.h / 2 - (ob.top + ob.height / 2);
        if (mode === 'b') o.top += ref.y + ref.h - (ob.top + ob.height);
        o.setCoords();
      }
    }
    selectObjects(objs);
    commit(true);
  };
  const A = [
    ['l', 'Align left', '<path d="M4 3v18M7 6h11v4H7zM7 14h7v4H7z" fill="currentColor"/>'],
    ['hc', 'Align horizontal centre', '<path d="M12 3v18M6 6h12v4H6zM8 14h8v4H8z" fill="currentColor"/>'],
    ['r', 'Align right', '<path d="M20 3v18M6 6h11v4H6zM10 14h7v4h-7z" fill="currentColor"/>'],
    ['t', 'Align top', '<path d="M3 4h18M6 7h4v11H6zM14 7h4v7h-4z" fill="currentColor"/>'],
    ['vc', 'Align vertical centre', '<path d="M3 12h18M6 6h4v12H6zM14 8h4v8h-4z" fill="currentColor"/>'],
    ['b', 'Align bottom', '<path d="M3 20h18M6 6h4v11H6zM14 10h4v7h-4z" fill="currentColor"/>'],
  ];
  b.append(h('div', { class: 'grid6' }, ...A.map(([m, t, d]) => h('button', { class: 'ibtn', title: t, onclick: () => doAlign(m) }, icon(d)))));
  b.append(h('div', { class: 'grid2' },
    h('button', { class: 'btn', onclick: () => doAlign('dh'), title: 'Distribute horizontal centres' }, '⇹ Distribute H'),
    h('button', { class: 'btn', onclick: () => doAlign('dv'), title: 'Distribute vertical centres' }, '⇳ Distribute V')));
  b.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Align to'),
    h('div', { class: 'seg', style: { flex: 1 } }, ...[['selection', 'Selection'], ['artboard', 'Artboard']].map(([v, l]) => h('button', { class: alignTo === v ? 'on' : '', onclick: () => { alignTo = v; renderAlign(); } }, l)))));
}

// ---------- Pathfinder ----------
function renderPathfinder() {
  const b = panels.pathfinder.body; b.innerHTML = '';
  const ops = [['unite', 'Unite'], ['minus', 'Minus Front'], ['intersect', 'Intersect'], ['exclude', 'Exclude']];
  b.append(h('div', { class: 'grid2' }, ...ops.map(([k, l]) => h('button', { class: 'btn', onclick: () => pathfinder(k) }, l))));
  b.append(h('div', { class: 'muted' }, 'Select 2 or more shapes. Text is outlined automatically.'));
}

// ---------- Layers ----------
function typeIcon(o) {
  if (isText(o)) return 'T';
  return { rect: '▭', ellipse: '◯', polygon: '⬠', line: '╱', path: '✎', image: '🖼', group: o.clipPath ? '◫' : '❒' }[o.type] || '•';
}
function renderLayers() {
  const b = panels.layers.body; b.innerHTML = '';
  const list = h('div', { class: 'layers' });
  const objs = canvas.getObjects().filter((o) => !o.vpGuide);
  const active = new Set(canvas.getActiveObjects());
  let dragIdx = -1;
  [...objs].reverse().forEach((o) => {
    const idx = canvas.getObjects().indexOf(o);
    const name = o.name || (isText(o) ? (o.text || 'Text').slice(0, 30) : o.type);
    const row = h('div', {
      class: 'lrow' + (active.has(o) ? ' sel' : '') + (o.visible ? '' : ' hidden'), draggable: 'true',
      onclick: (e) => {
        if (o.vpLocked || !o.visible) return;
        if (e.shiftKey || e.metaKey) { const cur = canvas.getActiveObjects(); selectObjects(cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]); }
        else selectObjects([o]);
      },
      ondragstart: (e) => { dragIdx = idx; e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => { e.preventDefault(); row.classList.add('dragover'); },
      ondragleave: () => row.classList.remove('dragover'),
      ondrop: (e) => {
        e.preventDefault(); row.classList.remove('dragover');
        const src = canvas.getObjects()[dragIdx];
        if (!src || src === o) return;
        canvas.moveObjectTo(src, canvas.getObjects().indexOf(o));
        canvas.requestRenderAll(); commit(true); renderLayers();
      },
    },
    h('button', { class: o.visible ? 'on' : '', title: o.visible ? 'Hide' : 'Show', onclick: (e) => { e.stopPropagation(); o.set({ visible: !o.visible, vpHidden: o.visible }); if (!o.visible) canvas.discardActiveObject(); canvas.requestRenderAll(); commit(true); renderLayers(); } }, o.visible ? '👁' : '–'),
    h('button', { class: o.vpLocked ? 'on' : '', title: o.vpLocked ? 'Unlock' : 'Lock', onclick: (e) => { e.stopPropagation(); setLocked(o, !o.vpLocked); if (o.vpLocked) canvas.discardActiveObject(); canvas.requestRenderAll(); commit(true); renderLayers(); } }, o.vpLocked ? '🔒' : '🔓'),
    h('span', { class: 'licon' }, typeIcon(o)),
    h('span', { class: 'lname', title: name }, name));
    row.querySelector('.lname').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const inp = h('input', { type: 'text', value: name, style: { width: '100%' } });
      e.target.replaceWith(inp); inp.focus(); inp.select();
      const done = () => { o.name = inp.value; commit(true); renderLayers(); };
      inp.addEventListener('blur', done);
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); });
    });
    list.append(row);
  });
  if (!objs.length) list.append(h('div', { class: 'muted', style: { padding: '8px' } }, 'No objects yet'));
  b.append(list);
}

// ---------- fill/stroke widget in toolbar ----------
export function renderFillStroke() {
  const t = paintTargets()[0];
  const f = t ? t.vpFill : state.defaults.fill;
  const s = t ? t.vpStroke : state.defaults.stroke;
  const fe = $('#fs-fill'); const se = $('#fs-stroke');
  fe.classList.toggle('none', !f); se.classList.toggle('none', !s);
  fe.firstChild.style.background = f ? paintCss(f) : '';
  se.firstChild.style.background = s ? paintCss(s) : '';
  fe.classList.toggle('active', state.activePaint === 'fill');
  se.classList.toggle('active', state.activePaint === 'stroke');
}

let refreshTimer = 0;
export function refreshPanels() {
  if (!canvas) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const focus = document.activeElement;
    const inPanels = focus && $('#panels').contains(focus) && focus.tagName === 'INPUT';
    const skip = (id) => inPanels && panels[id].el.contains(focus);
    const texts = sel().some(isText);
    panels.char.el.style.display = texts || !sel().length || state.tool === 'text' ? '' : 'none';
    if (!skip('props')) renderProps();
    if (!skip('color')) renderColor();
    if (!skip('stroke')) renderStroke();
    if (!skip('char')) renderChar();
    renderSwatches();
    renderLayers();
    renderFillStroke();
  }, 30);
}

export function initPanels() {
  canvas = state.canvas;
  panel('props', 'Properties');
  panel('color', 'Colour (CMYK)');
  panel('swatches', 'Swatches');
  panel('stroke', 'Stroke');
  panel('char', 'Character');
  panel('align', 'Align');
  panel('pathfinder', 'Pathfinder');
  panel('layers', 'Layers');
  renderAlign(); renderPathfinder();
  refreshPanels();
  ['object:moving', 'object:scaling', 'object:rotating'].forEach((ev) => canvas.on(ev, () => { clearTimeout(liveTimer); liveTimer = setTimeout(renderProps, 40); }));
  canvas.on('object:modified', () => refreshPanels());
  on('fonts', () => renderChar());
  on('doc', () => refreshPanels());
  on('defaults-changed', () => refreshPanels());
  on('colors-updated', () => { renderFillStroke(); renderSwatches(); });
  $('#fs-fill').addEventListener('click', () => { state.activePaint = 'fill'; refreshPanels(); });
  $('#fs-stroke').addEventListener('click', () => { state.activePaint = 'stroke'; refreshPanels(); });
  $('#fs-swap').addEventListener('click', () => emit('swap-paint'));
  $('#fs-default').addEventListener('click', () => emit('default-paint'));
  $('#fs-none').addEventListener('click', () => emit('none-paint'));
  on('toggle-paint', () => { state.activePaint = state.activePaint === 'fill' ? 'stroke' : 'fill'; refreshPanels(); });
  on('none-paint', () => { setPaint(null); renderColor(); });
  on('default-paint', () => {
    const t = paintTargets();
    if (t.length) { t.forEach((o) => { o.vpFill = solid([0, 0, 0, 0]); o.vpStroke = solid([0, 0, 0, 100]); if (!o.strokeWidth) o.strokeWidth = 1; applyPaint(o); }); canvas.requestRenderAll(); commit(true); }
    else { state.defaults.fill = solid([0, 0, 0, 0]); state.defaults.stroke = solid([0, 0, 0, 100]); }
    refreshPanels();
  });
  on('swap-paint', () => {
    const t = paintTargets();
    if (t.length) { t.forEach((o) => { const f = o.vpFill; o.vpFill = o.vpStroke; o.vpStroke = f; if (o.vpStroke && !o.strokeWidth) o.strokeWidth = 1; applyPaint(o); }); canvas.requestRenderAll(); commit(true); }
    else { const f = state.defaults.fill; state.defaults.fill = state.defaults.stroke; state.defaults.stroke = f; }
    refreshPanels();
  });
}
let liveTimer = 0;
