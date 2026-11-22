// Modal dialogs.
import { state } from './state.js';
import { $, h, toPt, fromPt, fmt, UNITS, toast } from './util.js';
import { onProfileChanged, openFile, selectObjects } from './app.js';

function modal(title, body, buttons, opts = {}) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const close = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', key, true); resolve(v); };
    const foot = h('div', { class: 'mfoot' }, ...buttons.map((b) => h('button', {
      class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
      onclick: () => { const v = b.value ? b.value() : b.result; if (v !== undefined && v !== false) close(v); else if (b.result === undefined && !b.value) close(null); },
    }, b.label)));
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(opts.escValue ?? null); }
      if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) {
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); e.stopPropagation(); const v = p.value ? p.value() : p.result; if (v !== undefined && v !== false) close(v); }
      }
    };
    document.addEventListener('keydown', key, true);
    const m = h('div', { class: 'modal', style: opts.width ? { width: opts.width } : {} }, title ? h('h2', {}, title) : null, h('div', { class: 'mbody' }, body), buttons.length ? foot : null);
    root.innerHTML = '';
    root.append(m);
    const first = m.querySelector('input[autofocus], input');
    if (first && opts.focus !== false) setTimeout(() => first.focus(), 30);
    if (opts.onMount) opts.onMount(m, close);
  });
}

export function alert(title, msg) {
  return modal(title, h('div', { style: { whiteSpace: 'pre-wrap', maxWidth: '460px' } }, msg), [{ label: 'OK', primary: true, result: true }]);
}

export function confirm(title, msg, labels) {
  return modal(title, h('div', { style: { maxWidth: '420px' } }, msg), labels.map((l, i) => ({ label: l, primary: i === 0, result: i })), { escValue: labels.length - 1 });
}

// ---------- New document ----------
export const PRESETS = [
  { group: 'Popular', name: 'Visiting Card', w: 3.5, h: 2, u: 'in', bleed: 3 },
  { group: 'Popular', name: 'A4', w: 210, h: 297, u: 'mm', bleed: 3 },
  { group: 'Popular', name: 'A5 Leaflet', w: 148, h: 210, u: 'mm', bleed: 3 },
  { group: 'Popular', name: 'A3', w: 297, h: 420, u: 'mm', bleed: 3 },
  { group: 'Paper', name: 'Letter', w: 8.5, h: 11, u: 'in', bleed: 3 },
  { group: 'Paper', name: 'Legal', w: 8.5, h: 14, u: 'in', bleed: 3 },
  { group: 'Paper', name: 'Letterhead (A4)', w: 210, h: 297, u: 'mm', bleed: 3 },
  { group: 'Paper', name: 'Envelope', w: 9.5, h: 4.25, u: 'in', bleed: 3 },
  { group: 'Poster', name: 'Poster 18×23″', w: 18, h: 23, u: 'in', bleed: 3 },
  { group: 'Poster', name: 'Poster 20×30″', w: 20, h: 30, u: 'in', bleed: 3 },
  { group: 'Poster', name: 'Double Demy 23×36″', w: 23, h: 36, u: 'in', bleed: 3 },
  { group: 'Large', name: 'Banner 6×3 ft', w: 6, h: 3, u: 'ft', bleed: 0 },
  { group: 'Large', name: 'Roll-up 33×80″', w: 33, h: 80, u: 'in', bleed: 0 },
  { group: 'Other', name: 'Sticker 3×3″', w: 3, h: 3, u: 'in', bleed: 2 },
  { group: 'Other', name: 'ID Card', w: 54, h: 85.6, u: 'mm', bleed: 2 },
  { group: 'Other', name: 'Shopping Bag Face', w: 12, h: 15, u: 'in', bleed: 3 },
];

export async function newDocDialog(welcome) {
  let sel = PRESETS[0];
  let landscape = sel.w > sel.h;
  const name = h('input', { type: 'text', value: 'Untitled' });
  const W = h('input', { type: 'text' }); const H = h('input', { type: 'text' });
  const units = h('select', {}, ...Object.keys(UNITS).filter((k) => k !== 'px').map((k) => h('option', { value: k }, UNITS[k].label)));
  const bleed = h('input', { type: 'text' }); const safe = h('input', { type: 'text', value: '5' });
  const cards = [];
  const sync = () => {
    units.value = sel.u;
    const [a, b] = landscape === (sel.w >= sel.h) ? [sel.w, sel.h] : [sel.h, sel.w];
    W.value = a; H.value = b; bleed.value = sel.bleed; name.value = sel.name === 'Custom' ? 'Untitled' : sel.name;
    cards.forEach(([c, p]) => c.classList.toggle('on', p === sel));
  };
  const grid = h('div', { class: 'presets' }, ...PRESETS.map((p) => {
    const mx = Math.max(p.w, p.h);
    const c = h('div', { class: 'preset', onclick: () => { sel = p; landscape = p.w > p.h; sync(); }, ondblclick: () => $('.modal .btn.primary').click() },
      h('div', { class: 'pv', style: { width: (p.w / mx) * 44 + 'px', height: (p.h / mx) * 44 + 'px' } }),
      h('div', { class: 'pn' }, p.name), h('div', { class: 'ps' }, `${p.w} × ${p.h} ${p.u}`));
    cards.push([c, p]);
    return c;
  }));
  const orient = h('div', { class: 'seg', style: { width: '160px' } },
    h('button', { onclick: () => { landscape = false; const a = +W.value; const b = +H.value; if (a > b) { W.value = b; H.value = a; } } }, 'Portrait'),
    h('button', { onclick: () => { landscape = true; const a = +W.value; const b = +H.value; if (a < b) { W.value = b; H.value = a; } } }, 'Landscape'));
  const recent = ((await window.vpm.invoke('settings:get')).recent || []);
  const body = h('div', { style: { display: 'flex', gap: '18px' } },
    h('div', { style: { flex: '1' } }, grid),
    h('div', { style: { width: '230px', display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('label', {}, 'Name', name),
      h('div', { class: 'grid2' }, h('label', {}, 'Width', W), h('label', {}, 'Height', H)),
      h('label', {}, 'Units', units),
      orient,
      h('div', { class: 'grid2' }, h('label', { title: 'Bleed in mm' }, 'Bleed (mm)', bleed), h('label', { title: 'Safe margin in mm' }, 'Safe (mm)', safe)),
      h('div', { class: 'muted' }, 'Colour mode: CMYK (print). Bleed is the extra area that gets trimmed off — 3 mm is standard in Bangladesh presses.'),
      recent.length && welcome ? h('div', { class: 'welcome-recent' }, h('div', { class: 'muted' }, 'Recent'),
        ...recent.slice(0, 6).map((r) => h('a', { title: r, onclick: () => { $('#modal-root').innerHTML = ''; openFile(r); } }, r.split(/[\\/]/).pop()))) : null,
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn', onclick: async () => { $('#modal-root').innerHTML = ''; window.__vpmCmd && window.__vpmCmd('open'); } }, 'Open existing file…')),
  );
  for (const l of body.querySelectorAll('label')) { l.style.display = 'flex'; l.style.flexDirection = 'column'; l.style.gap = '3px'; l.style.color = 'var(--dim)'; }
  sync();
  return modal(welcome ? 'Vibrant Print Master Pro — New Document' : 'New Document', body, [
    ...(welcome ? [{ label: 'Skip', result: null }] : [{ label: 'Cancel', result: null }]),
    {
      label: 'Create', primary: true,
      value: () => {
        const u = units.value; const w = parseFloat(W.value); const hh = parseFloat(H.value);
        if (!(w > 0 && hh > 0)) { toast('Enter a valid size'); return false; }
        return { name: name.value || 'Untitled', width: toPt(w, u), height: toPt(hh, u), units: u === 'ft' ? 'in' : u, bleed: toPt(parseFloat(bleed.value) || 0, 'mm'), safe: toPt(parseFloat(safe.value) || 0, 'mm') };
      },
    },
  ], { width: '900px' });
}

export async function docSetupDialog() {
  const d = state.doc; const u = d.units;
  const W = h('input', { type: 'text', value: fmt(d.width, u) }); const H = h('input', { type: 'text', value: fmt(d.height, u) });
  const B = h('input', { type: 'text', value: fmt(d.bleed, 'mm') }); const S = h('input', { type: 'text', value: fmt(d.safe, 'mm') });
  const units = h('select', {}, ...Object.keys(UNITS).map((k) => h('option', { value: k, selected: k === u }, UNITS[k].label)));
  const name = h('input', { type: 'text', value: d.name });
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', width: '360px' } },
    h('label', {}, 'Name', name),
    h('div', { class: 'grid2' }, h('label', {}, `Width (${u})`, W), h('label', {}, `Height (${u})`, H)),
    h('div', { class: 'grid2' }, h('label', {}, 'Bleed (mm)', B), h('label', {}, 'Safe margin (mm)', S)),
    h('label', {}, 'Ruler units', units),
    h('div', { class: 'muted' }, 'Changing the size keeps objects at their position from the top-left corner. Applies to all artboards.'));
  for (const l of body.querySelectorAll('label')) { l.style.display = 'flex'; l.style.flexDirection = 'column'; l.style.gap = '3px'; l.style.color = 'var(--dim)'; }
  return modal('Document Setup', body, [{ label: 'Cancel', result: null }, {
    label: 'OK', primary: true,
    value: () => ({ name: name.value || d.name, width: toPt(parseFloat(W.value), u) || d.width, height: toPt(parseFloat(H.value), u) || d.height, bleed: toPt(parseFloat(B.value) || 0, 'mm'), safe: toPt(parseFloat(S.value) || 0, 'mm'), units: units.value }),
  }]);
}

// ---------- Export ----------
export async function exportDialog(format, issues) {
  const errs = issues.filter((i) => i.sev === 'error').length;
  const warns = issues.filter((i) => i.sev === 'warn').length;
  const prof = await window.vpm.invoke('color:profiles');
  const incBleed = h('input', { type: 'checkbox', checked: format === 'pdf' });
  const marks = h('input', { type: 'checkbox', checked: format === 'pdf' && state.doc.bleed > 0 });
  const allPages = h('input', { type: 'checkbox', checked: true });
  const desc = {
    pdf: 'Print-ready PDF for the press: CMYK vectors, images converted to CMYK with your ICC profile and embedded, text converted to outlines, output intent included.',
    ai: 'Illustrator-compatible (.ai, PDF-based). Opens in Adobe Illustrator with editable shapes, CMYK colours and embedded images. Text comes in as outlines.',
    eps: 'EPS (PostScript Level 3) for printers that ask for EPS. CMYK vectors, embedded CMYK images. Made for maximum compatibility (PostScript Level 2). EPS has no transparency: opacity is ignored and transparent PNG areas become white — use .AI or PDF for those.',
  }[format];
  const body = h('div', { style: { width: '460px', display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { class: 'muted', style: { fontSize: '12px' } }, desc),
    h('label', { class: 'chk' }, incBleed, `Include bleed (${fmt(state.doc.bleed, 'mm')} mm)`),
    format === 'pdf' ? h('label', { class: 'chk' }, marks, 'Crop marks') : null,
    format === 'pdf' && state.doc.pages.length > 1 ? h('label', { class: 'chk' }, allPages, `All ${state.doc.pages.length} artboards (one page each)`) : null,
    format !== 'pdf' && state.doc.pages.length > 1 ? h('div', { class: 'muted' }, `Only the current artboard (${state.doc.pages[state.doc.page].name}) is saved in this format.`) : null,
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Colour profile:'), h('b', {}, prof.current ? prof.current.name : 'none')),
    errs || warns ? h('div', { style: { color: errs ? 'var(--danger)' : 'var(--warn)', cursor: 'pointer' }, onclick: () => { $('#modal-root').innerHTML = ''; preflightDialog(issues); } },
      `Preflight: ${errs} error(s), ${warns} warning(s) — click to review`) : h('div', { style: { color: 'var(--ok)' } }, '✓ Preflight passed'));
  return modal({ pdf: 'Export Print PDF', ai: 'Save as Illustrator (.ai)', eps: 'Save as EPS' }[format], body, [
    { label: 'Cancel', result: null },
    { label: 'Save…', primary: true, value: () => ({ includeBleed: incBleed.checked, marks: marks.checked, allPages: allPages.checked }) },
  ]);
}

export async function rasterDialog() {
  const fmtSel = h('select', {}, h('option', { value: 'png' }, 'PNG (transparent background)'), h('option', { value: 'jpg' }, 'JPG (white background)'));
  const dpi = h('select', {}, ...[72, 150, 300].map((v) => h('option', { value: v, selected: v === 300 }, v + ' dpi')));
  const inc = h('input', { type: 'checkbox' });
  const body = h('div', { style: { width: '380px', display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { class: 'row' }, h('span', { class: 'lbl', style: { width: '70px' } }, 'Format'), fmtSel),
    h('div', { class: 'row' }, h('span', { class: 'lbl', style: { width: '70px' } }, 'Resolution'), dpi),
    h('label', { class: 'chk' }, inc, 'Include bleed'),
    h('div', { class: 'muted' }, 'PNG/JPG are RGB screen images (for mock-ups, WhatsApp, Facebook). For the press, use Export PDF.'));
  return modal('Export PNG / JPG', body, [{ label: 'Cancel', result: null }, { label: 'Save…', primary: true, value: () => ({ format: fmtSel.value, dpi: +dpi.value, includeBleed: inc.checked }) }]);
}

// ---------- Preflight ----------
export function preflightDialog(issues) {
  const list = h('div', { class: 'pf-list' });
  if (!issues.length) list.append(h('div', { class: 'pf-ok' }, '✓ No problems found — ready for print.'));
  for (const it of issues) {
    list.append(h('div', {
      class: 'pf-item',
      onclick: () => { if (it.obj && it.obj.canvas && it.obj.selectable) { $('#modal-root').innerHTML = ''; selectObjects([it.obj]); } },
    }, h('span', { class: 'sev ' + it.sev }, { error: 'Error', warn: 'Warning', info: 'Info' }[it.sev]), h('span', {}, it.msg)));
  }
  return modal('Preflight', h('div', { style: { width: '560px' } }, list), [{ label: 'Close', primary: true, result: true }]);
}

// ---------- Preferences ----------
export async function preferencesDialog() {
  const r = await window.vpm.invoke('color:profiles');
  const sel = h('select', { style: { width: '100%' } }, ...r.list.map((p) => h('option', { value: p.path, selected: r.current && p.path === r.current.path }, p.name)));
  const body = h('div', { style: { width: '520px', display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', {}, h('b', {}, 'CMYK working space (ICC profile)')),
    sel,
    h('div', { class: 'muted' }, 'Use the same profile as Illustrator (Edit → Color Settings → Working Spaces → CMYK) so colours match. Coated FOGRA39 is common for offset printing in Bangladesh. This profile is used to preview colours on screen, convert RGB images/HEX to CMYK and is embedded as the output intent in PDFs.'),
    h('div', { class: 'muted' }, `${r.list.length} CMYK profile(s) found on this computer.`));
  const v = await modal('Preferences', body, [{ label: 'Cancel', result: null }, { label: 'Apply', primary: true, value: () => sel.value }]);
  if (v && (!r.current || v !== r.current.path)) {
    const name = await window.vpm.invoke('color:set-profile', v);
    await onProfileChanged();
    toast('Colour profile: ' + name);
  }
}

export function aboutDialog() {
  return modal('', h('div', { class: 'about' },
    h('img', { src: '../assets/logo.svg' }),
    h('h1', {}, 'Vibrant Print Master Pro'),
    h('div', { class: 'muted' }, 'Version 1.0 · CMYK vector design for print'),
    h('div', { class: 'by' }, 'Created by Tahamid'),
    h('div', { class: 'muted', style: { marginTop: '8px' } }, 'Colour management: LittleCMS · Text shaping: HarfBuzz · Canvas: Fabric.js · Booleans: Paper.js')),
  [{ label: 'Close', primary: true, result: true }]);
}

export function shortcutsDialog() {
  const k = [
    ['V', 'Selection'], ['A', 'Direct Selection (edit points)'], ['P', 'Pen'], ['T', 'Type'], ['M', 'Rectangle'], ['L', 'Ellipse'], ['\\', 'Line'], ['I', 'Eyedropper'], ['H / Space', 'Hand'], ['Z', 'Zoom'],
    ['X', 'Toggle fill / stroke'], ['⇧X', 'Swap fill and stroke'], ['D', 'Default colours'], ['/', 'None'],
    ['⌘G / ⇧⌘G', 'Group / Ungroup'], ['⌘7 / ⌥⌘7', 'Make / Release clipping mask'], ['⇧⌘O', 'Create outlines'],
    ['⌘] ⌘[', 'Forward / Backward'], ['⇧⌘] ⇧⌘[', 'Front / Back'], ['⌘2 / ⌥⌘2', 'Lock / Unlock all'], ['⌘3 / ⌥⌘3', 'Hide / Show all'],
    ['⌘D', 'Duplicate'], ['⇧⌘V', 'Paste in place'], ['Arrows', 'Nudge 1 pt (⇧ = 10 pt)'],
    ['⌘0 / ⌘1', 'Fit / Actual size'], ['⌘+ / ⌘−', 'Zoom'], ['⌘R', 'Rulers'], ['⌘;', 'Guides'],
    ['⌥⌘P', 'Export print PDF'], ['⌥⌘A', 'Save as .ai'], ['⌥⌘E', 'Save as EPS'], ['⇧⌘F', 'Preflight'], ['⇧⌘P', 'Place image'],
  ];
  return modal('Keyboard Shortcuts', h('div', { class: 'kbd', style: { width: '460px' } }, ...k.flatMap(([a, b]) => [h('kbd', {}, a), h('span', {}, b)])), [{ label: 'Close', primary: true, result: true }]);
}
