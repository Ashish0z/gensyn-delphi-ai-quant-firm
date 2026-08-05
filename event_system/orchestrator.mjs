import 'dotenv/config';
import { globalBus } from './event_bus.mjs';
import { startSignalBufferNode } from './signal_buffer_node.mjs';
import { startExecutorNode } from './executor_node.mjs';
import { PrometheusExporter } from '../telemetry/prometheus_exporter.mjs';
import { startTelemetryDashboardServer } from '../telemetry/telemetry_dashboard_server.mjs';
import { fork } from 'child_process';
import path from 'path';

/**
 * MASTER MULTI-PROCESS ORCHESTRATOR WITH TELEMETRY & OBSERVABILITY
 */
async function launchDistributedAgentSystem() {
  console.log('================================================================');
  console.log('  DISTRIBUTED MULTI-AGENT CLUSTER WITH OBSERVABILITY & TELEMETRY ');
  console.log('================================================================\n');

  // 1. Initialize Prometheus Exporter (Port 9090) & Telemetry Web Dashboard (Port 4000)
  const promExporter = new PrometheusExporter(9090);
  startTelemetryDashboardServer(4000);

  // 2. In-Memory Signal Accumulator & Sequential Executor Gateways
  startSignalBufferNode(globalBus);
  startExecutorNode(globalBus);

  // 3. Fork Continuous News & Sentiment Streamer Subagent
  const newsNodePath = path.join(process.cwd(), 'event_system', 'news_sentiment_node.mjs');
  console.log(`[Orchestrator] Spawning Continuous News & Sentiment Subagent...`);
  const newsProcess = fork(newsNodePath);
  newsProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  // 4. Fork Continuous Subgraph Whale Watcher Subagent
  const watcherNodePath = path.join(process.cwd(), 'event_system', 'adversarial_watcher_node.mjs');
  console.log(`[Orchestrator] Spawning Continuous Subgraph Whale Watcher Subagent...`);
  const watcherProcess = fork(watcherNodePath);
  watcherProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  // 5. Fork Continuous RL Swarm Meta-Learner Subagent
  const rlNodePath = path.join(process.cwd(), 'event_system', 'rl_validator_node.mjs');
  console.log(`[Orchestrator] Spawning Continuous RL Swarm Meta-Learner Subagent...`);
  const rlProcess = fork(rlNodePath);
  rlProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  // 6. Fork Continuous AI Quant Firm & Gemini LLM Researcher Subagent
  const quantFirmPath = path.join(process.cwd(), 'quant_firm', 'ai_quant_firm_daemon.mjs');
  console.log(`[Orchestrator] Spawning Continuous AI Quant Firm & Gemini LLM Researcher Subagent...`);
  const quantProcess = fork(quantFirmPath);
  quantProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  console.log('\n✅ OBSERVABILITY & ALL TELEMETRY CLUSTER MICROSERVICES LIVE!\n');
}

launchDistributedAgentSystem();
