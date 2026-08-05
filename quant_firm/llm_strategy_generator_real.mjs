import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * REAL LLM STRATEGY GENERATOR NODE (POWERED BY GOOGLE GEMINI API)
 * Features:
 * - Real API integration via @google/generative-ai (model: gemini-2.0-flash)
 * - Automatic 429 Rate-Limit Retry with exponential backoff
 * - Dynamic JavaScript function compilation via new Function()
 */
export class RealLLMStrategyGeneratorNode {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (this.apiKey) {
      this.genAI = new GoogleGenerativeAI(this.apiKey);
      this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    }
  }

  async callGeminiWithRetry(prompt, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        if (err.status === 429 && attempt < maxRetries) {
          const waitTime = attempt * 5000;
          console.log(`  ⏳ [Gemini API 429 Rate Limit] Retrying attempt ${attempt}/${maxRetries} in ${waitTime/1000}s...`);
          await new Promise(r => setTimeout(r, waitTime));
        } else {
          throw err;
        }
      }
    }
  }

  async generateStrategyCandidates(count = 1) {
    if (!this.apiKey) {
      console.log('⚠️ [Real LLM Node] GEMINI_API_KEY is missing in .env.');
      return [];
    }

    console.log(`[Real LLM Node] 🧠 Querying Google Gemini API (gemini-2.0-flash) for ${count} dynamic strategy code candidate(s)...`);
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

        const text = await this.callGeminiWithRetry(prompt);

        // Extract JS code block
        const codeMatch = text.match(/```(?:javascript|js)?([\s\S]*?)```/) || [null, text];
        const codeBody = codeMatch[1].trim();

        const stratId = `Gemini_LLM_Alpha_${Date.now()}_${i+1}`;
        const compiledFn = new Function('record', 'covMatrix', codeBody);

        console.log(`  ✅ [Gemini API Live Response] Successfully generated & compiled dynamic code:\n--- LIVE LLM CODE ---\n${codeBody}\n---------------------`);

        strategies.push({
          name: stratId,
          hypothesis: `Real Gemini LLM Strategy #${i+1}`,
          code: codeBody,
          fn: compiledFn,
        });

      } catch (err) {
        console.error(`  ❌ [Gemini API Call Status]: ${err.message || err}`);
      }
    }

    return strategies;
  }
}
