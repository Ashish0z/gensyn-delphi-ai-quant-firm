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
import { appendTrade, getRecentTrades } from './db.mjs';
import { WALLET_ADDRESS } from './config.mjs';
import { PrometheusExporter } from '../telemetry/prometheus_exporter.mjs';
import { execSync } from 'child_process';

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

    // 3. Load Feature Store
    const featureStore = new UnifiedFeatureStore();
    featureStore.seedMultiFeatureDataIfEmpty();
    const historicalRecords = featureStore.getHistoricalRecords();

    // 4. Generate LLM Strategy (Ollama primary; Gemini fallback)
    let candidateStrategies = [];
    const ollamaResearcher = new OllamaStrategyGeneratorNode();
    candidateStrategies = await ollamaResearcher.generateStrategyCandidates(1);

    if (candidateStrategies.length === 0) {
      console.log('  💡 Ollama produced no candidates. Trying RealLLMStrategyGeneratorNode...');
      const llmResearcher = new RealLLMStrategyGeneratorNode();
      candidateStrategies = await llmResearcher.generateStrategyCandidates(1);
    }

    promExporter.updateMetric('delphi_llm_calls_total',
      (promExporter.metrics.delphi_llm_calls_total || 0) + candidateStrategies.length);

    // 5. Backtester Tournament with real promotion criteria
    const backtester = new BacktesterEngine(0.02, 0.02, 0.005);
    for (const strat of candidateStrategies) {
      const report = backtester.runBacktest(strat.name, strat.fn, historicalRecords);

      // Fix 5: Use actual Sharpe/WinRate, not NaN defaults
      const sharpe  = Number.isFinite(report.sharpeRatio) ? report.sharpeRatio : 0.0;
      const winRate = Number.isFinite(report.winRate)     ? report.winRate     : 0.0;

      const isPromoted = report.totalTrades > 0 && sharpe >= 1.0 && winRate >= 50.0;

      console.log(`  ${isPromoted ? '✅' : '❌'} [${strat.name}] Sharpe: ${sharpe.toFixed(2)} | WinRate: ${winRate.toFixed(1)}% | Trades: ${report.totalTrades}`);

      if (isPromoted) {
        activeVoterPool.push({
          name:        strat.name,
          fn:          strat.fn,
          code:        strat.code || '',
          sharpeRatio: sharpe,
          winRate,
        });
        poolValidator.registerVoter(strat.name, sharpe, winRate);
      }
    }

    // 6. Sync RL weights from voter pool
    rlOptimizer.syncWeightsFromVoterPool(activeVoterPool);

    // 7. Audit & prune pool
    const { prunedPool } = poolValidator.auditAndPrunePool(activeVoterPool);
    activeVoterPool.length = 0;
    activeVoterPool.push(...prunedPool);

    console.log(`\n🏆 [Active Voter Pool]: ${activeVoterPool.length} active voters.`);

    // 8. Risk Engine
    const riskEngine = new CovarianceRiskEngine({
      maxDailyDrawdown: 0.02,
      minEdgeBarrier:   updatedPolicy.thresholds.minEdge,
    });
    const signalBuffer = new SignalAccumulatorBuffer(0.35, 2);

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

    // Update circuit breaker metric using the same initialCapital as the risk engine
    const drawdown = (riskEngine.initialCapital - walletBalanceUsdc) / riskEngine.initialCapital;
    promExporter.updateMetric('delphi_circuit_breaker_status', drawdown >= 0.02 ? 1 : 0);

  } catch (err) {
    console.error('[AI Quant Firm Cycle Error]:', err.message || err);
  }
}

async function startDaemon() {
  console.log('🤖 AI QUANT FIRM DAEMON: OLLAMA LLM + VOTER CONSENSUS GATEWAY LIVE');

  // Fix 8: Prometheus exporter initialised with zero hardcoded values
  const promExporter = new PrometheusExporter();

  const rlOptimizer  = new RLStrategyOptimizer();
  const poolValidator = new VoterPoolValidator(5, 45.0, 15);
  const onlineEwmaNode = new OnlineEwmaMlNode(0.15, 0.10, 2.5);
  const activeVoterPool = [];

  await runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool, onlineEwmaNode, promExporter);
  setInterval(() => runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool, onlineEwmaNode, promExporter), 60_000);
}

startDaemon();
