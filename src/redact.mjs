// Strip private data from prompt text before anything is mined or shared.
// Every match becomes a short placeholder and only counts survive: the removed values are never kept.
// Rules run in a fixed order so wide matches (code, URLs) swallow what they contain before narrower ones run,
// and no rule matches a placeholder, so running twice changes nothing. When in doubt, a rule redacts.

const P = {
  paths: '‹path›',
  secrets: '‹secret›',
  emails: '‹email›',
  hosts: '‹host›',
  names: '‹name›',
  code: '‹code›',
  urls: '‹url›',
};
const isPlaceholder = (s) => /^‹\w+›$/.test(s);
const zero = () => ({ paths: 0, secrets: 0, emails: 0, hosts: 0, names: 0, code: 0, urls: 0 });
const add = (a, b) => {
  for (const k in a) a[k] += b[k];
  return a;
};
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A name of five or more letters also matches with spaces, dashes or underscores between them
// ("starfield" → "Star Field", "star-field").
const loose = (n) => (n.length >= 5 && /^[A-Za-z0-9]+$/.test(n) ? [...n].map(escape).join('[-_ ]?') : escape(n));
const COMMON_PARTS = new Set(['claude', 'plugin', 'skills', 'official', 'server', 'client', 'plugin', 'plugins', 'frontend', 'backend', 'mobile', 'worker', 'engine', 'shared', 'common', 'config', 'script', 'scripts', 'website', 'landing', 'service', 'services', 'native', 'stack', 'project', 'starter', 'template', 'monorepo', 'packages', 'desktop', 'extension']);

// Path characters stop at whitespace, quotes, backticks and brackets so `"/a/b"` and `(/a/b)` keep their wrappers.
const PC = String.raw`[^\s'"\`<>|(){}\[\],;‹›]`;
// Sentence punctuation after a path belongs to the sentence, not the path.
const keepTail = (m, kind) => {
  const tail = m.match(/[.:!?]+$/)?.[0] ?? '';
  return P[kind] + tail;
};

// Common public and private suffixes. A file extension (.js, .md, .sh, .py) is deliberately absent so
// "node.js" and "README.md" survive; a dotted name ending in one of these is treated as a host.
const TLDS = new Set(
  (
    'com net org io dev app ai co me us uk de fr nl es it se no fi dk ch at be pl cz eu ca au nz jp cn in br ru ' +
    'info biz xyz tech cloud site online page tools so gg tv fm to cc ly sg hk kr tw za mx ar cl ie pt gr ' +
    'internal local localdomain lan corp intra intranet svc cluster test example invalid onion'
  ).split(' '),
);

// Ordered rules. Each is [kind, regex, replacer?]; a replacer returning null leaves the match alone.
function rules(ctx) {
  const home = ctx.home ? String(ctx.home).replace(/[\\/]+$/, '') : '';
  const names = [...(ctx.repoNames ?? []), ...(ctx.extraNames ?? [])];
  // The home folder's basename is usually the OS username; treat it as a name too.
  const user = home.split(/[\\/]/).pop();
  if (user && user.length >= 4) names.push(user);
  // A repo is also written by its parts ("nova-starfield" → "starfield"), so long parts count as names,
  // unless they are ordinary words.
  for (const n of [...names]) for (const part of String(n).split(/[-_.\s]+/)) if (part.length >= 6 && part !== n && !COMMON_PARTS.has(part.toLowerCase())) names.push(part);
  const words = [...new Set(names.map((n) => String(n).trim()).filter((n) => n.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );

  const list = [
    // PEM blocks first: their base64 body would otherwise be split across several rules. Unterminated runs to the end.
    ['secrets', /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g],
    // Fenced code, closed or still open at the end.
    ['code', /^[ \t]*(```|~~~)[^\n]*\n?[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm],
    ['code', /`[^`\n]{41,}`/g],
    // Shell prompts pasted with terminal output carry the username, machine name and cwd; the whole prefix goes.
    // Runs before URLs and paths so `user@host:~/dir$` is not split into a URL or a path.
    ['hosts', /\[[\w.-]+@[\w.-]+(?:\s[^\]\n]*)?\][$#%]/g],
    ['hosts', /(?<![\w.+-])[\w.-]+@[\w.-]+:[^\s$#%]*[$#%](?=\s|$)/gm],
    ['hosts', /(?<![\w.+-])[\w.-]+@[\w.-]+ [^\s@]+ [%$#](?=\s|$)/gm],
    ['hosts', /\bPS [A-Za-z]:\\[^>\n]*>/g],
    // URLs whole, including credentials or tokens in them. `git@host:org/repo` is an scp-style URL.
    [
      'urls',
      /\b(?:https?|ftps?|wss?|file|ssh|git|svn|s3|gs|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|jdbc:[a-z]+|smb|ldaps?):\/\/[^\s<>"'`\])}‹›]+|\bwww\.[^\s<>"'`\])}‹›]+|\b[\w.-]+@[\w.-]+\.[a-z]{2,}:[\w./~-]+/gi,
      (m) => P.urls + (m.match(/[.,:;!?]+$/)?.[0] ?? ''),
    ],
    // Known key shapes.
    ['secrets', /\bsk-ant-[\w-]{10,}/g],
    ['secrets', /\bsk-(?:proj-|svcacct-|admin-)?[\w-]{16,}/g],
    ['secrets', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,})/g],
    ['secrets', /\bxox[abeoprs]-[\w-]{10,}/g],
    ['secrets', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g],
    ['secrets', /\bAIza[\w-]{30,}/g],
    ['secrets', /\b(?:sk|pk|rk)_(?:live|test)_\w{10,}|\bwhsec_\w{10,}/g],
    ['secrets', /\b(?:npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|dop_v1_[a-f0-9]{40,}|SG\.[\w-]{16,}\.[\w-]{16,})/g],
    // JWTs: header.payload.signature, header always base64url JSON ("eyJ").
    ['secrets', /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g],
    [
      'secrets',
      /\b(Bearer|Basic|Token)\s+([\w.~+/=-]{16,})/g,
      (m, scheme, value) => (isPlaceholder(value) || !/\d/.test(value) ? null : `${scheme} ${P.secrets}`),
    ],
    // `KEY=value` assignments, env files and inline `FOO=bar cmd`: the name stays, the value goes.
    [
      'secrets',
      /\b([A-Z][A-Z0-9_]{2,})=("[^"\n]*"|'[^'\n]*'|[^\s'"`]+)/g,
      (m, name, value) => (isPlaceholder(value) ? null : `${name}=${P.secrets}`),
    ],
    // A long token next to a secret-ish word: "token: abc123…", "password is hunter2hunter2".
    [
      'secrets',
      /\b((?:api[_ -]?)?(?:key|token|secret|password|passwd|pwd|pass|passphrase|auth|credentials?|apikey|access[_ -]?key)s?\b)(["']?\s*(?:[:=]|=>|->|\bis\b|\bwas\b)?\s*["']?)([\w+/=.~-]{16,})/gi,
      (m, word, sep, value) => (/\d/.test(value) && /[a-z]/i.test(value) ? `${word}${sep}${P.secrets}` : null),
    ],
    ['emails', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g],
    // `user@machine` with no dot is not an email but still names a person and a machine.
    // Package tags (`pkg@latest`, `react@18`) are kept.
    [
      'hosts',
      /(?<![\w.+@-])[\w.-]+@([A-Za-z][\w-]*)(?![\w@-]|\.\w)/g,
      (m, host) => (/^(?:latest|next|beta|alpha|canary|rc|stable|experimental|nightly|insiders|preview|lts)$/i.test(host) ? null : P.hosts),
    ],
    // Machine names without a dot: macOS and PC defaults like "janes-macbook-air" or "build-pc-2".
    [
      'hosts',
      /\b[A-Za-z0-9][\w-]*?-(?:macbook(?:-pro|-air)?|mbp|imac|mac-mini|mac-studio|laptop|desktop|pc|thinkpad|dell|hp)(?:-\d+)?(?![\w-])/gi,
    ],
    // A quoted or backticked path may contain spaces; take it up to the closing quote.
    [
      'paths',
      /([`'"])((?:~[\w.-]*\/|[A-Za-z]:[\\/]|\/(?:[\w.@+-]+\/)+)[^`'"\n]* [^`'"\n]*)\1/g,
      (m, q) => `${q}${P.paths}${q}`,
    ],
    // Paths. Home first so a home path is never half-matched as a relative remainder.
    ...(home ? [['paths', new RegExp(`${escape(home)}(?:[\\\\/]${PC}*)?(?![\\w.-])`, 'g'), (m) => keepTail(m, 'paths')]] : []),
    ['paths', new RegExp(`(?<![\\w~])~[\\w.-]*/${PC}*`, 'g'), (m) => keepTail(m, 'paths')],
    // Windows drive paths and UNC shares.
    ['paths', new RegExp(`(?<![\\w])[A-Za-z]:[\\\\/]${PC}*`, 'g'), (m) => keepTail(m, 'paths')],
    ['paths', new RegExp(`(?<![\\w\\\\])\\\\\\\\[\\w.$-]+\\\\${PC}*`, 'g'), (m) => keepTail(m, 'paths')],
    // Unix: two or more segments, or one well-known root. One segment alone is a slash command ("/review").
    [
      'paths',
      new RegExp(
        `(?<![\\w.:/~\\\\-])/(?:(?:Users|home|root|etc|var|tmp|opt|private|mnt|Volumes|srv|usr|Library|proc|dev|workspace|workspaces)\\b|[\\w.@+-]+/[\\w.@+-])${PC}*`,
        'g',
      ),
      (m) => keepTail(m, 'paths'),
    ],
    // Bare long hex (≥32) or mixed base64 (≥40) is too likely a token or hash to keep.
    ['secrets', /\b[a-f0-9]{32,}\b/gi],
    [
      'secrets',
      /(?<![\w+/])[A-Za-z0-9+/_-]{40,}={0,2}/g,
      (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? P.secrets : null),
    ],
    // IPv4 (optionally with port) and IPv6 with at least four groups and a hex letter, so times survive.
    ['hosts', /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g],
    [
      'hosts',
      /(?<![\w:])(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{1,4}(?![\w:])/gi,
      (m) => (/[a-f]/i.test(m) ? P.hosts : null),
    ],
    // Dotted names ending in a known suffix, with an optional port.
    [
      'hosts',
      /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})\b(?::\d{2,5})?/gi,
      // `.home` only in lowercase, so `process.env.HOME` survives.
      (m, tld) => (TLDS.has(tld.toLowerCase()) || tld === 'home' ? P.hosts : null),
    ],
  ];
  if (words.length) {
    list.push(['names', new RegExp(`(?<![A-Za-z0-9])(?:${words.map(loose).join('|')})(?![A-Za-z0-9])`, 'gi')]);
  }
  return list;
}

// Stack traces: runs of frame lines collapse into one placeholder. The message line above them stays.
const FRAME = [
  /^\s*at\s+\S.*(?:\(.*:\d+(?::\d+)?\)|:\d+:\d+)\s*$/, // JS / Java
  /^\s*at\s+[\w$.<>]+\((?:[\w$.]+:\d+|Native Method|Unknown Source)\)\s*$/, // Java
  /^\s*Traceback \(most recent call last\):\s*$/, // Python header
  /^\s*File ".*", line \d+/, // Python frame
  /^\s{2,}\S.*$/, // indented continuation (Python source line), only counted inside a run
  /^\s*#\d+\s+(?:0x[0-9a-f]+\s+in\s+)?\S/, // gdb / Ruby / PHP numbered frames
  /^\s*\S+\.(?:go|rs|rb|py|java|kt|swift|c|cc|cpp|ts|js|mjs|cjs|php):\d+(?::\d+)?\b/, // file:line
  /^goroutine \d+ \[/,
  /^\s*thread '.*' panicked at/,
];
function collapseStacks(text, counts) {
  if (!/^\s*(?:at\s|Traceback|File "|#\d|goroutine|\S+\.\w+:\d)/m.test(text)) return text;
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; ) {
    // A run must start on a real frame, not on an indented line, and needs two lines (or a Traceback header).
    const strong = (l) => FRAME.some((r, k) => k !== 4 && r.test(l));
    if (!strong(lines[i])) {
      out.push(lines[i++]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && FRAME.some((r) => r.test(lines[j]))) j++;
    if (j - i >= 2 || /Traceback|^\s*at\s|^\s*File "/.test(lines[i])) {
      out.push(P.code);
      counts.code++;
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return out.join('\n');
}

export function redactText(text, ctx = {}) {
  const removed = zero();
  if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', removed };
  let out = text;
  const list = rules(ctx);
  // Code blocks and PEM come before stack traces so a fenced trace counts once, as code.
  for (const [kind, re, fn] of list.slice(0, 3)) out = apply(out, kind, re, fn, removed);
  out = collapseStacks(out, removed);
  for (const [kind, re, fn] of list.slice(3)) out = apply(out, kind, re, fn, removed);
  return { text: out, removed };
}

// Only the secrets rules, plus passwords in URLs: for the owner's own local text (recall), which keeps
// paths, names and code but never a key or token.
let SECRET_RULES;
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  SECRET_RULES ??= [
    ['secrets', /(\b[a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (m, head) => `${head}${P.secrets}@`],
    ...rules({}).filter(([kind]) => kind === 'secrets'),
  ];
  let out = text;
  for (const [kind, re, fn] of SECRET_RULES) out = apply(out, kind, re, fn, zero());
  return out;
}

function apply(text, kind, re, fn, counts) {
  return text.replace(re, (...args) => {
    const r = fn ? fn(...args) : P[kind];
    if (r == null) return args[0];
    counts[kind]++;
    return r;
  });
}

export function redactSession(session, ctx = {}) {
  const removed = zero();
  const events = (list) =>
    (list ?? []).map((e) => {
      if (e?.kind !== 'prompt') return { ...e };
      const r = redactText(e.text, ctx);
      add(removed, r.removed);
      return { ...e, text: r.text };
    });
  const out = {
    ...session,
    events: events(session?.events),
    subagents: (session?.subagents ?? []).map((s) => ({ ...s, events: events(s.events) })),
  };
  // cwdName is already a basename, but it may be the repo or client name itself.
  if (typeof out.cwdName === 'string' && out.cwdName) {
    const r = redactText(out.cwdName, { ...ctx, home: '' });
    if (r.removed.names) {
      out.cwdName = P.names;
      removed.names++;
    }
  }
  return { session: out, removed };
}

export function redactDeep(obj, ctx = {}) {
  const removed = zero();
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redactText(v, ctx);
      add(removed, r.removed);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return { value: walk(obj), removed };
}
