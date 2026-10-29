// UserPromptSubmit hook: when the prompt matches playbooks of the active loadout, send just those.
// `ask` (default): offer up to two, once per session, with a one-line cue for the user. `auto`: the
// best one, to follow. `off`: nothing. Then local recall: when the prompt is clearly about work from the owner's
// own earlier sessions, a short note on how it went, each past task once per session. Every other prompt, or
// anything unexpected: exit 0, no output.
import { MAX_PLAYBOOK_MD, markOffered, offeredIn, playbooksFor, readActive, readForgotten, readPack, readSuggestMode, renderOfferMd, renderPlaybookMd, withoutForgotten } from '../src/pack.mjs';
import { markRecalled, quiet, recallBanner, recallFor, recalledIn, recallOn, readCandidates, renderRecall, whereIs } from '../src/recall/query.mjs';
import { stampHook } from './last-hook.mjs';

try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  stampHook('UserPromptSubmit', input);
  const event = JSON.parse(input);
  const prompt = String(event.prompt ?? '').trim();
  const parts = [];
  try {
    const mode = readSuggestMode();
    const active = mode !== 'off' && !prompt.startsWith('/') && readActive();
    if (active) {
      const loadout = withoutForgotten(await readPack(active.path), readForgotten(active.handle));
      let out = null;
      if (mode === 'auto') {
        const [playbook] = playbooksFor(loadout, prompt, { limit: 1 });
        const md = playbook && renderPlaybookMd(loadout, playbook);
        if (md) out = { additionalContext: md };
      } else {
        const seen = offeredIn(event.session_id);
        const playbooks = playbooksFor(loadout, prompt).filter((p) => !seen.includes(p.id));
        if (playbooks.length) {
          try {
            markOffered(event.session_id, playbooks.map((p) => p.id), { transcript: event.transcript_path });
          } catch {}
          out = { additionalContext: renderOfferMd(loadout, playbooks), systemMessage: `loadout: ${playbooks.map((p) => p.name).join(', ')}` };
        }
      }
      if (out && out.additionalContext.length <= MAX_PLAYBOOK_MD) parts.push(out);
    }
  } catch {}
  try {
    const { tasks, counts } = !quiet(prompt) && recallOn() ? readCandidates(prompt) : { tasks: [] };
    // With a playbook already on this prompt, one past task at most.
    const hits = tasks.length ? recallFor(prompt, tasks, { ...whereIs(event.cwd), counts, exclude: [event.session_id, ...recalledIn(event.session_id)], limit: parts.length ? 1 : 2 }) : [];
    if (hits.length) {
      try {
        markRecalled(event.session_id, hits.map((h) => h.task.id));
      } catch {}
      parts.push({ additionalContext: renderRecall(hits), systemMessage: recallBanner(hits) });
    }
  } catch {}
  if (parts.length) {
    const systemMessage = parts.map((p) => p.systemMessage).filter(Boolean).join(' · ');
    process.stdout.write(JSON.stringify({
      ...(systemMessage ? { systemMessage } : {}),
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.map((p) => p.additionalContext).join('\n\n') },
    }));
  }
} catch {}
