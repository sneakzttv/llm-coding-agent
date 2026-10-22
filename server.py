"""Loopback-only stdlib HTTP server with an explicit, small endpoint surface."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import secrets
from urllib.parse import urlsplit

from agent import ROOT, SCENARIOS, WorkflowError, run_workflow
from provider import Provider, ProviderError, parse_object

# Files are mapped explicitly: URL paths are never joined onto host paths.
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}


class DemoServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, provider):
        super().__init__(address, Handler)
        self.provider = provider
        self.csrf_token = secrets.token_urlsafe(32)
        self.allowed_hosts = {
            f"127.0.0.1:{self.server_port}", f"localhost:{self.server_port}"
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "ConstrainedAgent/1"

    def log_message(self, *_):
        # Avoid persisting task contents or request-controlled text in logs.
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(35)

    def send(self, code, payload, content_type="application/json; charset=utf-8"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self'; "
                         "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(data)

    def host_ok(self):
        if self.headers.get("Host") not in self.server.allowed_hosts:
            self.send(403, {"error": "Unrecognized Host header."})
            return False
        return True

    def do_GET(self):
        if not self.host_ok():
            return
        if self.path == "/api/config":
            self.send(200, {
                "token": self.server.csrf_token,
                "models": list(self.server.provider.models),
                "provider_configured": bool(self.server.provider.endpoint and self.server.provider.models),
                "scenarios": [
                    {"id": key, "title": value["title"], "task": value["task"]}
                    for key, value in SCENARIOS.items()
                ],
            })
        elif self.path in ASSETS:
            filename, content_type = ASSETS[self.path]
            self.send(200, (ROOT / "static" / filename).read_bytes(), content_type)
        else:
            self.send(404, {"error": "Not found."})

    def do_POST(self):
        if not self.host_ok():
            return
        if self.path != "/api/run":
            self.send(404, {"error": "Not found."})
            return
        # Same-origin token + Host/Origin checks prevent drive-by browser runs.
        origin = self.headers.get("Origin")
        if origin is not None:
            try:
                parsed = urlsplit(origin)
            except ValueError:
                self.send(403, {"error": "Malformed Origin header."})
                return
            if (parsed.scheme != "http" or parsed.netloc != self.headers.get("Host")
                    or parsed.netloc not in self.server.allowed_hosts
                    or parsed.path or parsed.query or parsed.fragment):
                self.send(403, {"error": "Cross-origin requests are refused."})
                return
        if self.headers.get("X-Demo-Token") != self.server.csrf_token:
            self.send(403, {"error": "Missing or invalid session token."})
            return
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            self.send(415, {"error": "Use application/json."})
            return
        try:
            if self.headers.get("Transfer-Encoding"):
                raise WorkflowError("Transfer encoding is not supported.")
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= 8192:
                raise WorkflowError("Request must contain 1–8192 bytes.")
            request = parse_object(self.rfile.read(length).decode("utf-8"))
            self.send(200, run_workflow(request, self.server.provider))
        except (WorkflowError, ProviderError, ValueError, UnicodeError) as exc:
            self.send(400, {"error": str(exc)})
        except OSError:
            self.send(500, {"error": "Local I/O failed. Check owned workspace permissions."})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    # Docker may explicitly expose the app; the default remains loopback.
    parser.add_argument("--host", choices=["127.0.0.1", "0.0.0.0"], default="127.0.0.1")
    args = parser.parse_args()
    server = DemoServer((args.host, args.port), Provider.from_environment())
    print(f"Constrained coding-agent demo: http://127.0.0.1:{server.server_port}")
    if args.host != "127.0.0.1":
        print("WARNING: listening on all interfaces; use loopback-only port publishing.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
