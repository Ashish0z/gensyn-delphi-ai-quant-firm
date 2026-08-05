import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

function publishEvent(type, payload) {
  if (process.send) {
    process.send({ type, payload });
  } else {
    import('./event_bus.mjs').then(({ globalBus }) => globalBus.publish(type, payload));
  }
}

async function startNewsSentimentNode() {
  console.log('[Node: News & Sentiment] 🟢 High-frequency sentiment streaming node online...');
  const client = new DelphiClient();

  async function checkNewsAndSentiment() {
    try {
      const { markets } = await client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
      if (!markets) return;

      for (const m of markets) {
        const question = m.metadata?.question || m.id;
        const probs = m.spotImpliedProbabilities || [0.5, 0.5];

        // Simulate news shift detecting edge
        const estimatedTrueProb = Number(probs[0]) > 0.5 ? Math.min(probs[0] + 0.12, 0.95) : Math.max(probs[0] - 0.12, 0.05);

        if (Math.abs(estimatedTrueProb - probs[0]) >= 0.08) {
          console.log(`[Node: News & Sentiment] 📰 Significant News Shift: "${question.slice(0, 35)}..."`);
          publishEvent('NEWS_SIGNAL', {
            marketAddress: m.id,
            question,
            currentMarketProb: probs[0],
            estimatedTrueProb,
            sentimentScore: 0.85,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error('[Node: News & Sentiment Error]:', err.message);
    }
  }

  await checkNewsAndSentiment();
  setInterval(checkNewsAndSentiment, 10_000);
}

startNewsSentimentNode();
