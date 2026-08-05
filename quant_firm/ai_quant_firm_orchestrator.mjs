import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { UnifiedFeatureStore } from './unified_feature_store.mjs';
import { RealLLMStrategyGeneratorNode } from './llm_strategy_generator_real.mjs';
import { BacktesterEngine } from '../quant_system/backtester_engine.mjs';
import { CovarianceRiskEngine } from './covariance_risk_engine.mjs';
import { SignalAccumulatorBuffer } from '../event_system/signal_buffer_node.mjs';
import { appendTrade } from './db.mjs';
import { WALLET_ADDRESS } from './config.mjs';
import { execSync } from 'child_process';

async function runAIQuantFirmPipeline() {
  console.log('================================================================');
  console.log('  LIVE AI QUANT FIRM: POWERED BY OLLAMA / GEMINI LLM            ');
  console.log('================================================================\n');

  // 1. Ingest Data into Unified Feature Store (SQLite-backed)
  const featureStore = new UnifiedFeatureStore();
  featureStore.seedMultiFeatureDataIfEmpty();
  const historicalRecords = featureStore.getHistoricalRecords();

  console.log(`[Feature Store] SQLite DB loaded ${historicalRecords.length} multi-feature snapshots.`);

  // 2. LLM Quant Researcher (Ollama primary, Gemini fallback)
  const llmResearcher = new RealLLMStrategyGeneratorNode();
  const candidateStrategies = await llmResearcher.generateStrategyCandidates(2);

  if (candidateStrategies.length === 0) {
    console.log('\n⚠️ No strategies generated. Ensure Ollama is running or set GEMINI_API_KEY.');
    return;
  }

  // 3. Backtest Tournament Engine
  const backtester = new BacktesterEngine(0.02, 0.02, 0.005);
  const promotedVoterPool = [];

  console.log('\n====================================================');
  console.log(' 🏆 LLM STRATEGY BACKTESTING TOURNAMENT ');
  console.log('====================================================');

  for (const strat of candidateStrategies) {
    const report = backtester.runBacktest(strat.name, strat.fn, historicalRecords);
    const sharpe  = Number.isFinite(report.sharpeRatio) ? report.sharpeRatio : 0.0;
    const winRate = Number.isFinite(report.winRate)     ? report.winRate     : 0.0;
    const isPromoted = report.totalTrades > 0 && sharpe >= 1.0 && winRate >= 50.0;

    console.log(`\n📊 Candidate: [${report.strategyName}]`);
    console.log(`   Sharpe: ${sharpe.toFixed(2)} | WinRate: ${winRate.toFixed(1)}% | Net ROI: ${report.netRoi}%`);
    console.log(`   Status: ${isPromoted ? '✅ PROMOTED' : '❌ REJECTED'}`);

    if (isPromoted) {
      promotedVoterPool.push({ name: strat.name, fn: strat.fn, sharpeRatio: sharpe, winRate, weight: 0.50 });
    }
  }

  console.log(`\n====================================================`);
  console.log(` 🌟 VOTER POOL: ${promotedVoterPool.length} / ${candidateStrategies.length} strategies promoted.`);
  console.log(`====================================================\n`);

  // 4. Risk Engine & Signal Accumulator
  const riskEngine = new CovarianceRiskEngine({ maxDailyDrawdown: 0.02, minEdgeBarrier: 0.06 });
  const signalBuffer = new SignalAccumulatorBuffer(0.35, 2);
  const client = new DelphiClient();

  const { covMatrix, markets: covMarkets } = riskEngine.computeCovarianceMatrix(historicalRecords);
  const { balance: rawUsdc } = await client.getErc20BalanceWithDecimals();
  const walletBalanceUsdc = Number(rawUsdc) / 1e6;
  const { positions } = await client.listPositions({ wallet: WALLET_ADDRESS, redeemedOrLiquidated: false });
  const openPositions = (positions || []).filter(p => BigInt(p.shares) > 0n);

  console.log(`[Status] Wallet: ${walletBalanceUsdc.toFixed(2)} USDC | Positions: ${openPositions.length}`);

  // 5. Discover Live Open Markets & Execute Orders
  const { markets } = await client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
  if (!markets) return;

  for (const market of markets) {
    const question = market.metadata?.question || market.id;
    const probs = market.spotImpliedProbabilities || [0.5, 0.5];
    const record = { marketAddress: market.id, question, spotProbs: probs, newsSentiment: 0.80, whaleFlow: 25, category: market.category };

    featureStore.recordSnapshot(market.id, question, probs, 0.80, 25, market.category);

    for (const voter of promotedVoterPool) {
      const res = voter.fn(record, covMatrix);
      if (res && res.vote !== 'SKIP') {
        const evalRes = signalBuffer.addSignal({
          marketAddress: market.id,
          question,
          currentMarketProb: probs[0],
          estimatedTrueProb: res.estimatedProb,
          sentimentScore: res.confidence,
        });

        if (evalRes?.triggered) {
          const kelly = riskEngine.calculateKellySize(res.estimatedProb, probs[0], walletBalanceUsdc);
          const proposedSignal = {
            marketAddress: market.id, question,
            outcomeIdx: evalRes.outcomeIdx, outcomeLabel: evalRes.outcomeLabel,
            sharesNum: kelly.sharesNum, edge: evalRes.accumulatedMass,
            covMatrix, covMarkets,
          };

          const riskCheck = riskEngine.evaluateTradeRisk(proposedSignal, walletBalanceUsdc, openPositions, market.category);
          console.log(`[Risk] "${question.slice(0, 30)}...": ${riskCheck.reason}`);

          if (riskCheck.passed) {
            try {
              const sharesOut = BigInt(Math.round(kelly.sharesNum * 1e18));
              const { tokensIn } = await client.quoteBuy({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut });
              const maxTokensIn = (tokensIn * 102n) / 100n;
              await client.ensureTokenApproval({ marketAddress: market.id, minimumAmount: maxTokensIn });
              const tradeRes = await client.buyShares({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut, maxTokensIn });

              console.log(`🚀 [TRADE EXECUTED] TX: ${tradeRes.transactionHash}`);

              appendTrade({
                timestamp: new Date().toISOString(), market: market.id,
                question: question.slice(0, 120), voter: voter.name,
                vote: res.vote, outcome_idx: evalRes.outcomeIdx,
                outcome_label: evalRes.outcomeLabel, shares_num: kelly.sharesNum,
                edge: evalRes.accumulatedMass, risk_reason: riskCheck.reason,
                tx_hash: tradeRes.transactionHash,
              });

              try {
                execSync(`npx tsx scripts/log-event.ts THINK "LLM Strategy ${voter.name}: ${question}"`, { cwd: '.agents/skills/delphi' });
                execSync(`npx tsx scripts/log-event.ts BUY "${kelly.sharesNum} ${evalRes.outcomeLabel} shares on ${question.slice(0, 30)}..."`, { cwd: '.agents/skills/delphi' });
              } catch (_) {}
            } catch (err) {
              console.error(`[Execution Error]: ${err.message || err}`);
            }
          }
        }
      }
    }
  }

  console.log(`\n====================================================`);
  console.log(`  LLM QUANT PIPELINE PASS COMPLETE.`);
  console.log(`====================================================`);
}

runAIQuantFirmPipeline();
