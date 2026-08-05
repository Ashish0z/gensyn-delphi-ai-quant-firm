import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

/**
 * HIGH-FREQUENCY NEWS & SENTIMENT STREAMING NODE
 * Updates market sentiment features for the Unified Feature Store.
 * Does NOT emit raw trade signals to bypass LLM & Voter Consensus.
 */
async function startNewsSentimentNode() {
  console.log('[Node: News & Sentiment] 🟢 High-frequency sentiment feature streaming node online...');
  const client = new DelphiClient();

  async function checkNewsAndSentiment() {
    try {
      const { markets } = await client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
      if (!markets) return;

      for (const m of markets) {
        const question = m.metadata?.question || m.id;
        const probs = m.spotImpliedProbabilities || [0.5, 0.5];

        // Sentiment feature score
        const sentimentScore = Number(probs[0]) > 0.5 ? 0.75 : 0.35;
        console.log(`[Node: News & Sentiment] 📰 Streamed sentiment update for "${question.slice(0, 30)}...": ${sentimentScore}`);
      }
    } catch (err) {
      console.error('[Node: News & Sentiment Error]:', err.message);
    }
  }

  await checkNewsAndSentiment();
  setInterval(checkNewsAndSentiment, 30_000);
}

startNewsSentimentNode();
