import 'dotenv/config';
import fs from 'fs';
import path from 'path';

/**
 * LANGFUSE LLM TELEMETRY & TRACING ENGINE
 * Sends real LLM prompt traces, latency, and token consumption to Langfuse Cloud
 * and persists live traces to .llm_traces.json for real-time Web UI dashboard streaming.
 */
export class LangfuseTracer {
  constructor() {
    this.publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    this.secretKey = process.env.LANGFUSE_SECRET_KEY;
    this.host = process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';
    this.tracesFile = path.join(process.cwd(), '.llm_traces.json');
    this.traces = this.loadTracesFromDisk();
  }

  loadTracesFromDisk() {
    if (fs.existsSync(this.tracesFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.tracesFile, 'utf8'));
      } catch (_) {}
    }
    return [];
  }

  saveTracesToDisk() {
    try {
      fs.writeFileSync(this.tracesFile, JSON.stringify(this.traces.slice(-50), null, 2));
    } catch (_) {}
  }

  async traceLLMCall(modelName, prompt, responseText, latencyMs, tokens = { inputTokens: 150, outputTokens: 80 }) {
    const traceId = `trace_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    const trace = {
      id: traceId,
      name: `LLM_Quant_Generation_${modelName}`,
      timestamp: new Date().toISOString(),
      model: modelName,
      input: prompt,
      output: responseText || '',
      latencyMs,
      tokens,
      status: responseText ? 'SUCCESS' : 'ERROR',
    };

    this.traces.unshift(trace);
    if (this.traces.length > 50) this.traces.pop();
    this.saveTracesToDisk();

    console.log(`📊 [Langfuse Telemetry] Tracing LLM call to [${modelName}] | Latency: ${latencyMs}ms | Tokens: ${tokens.inputTokens + tokens.outputTokens}`);

    // If Langfuse keys are configured, send live ingestion event to Langfuse Cloud
    if (this.publicKey && this.secretKey) {
      try {
        const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString('base64');
        const response = await fetch(`${this.host}/api/public/ingestion`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${auth}`,
          },
          body: JSON.stringify({
            batch: [
              {
                id: `evt_${Date.now()}`,
                type: 'trace-create',
                timestamp: new Date().toISOString(),
                body: {
                  id: traceId,
                  name: `LLM_Quant_Generation_${modelName}`,
                  input: { prompt: prompt.slice(0, 500) },
                  output: { response: (responseText || '').slice(0, 500) },
                  metadata: { model: modelName, latencyMs, tokens },
                },
              },
            ],
          }),
        });

        if (response.ok) {
          console.log(`  ✅ [Langfuse Cloud] Ingested trace [${traceId}] to Langfuse project successfully.`);
        }
      } catch (err) {
        console.log(`  ⚠️ [Langfuse Cloud Ingestion Error]: ${err.message}`);
      }
    }

    return trace;
  }

  getRecentTraces() {
    return this.traces;
  }
}
