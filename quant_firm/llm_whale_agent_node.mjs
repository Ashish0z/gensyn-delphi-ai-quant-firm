import 'dotenv/config';

/**
 * LLM ON-CHAIN & WHALE REASONING AGENT NODE
 * Powered by Google Gemini API (gemini-2.0-flash) with GCP project header support.
 * Analyzes on-chain whale transactions, detects spoofing/manipulation, and outputs conviction alerts.
 */
export class LLMWhaleAgentNode {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.projectNum = process.env.GEMINI_PROJECT_NUMBER || '576882714676';
  }

  async evaluateWhaleTransactionWithLLM(txDetails) {
    if (!this.apiKey) return { convictionScore: 0.5, action: 'MONITOR' };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`;
    const prompt = `
      You are an expert On-Chain Forensic & Institutional Whale Analysis AI Agent.
      Evaluate this whale transaction in prediction market outcome pools:
      - Amount USDC: ${txDetails.amountUsdc}
      - Outcome Side: ${txDetails.outcomeLabel}
      - Market Question: "${txDetails.marketQuestion}"

      Detect spoofing, accumulation, or distribution tactics. Return JSON format strictly:
      {
        "convictionScore": float (0.0 to 1.0),
        "action": "FOLLOW_WHALE" | "FADE_MANIPULATION" | "MONITOR",
        "rationale": "brief 1-sentence explanation"
      }
    `;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-user-project': this.projectNum,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      });

      const data = await response.json();
      if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        const rawText = data.candidates[0].content.parts[0].text;
        const jsonMatch = rawText.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      }
    } catch (err) {
      console.log(`[LLM Whale Agent] API Warning: ${err.message}. Using default monitor state.`);
    }

    return { convictionScore: 0.5, action: 'MONITOR', rationale: 'Fallback baseline' };
  }
}
