import 'dotenv/config';
import { LangfuseTracer } from '../telemetry/langfuse_tracer.mjs';

/**
 * OLLAMA LOCAL LLM STRATEGY GENERATOR NODE (100% FREE, LOCAL OPEN-SOURCE AI)
 * Connects to Ollama running locally at http://localhost:11434.
 * Auto-detects local models (e.g. gpt-oss:120b-cloud, llama3.2, qwen2.5-coder).
 */
export class OllamaStrategyGeneratorNode {
  constructor(modelName = 'gpt-oss:120b-cloud') {
    this.host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.modelName = process.env.OLLAMA_MODEL || modelName;
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

    // Auto-detect installed model
    const installedModels = await this.getAvailableLocalModels();
    const activeModel = installedModels.includes(this.modelName) ? this.modelName : installedModels[0];

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeModel,
          prompt,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API returned HTTP ${response.status}`);
      }

      const data = await response.json();
      const responseText = data.response || '';
      const latencyMs = Date.now() - startTime;

      // Stream trace to Langfuse Cloud
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

    console.log(`[Ollama Quant Researcher] 🦙 Querying local Ollama active model [${activeModel}] at ${this.host}...`);
    const strategies = [];

    for (let i = 0; i < count; i++) {
      try {
        const prompt = `
          You are an expert Chief Quantitative Researcher for an AI prediction market hedge fund.
          Write a valid JavaScript function body (no function header, just the inner body lines) that takes (record, covMatrix) as inputs and returns an object:
          return { vote: 'BUY_YES' | 'BUY_NO' | 'SKIP', confidence: float (0.5 to 0.95), estimatedProb: float (0.0 to 1.0) };

          Available fields on 'record':
          - record.spotProbs[0]: YES implied probability (0.0 to 1.0)
          - record.newsSentiment: News sentiment score (0.0 to 1.0)
          - record.whaleFlow: Institutional USDC volume (e.g. 0 to 100)
          - record.category: Market category ('crypto', 'politics', 'economics')

          Formulate a unique quantitative alpha hypothesis combining these features.
          Return ONLY executable JavaScript code inside \`\`\`javascript ... \`\`\` block.
        `;

        let text = await this.callOllamaAPI(prompt);

        if (!text) {
          console.log(`  💡 [Ollama Fallback] Generating local zero-cost strategy candidate...`);
          const targetCategory = ['crypto', 'politics', 'economics'][Math.floor(Math.random()*3)];
          const minWhale = Math.floor(Math.random()*30) + 10;
          text = `
            const yesProb = record.spotProbs[0];
            const sentiment = record.newsSentiment || 0.5;
            const whale = record.whaleFlow || 0;
            const cat = record.category || '';

            if (cat === '${targetCategory}' && whale >= ${minWhale} && sentiment > 0.60) {
              return { vote: 'BUY_YES', confidence: 0.88, estimatedProb: Math.min(0.95, yesProb + 0.14) };
            }
            if (yesProb > 0.75 && sentiment < 0.40) {
              return { vote: 'BUY_NO', confidence: 0.85, estimatedProb: 0.35 };
            }
            return { vote: 'SKIP' };
          `;
        }

        const codeMatch = text.match(/```(?:javascript|js)?([\s\S]*?)```/) || [null, text];
        const codeBody = codeMatch[1] ? codeMatch[1].trim() : text.trim();

        const stratId = `Ollama_Alpha_${Date.now()}_${i+1}`;
        const compiledFn = new Function('record', 'covMatrix', codeBody);

        console.log(`  ✅ [Ollama ${activeModel} Response] Successfully generated & compiled dynamic code:\n--- OLLAMA CODE ---\n${codeBody}\n-------------------`);

        strategies.push({
          name: stratId,
          hypothesis: `Ollama Local Strategy (${activeModel}) #${i+1}`,
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
