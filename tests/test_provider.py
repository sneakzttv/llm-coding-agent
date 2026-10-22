"""Provider contract tests use in-memory HTTP doubles, not external services."""

import io
import json
import unittest
from unittest.mock import Mock, patch
import urllib.error

from provider import NoRedirect, Provider, ProviderError, parse_object


class ProviderTests(unittest.TestCase):
    def provider(self):
        return Provider("http://127.0.0.1:9000/v1", ["planner", "editor"], "secret-for-test")

    def response(self, content='{"plan":["Read"]}', **extra):
        return json.dumps({"choices": [{
            "finish_reason": "stop", "message": {"content": content, **extra},
        }]}).encode("utf-8")

    def call_with_response(self, raw):
        response = Mock()
        response.__enter__ = Mock(return_value=io.BytesIO(raw))
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        with patch("provider.urllib.request.build_opener", return_value=opener):
            result = self.provider().complete("planner", "planner", {"task": "demo"})
        return result, opener

    def test_real_http_request_contract_without_network(self):
        result, opener = self.call_with_response(self.response())
        self.assertEqual(result, {"plan": ["Read"]})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:9000/v1/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-for-test")
        self.assertEqual(json.loads(request.data)["model"], "planner")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 25)

    def test_unsupported_models_and_endpoints(self):
        with self.assertRaises(ProviderError):
            self.provider().validate_model("not-configured")
        with self.assertRaises(ProviderError):
            Provider().validate_model("anything")
        for endpoint in [
            "http://example.com/v1", "file:///etc", "https://user:pass@example.com/v1",
            "https://example.com/v1?key=secret", "https://example.com/v1#fragment",
            "https://example.com:invalid/v1", "http://[malformed/v1",
        ]:
            with self.subTest(endpoint=endpoint), self.assertRaises((ProviderError, ValueError)):
                Provider(endpoint, ["model"]).validate_model("model")
        Provider("https://example.com/v1", ["model"]).validate_model("model")

    def test_unsupported_outputs(self):
        for raw in [
            b"not JSON", b"[]", b'{"choices":[]}', b'{"choices":[null]}',
            b'{"choices":[{"finish_reason":"length","message":{"content":"{}"}}]}',
            self.response("```json\n{}\n```"), self.response("[]"),
            self.response('{"x":1,"x":2}'), self.response("{}", tool_calls=[{}]),
            self.response("{}", refusal="Refused"), b"x" * 65537,
            b'{"choices":[{"finish_reason":"stop","message":{}}]}',
        ]:
            with self.subTest(raw=raw[:60]), self.assertRaises(ProviderError):
                self.call_with_response(raw)

    def test_strict_json(self):
        for value in ['{"x":NaN}', '{"x":1,"x":2}', "{} trailing", "null"]:
            with self.subTest(value=value), self.assertRaises(ProviderError):
                parse_object(value)

    def test_http_errors_are_explicit_and_do_not_echo_provider_body(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            "http://127.0.0.1", 401, "unauthorized", {}, io.BytesIO(b"private details")
        )
        with patch("provider.urllib.request.build_opener", return_value=opener):
            with self.assertRaisesRegex(ProviderError, "HTTP 401") as caught:
                self.provider().complete("planner", "planner", {})
        self.assertNotIn("private", str(caught.exception))

    def test_redirects_refused(self):
        with self.assertRaises(ProviderError):
            NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere")


if __name__ == "__main__":
    unittest.main()
