# 🏗️ Infrastructure Setup Guide

This document explains how to set up every infrastructure component the system uses.  
All components except **Ollama** and **SQLite** are optional — the system degrades gracefully when they are absent.

---

## Required components

### 1. Node.js ≥ 18

```bash
# macOS / Linux (via nvm)
nvm install 20
nvm use 20

# Verify
node --version   # v20.x.x
```

### 2. Ollama (local LLM server — primary AI backend)

Ollama runs open-source LLMs locally. It replaces external API calls for strategy generation, news analysis, and whale reasoning.

**Install:**

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh
```

**Start the server:**

```bash
ollama serve
# Server listens on http://localhost:11434 by default
```

**Pull a model** (choose one):

```bash
# Recommended: llama3.2 (fast, good quality, ~2 GB)
ollama pull llama3.2

# Alternatives
ollama pull qwen2.5-coder   # strong at code generation
ollama pull mistral
ollama pull gemma3:4b
```

**Verify:**

```bash
curl http://localhost:11434/api/tags
# Should list your pulled models
```

Set `OLLAMA_MODEL` in `.env` to whichever model you pulled:

```env
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

---

### 3. SQLite (embedded — no separate server needed)

All persistent state (feature store, trade log, voter stats, RL policy, event log) is stored in a single SQLite database at `./data/quant_firm.db`.

The `better-sqlite3` Node.js driver is installed automatically via `npm install`.  
The database file and tables are created automatically on first run.

**Inspect the database manually:**

```bash
# Install the sqlite3 CLI
brew install sqlite3            # macOS
sudo apt-get install sqlite3    # Ubuntu/Debian

# Open the database
sqlite3 data/quant_firm.db

# Useful queries
.tables
SELECT COUNT(*) FROM market_ticks;
SELECT * FROM trade_log ORDER BY id DESC LIMIT 10;
SELECT * FROM voter_stats;
SELECT value FROM rl_policy WHERE key = 'state';
.quit
```

---

## Optional components

### 4. Redis (distributed pub/sub between processes)

Without Redis, all event bus messages are in-process only. Redis enables the forked microservice processes (RL validator, news node, whale watcher) to publish events that the main daemon process receives.

**Install:**

```bash
# macOS
brew install redis
brew services start redis

# Linux
sudo apt-get install redis-server
sudo systemctl start redis

# Docker (simplest)
docker run -d -p 6379:6379 --name redis redis:7-alpine
```

**Verify:**

```bash
redis-cli ping   # → PONG
```

**Configure:**

```env
REDIS_URL=redis://localhost:6379
```

The event bus auto-detects Redis at startup. If unavailable it silently falls back to in-process mode.

---

### 5. Prometheus + Grafana (metrics & dashboards)

The system exposes a Prometheus `/metrics` endpoint on port 9090 (configurable).

**Prometheus:**

```bash
# Docker
docker run -d \
  -p 9090:9090 \
  -v $(pwd)/infra/prometheus.yml:/etc/prometheus/prometheus.yml \
  --name prometheus \
  prom/prometheus
```

Create `infra/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'gensyn-delphi'
    static_configs:
      - targets: ['host.docker.internal:9090']
```

> On Linux replace `host.docker.internal` with your machine's LAN IP or `172.17.0.1` (Docker bridge).

**Grafana:**

```bash
docker run -d \
  -p 3000:3000 \
  --name grafana \
  grafana/grafana-oss
```

1. Open `http://localhost:3000` (admin / admin)
2. Add Prometheus data source: `http://host.docker.internal:9090`
3. Import a dashboard — use **Metric names** below:

| Metric | Type | Description |
|--------|------|-------------|
| `delphi_wallet_usdc_balance` | gauge | Live USDC balance |
| `delphi_active_positions_count` | gauge | Open prediction market positions |
| `delphi_llm_calls_total` | counter | Total LLM API calls since start |
| `delphi_circuit_breaker_status` | gauge | 1 = circuit breaker active |
| `delphi_rpc_latency_ms` | gauge | Last Delphi RPC round-trip latency |
| `delphi_ewma_max_zscore` | gauge | Latest EWMA anomaly Z-score |

---

### 6. Langfuse (LLM prompt tracing)

Langfuse records every LLM prompt + response with latency and token counts. Without keys, traces are stored in SQLite only.

**Cloud (free tier available):** https://cloud.langfuse.com

1. Create a project
2. Copy your **Public Key** and **Secret Key**
3. Add to `.env`:

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com
```

**Self-hosted (Docker):**

```bash
docker compose up -d   # see https://langfuse.com/docs/deployment/self-host
```

```env
LANGFUSE_HOST=http://localhost:3000
```

---

### 7. Telemetry Web Dashboard

The built-in dashboard is available at `http://localhost:4000` when running the orchestrator or daemon. No extra setup needed.

```env
TELEMETRY_PORT=4000   # override if needed
```

---

## Quick-start Docker Compose (all optional services)

Save as `infra/docker-compose.yml`:

```yaml
version: '3.9'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana-oss
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    depends_on:
      - prometheus
```

```bash
cd infra && docker compose up -d
```

---

## Minimum viable setup (no Docker, no cloud keys)

```bash
# 1. Install Ollama and pull a model
ollama serve &
ollama pull llama3.2

# 2. Install Node dependencies
npm install

# 3. Create .env (see .env.example)
cp .env.example .env
# Edit .env: set WALLET_PRIVATE_KEY, WALLET_ADDRESS, DELPHI_API_ACCESS_KEY

# 4. Run
node quant_firm/ai_quant_firm_daemon.mjs
```

The SQLite database is created automatically at `data/quant_firm.db`.
