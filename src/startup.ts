/** Startup coordination only. Identity must come from the trusted SDK bridge or
 * your server's verified admission response; this is not an authorization layer. */
export type SpawnStartupState<T> = Readonly<{
    status: 'blocked' | 'connecting' | 'ready' | 'closed';
    identity: Readonly<T> | null;
}>;
export function createSpawnStartup<T extends { id: string }>({ connect: verify, timeoutMs = 60_000 }: {
    connect(signal: AbortSignal): Promise<T>;
    timeoutMs?: number;
}) {
    if (typeof verify !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
        throw new Error('A connection function and bounded startup timeout are required.');
    let state: SpawnStartupState<T> = Object.freeze({ status: 'blocked', identity: null });
    const listeners = new Set<(state: SpawnStartupState<T>) => void>();
    type Attempt = { promise: Promise<Readonly<T>>; resolve(value: Readonly<T>): void; reject(error: Error): void; controller: AbortController; timer?: ReturnType<typeof setTimeout> };
    let active: Attempt | null = null;
    function publish(status: SpawnStartupState<T>['status'], identity: Readonly<T> | null = null) {
        state = Object.freeze({ status, identity });
        for (const listener of listeners) { try { listener(state); } catch { /* A view must not change admission state. */ } }
    }
    function cancel(status: 'blocked' | 'closed', error: Error) {
        const attempt = active; active = null;
        if (attempt) { clearTimeout(attempt.timer); attempt.controller.abort(); attempt.reject(error); }
        publish(status);
    }
    function connect(): Promise<Readonly<T>> {
        if (state.status === 'closed') return Promise.reject(new Error('Spawn startup is closed.'));
        if (active) return active.promise;
        if (state.status === 'ready') return Promise.resolve(state.identity!);
        let resolve!: Attempt['resolve'], reject!: Attempt['reject'];
        const promise = new Promise<Readonly<T>>((yes, no) => { resolve = yes; reject = no; });
        void promise.catch(() => {});
        const attempt: Attempt = { promise, resolve, reject, controller: new AbortController() };
        active = attempt;
        attempt.timer = setTimeout(() => { if (active === attempt) cancel('blocked', new Error('Spawn account connection timed out.')); }, timeoutMs);
        publish('connecting');
        if (active !== attempt) return promise;
        let result: Promise<T>;
        try { result = verify(attempt.controller.signal); } catch (error) { result = Promise.reject(error); }
        Promise.resolve(result).then(identity => {
            if (active !== attempt) return;
            if (!identity || typeof identity.id !== 'string' || !identity.id.trim()) throw new Error('Spawn identity is unavailable.');
            const safeIdentity = Object.freeze({ ...identity });
            clearTimeout(attempt.timer); active = null;
            publish('ready', safeIdentity);
            if (state.status === 'ready' && state.identity === safeIdentity) attempt.resolve(safeIdentity);
            else attempt.reject(new Error('Spawn account connection was lost.'));
        }).catch(error => {
            if (active === attempt) cancel('blocked', error instanceof Error ? error : new Error('Spawn account connection failed.'));
        });
        return promise;
    }
    return Object.freeze({
        get state() { return state; }, connect,
        invalidate() { if (state.status !== 'closed') cancel('blocked', new Error('Spawn account connection was lost.')); },
        subscribe(listener: (state: SpawnStartupState<T>) => void) {
            if (state.status === 'closed') { listener(state); return () => {}; }
            listeners.add(listener); listener(state); return () => { listeners.delete(listener); };
        },
        dispose() { if (state.status === 'closed') return; cancel('closed', new Error('Spawn startup is closed.')); listeners.clear(); }
    });
}
