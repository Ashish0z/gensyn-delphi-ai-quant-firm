# Infrastructure Guide (Windows-Friendly)

This document explains required and optional infrastructure, with Docker Desktop-first instructions for Windows users.

## Runtime model

- Application services run as Node.js processes on host.
- Optional infra services run in containers:
  - Redis
  - Prometheus
  - Grafana

## Required components

1. Node.js >= 18
2. Project dependencies (`npm install`)
3. Delphi credentials in `.env`
4. (Recommended) Ollama running on `http://localhost:11434`

## Optional observability/services via Docker

All compose resources are defined in:
- `/home/runner/work/gensyn-delphi-ai-quant-firm/gensyn-delphi-ai-quant-firm/infra/docker-compose.yml`

Prometheus scrape config:
- `/home/runner/work/gensyn-delphi-ai-quant-firm/gensyn-delphi-ai-quant-firm/infra/prometheus.yml`

### Start (Windows PowerShell)

```powershell
docker compose -f .\infra\docker-compose.yml up -d
```

### Stop

```powershell
docker compose -f .\infra\docker-compose.yml down
```

## Component endpoints

- Redis: `localhost:6379`
- Prometheus UI: `http://localhost:9090`
- Grafana UI: `http://localhost:3000`
- App telemetry dashboard: `http://localhost:4000`
- App metrics endpoint: `http://localhost:9090/metrics`

## Grafana configuration

1. Log in to `http://localhost:3000` with `admin/admin`
2. Add Prometheus datasource
3. Datasource URL:
   - `http://prometheus:9090` (recommended when both services are in compose)
4. Create dashboards/panels from metrics:
   - `delphi_wallet_usdc_balance`
   - `delphi_active_positions_count`
   - `delphi_llm_calls_total`
   - `delphi_circuit_breaker_status`
   - `delphi_rpc_latency_ms`
   - `delphi_ewma_max_zscore`

## Redis behavior

If Redis is reachable via `REDIS_URL`, event bus can communicate across forked processes using pub/sub.
If Redis is unavailable, system falls back to in-process event handling.

## SQLite behavior

Local SQLite file is created at `data/quant_firm.db` on first run.
No separate DB server is required.

## Recommended startup order (Windows)

1. Start Docker Desktop
2. `docker compose up -d` for infra
3. Ensure `.env` is populated
4. `npm install`
5. Start one runtime:
   - `node .\quant_firm\ai_quant_firm_orchestrator.mjs` or
   - `node .\quant_firm\ai_quant_firm_daemon.mjs` or
   - `node .\event_system\orchestrator.mjs`
6. Open dashboards (Telemetry/Prometheus/Grafana)
