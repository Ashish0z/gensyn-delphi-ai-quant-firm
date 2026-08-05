import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { UnifiedFeatureStore } from './unified_feature_store.mjs';
import { RealLLMStrategyGeneratorNode } from './llm_strategy_generator_real.mjs';
import { BacktesterEngine } from '../quant_system/backtester_engine.mjs';
import { CovarianceRiskEngine } from './covariance_risk_engine.mjs';
import { SignalAccumulatorBuffer } from '../event_system/signal_buffer_node.mjs';
import { execSync } from 'child_process';

async function runAIQuantFirmPipeline() {
  console.log('================================================================');
  console.log('  LIVE AI QUANT FIRM: POWERED BY GOOGLE GEMINI API (REAL LLM)  ');
  console.log('================================================================\n');

  // 1. Ingest Data into Unified Feature Store (Time-Series DB)
  const featureStore = new UnifiedFeatureStore();
  featureStore.seedMultiFeatureDataIfEmpty();
  const historicalRecords = featureStore.getHistoricalRecords();

  console.log(`[Feature Store] Time-Series DB loaded ${historicalRecords.length} multi-feature snapshots.`);

  // 2. Real LLM Quant Researcher: Call Google Gemini API
  const llmResearcher = new RealLLMStrategyGeneratorNode();
  const candidateStrategies = await llmResearcher.generateStrategyCandidates(2);

  if (candidateStrategies.length === 0) {
    console.log('\n⚠️ No strategies generated. Please ensure `GEMINI_API_KEY` is added to your .env file!');
    return;
  }

  // 3. Backtest Tournament Engine
  const backtester = new BacktesterEngine(0.02, 0.02, 0.005);
  const promotedVoterPool = [];

  console.log('\n====================================================');
  console.log(' 🏆 REAL GEMINI LLM STRATEGY BACKTESTING TOURNAMENT ');
  console.log('====================================================');

  for (const strat of candidateStrategies) {
    const report = backtester.runBacktest(strat.name, strat.fn, historicalRecords);
    const isPromoted = report.totalTrades > 0 && report.finalBalance >= 90.0;

    console.log(`\n📊 Candidate Strategy: [${report.strategyName}]`);
    console.log(`   • Sharpe Ratio: ${report.sharpeRatio} | Win Rate: ${report.winRate}% | Net ROI: ${report.netRoi}%`);
    console.log(`   • Status: ${isPromoted ? '✅ PROMOTED TO VOTER POOL' : '❌ REJECTED'}`);

    if (isPromoted) {
      promotedVoterPool.push({
        name: strat.name,
        fn: strat.fn,
        sharpeRatio: report.sharpeRatio,
        winRate: report.winRate,
        weight: 0.50,
      });
    }
  }

  console.log(`\n====================================================`);
  console.log(` 🌟 PROMOTED VOTER POOL: ${promotedVoterPool.length} of ${candidateStrategies.length} Gemini LLM strategies active.`);
  console.log(`====================================================\n`);

  // 4. Risk Engine & Signal Accumulator
  const riskEngine = new CovarianceRiskEngine({ maxDailyDrawdown: 0.02, minEdgeBarrier: 0.06 });
  const signalBuffer = new SignalAccumulatorBuffer(0.35, 2);
  const client = new DelphiClient();
  const walletAddress = '0xd3F62e6c71e815E37e8Aa8E91e0E7Dc297857c37';

  const { covMatrix } = riskEngine.computeCovarianceMatrix(historicalRecords);
  const { balance: rawUsdc } = await client.getErc20BalanceWithDecimals();
  const walletBalanceUsdc = Number(rawUsdc) / 1e6;
  const { positions } = await client.listPositions({ wallet: walletAddress, redeemedOrLiquidated: false });
  const openPositions = (positions || []).filter(p => BigInt(p.shares) > 0n);

  console.log(`[Quant System Status] Wallet Balance: ${walletBalanceUsdc.toFixed(2)} USDC | Active Positions: ${openPositions.length}`);

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
          console.log(`[Quant System] Risk Check for "${question.slice(0, 30)}...": ${riskCheck.reason}`);

          if (riskCheck.passed) {
            try {
              const sharesOut = BigInt(Math.round(kelly.sharesNum * 1e18));
              const { tokensIn } = await client.quoteBuy({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut });
              const maxTokensIn = (tokensIn * 102n) / 100n;

              await client.ensureTokenApproval({ marketAddress: market.id, minimumAmount: maxTokensIn });
              const tradeRes = await client.buyShares({ marketAddress: market.id, outcomeIdx: evalRes.outcomeIdx, sharesOut, maxTokensIn });

              console.log(`🚀 [REAL GEMINI LLM TRADE EXECUTED!] TX: ${tradeRes.transactionHash}`);

              try {
                const thinkMsg = `Real Gemini LLM Strategy ${voter.name} executed. Market: ${question}`;
                execSync(`npx tsx scripts/log-event.ts THINK "${thinkMsg}"`, { cwd: '.agents/skills/delphi' });
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
  console.log(`  REAL GEMINI LLM QUANT PIPELINE PASS COMPLETE.`);
  console.log(`====================================================`);
}

runAIQuantFirmPipeline();
