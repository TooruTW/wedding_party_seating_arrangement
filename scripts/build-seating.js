#!/usr/bin/env node
/**
 * Seat: validate sync → assign groups → resolve pending → preview in browser.
 * Prerequisite: guests.tags.json tagged (pending_list / invalid_list empty).
 * Usage: npm run build | node scripts/build-seating.js [--dry-run] [--no-open]
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, exec } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TAGS_PATH = path.join(ROOT, 'data', 'guests.tags.json');
const PREVIEW_URL = 'http://localhost:3000/output/groups-view.html';
const SERVE_PORT = 3000;

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const noOpen = args.has('--no-open');

function runStep(label, scriptRel, extraArgs = []) {
  console.log(`\n=== ${label} ===`);
  const script = path.join(ROOT, scriptRel);
  const result = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? 'unknown'})`);
  }
}

function assertTagsReady() {
  if (!fs.existsSync(TAGS_PATH)) {
    throw new Error('guests.tags.json not found — run npm run sync first');
  }
  const tags = JSON.parse(fs.readFileSync(TAGS_PATH, 'utf8'));
  const pending = tags.summary?.pending_list ?? [];
  const invalid = tags.summary?.invalid_list ?? [];
  if (pending.length || invalid.length) {
    console.error('\nbuild-seating: 請先完成標記再分組');
    if (pending.length) {
      console.error(`  pending_list (${pending.length}): ${pending.join(', ')}`);
      console.error('  → 在 guests.tags.json 補 relationship_ids（至少一個非表單四類）');
    }
    if (invalid.length) {
      for (const row of invalid) {
        const types = (row.error ?? []).map((e) => e[0]).join(', ');
        console.error(`  invalid: ${row.phone} [${types}]`);
      }
    }
    console.error('\n  流程：npm run sync → 手標 tags → npm run build');
    process.exit(1);
  }
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`, { shell: true });
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

function startPreviewServer() {
  const child = spawn('npx', ['serve', '.', '-l', String(SERVE_PORT)], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.unref();
  return child;
}

function main() {
  console.log('build-seating');
  if (dryRun) console.log('  (dry-run: 不寫檔)');
  if (noOpen) console.log('  (--no-open: 不啟動預覽 server)');

  runStep('1/3 sync-validate', 'scripts/sync-tags-from-raw.js', ['--validate']);
  assertTagsReady();

  const seatingArgs = dryRun ? ['--dry-run'] : [];
  runStep('2/3 assign-groups', 'seating/assign-groups.js', seatingArgs);
  runStep('3/3 resolve-groups-pending', 'seating/resolve-groups-pending.js', seatingArgs);

  if (noOpen || dryRun) {
    console.log('\n完成（未開預覽）');
    return;
  }

  startPreviewServer();
  setTimeout(() => {
    openBrowser(PREVIEW_URL);
    console.log(`\n預覽: ${PREVIEW_URL}`);
    console.log('（serve 在背景執行；關閉終端機或手動結束 node 行程即可停 server）');
  }, 800);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\nerror: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { runStep, assertTagsReady };
