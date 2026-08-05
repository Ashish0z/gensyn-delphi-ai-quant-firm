# Gensyn Delphi AI Quant Firm

Event-driven multi-agent quant trading system for Gensyn Delphi markets with local AI inference, risk controls, and observability.

## What this repository contains

- `quant_firm/`: core orchestrator, daemon, feature/risk logic
- `event_system/`: pub/sub event nodes and executor pipeline
- `quant_system/`: backtesting and strategy tournament components
- `telemetry/`: Prometheus exporter and local telemetry dashboard server
- `infra/`: Docker Compose stack for Redis, Prometheus, and Grafana

## Platform support

The project runs on Linux, macOS, and Windows.

- **Windows recommended path**: Docker Desktop (for infra) + Node.js on host.
- The app itself runs with `node` on host; optional services run in Docker.

See:
- [QUICKSTART.md](./QUICKSTART.md) for startup steps
- [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) for infra and dashboards
- [ARCHITECTURE.md](./ARCHITECTURE.md) for full system design and interactions

## Quick run

```bash
npm install
node quant_firm/ai_quant_firm_orchestrator.mjs
```

Daemon mode:

```bash
node quant_firm/ai_quant_firm_daemon.mjs
```

## Dashboards and endpoints

- Telemetry dashboard: `http://localhost:4000`
- Prometheus metrics endpoint: `http://localhost:9090/metrics` (exported by app)
- Prometheus UI (Docker): `http://localhost:9090`
- Grafana (Docker): `http://localhost:3000` (default `admin/admin`)

## Notes

- SQLite database is created at `data/quant_firm.db` on first run.
- Redis/Langfuse/Prometheus/Grafana are optional; system degrades gracefully if unavailable.
