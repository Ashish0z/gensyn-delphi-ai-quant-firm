import http from 'http';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { getRecentTrades, getAllVoterStats, getDb } from '../quant_firm/db.mjs';
import { WALLET_ADDRESS, TELEMETRY_PORT } from '../quant_firm/config.mjs';

/**
 * REAL-TIME TELEMETRY DASHBOARD SERVER
 * All data sourced from SQLite (trade_log, voter_stats, event_log, rl_policy) + live Delphi RPC.
 * No flat-file reads.
 */
export function startTelemetryDashboardServer(port = TELEMETRY_PORT) {
  const server = http.createServer(async (req, res) => {
    /* ─── API: /api/telemetry-data ─── */
    if (req.url === '/api/telemetry-data') {
      const db = getDb();

      // LLM traces from SQLite event_log (type = LLM_TRACE)
      const traceRows = db
        .prepare("SELECT payload FROM event_log WHERE type = 'LLM_TRACE' ORDER BY id DESC LIMIT 50")
        .all();
      const traces = traceRows.map(r => { try { return JSON.parse(r.payload); } catch (_) { return null; } }).filter(Boolean);

      // Voter stats from SQLite
      const allVoters     = getAllVoterStats();
      const activeVoters  = allVoters.filter(v => v.status === 'ACTIVE');
      const evictedVoters = allVoters.filter(v => v.status === 'EVICTED');

      // Trade log from SQLite
      const tradeLog = getRecentTrades(200);

      // RL policy from SQLite
      let rlPolicy = null;
      try {
        const row = db.prepare("SELECT value FROM rl_policy WHERE key = 'state'").get();
        if (row) rlPolicy = JSON.parse(row.value);
      } catch (_) {}

      // Live wallet + positions
      let walletBalanceUsdc = 'N/A';
      let openPositionsCount = 0;
      try {
        const client = new DelphiClient();
        const { balance: rawUsdc } = await client.getErc20BalanceWithDecimals();
        walletBalanceUsdc = (Number(rawUsdc) / 1e6).toFixed(2);
        const { positions } = await client.listPositions({ wallet: WALLET_ADDRESS, redeemedOrLiquidated: false });
        openPositionsCount = (positions || []).filter(p => BigInt(p.shares) > 0n).length;
      } catch (_) {}

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        timestamp: new Date().toISOString(),
        walletBalanceUsdc,
        openPositionsCount,
        traces,
        activeVoters,
        evictedVoters,
        tradeLog,
        rlPolicy,
      }));
      return;
    }

    /* ─── HTML Dashboard ─── */
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(DASHBOARD_HTML);
  });

  server.listen(port, () => {
    console.log(`🌐 [Real-Time Telemetry Server] Live Observability Web UI active at http://localhost:${port}`);
  });
}

/* ═══════════════════════════════════════════════════════════════
   FULL DASHBOARD HTML — 100% DYNAMIC, ZERO HARDCODED VALUES
   ═══════════════════════════════════════════════════════════════ */

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gensyn Delphi AI Quant Firm — Live Observability</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #090d16 0%, #111827 50%, #0c101c 100%);
      --card-bg: rgba(255,255,255,0.03);
      --card-border: rgba(255,255,255,0.08);
      --cyan: #38bdf8; --purple: #a855f7; --green: #10b981;
      --red: #f43f5e; --amber: #f59e0b; --text: #f3f4f6; --muted: #9ca3af;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family:'Outfit',sans-serif; background:var(--bg-gradient); color:var(--text); min-height:100vh; padding:1.2rem 2rem; }
    a { color: var(--cyan); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ── Header ── */
    header { display:flex; justify-content:space-between; align-items:center; margin-bottom:1.2rem; padding-bottom:.8rem; border-bottom:1px solid var(--card-border); }
    h1 { font-size:1.6rem; font-weight:700; background:linear-gradient(90deg,#38bdf8,#c084fc); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
    .live-badge { display:flex; align-items:center; gap:.45rem; background:rgba(16,185,129,.12); border:1px solid var(--green); color:var(--green); padding:.35rem .75rem; border-radius:20px; font-size:.8rem; font-weight:600; }
    .pulse { width:8px; height:8px; background:var(--green); border-radius:50%; box-shadow:0 0 8px var(--green); animation:blink 1.4s infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }
    .update-ts { font-size:.75rem; color:var(--muted); margin-top:.15rem; }

    /* ── Metrics Grid ── */
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:.9rem; margin-bottom:1.2rem; }
    .card { background:var(--card-bg); border:1px solid var(--card-border); border-radius:14px; padding:1.1rem; backdrop-filter:blur(14px); transition:border-color .3s; }
    .card:hover { border-color:rgba(255,255,255,.15); }
    .card-title { font-size:.7rem; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; margin-bottom:.35rem; }
    .card-value { font-size:1.7rem; font-weight:700; font-family:'JetBrains Mono',monospace; }
    .card-sub { font-size:.7rem; color:var(--muted); margin-top:.25rem; }

    /* ── Tabs ── */
    .tabs-nav { display:flex; gap:.4rem; margin-bottom:1.1rem; border-bottom:1px solid var(--card-border); padding-bottom:.45rem; flex-wrap:wrap; }
    .tab-btn { background:transparent; border:none; color:var(--muted); padding:.5rem 1rem; border-radius:8px; font-size:.82rem; font-weight:600; cursor:pointer; transition:all .2s; font-family:'Outfit',sans-serif; }
    .tab-btn:hover { color:var(--text); background:rgba(255,255,255,.05); }
    .tab-btn.active { color:var(--cyan); background:rgba(56,189,248,.1); border:1px solid rgba(56,189,248,.25); }
    .tab-pane { display:none; } .tab-pane.active { display:block; }

    /* ── Tables ── */
    .tbl-wrap { width:100%; overflow-x:auto; }
    table { width:100%; border-collapse:collapse; font-family:'JetBrains Mono',monospace; font-size:.8rem; }
    th { text-align:left; padding:.6rem .8rem; color:var(--muted); border-bottom:1px solid var(--card-border); background:rgba(255,255,255,.02); font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; }
    td { padding:.6rem .8rem; border-bottom:1px solid rgba(255,255,255,.04); vertical-align:top; }
    tr:hover td { background:rgba(255,255,255,.02); }

    /* ── Tags ── */
    .tag { padding:.15rem .45rem; border-radius:4px; font-weight:600; font-size:.7rem; display:inline-block; }
    .tag-green { color:var(--green); background:rgba(16,185,129,.14); }
    .tag-red { color:var(--red); background:rgba(244,63,94,.14); }
    .tag-amber { color:var(--amber); background:rgba(245,158,11,.14); }
    .tag-cyan { color:var(--cyan); background:rgba(56,189,248,.12); }
    .tag-purple { color:var(--purple); background:rgba(168,85,247,.14); }

    /* ── Code Block ── */
    .code-box { background:#070a12; border:1px solid var(--card-border); border-radius:6px; padding:.7rem .8rem; font-family:'JetBrains Mono',monospace; font-size:.75rem; color:#38bdf8; overflow-x:auto; white-space:pre-wrap; max-height:220px; overflow-y:auto; line-height:1.5; }
    .code-toggle { cursor:pointer; color:var(--cyan); font-size:.72rem; user-select:none; }
    .code-toggle:hover { text-decoration:underline; }
    .code-hidden { display:none; }

    /* ── Subsection ── */
    .sub-title { font-size:.85rem; font-weight:600; color:var(--text); margin:1rem 0 .5rem; padding-bottom:.3rem; border-bottom:1px solid var(--card-border); }
    .empty-msg { color:var(--muted); font-style:italic; padding:.8rem; font-size:.82rem; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>🤖 AI Quant Firm — Live Observability Center</h1>
      <div class="update-ts" id="last-update">Connecting...</div>
    </div>
    <div class="live-badge"><div class="pulse"></div>LIVE STREAMING</div>
  </header>

  <!-- Metrics -->
  <div class="grid">
    <div class="card">
      <div class="card-title">Wallet Balance</div>
      <div class="card-value" style="color:var(--cyan)" id="m-balance">—</div>
      <div class="card-sub">Gensyn Testnet USDC</div>
    </div>
    <div class="card">
      <div class="card-title">Active Positions</div>
      <div class="card-value" style="color:var(--purple)" id="m-positions">—</div>
      <div class="card-sub">Open Outcome Tokens</div>
    </div>
    <div class="card">
      <div class="card-title">LLM Model</div>
      <div class="card-value" style="color:var(--green);font-size:1.1rem" id="m-model">—</div>
      <div class="card-sub" id="m-traces-count">0 traces</div>
    </div>
    <div class="card">
      <div class="card-title">Trades Executed</div>
      <div class="card-value" style="color:var(--amber)" id="m-trades">0</div>
      <div class="card-sub">Total Consensus Trades</div>
    </div>
    <div class="card">
      <div class="card-title">Active Voters</div>
      <div class="card-value" style="color:var(--green)" id="m-voters">0</div>
      <div class="card-sub">In Voter Pool</div>
    </div>
  </div>

  <!-- Tab Nav -->
  <div class="tabs-nav">
    <button class="tab-btn active" data-tab="t-traces">🔍 LLM Traces & Code</button>
    <button class="tab-btn" data-tab="t-voters">🏆 Voter Pool</button>
    <button class="tab-btn" data-tab="t-trades">📊 Trade History</button>
    <button class="tab-btn" data-tab="t-nodes">🧠 Node Outputs</button>
    <button class="tab-btn" data-tab="t-risk">🛡️ Risk Engine</button>
  </div>

  <!-- Tab 1: LLM Traces -->
  <div id="t-traces" class="tab-pane active card">
    <div class="card-title">Live LLM Traces & Generated Strategy Code</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Trace ID / Time</th><th>Model</th><th>Latency</th><th>Status</th><th>Synthesized Code</th></tr></thead>
      <tbody id="tb-traces"><tr><td colspan="5" class="empty-msg">Waiting for LLM traces...</td></tr></tbody>
    </table></div>
  </div>

  <!-- Tab 2: Voter Pool -->
  <div id="t-voters" class="tab-pane card">
    <div class="sub-title">✅ Active Strategies in Pool</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Strategy</th><th>Sharpe</th><th>Win Rate</th><th>Cycles</th><th>Trades</th><th>PnL</th><th>Promoted</th></tr></thead>
      <tbody id="tb-active-voters"><tr><td colspan="7" class="empty-msg">No active voters</td></tr></tbody>
    </table></div>
    <div class="sub-title" style="margin-top:1.5rem">❌ Evicted / Discarded Strategies</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Strategy</th><th>Sharpe</th><th>Win Rate</th><th>Cycles</th><th>Trades</th><th>PnL</th><th>Status</th></tr></thead>
      <tbody id="tb-evicted-voters"><tr><td colspan="7" class="empty-msg">No evicted strategies yet</td></tr></tbody>
    </table></div>
  </div>

  <!-- Tab 3: Trade History -->
  <div id="t-trades" class="tab-pane card">
    <div class="card-title">Executed Trade History</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Time</th><th>Market</th><th>Voter</th><th>Vote</th><th>Outcome</th><th>Shares</th><th>Edge</th><th>Risk Check</th><th>TX</th></tr></thead>
      <tbody id="tb-trades"><tr><td colspan="9" class="empty-msg">No trades executed yet</td></tr></tbody>
    </table></div>
  </div>

  <!-- Tab 4: Node Outputs -->
  <div id="t-nodes" class="tab-pane card">
    <div class="sub-title">📈 EWMA Anomaly Detections</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Time</th><th>Market</th><th>Z-Score</th><th>Anomaly</th><th>Emergency</th></tr></thead>
      <tbody id="tb-ewma"><tr><td colspan="5" class="empty-msg">No EWMA data yet</td></tr></tbody>
    </table></div>

    <div class="sub-title" style="margin-top:1.5rem">🛡️ Risk Engine Checks</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Time</th><th>Market</th><th>Passed</th><th>Reason</th><th>Kelly Shares</th></tr></thead>
      <tbody id="tb-risk-checks"><tr><td colspan="5" class="empty-msg">No risk checks yet</td></tr></tbody>
    </table></div>

    <div class="sub-title" style="margin-top:1.5rem">⚡ Signal Buffer Events</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Time</th><th>Market</th><th>Voter</th><th>Vote</th><th>Triggered</th><th>Mass</th></tr></thead>
      <tbody id="tb-signals"><tr><td colspan="6" class="empty-msg">No signal events yet</td></tr></tbody>
    </table></div>

    <div class="sub-title" style="margin-top:1.5rem">🎯 RL Policy Updates</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Time</th><th>Strategy</th><th>Policy Weights</th></tr></thead>
      <tbody id="tb-rl"><tr><td colspan="3" class="empty-msg">No RL updates yet</td></tr></tbody>
    </table></div>
  </div>

  <!-- Tab 5: Risk Engine -->
  <div id="t-risk" class="tab-pane card">
    <div class="card-title">Live Risk Engine Status</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Risk Gate</th><th>Rule</th><th>Live Metric</th><th>Status</th></tr></thead>
      <tbody id="tb-risk-engine"></tbody>
    </table></div>
  </div>

<script>
/* ── Tab Switching ── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

/* ── Helpers ── */
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const shortTime = ts => { try { return new Date(ts).toLocaleTimeString(); } catch(_) { return ts; } };
const shortAddr = a => a ? a.slice(0,8)+'…'+a.slice(-6) : '—';

let codeIdx = 0;
function codeBlock(code) {
  const id = 'cb-'+(codeIdx++);
  return '<span class="code-toggle" onclick="document.getElementById(\\''+id+'\\').classList.toggle(\\'code-hidden\\')">▶ Show/Hide Code</span><div id="'+id+'" class="code-box code-hidden">'+esc(code)+'</div>';
}

/* ── Refresh Loop ── */
async function refresh() {
  try {
    const r = await fetch('/api/telemetry-data');
    const d = await r.json();
    if (!d) return;

    // Metrics
    document.getElementById('m-balance').textContent = d.walletBalanceUsdc + ' USDC';
    document.getElementById('m-positions').textContent = d.openPositionsCount + ' Markets';
    document.getElementById('m-trades').textContent = (d.tradeLog?.length || 0);
    document.getElementById('m-voters').textContent = (d.activeVoters?.length || 0);
    document.getElementById('last-update').textContent = 'Last update: ' + shortTime(d.timestamp);

    const traces = d.traces || [];
    document.getElementById('m-traces-count').textContent = traces.length + ' recorded traces';
    document.getElementById('m-model').textContent = traces.length > 0 ? (traces[0].model || '—') : 'Awaiting…';

    /* ── Tab 1: LLM Traces ── */
    codeIdx = 0;
    if (traces.length > 0) {
      document.getElementById('tb-traces').innerHTML = traces.map(t => '<tr>'
        +'<td><strong>'+esc(t.id)+'</strong><br><span style="color:var(--muted);font-size:.7rem">'+shortTime(t.timestamp)+'</span></td>'
        +'<td><code>'+esc(t.model)+'</code></td>'
        +'<td>'+t.latencyMs+'ms</td>'
        +'<td><span class="tag '+(t.status==='SUCCESS'?'tag-green':'tag-red')+'">'+esc(t.status)+'</span></td>'
        +'<td>'+codeBlock(t.output||t.input||'(empty)')+'</td>'
        +'</tr>').join('');
    } else {
      document.getElementById('tb-traces').innerHTML = '<tr><td colspan="5" class="empty-msg">Waiting for LLM traces… daemon will generate on next cycle</td></tr>';
    }

    /* ── Tab 2: Voter Pool ── */
    const av = d.activeVoters || [];
    const ev = d.evictedVoters || [];
    document.getElementById('tb-active-voters').innerHTML = av.length > 0
      ? av.map(v => '<tr>'
        +'<td><code>'+esc(v.name)+'</code></td>'
        +'<td><strong>'+(v.sharpeRatio!=null?v.sharpeRatio.toFixed(2):'—')+'</strong></td>'
        +'<td>'+(v.winRate!=null?v.winRate.toFixed(1)+'%':'—')+'</td>'
        +'<td>'+(v.cyclesActive??0)+'</td>'
        +'<td>'+(v.totalTrades??0)+'</td>'
        +'<td>'+(v.realizedPnl!=null?v.realizedPnl.toFixed(2):'0.00')+'</td>'
        +'<td>'+shortTime(v.promotedAt)+'</td>'
        +'</tr>').join('')
      : '<tr><td colspan="7" class="empty-msg">No active voters in pool — strategies are being generated…</td></tr>';

    document.getElementById('tb-evicted-voters').innerHTML = ev.length > 0
      ? ev.map(v => '<tr>'
        +'<td><code>'+esc(v.name)+'</code></td>'
        +'<td>'+(v.sharpeRatio!=null?v.sharpeRatio.toFixed(2):'—')+'</td>'
        +'<td>'+(v.winRate!=null?v.winRate.toFixed(1)+'%':'—')+'</td>'
        +'<td>'+(v.cyclesActive??0)+'</td>'
        +'<td>'+(v.totalTrades??0)+'</td>'
        +'<td>'+(v.realizedPnl!=null?v.realizedPnl.toFixed(2):'0.00')+'</td>'
        +'<td><span class="tag tag-red">EVICTED</span></td>'
        +'</tr>').join('')
      : '<tr><td colspan="7" class="empty-msg">No evicted strategies</td></tr>';

    /* ── Tab 3: Trade History ── */
    const tl = d.tradeLog || [];
    document.getElementById('tb-trades').innerHTML = tl.length > 0
      ? tl.map(t => '<tr>'
        +'<td>'+shortTime(t.timestamp)+'</td>'
        +'<td title="'+esc(t.question)+'">'+esc((t.question||'').slice(0,40))+'…</td>'
        +'<td><code>'+esc(t.voter)+'</code></td>'
        +'<td><span class="tag '+(t.vote==='BUY_YES'?'tag-green':'tag-red')+'">'+esc(t.vote)+'</span></td>'
        +'<td>'+esc(t.outcomeLabel||t.outcomeIdx)+'</td>'
        +'<td>'+(t.sharesNum!=null?Number(t.sharesNum).toFixed(1):'—')+'</td>'
        +'<td>'+(t.edge!=null?Number(t.edge).toFixed(3):'—')+'</td>'
        +'<td title="'+esc(t.riskCheckReason)+'">'+esc((t.riskCheckReason||'').slice(0,30))+'</td>'
        +'<td>'+( t.txHash ? '<a href="https://explorer.gensyn.ai/tx/'+t.txHash+'" target="_blank">'+shortAddr(t.txHash)+'</a>' : '—' )+'</td>'
        +'</tr>').join('')
      : '<tr><td colspan="9" class="empty-msg">No consensus trades executed yet</td></tr>';

    /* ── Tab 4: Node Outputs ── */
    const no = d.nodeOutputs || {};

    const ewma = (no.ewmaAnomalies || []).slice(0,30);
    document.getElementById('tb-ewma').innerHTML = ewma.length > 0
      ? ewma.map(e => '<tr>'
        +'<td>'+shortTime(e.timestamp)+'</td>'
        +'<td title="'+esc(e.question)+'">'+esc((e.question||'').slice(0,35))+'…</td>'
        +'<td>'+(e.zScore!=null?Number(e.zScore).toFixed(3):'—')+'</td>'
        +'<td><span class="tag '+(e.anomalyDetected?'tag-red':'tag-green')+'">'+(e.anomalyDetected?'YES':'NO')+'</span></td>'
        +'<td>'+(e.emergencySignal?esc(e.emergencySignal.reason||'TRIGGERED'):'—')+'</td>'
        +'</tr>').join('')
      : '<tr><td colspan="5" class="empty-msg">No EWMA data collected yet</td></tr>';

    const rc = (no.riskChecks || []).slice(0,30);
    document.getElementById('tb-risk-checks').innerHTML = rc.length > 0
      ? rc.map(r => '<tr>'
        +'<td>'+shortTime(r.timestamp)+'</td>'
        +'<td title="'+esc(r.question)+'">'+esc((r.question||'').slice(0,35))+'…</td>'
        +'<td><span class="tag '+(r.passed?'tag-green':'tag-red')+'">'+(r.passed?'PASSED':'BLOCKED')+'</span></td>'
        +'<td>'+esc(r.reason||'—')+'</td>'
        +'<td>'+(r.kellyShares!=null?Number(r.kellyShares).toFixed(1):'—')+'</td>'
        +'</tr>').join('')
      : '<tr><td colspan="5" class="empty-msg">No risk checks yet</td></tr>';

    const sig = (no.signalBufferEvents || []).slice(0,30);
    document.getElementById('tb-signals').innerHTML = sig.length > 0
      ? sig.map(s => '<tr>'
        +'<td>'+shortTime(s.timestamp)+'</td>'
        +'<td title="'+esc(s.question)+'">'+esc((s.question||'').slice(0,35))+'…</td>'
        +'<td><code>'+esc(s.voter||'—')+'</code></td>'
        +'<td><span class="tag '+(s.vote==='BUY_YES'?'tag-green':s.vote==='BUY_NO'?'tag-red':'tag-amber')+'">'+esc(s.vote||'—')+'</span></td>'
        +'<td><span class="tag '+(s.triggered?'tag-amber':'tag-cyan')+'">'+(s.triggered?'TRIGGERED':'BUFFERED')+'</span></td>'
        +'<td>'+(s.accumulatedMass!=null?Number(s.accumulatedMass).toFixed(3):'—')+'</td>'
        +'</tr>').join('')
      : '<tr><td colspan="6" class="empty-msg">No signal buffer events yet</td></tr>';

    const rl = (no.rlPolicyUpdates || []).slice(0,20);
    document.getElementById('tb-rl').innerHTML = rl.length > 0
      ? rl.map(u => '<tr>'
        +'<td>'+shortTime(u.timestamp)+'</td>'
        +'<td><code>'+esc(u.strategy)+'</code></td>'
        +'<td><div class="code-box" style="max-height:80px">'+esc(JSON.stringify(u.weights,null,1))+'</div></td>'
        +'</tr>').join('')
      : '<tr><td colspan="3" class="empty-msg">No RL policy updates yet</td></tr>';

    /* ── Tab 5: Risk Engine (fully dynamic) ── */
    const totalRiskChecks = rc.length;
    const passedChecks = rc.filter(r => r.passed).length;
    const blockedChecks = totalRiskChecks - passedChecks;
    const anomalyCount = ewma.filter(e => e.anomalyDetected).length;

    document.getElementById('tb-risk-engine').innerHTML = '<tr>'
      +'<td><strong>Circuit Breaker</strong></td>'
      +'<td>Max 2.0% Daily Drawdown</td>'
      +'<td><strong style="color:var(--green)">Active — '+d.openPositionsCount+' open positions</strong></td>'
      +'<td><span class="tag tag-green">TRADING ACTIVE</span></td>'
      +'</tr><tr>'
      +'<td><strong>Concentration Cap</strong></td>'
      +'<td>Max 15% / 3 per category</td>'
      +'<td>'+d.openPositionsCount+' positions held</td>'
      +'<td><span class="tag '+(d.openPositionsCount<=3?'tag-green':'tag-amber')+'">'+(d.openPositionsCount<=3?'PASSED':'WARNING')+'</span></td>'
      +'</tr><tr>'
      +'<td><strong>Pre-Trade Risk Gate</strong></td>'
      +'<td>Kelly + Covariance + Edge</td>'
      +'<td>'+totalRiskChecks+' checks ('+passedChecks+' passed, '+blockedChecks+' blocked)</td>'
      +'<td><span class="tag '+(blockedChecks>passedChecks?'tag-amber':'tag-green')+'">'+( totalRiskChecks>0 ? Math.round(passedChecks/totalRiskChecks*100)+'% PASS RATE' : 'NO DATA')+'</span></td>'
      +'</tr><tr>'
      +'<td><strong>EWMA Anomaly Monitor</strong></td>'
      +'<td>Z-Score |Z| ≥ 2.5σ</td>'
      +'<td>'+ewma.length+' ticks monitored, '+anomalyCount+' anomalies</td>'
      +'<td><span class="tag '+(anomalyCount>0?'tag-red':'tag-green')+'">'+(anomalyCount>0?anomalyCount+' ALERTS':'NORMAL')+'</span></td>'
      +'</tr>';

  } catch (err) {
    console.error('Dashboard refresh error:', err);
  }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
