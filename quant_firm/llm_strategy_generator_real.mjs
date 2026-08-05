import { OLLAMA_HOST, OLLAMA_MODEL, GEMINI_API_KEY, GEMINI_PROJECT_NUM } from './config.mjs';
import { LangfuseTracer } from '../telemetry/langfuse_tracer.mjs';

/**
 * LLM STRATEGY GENERATOR NODE
 *
 * Primary:  Ollama (local, free, no rate limits) – uses OLLAMA_HOST / OLLAMA_MODEL.
 * Fallback: Google Gemini REST API            – used only when GEMINI_API_KEY is set
 *           and Ollama is unreachable.
 *
 * Both backends ask the LLM to write a JavaScript function body that returns
 * { vote, confidence, estimatedProb } given (record, covMatrix).
 */
export class RealLLMStrategyGeneratorNode {
  constructor() {
    this.tracer = new LangfuseTracer();
    this._prompt = `
You are an expert Chief Quantitative Researcher for an AI prediction market hedge fund.
Write a valid JavaScript function body (NO function header, just the inner body lines) that
takes (record, covMatrix) as inputs and returns:
  { vote: 'BUY_YES' | 'BUY_NO' | 'SKIP', confidence: float (0.5–0.95), estimatedProb: float (0.0–1.0) }

Available fields on 'record':
  record.spotProbs[0]   – YES implied probability (0.0–1.0)
  record.newsSentiment  – News sentiment score    (0.0–1.0)
  record.whaleFlow      – Institutional USDC net volume (0–100)
  record.category       – Market category ('crypto', 'politics', 'economics', 'miscellaneous')

Rules:
  - Combine at least TWO of the above features in your alpha logic.
  - Never return BUY_YES/BUY_NO when spotProbs[0] is between 0.45 and 0.55 (low-edge zone).
  - Return ONLY executable JavaScript code inside a \`\`\`javascript ... \`\`\` block.
`;
  }

  /* ── Ollama ── */
  async _callOllama(prompt) {
    const startTime = Date.now();
    try {
      // Auto-select installed model
      let model = OLLAMA_MODEL;
      try {
        const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
        if (tagsRes.ok) {
          const { models = [] } = await tagsRes.json();
          if (models.length && !models.find(m => m.name === model)) {
            model = models[0].name;
          }
        }
      } catch (_) {}

      const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const data = await res.json();
      const text = data.response || '';
      await this.tracer.traceLLMCall(`Ollama_${model}`, prompt, text, Date.now() - startTime, { inputTokens: 240, outputTokens: 120 });
      return text || null;
    } catch (err) {
      console.warn(`[LLM Strategy] Ollama unavailable: ${err.message}`);
      return null;
    }
  }

  /* ── Gemini fallback ── */
  async _callGemini(prompt) {
    if (!GEMINI_API_KEY) return null;
    const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
    const startTime = Date.now();
    for (const modelName of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
      const headers = { 'Content-Type': 'application/json' };
      if (GEMINI_PROJECT_NUM) headers['x-goog-user-project'] = GEMINI_PROJECT_NUM;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          });
          const data = await res.json();
          if (data.error?.code === 429) {
            await new Promise(r => setTimeout(r, attempt * 2000));
            continue;
          }
          if (data.error) break;
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            await this.tracer.traceLLMCall(modelName, prompt, text, Date.now() - startTime, { inputTokens: 240, outputTokens: 120 });
            return text;
          }
        } catch (err) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    return null;
  }

  /* ── Hardcoded fallback (always works, no LLM required) ── */
  _hardcodedFallback(idx) {
    const cats = ['crypto', 'politics', 'economics', 'miscellaneous'];
    const cat = cats[idx % cats.length];
    const minWhale = 10 + (idx * 7) % 30;
    const minSent  = (0.55 + (idx * 0.04) % 0.25).toFixed(2);
    const pThresh  = (0.60 + (idx * 0.05) % 0.25).toFixed(2);
    return `
const yesProb = record.spotProbs[0];
const sentiment = record.newsSentiment || 0.5;
const whale = record.whaleFlow || 0;
const cat = record.category || '';
// Multi-factor alpha: category + whale flow + sentiment
if (cat === '${cat}' && whale >= ${minWhale} && sentiment >= ${minSent} && yesProb < 0.55) {
  return { vote: 'BUY_YES', confidence: 0.82, estimatedProb: Math.min(0.90, yesProb + 0.18) };
}
if (yesProb > ${pThresh} && sentiment < 0.38) {
  return { vote: 'BUY_NO', confidence: 0.80, estimatedProb: Math.max(0.10, yesProb - 0.22) };
}
return { vote: 'SKIP' };
`.trim();
  }

  /* ── Public API ── */
  async generateStrategyCandidates(count = 1) {
    console.log(`[LLM Strategy] Generating ${count} candidate(s) via Ollama (${OLLAMA_HOST})...`);
    const strategies = [];

    for (let i = 0; i < count; i++) {
      // 1. Try Ollama
      let text = await this._callOllama(this._prompt);

      // 2. Try Gemini if Ollama failed and key is available
      if (!text) {
        console.log(`  [LLM Strategy] Ollama failed for candidate ${i + 1}. ${GEMINI_API_KEY ? 'Trying Gemini fallback...' : 'Using hardcoded fallback.'}`);
        text = await this._callGemini(this._prompt);
      }

      let codeBody;
      if (text) {
        const m = text.match(/```(?:javascript|js)?([\s\S]*?)```/);
        codeBody = m?.[1]?.trim() || text.trim();
      } else {
        console.log(`  [LLM Strategy] Using hardcoded rule-based fallback for candidate ${i + 1}.`);
        codeBody = this._hardcodedFallback(i);
      }

      try {
        const compiledFn = new Function('record', 'covMatrix', codeBody);
        const stratId = `LLM_Alpha_${Date.now()}_${i + 1}`;
        console.log(`  ✅ [Strategy ${i + 1}] Compiled:\n--- CODE ---\n${codeBody.slice(0, 300)}\n------------`);
        strategies.push({ name: stratId, code: codeBody, fn: compiledFn });
      } catch (err) {
        console.error(`  ❌ Compile error for candidate ${i + 1}: ${err.message}`);
        // Compile the hardcoded fallback instead so we always return something
        const fallback = this._hardcodedFallback(i);
        try {
          strategies.push({
            name: `LLM_Alpha_Fallback_${Date.now()}_${i + 1}`,
            code: fallback,
            fn: new Function('record', 'covMatrix', fallback),
          });
        } catch (_) {}
      }
    }

    return strategies;
  }
}
