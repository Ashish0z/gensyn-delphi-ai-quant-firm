import { OLLAMA_HOST, OLLAMA_MODEL, GEMINI_API_KEY, GEMINI_PROJECT_NUM } from './config.mjs';

/**
 * LLM ON-CHAIN & WHALE REASONING AGENT NODE
 * Primary: Ollama (local). Fallback: Google Gemini if GEMINI_API_KEY is set.
 * Analyzes on-chain whale transactions, detects spoofing/manipulation, outputs conviction alerts.
 */
export class LLMWhaleAgentNode {
  async evaluateWhaleActivity({ marketQuestion, impliedProb, recentBuyVol, recentSellVol, largestBuy, largestSell, tradeCount }) {
    const netFlow = recentBuyVol - recentSellVol;
    const prompt = `
You are an expert on-chain forensic analyst for a prediction market fund.
Analyze the recent trading activity for this market and assess whether it reflects genuine informed conviction or potential manipulation.

Market question: "${marketQuestion}"
Current implied probability (YES): ${(impliedProb * 100).toFixed(1)}%
Recent trades (last 20): ${tradeCount} total
  - Buy volume: ${recentBuyVol.toFixed(2)} USDC | Largest single buy: ${largestBuy.toFixed(2)} USDC
  - Sell volume: ${recentSellVol.toFixed(2)} USDC | Largest single sell: ${largestSell.toFixed(2)} USDC
  - Net flow: ${netFlow >= 0 ? '+' : ''}${netFlow.toFixed(2)} USDC (${netFlow >= 0 ? 'net buying' : 'net selling'})

Return ONLY valid JSON (no markdown):
{"convictionScore": <float 0.0-1.0 where 1.0=high genuine conviction>, "action": "FOLLOW_WHALE"|"FADE_MANIPULATION"|"MONITOR", "rationale": "<one sentence>"}
    `.trim();

    const ollamaResult = await this._callOllama(prompt);
    if (ollamaResult) return ollamaResult;
    const geminiResult = await this._callGemini(prompt);
    if (geminiResult) return geminiResult;
    return { convictionScore: 0.5, action: 'MONITOR', rationale: 'LLM unavailable' };
  }

  async _callOllama(prompt) {
    try {
      let model = OLLAMA_MODEL;
      try {
        const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
        if (tagsRes.ok) {
          const { models = [] } = await tagsRes.json();
          if (models.length) model = models[0].name;
        }
      } catch (_) {}
      const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return this._parseJson(data.response);
    } catch (_) { return null; }
  }

  async _callGemini(prompt) {
    if (!GEMINI_API_KEY) return null;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
      const headers = { 'Content-Type': 'application/json' };
      if (GEMINI_PROJECT_NUM) headers['x-goog-user-project'] = GEMINI_PROJECT_NUM;
      const res = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const data = await res.json();
      return this._parseJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
    } catch (_) { return null; }
  }

  _parseJson(text) {
    if (!text) return null;
    try {
      const m = text.match(/\{[\s\S]*?\}/);
      if (m) return JSON.parse(m[0]);
    } catch (_) {}
    return null;
  }
}
