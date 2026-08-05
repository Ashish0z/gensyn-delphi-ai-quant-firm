# Quick Start (Windows + Docker Desktop)

This guide is the fastest way to run the project on Windows.

## Prerequisites

1. **Docker Desktop for Windows** (WSL2 backend enabled)
2. **Node.js 18+** (20 recommended)
3. **Git**
4. **Ollama** (optional but recommended AI backend)

## 1) Start infrastructure with Docker Desktop

From repository root:

```powershell
cd C:\path\to\gensyn-delphi-ai-quant-firm
docker compose -f .\infra\docker-compose.yml up -d
```

Verify:

```powershell
docker compose -f .\infra\docker-compose.yml ps
```

## 2) Configure environment

Create `.env` from your example/source values and set required keys:

- `DELPHI_API_ACCESS_KEY`
- `DELPHI_SIGNER_TYPE=private_key`
- `WALLET_PRIVATE_KEY`
- `WALLET_ADDRESS`
- `DELPHI_NETWORK=testnet` (or desired)

Recommended AI settings:

- `OLLAMA_HOST=http://localhost:11434`
- `OLLAMA_MODEL=llama3.2`

Optional infra settings:

- `REDIS_URL=redis://localhost:6379`
- `TELEMETRY_PORT=4000`

## 3) Install dependencies

```powershell
npm install
```

## 4) Run the system

Single cycle:

```powershell
node .\quant_firm\ai_quant_firm_orchestrator.mjs
```

Continuous daemon:

```powershell
node .\quant_firm\ai_quant_firm_daemon.mjs
```

Full distributed process orchestrator:

```powershell
node .\event_system\orchestrator.mjs
```

## 5) View dashboards

- **Telemetry dashboard**: http://localhost:4000
- **Prometheus UI**: http://localhost:9090
- **Grafana UI**: http://localhost:3000 (login `admin/admin`)

Grafana setup:
1. Add data source: Prometheus
2. URL: `http://prometheus:9090` if Grafana and Prometheus are both in compose network (recommended from Grafana container context)
3. Build panels using exported metrics such as:
   - `delphi_wallet_usdc_balance`
   - `delphi_active_positions_count`
   - `delphi_llm_calls_total`
   - `delphi_circuit_breaker_status`
   - `delphi_rpc_latency_ms`
   - `delphi_ewma_max_zscore`

## 6) Stop infrastructure

```powershell
docker compose -f .\infra\docker-compose.yml down
```

## Troubleshooting (Windows)

- If ports 3000/6379/9090 are occupied, stop conflicting apps and restart compose.
- Ensure Docker Desktop is running before `docker compose`.
- If Ollama is not running, use fallback/non-LLM paths or start Ollama service first.
