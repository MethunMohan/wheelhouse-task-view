'use strict';
// Task identity: hashing and reconciliation of "tasks found now" against
// "task records we remember". Pure functions, no Obsidian dependency.

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function hashText(s) {
  return cyrb53(s).toString(36);
}

/** Normalise text for identity: case/whitespace-insensitive, ignores a trailing ^block-id. */
function normalizeText(s) {
  return String(s).replace(/\s\^[A-Za-z0-9-]+\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A compact fuzzy fingerprint (hashed words, not content) used to recognise edited tasks. */
function wordHashes(text) {
  const words = normalizeText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const uniq = [...new Set(words)].sort().slice(0, 10);
  return uniq.map((w) => cyrb53(w).toString(36));
}

function jaccard(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const x of a) if (sb.has(x)) inter++;
  return inter / (a.length + b.length - inter);
}

const pos = (x) => (x.l !== undefined ? x.l : x.line);
const sameCtx = (a, b) => a.cp === b.cp && a.cn === b.cn;

/**
 * Match remembered records to freshly parsed tasks of ONE file.
 * oldRecs: [{h, cp, cn, w, l}]   newTasks: [{h, cp, cn, w, line}]
 * Returns an array (one entry per new task) holding the matched old index or -1.
 *
 * Passes: (1) identical text, disambiguating duplicates by neighbouring lines;
 * (2) optional fuzzy match for edited text, only when unambiguous.
 * Ambiguity never guesses: the task simply stays unmatched.
 */
function reconcile(oldRecs, newTasks, opts) {
  const fuzzy = !opts || opts.fuzzy !== false;
  const o2n = new Array(oldRecs.length).fill(-1);
  const n2o = new Array(newTasks.length).fill(-1);
  const pair = (o, n) => { o2n[o] = n; n2o[n] = o; };
  const group = (arr) => {
    const m = new Map();
    arr.forEach((x, i) => { if (!m.has(x.h)) m.set(x.h, []); m.get(x.h).push(i); });
    return m;
  };
  const oldBy = group(oldRecs);
  const newBy = group(newTasks);

  for (const [h, os] of oldBy) {
    const ns = newBy.get(h);
    if (!ns) continue;
    let freeO = os.slice();
    let freeN = ns.slice();
    // A: pair where neighbouring-line context is equal and unique on both sides.
    for (const o of os) {
      const cands = freeN.filter((n) => sameCtx(oldRecs[o], newTasks[n]));
      if (cands.length !== 1) continue;
      const n = cands[0];
      const back = freeO.filter((x) => sameCtx(oldRecs[x], newTasks[n]));
      if (back.length !== 1) continue;
      pair(o, n);
      freeO = freeO.filter((x) => x !== o);
      freeN = freeN.filter((x) => x !== n);
    }
    // B: same number left on both sides -> pair in document order.
    if (freeO.length && freeO.length === freeN.length) {
      freeO.sort((a, b) => pos(oldRecs[a]) - pos(oldRecs[b]));
      freeN.sort((a, b) => pos(newTasks[a]) - pos(newTasks[b]));
      freeO.forEach((o, i) => pair(o, freeN[i]));
    }
  }

  if (fuzzy) {
    const fo = [];
    const fn = [];
    o2n.forEach((v, i) => { if (v < 0) fo.push(i); });
    n2o.forEach((v, i) => { if (v < 0) fn.push(i); });
    if (fo.length && fn.length && fo.length * fn.length <= 40000) {
      const score = (o, n) => {
        const j = jaccard(oldRecs[o].w, newTasks[n].w);
        if (j < 0.5) return 0;
        return j
          + (oldRecs[o].cp === newTasks[n].cp ? 0.15 : 0)
          + (oldRecs[o].cn === newTasks[n].cn ? 0.15 : 0)
          + (Math.abs(pos(oldRecs[o]) - pos(newTasks[n])) <= 2 ? 0.1 : 0);
      };
      const best = (cands, f) => {
        let b = -1, bs = 0, second = 0;
        for (const c of cands) {
          const s = f(c);
          if (s > bs) { second = bs; bs = s; b = c; } else if (s > second) second = s;
        }
        return bs >= 0.6 && bs > second ? b : -1; // must clear the threshold and be unique
      };
      const bestN = new Map(fo.map((o) => [o, best(fn, (n) => score(o, n))]));
      const bestO = new Map(fn.map((n) => [n, best(fo, (o) => score(o, n))]));
      for (const o of fo) {
        const n = bestN.get(o);
        if (n >= 0 && bestO.get(n) === o) pair(o, n);
      }
    }
  }
  return n2o;
}

module.exports = { hashText, normalizeText, wordHashes, reconcile, jaccard };
