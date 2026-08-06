import http from 'http';
import { PROMETHEUS_PORT } from '../quant_firm/config.mjs';

/**
 * PROMETHEUS METRICS EXPORTER
 *
 * All metric values start at 0 and are updated by the daemon at runtime
 * via updateMetric(). No hardcoded values.
 *
 * Exposes Prometheus-formatted metrics at http://localhost:<port>/metrics.
 * Default port: 9090 (override with PROMETHEUS_PORT env var).
 */
export class PrometheusExporter {
  constructor(port = PROMETHEUS_PORT) {
    this.port = port;
    // All metrics initialised to 0 – updated by the daemon at runtime
    this.metrics = {
      delphi_active_positions_count: 0,
      delphi_wallet_usdc_balance:    0,
      delphi_llm_calls_total:        0,
      delphi_circuit_breaker_status: 0,
      delphi_ewma_max_zscore:        0,
      delphi_rpc_latency_ms:         0,
    };
    this._startServer();
  }

  updateMetric(key, value) {
    this.metrics[key] = value;
  }

  generatePrometheusFormat() {
    const defs = {
      delphi_wallet_usdc_balance:    ['gauge',   'Liquid wallet balance in USDC'],
      delphi_active_positions_count: ['gauge',   'Count of open active prediction market positions'],
      delphi_llm_calls_total:        ['counter', 'Total LLM API calls executed'],
      delphi_circuit_breaker_status: ['gauge',   'Circuit breaker stop-loss status (1=active, 0=normal)'],
      delphi_rpc_latency_ms:         ['gauge',   'Last RPC node round-trip latency in milliseconds'],
      delphi_ewma_max_zscore:        ['gauge',   'Latest absolute EWMA Z-score anomaly value'],
    };

    let output = '';
    for (const [key, [type, help]] of Object.entries(defs)) {
      output += `# HELP ${key} ${help}\n`;
      output += `# TYPE ${key} ${type}\n`;
      output += `${key} ${this.metrics[key] ?? 0}\n\n`;
    }
    return output;
  }

  _startServer() {
    const server = http.createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(this.generatePrometheusFormat());
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`⚠️  [Prometheus] Port ${this.port} already in use — metrics server skipped`);
      } else {
        console.error('[Prometheus] Server error:', err.message);
      }
    });
    server.listen(this.port, () => {
      console.log(`📊 [Prometheus] Metrics available at http://localhost:${this.port}/metrics`);
    });
  }
}
