"""Auth-verification service for Traefik forwardAuth → Ory Kratos SSO.

Traefik sends every protected request here first via forwardAuth.
  * If Kratos says the session is valid → 200 + X-Webauth-User / Remote-User headers.
  * Otherwise → 302 redirect to Kratos login (return_to = original URL).

Also runs a MinIO auto-login service on port 4181.  After Kratos auth
succeeds, Traefik routes /minio/ to this service which calls the MinIO
Console login API, copies the session cookie to the browser, and redirects
to the MinIO Console UI.
"""

import json
import os
import ssl
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KRATOS_WHOAMI = "http://host.containers.internal:4433/sessions/whoami"
LOGIN_URL = "https://localhost:8443/.ory/kratos/public/self-service/login/browser"

MINIO_API = "http://host.containers.internal:9001"
MINIO_CONSOLE_URL = "http://localhost:9001"
MINIO_USER = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
MINIO_PASS = os.environ.get("MINIO_SECRET_KEY", "minioadmin")

# Kratos may sit behind a self-signed TLS cert; we only call its HTTP port
# but disable verification globally just in case.
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE


class AuthHandler(BaseHTTPRequestHandler):
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
            self.send_header("Remote-User", email)
            self.end_headers()
        except Exception:
            self._redirect()

    def _redirect(self):
        # Build return_to from the original URL that Traefik forwards.
        original = self.headers.get("X-Forwarded-Uri", "/")
        host = self.headers.get("X-Forwarded-Host", "localhost:8443")
        proto = self.headers.get("X-Forwarded-Proto", "https")
        return_to = urllib.request.quote(f"{proto}://{host}{original}", safe="")
        self.send_response(302)
        self.send_header("Location", f"{LOGIN_URL}?return_to={return_to}")
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


class MinioLoginHandler(BaseHTTPRequestHandler):
    """Calls the MinIO Console login API and relays the session cookie."""

    def do_GET(self):
        payload = json.dumps(
            {"accessKey": MINIO_USER, "secretKey": MINIO_PASS}
        ).encode()
        req = urllib.request.Request(
            f"{MINIO_API}/api/v1/login",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            resp = urllib.request.urlopen(req, timeout=5)
            # Extract Set-Cookie from MinIO response and relay to browser.
            # Cookie domain defaults to localhost (port-agnostic), so it is
            # sent when the browser redirects to the Console on port 9001.
            token_cookie = resp.headers.get("Set-Cookie", "")
            self.send_response(302)
            if token_cookie:
                self.send_header("Set-Cookie", token_cookie)
            self.send_header("Location", MINIO_CONSOLE_URL)
            self.end_headers()
        except Exception:
            # Fall back to MinIO Console login page
            self.send_response(302)
            self.send_header("Location", MINIO_CONSOLE_URL)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    auth_server = ThreadingHTTPServer(("0.0.0.0", 4180), AuthHandler)
    minio_server = ThreadingHTTPServer(("0.0.0.0", 4181), MinioLoginHandler)

    threading.Thread(target=minio_server.serve_forever, daemon=True).start()
    print("auth-proxy listening on :4180, minio-login on :4181", flush=True)
    auth_server.serve_forever()
