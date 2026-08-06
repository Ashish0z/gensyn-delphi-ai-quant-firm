import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { UnifiedFeatureStore } from './unified_feature_store.mjs';
import { OllamaStrategyGeneratorNode } from './ollama_strategy_generator_node.mjs';
import { RealLLMStrategyGeneratorNode } from './llm_strategy_generator_real.mjs';
import { OnlineEwmaMlNode } from './online_ewma_ml_node.mjs';
import { BacktesterEngine } from '../quant_system/backtester_engine.mjs';
import { VoterPoolValidator } from './voter_pool_validator.mjs';
import { CovarianceRiskEngine } from './covariance_risk_engine.mjs';
import { SignalAccumulatorBuffer } from '../event_system/signal_buffer_node.mjs';
import { RLStrategyOptimizer } from '../event_system/rl_validator_node.mjs';
import { appendTrade, getRecentTrades, logStrategyFailure, logNodeEvent, getDb, upsertVoterStats, getActiveVoters, setVoterStatus, getOpenPositionEntries } from './db.mjs';
import { WALLET_ADDRESS } from './config.mjs';
import { PrometheusExporter } from '../telemetry/prometheus_exporter.mjs';
import { startTelemetryDashboardServer } from '../telemetry/telemetry_dashboard_server.mjs';
import { LLMNewsAgentNode } from './llm_news_agent_node.mjs';
import { LLMWhaleAgentNode } from './llm_whale_agent_node.mjs';
import { execSync } from 'child_process';

const BOOTSTRAP_TARGET     = 20;
const BOOTSTRAP_BATCH      = 10;
const BOOTSTRAP_MAX_ROUNDS = 4;
const SIMILARITY_THRESHOLD = 0.50;
const PRICE_CHANGE_THRESHOLD  = 0.005; // trigger voter eval when price moves ≥ 0.5%
const PRICE_POLL_INTERVAL_MS  = 10_000; // poll prices every 10 seconds

// Cache LLM-heavy market analysis for 5 minutes to avoid redundant calls each cycle
const _featureCache = new Map(); // marketId -> { ts, newsSentiment, whaleFlow }
const FEATURE_CACHE_TTL_MS = 5 * 60 * 1000;

/* ── Jaccard similarity on code tokens to catch duplicate strategies ── */
function codeJaccardSimilarity(codeA, codeB) {
  const setA = new Set(codeA.match(/\w+/g) || []);
  const setB = new Set(codeB.match(/\w+/g) || []);
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

function isTooSimilar(newCode, existingPool) {
  return existingPool.some(v => v.code && codeJaccardSimilarity(newCode, v.code) >= SIMILARITY_THRESHOLD);
}

/* ── Backtest candidates and promote using competitive replacement ── */
function backtestAndPromote(candidates, historicalRecords, activeVoterPool, promExporter) {
  const backtester = new BacktesterEngine(0.02, 0.02, 0.005);
  let promoted = 0;

  // Score every candidate first
  const scored = [];
  for (const strat of candidates) {
    const report  = backtester.runBacktest(strat.name, strat.fn, historicalRecords);
    const sharpe  = Number.isFinite(report.sharpeRatio) ? report.sharpeRatio : 0.0;
    const winRate = Number.isFinite(report.winRate)     ? report.winRate     : 0.0;
    console.log(`  ${report.totalTrades > 0 ? '📊' : '❌'} [${strat.name}] Trades: ${report.totalTrades} | Sharpe: ${sharpe.toFixed(2)} | WinRate: ${winRate.toFixed(1)}%`);
    if (report.totalTrades === 0) {
      if (strat.code) logStrategyFailure({ code: strat.code, sharpe, winRate, totalTrades: 0, reason: 'generated zero trades — logic never triggered on real-anchored data' });
      continue;
    }
    scored.push({ strat, sharpe, winRate });
  }

  const poolFull = activeVoterPool.length >= BOOTSTRAP_TARGET;

  if (!poolFull) {
    // Phase 1 — bootstrap: admit everything that fires
    for (const { strat, sharpe, winRate } of scored) {
      if (activeVoterPool.length >= BOOTSTRAP_TARGET) break;
      activeVoterPool.push({ name: strat.name, fn: strat.fn, code: strat.code || '', sharpeRatio: sharpe, winRate });
      upsertVoterStats(strat.name, sharpe, winRate, strat.code || '');
      promoted++;
      console.log(`  ✅ Promoted [${strat.name}] | Pool: ${activeVoterPool.length}/${BOOTSTRAP_TARGET}`);
    }
  } else {
    // Phase 2 — refinement: among candidates that beat the worst voter,
    // prefer the one with the best Sharpe; use lowest similarity as tiebreaker.
    const worstIdx = activeVoterPool.reduce((wi, v, i, a) => v.sharpeRatio < a[wi].sharpeRatio ? i : wi, 0);
    const worst = activeVoterPool[worstIdx];

    const challengers = scored.filter(s => s.sharpe > worst.sharpeRatio);
    if (!challengers.length) {
      console.log(`  ⏭️  No candidate beats worst voter (Sharpe ${worst.sharpeRatio.toFixed(2)})`);
    } else {
      // Sort: highest Sharpe first; break ties by lowest max-similarity to pool
      challengers.sort((a, b) => {
        if (Math.abs(b.sharpe - a.sharpe) > 0.05) return b.sharpe - a.sharpe;
        const simA = Math.max(...activeVoterPool.map(v => v.code ? codeJaccardSimilarity(a.strat.code || '', v.code) : 0));
        const simB = Math.max(...activeVoterPool.map(v => v.code ? codeJaccardSimilarity(b.strat.code || '', v.code) : 0));
        return simA - simB; // prefer lower similarity
      });
      const { strat, sharpe, winRate } = challengers[0];
      console.log(`  🔄 Replacing worst [${worst.name}] (${worst.sharpeRatio.toFixed(2)}) → [${strat.name}] (${sharpe.toFixed(2)})${challengers.length > 1 ? ` (chosen from ${challengers.length} challengers by Sharpe+diversity)` : ''}`);
      setVoterStatus(worst.name, 'EVICTED');
      activeVoterPool.splice(worstIdx, 1);
      activeVoterPool.push({ name: strat.name, fn: strat.fn, code: strat.code || '', sharpeRatio: sharpe, winRate });
      upsertVoterStats(strat.name, sharpe, winRate, strat.code || '');
      promoted++;
    }
  }

  promExporter.updateMetric('delphi_llm_calls_total',
    (promExporter.metrics.delphi_llm_calls_total || 0) + candidates.length);
  return promoted;
}/* ── Evaluate open positions and sell when EV of holding turns negative ── */
async function runPositionManagement(client, openPositions, activeVoterPool, marketMap, covMatrix, rlWeights) {
  if (!openPositions.length || !activeVoterPool.length) return;

  for (const pos of openPositions) {
    const mkt = marketMap.get(pos.marketProxy);
    if (!mkt) continue;

    const probs      = mkt.spotImpliedProbabilities || [0.5, 0.5];
    const outcomeIdx = Number(pos.outcomeIdx);
    // Current market price for the held outcome
    const currentPrice = outcomeIdx === 0 ? probs[0] : probs[1] ?? (1 - probs[0]);
    const heldLabel    = outcomeIdx === 0 ? 'YES' : 'NO';
    const question     = mkt.metadata?.question || mkt.id;
    const fee          = mkt.tradingFee ? Number(mkt.tradingFee) / 1e18 : 0.02;
    const daysLeft     = mkt.resolvesAt ? (new Date(mkt.resolvesAt) - Date.now()) / 86_400_000 : 999;

    const record = {
      marketAddress: mkt.id, question, spotProbs: probs,
      newsSentiment: 0.5, whaleFlow: 0, category: mkt.category,
      priceTrend: 0, volume: 0, daysToResolution: daysLeft,
      tradingFee: fee, isVerifiable: !!mkt.verifiable,
    };

    // Compute RL-weighted voter probability estimate for this market
    let weightedProbSum = 0, totalWeight = 0;
    for (const voter of activeVoterPool) {
      try {
        const res = voter.fn(record, covMatrix);
        if (!res || res.vote === 'SKIP') continue;
        // estimatedProb is always the YES probability regardless of vote direction
        const w = rlWeights[voter.name] ?? (1 / activeVoterPool.length);
        weightedProbSum += res.estimatedProb * w;
        totalWeight += w;
      } catch (_) {}
    }
    if (totalWeight === 0) continue; // no voter has opinion on this market

    const voterEstimatedYesProb = weightedProbSum / totalWeight;

    // EV of holding this outcome = voter_yes_prob (for YES) or 1-voter_yes_prob (for NO)
    // minus the current market price for that outcome
    const voterOutcomeProb = outcomeIdx === 0 ? voterEstimatedYesProb : (1 - voterEstimatedYesProb);
    const holdingEV = voterOutcomeProb - currentPrice;

    // Time-decay factor: as resolution approaches, we require less negative EV to exit
    // (less time = less chance for price to recover)
    const urgency = Math.max(1, 30 / Math.max(1, daysLeft)); // 1x at 30+ days, 10x at 3 days
    const adjustedEV = holdingEV * urgency;

    // Sell when: adjusted EV < -fee (negative value to hold, net of exit fee)
    if (adjustedEV < -fee) {
      const reason = holdingEV < 0
        ? `EV ${holdingEV.toFixed(3)} × urgency ${urgency.toFixed(1)}x = ${adjustedEV.toFixed(3)} < -fee (${fee})`
        : `Time pressure (${daysLeft.toFixed(1)}d left) amplifies marginal EV ${holdingEV.toFixed(3)}`;

      console.log(`  📤 [Sell ${heldLabel}] "${question.slice(0, 50)}" | ${reason}`);
      try {
        const shares = BigInt(pos.shares);
        const { tokensOut } = await client.quoteSell({ marketAddress: pos.marketProxy, outcomeIdx, sharesIn: shares });
        const minTokensOut = (tokensOut * 98n) / 100n;
        const tx = await client.sellShares({ marketAddress: pos.marketProxy, outcomeIdx, sharesIn: shares, minTokensOut });
        console.log(`  ✅ [SOLD ${heldLabel}] ${(Number(tokensOut) / 1e6).toFixed(2)} USDC | TX: ${tx?.transactionHash}`);
      } catch (err) {
        console.error(`  ⚠️  Sell failed for ${pos.marketProxy}: ${err.message}`);
      }
    } else {
      console.log(`  📊 [Hold ${heldLabel}] "${question.slice(0, 40)}" | holdingEV=${holdingEV.toFixed(3)} urgency=${urgency.toFixed(1)}x → adjustedEV=${adjustedEV.toFixed(3)}`);
    }
  }
}
async function deriveMarketFeatures(subgraph, featureStore, market, question, impliedProb) {
  let buys = [], sells = [];
  try {
    ({ buys = [], sells = [] } = await subgraph.getMarketTrades(market.id, { first: 20 }));
  } catch (_) {}

  const buyVol   = buys.reduce((s, b)  => s + Number(b.tokensIn  || 0), 0) / 1e6;
  const sellVol  = sells.reduce((s, b) => s + Number(b.tokensOut || 0), 0) / 1e6;
  const totalVol = buyVol + sellVol;
  const buyPressure = totalVol > 0 ? buyVol / totalVol : 0.5;
  const largestBuy  = buys.length  ? Math.max(...buys.map(b  => Number(b.tokensIn  || 0) / 1e6)) : 0;
  const largestSell = sells.length ? Math.max(...sells.map(s => Number(s.tokensOut || 0) / 1e6)) : 0;

  // Price trend from stored ticks for this market
  const recentTicks = featureStore.db
    .prepare('SELECT yes_prob FROM market_ticks WHERE market_address=? ORDER BY timestamp DESC LIMIT 20')
    .all(market.id);
  const priceTrend = recentTicks.length >= 2
    ? recentTicks[0].yes_prob - recentTicks[recentTicks.length - 1].yes_prob
    : 0;

  return { buyPressure, buyVol, sellVol, largestBuy, largestSell, tradeCount: buys.length + sells.length, priceTrend, volume: buyVol + sellVol };
}

async function startDaemon() {
  console.log('🤖 AI QUANT FIRM DAEMON: REAL-TIME EVENT-DRIVEN MODE');

  const promExporter  = new PrometheusExporter();
  startTelemetryDashboardServer();

  // Shared mutable state passed to all loops
  const state = {
    client:          new DelphiClient(),
    rlOptimizer:     new RLStrategyOptimizer(),
    poolValidator:   new VoterPoolValidator(20, 40.0, 30),
    onlineEwmaNode:  new OnlineEwmaMlNode(0.15, 0.10, 2.5),
    featureStore:    new UnifiedFeatureStore(),
    promExporter,
    activeVoterPool: [],
    // Persistent signal buffer — accumulates signals across price polls
    signalBuffer:    new SignalAccumulatorBuffer(0.08, 2, 0.60),
    lastPrices:      new Map(), // marketId → last known YES price
    lastTradeCounts: new Map(), // marketId → last known trade count (whale detection)
    newsAgent:       new LLMNewsAgentNode(),
    whaleAgent:      new LLMWhaleAgentNode(),
    subgraph:        null, // set after first markets call
    isStrategyRunning: false,
  };

  // Restore pool from DB
  for (const row of getActiveVoters()) {
    try {
      const fn = new Function('record', 'covMatrix', row.code);
      state.activeVoterPool.push({ name: row.name, fn, code: row.code, sharpeRatio: row.sharpe_ratio, winRate: row.win_rate });
    } catch (_) {}
  }
  if (state.activeVoterPool.length) console.log(`♻️  [Startup] Restored ${state.activeVoterPool.length} voter(s) from DB.`);

  // Seed feature store once on startup
  await state.featureStore.seedFromLiveMarkets(state.client);
  state.subgraph = state.client.getSubgraph();

  // ── Loop 1: Strategy Evolver ─────────────────────────────────────
  // Slow loop (5 min): LLM generation, backtesting, pool management, RL weights
  async function runStrategyEvolver() {
    if (state.isStrategyRunning) return;
    state.isStrategyRunning = true;
    try {
      const updatedPolicy = state.rlOptimizer.updateWeightsFromTradeLog();
      const historicalRecords = state.featureStore.getHistoricalRecords();
      const llmResearcher = new RealLLMStrategyGeneratorNode();

      if (state.activeVoterPool.length < BOOTSTRAP_TARGET) {
        console.log(`\n🚀 [Bootstrap] Pool ${state.activeVoterPool.length}/${BOOTSTRAP_TARGET}`);
        let rounds = 0;
        while (state.activeVoterPool.length < BOOTSTRAP_TARGET && rounds < BOOTSTRAP_MAX_ROUNDS) {
          rounds++;
          const existingCodes = state.activeVoterPool.map(v => v.code).filter(Boolean);
          const topVoters = [...state.activeVoterPool].sort((a, b) => b.sharpeRatio - a.sharpeRatio).slice(0, 5);
          const candidates = await llmResearcher.generateBatch(BOOTSTRAP_BATCH, existingCodes, topVoters);
          backtestAndPromote(candidates, historicalRecords, state.activeVoterPool, promExporter);
          console.log(`  [Bootstrap Round ${rounds}] Pool now: ${state.activeVoterPool.length}/${BOOTSTRAP_TARGET}`);
        }
      } else {
        console.log(`\n🔄 [Evolver] Generating challenger strategy...`);
        const ollamaResearcher = new OllamaStrategyGeneratorNode();
        let candidates = await ollamaResearcher.generateStrategyCandidates(1);
        if (!candidates.length) {
          const existingCodes = state.activeVoterPool.map(v => v.code).filter(Boolean);
          const topVoters = [...state.activeVoterPool].sort((a, b) => b.sharpeRatio - a.sharpeRatio).slice(0, 5);
          candidates = await llmResearcher.generateBatch(1, existingCodes, topVoters);
        }
        backtestAndPromote(candidates, historicalRecords, state.activeVoterPool, promExporter);
      }

      state.rlOptimizer.syncWeightsFromVoterPool(state.activeVoterPool);
      const { prunedPool } = state.poolValidator.auditAndPrunePool(state.activeVoterPool);
      state.activeVoterPool.length = 0;
      state.activeVoterPool.push(...prunedPool);
      console.log(`🏆 [Pool] ${state.activeVoterPool.length} active voters`);
    } catch (err) {
      console.error('[Strategy Evolver Error]:', err.message);
    } finally {
      state.isStrategyRunning = false;
    }
  }

  // ── Loop 2: Price Monitor ─────────────────────────────────────────
  // Fast loop (10s): polls prices, triggers voter evaluation only on change
  async function runPriceMonitor() {
    if (state.activeVoterPool.length < BOOTSTRAP_TARGET) return;
    try {
      const { markets } = await state.client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
      if (!markets?.length) return;

      const { balance: rawUsdc } = await state.client.getErc20BalanceWithDecimals();
      const walletUsdc = Number(rawUsdc) / 1e6;
      promExporter.updateMetric('delphi_wallet_usdc_balance', walletUsdc);

      const db = getDb();
      const peakRow = db.prepare("SELECT value FROM rl_policy WHERE key='peak_capital'").get();
      let peakCapital = peakRow ? parseFloat(peakRow.value) : walletUsdc;
      if (walletUsdc > peakCapital) {
        peakCapital = walletUsdc;
        db.prepare("INSERT OR REPLACE INTO rl_policy (key,value) VALUES ('peak_capital',?)").run(String(peakCapital));
      }
      const updatedPolicy = state.rlOptimizer.updateWeightsFromTradeLog();
      const riskEngine = new CovarianceRiskEngine({ maxDrawdownFromPeak: 0.50, minEdgeBarrier: updatedPolicy.thresholds.minEdge, peakCapital });
      const historicalRecords = state.featureStore.getHistoricalRecords();
      const { covMatrix, markets: covMarkets } = riskEngine.computeCovarianceMatrix(historicalRecords);

      const { positions } = await state.client.listPositions({ wallet: WALLET_ADDRESS, redeemedOrLiquidated: false });
      const openPositions = (positions || []).filter(p => BigInt(p.shares) > 0n);
      promExporter.updateMetric('delphi_active_positions_count', openPositions.length);

      const marketMap = new Map(markets.map(m => [m.id, m]));

      for (const market of markets) {
        const probs    = market.spotImpliedProbabilities || [0.5, 0.5];
        const newPrice = probs[0];
        const lastPrice = state.lastPrices.get(market.id);
        state.lastPrices.set(market.id, newPrice);

        const priceChanged = !lastPrice || Math.abs(newPrice - lastPrice) >= PRICE_CHANGE_THRESHOLD;
        const question = market.metadata?.question || market.id;

        // Always record tick and check EWMA
        const features = await deriveMarketFeatures(state.subgraph, state.featureStore, market, question, newPrice);
        const cached = _featureCache.get(market.id);
        let newsSentiment = features.buyPressure, whaleFlow = 0;
        if (cached && (Date.now() - cached.ts) < FEATURE_CACHE_TTL_MS) {
          ({ newsSentiment, whaleFlow } = cached);
        }

        const ewmaRes = state.onlineEwmaNode.updateMarketTick(market.id, question, newPrice);
        promExporter.updateMetric('delphi_ewma_max_zscore', Math.max(promExporter.metrics.delphi_ewma_max_zscore || 0, Math.abs(ewmaRes.zScore || 0)));
        logNodeEvent('EWMA_TICK', { marketAddress: market.id, question, zScore: ewmaRes.zScore || 0, anomalyDetected: !!ewmaRes.anomalyDetected });
        state.featureStore.recordSnapshot(market.id, question, probs, newsSentiment, whaleFlow, market.category);

        if (!priceChanged && !ewmaRes.anomalyDetected) continue;

        if (priceChanged) console.log(`📡 [Price Change] ${question.slice(0, 40)} | ${lastPrice?.toFixed(3)} → ${newPrice.toFixed(3)}`);
        if (ewmaRes.anomalyDetected) console.log(`🚨 [EWMA Anomaly] ${question.slice(0, 40)} | z=${ewmaRes.zScore?.toFixed(2)}`);

        const record = {
          marketAddress: market.id, question, spotProbs: probs,
          newsSentiment, whaleFlow, category: market.category,
          priceTrend: features.priceTrend, volume: features.volume,
          daysToResolution: market.resolvesAt ? (new Date(market.resolvesAt) - Date.now()) / 86_400_000 : null,
          tradingFee: market.tradingFee ? Number(market.tradingFee) / 1e18 : 0.02,
          isVerifiable: !!market.verifiable,
        };

        // Run voter pool against the changed market
        for (const voter of state.activeVoterPool) {
          try {
            const res = voter.fn(record, covMatrix);
            if (!res || res.vote === 'SKIP') continue;
            console.log(`  🗳️  [${voter.name.slice(-20)}] ${res.vote} edge=${Math.abs(res.estimatedProb - probs[0]).toFixed(3)}`);
            const evalRes = state.signalBuffer.addSignal({
              marketAddress: market.id, question,
              currentMarketProb: probs[0], estimatedTrueProb: res.estimatedProb,
              sentimentScore: res.confidence,
            });
            if (!evalRes?.triggered) continue;

            logNodeEvent('SIGNAL_EVENT', { marketAddress: market.id, question, voter: voter.name, vote: res.vote, triggered: true, accumulatedMass: evalRes.accumulatedMass });
            const kelly = riskEngine.calculateKellySize(res.estimatedProb, probs[0], walletUsdc);
            const proposedSignal = { marketAddress: market.id, question, outcomeIdx: evalRes.outcomeIdx, outcomeLabel: evalRes.outcomeLabel, sharesNum: kelly.sharesNum, edge: evalRes.accumulatedMass, covMatrix, covMarkets };
            const riskCheck = riskEngine.evaluateTradeRisk(proposedSignal, walletUsdc, openPositions, market.category);
            logNodeEvent('RISK_CHECK', { marketAddress: market.id, question, passed: riskCheck.passed, reason: riskCheck.reason, kellyShares: kelly.sharesNum });
            console.log(`  🛡️  ${riskCheck.reason}`);
            if (!riskCheck.passed) continue;

            const sharesOut = BigInt(Math.round(kelly.sharesNum * 1e18));
            const { tokensIn } = await state.client.quoteBuy({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut });
            const maxTokensIn = (tokensIn * 102n) / 100n;
            await state.client.ensureTokenApproval({ marketAddress: market.id, minimumAmount: maxTokensIn });
            const tradeRes = await state.client.buyShares({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut, maxTokensIn });
            console.log(`🚀 [TRADE EXECUTED] TX: ${tradeRes.transactionHash}`);
            appendTrade({ timestamp: new Date().toISOString(), market: market.id, question: question.slice(0, 120), voter: voter.name, vote: res.vote, outcome_idx: evalRes.outcomeIdx, outcome_label: evalRes.outcomeLabel, shares_num: kelly.sharesNum, edge: evalRes.accumulatedMass, entry_prob: probs[evalRes.outcomeIdx === 0 ? 0 : 1] ?? probs[0], risk_reason: riskCheck.reason, tx_hash: tradeRes.transactionHash });
            state.poolValidator.recordTrade(voter.name);
          } catch (vErr) { console.error(`  ⚠️ Voter error [${voter.name}]: ${vErr.message}`); }
        }
      }

      // Position manager runs on each price poll
      await runPositionManagement(state.client, openPositions, state.activeVoterPool, marketMap, covMatrix, updatedPolicy.weights);
      promExporter.updateMetric('delphi_circuit_breaker_status', (peakCapital - walletUsdc) / peakCapital >= 0.50 ? 1 : 0);

    } catch (err) { console.error('[Price Monitor Error]:', err.message); }
  }

  // ── Loop 3: Whale & News Ingester ────────────────────────────────
  // Medium loop (60s): fetches LLM-enriched sentiment for active markets, updates cache
  async function runFeatureIngester() {
    try {
      const { markets } = await state.client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
      if (!markets?.length) return;
      for (const market of markets) {
        const cached = _featureCache.get(market.id);
        if (cached && (Date.now() - cached.ts) < FEATURE_CACHE_TTL_MS) continue; // still fresh
        const question = market.metadata?.question || market.id;
        const probs = market.spotImpliedProbabilities || [0.5, 0.5];
        const features = await deriveMarketFeatures(state.subgraph, state.featureStore, market, question, probs[0]);
        let newsSentiment = features.buyPressure, whaleFlow = Math.min(100, features.largestBuy / 5);
        if (features.tradeCount > 0) {
          try {
            const newsResult = await state.newsAgent.analyzeMarketContext({ question, category: market.category, impliedProb: probs[0], priceTrend: features.priceTrend, buyPressure: features.buyPressure });
            if (newsResult?.sentimentScore != null) newsSentiment = newsResult.sentimentScore;
            const whaleResult = await state.whaleAgent.evaluateWhaleActivity({ marketQuestion: question, impliedProb: probs[0], recentBuyVol: features.buyVol, recentSellVol: features.sellVol, largestBuy: features.largestBuy, largestSell: features.largestSell, tradeCount: features.tradeCount });
            if (whaleResult?.convictionScore != null) whaleFlow = Math.min(100, features.largestBuy / 5 * whaleResult.convictionScore * 2);
          } catch (_) {}
          // Detect new whale trade activity → flush signal buffer to re-evaluate
          const lastCount = state.lastTradeCounts.get(market.id) || 0;
          if (features.tradeCount > lastCount) {
            console.log(`🐋 [Whale Alert] ${question.slice(0, 40)} | ${features.tradeCount - lastCount} new trade(s), volume: ${features.volume.toFixed(0)} USDC`);
            state.signalBuffer.buffers.delete(market.id); // flush to re-evaluate with fresh data
          }
          state.lastTradeCounts.set(market.id, features.tradeCount);
        }
        _featureCache.set(market.id, { ts: Date.now(), newsSentiment, whaleFlow });
        console.log(`📰 [Feature Update] ${question.slice(0, 40)} | sentiment=${newsSentiment.toFixed(2)} whale=${whaleFlow.toFixed(0)}`);
      }
    } catch (err) { console.error('[Feature Ingester Error]:', err.message); }
  }

  // Start all loops
  console.log('🔁 Starting real-time loops: price=10s | features=60s | strategy=5min');
  await runStrategyEvolver();                                           // bootstrap immediately
  setInterval(runStrategyEvolver,  5 * 60_000);                        // evolve pool every 5 min
  setInterval(runPriceMonitor,     PRICE_POLL_INTERVAL_MS);            // reactive price check
  setInterval(runFeatureIngester,  60_000);                            // refresh LLM features
  runPriceMonitor();                                                    // immediate first price poll
}

startDaemon();
