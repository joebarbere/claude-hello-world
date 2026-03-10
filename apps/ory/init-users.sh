#!/bin/sh
set -e

KRATOS_ADMIN_URL="${KRATOS_ADMIN_URL:-http://localhost:4434}"

wait_for_kratos() {
  echo "Waiting for Kratos admin API..."
  for i in $(seq 1 30); do
    if wget -q --spider "${KRATOS_ADMIN_URL}/health/ready" 2>/dev/null; then
      echo "Kratos is ready."
      return 0
    fi
    echo "Attempt $i/30 - not ready yet, waiting 2s..."
    sleep 2
  done
  echo "Kratos did not become ready in time."
  exit 1
}

create_identity() {
  local email="$1"
  local password="$2"
  local role="$3"

  echo "Creating identity: ${email} (role: ${role})"

  existing=$(wget -q -O- \
    "${KRATOS_ADMIN_URL}/admin/identities?credentials_identifier=${email}" \
    2>/dev/null || true)

  if echo "${existing}" | grep -q "\"${email}\""; then
    echo "Identity ${email} already exists, skipping."
    return 0
  fi

  wget -q -O- \
    --header="Content-Type: application/json" \
    --post-data="{
      \"schema_id\": \"default\",
      \"traits\": {
        \"email\": \"${email}\",
        \"role\": \"${role}\"
      },
      \"credentials\": {
        \"password\": {
          \"config\": {
            \"password\": \"${password}\"
          }
        }
      }
    }" \
    "${KRATOS_ADMIN_URL}/admin/identities" \
    && echo "Created ${email}" \
    || echo "Failed to create ${email}"
}

wait_for_kratos

create_identity "admin@example.com" "Admin1234!" "admin"
create_identity "weatheradmin@example.com" "WeatherAdmin1234!" "weather_admin"

echo "User initialization complete."
