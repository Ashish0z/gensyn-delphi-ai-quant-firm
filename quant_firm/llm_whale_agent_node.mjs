import { OLLAMA_HOST, OLLAMA_MODEL, GEMINI_API_KEY, GEMINI_PROJECT_NUM } from './config.mjs';

/**
 * LLM ON-CHAIN & WHALE REASONING AGENT NODE
 * Primary: Ollama (local). Fallback: Google Gemini if GEMINI_API_KEY is set.
 * Analyzes on-chain whale transactions, detects spoofing/manipulation, outputs conviction alerts.
 */
export class LLMWhaleAgentNode {
  async evaluateWhaleTransactionWithLLM(txDetails) {
    const prompt = `
You are an expert On-Chain Forensic & Institutional Whale Analysis AI for a prediction market fund.
Evaluate this whale transaction:
- Amount USDC: ${txDetails.amountUsdc}
- Outcome Side: ${txDetails.outcomeLabel}
- Market Question: "${txDetails.marketQuestion}"

Return ONLY valid JSON (no markdown):
{"convictionScore": <float 0.0–1.0>, "action": "FOLLOW_WHALE"|"FADE_MANIPULATION"|"MONITOR", "rationale": "<one sentence>"}
    `.trim();

    const ollamaResult = await this._callOllama(prompt);
    if (ollamaResult) return ollamaResult;

    const geminiResult = await this._callGemini(prompt);
    if (geminiResult) return geminiResult;

    return { convictionScore: 0.5, action: 'MONITOR', rationale: 'Fallback baseline' };
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
