# 🚀 Quick Start Guide

Getting started with the **Gensyn Delphi AI Quant Firm** in 3 easy steps.

---

## 1. Prerequisites

- **Node.js**: v18+ or v20+
- **Git**: Installed
- **Google Gemini API Key**: Free API Key from [Google AI Studio](https://aistudio.google.com/app/apikey)

---

## 2. Environment Configuration

1. Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

2. Add your environment credentials:

```env
# Delphi Network Configuration
DELPHI_API_ACCESS_KEY=your_access_key
DELPHI_SIGNER_TYPE=private_key
WALLET_PRIVATE_KEY=0x_your_wallet_private_key
DELPHI_NETWORK=testnet

# Real Google Gemini LLM API Key
GEMINI_API_KEY=AIzaSy_your_gemini_api_key
```

---

## 3. Launching the System

### Single-Pass Orchestrator Pass

To test a single complete cycle (Data Ingestion $\rightarrow$ Gemini LLM Synthesis $\rightarrow$ Backtest Tournament $\rightarrow$ Active Pool Pruning $\rightarrow$ Risk Gates $\rightarrow$ On-Chain Execution):

```bash
node quant_firm/ai_quant_firm_orchestrator.mjs
```

### 24/7 Master Daemon

To run the continuous, self-evolving daemon background loop (runs cycles every 3 minutes):

```bash
node quant_firm/ai_quant_firm_daemon.mjs
```

---

## 4. Viewing Logs & Agent TUI

The system emits real-time event logs. You can inspect live logs or view event traces:

```bash
# View live daemon task output
cat .quant_firm_data/unified_features.jsonl
```
