# Plan: Webhook / Outbound Event Publishing

## Goal

Build a webhook delivery service that consumes CDC events from the Kafka `weather.public.WeatherForecasts` topic and POSTs simplified JSON payloads to subscriber-registered URLs, with HMAC-SHA256 signing, exponential backoff retries, and dead-letter handling.

## Current State

- **Kafka CDC pipeline**: Debezium is configured in `apps/kafka/debezium-init/register-connector.sh` with topic prefix `weather` and `table.include.list: public.*`. This produces events on topics like `weather.public.WeatherForecasts` (Avro-encoded via the Schema Registry at `localhost:8081` inside the kafka pod, exposed on `host.containers.internal:8085`).
- **Kafka pod** (`k8s/kafka-pod.yaml`): Runs Kafka 3.9.0 (KRaft mode), Schema Registry (Confluent 7.7.1), Debezium Connect, kafka-ui, and slot-guard. Kafka is reachable cross-pod at `host.containers.internal:9094` (EXTERNAL listener) and within the pod at `localhost:9092` (INTERNAL listener).
- **Postgres** (`k8s/postgres-pod.yaml`, `apps/postgres/Containerfile`): Runs PostgreSQL 17 with logical replication enabled. Database `appdb`, user `appuser`. The WeatherDbContext (`apps/weather-api/Data/WeatherDbContext.cs`) manages `WeatherForecasts` and `Minions` tables via EF Core.
- **Weather API** (`apps/weather-api/Program.cs`): Minimal API with CRUD endpoints for forecasts and minions. No webhook management endpoints exist.
- **No outbound event publishing exists** — there is no webhook registration model, no consumer service, and no delivery infrastructure.
- **Existing Kafka consumer pattern**: `apps/datascience/airflow/dags/dag_kafka_cdc_to_duckdb.py` consumes from the same CDC topic using `confluent_kafka` with Avro deserialization. This validates that the topic and schema registry are working.
- **Airflow** (`k8s/datascience-pod.yaml`): Available for scheduling but using SequentialExecutor + SQLite. A long-running consumer service is better suited as a standalone container than an Airflow DAG.

## Implementation Steps

### 1. Design the webhook registration data model

Add two new EF Core entities to the weather-api:

**`apps/weather-api/Models/WebhookSubscription.cs`**:
```csharp
public class WebhookSubscription
{
    public int Id { get; set; }

    [Required, MaxLength(2048)]
    public string Url { get; set; } = string.Empty;

    [Required, MaxLength(64)]
    public string Secret { get; set; } = string.Empty;  // HMAC-SHA256 key

    [MaxLength(200)]
    public string? Description { get; set; }

    public bool IsActive { get; set; } = true;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public ICollection<WebhookDelivery> Deliveries { get; set; } = new List<WebhookDelivery>();
}
```

**`apps/weather-api/Models/WebhookDelivery.cs`**:
```csharp
public class WebhookDelivery
{
    public long Id { get; set; }

    public int SubscriptionId { get; set; }
    public WebhookSubscription Subscription { get; set; } = null!;

    [MaxLength(50)]
    public string EventType { get; set; } = string.Empty;  // "create", "update", "delete"

    public string Payload { get; set; } = string.Empty;  // JSON payload sent

    public int HttpStatus { get; set; }

    public int AttemptCount { get; set; }

    [MaxLength(20)]
    public string Status { get; set; } = "pending";  // pending, delivered, failed, dead_letter

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? DeliveredAt { get; set; }
}
```

### 2. Register entities in DbContext

Edit `apps/weather-api/Data/WeatherDbContext.cs`:

```csharp
public DbSet<WebhookSubscription> WebhookSubscriptions => Set<WebhookSubscription>();
public DbSet<WebhookDelivery> WebhookDeliveries => Set<WebhookDelivery>();
```

### 3. Create and apply the EF Core migration

```bash
cd apps/weather-api
dotnet ef migrations add AddWebhookTables
```

The migration will run automatically on startup (the existing `db.Database.Migrate()` call in `Program.cs` handles this).

### 4. Add webhook management API endpoints

Add to `apps/weather-api/Program.cs`:

```csharp
var webhooks = app.MapGroup("/webhooks");

webhooks.MapGet("/", async (WeatherDbContext db) =>
    Results.Ok(await db.WebhookSubscriptions
        .Select(w => new { w.Id, w.Url, w.Description, w.IsActive, w.CreatedAt })
        .ToListAsync()))
    .WithName("GetWebhooks");

webhooks.MapPost("/", async (WebhookSubscription input, WeatherDbContext db) =>
{
    if (string.IsNullOrWhiteSpace(input.Secret))
        input.Secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    db.WebhookSubscriptions.Add(input);
    await db.SaveChangesAsync();
    return Results.Created($"/webhooks/{input.Id}",
        new { input.Id, input.Url, input.Secret, input.Description, input.IsActive });
})
.WithName("CreateWebhook");

webhooks.MapDelete("/{id:int}", async (int id, WeatherDbContext db) =>
{
    var sub = await db.WebhookSubscriptions.FindAsync(id);
    if (sub is null) return Results.NotFound();
    db.WebhookSubscriptions.Remove(sub);
    await db.SaveChangesAsync();
    return Results.NoContent();
})
.WithName("DeleteWebhook");

webhooks.MapGet("/{id:int}/deliveries", async (int id, WeatherDbContext db) =>
    Results.Ok(await db.WebhookDeliveries
        .Where(d => d.SubscriptionId == id)
        .OrderByDescending(d => d.CreatedAt)
        .Take(50)
        .ToListAsync()))
    .WithName("GetWebhookDeliveries");
```

### 5. Add Traefik routes for `/webhooks`

Edit `traefik/traefik-dynamic.yml`:

```yaml
webhooks-router:
  rule: "PathPrefix(`/webhooks`)"
  entryPoints:
    - websecure
  service: weather-api
  priority: 20
  tls: {}
```

No path rewriting needed since the API endpoint path matches the public path.

### 6. Build the Kafka consumer webhook delivery service

Create a standalone Python service (consistent with the existing datascience Kafka consumer pattern in `dag_kafka_cdc_to_duckdb.py`):

**`apps/webhook-publisher/webhook_consumer.py`**:

Core logic:
1. Connect to Kafka at `host.containers.internal:9094` and Schema Registry at `http://host.containers.internal:8085`.
2. Subscribe to `weather.public.WeatherForecasts`.
3. For each message, deserialize the Avro envelope, extract the operation type (`c`=create, `u`=update, `d`=delete) and the `after` payload.
4. Transform into a simplified JSON event:
   ```json
   {
     "event": "forecast.updated",
     "timestamp": "2026-03-28T12:00:00Z",
     "data": {
       "id": 42,
       "date": "2026-03-28",
       "temperatureC": 22,
       "temperatureF": 71,
       "summary": "Mild"
     }
   }
   ```
5. Query Postgres for all active `WebhookSubscriptions`.
6. For each subscription, compute HMAC-SHA256 signature and POST:
   ```
   POST <subscription.url>
   Content-Type: application/json
   X-Weather-Signature: sha256=<hex_hmac>
   X-Weather-Event: forecast.updated
   ```
7. Record the delivery result in `WebhookDeliveries`.

**HMAC signing**:
```python
import hmac, hashlib
signature = hmac.new(
    secret.encode(), payload_bytes, hashlib.sha256
).hexdigest()
header = f"sha256={signature}"
```

**Retry with exponential backoff**:
- On HTTP 4xx (except 410 Gone): no retry, mark as `failed`.
- On HTTP 5xx or connection error: retry up to 3 times with delays of 5s, 25s, 125s (5^attempt seconds).
- After 3 failed attempts: mark as `dead_letter`.
- On HTTP 410 Gone: auto-deactivate the subscription (`IsActive = false`).

### 7. Containerize the webhook publisher

Create `apps/webhook-publisher/Containerfile`:

```dockerfile
FROM docker.io/library/python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY webhook_consumer.py .
CMD ["python", "webhook_consumer.py"]
```

**`apps/webhook-publisher/requirements.txt`**:
```
confluent-kafka[schema-registry]
fastavro
psycopg2-binary
requests
```

### 8. Add the webhook publisher container to the kafka pod

Edit `k8s/kafka-pod.yaml` to add a new container:

```yaml
- name: webhook-publisher
  image: localhost/webhook-publisher:latest
  env:
    - name: KAFKA_BROKER
      value: "localhost:9092"
    - name: SCHEMA_REGISTRY_URL
      value: "http://localhost:8081"
    - name: PGHOST
      value: "host.containers.internal"
    - name: PGPORT
      value: "5432"
    - name: PGUSER
      value: "appuser"
    - name: PGDATABASE
      value: "appdb"
    - name: PGPASSWORD
      value: "apppassword"
    - name: CONSUMER_GROUP
      value: "webhook-publisher"
```

Running inside the kafka pod means it can use `localhost:9092` (INTERNAL listener) for Kafka and `localhost:8081` for Schema Registry — no cross-pod networking needed for Kafka access.

### 9. Add Nx project configuration

Create `apps/webhook-publisher/project.json`:

```json
{
  "name": "webhook-publisher",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "options": {
        "command": "podman build -t localhost/webhook-publisher:latest -f apps/webhook-publisher/Containerfile apps/webhook-publisher"
      }
    }
  }
}
```

### 10. Add dead-letter monitoring

Add a Prometheus metric emitted by the webhook consumer:
- `webhook_deliveries_total{status="delivered|failed|dead_letter"}` — counter.
- `webhook_delivery_latency_seconds` — histogram.

Expose on port 9405 (matches the pattern of debezium-connect's JMX exporter on 9404). Add to `apps/observability/prometheus/prometheus.yml` as a scrape target.

## Files to Create/Modify

- **Create** `apps/weather-api/Models/WebhookSubscription.cs`
- **Create** `apps/weather-api/Models/WebhookDelivery.cs`
- **Create** EF Core migration files (auto-generated by `dotnet ef migrations add`)
- **Modify** `apps/weather-api/Data/WeatherDbContext.cs` — add DbSet properties
- **Modify** `apps/weather-api/Program.cs` — add `/webhooks` endpoint group
- **Modify** `traefik/traefik-dynamic.yml` — add `webhooks-router`
- **Create** `apps/webhook-publisher/webhook_consumer.py`
- **Create** `apps/webhook-publisher/Containerfile`
- **Create** `apps/webhook-publisher/requirements.txt`
- **Create** `apps/webhook-publisher/project.json`
- **Modify** `k8s/kafka-pod.yaml` — add `webhook-publisher` container
- **Modify** `apps/observability/prometheus/prometheus.yml` — add scrape target

## Testing

1. **Unit tests for HMAC signing**: Write a pytest test that verifies the signature computation matches a known test vector (RFC 4231).
2. **API integration test**: Use the weather-api test project (`apps/weather-api-tests/`) to test the webhook CRUD endpoints — create a subscription, list it, delete it.
3. **End-to-end delivery test**:
   - Register a webhook pointing at a local HTTP echo server (e.g., `https://webhook.site` or a simple Flask app).
   - Create a weather forecast via `POST /weather`.
   - Wait for Debezium to capture the change (typically <5 seconds).
   - Verify the echo server received the POST with the correct payload and valid `X-Weather-Signature` header.
   - Verify the delivery record appears in `GET /webhooks/{id}/deliveries`.
4. **Retry test**: Register a webhook pointing at a URL that returns 500. Verify the consumer retries 3 times with increasing delays, then marks the delivery as `dead_letter`.
5. **Manual verification**: Use `kafka-ui` at `https://localhost:8443/kafka-ui` to observe the consumer group `webhook-publisher` and confirm it is consuming from the CDC topic with no lag.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Webhook delivery blocks Kafka consumption** — slow or unresponsive webhook URLs could cause consumer lag and Kafka rebalancing. | Deliver webhooks asynchronously: use a thread pool (or `asyncio`) with a timeout of 10 seconds per request. If all threads are busy, buffer events in memory and process the backlog before consuming more. |
| **Credential exposure** — webhook secrets are stored in plaintext in Postgres. | For a dev environment this is acceptable (consistent with existing hardcoded passwords in pod YAMLs). For production, encrypt secrets at rest using a KMS or Postgres `pgcrypto`. |
| **Schema evolution breaks consumer** — if the Avro schema changes (e.g., new columns added to WeatherForecasts), the consumer may fail to deserialize. | Use the Schema Registry's Avro deserializer which handles backward-compatible schema evolution automatically. The webhook payload is a simplified JSON projection, not the raw Avro — so new fields are ignored unless explicitly mapped. |
| **Duplicate deliveries** — Kafka's at-least-once semantics mean a message may be consumed twice after a consumer restart. | Include a deterministic `delivery_id` (hash of `topic + partition + offset`) in the webhook delivery record. Before delivering, check if a delivery with that ID already exists. |
| **Dead-letter backlog grows unbounded** — failed webhooks accumulate delivery records. | Add a periodic cleanup: delete `dead_letter` deliveries older than 30 days. This can be a simple SQL `DELETE` in the consumer's startup routine or a scheduled task. |

## Dependencies

- **No hard dependencies** on other IDEAS.md items. The CDC topic `weather.public.WeatherForecasts` already exists and emits events whenever forecasts are created/updated/deleted.
- **Beneficial**: "Add location to WeatherForecast" — webhook payloads would be more useful if they include location data.
- **Beneficial**: "Rotate hardcoded credentials" — webhook secrets and Postgres credentials should eventually move to proper secret management.

## Estimated Complexity

**Large** — This introduces a new long-running service (the Kafka consumer), a new data model (two tables + migration), new API endpoints, a new container image, and delivery infrastructure with retry/dead-letter semantics. The individual pieces are straightforward, but the integration surface area (Kafka + Schema Registry + Postgres + HTTP delivery + monitoring) is broad.
