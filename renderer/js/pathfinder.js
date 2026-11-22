// Pathfinder boolean operations using paper.js (offscreen).
import { state } from './state.js';
import { toast } from './util.js';
import { applyPaint, clonePaint } from './paint.js';
import { absoluteSubs, subsToD } from './geometry.js';
import { commit, selectObjects } from './app.js';

let ready = false;
function setup() {
  if (ready) return;
  paper.setup(new paper.Size(1, 1));
  ready = true;
}

export async function pathfinder(op) {
  const canvas = state.canvas;
  const all = canvas.getObjects();
  const objs = [...canvas.getActiveObjects()].sort((a, b) => all.indexOf(a) - all.indexOf(b));
  if (objs.length < 2) { toast('Select two or more shapes'); return; }
  if (objs.some((o) => o.type === 'image')) { toast('Pathfinder works on shapes and text, not images'); return; }
  setup();
  const items = [];
  for (const o of objs) {
    const d = subsToD(await absoluteSubs(o));
    const p = new paper.CompoundPath({ pathData: d, insert: false });
    p.fillRule = o.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
    p.reorient(p.fillRule === 'nonzero', true);
    items.push(p);
  }
  let res;
  if (op === 'unite') res = items.reduce((a, b) => a.unite(b, { insert: false }));
  else if (op === 'minus') { const front = items.slice(1).reduce((a, b) => a.unite(b, { insert: false })); res = items[0].subtract(front, { insert: false }); }
  else if (op === 'intersect') res = items.reduce((a, b) => a.intersect(b, { insert: false }));
  else res = items.reduce((a, b) => a.exclude(b, { insert: false }));
  const d = res.pathData;
  const styleSrc = op === 'minus' ? objs[0] : objs[objs.length - 1];
  const idx = all.indexOf(objs[0]);
  canvas.discardActiveObject();
  canvas.remove(...objs);
  if (!d) { canvas.requestRenderAll(); commit(true); toast('Result is empty'); return; }
  const path = new fabric.Path(d, { fillRule: 'nonzero' });
  path.vpFill = clonePaint(styleSrc.vpFill);
  path.vpStroke = clonePaint(styleSrc.vpStroke);
  path.strokeWidth = styleSrc.strokeWidth;
  path.opacity = styleSrc.opacity;
  path.name = { unite: 'Unite', minus: 'Minus Front', intersect: 'Intersect', exclude: 'Exclude' }[op];
  applyPaint(path);
  canvas.insertAt(Math.max(0, idx), path);
  selectObjects([path]);
  commit(true);
}
