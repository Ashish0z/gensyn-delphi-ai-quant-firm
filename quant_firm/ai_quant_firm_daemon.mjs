import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { UnifiedFeatureStore } from './unified_feature_store.mjs';
import { RealLLMStrategyGeneratorNode } from './llm_strategy_generator_real.mjs';
import { BacktesterEngine } from '../quant_system/backtester_engine.mjs';
import { VoterPoolValidator } from './voter_pool_validator.mjs';
import { CovarianceRiskEngine } from './covariance_risk_engine.mjs';
import { SignalAccumulatorBuffer } from '../event_system/signal_buffer_node.mjs';
import { RLStrategyOptimizer } from '../event_system/rl_validator_node.mjs';
import { execSync } from 'child_process';

async function runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool) {
  console.log(`\n================================================================`);
  console.log(`  AI QUANT FIRM DAEMON CYCLE RUNNING [${new Date().toISOString()}]  `);
  console.log(`================================================================\n`);

  try {
    const client = new DelphiClient();
    const walletAddress = '0xd3F62e6c71e815E37e8Aa8E91e0E7Dc297857c37';

    // 1. RL Swarm Audit
    const { balance: rawUsdc } = await client.getErc20BalanceWithDecimals();
    const walletBalanceUsdc = Number(rawUsdc) / 1e6;
    const { positions } = await client.listPositions({ wallet: walletAddress, redeemedOrLiquidated: false });
    const openPositions = (positions || []).filter(p => BigInt(p.shares) > 0n);

    console.log(`🧠 [RL Swarm Validator Audit] Wallet Balance: ${walletBalanceUsdc.toFixed(2)} USDC | Active Positions: ${openPositions.length}`);
    const updatedPolicy = rlOptimizer.updateWeights({ strategy: 'Active_Pool_LLM', pnl: 0.01, fee: 0.02, edge: 0.10 });

    // 2. Feature Store Ingestion
    const featureStore = new UnifiedFeatureStore();
    featureStore.seedMultiFeatureDataIfEmpty();
    const historicalRecords = featureStore.getHistoricalRecords();

    // 3. Real LLM Quant Researcher
    const llmResearcher = new RealLLMStrategyGeneratorNode();
    const candidateStrategies = await llmResearcher.generateStrategyCandidates(1);

    // 4. Backtester Tournament & Promotion to Candidate List
    const backtester = new BacktesterEngine(0.02, 0.02, 0.005);
    for (const strat of candidateStrategies) {
      const report = backtester.runBacktest(strat.name, strat.fn, historicalRecords);
      if (report.totalTrades > 0 && report.finalBalance >= 90.0) {
        console.log(`  🌟 Promoted Candidate Strategy: [${strat.name}] to Active Voter Pool`);
        activeVoterPool.push({
          name: strat.name,
          fn: strat.fn,
          sharpeRatio: report.sharpeRatio,
          winRate: report.winRate,
        });
        poolValidator.registerVoter(strat.name, report.sharpeRatio, report.winRate);
      }
    }

    // 5. Real-Time Active Pool Performance Validator & Eviction Engine
    const { prunedPool, evictedVoters } = poolValidator.auditAndPrunePool(activeVoterPool);
    activeVoterPool.length = 0;
    activeVoterPool.push(...prunedPool);

    if (evictedVoters.length > 0) {
      try {
        const msg = `Evicted ${evictedVoters.length} stale/underperforming voter agents. Pool size: ${activeVoterPool.length}`;
        execSync(`npx tsx scripts/log-event.ts THINK "${msg}"`, { cwd: '.agents/skills/delphi' });
      } catch (_) {}
    }

    if (activeVoterPool.length === 0) {
      console.log('[AI Quant Firm] Active Voter Pool is empty after pruning pass. Cycle complete.');
      return;
    }

    console.log(`[Active Voter Pool] Operating with ${activeVoterPool.length} validated high-Sharpe LLM agents.`);

    // 6. Covariance Risk Engine & Signal Accumulator
    const riskEngine = new CovarianceRiskEngine({ maxDailyDrawdown: 0.02, minEdgeBarrier: updatedPolicy.thresholds.minEdge });
    const signalBuffer = new SignalAccumulatorBuffer(0.35, 2);
    const { covMatrix } = riskEngine.computeCovarianceMatrix(historicalRecords);

    // 7. Live Market Execution Pass
    const { markets } = await client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
    if (!markets) return;

    for (const market of markets) {
      const question = market.metadata?.question || market.id;
      const probs = market.spotImpliedProbabilities || [0.5, 0.5];
      const record = { marketAddress: market.id, question, spotProbs: probs, newsSentiment: 0.80, whaleFlow: 25, category: market.category };

      featureStore.recordSnapshot(market.id, question, probs, 0.80, 25, market.category);

      for (const voter of activeVoterPool) {
        const res = voter.fn(record, covMatrix);
        if (res && res.vote !== 'SKIP') {
          const evalRes = signalBuffer.addSignal({
            marketAddress: market.id,
            question,
            currentMarketProb: probs[0],
            estimatedTrueProb: res.estimatedProb,
            sentimentScore: res.confidence,
          });

          if (evalRes && evalRes.triggered) {
            const kelly = riskEngine.calculateKellySize(res.estimatedProb, probs[0], walletBalanceUsdc);
            const proposedSignal = {
              marketAddress: market.id,
              question,
              outcomeIdx: evalRes.outcomeIdx,
              outcomeLabel: evalRes.outcomeLabel,
              sharesNum: kelly.sharesNum,
              edge: evalRes.accumulatedMass,
            };

            const riskCheck = riskEngine.evaluateTradeRisk(proposedSignal, walletBalanceUsdc, openPositions, market.category);
            console.log(`[AI Quant Firm] Risk Check for "${question.slice(0, 30)}...": ${riskCheck.reason}`);

            if (riskCheck.passed) {
              try {
                const sharesOut = BigInt(Math.round(kelly.sharesNum * 1e18));
                const { tokensIn } = await client.quoteBuy({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut });
                const maxTokensIn = (tokensIn * 102n) / 100n;

                await client.ensureTokenApproval({ marketAddress: market.id, minimumAmount: maxTokensIn });
                const tradeRes = await client.buyShares({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut, maxTokensIn });

                console.log(`🚀 [AI QUANT FIRM TRADE EXECUTED!] TX: ${tradeRes.transactionHash}`);

                try {
                  const thinkMsg = `AI Quant Firm: Validated Voter ${voter.name} executed. Market: ${question}`;
                  execSync(`npx tsx scripts/log-event.ts THINK "${thinkMsg}"`, { cwd: '.agents/skills/delphi' });
                  execSync(`npx tsx scripts/log-event.ts BUY "${kelly.sharesNum} ${evalRes.outcomeLabel} shares on ${question.slice(0, 30)}..."`, { cwd: '.agents/skills/delphi' });
                } catch (_) {}

              } catch (err) {
                console.error(`[AI Quant Firm Execution Error]: ${err.message || err}`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[AI Quant Firm Cycle Error]:', err.message || err);
  }
}

async function startDaemon() {
  console.log('🤖 AI QUANT FIRM DAEMON WITH VOTER POOL EVICTION ENGINE STARTED');
  const rlOptimizer = new RLStrategyOptimizer();
  const poolValidator = new VoterPoolValidator(5, 45.0, 15);
  const activeVoterPool = [];

  await runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool);
  setInterval(() => runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool), 180_000);
}

startDaemon();
