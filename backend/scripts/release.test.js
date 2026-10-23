'use strict';
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('backend static release preflight passes', () => {
  const script = path.join(__dirname, 'check-release.js');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
});
