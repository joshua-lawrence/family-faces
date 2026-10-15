import json
import subprocess
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from family_faces.api import familysearch_connection as connection


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        script = patch.object(connection, 'SCRIPT', connection.Path('/tmp/connection.mjs'))
        script.start()
        self.addCleanup(script.stop)

    def test_unconfigured_connection_reports_unavailable(self):
        with patch.object(connection, 'SCRIPT', None), patch.object(connection.subprocess, 'Popen') as popen:
            self.assertEqual(connection.call_connection('status')['status'], 'unavailable')
        popen.assert_not_called()

    def test_connect_is_single_flight_and_validates_before_reporting_connected(self):
        entered = threading.Event()
        finish = threading.Event()
        calls = []

        def mcp(action):
            calls.append(action)
            entered.set()
            finish.wait(2)
            return {'status': 'connected', 'connected': True, 'note': 'Connected'}

        service = connection.Connection(mcp)
        self.assertEqual(service.connect({})['status'], 'connecting')
        self.assertTrue(entered.wait(1))
        for _ in range(5):
            self.assertEqual(service.connect({})['status'], 'connecting')
            self.assertEqual(service.status(True)['status'], 'connecting')
        self.assertFalse(service.status()['connected'])
        finish.set()
        service.worker.join(2)
        self.assertTrue(service.status()['connected'])
        self.assertEqual(calls, ['connect'])

    def test_read_only_status_never_starts_a_browser_login(self):
        calls = []
        service = connection.Connection(lambda action: calls.append(action) or
                                        {'status': 'disconnected', 'connected': False, 'note': 'Sign in'})
        service.status(True)
        service.worker.join(2)
        for _ in range(3):
            self.assertEqual(service.status()['status'], 'disconnected')
        self.assertEqual(calls, ['status'])

    def test_login_failure_does_not_expose_diagnostics_and_can_be_retried(self):
        def fail(action):
            raise ValueError('private diagnostic data')
        service = connection.Connection(fail)
        service.connect({})
        service.worker.join(2)
        self.assertEqual(service.status()['status'], 'error')
        self.assertNotIn('private', service.status()['note'])
        service.mcp = lambda action: {'status': 'connected', 'connected': True, 'note': 'Connected'}
        service.connect({})
        service.worker.join(2)
        self.assertTrue(service.status()['connected'])

    def test_timeout_explains_the_next_step(self):
        def fail(action):
            raise subprocess.TimeoutExpired('private command', 450)
        service = connection.Connection(fail)
        service.connect({})
        service.worker.join(2)
        self.assertIn('timed out', service.status()['note'])
        self.assertNotIn('private', service.status()['note'])

    def test_only_connection_actions_are_sent_to_mcp(self):
        for action in ('status', 'connect'):
            process = MagicMock()
            process.communicate.return_value = (json.dumps({'status': 'connected', 'connected': True, 'note': 'Connected'}), '')
            process.poll.return_value = 0
            with patch.object(connection.subprocess, 'Popen', return_value=process) as run:
                self.assertTrue(connection.call_connection(action)['connected'])
                self.assertEqual(json.loads(process.communicate.call_args.kwargs['input']), {'action': action})
                self.assertEqual(process.communicate.call_args.kwargs['timeout'], .25)
                self.assertTrue(run.call_args.kwargs['start_new_session'])

    def test_cancel_ends_the_wait_and_allows_a_new_connect(self):
        finish = threading.Event()

        def mcp(action):
            finish.wait(2)
            return {'status': 'connected', 'connected': True, 'note': 'Connected'}

        service = connection.Connection(mcp)
        service.connect({})
        self.assertEqual(service.cancel({})['status'], 'cancelling')
        self.assertEqual(service.connect({})['status'], 'cancelling')
        finish.set()
        service.worker.join(2)
        self.assertEqual(service.status()['status'], 'disconnected')
        self.assertFalse(service.status()['connected'])
        service.mcp = lambda action: {'status': 'connected', 'connected': True, 'note': 'Connected'}
        service.connect({})
        service.worker.join(2)
        self.assertTrue(service.status()['connected'])

    def test_cancel_stops_only_the_owned_connection_process_group(self):
        cancel = threading.Event()
        process = MagicMock(pid=4242)
        process.poll.return_value = None

        def wait(**kwargs):
            if 'input' in kwargs:
                cancel.set()
                raise subprocess.TimeoutExpired('test helper', .25)
            return '', ''

        process.communicate.side_effect = wait
        with patch.object(connection.subprocess, 'Popen', return_value=process), patch.object(connection.os, 'killpg') as kill:
            self.assertEqual(connection.call_connection('connect', cancel)['status'], 'disconnected')
            kill.assert_called_once_with(4242, connection.signal.SIGTERM)

    def test_timed_out_helpers_close_their_browser_before_retry(self):
        process = MagicMock(pid=4242)
        process.poll.return_value = None
        process.communicate.return_value = ('', '')
        with patch.object(connection.subprocess, 'Popen', return_value=process), \
                patch.object(connection.time, 'monotonic', side_effect=[0, 451]), \
                patch.object(connection.os, 'killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                connection.call_connection('connect')
            kill.assert_called_once_with(4242, connection.signal.SIGTERM)

    def test_connect_does_not_accept_credentials_or_start_work_on_invalid_input(self):
        calls = []
        service = connection.Connection(lambda action: calls.append(action))
        for body in (None, [], {'cookies': 'do not accept credentials from the page'}):
            with self.assertRaises(ValueError):
                service.connect(body)
        self.assertEqual(calls, [])

    def test_connection_login_cannot_run_as_a_batch_write(self):
        app = SimpleNamespace(BATCH_REFUSED=set())
        routes = {'GET': {}, 'POST': {}}
        connection.register(routes, app)
        self.assertIn('/api/familysearch-connection/connect', app.BATCH_REFUSED)
        self.assertIn('/api/familysearch-connection/cancel', app.BATCH_REFUSED)
        self.assertEqual(set(routes['POST']), {'/api/familysearch-connection/connect', '/api/familysearch-connection/cancel'})


if __name__ == '__main__':
    unittest.main()
