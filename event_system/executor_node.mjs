import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { execSync } from 'child_process';

/**
 * EVENT-DRIVEN ON-CHAIN EXECUTOR NODE WITH NONCE QUEUE
 * Process: Sleeps continuously until woken by EXECUTE_TRADE_SIGNAL event.
 * Queues signals sequentially to prevent transaction replacement / nonce errors.
 */
export function startExecutorNode(eventBus) {
  console.log('[Node: Executor] ⚡ Started Event-Driven On-Chain Executor Node (Sleeping until event...)');
  const client = new DelphiClient();
  let executionQueue = Promise.resolve();

  eventBus.on('EXECUTE_TRADE_SIGNAL', (signal) => {
    executionQueue = executionQueue.then(async () => {
      console.log(`\n[Node: Executor] ⏰ WOKEN UP BY EXECUTE_TRADE_SIGNAL!`);
      console.log(`   • Market: "${signal.question.slice(0, 40)}..."`);
      console.log(`   • Target: ${signal.sharesNum} ${signal.outcomeLabel} shares`);

      try {
        const sharesOut = BigInt(Math.round(signal.sharesNum * 1e18));
        
        // 1. Quote
        const { tokensIn } = await client.quoteBuy({
          marketAddress: signal.marketAddress,
          outcomeIdx: signal.outcomeIdx,
          sharesOut,
        });

        const costUsdc = Number(tokensIn) / 1e6;
        const maxTokensIn = (tokensIn * 102n) / 100n; // 2% slippage cap

        console.log(`   • Quoted Cost: ${costUsdc.toFixed(4)} USDC`);

        // 2. Ensure Approval
        await client.ensureTokenApproval({
          marketAddress: signal.marketAddress,
          minimumAmount: maxTokensIn,
        });

        // 3. Submit Transaction
        const tradeRes = await client.buyShares({
          marketAddress: signal.marketAddress,
          outcomeIdx: signal.outcomeIdx,
          sharesOut,
          maxTokensIn,
        });

        console.log(`   🚀 TRADE EXECUTED ON-CHAIN!`);
        console.log(`   • TX Hash: ${tradeRes.transactionHash}`);

        // 4. Stream event to Agent TUI event log
        try {
          const thinkMsg = `Event Trigger: Edge ${(signal.edge*100).toFixed(1)}%, conf ${(signal.confidence*100).toFixed(0)}%. Market: ${signal.question}`;
          execSync(`npx tsx scripts/log-event.ts THINK "${thinkMsg}"`, { cwd: '.agents/skills/delphi' });
          execSync(`npx tsx scripts/log-event.ts BUY "${signal.sharesNum} ${signal.outcomeLabel} shares on ${signal.question.slice(0, 30)}..."`, { cwd: '.agents/skills/delphi' });
        } catch (_) {}

        // Small 2-second cooldown to let L2 transaction nonce clear
        await new Promise(r => setTimeout(r, 2000));

      } catch (err) {
        console.error(`   ❌ Executor Execution Failed: ${err.message || err}`);
      }

      console.log(`[Node: Executor] 😴 Trade complete. Returning to sleep mode...\n`);
    });
  });
}
