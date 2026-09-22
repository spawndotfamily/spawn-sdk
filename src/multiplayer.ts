import { localBalanceOrigin, createTokenMethods, type SpawnTokens } from './token-balances.ts';
export type { SpawnTokens, SpawnTokenBalance, SpawnTokenBalances, SpawnBalancePlayer } from './token-balances.ts';
import { createTradeMethods, type SpawnTrades, type SpawnTradeAction } from './trades.ts';
export type { SpawnTrade, SpawnTrades } from './trades.ts';
import type { SpawnTokenPaymentOptions, SpawnTokenPaymentReceipt } from './index.ts';
export type { SpawnTokenPaymentOptions, SpawnTokenPaymentReceipt } from './index.ts';
import {
    validateSpawnTableBuyInResult,
    validateSpawnTablePlayerStatus,
} from './table-validation.ts';
export type {
    SpawnTableAsset,
    SpawnTableStatusName,
    SpawnTableSeat,
    SpawnTableHandPlayer,
    SpawnTablePot,
    SpawnTableHand,
    SpawnTableTotals,
    SpawnTableStatus,
    SpawnTableBuyInStatus,
    SpawnTableBuyInQuote,
    SpawnTableBuyInResult,
    SpawnTablePlayerBuyInQuote,
    SpawnTablePlayerStatus,
} from './table-types.ts';
export type SpawnMultiplayerTables = {
    buyIn(input: { tableId: string; buyInId: string }): Promise<import('./table-types.ts').SpawnTableBuyInResult>;
    status(tableId: string): Promise<import('./table-types.ts').SpawnTablePlayerStatus>;
    heartbeat(tableId: string): Promise<import('./table-types.ts').SpawnTablePlayerStatus>;
    leave(input: { tableId: string; operationId: string; seatId: string }): Promise<import('./table-types.ts').SpawnTablePlayerStatus>;
    watch(tableId: string): () => void;
};
/** Browser-only admission transport. Account proof is verified on the creator's server. */
export type SpawnMultiplayerOptions = {
    platformOrigin: string;
    serverOrigin: string;
    /** Trusted same-server resource routing refresh; never player or payment proof. */
    onResourcePath?: (path: string) => void;
};
export type SpawnMultiplayerClient = {
    trades: SpawnTrades;
    tokens: SpawnTokens;
    tables: SpawnMultiplayerTables;
    ready(): Promise<void>;
    requestGrant(): Promise<{
        ticket: string;
    }>;
    /** Presentation acknowledgement only. This never authorizes admission, gameplay or rewards. */
    requestMatchEntry(input: { matchId: string }): Promise<{
        matchId: string;
        status: 'reserved' | 'cancelled';
    }>;
    /** Opens Spawn's shared confirmation UI for an explicit optional Listing-token payment. */
    requestTokenPayment(options: SpawnTokenPaymentOptions): Promise<SpawnTokenPaymentReceipt>;
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
const DURATION = 8000, LOAD_DURATION = 45000, MATCH_ENTRY_DURATION = 120000, TOKEN_PAYMENT_DURATION = 300000, TABLE_HEARTBEAT_INTERVAL = 20000, TABLE_TIMEOUT = 15000, TABLE_BUYIN_TIMEOUT = 300000, PREFIX = 'spawn:multiplayer-';
const TOKEN_PAYMENT_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const TOKEN_PAYMENT_ITEM_MAX_LENGTH = 80;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const tableUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function validTokenPaymentReceipt(value: unknown, platformOrigin: string): value is SpawnTokenPaymentReceipt {
    if (!object(value) || !exact(value, ['id', 'assetId', 'amount', 'projectId', 'status'])) return false;
    if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128 || /[\u0000-\u001f\u007f]/.test(value.id)) return false;
    if (typeof value.assetId !== 'string' || !/^erc20:(?:46630|31337):0x[a-f0-9]{40}$/.test(value.assetId)) return false;
    if (value.assetId.startsWith('erc20:31337:')) {
        const hostname = new URL(platformOrigin).hostname.toLowerCase();
        if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return false;
    }
    if (typeof value.amount !== 'string' || !/^[1-9][0-9]*$/.test(value.amount) || value.amount.length > 78) return false;
    if (BigInt(value.amount) > (1n << 256n) - 1n) return false;
    return uuid(value.projectId) && value.status === 'paid';
}
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
    let pendingTokenPayment: {
        id: string;
        amount: string;
        item?: string;
        promise: Promise<SpawnTokenPaymentReceipt>;
        resolve: (value: SpawnTokenPaymentReceipt) => void;
        reject: (error: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
    } | null = null;
    const tradeRequests=new Map<string,{action:SpawnTradeAction;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
    const tableRequests = new Map<string, {
        method: 'tables.buyIn' | 'tables.status' | 'tables.heartbeat' | 'tables.leave';
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    const tableWatches = new Map<string, { timer: ReturnType<typeof setInterval>; inFlight: boolean }>();
    async function sendTrade(action:SpawnTradeAction,payload:Record<string,unknown>):Promise<unknown>{
        await readyPromise;
        if(closed||!confirmed)throw new Error('The Spawn launch is closed.');
        if(tradeRequests.size>=5)throw new Error('Too many pending trade requests.');
        return new Promise((resolve,reject)=>{
            const id=crypto.randomUUID();
            const timer=setTimeout(()=>{tradeRequests.delete(id);reject(new Error(action === 'balances' ? 'Token balance unavailable. Retry this read after reconnecting.' : 'Trade outcome is unknown. Query the same trade ID.'));},action==='accept'?300000:15000);
            tradeRequests.set(id,{action,resolve,reject,timer});
            post({type:PREFIX+'trade-request',requestId:id,action,payload});
        });
    }
    async function sendTable(method: 'tables.buyIn' | 'tables.status' | 'tables.heartbeat' | 'tables.leave', payload: Record<string, unknown>): Promise<unknown> {
        await readyPromise;
        if (closed || !confirmed) throw new Error('The Spawn launch is closed.');
        if (tableRequests.size >= 5) throw new Error('Too many pending table requests.');
        return new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
                tableRequests.delete(id);
                reject(new Error(method === 'tables.buyIn'
                    ? 'Spawn did not respond; table buy-in outcome is unknown.'
                    : 'Spawn did not respond; table status is unavailable.'));
            }, method === 'tables.buyIn' ? TABLE_BUYIN_TIMEOUT : TABLE_TIMEOUT);
            tableRequests.set(id, { method, resolve, reject, timer });
            post({ type: PREFIX + 'table-request', requestId: id, method, payload });
        });
    }
    function normalizeTableId(value: unknown): string {
        if (!tableUuid(value)) throw new Error('tableId must be a UUID.');
        return value.toLowerCase();
    }
    function normalizeOperationId(value: unknown): string {
        if (!tableUuid(value)) throw new Error('operationId must be a UUID.');
        return value.toLowerCase();
    }
    function normalizeSeatId(value: unknown): string {
        if (!tableUuid(value)) throw new Error('seatId must be a UUID.');
        return value.toLowerCase();
    }
    function stopTableWatch(tableId: string): void {
        const watch = tableWatches.get(tableId);
        if (!watch) return;
        clearInterval(watch.timer);
        tableWatches.delete(tableId);
    }
    function startTableWatch(tableId: string): () => void {
        stopTableWatch(tableId);
        const watch = { timer: undefined as unknown as ReturnType<typeof setInterval>, inFlight: false };
        const tick = () => {
            if (closed || watch.inFlight || tableWatches.get(tableId) !== watch) return;
            watch.inFlight = true;
            sendTable('tables.heartbeat', { tableId })
                .then((value) => validateSpawnTablePlayerStatus(value, tableId, platformOrigin))
                .catch(() => { if (tableWatches.get(tableId) === watch) stopTableWatch(tableId); })
                .finally(() => { watch.inFlight = false; });
        };
        watch.timer = setInterval(tick, TABLE_HEARTBEAT_INTERVAL);
        tableWatches.set(tableId, watch);
        tick();
        return () => stopTableWatch(tableId);
    }
    function dispose() {
        if (closed)
            return;
        closed = true;
        for(const t of tradeRequests.values()){clearTimeout(t.timer);t.reject(new Error(t.action === 'balances' ? 'Token balance unavailable. Reopen the game and retry this read.' : 'The launch closed. Trade outcome is unknown; query its status.'));}
        tradeRequests.clear();
        for (const watch of tableWatches.values()) clearInterval(watch.timer);
        tableWatches.clear();
        for (const request of tableRequests.values()) {
            clearTimeout(request.timer);
            request.reject(new Error(request.method === 'tables.buyIn'
                ? 'The Spawn launch closed; table buy-in outcome is unknown.'
                : 'The Spawn launch closed; table status is unavailable.'));
        }
        tableRequests.clear();
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
        if (pendingTokenPayment) {
            clearTimeout(pendingTokenPayment.timer);
            pendingTokenPayment.reject(new Error('The Spawn launch closed; token payment outcome is unknown.'));
            pendingTokenPayment = null;
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
        if(typeof value.requestId==='string'&&tradeRequests.has(value.requestId)){
            const result=value.type===PREFIX+'trade-result'&&exact(value,['type','version','nonce','requestId','value']);
            const error=value.type===PREFIX+'trade-error'&&exact(value,['type','version','nonce','requestId','message']);
            if(!result&&!error)return;
            const t=tradeRequests.get(value.requestId)!;tradeRequests.delete(value.requestId);clearTimeout(t.timer);
            if(result)t.resolve(value.value);else t.reject(new Error('Trade request failed. Query its status before retrying.'));
            return;
        }
        if (typeof value.requestId === 'string' && tableRequests.has(value.requestId)) {
            const result = value.type === PREFIX + 'table-result' && exact(value, ['type', 'version', 'nonce', 'requestId', 'value']);
            const error = value.type === PREFIX + 'table-error' && exact(value, ['type', 'version', 'nonce', 'requestId', 'message']);
            if (!result && !error) return;
            if (error && (typeof value.message !== 'string' || value.message.length > 160)) return;
            const request = tableRequests.get(value.requestId)!;
            tableRequests.delete(value.requestId);
            clearTimeout(request.timer);
            if (result) request.resolve(value.value);
            else request.reject(new Error('Spawn could not complete this table request. Reconcile its server status.'));
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
        if (pendingTokenPayment && value.requestId === pendingTokenPayment.id) {
            const request = pendingTokenPayment;
            const result = value.type === PREFIX + 'token-payment-result' && exact(value, ['type', 'version', 'nonce', 'requestId', 'receipt']);
            const failed = value.type === PREFIX + 'token-payment-error' && exact(value, ['type', 'version', 'nonce', 'requestId', 'message']);
            if (!result && !failed)
                return;
            if (failed && (typeof value.message !== 'string' || value.message.length > 160))
                return;
            pendingTokenPayment = null;
            clearTimeout(request.timer);
            if (result && validTokenPaymentReceipt(value.receipt, platformOrigin))
                request.resolve(value.receipt);
            else
                request.reject(new Error(failed ? 'Spawn could not complete this token payment.' : 'Spawn returned an invalid token payment receipt.'));
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
    function requestTokenPayment(input: SpawnTokenPaymentOptions): Promise<SpawnTokenPaymentReceipt> {
        if (!object(input) || !Object.hasOwn(input, 'amount') || Object.keys(input).some(key => !['amount', 'item', 'requestId'].includes(key)))
            return Promise.reject(new Error('Token payment requires an explicit amount; only an optional item label and request ID may be supplied.'));
        const amount = input.amount, item = input.item;
        if (typeof amount !== 'string' || amount.length > 512 || !TOKEN_PAYMENT_AMOUNT_PATTERN.test(amount))
            return Promise.reject(new Error('Token payment amount must be a decimal string without a sign or exponent.'));
        const [whole, fraction = ''] = amount.split('.');
        if (BigInt(whole) === 0n && !/[1-9]/.test(fraction))
            return Promise.reject(new Error('Token payment amount must be greater than zero.'));
        if (item !== undefined && (typeof item !== 'string' || item.trim() === '' || item.length > TOKEN_PAYMENT_ITEM_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(item)))
            return Promise.reject(new Error(`Token payment item label must contain 1–${TOKEN_PAYMENT_ITEM_MAX_LENGTH} printable characters.`));
        const requestId = input.requestId === undefined ? crypto.randomUUID() : input.requestId;
        if (!uuid(requestId))
            return Promise.reject(new Error('Token payment requestId must be a UUID.'));
        if (pendingMatchEntry)
            return Promise.reject(new Error('A match entry request is already pending.'));
        if (pendingTokenPayment) {
            if (pendingTokenPayment.id === requestId && pendingTokenPayment.amount === amount && pendingTokenPayment.item === item)
                return pendingTokenPayment.promise;
            return Promise.reject(new Error('A token payment request is already pending.'));
        }
        let resolve!: (value: SpawnTokenPaymentReceipt) => void, reject!: (error: Error) => void;
        const promise = new Promise<SpawnTokenPaymentReceipt>((yes, no) => { resolve = yes; reject = no; });
        const request = { id: requestId, amount, ...(item === undefined ? {} : { item }), promise, resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined };
        pendingTokenPayment = request;
        void readyPromise.then(() => {
            if (closed || pendingTokenPayment !== request)
                return;
            if (!confirmed || !port) {
                pendingTokenPayment = null;
                request.reject(new Error('The Spawn launch is closed.'));
                return;
            }
            request.timer = setTimeout(() => {
                if (pendingTokenPayment !== request)
                    return;
                pendingTokenPayment = null;
                request.reject(new Error('Spawn did not respond; token payment outcome is unknown.'));
            }, TOKEN_PAYMENT_DURATION);
            post({ type: PREFIX + 'token-payment-request', requestId, amount, ...(item === undefined ? {} : { item }) });
        }).catch((error: unknown) => {
            if (pendingTokenPayment !== request)
                return;
            pendingTokenPayment = null;
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
    const tables: SpawnMultiplayerTables = {
        buyIn(input) {
            if (!object(input) || !exact(input, ['tableId', 'buyInId']))
                return Promise.reject(new Error('A table ID and buy-in ID are required.'));
            let tableId: string, buyInId: string;
            try {
                tableId = normalizeTableId(input.tableId);
                buyInId = normalizeTableId(input.buyInId);
            } catch (error) {
                return Promise.reject(error instanceof Error ? error : new Error('Invalid table buy-in request.'));
            }
            return sendTable('tables.buyIn', { tableId, buyInId })
                .then(value => {
                    const result = validateSpawnTableBuyInResult(value, tableId, buyInId);
                    return result;
                });
        },
        status(tableId) {
            let id: string;
            try { id = normalizeTableId(tableId); }
            catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Invalid table ID.')); }
            return sendTable('tables.status', { tableId: id })
                .then(value => validateSpawnTablePlayerStatus(value, id, platformOrigin));
        },
        heartbeat(tableId) {
            let id: string;
            try { id = normalizeTableId(tableId); }
            catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Invalid table ID.')); }
            return sendTable('tables.heartbeat', { tableId: id })
                .then(value => validateSpawnTablePlayerStatus(value, id, platformOrigin));
        },
        leave(input) {
            if (!object(input) || !exact(input, ['tableId', 'operationId', 'seatId']))
                return Promise.reject(new Error('A table ID, operation ID and seat ID are required.'));
            let tableId: string, operationId: string, seatId: string;
            try {
                tableId = normalizeTableId(input.tableId);
                operationId = normalizeOperationId(input.operationId);
                seatId = normalizeSeatId(input.seatId);
            } catch (error) {
                return Promise.reject(error instanceof Error ? error : new Error('Invalid table leave request.'));
            }
            return sendTable('tables.leave', { tableId, operationId, seatId })
                .then(value => validateSpawnTablePlayerStatus(value, tableId, platformOrigin));
        },
        watch(tableId) {
            return startTableWatch(normalizeTableId(tableId));
        },
    };
    const client = { tables, tokens: createTokenMethods(payload => sendTrade('balances', payload), localBalanceOrigin(platformOrigin)), trades: createTradeMethods(sendTrade), ready: () => readyPromise, requestGrant, requestMatchEntry, requestTokenPayment, reportConnection, dispose };
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
