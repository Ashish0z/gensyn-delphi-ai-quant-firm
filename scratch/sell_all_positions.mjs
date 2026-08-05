import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('====================================================');
  console.log(' 💰 LIQUIDATING ALL ACTIVE POSITIONS & COMPUTING PNL');
  console.log('====================================================\n');

  const client = new DelphiClient();
  const walletAddress = '0xd3F62e6c71e815E37e8Aa8E91e0E7Dc297857c37';

  // 1. Initial Balances
  const { balance: initialRawUsdc } = await client.getErc20BalanceWithDecimals();
  const initialUsdc = Number(initialRawUsdc) / 1e6;
  const initialEth = Number(await client.getEthBalance()) / 1e18;

  console.log(`[Initial Balance] USDC: ${initialUsdc.toFixed(4)} | ETH (Gas): ${initialEth.toFixed(6)}`);

  // 2. Fetch Open Positions
  const { positions } = await client.listPositions({ wallet: walletAddress, redeemedOrLiquidated: false, limit: 100 });
  const activePositions = (positions || []).filter(p => BigInt(p.shares) > 0n);

  console.log(`[Active Positions Found]: ${activePositions.length}\n`);

  let grossTokensQuoted = 0;
  let grossTokensRecovered = 0;
  let soldCount = 0;
  let failedCount = 0;
  const salesLog = [];

  for (const pos of activePositions) {
    const marketAddress = pos.marketProxy;
    const outcomeIdx = Number(pos.outcomeIdx);
    const sharesIn = BigInt(pos.shares);
    const sharesHuman = Number(sharesIn) / 1e18;

    console.log(`🔍 Processing Market [${marketAddress.slice(0, 10)}...] Outcome #${outcomeIdx} | Shares: ${sharesHuman.toFixed(4)}`);

    try {
      // Quote sell
      const { tokensOut } = await client.quoteSell({ marketAddress, outcomeIdx, sharesIn });
      const quotedUsdc = Number(tokensOut) / 1e6;
      grossTokensQuoted += quotedUsdc;

      console.log(`  • Quoted Payout: ${quotedUsdc.toFixed(4)} USDC`);

      // Sell with 5% slippage tolerance
      const minTokensOut = (tokensOut * 95n) / 100n;
      const sellTx = await client.sellShares({ marketAddress, outcomeIdx, sharesIn, minTokensOut });
      
      console.log(`  ✅ [Sold Successfully] Tx: ${sellTx.transactionHash}`);
      grossTokensRecovered += quotedUsdc;
      soldCount++;

      salesLog.push({
        market: marketAddress,
        outcomeIdx,
        shares: sharesHuman,
        quotedUsdc,
        txHash: sellTx.transactionHash,
        status: 'SOLD'
      });

    } catch (err) {
      console.log(`  ⚠️ Could not sell (Trying redeem/liquidate): ${err.message.slice(0, 80)}`);
      
      // Try redeem if settled
      try {
        const redeemRes = await client.redeemMarket({ marketAddress });
        console.log(`  ✅ [Redeemed Settled Market] Tx: ${redeemRes.transactionHash}`);
        const redeemedUsdc = Number(redeemRes.tokensOut || 0n) / 1e6;
        grossTokensRecovered += redeemedUsdc;
        soldCount++;
        salesLog.push({ market: marketAddress, outcomeIdx, shares: sharesHuman, quotedUsdc: redeemedUsdc, txHash: redeemRes.transactionHash, status: 'REDEEMED' });
      } catch (rErr) {
        // Try liquidate if expired
        try {
          const liqRes = await client.liquidate({ marketAddress, outcomeIndices: [outcomeIdx] });
          console.log(`  ✅ [Liquidated Expired Market] Tx: ${liqRes.transactionHash}`);
          const liqUsdc = Number(liqRes.totalTokensOut || 0n) / 1e6;
          grossTokensRecovered += liqUsdc;
          soldCount++;
          salesLog.push({ market: marketAddress, outcomeIdx, shares: sharesHuman, quotedUsdc: liqUsdc, txHash: liqRes.transactionHash, status: 'LIQUIDATED' });
        } catch (lErr) {
          console.log(`  ❌ Exhausted all sell/redeem/liquidate options: ${lErr.message.slice(0, 80)}`);
          failedCount++;
          salesLog.push({ market: marketAddress, outcomeIdx, shares: sharesHuman, quotedUsdc: 0, status: 'FAILED', error: lErr.message.slice(0, 80) });
        }
      }
    }
  }

  // 3. Final Balances
  const { balance: finalRawUsdc } = await client.getErc20BalanceWithDecimals();
  const finalUsdc = Number(finalRawUsdc) / 1e6;
  const finalEth = Number(await client.getEthBalance()) / 1e18;

  const actualBalanceDelta = finalUsdc - initialUsdc;
  const ethSpentGas = initialEth - finalEth;
  const estimatedGasCostUsdc = ethSpentGas * 2500;
  const estimatedSlippageCostUsdc = Math.max(0, grossTokensQuoted - grossTokensRecovered);

  console.log('\n====================================================');
  console.log(' 📊 LIQUIDATION & PNL SUMMARY REPORT');
  console.log('====================================================');
  console.log(`Initial USDC Balance:       ${initialUsdc.toFixed(4)} USDC`);
  console.log(`Final USDC Balance:         ${finalUsdc.toFixed(4)} USDC`);
  console.log(`Net Wallet USDC Delta:      ${actualBalanceDelta >= 0 ? '+' : ''}${actualBalanceDelta.toFixed(4)} USDC`);
  console.log(`Total Positions Processed:  ${activePositions.length} (${soldCount} Exited, ${failedCount} Failed)`);
  console.log(`Gross Revenue Recovered:    ${grossTokensRecovered.toFixed(4)} USDC`);
  console.log(`ETH Gas Spent:              ${ethSpentGas.toFixed(6)} ETH (~$${estimatedGasCostUsdc.toFixed(4)} USD)`);
  console.log(`Slippage & Protocol Fees:   ${estimatedSlippageCostUsdc.toFixed(4)} USDC`);
  console.log(`Net Realized PnL:           ${actualBalanceDelta.toFixed(4)} USDC`);
  console.log('====================================================\n');

  // Save JSON report
  const pnlReport = {
    timestamp: new Date().toISOString(),
    walletAddress,
    initialUsdc,
    finalUsdc,
    actualBalanceDelta,
    ethSpentGas,
    estimatedGasCostUsdc,
    estimatedSlippageCostUsdc,
    grossTokensQuoted,
    grossTokensRecovered,
    positionsProcessed: activePositions.length,
    soldCount,
    failedCount,
    salesLog,
  };

  fs.writeFileSync(path.join(process.cwd(), '.pnl_report.json'), JSON.stringify(pnlReport, null, 2));
  console.log('✅ PnL report written to .pnl_report.json');
}

main().catch(console.error);
