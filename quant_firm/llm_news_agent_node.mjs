import 'dotenv/config';

/**
 * LLM NEWS & SENTIMENT REASONING AGENT NODE
 * Powered by Google Gemini API (gemini-2.0-flash) with GCP project header support.
 * Semantically evaluates live prediction market headlines and reasons about outcome probability shifts.
 */
export class LLMNewsAgentNode {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.projectNum = process.env.GEMINI_PROJECT_NUMBER || '576882714676';
  }

  async analyzeHeadlineWithLLM(headline, marketQuestion) {
    if (!this.apiKey) return { sentimentScore: 0.5, impact: 'NEUTRAL' };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`;
    const prompt = `
      You are an expert Intelligence & Geopolitical News Analysis AI Agent for a prediction market fund.
      Analyze this news headline relative to the target market question:
      - Headline: "${headline}"
      - Market Question: "${marketQuestion}"

      Evaluate semantic impact and probability direction. Return JSON format strictly:
      {
        "sentimentScore": float (0.0 to 1.0, where 1.0 means strongly YES),
        "impact": "HIGH_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "HIGH_BEARISH",
        "reasoning": "brief 1-sentence explanation"
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
      console.log(`[LLM News Agent] API Warning: ${err.message}. Using baseline sentiment.`);
    }

    return { sentimentScore: 0.5, impact: 'NEUTRAL', reasoning: 'Fallback baseline' };
  }
}
