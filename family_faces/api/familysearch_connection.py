"""Connect the local app to the saved FamilySearch browser session through MCP."""
import json
import os
import signal
import subprocess
import threading
import time
import shutil
from pathlib import Path

from family_faces import config

SCRIPT = config.FAMILYSEARCH_CONNECTION_SCRIPT
NODE = shutil.which('node') or 'node'


def stopped():
    return {'status': 'disconnected', 'connected': False,
            'note': 'Sign-in stopped. Sign in in Chrome, then click Connect FamilySearch to try again.'}


def call_connection(action, cancel=None):
    cancel = cancel or threading.Event()
    if not SCRIPT:
        return {'status': 'unavailable', 'connected': False,
                'note': 'FamilySearch is not set up for this app.'}
    if cancel.is_set():
        return stopped()
    timeout = 450 if action == 'connect' else 80
    deadline = time.monotonic() + timeout
    process = subprocess.Popen([NODE, str(SCRIPT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    payload = json.dumps({'action': action})
    try:
        while not cancel.is_set():
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired('FamilySearch connection', timeout)
            try:
                stdout, _ = process.communicate(input=payload, timeout=.25)
                break
            except subprocess.TimeoutExpired:
                payload = None
        else:
            return stopped()
    finally:
        if process.poll() is None:
            # This group contains only this connection helper and its own sign-in window.
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            except ProcessLookupError:
                pass
    data = json.loads(stdout)
    if not isinstance(data, dict) or data.get('status') not in ('connected', 'disconnected', 'error'):
        raise ValueError('The connection result is not valid.')
    return {'status': data['status'], 'connected': data['status'] == 'connected',
            'note': str(data.get('note') or 'Check the FamilySearch connection.')}


class Connection:
    def __init__(self, mcp=None):
        self.mcp = mcp
        self.lock = threading.Lock()
        self.worker = None
        self.cancel_event = threading.Event()
        self.state = {'status': 'unknown', 'connected': False, 'note': 'The connection has not been checked.'}

    def run(self, action, cancel):
        try:
            result = self.mcp(action) if self.mcp else call_connection(action, cancel)
        except subprocess.TimeoutExpired:
            result = {'status': 'error', 'connected': False,
                      'note': 'FamilySearch sign-in or its connection check timed out. Click Connect FamilySearch to try again.'}
        except Exception:
            result = {'status': 'error', 'connected': False,
                      'note': 'Could not check the FamilySearch connection. Click Connect FamilySearch to try again.'}
        with self.lock:
            self.state = stopped() if cancel.is_set() else result

    def start(self, action):
        if self.state['status'] in ('checking', 'connecting', 'cancelling'):
            return
        self.state = {'status': 'connecting' if action == 'connect' else 'checking', 'connected': False,
                      'note': 'Checking your Chrome session. If a Connect window opens, sign in there. Sign-in can take up to 5 minutes.'
                      if action == 'connect' else 'Checking the saved FamilySearch session…'}
        self.cancel_event = threading.Event()
        self.worker = threading.Thread(target=self.run, args=(action, self.cancel_event), daemon=True)
        self.worker.start()

    def status(self, refresh=False):
        with self.lock:
            if refresh:
                self.start('status')
            return dict(self.state)

    def connect(self, body):
        if not isinstance(body, dict) or body:
            raise ValueError('The connection request is not valid.')
        with self.lock:
            self.start('connect')
            return dict(self.state)

    def cancel(self, body):
        if not isinstance(body, dict) or body:
            raise ValueError('The connection request is not valid.')
        with self.lock:
            if self.state['status'] == 'connecting':
                self.cancel_event.set()
                self.state = {'status': 'cancelling', 'connected': False, 'note': 'Stopping the sign-in step…'}
            return dict(self.state)


def register(routes, app):
    connection = Connection()
    app.BATCH_REFUSED.add('/api/familysearch-connection/connect')
    app.BATCH_REFUSED.add('/api/familysearch-connection/cancel')
    routes['GET']['/api/familysearch-connection'] = lambda query: connection.status(query.get('check') == '1')
    routes['POST']['/api/familysearch-connection/connect'] = connection.connect
    routes['POST']['/api/familysearch-connection/cancel'] = connection.cancel
