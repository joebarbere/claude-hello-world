#!/bin/sh
set -e

CONNECT_URL="${CONNECT_URL:-http://localhost:8083}"

echo "Waiting for Kafka Connect to be ready..."
i=0
until wget -qO- "$CONNECT_URL/connectors" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "ERROR: Kafka Connect not ready after 5 minutes"
    exit 1
  fi
  echo "Kafka Connect not ready, retrying in 5s..."
  sleep 5
done

echo "Kafka Connect is ready."

# Check if connector already exists
if wget -qO- "$CONNECT_URL/connectors/weather-api-connector" >/dev/null 2>&1; then
  echo "Connector 'weather-api-connector' already exists, skipping registration."
else
  echo "Registering weather-api CDC connector..."
  wget -qO- --header='Content-Type: application/json' \
    --post-data='{
      "name": "weather-api-connector",
      "config": {
        "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
        "database.hostname": "host.containers.internal",
        "database.port": "5432",
        "database.user": "appuser",
        "database.password": "apppassword",
        "database.dbname": "appdb",
        "topic.prefix": "weather",
        "table.include.list": "public.*",
        "plugin.name": "pgoutput",
        "slot.name": "debezium_weather",
        "publication.name": "dbz_publication",
        "publication.autocreate.mode": "filtered",
        "decimal.handling.mode": "double",
        "tombstones.on.delete": "false",
        "key.converter": "io.confluent.connect.avro.AvroConverter",
        "key.converter.schema.registry.url": "http://localhost:8081",
        "value.converter": "io.confluent.connect.avro.AvroConverter",
        "value.converter.schema.registry.url": "http://localhost:8081"
      }
    }' \
    "$CONNECT_URL/connectors"

  echo "Connector registered successfully."
fi

# Keep alive briefly so logs are visible in podman logs
sleep 5
echo "Init complete."
