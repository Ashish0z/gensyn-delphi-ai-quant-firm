import { OLLAMA_HOST, OLLAMA_MODEL, GEMINI_API_KEY, GEMINI_PROJECT_NUM } from './config.mjs';

/**
 * LLM NEWS & SENTIMENT REASONING AGENT NODE
 * Primary: Ollama (local). Fallback: Google Gemini if GEMINI_API_KEY is set.
 * Semantically evaluates live prediction market headlines and reasons about outcome probability shifts.
 */
export class LLMNewsAgentNode {
  // Extract salient search terms from a market question for news lookup
  _extractKeywords(question) {
    const stopWords = new Set(['will','the','a','an','by','of','in','at','to','for','be','is','are','was','were','end','start','reach','hit','exceed','above','below','over','under','more','less','than','and','or','not','no','do','does','did','has','have','had','this','that','with','from','into','onto','upon','when','where','what','how','which']);
    return question
      .replace(/[?$%]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
      .slice(0, 4)
      .join(' ');
  }

  // Fetch recent headlines from Google News RSS (free, no key required)
  async _fetchHeadlines(question) {
    try {
      const keywords = this._extractKeywords(question);
      if (!keywords) return [];
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keywords)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const xml = await res.text();
      // Google News RSS uses both CDATA-wrapped and plain <title> tags
      const cdata = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].map(m => m[1]);
      const plain = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map(m => m[1]);
      return (cdata.length ? cdata : plain).slice(1, 7); // skip first (feed title)
    } catch (_) {
      return [];
    }
  }

  async analyzeMarketContext({ question, category, impliedProb, priceTrend, buyPressure }) {
    const headlines = await this._fetchHeadlines(question);
    const trendDesc = priceTrend > 0.02 ? 'rising' : priceTrend < -0.02 ? 'falling' : 'stable';
    const headlinesSection = headlines.length
      ? `\nRecent real-world headlines:\n${headlines.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}`
      : '\n(No recent headlines found — rely on market signals only)';

    const prompt = `
You are an expert prediction market analyst. Assess the outcome probability for the following market.

Market question: "${question}"
Category: ${category || 'general'}
Current market-implied probability (YES): ${(impliedProb * 100).toFixed(1)}%
Recent price trend: ${trendDesc} (${priceTrend >= 0 ? '+' : ''}${(priceTrend * 100).toFixed(1)}% change)
Recent trader buy pressure: ${(buyPressure * 100).toFixed(0)}% of volume is buying YES
${headlinesSection}

Based on the headlines above and market signals, what is your sentiment toward YES resolving?

Return ONLY valid JSON (no markdown):
{"sentimentScore": <float 0.0-1.0 where 1.0=very bullish YES>, "impact": "HIGH_BULLISH"|"BULLISH"|"NEUTRAL"|"BEARISH"|"HIGH_BEARISH", "reasoning": "<one sentence>"}
    `.trim();

    const ollamaResult = await this._callOllama(prompt);
    if (ollamaResult) return ollamaResult;
    const geminiResult = await this._callGemini(prompt);
    if (geminiResult) return geminiResult;
    return { sentimentScore: buyPressure, impact: 'NEUTRAL', reasoning: 'LLM unavailable — using buy pressure as proxy' };
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
