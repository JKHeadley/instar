// Agent-side waits belong on the Agent door, not in the person's action list (work-front-doors §2.1).
import { readableIssues } from './health-model.js';

export function agentHealthNote(res) {
  const d = readableIssues(res);
  if (!d) return 'unknown';
  if (d.issues.some((i) => i && i.impact === 'user-affecting' && i.requiresUserAction === false)) return 'note';
  if (d.truncated || d.verdict === 'unsure' || d.issues.some((i) => !i || typeof i.impact !== 'string')) return 'unknown';
  return 'clear';
}

let stopPrevious = null;
export function mountAgentHealthNote(anchor, { get }) {
  if (stopPrevious) stopPrevious();
  if (!anchor) return;
  const dot = document.createElement('span');
  dot.setAttribute('role', 'img');
  anchor.append(dot);
  let stopped = false;
  let busy = false;
  const paint = (state) => {
    dot.hidden = state === 'clear';
    dot.className = `dot ${state === 'note' ? 'attn' : 'unknown'}`;
    const words = state === 'note' ? 'Agent status: work is waiting. See Health.' : 'Agent status could not be read. See Health.';
    dot.setAttribute('aria-label', words);
    dot.title = words;
  };
  paint('unknown');
  const load = async () => {
    if (stopped) return;
    if (!anchor.isConnected) { stop(); return; }
    if (busy || document.visibilityState === 'hidden') return;
    busy = true;
    let state;
    try { state = agentHealthNote(await get('/mobile/health-issues')); }
    catch { state = 'unknown'; } // A failed read is visible; never report a clear status.
    finally { busy = false; }
    if (!stopped && anchor.isConnected) paint(state);
  };
  const timer = setInterval(load, 45000);
  const stop = () => { stopped = true; clearInterval(timer); dot.remove(); };
  stopPrevious = stop;
  void load();
  return stop;
}
