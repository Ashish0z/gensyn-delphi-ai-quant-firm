import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const WALLET = '0xd3F62e6c71e815E37e8Aa8E91e0E7Dc297857c37';

async function sellAll() {
  const client = new DelphiClient();

  const { balance: rawBefore } = await client.getErc20BalanceWithDecimals();
  const balBefore = (Number(rawBefore) / 1e6).toFixed(2);
  console.log(`\n💰 Balance BEFORE: ${balBefore} USDC`);

  const { positions } = await client.listPositions({ wallet: WALLET, redeemedOrLiquidated: false });
  const open = (positions || []).filter(p => BigInt(p.shares) > 0n);
  console.log(`📦 Open positions: ${open.length}\n`);

  if (open.length === 0) { console.log('Nothing to sell.'); return; }

  let soldCount = 0, failCount = 0;

  for (const pos of open) {
    const shares = BigInt(pos.shares);
    const mkt = pos.marketProxy;
    const idx = Number(pos.outcomeIdx);
    try {
      const { tokensOut } = await client.quoteSell({ marketAddress: mkt, outcomeIdx: idx, sharesIn: shares });
      const minTokensOut = (tokensOut * 98n) / 100n;
      const tx = await client.sellShares({ marketAddress: mkt, outcomeIdx: idx, sharesIn: shares, minTokensOut });
      const usdcOut = (Number(tokensOut) / 1e6).toFixed(2);
      const txHash = tx?.transactionHash || tx?.hash || JSON.stringify(tx);
      console.log(`✅ SOLD ${mkt} idx=${idx} | ${usdcOut} USDC | TX: ${txHash}`);
      soldCount++;
    } catch (err) {
      console.error(`❌ FAIL ${mkt} idx=${idx}: ${err.message}`);
      failCount++;
    }
  }

  const { balance: rawAfter } = await client.getErc20BalanceWithDecimals();
  const balAfter = (Number(rawAfter) / 1e6).toFixed(2);

  console.log(`\n════════════════════════════════════`);
  console.log(`  SELL ALL COMPLETE`);
  console.log(`  Before:  ${balBefore} USDC`);
  console.log(`  After:   ${balAfter} USDC`);
  console.log(`  Delta:   +${(parseFloat(balAfter) - parseFloat(balBefore)).toFixed(2)} USDC`);
  console.log(`  Sold:    ${soldCount} | Failed: ${failCount}`);
  console.log(`════════════════════════════════════\n`);
}

sellAll().catch(e => console.error('Fatal:', e));
