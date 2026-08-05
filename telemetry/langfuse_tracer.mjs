import { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } from '../quant_firm/config.mjs';
import { getDb } from '../quant_firm/db.mjs';

/**
 * LANGFUSE LLM TELEMETRY & TRACING ENGINE
 *
 * Persists LLM traces to the SQLite event_log table (type = 'LLM_TRACE') and
 * optionally forwards them to Langfuse Cloud when keys are configured.
 */
export class LangfuseTracer {
  async traceLLMCall(modelName, prompt, responseText, latencyMs, tokens = { inputTokens: 150, outputTokens: 80 }) {
    const traceId = `trace_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const trace = {
      id:        traceId,
      name:      `LLM_Quant_Generation_${modelName}`,
      timestamp: new Date().toISOString(),
      model:     modelName,
      input:     prompt,
      output:    responseText || '',
      latencyMs,
      tokens,
      status:    responseText ? 'SUCCESS' : 'ERROR',
    };

    // Persist to SQLite event_log
    try {
      getDb().prepare(
        "INSERT INTO event_log (timestamp, type, payload) VALUES (?, 'LLM_TRACE', ?)"
      ).run(trace.timestamp, JSON.stringify(trace));
    } catch (_) {}

    console.log(`📊 [Langfuse] LLM call [${modelName}] | Latency: ${latencyMs}ms | Tokens: ${(tokens.inputTokens || 0) + (tokens.outputTokens || 0)}`);

    // Forward to Langfuse Cloud if credentials are set
    if (LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY) {
      try {
        const auth = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');
        const response = await fetch(`${LANGFUSE_HOST}/api/public/ingestion`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
          body: JSON.stringify({
            batch: [{
              id:        `evt_${Date.now()}`,
              type:      'trace-create',
              timestamp: trace.timestamp,
              body: {
                id:       traceId,
                name:     trace.name,
                input:    { prompt: prompt.slice(0, 500) },
                output:   { response: (responseText || '').slice(0, 500) },
                metadata: { model: modelName, latencyMs, tokens },
              },
            }],
          }),
        });
        if (response.ok) console.log(`  ✅ [Langfuse Cloud] Trace [${traceId}] ingested.`);
      } catch (err) {
        console.log(`  ⚠️ [Langfuse Cloud] Ingestion failed: ${err.message}`);
      }
    }

    return trace;
  }

  getRecentTraces(limit = 50) {
    try {
      const rows = getDb()
        .prepare("SELECT payload FROM event_log WHERE type = 'LLM_TRACE' ORDER BY id DESC LIMIT ?")
        .all(limit);
      return rows.map(r => { try { return JSON.parse(r.payload); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) { return []; }
  }
}
