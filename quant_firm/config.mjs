/**
 * Centralised runtime configuration.
 * All env vars are read once here; the rest of the codebase imports from this module.
 *
 * Required:
 *   WALLET_ADDRESS       – your Gensyn L2 wallet address (0x...)
 *   WALLET_PRIVATE_KEY   – wallet private key (used by DelphiClient signer)
 *
 * Optional LLM (Ollama is primary; Gemini is used only for news/whale analysis):
 *   OLLAMA_HOST          – default http://localhost:11434
 *   OLLAMA_MODEL         – default llama3.2
 *   GEMINI_API_KEY       – enables Gemini-based news/whale reasoning agents
 *
 * Optional observability:
 *   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST
 *   REDIS_URL            – enables Redis pub/sub between processes
 *   PROMETHEUS_PORT      – default 9090
 *   TELEMETRY_PORT       – default 4000
 */
import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name, fallback = null) {
  return process.env[name] || fallback;
}

export const WALLET_ADDRESS     = required('WALLET_ADDRESS');
export const OLLAMA_HOST        = optional('OLLAMA_HOST',  'http://localhost:11434');
export const OLLAMA_MODEL       = optional('OLLAMA_MODEL', 'llama3.2');
export const GEMINI_API_KEY     = optional('GEMINI_API_KEY');
export const GEMINI_PROJECT_NUM = optional('GEMINI_PROJECT_NUMBER', '');
export const LANGFUSE_PUBLIC_KEY = optional('LANGFUSE_PUBLIC_KEY');
export const LANGFUSE_SECRET_KEY = optional('LANGFUSE_SECRET_KEY');
export const LANGFUSE_HOST       = optional('LANGFUSE_HOST', 'https://cloud.langfuse.com');
export const REDIS_URL           = optional('REDIS_URL');
export const PROMETHEUS_PORT     = parseInt(optional('PROMETHEUS_PORT', '9090'), 10);
export const TELEMETRY_PORT      = parseInt(optional('TELEMETRY_PORT', '4000'), 10);
export const DELPHI_NETWORK      = optional('DELPHI_NETWORK', 'testnet');
