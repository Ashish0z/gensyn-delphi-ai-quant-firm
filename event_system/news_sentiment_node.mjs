import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { LLMNewsAgentNode } from '../quant_firm/llm_news_agent_node.mjs';

/**
 * HIGH-FREQUENCY NEWS & SENTIMENT STREAMING NODE
 *
 * Derives per-market sentiment using two signals:
 *   1. Price momentum: EWMA of recent probability changes (bullish/bearish trend).
 *   2. LLM headline analysis: Ollama (primary) or Gemini (fallback) evaluates the
 *      market question text against synthetic "latest news" to produce a semantic score.
 *
 * The composite score is published as a NEWS_SIGNAL event on the shared event bus.
 */

const EWMA_ALPHA = 0.2; // decay factor for exponential moving average
const probHistory = new Map(); // marketAddress -> { ewmaProb, prevProb }

function momentumSentiment(marketAddress, currentProb) {
  if (!probHistory.has(marketAddress)) {
    probHistory.set(marketAddress, { ewmaProb: currentProb, prevProb: currentProb });
    return 0.5; // neutral on first tick
  }
  const state = probHistory.get(marketAddress);
  const newEwma = EWMA_ALPHA * currentProb + (1 - EWMA_ALPHA) * state.ewmaProb;
  const momentum = newEwma - state.ewmaProb; // positive = price rising = bullish
  state.prevProb = state.ewmaProb;
  state.ewmaProb = newEwma;
  // Map momentum [-0.2, +0.2] → sentiment [0.1, 0.9]
  return Math.max(0.1, Math.min(0.9, 0.5 + momentum * 2.5));
}

async function startNewsSentimentNode() {
  console.log('[Node: News & Sentiment] 🟢 High-frequency sentiment streaming node online...');
  const client = new DelphiClient();
  const llmNews = new LLMNewsAgentNode();

  async function checkNewsAndSentiment() {
    try {
      const { markets } = await client.listMarkets({ status: 'open', limit: 10, pricesAndImpliedProbabilities: true });
      if (!markets) return;

      for (const m of markets) {
        const question = m.metadata?.question || m.id;
        const probs = m.spotImpliedProbabilities || [0.5, 0.5];
        const currentProb = probs[0];

        // 1. Price-momentum sentiment
        const momentumScore = momentumSentiment(m.id, currentProb);

        // 2. LLM semantic sentiment (async, best-effort)
        let llmScore = 0.5;
        try {
          // Use the market question itself as the "headline" since we have no live news feed.
          // In production replace `question` with a real fetched headline.
          const llmResult = await llmNews.analyzeHeadlineWithLLM(question, question);
          if (llmResult && typeof llmResult.sentimentScore === 'number') {
            llmScore = llmResult.sentimentScore;
          }
        } catch (_) {}

        // 3. Composite: 60% momentum + 40% LLM
        const compositeScore = 0.6 * momentumScore + 0.4 * llmScore;

        console.log(`[Node: News & Sentiment] 📰 "${question.slice(0, 35)}..." → momentum=${momentumScore.toFixed(2)} llm=${llmScore.toFixed(2)} composite=${compositeScore.toFixed(2)}`);

        // Publish to event bus so the consensus node / signal buffer can consume it
        if (process.send) {
          process.send({
            type: 'NEWS_SIGNAL',
            payload: {
              marketAddress:     m.id,
              question,
              currentMarketProb: currentProb,
              estimatedTrueProb: Math.max(0.05, Math.min(0.95, currentProb + (compositeScore - 0.5) * 0.2)),
              sentimentScore:    compositeScore,
            },
          });
        }
      }
    } catch (err) {
      console.error('[Node: News & Sentiment Error]:', err.message);
    }
  }

  await checkNewsAndSentiment();
  setInterval(checkNewsAndSentiment, 30_000);
}

startNewsSentimentNode();
