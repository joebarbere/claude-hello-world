"""Airflow webserver configuration for proxy authentication via Ory Kratos.

The auth-proxy sets X-Webauth-User on authenticated requests. This becomes
HTTP_X_WEBAUTH_USER in WSGI environ. We copy it to REMOTE_USER so Flask's
request.remote_user picks it up for FAB's AUTH_REMOTE_USER flow.
"""

from flask_appbuilder.security.manager import AUTH_REMOTE_USER

AUTH_TYPE = AUTH_REMOTE_USER
AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Admin"
