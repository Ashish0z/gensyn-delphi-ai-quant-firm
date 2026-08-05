import { OLLAMA_HOST, OLLAMA_MODEL } from './config.mjs';
import { LangfuseTracer } from '../telemetry/langfuse_tracer.mjs';

/**
 * OLLAMA LOCAL LLM STRATEGY GENERATOR NODE
 * Connects to Ollama running locally (OLLAMA_HOST / OLLAMA_MODEL).
 * Auto-detects installed models and falls back to rule-based code when Ollama is unreachable.
 */
export class OllamaStrategyGeneratorNode {
  constructor(modelName = OLLAMA_MODEL) {
    this.host = OLLAMA_HOST;
    this.modelName = modelName;
    this.tracer = new LangfuseTracer();
  }

  async getAvailableLocalModels() {
    try {
      const response = await fetch(`${this.host}/api/tags`);
      if (response.ok) {
        const data = await response.json();
        const models = (data.models || []).map(m => m.name);
        if (models.length > 0) return models;
      }
    } catch (_) {}
    return [this.modelName];
  }

  async callOllamaAPI(prompt) {
    const url = `${this.host}/api/generate`;
    const startTime = Date.now();

    const installedModels = await this.getAvailableLocalModels();
    const activeModel = installedModels.includes(this.modelName) ? this.modelName : installedModels[0];

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: activeModel, prompt, stream: false }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API returned HTTP ${response.status}`);
      }

      const data = await response.json();
      const responseText = data.response || '';
      const latencyMs = Date.now() - startTime;

      await this.tracer.traceLLMCall(`Ollama_${activeModel}`, prompt, responseText, latencyMs, { inputTokens: 220, outputTokens: 110 });

      return responseText;
    } catch (err) {
      console.log(`  ⚠️ [Ollama Node Warning]: Could not connect to local Ollama (${this.host}). ${err.message}`);
      return null;
    }
  }

  async generateStrategyCandidates(count = 1) {
    const installedModels = await this.getAvailableLocalModels();
    const activeModel = installedModels.includes(this.modelName) ? this.modelName : installedModels[0];

    console.log(`[Ollama Quant Researcher] 🦙 Querying local Ollama model [${activeModel}] at ${this.host}...`);
    const strategies = [];

    for (let i = 0; i < count; i++) {
      try {
        const prompt = `
You are an expert Chief Quantitative Researcher for an AI prediction market hedge fund.
Write a valid JavaScript function body (no function header, just the inner body lines) that takes (record, covMatrix) as inputs and returns:
  { vote: 'BUY_YES' | 'BUY_NO' | 'SKIP', confidence: float (0.5–0.95), estimatedProb: float (0.0–1.0) }

Available fields on 'record':
  record.spotProbs[0]  – YES implied probability (0.0–1.0)
  record.newsSentiment – News sentiment score    (0.0–1.0)
  record.whaleFlow     – Institutional USDC net volume (0–100)
  record.category      – Market category ('crypto', 'politics', 'economics', 'miscellaneous')

Combine at least TWO features in your alpha logic.
Never return BUY_YES/BUY_NO when spotProbs[0] is between 0.45 and 0.55.
Return ONLY executable JavaScript code inside a \`\`\`javascript ... \`\`\` block.
        `;

        let text = await this.callOllamaAPI(prompt);

        if (!text) {
          console.log(`  💡 [Ollama Fallback] Generating rule-based strategy candidate ${i + 1}...`);
          const cats = ['crypto', 'politics', 'economics', 'miscellaneous'];
          const targetCategory = cats[i % cats.length];
          const minWhale = 10 + (i * 7) % 30;
          const minSent  = (0.55 + (i * 0.04) % 0.25).toFixed(2);
          const pThresh  = (0.60 + (i * 0.05) % 0.25).toFixed(2);
          text = `
const yesProb = record.spotProbs[0];
const sentiment = record.newsSentiment || 0.5;
const whale = record.whaleFlow || 0;
const cat = record.category || '';
if (cat === '${targetCategory}' && whale >= ${minWhale} && sentiment >= ${minSent} && yesProb < 0.55) {
  return { vote: 'BUY_YES', confidence: 0.82, estimatedProb: Math.min(0.90, yesProb + 0.18) };
}
if (yesProb > ${pThresh} && sentiment < 0.38) {
  return { vote: 'BUY_NO', confidence: 0.80, estimatedProb: Math.max(0.10, yesProb - 0.22) };
}
return { vote: 'SKIP' };
          `.trim();
        }

        const codeMatch = text.match(/```(?:javascript|js)?([\s\S]*?)```/) || [null, text];
        const codeBody = codeMatch[1] ? codeMatch[1].trim() : text.trim();

        const stratId = `Ollama_Alpha_${Date.now()}_${i + 1}`;
        const compiledFn = new Function('record', 'covMatrix', codeBody);

        console.log(`  ✅ [Ollama ${activeModel}] Compiled strategy:\n--- CODE ---\n${codeBody.slice(0, 300)}\n------------`);

        strategies.push({
          name: stratId,
          code: codeBody,
          fn: compiledFn,
        });

      } catch (err) {
        console.error(`  ❌ [Ollama Node Error]: ${err.message || err}`);
      }
    }

    return strategies;
  }
}
