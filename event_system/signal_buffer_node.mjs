import 'dotenv/config';

/**
 * SIGNAL ACCUMULATOR BUFFER & BATCH TRIGGER NODE
 * Architecture: Replaces artificial time cooldowns with a Signal Mass Accumulator.
 * Function: Buffers signals from News, Sentiment, and Subgraph Watcher nodes.
 * Flushes a single size-optimized batch order only when cumulative conviction mass crosses threshold.
 */
export class SignalAccumulatorBuffer {
  constructor(massThreshold = 0.35, minAgreeingSignals = 2) {
    this.massThreshold = massThreshold;
    this.minAgreeingSignals = minAgreeingSignals;
    this.buffers = new Map(); // marketAddress -> SignalVector[]
  }

  /**
   * Add signal to buffer & evaluate accumulation mass
   */
  addSignal(signal) {
    const marketAddress = signal.marketAddress;
    if (!this.buffers.has(marketAddress)) {
      this.buffers.set(marketAddress, []);
    }

    const buffer = this.buffers.get(marketAddress);
    buffer.push({
      ...signal,
      receivedAt: Date.now(),
    });

    return this.evaluateBuffer(marketAddress);
  }

  /**
   * Evaluate cumulative signal mass M_accumulated & direction agreement
   */
  evaluateBuffer(marketAddress) {
    const buffer = this.buffers.get(marketAddress) || [];
    if (buffer.length === 0) return null;

    let yesMass = 0;
    let noMass = 0;
    let yesCount = 0;
    let noCount = 0;

    for (const sig of buffer) {
      const edge = sig.estimatedTrueProb - sig.currentMarketProb;
      const confidence = sig.sentimentScore || 0.75;
      const signalMass = Math.abs(edge) * confidence;

      if (edge > 0) {
        yesMass += signalMass;
        yesCount++;
      } else {
        noMass += signalMass;
        noCount++;
      }
    }

    const dominantDirection = yesMass >= noMass ? 'YES' : 'NO';
    const dominantMass = Math.max(yesMass, noMass);
    const dominantCount = dominantDirection === 'YES' ? yesCount : noCount;

    // Check if accumulation threshold crossed
    if (dominantMass >= this.massThreshold && dominantCount >= this.minAgreeingSignals) {
      const sample = buffer[0];
      const outcomeIdx = dominantDirection === 'YES' ? 0 : 1;
      
      // Calculate single optimized batch size (e.g. 5 shares instead of fragmented 2-share buys)
      const batchShares = Math.min(10, Math.max(4, Math.round(dominantMass * 15)));

      // Flush buffer on trigger
      this.buffers.set(marketAddress, []);

      return {
        triggered: true,
        marketAddress,
        question: sample.question,
        outcomeIdx,
        outcomeLabel: dominantDirection,
        batchShares,
        accumulatedMass: dominantMass,
        agreeingSignalsCount: dominantCount,
      };
    }

    return {
      triggered: false,
      marketAddress,
      currentMass: dominantMass,
      bufferedCount: buffer.length,
    };
  }
}

export function startSignalBufferNode(eventBus) {
  console.log('[Node: Signal Buffer] 📥 Signal Accumulator Buffer & Batch Trigger Node online...');
  const accumulator = new SignalAccumulatorBuffer(0.35, 2);

  eventBus.on('NEWS_SIGNAL', (signal) => {
    console.log(`[Node: Signal Buffer] 📥 Buffering NEWS_SIGNAL for "${signal.question.slice(0, 30)}..."`);
    const evalRes = accumulator.addSignal(signal);

    if (evalRes && evalRes.triggered) {
      console.log(`\n💥 [SIGNAL BUFFER ACCUMULATION THRESHOLD CROSSED!]`);
      console.log(`   • Market: "${evalRes.question.slice(0, 40)}..."`);
      console.log(`   • Accumulated Mass: ${evalRes.accumulatedMass.toFixed(3)} (Threshold: 0.35)`);
      console.log(`   • Agreeing Signals: ${evalRes.agreeingSignalsCount}`);
      console.log(`   ⚡ Flushing Batch Trigger for ${evalRes.batchShares} ${evalRes.outcomeLabel} shares to Executor!\n`);

      eventBus.publish('EXECUTE_TRADE_SIGNAL', {
        marketAddress: evalRes.marketAddress,
        question: evalRes.question,
        outcomeIdx: evalRes.outcomeIdx,
        outcomeLabel: evalRes.outcomeLabel,
        sharesNum: evalRes.batchShares,
        edge: evalRes.accumulatedMass,
        confidence: 0.85,
        timestamp: new Date().toISOString(),
      });
    } else if (evalRes) {
      console.log(`   • Buffer Status: ${evalRes.bufferedCount} signals | Accumulated Mass: ${evalRes.currentMass.toFixed(3)} / 0.35 threshold`);
    }
  });
}
