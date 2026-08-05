import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

function publishEvent(type, payload) {
  if (process.send) {
    process.send({ type, payload });
  } else {
    import('./event_bus.mjs').then(({ globalBus }) => globalBus.publish(type, payload));
  }
}

async function startAdversarialWatcherNode() {
  console.log('[Node: Adversarial Watcher] 🛡️ Real-time on-chain & subgraph watcher node online...');
  const client = new DelphiClient();
  const subgraph = client.getSubgraph();

  async function checkOnchainEvents() {
    try {
      const { markets } = await client.listMarkets({ status: 'open', limit: 10 });
      if (!markets) return;

      for (const m of markets) {
        try {
          const { buys } = await subgraph.getMarketTrades(m.id, { first: 5 });
          for (const buy of buys || []) {
            const costUsdc = Number(BigInt(buy.tokensIn || '0')) / 1e6;
            if (costUsdc >= 10.0) {
              console.log(`[Node: Adversarial Watcher] 🐋 Whale Trade Detected! ${costUsdc.toFixed(2)} USDC on ${m.id}`);
              publishEvent('WHALE_ALERT', {
                marketAddress: m.id,
                buyer: buy.buyer,
                amountUsdc: costUsdc,
                sharesOut: buy.sharesOut,
                timestamp: buy.timestamp_,
              });
            }
          }
        } catch (_) {}
      }
    } catch (err) {
      console.error('[Node: Adversarial Watcher Error]:', err.message);
    }
  }

  await checkOnchainEvents();
  setInterval(checkOnchainEvents, 15_000);
}

startAdversarialWatcherNode();
