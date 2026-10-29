// Stamp $LOADOUT_HOME/last-hook.json on every hook run, so `loadout doctor` can tell a loadout that is
// on but never injected (the plugin's hooks aren't running). Never throws: a full disk can't block a prompt.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadoutHome } from '../src/pack.mjs';

export function stampHook(event, input) {
  try {
    let session;
    try { session = JSON.parse(input).session_id; } catch {}
    const home = loadoutHome();
    mkdirSync(home, { recursive: true });
    const stamp = { event, at: new Date().toISOString(), ...(typeof session === 'string' && { session }) };
    writeFileSync(join(home, 'last-hook.json'), JSON.stringify(stamp));
  } catch {}
}
