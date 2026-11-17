#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const args = process.argv.slice(2).filter((arg) => arg !== '--dry-run');

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/release.js [--dry-run]');
  console.log('Checks a clean, pushed main branch, then creates and pushes the manifest version tag.');
  process.exit(0);
}
if (args.length) throw new Error(`Unknown argument: ${args[0]}`);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${commandArgs.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
  return (result.stdout || '').trim();
}

function fail(message) {
  throw new Error(message);
}

try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`manifest.json version must be x.y.z; found ${version}`);

  const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
  if (versions[version] !== manifest.minAppVersion) {
    fail(`versions.json must map ${version} to minAppVersion ${manifest.minAppVersion}`);
  }
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (!new RegExp(`^##\\s+${version.replaceAll('.', '\\.')}([\\s(]|$)`, 'm').test(changelog)) {
    fail(`CHANGELOG.md needs a heading for ${version}`);
  }

  if (run('git', ['branch', '--show-current']) !== 'main') fail('Release from the main branch.');
  if (run('git', ['status', '--porcelain'])) fail('Commit or discard all working-tree changes before releasing.');
  const origin = run('git', ['remote', 'get-url', 'origin']);

  run('git', ['fetch', '--quiet', 'origin', 'main']);
  if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', 'FETCH_HEAD'])) {
    fail('Push the current main branch to origin before creating a release tag.');
  }
  if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${version}`])) {
    fail(`Remote tag ${version} already exists.`);
  }

  run(process.execPath, ['scripts/build.js', '--check']);
  for (const file of ['.github/workflows/release.yml', 'main.js', 'manifest.json', 'styles.css']) {
    if (!fs.existsSync(path.join(root, file))) fail(`Release asset is missing: ${file}`);
  }

  const localTag = run('git', ['tag', '--list', version]);
  if (localTag) {
    if (run('git', ['rev-parse', `${version}^{commit}`]) !== run('git', ['rev-parse', 'HEAD'])) {
      fail(`Local tag ${version} exists but does not point to HEAD.`);
    }
    if (run('git', ['cat-file', '-t', `refs/tags/${version}`]) !== 'tag') {
      fail(`Local tag ${version} is lightweight; create an annotated tag instead.`);
    }
  }

  if (dryRun) {
    console.log(`Release checks passed. Would ${localTag ? 'push existing' : 'create and push'} tag ${version}.`);
  } else {
    if (!localTag) run('git', ['tag', '-a', version, '-m', version], { stdio: 'inherit' });
    run('git', ['push', 'origin', `refs/tags/${version}`], { stdio: 'inherit' });
    console.log(`Pushed ${version}. GitHub Actions will build the assets and create a draft release.`);
    const repo = origin.replace(/\.git$/, '').match(/github\.com[:/]([^/]+\/[^/]+)$/)?.[1];
    if (repo) console.log(`Track the workflow: https://github.com/${repo}/actions/workflows/release.yml`);
  }
} catch (error) {
  console.error(`Release stopped: ${error.message}`);
  process.exitCode = 1;
}
