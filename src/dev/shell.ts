export function launcherHtml(token: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spawn · Local testing</title><link rel="stylesheet" href="/__spawn/style.css"></head>
<body data-document-token="${token}">
<header><strong>SPAWN <span>LOCAL TESTING</span></strong><div class="players" aria-label="Test player"><button data-player="alice" aria-pressed="true">Alice</button><button data-player="bob" aria-pressed="false">Bob</button><button data-player="empty" aria-pressed="false">Empty balance</button></div><button id="reopen">Rebuild / reload</button><button id="disconnect">Disconnect</button><button id="reset">Reset testing</button></header>
<div class="notice">Fake accounts, fake tokens. Nothing is sent to Spawn. Reloading clears this session. Test your private Spawn preview before publishing.</div>
<output id="spawn-dev-state" hidden aria-hidden="true"></output>
<main><section id="game" aria-label="Game preview"><div id="frame-slot"></div></section><aside>
<section class="panel-section"><p class="eyebrow">Player</p><h1 id="balance"></h1><p id="status" role="status">Waiting for the SDK…</p></section>
<section class="panel-section"><h2>Creator test panel</h2><div class="balances"><div><span>Game pool</span><strong id="pool-balance"></strong></div><div><span>Creator wallet</span><strong id="creator-balance"></strong></div><div><span>Spawn fees</span><strong id="platform-balance"></strong></div></div>
<label for="transfer-amount">Amount <span class="hint">TEST tokens</span></label><input id="transfer-amount" type="number" min="1" step="1" value="10" inputmode="numeric">
<div class="pool-actions"><button id="fund-pool">Top up pool</button><button id="withdraw-pool">Withdraw</button><button id="reward-player" class="primary">Reward Alice</button></div>
<p id="transfer-feedback" class="hint" role="status" aria-live="polite">Rewards go to the selected test player.</p></section>
<section class="panel-section"><h2>Submitted scores</h2><p class="hint">Unverified game results. Review manually; submitting a score never pays a reward.</p><p id="no-scores" class="empty">No scores yet.</p><ol id="scores"></ol></section>
<section class="panel-section"><h2>Transactions <span class="hint">Latest 12</span></h2><p id="no-transactions" class="empty">Confirm a payment in your game or try a pool transfer.</p><ol id="history" class="transactions"></ol></section>
</aside></main>
<dialog id="payment"><h2 id="payment-title">Confirm test payment</h2><p id="payment-copy">Pay 10 TEST to this local test game?</p><p class="hint">This is a simulation. No real tokens move.</p><div class="actions"><button id="cancel">Cancel</button><button id="confirm" class="primary">Confirm 10 TEST</button><button id="continue" class="primary" hidden>Continue to game</button></div></dialog>
<script type="module" src="/__spawn/host.js"></script></body></html>`;
}
