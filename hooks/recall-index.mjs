// SessionEnd hook: start the incremental recall index build in a detached process and return at once, so
// closing Claude Code never waits on it. `--build` is that process: one build at a time, then exit.
// Recall off (`loadout recall off`), or anything unexpected: nothing happens.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadoutHome } from '../src/pack.mjs';
import { buildIndex, recallDir } from '../src/recall/index.mjs';
import { stampHook } from './last-hook.mjs';

const STALE_LOCK_MS = 10 * 60 * 1000;

function recallOn(home) {
  try {
    const v = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).recall;
    return v !== 'off' && v !== false;
  } catch {
    return true;
  }
}

try {
  const home = loadoutHome();
  if (process.argv[2] === '--build') {
    const dir = recallDir(home);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, 'build.lock');
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
    } catch {}
    let fd;
    try {
      fd = openSync(lock, 'wx');
    } catch {
      process.exit(0); // another build is running
    }
    try {
      await buildIndex({ home });
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
  } else {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    stampHook('SessionEnd', input);
    if (recallOn(home)) {
      spawn(process.execPath, [fileURLToPath(import.meta.url), '--build'], { detached: true, stdio: 'ignore', env: process.env }).unref();
    }
  }
} catch {}
