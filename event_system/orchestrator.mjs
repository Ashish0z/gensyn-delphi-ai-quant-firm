import 'dotenv/config';
import { globalBus } from './event_bus.mjs';
import { startSignalBufferNode } from './signal_buffer_node.mjs';
import { startExecutorNode } from './executor_node.mjs';
import { fork } from 'child_process';
import path from 'path';

/**
 * MASTER MULTI-PROCESS ORCHESTRATOR
 * Spawns continuous, decoupled subagents running as independent OS worker processes:
 * 1. News & Sentiment Streamer Subagent
 * 2. Adversarial & Subgraph Whale Watcher Subagent
 * 3. RL Swarm Meta-Learner & Validator Subagent
 * 4. Signal Accumulator Buffer & Execution Gateway
 * 5. Real Gemini LLM Strategy Generator & Quant Firm Microservice
 */
async function launchDistributedAgentSystem() {
  console.log('================================================================');
  console.log('  DISTRIBUTED MULTI-AGENT SUBAGENT MICROSERVICES CLUSTER  ');
  console.log('================================================================\n');

  // 1. In-Memory Signal Accumulator & Sequential Executor Gateways
  startSignalBufferNode(globalBus);
  startExecutorNode(globalBus);

  // 2. Fork Continuous News & Sentiment Streamer Subagent
  const newsNodePath = path.join(process.cwd(), 'event_system', 'news_sentiment_node.mjs');
  console.log(`[Orchestrator] Spawning Continuous News & Sentiment Subagent (PID)...`);
  const newsProcess = fork(newsNodePath);
  newsProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  // 3. Fork Continuous Subgraph Whale Watcher Subagent
  const watcherNodePath = path.join(process.cwd(), 'event_system', 'adversarial_watcher_node.mjs');
  console.log(`[Orchestrator] Spawning Continuous Subgraph Whale Watcher Subagent (PID)...`);
  const watcherProcess = fork(watcherNodePath);
  watcherProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  // 4. Fork Continuous RL Swarm Meta-Learner Subagent
  const rlNodePath = path.join(process.cwd(), 'event_system', 'rl_validator_node.mjs');
  console.log(`[Orchestrator] Spawning Continuous RL Swarm Meta-Learner Subagent (PID)...`);
  const rlProcess = fork(rlNodePath);
  rlProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  // 5. Fork Continuous AI Quant Firm & Gemini LLM Researcher Subagent
  const quantFirmPath = path.join(process.cwd(), 'quant_firm', 'ai_quant_firm_daemon.mjs');
  console.log(`[Orchestrator] Spawning Continuous AI Quant Firm & Gemini LLM Researcher Subagent (PID)...`);
  const quantProcess = fork(quantFirmPath);
  quantProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  console.log('\n✅ ALL CONTINUOUS SUBAGENT WORKERS LIVE & FEEDING REAL-TIME SIGNALS!\n');
}

launchDistributedAgentSystem();
