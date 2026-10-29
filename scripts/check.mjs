// Offline checks: runs every scripts/check-*.mjs in its own process and reports the total.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter((f) => /^check-.+\.mjs$/.test(f)).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n# ${f}`);
  const r = spawnSync(process.execPath, [`${dir}${f}`], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} of ${files.length} check files failed` : `\nall ${files.length} check files passed`);
process.exit(failed ? 1 : 0);
