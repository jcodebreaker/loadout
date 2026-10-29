// Local review page for a draft loadout. The owner toggles, bundles personal skills, renames playbooks and rewords rules; everything else (checks,
// openings, the CLAUDE.md text) is read-only.
// Logs only to stderr.
import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const log = (...args) => console.error('loadout:', ...args);
const PAGE = new URL('page.html', import.meta.url);

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const body = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error('body too large');
  }
  return JSON.parse(raw || '{}');
};

// The only editable fields: list -> per-item keys that may change.
const EDITABLE = [
  [(d) => d.playbooks, ['name', 'include']],
  [(d) => d.patterns, ['include']],
  [(d) => d.kit?.skills, ['include']],
  [(d) => d.kit?.mcp, ['include']],
  [(d) => d.rules, ['text', 'include']],
  [(d) => (d.claudeMd == null ? d.claudeMd : [d.claudeMd]), ['include']],
];

const stable = (v) =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : JSON.stringify(v);

// Returns an error string, or null when `next` differs from `current` only in editable fields.
export function checkEdit(current, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return 'Expected a draft object.';
  const strip = (d) => {
    const copy = structuredClone(d);
    for (const [list, keys] of EDITABLE) {
      const items = list(copy);
      if (Array.isArray(items)) for (const item of items) if (item && typeof item === 'object') for (const k of keys) delete item[k];
    }
    // A personal skill with files can be bundled.
    for (const s of copy.kit?.skills ?? []) if (s?.source?.kind === 'personal' && s.files) delete s.source.bundled;
    return copy;
  };
  for (const [list, keys] of EDITABLE) {
    const a = list(current), b = list(next);
    if (a == null && b == null) continue; // an older draft without this list; the strict compare below still applies
    if (!Array.isArray(b) || b.length !== (a ?? []).length) return 'Items cannot be added or removed.';
    for (const item of b) {
      if (!item || typeof item !== 'object') return 'Invalid item.';
      if ('include' in item && typeof item.include !== 'boolean') return 'include must be true or false.';
      if (keys.includes('name') && (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80)) return 'A playbook name must be 1 to 80 characters.';
      if (keys.includes('text') && (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 140)) return 'A rule must be 1 to 140 characters.';
      if (item.source?.bundled !== undefined && typeof item.source.bundled !== 'boolean') return 'bundled must be true or false.';
    }
  }
  if (stable(strip(current)) !== stable(strip(next))) return 'Only names, rule wording, include and bundle switches can change.';
  return null;
}

function openBrowser(url) {
  const [cmd, ...args] =
    process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', (err) => log(`could not open the browser (${err.message}); open ${url}`));
  child.unref();
}

// Resolves with { url, close, done }. `done` resolves { publish: true } when the owner presses publish,
// and { publish: false } when they close without publishing or close() is called.
export async function startReview({ draftPath, open = true }) {
  const read = async () => JSON.parse(await readFile(draftPath, 'utf8'));
  await read(); // fail early on a missing or broken draft
  let finish;
  const done = new Promise((resolve) => (finish = resolve));

  const routes = {
    'GET /': async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(await readFile(PAGE));
    },
    'GET /api/draft': async (req, res) => json(res, 200, await read()),
    'POST /api/draft': async (req, res) => {
      const next = await body(req);
      const error = checkEdit(await read(), next);
      if (error) return json(res, 400, { error });
      const tmp = `${draftPath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
      await rename(tmp, draftPath);
      json(res, 200, { ok: true });
    },
    'POST /api/done': async (req, res) => {
      json(res, 200, { ok: true });
      setImmediate(() => close({ publish: true }));
    },
    'POST /api/close': async (req, res) => {
      json(res, 200, { ok: true });
      setImmediate(close);
    },
  };

  const http = createServer(async (req, res) => {
    const route = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
    if (!route) return json(res, 404, { error: 'not found' });
    try {
      await route(req, res);
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: err.message });
    }
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${http.address().port}`;
  log(`review your loadout at ${url}`);

  function close({ publish = false } = {}) {
    http.close();
    http.closeAllConnections?.();
    finish({ publish });
  }
  if (open && process.env.LOADOUT_NO_OPEN !== '1') openBrowser(url);
  return { url, close, done };
}
