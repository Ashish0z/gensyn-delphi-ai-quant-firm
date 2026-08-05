import 'dotenv/config';

/**
 * STRATEGY & CONSENSUS ENGINE NODE
 * Process: Event-driven subscriber process.
 * Function: Subscribes to NEWS_SIGNAL, WHALE_ALERT, and STRATEGY_WEIGHTS_UPDATED.
 * Dynamically adjusts strategy weights from RL Validator Node online!
 */
export function startConsensusNode(eventBus) {
  console.log('[Node: Consensus Engine] ⚖️ Started Strategy & Consensus Engine Node...');

  // Dynamic RL Policy Weights & Thresholds (tuned by RL Validator)
  let policyWeights = {
    Momentum_Strategist: 0.33,
    Fundamental_Analyst: 0.34,
    Contrarian_Strategist: 0.33,
  };
  let minEdgeThreshold = 0.08;

  // Subscribe to RL Policy Updates from RL Validator Node
  eventBus.on('STRATEGY_WEIGHTS_UPDATED', (payload) => {
    if (payload && payload.weights) {
      policyWeights = payload.weights;
      if (payload.thresholds && payload.thresholds.minEdge) {
        minEdgeThreshold = payload.thresholds.minEdge;
      }
      console.log(`[Node: Consensus Engine] 🔄 RL Strategy Weights Updated (Iter #${payload.iteration}):`);
      console.log(`   Weights: Momentum ${(policyWeights.Momentum_Strategist*100).toFixed(1)}% | Fundamental ${(policyWeights.Fundamental_Analyst*100).toFixed(1)}% | Contrarian ${(policyWeights.Contrarian_Strategist*100).toFixed(1)}%`);
      console.log(`   Dynamic Min Edge Bar: ${(minEdgeThreshold*100).toFixed(1)}%`);
    }
  });

  // Subscribe to High-Frequency News Signals
  eventBus.on('NEWS_SIGNAL', (payload) => {
    console.log(`[Node: Consensus Engine] 📩 Received NEWS_SIGNAL for "${payload.question.slice(0, 30)}..."`);
    
    const edge = payload.estimatedTrueProb - payload.currentMarketProb;
    const absEdge = Math.abs(edge);

    console.log(`   • Estimated Prob: ${(payload.estimatedTrueProb*100).toFixed(1)}% | Market: ${(payload.currentMarketProb*100).toFixed(1)}% | Edge: ${(edge*100).toFixed(1)}%`);

    // Check RL-tuned dynamic min edge threshold
    if (absEdge >= minEdgeThreshold) {
      const targetOutcomeIdx = edge > 0 ? 0 : 1;
      const targetLabel = edge > 0 ? 'YES' : 'NO';
      const sharesToBuy = 2;

      console.log(`   ✅ Edge ${(absEdge*100).toFixed(1)}% >= RL Bar ${(minEdgeThreshold*100).toFixed(1)}%! Emitting EXECUTE_TRADE_SIGNAL...`);

      eventBus.publish('EXECUTE_TRADE_SIGNAL', {
        marketAddress: payload.marketAddress,
        question: payload.question,
        outcomeIdx: targetOutcomeIdx,
        outcomeLabel: targetLabel,
        sharesNum: sharesToBuy,
        edge: edge,
        confidence: payload.sentimentScore,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log(`   🛑 Edge ${(absEdge*100).toFixed(1)}% below RL Bar ${(minEdgeThreshold*100).toFixed(1)}%. No trade emitted.`);
    }
  });

  eventBus.on('WHALE_ALERT', (payload) => {
    console.log(`[Node: Consensus Engine] 🐋 Received WHALE_ALERT for ${payload.marketAddress} (${payload.amountUsdc} USDC)`);
  });
}
