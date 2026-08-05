# 🚀 Quick Start Guide

Getting started with the **Gensyn Delphi AI Quant Firm** in under 5 minutes.

For full infrastructure setup (Redis, Prometheus/Grafana, Langfuse) see [INFRASTRUCTURE.md](./INFRASTRUCTURE.md).

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | v18+ | v20 recommended |
| **Ollama** | latest | Local LLM server — primary AI backend |
| **Git** | any | |

---

## 1. Install Ollama and pull a model

```bash
# Install Ollama — https://ollama.com
# macOS:
brew install ollama

# Linux:
curl -fsSL https://ollama.com/install.sh | sh

# Start the server
ollama serve

# Pull a model (in a new terminal)
ollama pull llama3.2       # recommended (~2 GB, fast)
# or: ollama pull qwen2.5-coder
```

---

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the **required** values:

```env
DELPHI_API_ACCESS_KEY=your_delphi_key
DELPHI_SIGNER_TYPE=private_key
WALLET_PRIVATE_KEY=0x_your_private_key
WALLET_ADDRESS=0x_your_wallet_address
DELPHI_NETWORK=testnet

OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

All other values (`GEMINI_API_KEY`, `REDIS_URL`, `LANGFUSE_*`) are optional — the system runs without them.

---

## 3. Install Node.js dependencies

```bash
npm install
```

---

## 4. Run the system

### Single-pass orchestrator (test one full cycle)

```bash
node quant_firm/ai_quant_firm_orchestrator.mjs
```

### 24/7 daemon (runs every 60 seconds)

```bash
node quant_firm/ai_quant_firm_daemon.mjs
```

### Full distributed cluster (all microservices + telemetry UI)

```bash
node event_system/orchestrator.mjs
```

---

## 5. Observe

| Interface | URL | Notes |
|---|---|---|
| **Telemetry Web Dashboard** | http://localhost:4000 | Live voter pool, trades, RL policy |
| **Prometheus Metrics** | http://localhost:9090/metrics | Raw metrics |
| **Grafana** | http://localhost:3000 | Requires Grafana — see INFRASTRUCTURE.md |

---

## 6. Inspect the database

All state is in `data/quant_firm.db` (SQLite):

```bash
sqlite3 data/quant_firm.db

sqlite> SELECT COUNT(*) FROM market_ticks;
sqlite> SELECT * FROM trade_log ORDER BY id DESC LIMIT 5;
sqlite> SELECT name, sharpe_ratio, win_rate, total_trades, status FROM voter_stats;
sqlite> SELECT value FROM rl_policy WHERE key = 'state';
sqlite> .quit
```

