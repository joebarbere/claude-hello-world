#!/bin/bash
set -e
airflow db migrate
airflow users create \
  --username "${_AIRFLOW_WWW_USER_USERNAME:-admin}" \
  --password "${_AIRFLOW_WWW_USER_PASSWORD:-admin}" \
  --firstname Admin \
  --lastname User \
  --role Admin \
  --email admin@example.com || true
# Start scheduler in background, webserver in foreground
airflow scheduler &
exec airflow webserver
