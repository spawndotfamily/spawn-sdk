/** Browser-only admission transport. Account proof is verified on the creator's server. */
export type SpawnMultiplayerOptions = {
    platformOrigin: string;
    serverOrigin: string;
    /** Trusted same-server resource routing refresh; never player or payment proof. */
    onResourcePath?: (path: string) => void;
};
export type SpawnMultiplayerClient = {
    ready(): Promise<void>;
    requestGrant(): Promise<{
        ticket: string;
    }>;
    /** Presentation acknowledgement only. This never authorizes admission, gameplay or rewards. */
    requestMatchEntry(input: { matchId: string }): Promise<{
        matchId: string;
        status: 'reserved' | 'cancelled';
    }>;
    /** Presentation only. Never authorizes a player, action or reward. */
    reportConnection(state: 'connecting' | 'ready' | 'disconnected'): boolean;
    dispose(): void;
};
type ActiveClient = {
    platformOrigin: string;
    serverOrigin: string;
    client: SpawnMultiplayerClient;
};
const clients = new WeakMap<Window, ActiveClient>(), closedDocuments = new WeakSet<Window>();
const DURATION = 8000, LOAD_DURATION = 45000, MATCH_ENTRY_DURATION = 120000, PREFIX = 'spawn:multiplayer-';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function trustedOrigin(value: string) {
    let url: URL;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('An exact trusted origin is required.');
    }
    if (url.origin !== value || url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        throw new Error('Use an exact HTTPS origin, or literal loopback HTTP for local development.');
    return url.origin;
}
function validPort(value: unknown): value is MessagePort { return object(value) && ['postMessage', 'start', 'close'].every(key => typeof value[key] === 'function'); }
export function createSpawnMultiplayerClient(options: SpawnMultiplayerOptions): SpawnMultiplayerClient {
    const platformOrigin = trustedOrigin(options.platformOrigin), serverOrigin = trustedOrigin(options.serverOrigin);
    if (platformOrigin === serverOrigin)
        throw new Error('The game server requires a separate origin from Spawn.');
    if (typeof window === 'undefined' || window.parent === window)
        throw new Error('A Spawn-launched game iframe is required.');
    const w = window;
    if (closedDocuments.has(w))
        throw new Error('This Spawn document is closed. Launch the game again.');
    const prior = clients.get(w);
    if (prior) {
        if (prior.platformOrigin === platformOrigin && prior.serverOrigin === serverOrigin)
            return prior.client;
        throw new Error('A different Spawn client is already connected.');
    }
    const fragment = new URLSearchParams(w.location.hash.slice(1)), documentToken = fragment.get('spawnBridge');
    if (fragment.size !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(documentToken || ''))
        throw new Error('A valid Spawn document capability is required.');
    const nonce = crypto.randomUUID();
    let port: MessagePort | null = null, confirmed = false, closed = false;
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void readyPromise.catch(() => { });
    let readyTimer: ReturnType<typeof setInterval> | undefined, handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: {
        id: string;
        promise: Promise<{
            ticket: string;
        }>;
        resolve: (value: {
            ticket: string;
        }) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    } | null = null;
    let pendingMatchEntry: {
        id: string;
        matchId: string;
        promise: Promise<{ matchId: string; status: 'reserved' | 'cancelled' }>;
        resolve: (value: { matchId: string; status: 'reserved' | 'cancelled' }) => void;
        reject: (error: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
    } | null = null;
    function dispose() {
        if (closed)
            return;
        closed = true;
        clearInterval(readyTimer);
        clearTimeout(handshakeTimer);
        w.removeEventListener('message', offer);
        w.removeEventListener('pagehide', dispose);
        w.removeEventListener('load', loaded);
        if (port) {
            port.onmessage = null;
            port.onmessageerror = null;
            port.close();
        }
        clients.delete(w);
        closedDocuments.add(w);
        const error = new Error('The Spawn launch closed. Launch the game again.');
        readyReject(error);
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            pending = null;
        }
        if (pendingMatchEntry) {
            clearTimeout(pendingMatchEntry.timer);
            pendingMatchEntry.reject(new Error('The Spawn launch closed; match entry status is unknown.'));
            pendingMatchEntry = null;
        }
    }
    function post(value: Record<string, unknown>) { try {
        port?.postMessage({ ...value, version: 1, nonce });
    }
    catch {
        dispose();
    } }
    function receive(event: MessageEvent) {
        const value: unknown = event.data;
        if (closed || !object(value) || value.version !== 1 || value.nonce !== nonce)
            return;
        if (!confirmed) {
            if (value.type !== PREFIX + 'confirm' || !exact(value, ['type', 'version', 'nonce']))
                return;
            confirmed = true;
            w.removeEventListener('load', loaded);
            clearTimeout(handshakeTimer);
            readyResolve();
            return;
        }
        if (pendingMatchEntry && value.requestId === pendingMatchEntry.id && value.matchId === pendingMatchEntry.matchId) {
            const request = pendingMatchEntry;
            const result = value.type === PREFIX + 'payment-result' && exact(value, ['type', 'version', 'nonce', 'requestId', 'matchId', 'status']);
            const failed = value.type === PREFIX + 'payment-error' && exact(value, ['type', 'version', 'nonce', 'requestId', 'matchId', 'message']);
            if (!result && !failed)
                return;
            if (failed && (typeof value.message !== 'string' || value.message.length > 160))
                return;
            if (result && value.status !== 'reserved' && value.status !== 'cancelled')
                return;
            pendingMatchEntry = null;
            clearTimeout(request.timer);
            if (result)
                request.resolve({ matchId: request.matchId, status: value.status as 'reserved' | 'cancelled' });
            else
                request.reject(new Error('Spawn could not complete this match entry request.'));
            return;
        }
        if (!pending || value.requestId !== pending.id)
            return;
        if (value.type === PREFIX + 'resource' && exact(value, ['type', 'version', 'nonce', 'requestId', 'path'])) {
            if (typeof value.path === 'string' && value.path.length <= 1024 && /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)*$/.test(value.path))
                options.onResourcePath?.(value.path);
            return;
        }
        const good = value.type === PREFIX + 'grant' && exact(value, ['type', 'version', 'nonce', 'requestId', 'ticket', 'serverOrigin']);
        const failed = value.type === PREFIX + 'grant-error' && exact(value, ['type', 'version', 'nonce', 'requestId', 'message']);
        if (!good && !failed)
            return;
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        if (good && value.serverOrigin === serverOrigin && typeof value.ticket === 'string' && value.ticket.length > 0 && value.ticket.length <= 4096)
            request.resolve({ ticket: value.ticket });
        else
            request.reject(new Error(failed ? 'Spawn could not verify this launch. Please reopen the game.' : 'Spawn returned an invalid game connection.'));
    }
    function offer(event: MessageEvent) {
        const value: unknown = event.data;
        if (closed || port || event.source !== w.parent || event.origin !== platformOrigin || !object(value) || !exact(value, ['type', 'version', 'nonce']) || value.type !== PREFIX + 'offer' || value.version !== 1 || value.nonce !== nonce || event.ports?.length !== 1 || !validPort(event.ports[0]))
            return;
        port = event.ports[0];
        loaded();
        clearInterval(readyTimer);
        port.onmessage = receive;
        port.onmessageerror = dispose;
        port.start();
        post({ type: PREFIX + 'ack' });
    }
    async function requestGrant(): Promise<{
        ticket: string;
    }> {
        await readyPromise;
        if (closed || !confirmed)
            throw new Error('The Spawn launch is closed.');
        if (pending)
            return pending.promise;
        const id = crypto.randomUUID();
        let resolve!: (value: {
            ticket: string;
        }) => void, reject!: (error: Error) => void;
        const promise = new Promise<{
            ticket: string;
        }>((yes, no) => { resolve = yes; reject = no; });
        const timer = setTimeout(() => { if (pending?.id !== id)
            return; pending = null; reject(new Error('Spawn did not respond. Please try again.')); }, DURATION);
        pending = { id, promise, resolve, reject, timer };
        post({ type: PREFIX + 'grant-request', requestId: id });
        return promise;
    }
    function requestMatchEntry({ matchId }: { matchId: string }): Promise<{ matchId: string; status: 'reserved' | 'cancelled' }> {
        if (!uuid(matchId))
            return Promise.reject(new Error('A valid match ID is required.'));
        if (pendingMatchEntry) {
            if (pendingMatchEntry.matchId === matchId)
                return pendingMatchEntry.promise;
            return Promise.reject(new Error('A match entry request is already pending.'));
        }
        const id = crypto.randomUUID();
        let resolve!: (value: { matchId: string; status: 'reserved' | 'cancelled' }) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<{ matchId: string; status: 'reserved' | 'cancelled' }>((yes, no) => { resolve = yes; reject = no; });
        const request = { id, matchId, promise, resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined };
        pendingMatchEntry = request;
        void readyPromise.then(() => {
            if (closed || pendingMatchEntry !== request)
                return;
            if (!confirmed || !port) {
                pendingMatchEntry = null;
                request.reject(new Error('The Spawn launch is closed.'));
                return;
            }
            request.timer = setTimeout(() => {
                if (pendingMatchEntry !== request)
                    return;
                pendingMatchEntry = null;
                request.reject(new Error('Spawn did not respond; match entry status is unknown.'));
            }, MATCH_ENTRY_DURATION);
            post({ type: PREFIX + 'payment-request', requestId: id, matchId });
        }).catch((error: unknown) => {
            if (pendingMatchEntry !== request)
                return;
            pendingMatchEntry = null;
            request.reject(error instanceof Error ? error : new Error('The Spawn launch is closed.'));
        });
        return promise;
    }
    function loaded() {
        w.removeEventListener('load', loaded);
        if (closed || confirmed) return;
        clearTimeout(handshakeTimer);
        handshakeTimer = setTimeout(dispose, DURATION);
    }
    let lastReported: string | null = null;
    function reportConnection(state: 'connecting' | 'ready' | 'disconnected'): boolean {
        if (closed || !confirmed || !port || !['connecting', 'ready', 'disconnected'].includes(state) || lastReported === state) return false;
        lastReported = state;
        post({ type: PREFIX + 'connection-state', state });
        return !closed;
    }
    const client = { ready: () => readyPromise, requestGrant, requestMatchEntry, reportConnection, dispose };
    clients.set(w, { platformOrigin, serverOrigin, client });
    w.addEventListener('message', offer);
    w.addEventListener('pagehide', dispose, { once: true });
    const ready = () => { try {
        w.parent.postMessage({ type: PREFIX + 'ready', version: 1, nonce, documentToken }, platformOrigin);
    }
    catch {
        dispose();
    } };
    readyTimer = setInterval(ready, 1000);
    if (w.document && w.document.readyState !== 'complete') {
        w.addEventListener('load', loaded, { once: true });
        handshakeTimer = setTimeout(dispose, LOAD_DURATION);
    } else loaded();
    ready();
    return client;
}
