# System Design Document

## 1. Purpose and Scope

This document describes the end-to-end architecture for the Gensyn Delphi AI Quant Firm, including:
- Internal components and responsibilities
- External dependencies/services
- Data flow and interaction boundaries
- Runtime and observability topology

## 2. High-Level Architecture

```mermaid
flowchart TD
    subgraph EXT["External Services"]
        DELPHI["Gensyn Delphi API\n(markets, prices, execution)"]
        OLLAMA["Ollama\nlocalhost:11434"]
        GEMINI["Google Gemini\n(fallback LLM)"]
        LANGFUSE["Langfuse Cloud\n(LLM tracing)"]
        REDIS[("Redis\nlocalhost:6379")]
        PROM["Prometheus\nlocalhost:9090"]
        GRAFANA["Grafana\nlocalhost:3000"]
    end

    subgraph PERSIST["Persistence"]
        SQLITE[("SQLite\ndata/quant_firm.db\n─────────────\ntrade_log\nvoter_stats\nrl_policy\nstrategy_failures\nevent_log")]
    end

    subgraph INGEST["1 · Ingestion & Feature Layer"]
        UFS["UnifiedFeatureStore\nunified_feature_store.mjs"]
        NEWS["NewsSentimentNode\nnews_sentiment_node.mjs"]
        WHALE["WhaleAgentNode\nllm_whale_agent_node.mjs"]
    end

    subgraph STRATEGY["2 · Strategy Generation"]
        OLLAMA_GEN["OllamaStrategyGeneratorNode\nollama_strategy_generator_node.mjs"]
        LLM_GEN["RealLLMStrategyGeneratorNode\nllm_strategy_generator_real.mjs\n(batch + incremental)"]
        FAILS[("strategy_failures\nin SQLite\n(failure feedback loop)")]
    end

    subgraph EVAL["3 · Evaluation & Selection"]
        BACK["BacktesterEngine\nbacktester_engine.mjs\nSharpe ≥ 1.0 · WinRate ≥ 50%"]
        VOTER["VoterPoolValidator\nvoter_pool_validator.mjs\n(max 5, evict stale)"]
        RL["RLStrategyOptimizer\nrl_validator_node.mjs\n(weight sync + pruning)"]
    end

    subgraph RISK["4 · Risk & Signal Gate"]
        SIG["SignalAccumulatorBuffer\nsignal_buffer_node.mjs\n(mass ≥ 0.20, ≥ 2 signals)"]
        COV["CovarianceRiskEngine\ncovariance_risk_engine.mjs\nKelly · circuit breaker · cov cap"]
        EWMA["OnlineEwmaMlNode\nonline_ewma_ml_node.mjs\n(anomaly Z-score)"]
    end

    subgraph EXEC["5 · Execution"]
        EXECUTOR["Executor / Daemon\nai_quant_firm_daemon.mjs\nbuyShares · ensureTokenApproval"]
    end

    subgraph OBS["6 · Observability"]
        PROM_EXP["PrometheusExporter\nprometheus_exporter.mjs\n:9091/metrics"]
        DASH["TelemetryDashboardServer\ntelemetry_dashboard_server.mjs\n:4000"]
        TRACER["LangfuseTracer\nlangfuse_tracer.mjs"]
        EBUS["DistributedEventBus\nevent_bus.mjs"]
    end

    %% Ingestion
    DELPHI -->|"listMarkets · spotProbs"| UFS
    OLLAMA -->|"news/whale prompts"| NEWS
    OLLAMA -->|"news/whale prompts"| WHALE
    NEWS --> UFS
    WHALE --> UFS
    UFS -->|historical records| BACK
    UFS -->|live record| SIG

    %% Strategy generation
    OLLAMA -->|generate| OLLAMA_GEN
    OLLAMA -->|generate batch| LLM_GEN
    GEMINI -->|fallback| LLM_GEN
    FAILS -->|"recent failure context\ninjected into prompt"| LLM_GEN
    OLLAMA_GEN --> BACK
    LLM_GEN --> BACK

    %% Evaluation
    BACK -->|promoted strategies| VOTER
    VOTER -->|active pool| RL
    RL -->|synced weights| EXECUTOR

    %% Risk gate
    VOTER -->|"fn(record, covMatrix)"| SIG
    EWMA -->|anomaly signal| SIG
    SIG -->|triggered batch| COV
    COV -->|passed| EXECUTOR

    %% Execution
    EXECUTOR -->|"buyShares · quoteBuy"| DELPHI
    EXECUTOR -->|appendTrade| SQLITE

    %% Persistence
    VOTER -->|upsertVoterStats| SQLITE
    RL -->|policy weights| SQLITE
    BACK -->|logStrategyFailure| FAILS
    FAILS -.->|stored in| SQLITE

    %% Event bus
    EXECUTOR --> EBUS
    EBUS <-->|pub/sub| REDIS

    %% Observability
    EXECUTOR --> PROM_EXP
    PROM_EXP -->|scrape| PROM
    PROM --> GRAFANA
    DASH -->|reads| SQLITE
    DASH -->|live balance/positions| DELPHI
    LLM_GEN --> TRACER
    OLLAMA_GEN --> TRACER
    TRACER -->|traces| LANGFUSE
    TRACER -->|event_log| SQLITE

    %% Styles
    classDef ext fill:#1e3a5f,stroke:#38bdf8,color:#e2e8f0
    classDef persist fill:#1a2e1a,stroke:#10b981,color:#e2e8f0
    classDef obs fill:#2d1b4e,stroke:#a855f7,color:#e2e8f0
    class DELPHI,OLLAMA,GEMINI,LANGFUSE,REDIS,PROM,GRAFANA ext
    class SQLITE,FAILS persist
    class PROM_EXP,DASH,TRACER,EBUS obs
```

The system is an event-driven multi-agent trading pipeline composed of:

1. **Data + feature ingestion layer**
2. **Strategy generation and evaluation layer**
3. **Validation and risk gate layer**
4. **Execution layer**
5. **Telemetry and observability layer**
6. **Persistence layer**

Primary process modes:
- Single-pass orchestrator (`quant_firm/ai_quant_firm_orchestrator.mjs`)
- Continuous daemon (`quant_firm/ai_quant_firm_daemon.mjs`)
- Distributed event orchestrator (`event_system/orchestrator.mjs`)

## 3. Components and Interactions

### 3.1 Internal Components

#### Core quant_firm components

- `quant_firm/ai_quant_firm_orchestrator.mjs`
  - Coordinates one full strategy-to-trade cycle.
  - Pulls data, triggers strategy generation/backtest, applies risk checks, and dispatches execution.

- `quant_firm/ai_quant_firm_daemon.mjs`
  - Repeats orchestration loop on interval for continuous operation.

- `quant_firm/unified_feature_store.mjs`
  - Writes/reads multi-source market features.
  - Persists structured signals and state to SQLite.

- `quant_firm/llm_strategy_generator*.mjs` and `quant_firm/ollama_strategy_generator_node.mjs`
  - Generates candidate trading logic using configured LLM provider.

- `quant_firm/voter_pool_validator.mjs`
  - Maintains active pool of candidate strategies.
  - Filters stale/underperforming strategies.

- `quant_firm/covariance_risk_engine.mjs`
  - Enforces concentration, covariance, and pre-trade safety checks.
  - Produces size/risk decision input for execution.

#### quant_system components

- `quant_system/backtester_engine.mjs`
  - Replays historical feature windows.
  - Computes quality metrics (e.g., win-rate/sharpe-like performance indicators).

- `quant_system/ml_strategy_tournament_agent.mjs`
  - Compares candidates and emits selected strategy set.

- `quant_system/pre_trade_risk_engine.mjs`
  - Additional risk checks before order intent generation.

#### event_system components

- `event_system/event_bus.mjs`
  - Internal pub/sub event transport abstraction.
  - Uses Redis when available; can run in in-process mode.

- `event_system/news_sentiment_node.mjs`
  - Emits event signals from news/sentiment context.

- `event_system/adversarial_watcher_node.mjs`
  - Emits event signals from whale/adversarial market observations.

- `event_system/consensus_node.mjs`
  - Aggregates per-node outputs into consensus signals.

- `event_system/rl_validator_node.mjs`
  - Applies adaptive weighting/meta-policy updates.

- `event_system/signal_buffer_node.mjs`
  - Buffers and combines aligned signals before execution.

- `event_system/executor_node.mjs`
  - Converts validated signal into on-chain actions through Delphi SDK.

### 3.2 Telemetry components

- `telemetry/prometheus_exporter.mjs`
  - Exposes metrics endpoint for scrape.

- `telemetry/telemetry_dashboard_server.mjs`
  - Local dashboard for live runtime and strategy state.

- `telemetry/langfuse_tracer.mjs`
  - Captures LLM prompt/response traces for observability.

## 4. External Services and Dependencies

### Required external service

- **Gensyn Delphi API / chain-facing endpoints**
  - Used for market reads and execution paths through SDK.

### Optional external/internal services

- **Ollama** (`http://localhost:11434`)
  - Local model host for strategy generation.

- **Redis** (`redis://localhost:6379`)
  - Cross-process pub/sub event transport.

- **Prometheus** (`http://localhost:9090`)
  - Scrapes application metrics.

- **Grafana** (`http://localhost:3000`)
  - Dashboard visualization of Prometheus metrics.

- **Langfuse Cloud/Self-host**
  - Optional LLM tracing backend.

## 5. Persistence and Data Stores

- **SQLite**: `data/quant_firm.db`
  - Feature snapshots
  - Trade logs
  - Voter/strategy stats
  - RL policy and state metadata

- **In-memory/event buffers**
  - Short-lived signal aggregation and pipeline state between event nodes.

## 6. End-to-End Interaction Flow

1. Ingestion nodes collect market/news/whale context and write to feature store.
2. Strategy generators produce candidate decision logic from recent features.
3. Backtester/tournament ranks candidates and emits active strategy subset.
4. Validator + RL node update weights and reject weak/stale candidates.
5. Risk engine applies pre-trade safety constraints.
6. Signal buffer consolidates qualified intents.
7. Executor node submits approved order flow to Delphi market interfaces.
8. Execution results feed telemetry and persistence.
9. Prometheus/Grafana/dashboard expose runtime state and performance.

## 7. Windows Runtime Topology

On Windows, recommended deployment is hybrid:

- Host processes:
  - Node runtime components (`quant_firm`, `event_system`, `quant_system`, telemetry server)
- Docker Desktop containers:
  - Redis
  - Prometheus
  - Grafana

Network assumptions:
- Host services are accessed by containers via `host.docker.internal`.
- Compose-internal calls use service DNS names (e.g., `prometheus`).

## 8. Operations and Monitoring

### Health/visibility endpoints

- Telemetry dashboard: `http://localhost:4000`
- Prometheus UI: `http://localhost:9090`
- Grafana UI: `http://localhost:3000`

### Core observable signals

- LLM call count and latency proxies
- Active position count and wallet balances
- Circuit breaker status
- Risk/latency indicators and anomaly scores

## 9. Failure Modes and Degradation

- If Redis is down: event bus can fall back to in-process operation.
- If Grafana/Prometheus are down: trading pipeline can continue without dashboards.
- If Langfuse is unavailable: local execution continues without external trace sink.
- If LLM provider is unavailable: strategy generation paths depending on that provider degrade or pause depending on configuration.

## 10. Security and Secrets Boundaries

- Secrets (wallet key, Delphi key, optional cloud keys) are sourced from `.env` only.
- `.env` and runtime DB/artifacts must not be committed.
- Execution node should be treated as high-trust boundary due to signing and order submission.
