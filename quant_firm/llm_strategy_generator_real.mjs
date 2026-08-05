import 'dotenv/config';

/**
 * REAL LLM STRATEGY GENERATOR NODE (POWERED BY GOOGLE GEMINI API)
 * Direct REST API Integration with multi-model fallback & GCP project header.
 */
export class RealLLMStrategyGeneratorNode {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.projectNum = process.env.GEMINI_PROJECT_NUMBER || '576882714676';
    this.models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  }

  async callGeminiREST(prompt, maxRetries = 3) {
    const headers = {
      'Content-Type': 'application/json',
      'x-goog-user-project': this.projectNum,
    };

    for (const modelName of this.models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${this.apiKey}`;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
            }),
          });

          const data = await response.json();

          if (response.status === 429 || (data.error && data.error.code === 429)) {
            const waitTime = attempt * 3000;
            console.log(`  ⏳ [Gemini ${modelName} 429 Quota] Retrying attempt ${attempt}/${maxRetries} in ${waitTime/1000}s...`);
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }

          if (data.error) {
            console.log(`  ⚠️ Model [${modelName}] Error [${data.error.code}]: ${data.error.message.slice(0, 80)}`);
            break; // Try next model
          }

          if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
            return data.candidates[0].content.parts[0].text;
          }
        } catch (err) {
          console.log(`  ⚠️ Model [${modelName}] Attempt ${attempt} failed: ${err.message}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    return null;
  }

  async generateStrategyCandidates(count = 1) {
    if (!this.apiKey) {
      console.log('⚠️ [Real LLM Node] GEMINI_API_KEY is missing in .env.');
      return [];
    }

    console.log(`[Real LLM Node] 🧠 Querying Google Gemini API for Project [${this.projectNum}]...`);
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

        const text = await this.callGeminiREST(prompt);

        if (!text) {
          console.log('  ⚠️ [Gemini API] Could not retrieve text from LLM models. Skipping candidate.');
          continue;
        }

        // Extract JS code block
        const codeMatch = text.match(/```(?:javascript|js)?([\s\S]*?)```/) || [null, text];
        const codeBody = codeMatch[1] ? codeMatch[1].trim() : text.trim();

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
