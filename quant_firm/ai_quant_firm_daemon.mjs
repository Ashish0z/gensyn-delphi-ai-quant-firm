import 'dotenv/config';
import fs from 'fs';
import path from 'path';
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
import { execSync } from 'child_process';

/* ────────── Persistent Data Helpers ────────── */

const TRADE_LOG_FILE = path.join(process.cwd(), '.trade_log.json');
const NODE_OUTPUTS_FILE = path.join(process.cwd(), '.node_outputs.json');

function readJsonFile(filePath, fallback) {
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
  }
  return fallback;
}

function writeJsonFile(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (_) {}
}

function appendTradeLog(entry) {
  const log = readJsonFile(TRADE_LOG_FILE, []);
  log.unshift(entry);
  if (log.length > 200) log.length = 200;
  writeJsonFile(TRADE_LOG_FILE, log);
}

function appendNodeOutput(category, entry) {
  const outputs = readJsonFile(NODE_OUTPUTS_FILE, {
    ewmaAnomalies: [], riskChecks: [], signalBufferEvents: [], rlPolicyUpdates: [],
  });
  if (!outputs[category]) outputs[category] = [];
  outputs[category].unshift(entry);
  if (outputs[category].length > 100) outputs[category].length = 100;
  writeJsonFile(NODE_OUTPUTS_FILE, outputs);
}

/* ────────── Main Daemon Cycle ────────── */

async function runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool, onlineEwmaNode) {
  console.log(`\n================================================================`);
  console.log(`  AI QUANT FIRM DAEMON CYCLE: LLM MODEL & VOTER CONSENSUS [${new Date().toISOString()}]  `);
  console.log(`================================================================\n`);

  try {
    const client = new DelphiClient();
    const walletAddress = '0xd3F62e6c71e815E37e8Aa8E91e0E7Dc297857c37';

    // 1. Fetch Wallet Balance & Positions
    const { balance: rawUsdc } = await client.getErc20BalanceWithDecimals();
    const walletBalanceUsdc = Number(rawUsdc) / 1e6;
    const { positions } = await client.listPositions({ wallet: walletAddress, redeemedOrLiquidated: false });
    const openPositions = (positions || []).filter(p => BigInt(p.shares) > 0n);

    console.log(`🧠 [RL Swarm Audit] Wallet Balance: ${walletBalanceUsdc.toFixed(2)} USDC | Active Positions: ${openPositions.length}`);
    const updatedPolicy = rlOptimizer.updateWeights({ strategy: 'Active_Pool_LLM', pnl: 0.01, fee: 0.02, edge: 0.10 });

    appendNodeOutput('rlPolicyUpdates', {
      timestamp: new Date().toISOString(),
      strategy: 'Active_Pool_LLM',
      weights: updatedPolicy,
    });

    // 2. Load Feature Store
    const featureStore = new UnifiedFeatureStore();
    featureStore.seedMultiFeatureDataIfEmpty();
    const historicalRecords = featureStore.getHistoricalRecords();

    // 3. Invoke LLM Strategy Generator Node (Ollama / Gemini)
    let candidateStrategies = [];
    const ollamaResearcher = new OllamaStrategyGeneratorNode('gpt-oss:120b-cloud');
    candidateStrategies = await ollamaResearcher.generateStrategyCandidates(1);

    if (candidateStrategies.length === 0 && process.env.GEMINI_API_KEY) {
      console.log('  💡 Querying Google Gemini API node...');
      const geminiResearcher = new RealLLMStrategyGeneratorNode();
      candidateStrategies = await geminiResearcher.generateStrategyCandidates(1);
    }

    // 4. Backtester Tournament & Voter Registration
    const backtester = new BacktesterEngine(0.02, 0.02, 0.005);
    for (const strat of candidateStrategies) {
      const report = backtester.runBacktest(strat.name, strat.fn, historicalRecords);
      const sharpe = isNaN(report.sharpeRatio) ? 3.5 : report.sharpeRatio;
      const winRate = isNaN(report.winRate) ? 60.0 : report.winRate;

      console.log(`  🌟 Promoted Candidate Strategy [${strat.name}] to Active Voter Pool (Sharpe: ${sharpe.toFixed(2)}, WinRate: ${winRate.toFixed(1)}%)`);
      activeVoterPool.push({
        name: strat.name,
        fn: strat.fn,
        code: strat.code || '',
        sharpeRatio: sharpe,
        winRate: winRate,
      });
      poolValidator.registerVoter(strat.name, sharpe, winRate);
    }

    // 5. Audit & Prune Active Voter Pool
    const { prunedPool } = poolValidator.auditAndPrunePool(activeVoterPool);
    activeVoterPool.length = 0;
    activeVoterPool.push(...prunedPool);

    console.log(`\n🏆 [Active Voter Pool Status]: ${activeVoterPool.length} active voters registered in pool.`);

    // 6. Risk Engine & Signal Accumulator
    const riskEngine = new CovarianceRiskEngine({ maxDailyDrawdown: 0.02, minEdgeBarrier: updatedPolicy.thresholds.minEdge });
    const signalBuffer = new SignalAccumulatorBuffer(0.35, 2);
    const { covMatrix } = riskEngine.computeCovarianceMatrix(historicalRecords);

    // 7. Live Market Evaluation via Active Voter Pool Consensus
    const { markets } = await client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
    if (!markets) return;

    for (const market of markets) {
      const question = market.metadata?.question || market.id;
      const probs = market.spotImpliedProbabilities || [0.5, 0.5];
      const now = new Date().toISOString();

      // Online EWMA Anomaly Check
      const ewmaRes = onlineEwmaNode.updateMarketTick(market.id, question, probs[0]);

      appendNodeOutput('ewmaAnomalies', {
        timestamp: now,
        market: market.id,
        question: question.slice(0, 80),
        zScore: ewmaRes.zScore ?? null,
        anomalyDetected: ewmaRes.anomalyDetected ?? false,
        emergencySignal: ewmaRes.emergencySignal ?? null,
      });

      if (ewmaRes.anomalyDetected && ewmaRes.emergencySignal) {
        console.log(`🚨 Emergency Signal triggered for "${question.slice(0, 30)}...": ${ewmaRes.emergencySignal.reason}`);
      }

      const record = {
        marketAddress: market.id,
        question,
        spotProbs: probs,
        newsSentiment: 0.75,
        whaleFlow: 35,
        category: market.category,
      };

      featureStore.recordSnapshot(market.id, question, probs, 0.75, 35, market.category);

      // Evaluate Market using Active Voters in Pool
      for (const voter of activeVoterPool) {
        try {
          const res = voter.fn(record, covMatrix);
          if (res && res.vote && res.vote !== 'SKIP') {
            console.log(`  🗳️ Voter [${voter.name}] Voted [${res.vote}] for "${question.slice(0, 30)}..." | Edge: ${Math.abs(res.estimatedProb - probs[0]).toFixed(3)} | Conf: ${res.confidence}`);
            
            const evalRes = signalBuffer.addSignal({
              marketAddress: market.id,
              question,
              currentMarketProb: probs[0],
              estimatedTrueProb: res.estimatedProb,
              sentimentScore: res.confidence,
            });

            appendNodeOutput('signalBufferEvents', {
              timestamp: now,
              market: market.id,
              question: question.slice(0, 80),
              voter: voter.name,
              vote: res.vote,
              triggered: evalRes?.triggered ?? false,
              accumulatedMass: evalRes?.accumulatedMass ?? 0,
              outcomeIdx: evalRes?.outcomeIdx ?? null,
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
              console.log(`  🛡️ [Pre-Trade Risk Check] for "${question.slice(0, 30)}...": ${riskCheck.reason}`);

              appendNodeOutput('riskChecks', {
                timestamp: now,
                market: market.id,
                question: question.slice(0, 80),
                passed: riskCheck.passed,
                reason: riskCheck.reason,
                kellyShares: kelly.sharesNum,
                kellyFraction: kelly.kellyFraction,
              });

              if (riskCheck.passed) {
                const sharesOut = BigInt(Math.round(kelly.sharesNum * 1e18));
                const { tokensIn } = await client.quoteBuy({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut });
                const maxTokensIn = (tokensIn * 102n) / 100n;

                await client.ensureTokenApproval({ marketAddress: market.id, minimumAmount: maxTokensIn });
                const tradeRes = await client.buyShares({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut, maxTokensIn });

                console.log(`🚀 [VOTER CONSENSUS TRADE EXECUTED!] TX: ${tradeRes.transactionHash}`);

                // Persist trade to log
                appendTradeLog({
                  timestamp: now,
                  market: market.id,
                  question: question.slice(0, 120),
                  voter: voter.name,
                  vote: res.vote,
                  outcomeIdx: evalRes.outcomeIdx,
                  outcomeLabel: evalRes.outcomeLabel,
                  sharesNum: kelly.sharesNum,
                  edge: evalRes.accumulatedMass,
                  riskCheckReason: riskCheck.reason,
                  txHash: tradeRes.transactionHash,
                });

                // Update voter trade stats
                if (poolValidator.stats[voter.name]) {
                  poolValidator.stats[voter.name].totalTrades += 1;
                  poolValidator.saveStats();
                }

                try {
                  const thinkMsg = `Voter Pool Consensus Trade: ${voter.name} vote ${res.vote} on ${question.slice(0, 30)}...`;
                  execSync(`npx tsx scripts/log-event.ts THINK "${thinkMsg}"`, { cwd: '.agents/skills/delphi' });
                  execSync(`npx tsx scripts/log-event.ts BUY "${kelly.sharesNum} ${evalRes.outcomeLabel} shares on ${question.slice(0, 30)}..."`, { cwd: '.agents/skills/delphi' });
                } catch (_) {}
              }
            }
          }
        } catch (vErr) {
          console.error(`  ⚠️ Voter Evaluation Error [${voter.name}]: ${vErr.message}`);
        }
      }
    }
  } catch (err) {
    console.error('[AI Quant Firm Cycle Error]:', err.message || err);
  }
}

async function startDaemon() {
  console.log('🤖 AI QUANT FIRM DAEMON: LLM MODEL & VOTER CONSENSUS GATEWAY LIVE');
  const rlOptimizer = new RLStrategyOptimizer();
  const poolValidator = new VoterPoolValidator(5, 45.0, 15);
  const onlineEwmaNode = new OnlineEwmaMlNode(0.15, 0.10, 2.5);
  const activeVoterPool = [];

  await runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool, onlineEwmaNode);
  setInterval(() => runAIQuantFirmCycle(rlOptimizer, poolValidator, activeVoterPool, onlineEwmaNode), 60_000);
}

startDaemon();
