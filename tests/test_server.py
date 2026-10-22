"""Loopback integration tests for HTTP restrictions and the public API."""

import http.client
import json
import threading
import unittest

from provider import Provider
from server import DemoServer


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = DemoServer(("127.0.0.1", 0), Provider())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=15)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_config_and_static_files(self):
        code, headers, body = self.request("GET", "/api/config")
        self.assertEqual(code, 200)
        config = json.loads(body)
        self.assertFalse(config["provider_configured"])
        self.assertNotIn("api_key", config)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        for asset in ("/", "/app.js", "/style.css", "/browser-engine.js", "/scenarios.json"):
            with self.subTest(asset=asset):
                self.assertEqual(self.request("GET", asset)[0], 200)

    def test_static_traversal_is_not_routed(self):
        for path in ("/../agent.py", "/%2e%2e/agent.py", "/agent.py", "/.workspaces"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)

    def test_host_and_token_and_origin_guards(self):
        self.assertEqual(self.request("GET", "/api/config", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/run", "{}")[0], 403)
        headers = {"X-Demo-Token": self.server.csrf_token,
                   "Content-Type": "application/json", "Origin": "https://evil.example"}
        self.assertEqual(self.request("POST", "/api/run", "{}", headers)[0], 403)
        headers["Origin"] = "http://[malformed"
        self.assertEqual(self.request("POST", "/api/run", "{}", headers)[0], 403)

    def test_request_errors_and_real_offline_endpoint(self):
        headers = {"X-Demo-Token": self.server.csrf_token, "Content-Type": "application/json"}
        self.assertEqual(self.request("POST", "/api/run", '{"mode":"invented"}', headers)[0], 400)
        self.assertEqual(self.request("POST", "/api/run", '{"mode":1,"mode":2}', headers)[0], 400)
        self.assertEqual(self.request("POST", "/api/run", "{}", {
            "X-Demo-Token": self.server.csrf_token, "Content-Type": "text/plain",
        })[0], 415)
        code, _, body = self.request("POST", "/api/run", '{"scenario":"clean-labels"}', headers)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["status"], "passed")


if __name__ == "__main__":
    unittest.main()
