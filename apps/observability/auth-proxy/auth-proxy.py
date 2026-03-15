"""Tiny auth-verification service for Traefik forwardAuth → Grafana SSO.

Traefik sends every Grafana request here first.
  * If Kratos says the session is valid → 200 + X-Webauth-User header.
  * Otherwise → 302 redirect to Kratos login (return_to = original URL).
"""

import json
import ssl
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

KRATOS_WHOAMI = "http://host.containers.internal:4433/sessions/whoami"
LOGIN_URL = "https://localhost:8443/.ory/kratos/public/self-service/login/browser"

# Kratos may sit behind a self-signed TLS cert; we only call its HTTP port
# but disable verification globally just in case.
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        cookie = self.headers.get("Cookie", "")
        if not cookie:
            return self._redirect()

        req = urllib.request.Request(
            KRATOS_WHOAMI,
            headers={"Cookie": cookie, "Accept": "application/json"},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=5, context=ssl_ctx)
            data = json.loads(resp.read())
            email = data["identity"]["traits"]["email"]
            self.send_response(200)
            self.send_header("X-Webauth-User", email)
            self.end_headers()
        except Exception:
            self._redirect()

    def _redirect(self):
        # Build return_to from the original URL that Traefik forwards.
        original = self.headers.get("X-Forwarded-Uri", "/grafana/")
        host = self.headers.get("X-Forwarded-Host", "localhost:8443")
        proto = self.headers.get("X-Forwarded-Proto", "https")
        return_to = urllib.request.quote(f"{proto}://{host}{original}", safe="")
        self.send_response(302)
        self.send_header("Location", f"{LOGIN_URL}?return_to={return_to}")
        self.end_headers()

    # Suppress per-request log lines
    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 4180), Handler)
    print("auth-proxy listening on :4180", flush=True)
    server.serve_forever()
