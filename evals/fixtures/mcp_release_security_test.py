import base64
import contextlib
import hashlib
import hmac
import io
import json
import os
import pathlib
import runpy
import secrets
import ssl
import sys
import tempfile
import unittest
import urllib.parse
from unittest.mock import Mock, patch


FIXTURES = pathlib.Path(__file__).resolve().parent


def load_fixture(name, mode='witness'):
    with patch.dict(os.environ, {'PROOF_PRIVATE_DIR': tempfile.gettempdir(), 'PROVIDER_SECRET': 'synthetic-provider', 'OAUTH_SECRET': 'synthetic-oauth'}), patch.object(sys, 'argv', [name, mode]), patch('http.server.ThreadingHTTPServer'):
        return runpy.run_path(str(FIXTURES / name))


def request(handler_type, path, headers=None, body=None):
    handler = handler_type.__new__(handler_type)
    handler.client_address = ('127.0.0.1', 12345)
    raw = json.dumps(body).encode() if body is not None else b''
    method = 'POST' if body is not None else 'GET'
    headers = {'Host': 'fixture.example', 'Content-Length': str(len(raw)), **(headers or {})}
    wire = f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in headers.items()) + '\r\n'
    handler.rfile = io.BytesIO(wire.encode() + raw)
    handler.wfile = io.BytesIO()
    with contextlib.redirect_stdout(io.StringIO()) as logs:
        handler.handle_one_request()
    head, _, payload = handler.wfile.getvalue().partition(b'\r\n\r\n')
    lines = head.decode('latin-1').split('\r\n')
    status = int(lines[0].split()[1])
    response_headers = dict(line.split(': ', 1) for line in lines[1:])
    return status, response_headers, payload, logs.getvalue()


class ReleaseSecurityTests(unittest.TestCase):
    def test_fingerprints_match_across_exporter_and_witness(self):
        exporter = load_fixture('mcp-post-deploy-release.py')['fingerprint']
        witness = load_fixture('mcp-post-deploy-witness.py')['fingerprint']
        credential = secrets.token_urlsafe(32)
        expected = hmac.new(credential.encode(), b'openwork-release-proof-fingerprint-v1', hashlib.sha256).hexdigest()[:16]
        self.assertEqual(exporter(credential), expected)
        self.assertEqual(witness(credential), expected)
        self.assertRegex(expected, r'^[0-9a-f]{16}$')
        self.assertNotEqual(exporter(credential + '-rotated'), expected)
        self.assertNotIn(credential, json.dumps({'fingerprint': expected}))

    def test_export_persists_only_boolean_checks_and_redacted_witnesses(self):
        export = load_fixture('mcp-put-release-client.py')['export']
        credential = secrets.token_urlsafe(32)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'password').write_text(secrets.token_urlsafe(32))
            (root / 'release.env').write_text('OPENWORK_SETUP_CODE=synthetic-setup-code\n')
            (root / 'witness.env').write_text('WITNESS_SECRET=' + credential + '\n')
            for index, (label, value) in enumerate([('case6-secret-create', credential), ('case6-secret-read', '[REDACTED]')]):
                receipt = {'label': label, 'response': {'body': {'apiKey': value}, 'headers': {'Set-Cookie': 'unknown-cookie'}}}
                (root / f'request-{index:03d}.json').write_text(json.dumps(receipt))
            (root / 'witness.jsonl').write_text(json.dumps({'method': 'tools/call', 'nonce': credential, 'authenticated': True, 'authorization': 'Bearer unknown-token'}) + '\n')
            destination = root / 'export.json'
            with patch.dict(export.__globals__, {'ROOT': root, 'load': lambda: {}}), patch('subprocess.check_output', side_effect=['synthetic-image', '{}', 'synthetic-image:tag', 'synthetic-version']), contextlib.redirect_stdout(io.StringIO()):
                export(str(destination))
            serialized = destination.read_text()
            output = json.loads(serialized)
            self.assertEqual([row['rawResponseContainsWitnessSecret'] for row in output['secretChecksBeforeRedaction']], [True, False])
            self.assertTrue(all(type(row['rawResponseContainsWitnessSecret']) is bool for row in output['secretChecksBeforeRedaction']))
            self.assertTrue(all(row['responseHasApiKeyField'] for row in output['secretChecksBeforeRedaction']))
            self.assertEqual(output['witnessCalls'], [{'method': 'tools/call', 'nonce': '[REDACTED]', 'authenticated': True, 'authorization': '[REDACTED]'}])
            self.assertNotIn(credential, serialized)
            self.assertNotIn('unknown-cookie', serialized)
            self.assertNotIn('unknown-token', serialized)
            self.assertTrue(all(row['response']['body']['apiKey'] == '[REDACTED]' for row in output['requests']))

    def test_proxy_enforces_tls12_even_with_permissive_runtime_defaults(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.MINIMUM_SUPPORTED
        with patch.object(context, 'load_cert_chain') as load_cert, patch.object(context, 'wrap_socket') as wrap_socket, patch('ssl.SSLContext.__new__', return_value=context) as create_context, patch.dict(os.environ, {'PROOF_TLS_CERT': 'synthetic-cert.pem', 'PROOF_TLS_KEY': 'synthetic-key.pem'}):
            load_fixture('mcp-put-release-witness.py', 'proxy')
        create_context.assert_called_once_with(ssl.SSLContext, ssl.PROTOCOL_TLS_SERVER)
        self.assertEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.assertGreater(context.minimum_version, ssl.TLSVersion.TLSv1_1)
        load_cert.assert_called_once_with('synthetic-cert.pem', 'synthetic-key.pem')
        self.assertTrue(wrap_socket.call_args.kwargs['server_side'])

    def test_oauth_redirect_rejects_response_splitting_and_controls(self):
        handler = load_fixture('mcp-post-deploy-witness.py')['Handler']
        for control in ['\r', '\n', '\r\n', '\x00', '\x7f', '\u0100']:
            with self.subTest(control=repr(control)):
                query = urllib.parse.urlencode({'client_id': 'lane3-client', 'redirect_uri': 'http://localhost:18788/callback' + control + 'X-Injected: yes', 'state': 'synthetic-state', 'code_challenge': 'synthetic-challenge'})
                status, headers, _, _ = request(handler, '/authorize?' + query)
                self.assertEqual(status, 400)
                self.assertNotIn('Location', headers)
                self.assertNotIn('X-Injected', headers)

    def test_oauth_challenge_rejects_folded_host(self):
        handler = load_fixture('mcp-post-deploy-witness.py')['Handler']
        status, headers, _, _ = request(handler, '/oauth/mcp', {'Host': 'fixture.example\r\n X-Injected: yes'})
        self.assertEqual(status, 400)
        self.assertNotIn('WWW-Authenticate', headers)
        self.assertNotIn('X-Injected', headers)

    def test_oauth_and_provider_positive_and_negative_controls(self):
        fixture = load_fixture('mcp-post-deploy-witness.py')
        handler = fixture['Handler']
        verifier = secrets.token_urlsafe(32)
        redirect = 'http://localhost:18788/callback'
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        query = urllib.parse.urlencode({'client_id': 'lane3-client', 'redirect_uri': redirect, 'state': 'synthetic-state', 'code_challenge': challenge})
        status, headers, _, _ = request(handler, '/authorize?' + query)
        self.assertEqual(status, 302)
        location = urllib.parse.urlsplit(headers['Location'])
        self.assertEqual(location.path, '/callback')
        parameters = urllib.parse.parse_qs(location.query)
        self.assertEqual(parameters['state'], ['synthetic-state'])
        token_body = {'client_id': 'lane3-client', 'client_secret': fixture['OAUTH_SECRET'], 'code': parameters['code'][0], 'code_verifier': verifier, 'redirect_uri': redirect}
        self.assertEqual(request(handler, '/token', body={**token_body, 'client_secret': 'wrong'})[0], 401)
        self.assertEqual(request(handler, '/token', body={**token_body, 'code_verifier': 'wrong'})[0], 400)
        status, _, payload, logs = request(handler, '/token', body=token_body)
        self.assertEqual(status, 200)
        token = json.loads(payload)['access_token']
        self.assertEqual(json.loads(logs)['request']['secretFingerprint'], fixture['fingerprint'](fixture['OAUTH_SECRET']))
        self.assertNotIn(token, logs)
        self.assertNotIn(fixture['OAUTH_SECRET'], logs)
        self.assertEqual(request(handler, '/token', body=token_body)[0], 400)
        call = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'arguments': {'nonce': 'synthetic-nonce'}}}
        status, _, payload, _ = request(handler, '/oauth/mcp', {'Authorization': 'Bearer ' + token}, call)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(json.loads(payload)['result']['content'][0]['text'])['authenticated'])
        status, headers, _, _ = request(handler, '/oauth/mcp', body=call)
        self.assertEqual(status, 401)
        self.assertEqual(headers['WWW-Authenticate'], 'Bearer resource_metadata="https://fixture.example/.well-known/oauth-protected-resource/oauth/mcp"')
        self.assertEqual(request(handler, '/v1/models', {'Authorization': 'Bearer ' + fixture['PROVIDER_SECRET']})[0], 200)
        self.assertEqual(request(handler, '/v1/models', {'Authorization': 'Bearer wrong'})[0], 401)

    def test_proxy_rejects_invalid_upstream_header_names_and_values(self):
        handler = load_fixture('mcp-put-release-witness.py')['Handler']
        invalid = [('X-Proof' + control + 'X-Injected', 'yes') for control in ['\r', '\n', '\r\n', ':', ' ', '\x00', '\u0100']]
        invalid += [('X-Proof', 'value' + control + 'X-Injected: yes') for control in ['\r', '\n', '\r\n', '\x00', '\x7f', '\u0100']]
        for name, value in invalid:
            with self.subTest(name=repr(name), value=repr(value)):
                connection = Mock()
                upstream = connection.getresponse.return_value
                upstream.status = 200
                upstream.read.return_value = b'{}'
                upstream.getheaders.return_value = [('Content-Type', 'application/json'), (name, value)]
                with patch.dict(handler.handle_request.__globals__, {'MODE': 'proxy'}), patch('http.client.HTTPConnection', return_value=connection):
                    status, headers, _, _ = request(handler, '/v1/org')
                self.assertEqual(status, 502)
                self.assertNotIn('X-Proof', headers)
                self.assertNotIn('X-Injected', headers)
                connection.close.assert_called_once()

    def test_proxy_preserves_valid_headers_and_recomputes_content_length(self):
        handler = load_fixture('mcp-put-release-witness.py')['Handler']
        connection = Mock()
        upstream = connection.getresponse.return_value
        upstream.status = 201
        upstream.read.return_value = b'{"ok":true}'
        upstream.getheaders.return_value = [('Content-Type', 'application/json'), ('X-Proof', 'valid\tvalue'), ('Content-Length', '999'), ('Transfer-Encoding', 'chunked'), ('Connection', 'keep-alive')]
        with patch.dict(handler.handle_request.__globals__, {'MODE': 'proxy'}), patch('http.client.HTTPConnection', return_value=connection):
            status, headers, payload, _ = request(handler, '/v1/org')
        self.assertEqual(status, 201)
        self.assertEqual(headers['X-Proof'], 'valid\tvalue')
        self.assertEqual(headers['Content-Type'], 'application/json')
        self.assertEqual(int(headers['Content-Length']), len(payload))
        self.assertNotIn('Transfer-Encoding', headers)
        self.assertNotIn('Connection', headers)
        self.assertEqual(json.loads(payload), {'ok': True})
        connection.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
