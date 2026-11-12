#!/usr/bin/env python3
"""B-lite trial measure: match each bugs-overseer run to the one transcript that starts
within 30 s after it in the agent's own project (cost report attributes no tokens; see
fb-1ef45b3a-3f5). Usage: measure.py <auth-file> <from-iso> <to-iso> <out.json>"""
import json, sys, urllib.request, datetime
auth, frm, to, out = sys.argv[1:5]
H = {'Authorization': 'Bearer ' + open(auth).read().strip()}
BASE = 'http://192.168.87.47:4042'
def get(p):
    return json.load(urllib.request.urlopen(urllib.request.Request(BASE + p, headers=H), timeout=60))
ts = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000
lo, hi = ts(frm), ts(to)
runs = [r for r in get('/jobs/bugs-overseer/history?limit=200')['runs'] if lo <= ts(r['startedAt']) < hi]
rows = []
for r in sorted(runs, key=lambda r: r['startedAt']):
    t = ts(r['startedAt'])
    # top sessions with events since 60 s before this run; a session that starts after
    # `since` is counted whole. The endpoint caps at 500 (largest first).
    sess = get('/tokens/sessions?limit=500&since=%d' % int(t - 60000))['sessions']
    sess = [s for s in sess if s['projectPath'].rstrip('/').endswith('/agents/echo')]
    c = [s for s in sess if 0 <= s['firstTs'] - t <= 30000]
    rows.append({'runId': r['runId'], 'startedAt': r['startedAt'], 'result': r.get('result'),
                 'model': r.get('model'), 'launch': r.get('launch'),
                 'match': c[0]['sessionId'] if len(c) == 1 else None, 'candidates': len(c),
                 'tokens': c[0]['totalTokens'] if len(c) == 1 else None})
m = [x['tokens'] for x in rows if x['tokens'] is not None]
summary = {'window': [frm, to], 'runs': len(rows), 'matched': len(m),
           'success': sum(1 for x in rows if x['result'] == 'success'),
           'failure': sum(1 for x in rows if x['result'] not in ('success', 'pending', None)),
           'tokensTotal': sum(m), 'tokensMeanPerMatchedRun': (sum(m) / len(m)) if m else None,
           'tokensMedian': sorted(m)[len(m)//2] if m else None}
json.dump({'summary': summary, 'rows': rows}, open(out, 'w'), indent=1)
print(json.dumps(summary))
