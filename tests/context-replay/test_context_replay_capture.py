import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'evaluation'))
from context_replay_capture import checked_result, classify_answer


class CaptureStreamTest(unittest.TestCase):
    def stream(self, **overrides):
        start = dict(type='system', subtype='init', tools=[], mcp_servers=[],
                     apiKeySource='none', served_by_anthropic=True)
        result = dict(type='result', subtype='success', is_error=False,
                      num_turns=1, permission_denials=[], result='NO_TOOLS',
                      usage=dict(input_tokens=7, output_tokens=3, unrelated=10))
        start.update(overrides.get('start', {}))
        result.update(overrides.get('result', {}))
        return '\n'.join(json.dumps(x) for x in [start, *overrides.get('events', []), result]).encode()

    def test_reports_only_supported_usage(self):
        value, receipt = checked_result(self.stream(), 0)
        self.assertEqual(value, 'NO_TOOLS')
        self.assertEqual(receipt['usage'], {'input_tokens': 7, 'output_tokens': 3})

    def test_fails_closed_for_tools_mcp_or_other_credentials(self):
        for change in ({'tools': ['Bash']}, {'mcp_servers': [{}]}, {'apiKeySource': 'env'},
                       {'served_by_anthropic': False}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                checked_result(self.stream(start=change), 0)

    def test_refuses_tool_events_even_with_empty_init(self):
        event = {'type': 'assistant', 'message': {'content': [{'type': 'tool_use'}]}}
        with self.assertRaisesRegex(ValueError, 'tool-activity'):
            checked_result(self.stream(events=[event]), 0)

    def test_stored_login_failure_is_a_classified_blocker(self):
        with self.assertRaisesRegex(ValueError, 'stored-login-unavailable'):
            checked_result(self.stream(result={'is_error': True, 'result': 'Not logged in'}), 1)


class ParseOutcomeTest(unittest.TestCase):
    def test_text_that_is_not_json_is_a_parse_failure(self):
        actions, outcome = classify_answer('Here is my answer: {')
        self.assertEqual(actions, [])
        self.assertEqual(outcome, {'status': 'json-parse-failed'})

    def test_json_of_the_wrong_shape_is_a_schema_failure(self):
        for text in ('[]', '{"unexpected": true}', '"just a string"'):
            with self.subTest(text=text):
                actions, outcome = classify_answer(text)
                self.assertEqual(actions, [])
                self.assertEqual(outcome['status'], 'schema-invalid')
                self.assertIsInstance(outcome['reason'], str)
                self.assertLessEqual(len(outcome['reason']), 120)

    def test_schema_reason_never_carries_the_answer_text(self):
        _, outcome = classify_answer('{"secret-looking-field": "PRIVATE-VALUE"}')
        self.assertNotIn('PRIVATE-VALUE', outcome['reason'])


if __name__ == '__main__':
    unittest.main()
