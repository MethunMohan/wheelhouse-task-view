'use strict';
// Markdown scanning: extract checkbox tasks from note text. Pure, no Obsidian dependency.
const { hashText, normalizeText, wordHashes } = require('./task-identity');

const FENCE_RE = /^(?:[ \t]*>)*[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const TASK_RE = /^((?:[ \t]*>)*)([ \t]*)([-*+])[ \t]+\[([ xX])\][ \t]+(\S.*?)[ \t]*$/;
const BLANK_RE = /^[ \t]*$/;
const OPEN_BOX_RE = /^((?:[ \t]*>)*[ \t]*[-*+][ \t]+\[)[ ](\])/;

const widthOf = (s) => s.replace(/\t/g, '    ').length;

function lineSignature(line) {
  return hashText(normalizeText(line.replace(/^(?:[ \t]*>)*/, '').replace(/\[[ xX]\]/, '[]')));
}

/**
 * Parse note content into tasks (open AND completed; callers filter).
 * Skips YAML front matter and fenced code blocks. Nested tasks are separate
 * entries carrying depth and parent info.
 */
function parseTasks(content) {
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  let i = 0;
  if (lines.length && lines[0].trim() === '---') {
    for (let j = 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === '---' || t === '...') { i = j + 1; break; }
    }
  }
  const tasks = [];
  const stack = [];
  let fence = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!fence) {
        if (!(ch === '`' && fm[2].includes('`'))) fence = { ch, len };
      } else if (ch === fence.ch && len >= fence.len && BLANK_RE.test(fm[2])) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    const m = TASK_RE.exec(line);
    if (!m) {
      if (!BLANK_RE.test(line)) {
        const ind = widthOf(/^[ \t]*/.exec(line.replace(/^(?:[ \t]*>)*/, ''))[0]);
        while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
      }
      continue;
    }
    const indent = widthOf(m[2]);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1] || null;
    tasks.push({
      line: i,
      checked: m[4] !== ' ',
      text: m[5],
      depth: stack.length,
      parentText: parent ? parent.text : '',
    });
    stack.push({ indent, text: m[5] });
  }
  const sig = (idx, dir) => {
    for (let k = idx + dir; k >= 0 && k < lines.length; k += dir) {
      if (!BLANK_RE.test(lines[k])) return lineSignature(lines[k]);
    }
    return '';
  };
  for (const t of tasks) {
    if (t.checked) continue;
    t.h = hashText(normalizeText(t.text));
    t.w = wordHashes(t.text);
    t.cp = sig(t.line, -1);
    t.cn = sig(t.line, 1);
  }
  return tasks;
}

/** Tick the open checkbox on one line; returns new content, or null if that line is not an open task. */
function checkLine(content, lineNo) {
  const lines = content.split('\n');
  const l = lines[lineNo];
  if (l === undefined || !OPEN_BOX_RE.test(l)) return null;
  lines[lineNo] = l.replace(OPEN_BOX_RE, '$1x$2');
  return lines.join('\n');
}

/** Plain-text rendering of task text for display (links flattened, block id removed). */
function displayText(text) {
  return text
    .replace(/\s\^[A-Za-z0-9-]+$/, '')
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

module.exports = { parseTasks, checkLine, displayText };
