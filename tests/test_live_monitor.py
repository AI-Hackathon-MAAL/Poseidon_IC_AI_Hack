import unittest
from datetime import datetime, timezone
from unittest.mock import Mock
from agent.live_monitor import GFWClient, window, flatten, assess

class MonitorTests(unittest.TestCase):
    def test_rolling_window(self):
        self.assertEqual(window(1, datetime(2026, 11, 14, tzinfo=timezone.utc)),
                         ('2026-11-13T00:00:00+00:00', '2026-11-14T00:00:00+00:00'))

    def test_gap_assessments(self):
        event = flatten({'id': 'real-id', 'start': '2026-11-01T00:00:00Z',
                         'end': '2026-11-01T13:00:00Z', 'vessel': {'id': 'v1'}},
                        'gap', '1', 'Galapagos')
        self.assertEqual(assess([event]), 'flagged_for_review')
        self.assertEqual(assess([event], 24), 'no_qualifying_gap_found')
        event['duration_hours'] = None
        self.assertEqual(assess([event]), 'insufficient_data')

    def client(self, pages):
        c = GFWClient('test-token')
        c.session = Mock()
        responses = []
        for page in pages:
            r = Mock()
            r.json.return_value = page
            responses.append(r)
        c.session.post.side_effect = responses
        return c

    def test_pagination(self):
        c = self.client([{'entries': [{'id': 'a'}], 'nextOffset': 1},
                         {'entries': [{'id': 'b'}], 'total': 2}])
        self.assertEqual(len(c.events('gap', '1', 'start', 'end')), 2)

    def test_partial_results_rejected(self):
        for pages in [[{'entries': [], 'nextOffset': 1}],
                      [{'entries': [{'id': 'a'}], 'total': 2}],
                      [{'entries': [{'id': 'a'}], 'nextOffset': 0}]]:
            with self.subTest(pages=pages), self.assertRaises(RuntimeError):
                self.client(pages).events('gap', '1', 'start', 'end')

    def test_http_failure_propagates(self):
        c = self.client([{}])
        c.session.post.side_effect = RuntimeError('HTTP failure')
        with self.assertRaises(RuntimeError):
            c.events('gap', '1', 'start', 'end')

if __name__ == '__main__':
    unittest.main()
