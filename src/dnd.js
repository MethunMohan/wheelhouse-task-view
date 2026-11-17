'use strict';
// Minimal HTML5 drag-and-drop helpers shared by the Overview and the Queue.
const state = { id: null, ids: [], after: [] };
let indicator = null;

const isDragging = () => state.id !== null;
const afterDrag = (cb) => state.after.push(cb);

function clearIndicator() {
  if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
}
function endDrag() {
  const doc = indicator ? indicator.ownerDocument : document;
  state.id = null;
  state.ids = [];
  clearIndicator();
  doc.body.classList.remove('to-dragging');
  doc.querySelectorAll('.to-over, .is-dragging').forEach((e) => e.classList.remove('to-over', 'is-dragging'));
  const cbs = state.after;
  state.after = [];
  cbs.forEach((cb) => cb());
}

/** `ids` (optional): drag a group of tasks (a note card) as one. `id` is then the first of them. */
function enableDrag(el, id, ids) {
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', (e) => {
    if (e.target !== el) return;
    state.id = id;
    state.ids = ids || [id];
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    el.ownerDocument.body.classList.add('to-dragging');
    requestAnimationFrame(() => el.classList.add('is-dragging'));
  });
  el.addEventListener('dragend', (e) => { if (e.target === el) endDrag(); });
}

function beforeElement(zone, e, opts) {
  const items = [...zone.querySelectorAll(opts.itemSelector)].filter((x) => x.dataset.id !== state.id);
  for (const it of items) {
    const r = it.getBoundingClientRect();
    const before = opts.orientation === 'column'
      ? e.clientY < r.top + r.height / 2
      : e.clientY < r.bottom && e.clientX < r.left + r.width / 2;
    if (before) return it;
  }
  return null;
}

/**
 * opts.itemSelector: when set, drops are positional and onDrop(id, beforeId, ids) is told
 * which item to insert before (null = end). Without it the whole zone is one target.
 */
function enableDrop(zone, opts) {
  zone.addEventListener('dragover', (e) => {
    if (!state.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('to-over');
    if (!opts.itemSelector) return;
    const before = beforeElement(zone, e, opts);
    if (!indicator) {
      indicator = zone.ownerDocument.createElement('div');
      indicator.className = 'to-drop-indicator';
    }
    const parent = before ? before.parentNode : zone;
    const inPlace = indicator.parentNode === parent && (before ? indicator.nextElementSibling === before : parent.lastElementChild === indicator);
    if (!inPlace) parent.insertBefore(indicator, before);
  });
  zone.addEventListener('dragleave', (e) => {
    if (zone.contains(e.relatedTarget)) return;
    zone.classList.remove('to-over');
    if (indicator && zone.contains(indicator)) clearIndicator();
  });
  zone.addEventListener('drop', (e) => {
    if (!state.id) return;
    e.preventDefault();
    const id = state.id;
    const ids = state.ids;
    const before = opts.itemSelector ? beforeElement(zone, e, opts) : null;
    endDrag();
    opts.onDrop(id, before ? before.dataset.id : null, ids);
  });
}

module.exports = { enableDrag, enableDrop, isDragging, afterDrag };
