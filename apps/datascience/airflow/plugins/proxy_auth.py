"""Airflow plugin: copy X-Webauth-User header to REMOTE_USER in WSGI environ.

This runs before every request so that FAB's AUTH_REMOTE_USER flow can read
request.remote_user (which reads REMOTE_USER from the WSGI environ).
"""

from airflow.plugins_manager import AirflowPlugin
from flask import Blueprint, request

bp = Blueprint("proxy_auth", __name__)


@bp.before_app_request
def copy_remote_user():
    user = request.headers.get("X-Webauth-User")
    if user:
        request.environ["REMOTE_USER"] = user


class ProxyAuthPlugin(AirflowPlugin):
    name = "proxy_auth"
    flask_blueprints = [bp]
