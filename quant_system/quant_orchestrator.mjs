import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { MLStrategyTournamentAgent } from './ml_strategy_tournament_agent.mjs';
import { PreTradeRiskEngine } from './pre_trade_risk_engine.mjs';
import { SignalAccumulatorBuffer } from '../event_system/signal_buffer_node.mjs';
import { execSync } from 'child_process';

async function runQuantProductionPipeline() {
  console.log('================================================================');
  console.log('  INDUSTRY-STANDARD QUANT SYSTEM WITH PRE-TRADE RISK ENGINE  ');
  console.log('================================================================\n');

  // 1. Run ML Strategy Tournament & Promote High-Sharpe Voters
  const tournament = new MLStrategyTournamentAgent();
  const { promotedVoterPool } = tournament.runTournament();

  if (promotedVoterPool.length === 0) {
    console.log('❌ No candidate strategies passed the Sharpe & WinRate requirements for promotion.');
    return;
  }

  // 2. Initialize Pre-Trade Risk Engine & Signal Accumulator
  const riskEngine = new PreTradeRiskEngine({
    maxDailyDrawdown: 0.02,     // 2% max daily stop loss
    maxMarketExposurePct: 0.15, // 15% max per market
    minEdgeBarrier: 0.06,       // 6% min edge to clear fees
    maxRpcLatencyMs: 800,       // 800ms max latency
  });

  const signalBuffer = new SignalAccumulatorBuffer(0.35, 2);
  const client = new DelphiClient();
  const walletAddress = '0xd3F62e6c71e815E37e8Aa8E91e0E7Dc297857c37';

  // 3. Fetch Wallet State & Open Positions
  const { balance: rawUsdc } = await client.getErc20BalanceWithDecimals();
  const walletBalanceUsdc = Number(rawUsdc) / 1e6;

  const { positions } = await client.listPositions({ wallet: walletAddress, redeemedOrLiquidated: false });
  const openPositions = (positions || []).filter(p => BigInt(p.shares) > 0n);

  console.log(`[Quant System Status] Wallet Balance: ${walletBalanceUsdc.toFixed(2)} USDC | Active Positions: ${openPositions.length}`);
  console.log(`[Quant System Status] Active Voters in Pool: ${promotedVoterPool.map(v => v.name).join(', ')}\n`);

  // 4. Discover Open Markets & Run Promoted Strategy Voters
  const { markets } = await client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
  if (!markets) return;

  for (const market of markets) {
    const question = market.metadata?.question || market.id;
    const probs = market.spotImpliedProbabilities || [0.5, 0.5];
    const tick = { marketAddress: market.id, question, spotProbs: probs };

    // Run each Promoted Voter Strategy
    for (const voter of promotedVoterPool) {
      const res = voter.fn(tick);
      if (res && res.vote !== 'SKIP') {
        const edge = Math.abs(res.estimatedProb - probs[0]);

        // Add signal to Accumulator Buffer
        const evalRes = signalBuffer.addSignal({
          marketAddress: market.id,
          question,
          currentMarketProb: probs[0],
          estimatedTrueProb: res.estimatedProb,
          sentimentScore: res.confidence,
        });

        // Check if Signal Accumulator Threshold Triggered
        if (evalRes && evalRes.triggered) {
          console.log(`----------------------------------------------------`);
          console.log(`⚡ [SIGNAL ACCUMULATOR TRIGGERED] Market: "${question.slice(0, 35)}..."`);
          console.log(`   Accumulated Mass: ${evalRes.accumulatedMass.toFixed(3)} | Batch: ${evalRes.batchShares} ${evalRes.outcomeLabel} shares`);

          const proposedSignal = {
            marketAddress: market.id,
            question,
            outcomeIdx: evalRes.outcomeIdx,
            outcomeLabel: evalRes.outcomeLabel,
            sharesNum: evalRes.batchShares,
            edge: evalRes.accumulatedMass,
          };

          // 5. Run Pre-Trade Risk Engine Checks
          console.log(`\n  🛡️ [PRE-TRADE RISK ENGINE EVALUATION]`);
          const riskCheck = await riskEngine.evaluateTradeRisk(proposedSignal, walletBalanceUsdc, openPositions);

          console.log(`     • ${riskCheck.reason}`);

          if (riskCheck.passed) {
            console.log(`  🚀 RISK CHECKS PASSED! Submitting On-Chain Order...`);
            try {
              const sharesOut = BigInt(Math.round(evalRes.batchShares * 1e18));
              const { tokensIn } = await client.quoteBuy({
                marketAddress: market.id,
                outcomeIdx: evalRes.outcomeIdx,
                sharesOut,
              });

              const maxTokensIn = (tokensIn * 102n) / 100n;
              await client.ensureTokenApproval({ marketAddress: market.id, minimumAmount: maxTokensIn });

              const tradeRes = await client.buyShares({
                marketAddress: market.id,
                outcomeIdx: evalRes.outcomeIdx,
                sharesOut,
                maxTokensIn,
              });

              console.log(`     ✅ TRADE EXECUTED! TX Hash: ${tradeRes.transactionHash}`);

              try {
                const thinkMsg = `Quant System Approved (${promotedVoterPool.length} Voters, Risk Checked). Market: ${question}`;
                execSync(`npx tsx scripts/log-event.ts THINK "${thinkMsg}"`, { cwd: '.agents/skills/delphi' });
                execSync(`npx tsx scripts/log-event.ts BUY "${evalRes.batchShares} ${evalRes.outcomeLabel} shares on ${question.slice(0, 30)}..."`, { cwd: '.agents/skills/delphi' });
              } catch (_) {}

            } catch (err) {
              console.error(`     ❌ Trade Execution Error: ${err.message || err}`);
            }
          } else {
            console.log(`  🛑 TRADE REJECTED BY PRE-TRADE RISK ENGINE. Capital Protected.`);
          }
        }
      }
    }
  }

  console.log(`\n====================================================`);
  console.log(`  QUANT SYSTEM PASS COMPLETE.`);
  console.log(`====================================================`);
}

runQuantProductionPipeline();
