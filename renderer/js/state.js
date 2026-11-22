// Global editor state (single document per window).
import { DEFAULT_FILL, DEFAULT_STROKE } from './paint.js';

export const state = {
  canvas: null,
  doc: null, // { name, file, width, height, bleed, safe, units, pages:[{name,json}], page, guides:{v:[],h:[]}, swatches:[] }
  zoom: 1,
  tool: 'select',
  activePaint: 'fill', // 'fill' | 'stroke'
  defaults: { fill: DEFAULT_FILL, stroke: DEFAULT_STROKE, strokeWidth: 1, fontId: null, fontSize: 12 },
  showRulers: true,
  showGuides: true,
  showBleed: true,
  snap: true,
  dirty: false,
  fonts: [],
  fontById: new Map(),
  exporting: false,
  snapLines: [],
  listeners: {},
};

export function on(ev, fn) { (state.listeners[ev] ||= []).push(fn); }
export function emit(ev, ...a) { (state.listeners[ev] || []).forEach((f) => f(...a)); }

export function markDirty() {
  if (!state.dirty) { state.dirty = true; emit('title'); }
}
