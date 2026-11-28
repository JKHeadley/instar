#!/usr/bin/env python3
"""Offline, data-only context replay. Never launches a model or executes answers."""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

ARMS = ("none", "reduced", "full")
MAX_BYTES = 4 * 1024 * 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def exact(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys),
            "Unexpected or missing fields")


def ids(values):
    require(isinstance(values, list) and all(isinstance(v, str) and v for v in values),
            "Expected nonempty string identifiers")
    require(len(set(values)) == len(values), "Duplicate identifiers")
    return values


def number(value):
    require(type(value) in (int, float) and 0 <= value <= 10**15 and math.isfinite(value),
            "Cost must be a finite nonnegative number")
    return value


def validate_answer(answer):
    require(isinstance(answer, dict), "Answer must be an object")
    require(set(answer) in ({'staleIds', 'unavailableIds'},
                           {'staleIds', 'unavailableIds', 'storeStatus'}), "Invalid answer fields")
    ids(answer['staleIds'])
    ids(answer['unavailableIds'])
    require(not set(answer['staleIds']) & set(answer['unavailableIds']), "Conflicting answer")
    require(answer.get('storeStatus', 'available') in ('available', 'unavailable'), "Invalid store status")


def prepare(inputs, specification):
    """Separate preparation from label access. Output is the exact trial payload."""
    exact(inputs, ("status", "clock", "cases"))
    exact(specification, ("mandatory", "question", "reduced", "full", "repeats",
                          "criticalCases", "rules", "provenance"))
    for key in ("mandatory", "question", "reduced", "full"):
        require(isinstance(specification[key], str) and specification[key].strip(),
                "Context and question must be explicit nonempty strings")
    require(specification['reduced'] != specification['full'], "Contexts must differ")
    repeats = specification['repeats']
    require(type(repeats) is int and 2 <= repeats <= 20, "Require 2..20 paired repeats")
    require(isinstance(inputs['clock'], str) and inputs['clock'], "Fixed clock required")
    require(isinstance(inputs['cases'], list) and 0 < len(inputs['cases']) <= 1000,
            "Require 1..1000 scenarios")
    case_ids = ids([c.get('id') for c in inputs['cases'] if isinstance(c, dict)])
    require(len(case_ids) == len(inputs['cases']), "Scenario must be an object")
    require(set(ids(specification['criticalCases'])) <= set(case_ids), "Unknown critical case")
    rules = specification['rules']
    exact(rules, ('acceptableLoss', 'uncertaintyMethod', 'stopping', 'costHorizonTasks'))
    require(number(rules['acceptableLoss']) <= 1, "Loss must be between zero and one")
    require(rules['uncertaintyMethod'] == 'descriptive-only-no-qualification',
            "Offline runner only supports descriptive uncertainty")
    require(rules['stopping'] == 'fixed-complete-grid-no-early-stop', "Fixed stopping required")
    require(type(rules['costHorizonTasks']) is int and 0 < rules['costHorizonTasks'] <= 10**9,
            "Positive integer cost horizon required")
    exact(specification['provenance'], ('model', 'harness', 'accountRoute', 'evidenceDate', 'source'))
    require(all(isinstance(v, str) and v.strip() for v in specification['provenance'].values()),
            "Explicit provenance required, including synthetic/imported source")
    trials = []
    for case in inputs['cases']:
        for repeat in range(repeats):
            for arm in ARMS:
                trials.append({'id': f"{case['id']}:{repeat}:{arm}", 'caseId': case['id'],
                               'repeat': repeat, 'arm': arm,
                               'payload': {'mandatory': specification['mandatory'],
                                           'question': specification['question'],
                                           'context': '' if arm == 'none' else specification[arm],
                                           'clock': inputs['clock'], 'fixture': case}})
    plan = {'version': 1, 'mode': 'offline-import-only',
            'runnerHash': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'inputStatus': inputs['status'], 'inputHash': digest(inputs),
            'specification': specification, 'trials': trials}
    plan['planHash'] = digest(plan)
    require(len(canonical(plan).encode()) <= MAX_BYTES, "Generated plan exceeds 4 MiB limit")
    return plan


def validate_plan(plan):
    exact(plan, ('version', 'mode', 'runnerHash', 'inputStatus', 'inputHash', 'specification', 'trials', 'planHash'))
    unsigned = {k: v for k, v in plan.items() if k != 'planHash'}
    require(plan['planHash'] == digest(unsigned), "Plan hash mismatch")
    require(plan['version'] == 1 and plan['mode'] == 'offline-import-only', "Unsupported plan")
    require(isinstance(plan['trials'], list) and plan['trials'], "Empty trial grid")
    # Rebuild the complete grid rather than trusting a self-consistent supplied hash.
    cases = []
    seen = set()
    for trial in plan['trials']:
        if trial['caseId'] not in seen:
            cases.append(trial['payload']['fixture'])
            seen.add(trial['caseId'])
    # Preserve the input status without exposing or relying on its wording.
    inputs = {'status': plan.get('inputStatus'), 'clock': plan['trials'][0]['payload']['clock'],
              'cases': cases}
    rebuilt = prepare(inputs, plan['specification'])
    require(rebuilt == plan, "Changed or incomplete trial grid")


def interpret(payload, actions):
    """No eval, callbacks, imports, subprocesses or paths derived from answer data.

    The only lookup returns a copy of the already supplied fixture. Every other
    action is a recorded refusal. This is a data interpreter, not a code sandbox.
    """
    if not isinstance(actions, list) or not 1 <= len(actions) <= 32:
        return {'answer': None, 'refusals': ['invalid-action-sequence'], 'fixtureReads': 0}
    reads, denied, final = [], [], None
    finished = False
    for action in actions:
        if not isinstance(action, dict):
            denied.append('malformed-action')
            continue
        kind = action.get('kind')
        if finished:
            denied.append('action-after-final')
        elif kind == 'fixture' and set(action) == {'kind', 'id'} and action['id'] == payload['fixture']['id']:
            reads.append(json.loads(canonical(payload['fixture'])))
        elif kind == 'final' and set(action) == {'kind', 'answer'}:
            answer = action['answer']
            try:
                validate_answer(answer)
                final = json.loads(canonical(answer))
            except ValueError:
                denied.append('invalid-final')
            finished = True
        else:
            # Do not copy potentially secret/path-bearing arguments into reports.
            denied.append('forbidden-action')
    return {'answer': final, 'refusals': denied, 'fixtureReads': len(reads)}


def score(plan, labels, transcripts, costs):
    validate_plan(plan)
    require(isinstance(labels, dict) and isinstance(labels.get('cases'), list), "Labels required")
    label_ids = ids([c['id'] for c in labels['cases']])
    by_label = dict(zip(label_ids, labels['cases']))
    for label in labels['cases']:
        validate_answer(label['expected'])
    require(set(by_label) == {t['caseId'] for t in plan['trials']}, "Labels must match cases exactly")
    exact(transcripts, ('planHash', 'trials'))
    require(transcripts['planHash'] == plan['planHash'], "Transcript belongs to another plan")
    require(isinstance(transcripts['trials'], list), "Trial transcripts required")
    for row in transcripts['trials']:
        exact(row, ('id', 'actions'))
    transcript_ids = ids([r['id'] for r in transcripts['trials']])
    require(set(transcript_ids) == {t['id'] for t in plan['trials']}, "Complete paired grid required")
    by_trial = dict(zip(transcript_ids, transcripts['trials']))
    exact(costs, ('unit', 'qualification', 'servingPerTask'))
    require(costs['unit'] in ('tokens', 'USD'), "Declare one common cost unit")
    components = {'assembly', 'answering', 'tools', 'checks', 'repeats', 'judging', 'retries', 'fallback'}
    for group in (costs['qualification'], costs['servingPerTask']):
        exact(group, components)
        for value in group.values():
            number(value)
    results = []
    for trial in plan['trials']:
        result = interpret(trial['payload'], by_trial[trial['id']]['actions'])
        expected = by_label[trial['caseId']]['expected']
        answer = result['answer']
        correct = answer is not None and all(
            sorted(answer.get(k, [])) == sorted(v) if isinstance(v, list) else answer.get(k) == v
            for k, v in expected.items())
        result.update({k: trial[k] for k in ('id', 'arm', 'caseId', 'repeat')})
        result.update({'correct': correct and not result['refusals'],
                       'critical': trial['caseId'] in plan['specification']['criticalCases']})
        results.append(result)
    grouped = {arm: [r for r in results if r['arm'] == arm] for arm in ARMS}
    summary = {arm: {'passed': sum(r['correct'] for r in rows), 'total': len(rows),
                     'criticalFailures': sum(r['critical'] and not r['correct'] for r in rows),
                     'refusedActions': sum(len(r['refusals']) for r in rows)}
               for arm, rows in grouped.items()}
    disagreements = []
    context_evidence = []
    for case_id in label_ids:
        full = [r for r in grouped['full'] if r['caseId'] == case_id]
        signatures = {canonical({'answer': {k: sorted(v) if isinstance(v, list) else v
                                            for k, v in r['answer'].items()} if r['answer'] else None,
                                 'refusals': r['refusals']}) for r in full}
        if len(signatures) > 1:
            disagreements.append(case_id)
        none = [r for r in grouped['none'] if r['caseId'] == case_id]
        if all(r['correct'] for r in full) and not all(r['correct'] for r in none):
            context_evidence.append(case_id)
    return {'status': 'offline-replay-not-qualification', 'planHash': plan['planHash'],
            'labelsHash': digest(labels), 'transcriptsHash': digest(transcripts),
            'costsHash': digest(costs), 'results': results, 'summary': summary,
            'fullRepeatDisagreements': disagreements,
            'possibleContextDependentCases': context_evidence,
            'costs': {'reportedNotMeasured': costs,
                      'combinedHorizon': sum(costs['qualification'].values()) +
                      plan['specification']['rules']['costHorizonTasks'] * sum(costs['servingPerTask'].values())},
            'adoptionAuthorized': False}


def load(path):
    with Path(path).open('rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    require(len(data) <= MAX_BYTES, "Input exceeds 4 MiB limit")
    def unique(pairs):
        out = {}
        for key, value in pairs:
            require(key not in out, "Duplicate JSON key")
            out[key] = value
        return out
    def invalid(_):
        raise ValueError('Nonfinite JSON number')
    return json.loads(data, object_pairs_hook=unique, parse_constant=invalid)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare')
    prep.add_argument('--inputs', required=True)
    prep.add_argument('--specification', required=True)
    grade = commands.add_parser('score')
    for name in ('plan', 'labels', 'transcripts', 'costs'):
        grade.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            result = prepare(load(args.inputs), load(args.specification))
        else:
            result = score(load(args.plan), load(args.labels), load(args.transcripts), load(args.costs))
        print(canonical(result))
    except (ValueError, KeyError, TypeError, OSError, RecursionError) as error:
        # Paths, scenario text and secret-bearing arguments are never echoed.
        print('Replay refused: invalid or unreadable input (' + type(error).__name__ + ')', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
