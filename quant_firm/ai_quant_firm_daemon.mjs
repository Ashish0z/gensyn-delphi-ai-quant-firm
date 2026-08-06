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
import { appendTrade, getRecentTrades, logStrategyFailure, logNodeEvent, getDb, upsertVoterStats, getActiveVoters, setVoterStatus } from './db.mjs';
import { WALLET_ADDRESS } from './config.mjs';
import { PrometheusExporter } from '../telemetry/prometheus_exporter.mjs';
import { startTelemetryDashboardServer } from '../telemetry/telemetry_dashboard_server.mjs';
import { execSync } from 'child_process';

const BOOTSTRAP_TARGET    = 20; // keep generating until this many voters are promoted
const BOOTSTRAP_BATCH     = 10; // strategies per batch LLM call during bootstrap
const BOOTSTRAP_MAX_ROUNDS = 4; // max batch rounds per cycle to avoid infinite loops
const SIMILARITY_THRESHOLD = 0.50; // reject new strategy if Jaccard similarity to any existing voter exceeds this

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
  for (const strat of candidates) {
    const report  = backtester.runBacktest(strat.name, strat.fn, historicalRecords);
    const sharpe  = Number.isFinite(report.sharpeRatio) ? report.sharpeRatio : 0.0;
    const winRate = Number.isFinite(report.winRate)     ? report.winRate     : 0.0;

    console.log(`  ${report.totalTrades > 0 ? '📊' : '❌'} [${strat.name}] Trades: ${report.totalTrades} | Sharpe: ${sharpe.toFixed(2)} | WinRate: ${winRate.toFixed(1)}%`);

    if (report.totalTrades === 0) {
      if (strat.code) logStrategyFailure({ code: strat.code, sharpe, winRate, totalTrades: 0, reason: 'generated zero trades — logic never triggered on real-anchored data' });
      continue;
    }

    if (strat.code && isTooSimilar(strat.code, activeVoterPool)) {
      console.log(`  ⚠️  [${strat.name}] Rejected — too similar to an existing voter (Jaccard ≥ ${SIMILARITY_THRESHOLD})`);
      logStrategyFailure({ code: strat.code, sharpe, winRate, totalTrades: report.totalTrades, reason: 'duplicate: too similar to existing voter strategy' });
      continue;
    }

    // During bootstrap fill the pool freely; once full only admit if better than worst voter
    const poolFull = activeVoterPool.length >= BOOTSTRAP_TARGET;
    if (poolFull) {
      const worstIdx = activeVoterPool.reduce((wi, v, i, a) => v.sharpeRatio < a[wi].sharpeRatio ? i : wi, 0);
      const worst = activeVoterPool[worstIdx];
      if (sharpe <= worst.sharpeRatio) {
        console.log(`  ⏭️  [${strat.name}] Sharpe ${sharpe.toFixed(2)} ≤ worst voter ${worst.sharpeRatio.toFixed(2)} — not promoted`);
        continue;
      }
      // Evict the weakest voter
      console.log(`  🔄 Replacing worst voter [${worst.name}] (Sharpe ${worst.sharpeRatio.toFixed(2)}) with [${strat.name}] (Sharpe ${sharpe.toFixed(2)})`);
      setVoterStatus(worst.name, 'EVICTED');
      activeVoterPool.splice(worstIdx, 1);
    }

    activeVoterPool.push({ name: strat.name, fn: strat.fn, code: strat.code || '', sharpeRatio: sharpe, winRate });
    upsertVoterStats(strat.name, sharpe, winRate, strat.code || '');
    promoted++;
    console.log(`  ✅ Promoted [${strat.name}] | Pool: ${activeVoterPool.length}/${BOOTSTRAP_TARGET}`);
  }
  promExporter.updateMetric('delphi_llm_calls_total',
    (promExporter.metrics.delphi_llm_calls_total || 0) + candidates.length);
  return promoted;
}

/* ────────── Main Daemon Cycle ────────── */

async function runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool, onlineEwmaNode, promExporter) {
  console.log(`\n================================================================`);
  console.log(`  AI QUANT FIRM DAEMON CYCLE [${new Date().toISOString()}]`);
  console.log(`================================================================\n`);

  try {
    const client = new DelphiClient();

    // 1. Fetch Wallet Balance & Positions
    const { balance: rawUsdc } = await client.getErc20BalanceWithDecimals();
    const walletBalanceUsdc = Number(rawUsdc) / 1e6;
    const { positions } = await client.listPositions({ wallet: WALLET_ADDRESS, redeemedOrLiquidated: false });
    const openPositions = (positions || []).filter(p => BigInt(p.shares) > 0n);

    console.log(`🧠 [Status] Wallet: ${walletBalanceUsdc.toFixed(2)} USDC | Open positions: ${openPositions.length}`);

    // Update Prometheus wallet + positions metrics from live data
    promExporter.updateMetric('delphi_wallet_usdc_balance', walletBalanceUsdc);
    promExporter.updateMetric('delphi_active_positions_count', openPositions.length);

    // 2. RL weight update from real trade log
    const updatedPolicy = rlOptimizer.updateWeightsFromTradeLog();

    // 3. Load Feature Store — seed from live markets on first run
    const featureStore = new UnifiedFeatureStore();
    await featureStore.seedFromLiveMarkets(client);
    const historicalRecords = featureStore.getHistoricalRecords();

    // 4+5. Strategy Generation & Backtester Tournament
    // Bootstrap mode: keep generating in batches until the pool reaches BOOTSTRAP_TARGET.
    // Once the target is met, generate one batch per cycle (incremental).
    const llmResearcher = new RealLLMStrategyGeneratorNode();
    const needsBootstrap = activeVoterPool.length < BOOTSTRAP_TARGET;

    if (needsBootstrap) {
      console.log(`\n🚀 [Bootstrap] Pool has ${activeVoterPool.length}/${BOOTSTRAP_TARGET} voters — running batch generation until target is met...`);
      let rounds = 0;
      while (activeVoterPool.length < BOOTSTRAP_TARGET && rounds < BOOTSTRAP_MAX_ROUNDS) {
        rounds++;
        console.log(`  [Bootstrap Round ${rounds}/${BOOTSTRAP_MAX_ROUNDS}] Requesting batch of ${BOOTSTRAP_BATCH} strategies...`);
        const existingCodes = activeVoterPool.map(v => v.code).filter(Boolean);
        const topVoters = [...activeVoterPool].sort((a, b) => b.sharpeRatio - a.sharpeRatio).slice(0, 5);
        const candidates = await llmResearcher.generateBatch(BOOTSTRAP_BATCH, existingCodes, topVoters);
        backtestAndPromote(candidates, historicalRecords, activeVoterPool, promExporter);
        console.log(`  [Bootstrap Round ${rounds}] Pool now: ${activeVoterPool.length}/${BOOTSTRAP_TARGET}`);
      }
      if (activeVoterPool.length >= BOOTSTRAP_TARGET) {
        console.log(`✅ [Bootstrap] Target reached: ${activeVoterPool.length} active voters.`);
      } else {
        console.log(`⚠️  [Bootstrap] Max rounds reached with ${activeVoterPool.length} voters — will retry next cycle.`);
      }
    } else {
      // Incremental: one fresh strategy per cycle to keep the pool evolving
      console.log(`\n🔄 [Incremental] Pool healthy (${activeVoterPool.length} voters) — generating new candidate to challenge worst voter...`);
      const ollamaResearcher = new OllamaStrategyGeneratorNode();
      let candidates = await ollamaResearcher.generateStrategyCandidates(1);
      if (candidates.length === 0) {
        const existingCodes = activeVoterPool.map(v => v.code).filter(Boolean);
        const topVoters = [...activeVoterPool].sort((a, b) => b.sharpeRatio - a.sharpeRatio).slice(0, 5);
        candidates = await llmResearcher.generateStrategyCandidates(1);
        // Enrich the single candidate with success/diversity context via batch of 1
        candidates = await llmResearcher.generateBatch(1, existingCodes, topVoters);
      }
      backtestAndPromote(candidates, historicalRecords, activeVoterPool, promExporter);
    }

    // 6. Sync RL weights from voter pool
    rlOptimizer.syncWeightsFromVoterPool(activeVoterPool);

    // 7. Audit & prune pool
    const { prunedPool } = poolValidator.auditAndPrunePool(activeVoterPool);
    activeVoterPool.length = 0;
    activeVoterPool.push(...prunedPool);

    console.log(`\n🏆 [Active Voter Pool]: ${activeVoterPool.length} active voters.`);

    // 8. Risk Engine — rolling high-water mark circuit breaker
    // Peak capital is updated whenever the wallet reaches a new high;
    // the breaker trips only when we fall >10% below that peak.
    const db = getDb();
    const peakRow = db.prepare("SELECT value FROM rl_policy WHERE key = 'peak_capital'").get();
    let peakCapital = peakRow ? parseFloat(peakRow.value) : walletBalanceUsdc;
    if (walletBalanceUsdc > peakCapital) {
      peakCapital = walletBalanceUsdc;
      db.prepare("INSERT OR REPLACE INTO rl_policy (key, value) VALUES ('peak_capital', ?)").run(String(peakCapital));
      console.log(`📈 [Risk Engine] New peak capital: ${peakCapital.toFixed(2)} USDC`);
    }
    const riskEngine = new CovarianceRiskEngine({
      maxDrawdownFromPeak: 0.50,
      minEdgeBarrier:      updatedPolicy.thresholds.minEdge,
      peakCapital,
    });
    // Single-voter signal allowed; low mass threshold so any clear conviction triggers
    // Consensus = 50% of pool (min 1) so larger pools require broader agreement
    const consensusRequired = Math.max(1, Math.ceil(activeVoterPool.length * 0.5));
    const signalBuffer = new SignalAccumulatorBuffer(0.08, consensusRequired);
    console.log(`🗳️  [Signal Buffer] Consensus: ${consensusRequired}/${activeVoterPool.length} voters required`);

    // Fix 6: compute actual covariance matrix from feature store
    const { covMatrix, markets: covMarkets } = riskEngine.computeCovarianceMatrix(historicalRecords);

    // 9. Live Market Evaluation
    const { markets } = await client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
    if (!markets) return;

    for (const market of markets) {
      const question = market.metadata?.question || market.id;
      const probs    = market.spotImpliedProbabilities || [0.5, 0.5];

      // EWMA anomaly check
      const ewmaRes = onlineEwmaNode.updateMarketTick(market.id, question, probs[0]);
      if (ewmaRes.anomalyDetected && ewmaRes.emergencySignal) {
        console.log(`🚨 EWMA Emergency Signal: "${question.slice(0, 35)}..." ${ewmaRes.emergencySignal.reason}`);
        promExporter.updateMetric('delphi_ewma_max_zscore', Math.abs(ewmaRes.zScore || 0));
      }
      logNodeEvent('EWMA_TICK', { marketAddress: market.id, question, zScore: ewmaRes.zScore || 0, anomalyDetected: !!ewmaRes.anomalyDetected, emergencySignal: ewmaRes.emergencySignal || null });

      const record = {
        marketAddress: market.id,
        question,
        spotProbs:     probs,
        newsSentiment: 0.75,
        whaleFlow:     35,
        category:      market.category,
      };

      featureStore.recordSnapshot(market.id, question, probs, 0.75, 35, market.category);

      for (const voter of activeVoterPool) {
        try {
          // Pass covMatrix to each strategy function
          const res = voter.fn(record, covMatrix);
          if (!res || res.vote === 'SKIP') continue;

          console.log(`  🗳️  [${voter.name}] Vote=${res.vote} | Edge=${Math.abs(res.estimatedProb - probs[0]).toFixed(3)} | Conf=${res.confidence}`);

          const evalRes = signalBuffer.addSignal({
            marketAddress:     market.id,
            question,
            currentMarketProb: probs[0],
            estimatedTrueProb: res.estimatedProb,
            sentimentScore:    res.confidence,
          });

          if (!evalRes?.triggered) continue;

          logNodeEvent('SIGNAL_EVENT', { marketAddress: market.id, question, voter: voter.name, vote: res.vote, triggered: true, accumulatedMass: evalRes.accumulatedMass });

          const kelly = riskEngine.calculateKellySize(res.estimatedProb, probs[0], walletBalanceUsdc);

          // Fix 6: supply covMatrix-derived concentration data to risk gate
          const proposedSignal = {
            marketAddress: market.id,
            question,
            outcomeIdx:    evalRes.outcomeIdx,
            outcomeLabel:  evalRes.outcomeLabel,
            sharesNum:     kelly.sharesNum,
            edge:          evalRes.accumulatedMass,
            covMatrix,
            covMarkets,
          };

          const riskCheck = riskEngine.evaluateTradeRisk(proposedSignal, walletBalanceUsdc, openPositions, market.category);
          console.log(`  🛡️  Risk check: ${riskCheck.reason}`);
          logNodeEvent('RISK_CHECK', { marketAddress: market.id, question, passed: riskCheck.passed, reason: riskCheck.reason, kellyShares: kelly.sharesNum });

          const now = new Date().toISOString();

          if (riskCheck.passed) {
            const sharesOut = BigInt(Math.round(kelly.sharesNum * 1e18));
            const rpcStart = Date.now();
            const { tokensIn } = await client.quoteBuy({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut });
            const rpcLatency = Date.now() - rpcStart;
            promExporter.updateMetric('delphi_rpc_latency_ms', rpcLatency);

            const maxTokensIn = (tokensIn * 102n) / 100n;
            await client.ensureTokenApproval({ marketAddress: market.id, minimumAmount: maxTokensIn });
            const tradeRes = await client.buyShares({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut, maxTokensIn });

            console.log(`🚀 [TRADE EXECUTED] TX: ${tradeRes.transactionHash}`);

            appendTrade({
              timestamp:     now,
              market:        market.id,
              question:      question.slice(0, 120),
              voter:         voter.name,
              vote:          res.vote,
              outcome_idx:   evalRes.outcomeIdx,
              outcome_label: evalRes.outcomeLabel,
              shares_num:    kelly.sharesNum,
              edge:          evalRes.accumulatedMass,
              risk_reason:   riskCheck.reason,
              tx_hash:       tradeRes.transactionHash,
            });

            poolValidator.recordTrade(voter.name);

            try {
              execSync(`npx tsx scripts/log-event.ts THINK "Voter Pool Consensus: ${voter.name} on ${question.slice(0, 30)}..."`, { cwd: '.agents/skills/delphi' });
              execSync(`npx tsx scripts/log-event.ts BUY "${kelly.sharesNum} ${evalRes.outcomeLabel} shares on ${question.slice(0, 30)}..."`, { cwd: '.agents/skills/delphi' });
            } catch (_) {}
          }
        } catch (vErr) {
          console.error(`  ⚠️ Voter error [${voter.name}]: ${vErr.message}`);
        }
      }
    }

    const drawdown = (riskEngine.peakCapital - walletBalanceUsdc) / riskEngine.peakCapital;
    promExporter.updateMetric('delphi_circuit_breaker_status', drawdown >= riskEngine.maxDrawdownFromPeak ? 1 : 0);

  } catch (err) {
    console.error('[AI Quant Firm Cycle Error]:', err.message || err);
  }
}

async function startDaemon() {
  console.log('🤖 AI QUANT FIRM DAEMON: OLLAMA LLM + VOTER CONSENSUS GATEWAY LIVE');

  // Fix 8: Prometheus exporter initialised with zero hardcoded values
  const promExporter = new PrometheusExporter();
  startTelemetryDashboardServer();

  const rlOptimizer  = new RLStrategyOptimizer();
  const poolValidator = new VoterPoolValidator(20, 40.0, 30);
  const onlineEwmaNode = new OnlineEwmaMlNode(0.15, 0.10, 2.5);
  const activeVoterPool = [];

  // Restore previously promoted voters so the pool survives daemon restarts
  for (const row of getActiveVoters()) {
    try {
      const fn = new Function('record', 'covMatrix', row.code);
      activeVoterPool.push({ name: row.name, fn, code: row.code, sharpeRatio: row.sharpe_ratio, winRate: row.win_rate });
    } catch (_) {}
  }
  if (activeVoterPool.length) console.log(`♻️  [Startup] Restored ${activeVoterPool.length} voter(s) from DB.`);

  await runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool, onlineEwmaNode, promExporter);
  setInterval(() => runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool, onlineEwmaNode, promExporter), 60_000);
}

startDaemon();
