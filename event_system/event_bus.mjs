import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

/**
 * Shared Local IPC / File-backed Event Bus for Decoupled Multi-Agent Nodes
 */
export class DistributedEventBus extends EventEmitter {
  constructor(channel = 'delphi_events') {
    super();
    this.channel = channel;
    this.logFile = path.join(process.cwd(), '.event_bus_log.jsonl');
  }

  publish(eventType, payload) {
    const event = {
      timestamp: new Date().toISOString(),
      type: eventType,
      payload,
    };
    
    // Log event to shared log file
    fs.appendFileSync(this.logFile, JSON.stringify(event) + '\n');
    
    // Emit in process
    this.emit(eventType, payload);
    this.emit('*', event);
  }
}

export const globalBus = new DistributedEventBus();
