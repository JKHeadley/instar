"""Score future tone rows against the 2026-11-03 frozen thresholds.

Reads gitignored raw samples locally; prints and writes ids/counts only.
Incumbent disagreements require independent review before any promotion.
"""
import collections
import json

SINCE = '2026-11-04T03:10:00Z'
PIN = 'jev-1.13.0'
OLD = ('raw_path', 'cli', 'config', 'endpoint', 'code', 'env', 'selfstop', 'steps', 'endrun')


def lines(name):
    with open(name, encoding='utf-8') as source:
        return [json.loads(line) for line in source if line.strip()]


samples = {row['id']: row for row in json.load(open('sample-tone.json', encoding='utf-8'))
           if row['ts'] >= SINCE}
base = {row['id']: row for row in lines('results-tone-future-base.jsonl')}
variant = {row['id']: row for row in lines('results-tone-future-variant.jsonl')}
# Frozen on 2026-11-03 19:10 PST; changing these requires a new holdout.
thresholds = {
    'style2': 0.5, 'slug2': 0.75, 'wall2': 0.85, 'hand2': 0.9,
    'park2': 0.9, 'raw_path': 0.9, 'cli': 0.9, 'config': 0.9,
    'endpoint': 0.9, 'code': 0.9, 'env': 0.9, 'selfstop': 0.9,
    'steps': 0.9, 'endrun': 0.9, 'junk2': 0.9, 'hash': 0.9,
    'stop2': 0.2,
}

complete = []
settled = []
incomplete = []
for key, sample in samples.items():
    a, b = base.get(key), variant.get(key)
    if not a or not b or not a.get('ok') or not b.get('ok') or a.get('model') != PIN or b.get('model') != PIN:
        incomplete.append(key)
        continue
    probabilities = dict(b['p'])
    probabilities.update({name: a['p'].get(name) for name in OLD})
    if not all(isinstance(probabilities.get(name), (int, float)) for name in thresholds):
        incomplete.append(key)
        continue
    complete.append(key)
    if all(probabilities[name] < threshold for name, threshold in thresholds.items()):
        settled.append(key)

conflicts = [key for key in settled if samples[key]['label'] == 'block']
review_passes = sorted((key for key in settled if samples[key]['label'] == 'pass'),
                       key=lambda key: (samples[key]['ts'], key))[:40]
report = {
    'since': SINCE,
    'model': PIN,
    'rows': len(samples),
    'complete': len(complete),
    'incompleteIds': incomplete,
    'incumbentBlocks': sum(row['label'] == 'block' for row in samples.values()),
    'settled': len(settled),
    'settledShare': len(settled) / len(samples) if samples else None,
    'conflictIds': conflicts,
    'conflictRules': dict(collections.Counter(samples[key]['rule'] for key in conflicts)),
    'settledIds': settled,
    'reviewPassIds': review_passes,
}
with open('result-tone-future.json', 'w', encoding='utf-8') as output:
    json.dump(report, output, indent=2)
print(json.dumps({key: value for key, value in report.items()
                  if key not in ('incompleteIds', 'conflictIds', 'settledIds', 'reviewPassIds')}))
