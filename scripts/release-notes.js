'use strict';

const fs = require('fs');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/release-notes.js <version>');
  process.exit(1);
}

const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const lines = changelog.split(/\r?\n/);
const heading = `## ${version}`;
const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));

if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}

const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
const section = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();

if (!section) {
  console.error(`CHANGELOG.md section for ${version} is empty`);
  process.exit(1);
}

process.stdout.write(`${section}\n`);
