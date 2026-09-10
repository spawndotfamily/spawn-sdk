import { LocalTestState, type LocalQuote } from './state.ts';
import { createCreatorPanel } from './panel.ts';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const player = { value: 'alice' };
const playerButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-player]'));
const status = element<HTMLOutputElement>('status');
const dialog = element<HTMLDialogElement>('payment');
const confirm = element<HTMLButtonElement>('confirm'), cancel = element<HTMLButtonElement>('cancel'), next = element<HTMLButtonElement>('continue');
let state = new LocalTestState(), dispose: (() => void) | undefined;
let payment: { quote: LocalQuote; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
const panel = createCreatorPanel(() => state, () => player.value);
function refresh() { panel.refresh(); }
function closePayment() {
  if (payment) { state.cancel(payment.quote.id); payment.reject(new Error('Local payment cancelled.')); }
  payment = null; dialog.close();
}
function requestPayment(launch: string, product: string) {
  if (payment) throw new Error('A payment confirmation is already open.');
  const quote = state.quote(player.value, launch, product);
  if (quote.receipt) return Promise.resolve(quote.receipt);
  return new Promise((resolve, reject) => {
    payment = { quote, resolve, reject };
    element('payment-title').textContent = 'Confirm test payment'; element('payment-title').className = '';
    element('payment-copy').textContent = 'Pay 10 TEST to this local test game?';
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
      state.confirm(current.quote.id); refresh();
      element('payment-title').textContent = 'Paid'; element('payment-title').className = 'paid';
      element('payment-copy').textContent = '10 TEST sent to the local test game.';
      confirm.hidden = cancel.hidden = true; next.hidden = false; next.focus();
    } catch (error) { current.reject(error instanceof Error ? error : new Error('Local payment failed.')); payment = null; dialog.close(); }
  }));
};
next.onclick = () => {
  if (!payment) return;
  const current = payment; payment = null; dialog.close(); current.resolve(state.confirm(current.quote.id));
};
function openGame() {
  dispose?.(); closePayment(); refresh();
  const token = document.body.dataset.documentToken!;
  const launch = crypto.randomUUID(), identity = player.value;
  const frame = document.createElement('iframe');
  frame.title = 'Local test game'; frame.sandbox.add('allow-scripts', 'allow-pointer-lock'); frame.allow = 'autoplay; fullscreen; gamepad'; frame.referrerPolicy = 'no-referrer';
  let active = true, connected = false, ready = false, loads = 0, nonce = '', requests = 0;
  let port: MessagePort | null = null;
  const queued: unknown[] = [], pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = setInterval(() => { requests = 0; }, 60000);
  const stop = () => { active = false; clearTimeout(timer); clearInterval(reset); port?.close(); window.removeEventListener('message', receive); closePayment(); status.textContent = 'Disconnected. Reopen the game to reconnect.'; };
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
        if (!ready && nonce && data.nonce === nonce && data.version === 1 && loads === 1) { ready = true; clearTimeout(timer); for (const request of queued.splice(0)) void dispatch(request); }
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
element('reopen').onclick = openGame;
element('disconnect').onclick = () => dispose?.();
element('reset').onclick = () => { dispose?.(); state = new LocalTestState(); panel.reset(); openGame(); };
for (const button of playerButtons) button.onclick = () => { player.value = button.dataset.player!; for (const item of playerButtons) item.setAttribute('aria-pressed', String(item === button)); openGame(); };
window.addEventListener('pagehide', () => dispose?.());
openGame();
