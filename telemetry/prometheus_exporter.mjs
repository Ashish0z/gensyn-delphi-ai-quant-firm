import http from 'http';

/**
 * PROMETHEUS & GRAFANA SYSTEM METRICS EXPORTER
 * Exposes Prometheus-formatted metrics at http://localhost:9090/metrics for Grafana ingestion.
 */
export class PrometheusExporter {
  constructor(port = 9090) {
    this.port = port;
    this.metrics = {
      delphi_active_positions_count: 8,
      delphi_wallet_usdc_balance: 276.17,
      delphi_llm_calls_total: 142,
      delphi_circuit_breaker_status: 1, // 1 = active, 0 = normal
      delphi_ewma_max_zscore: 1.84,
      delphi_rpc_latency_ms: 363,
    };
    this.startServer();
  }

  updateMetric(key, value) {
    this.metrics[key] = value;
  }

  generatePrometheusFormat() {
    let output = `# HELP delphi_wallet_usdc_balance Liquid wallet balance in USDC\n`;
    output += `# TYPE delphi_wallet_usdc_balance gauge\n`;
    output += `delphi_wallet_usdc_balance ${this.metrics.delphi_wallet_usdc_balance}\n\n`;

    output += `# HELP delphi_active_positions_count Count of open active prediction market positions\n`;
    output += `# TYPE delphi_active_positions_count gauge\n`;
    output += `delphi_active_positions_count ${this.metrics.delphi_active_positions_count}\n\n`;

    output += `# HELP delphi_llm_calls_total Total LLM API calls executed\n`;
    output += `# TYPE delphi_llm_calls_total counter\n`;
    output += `delphi_llm_calls_total ${this.metrics.delphi_llm_calls_total}\n\n`;

    output += `# HELP delphi_circuit_breaker_status Circuit breaker stop loss status (1=active, 0=normal)\n`;
    output += `# TYPE delphi_circuit_breaker_status gauge\n`;
    output += `delphi_circuit_breaker_status ${this.metrics.delphi_circuit_breaker_status}\n\n`;

    output += `# HELP delphi_rpc_latency_ms RPC node latency in milliseconds\n`;
    output += `# TYPE delphi_rpc_latency_ms gauge\n`;
    output += `delphi_rpc_latency_ms ${this.metrics.delphi_rpc_latency_ms}\n\n`;

    return output;
  }

  startServer() {
    const server = http.createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(this.generatePrometheusFormat());
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(this.port, () => {
      console.log(`📊 [Prometheus Exporter] Exposing metrics at http://localhost:${this.port}/metrics`);
    });
  }

  getGrafanaDashboardLink() {
    return `http://localhost:3000/d/gensyn-quant-firm/gensyn-delphi-ai-quant-firm-dashboard`;
  }
}
