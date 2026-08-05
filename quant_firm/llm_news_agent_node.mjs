import { OLLAMA_HOST, OLLAMA_MODEL, GEMINI_API_KEY, GEMINI_PROJECT_NUM } from './config.mjs';

/**
 * LLM NEWS & SENTIMENT REASONING AGENT NODE
 * Primary: Ollama (local). Fallback: Google Gemini if GEMINI_API_KEY is set.
 * Semantically evaluates live prediction market headlines and reasons about outcome probability shifts.
 */
export class LLMNewsAgentNode {
  async analyzeHeadlineWithLLM(headline, marketQuestion) {
    const prompt = `
You are an expert Intelligence & Geopolitical News Analysis AI for a prediction market fund.
Analyze this news headline relative to the target market question:
- Headline: "${headline}"
- Market Question: "${marketQuestion}"

Return ONLY valid JSON (no markdown, no explanation):
{"sentimentScore": <float 0.0–1.0>, "impact": "HIGH_BULLISH"|"BULLISH"|"NEUTRAL"|"BEARISH"|"HIGH_BEARISH", "reasoning": "<one sentence>"}
    `.trim();

    // 1. Try Ollama
    const ollamaResult = await this._callOllama(prompt);
    if (ollamaResult) return ollamaResult;

    // 2. Try Gemini
    const geminiResult = await this._callGemini(prompt);
    if (geminiResult) return geminiResult;

    return { sentimentScore: 0.5, impact: 'NEUTRAL', reasoning: 'Fallback baseline' };
  }

  async _callOllama(prompt) {
    try {
      const models = await this._getOllamaModels();
      const model = models[0] || OLLAMA_MODEL;
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

  async _getOllamaModels() {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`);
      if (res.ok) {
        const data = await res.json();
        return (data.models || []).map(m => m.name);
      }
    } catch (_) {}
    return [OLLAMA_MODEL];
  }

  async _callGemini(prompt) {
    if (!GEMINI_API_KEY) return null;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
      const headers = { 'Content-Type': 'application/json' };
      if (GEMINI_PROJECT_NUM) headers['x-goog-user-project'] = GEMINI_PROJECT_NUM;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return this._parseJson(text);
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
