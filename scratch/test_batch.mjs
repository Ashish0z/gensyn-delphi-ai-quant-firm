import 'dotenv/config';
import '../quant_firm/llm_strategy_generator_real.mjs';
import { RealLLMStrategyGeneratorNode } from '../quant_firm/llm_strategy_generator_real.mjs';

const gen = new RealLLMStrategyGeneratorNode();
console.log('Requesting batch of 2...');
const strategies = await gen.generateBatch(2);
console.log('\nGot', strategies.length, 'strategies:');
strategies.forEach((s, i) => {
  console.log(`\n--- Strategy ${i+1}: ${s.name} ---`);
  console.log(s.code.slice(0, 300));
});
