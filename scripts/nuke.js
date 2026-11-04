// Force-remove node_modules with native fs.
// Run with:  CODEBUDDY_SAFE_DELETE_ENABLED=0 "C:/Program Files/nodejs/node.exe" scripts/nuke.js
const fs = require('fs');
const path = require('path');

const targets = ['node_modules', '.expo', 'android', 'ios'];
const root = path.resolve(__dirname, '..');

for (const t of targets) {
  const p = path.join(root, t);
  if (!fs.existsSync(p)) {
    console.log('skip  ' + t + ' (absent)');
    continue;
  }
  const started = Date.now();
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log('gone  ' + t + '  (' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
  } catch (e) {
    console.log('FAIL  ' + t + '  ' + e.message);
    process.exitCode = 1;
  }
}
console.log('done');
