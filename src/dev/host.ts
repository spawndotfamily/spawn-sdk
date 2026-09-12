import { LocalTestState, type LocalQuote } from './state.ts';
import { createCreatorPanel } from './panel.ts';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const player = { value: 'alice' };
const playerButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-player]'));
const status = element<HTMLOutputElement>('status');
const dialog = element<HTMLDialogElement>('payment');
const confirm = element<HTMLButtonElement>('confirm'), cancel = element<HTMLButtonElement>('cancel'), next = element<HTMLButtonElement>('continue');
let connectedState = false;
let receiptStatus: 'idle' | 'pending' | 'paid' | 'cancelled' | 'failed' = 'idle';
let lastReceipt: unknown = null;
let state = new LocalTestState(), dispose: (() => void) | undefined;
let payment: { quote: LocalQuote; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
const devSnapshot = () => structuredClone({
  environment: 'local-test', connected: connectedState, player: state.identity(player.value),
  lastScore: state.scores[0] ?? null, receiptStatus, lastReceipt,
  balances: { player: state.balance(player.value), pool: state.economy.balance('pool'), platform: state.economy.balance('platform') }
});
Object.defineProperty(window, '__SPAWN_DEV_STATE__', { get: devSnapshot });
const updateDiagnostics = () => { element('spawn-dev-state').textContent = JSON.stringify(devSnapshot()); };
const panel = createCreatorPanel(() => state, () => player.value, updateDiagnostics);
function refresh() { panel.refresh(); }
function closePayment() {
  if (payment) { if (receiptStatus !== 'paid') receiptStatus = 'cancelled'; state.cancel(payment.quote.id); payment.reject(new Error('Local payment cancelled.')); }
  payment = null; dialog.close(); refresh();
}
function requestPayment(launch: string, product: string) {
  if (payment) throw new Error('A payment confirmation is already open.');
  const quote = state.quote(player.value, launch, product);
  if (quote.receipt) return Promise.resolve(quote.receipt);
  return new Promise((resolve, reject) => {
    payment = { quote, resolve, reject }; receiptStatus = 'pending'; refresh();
    element('payment-title').textContent = 'Confirm test payment'; element('payment-title').className = '';
    element('payment-copy').textContent = 'Pay 10 TEST? The game pool receives 9.5 TEST; Spawn receives 0.5 TEST (5%, included).';
    confirm.hidden = cancel.hidden = false; next.hidden = true; confirm.disabled = false;
    document.exitPointerLock?.(); dialog.showModal();
  });
}
cancel.onclick = closePayment;
dialog.addEventListener('cancel', event => { event.preventDefault(); if (!next.hidden) return; closePayment(); });
confirm.onclick = () => {
  if (!payment) return;
  const current = payment;
  confirm.disabled = true;
  element('payment-copy').textContent = 'Processing local test payment…';
  // Let the processing state paint; there is no remote settlement in this launcher.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (payment !== current) return;
    try {
      lastReceipt = state.confirm(current.quote.id); receiptStatus = 'paid'; refresh();
      element('payment-title').textContent = 'Paid'; element('payment-title').className = 'paid';
      element('payment-copy').textContent = 'Paid 10 TEST: 9.5 to the game pool and 0.5 to Spawn.';
      confirm.hidden = cancel.hidden = true; next.hidden = false; next.focus();
    } catch (error) { receiptStatus = 'failed'; current.reject(error instanceof Error ? error : new Error('Local payment failed.')); payment = null; dialog.close(); refresh(); }
  }));
};
next.onclick = () => {
  if (!payment) return;
  const current = payment; payment = null; dialog.close(); refresh(); current.resolve(state.confirm(current.quote.id));
};
function openGame() {
  dispose?.(); closePayment(); receiptStatus = 'idle'; lastReceipt = null; refresh();
  const token = document.body.dataset.documentToken!;
  const launch = crypto.randomUUID(), identity = player.value;
  const frame = document.createElement('iframe');
  frame.title = 'Local test game'; frame.sandbox.add('allow-scripts', 'allow-pointer-lock'); frame.allow = 'autoplay; fullscreen; gamepad'; frame.referrerPolicy = 'no-referrer';
  let active = true, connected = false, ready = false, loads = 0, nonce = '', requests = 0;
  let port: MessagePort | null = null;
  const queued: unknown[] = [], pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = setInterval(() => { requests = 0; }, 60000);
  const stop = () => { connectedState = false; active = false; clearTimeout(timer); clearInterval(reset); port?.close(); window.removeEventListener('message', receive); closePayment(); status.textContent = 'Disconnected. Reopen the game to reconnect.'; refresh(); };
  async function dispatch(raw: unknown) {
    const data = raw as { type?: string; version?: number; id?: string; method?: string; payload?: Record<string, unknown> };
    if (!active || !ready || !data || data.type !== 'spawn:request' || data.version !== 1 || typeof data.id !== 'string' || data.id.length > 80 || pending.has(data.id)) return;
    const send = (ok: boolean, value: unknown) => { if (active) port?.postMessage({ type: 'spawn:response', version: 1, id: data.id, ok, ...(ok ? { value } : { error: value }) }); };
    if (++requests > 100 || pending.size >= 20) { send(false, 'Too many local test requests.'); return; }
    pending.add(data.id);
    try {
      const payload = data.payload ?? {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 16000) throw new Error('Invalid request payload.');
      let value: unknown;
      if (data.method === 'identity') { value = state.identity(identity); status.textContent = `Connected as ${state.identity(identity).displayName}`; }
      else if (data.method === 'load') value = state.load(identity, String(payload.key));
      else if (data.method === 'save') value = state.save(identity, String(payload.key), payload.value, payload.expectedVersion as number);
      else if (data.method === 'submitScore') { value = state.score(identity, payload.score as number, payload.details); refresh(); }
      else if (data.method === 'requestPayment') value = await requestPayment(launch, String(payload.productId));
      else throw new Error('Unsupported Spawn operation.');
      send(true, value);
    } catch (error) { send(false, error instanceof Error ? error.message : 'Local test request failed.'); }
    finally { pending.delete(data.id); }
  }
  const probe = () => { if (!active || !port || loads !== 1 || nonce || ready) return; nonce = crypto.randomUUID(); port.postMessage({ type: 'spawn:ready', version: 1, nonce }); timer = setTimeout(stop, 10000); };
  function receive(event: MessageEvent) {
    if (!active || connected || event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.type !== 'spawn:connect' || event.data?.version !== 1 || event.data?.documentToken !== token) return;
    connected = true; const channel = new MessageChannel(); port = channel.port1;
    port.onmessage = ({ data }) => {
      if (!active) return;
      if (data?.type === 'spawn:ready-ack') {
        if (!ready && nonce && data.nonce === nonce && data.version === 1 && loads === 1) { ready = true; connectedState = true; refresh(); clearTimeout(timer); for (const request of queued.splice(0)) void dispatch(request); }
      } else if (ready) void dispatch(data);
      else if (queued.length < 20) queued.push(data); else stop();
    };
    frame.contentWindow?.postMessage({ type: 'spawn:connected', version: 1 }, '*', [channel.port2]); probe();
  }
  window.addEventListener('message', receive);
  frame.onload = () => { if (++loads > 1) stop(); else probe(); };
  frame.src = `/build/${token}/index.html`;
  status.textContent = 'Waiting for the SDK…';
  element('frame-slot').replaceChildren(frame); dispose = stop;
}
element('reopen').onclick = async () => {
  const button = element<HTMLButtonElement>('reopen'); button.disabled = true;
  dispose?.(); status.textContent = 'Checking rebuilt files…';
  try {
    const response = await fetch('/__spawn/rescan', { method: 'POST' });
    if (!response.ok) throw new Error('Build not ready. Finish rebuilding and try again.');
    const value = await response.json() as { documentToken?: string };
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.documentToken ?? '')) throw new Error('Invalid rescan response.');
    document.body.dataset.documentToken = value.documentToken; openGame();
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Unable to rescan the build.'; }
  finally { button.disabled = false; }
};
element('disconnect').onclick = () => dispose?.();
element('reset').onclick = () => { dispose?.(); state = new LocalTestState(); receiptStatus = 'idle'; lastReceipt = null; panel.reset(); openGame(); };
for (const button of playerButtons) button.onclick = () => { player.value = button.dataset.player!; for (const item of playerButtons) item.setAttribute('aria-pressed', String(item === button)); openGame(); };
window.addEventListener('pagehide', () => dispose?.());
openGame();
