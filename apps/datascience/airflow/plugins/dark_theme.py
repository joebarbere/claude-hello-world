"""Airflow plugin: default to dark mode.

Injects a script into every HTML response that sets localStorage.darkTheme
to 'true' if no preference exists yet. This runs before Airflow's built-in
toggle_theme.js calls initTheme(), so first-time visitors get dark mode.
Users can still toggle back to light mode manually.
"""

from airflow.plugins_manager import AirflowPlugin
from flask import Blueprint, after_this_request, request

bp = Blueprint("dark_theme", __name__)

DARK_THEME_SCRIPT = (
    b"<script>if(localStorage.getItem('darkTheme')===null)"
    b"localStorage.setItem('darkTheme','true');</script>"
)


@bp.after_app_request
def inject_dark_theme_default(response):
    if response.content_type and "text/html" in response.content_type:
        data = response.get_data()
        if b"</head>" in data:
            response.set_data(data.replace(b"</head>", DARK_THEME_SCRIPT + b"</head>", 1))
    return response


class DarkThemePlugin(AirflowPlugin):
    name = "dark_theme"
    flask_blueprints = [bp]
