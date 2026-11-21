"""Cross-check three records of every tool call for one Claude session:
1. recorder.js (neutral PreToolUse/PostToolUse/PostToolUseFailure log, the instrument)
2. the Claude Code transcript (tool_use blocks, incl. virtual ones made from scripts)
3. Instar's own hook-event log (.instar/hook-events/<sid>.jsonl, written by hook-event-reporter.js)
Usage: python3 analyze.py <claude_session_id> <recorder_run_label_or_''> [since_iso]
"""
import json, sys, collections
sid = sys.argv[1]
since = sys.argv[3] if len(sys.argv) > 3 else ''
TR = f'~/<claude-config>/projects/-private-tmp-claude-501-cmx/{sid}.jsonl'
HE = f'/private/tmp/claude-501/cmx/.instar/hook-events/{sid}.jsonl'
REC = '/private/tmp/claude-501/cmx-lab/calls.jsonl'

# transcript tool_use ids + results
tr_use, tr_res = {}, {}
for l in open(TR):
    d = json.loads(l)
    if d.get('type') not in ('assistant', 'user'):
        continue
    if since and d.get('timestamp', '') < since:
        continue
    c = (d.get('message') or {}).get('content')
    if not isinstance(c, list):
        continue
    for b in c:
        if not isinstance(b, dict):
            continue
        if b.get('type') == 'tool_use':
            tr_use[b['id']] = (b.get('name'), bool(d.get('isVirtual')), json.dumps(b.get('input'))[:120])
        elif b.get('type') == 'tool_result':
            txt = b.get('content')
            txt = json.dumps(txt) if not isinstance(txt, str) else txt
            tr_res[b.get('tool_use_id')] = (bool(b.get('is_error')), txt[:140])

rec = collections.defaultdict(dict)
for l in open(REC):
    d = json.loads(l)
    if since and d['ts'] < since:
        continue
    if d.get('id'):
        rec[d['id']][d['ev']] = d

he = collections.Counter()
for l in open(HE):
    d = json.loads(l)
    if since and d['receivedAt'] < since:
        continue
    p = d['payload']
    he[(p.get('event'), p.get('tool_name'))] += 1

ids = set(tr_use) | set(rec)
rows = []
for i in ids:
    name = (tr_use.get(i) or (None,))[0] or next(iter(rec[i].values()))['tool']
    rows.append((name, i in tr_use, (tr_use.get(i) or (0, 0))[1], 'PreToolUse' in rec[i], 'PostToolUse' in rec[i], 'PostToolUseFailure' in rec[i], tr_res.get(i, (None,))[0]))
c = collections.Counter((r[0] if not r[0].startswith('mcp__') else 'mcp__*', r[1], r[3], r[4], r[5], r[6]) for r in rows)
print('name | in_transcript | recPre | recPost | recPostFail | transcript_is_error -> count')
for k, v in sorted(c.items(), key=str):
    print(k, v)
print('\nmissing from transcript:', [(r[0]) for r in rows if not r[1]])
print('missing PreToolUse in recorder:', [(r[0]) for r in rows if not r[3]])
succ = collections.Counter(r[0] for r in rows if r[4])
print('\nsucceeded calls by tool (recorder PostToolUse):', dict(succ))
print('instar hook-events PostToolUse by tool:', {k[1]: v for k, v in he.items() if k[0] == 'PostToolUse'})
print('instar hook-events other:', {str(k): v for k, v in he.items() if k[0] != 'PostToolUse'})
