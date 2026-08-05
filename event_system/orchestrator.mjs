import 'dotenv/config';
import { globalBus } from './event_bus.mjs';
import { startSignalBufferNode } from './signal_buffer_node.mjs';
import { startExecutorNode } from './executor_node.mjs';
import { fork } from 'child_process';
import path from 'path';

async function launchDistributedAgentSystem() {
  console.log('================================================================');
  console.log('  DISTRIBUTED SYSTEM WITH SIGNAL ACCUMULATOR BUFFER NODE  ');
  console.log('================================================================\n');

  // 1. Initialize Signal Accumulator Buffer & Executor Microservices
  startSignalBufferNode(globalBus);
  startExecutorNode(globalBus);

  // 2. Fork News & Sentiment Streaming Node
  const newsNodePath = path.join(process.cwd(), 'event_system', 'news_sentiment_node.mjs');
  console.log(`[Orchestrator] Spawning News & Sentiment Node process...`);
  const newsProcess = fork(newsNodePath);

  newsProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  // 3. Fork Adversarial & On-Chain Watcher Node
  const watcherNodePath = path.join(process.cwd(), 'event_system', 'adversarial_watcher_node.mjs');
  console.log(`[Orchestrator] Spawning Adversarial & Subgraph Watcher Node process...`);
  const watcherProcess = fork(watcherNodePath);

  watcherProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  // 4. Fork RL Meta-Learner Node
  const rlNodePath = path.join(process.cwd(), 'event_system', 'rl_validator_node.mjs');
  console.log(`[Orchestrator] Spawning RL Meta-Learner & System Validator Node process...`);
  const rlProcess = fork(rlNodePath);

  rlProcess.on('message', (msg) => {
    if (msg && msg.type) globalBus.publish(msg.type, msg.payload);
  });

  console.log('\n✅ ALL MICROSERVICES + SIGNAL ACCUMULATOR BUFFER ACTIVE!\n');
}

launchDistributedAgentSystem();
