// SessionStart hook: inject the active loadout's LOADOUT.md once. No active loadout,
// or anything unexpected: exit 0 with no output.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LOADOUT_MD, readActive } from '../src/pack.mjs';
import { stampHook } from './last-hook.mjs';

try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  stampHook('SessionStart', input);
  const active = readActive();
  const md = active && readFileSync(join(active.path, 'LOADOUT.md'), 'utf8');
  if (md && Buffer.byteLength(md) <= MAX_LOADOUT_MD) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `The user turned on ${active.handle}'s loadout. Follow it as the loadout skill describes.\n\n${md}`,
      },
    }));
  }
} catch {}
