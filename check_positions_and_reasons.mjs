import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function main() {
  try {
    const client = new DelphiClient();
    const walletAddress = '0xd3F62e6c71e815E37e8Aa8E91e0E7Dc297857c37';

    console.log('====================================================');
    console.log('  CURRENT POSITIONS & REASONING AUDIT  ');
    console.log('====================================================\n');

    // 1. Fetch current open positions
    const { positions } = await client.listPositions({
      wallet: walletAddress,
      redeemedOrLiquidated: false,
      limit: 50,
    });

    const activePositions = (positions || []).filter(p => BigInt(p.shares) > 0n);

    console.log(`Active Positions Count: ${activePositions.length}\n`);

    for (let i = 0; i < activePositions.length; i++) {
      const pos = activePositions[i];
      const sharesNum = Number(BigInt(pos.shares)) / 1e18;
      const outcomeIdx = Number(pos.outcomeIdx);
      const marketAddress = pos.marketProxy;

      let m = null;
      try {
        m = await client.getMarket({ id: marketAddress, pricesAndImpliedProbabilities: true });
      } catch (_) {}

      const question = m?.metadata?.question || marketAddress;
      const outcomeLabel = outcomeIdx === 0 ? 'YES' : 'NO';
      const currentSpotPrice = m?.spotPrices ? m.spotPrices[outcomeIdx] : 'N/A';
      const currentProb = m?.spotImpliedProbabilities ? (m.spotImpliedProbabilities[outcomeIdx] * 100).toFixed(1) + '%' : 'N/A';

      console.log(`[Position ${i+1}/${activePositions.length}]`);
      console.log(`📌 Market: "${question}"`);
      console.log(`   Address: ${marketAddress}`);
      console.log(`   Outcome: Outcome ${outcomeIdx} (${outcomeLabel}) | Shares: ${sharesNum.toFixed(4)}`);
      console.log(`   Live Spot Price: ${typeof currentSpotPrice === 'number' ? currentSpotPrice.toFixed(4) + ' USDC/share' : currentSpotPrice}`);
      console.log(`   Live Implied Prob: ${currentProb}`);
      console.log('');
    }

    // 2. Read Agent Event Logs
    const logPath = path.join(os.homedir(), '.delphi', 'agent-events.jsonl');
    console.log('----------------------------------------------------');
    console.log('Recent Agent Reasoning Stream Logs (~/.delphi/agent-events.jsonl):\n');

    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      const recent = lines.slice(-10);
      for (const line of recent) {
        try {
          const ev = JSON.parse(line);
          console.log(`• [${ev.type}] ${ev.message}`);
        } catch (_) {
          console.log(`• ${line}`);
        }
      }
    } else {
      console.log('No agent-events.jsonl file found.');
    }

  } catch (err) {
    console.error('Audit Error:', err.message || err);
  }
}

main();
