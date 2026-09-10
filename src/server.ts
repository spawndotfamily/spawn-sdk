// @ts-ignore Node runtime modules are available without an SDK runtime dependency.
import { createPublicKey, verify as verifySignature } from 'node:crypto';
// @ts-ignore Node runtime modules are available without an SDK runtime dependency.
import { Buffer } from 'node:buffer';
/** Only public verification material belongs here. Never supply a signing/private key. */
export type SpawnLaunchVerificationOptions = {
    publicKeys: Record<string, string>;
    issuer: string;
    audience: string;
    gameId: string;
    environment: string;
    now?: () => number;
    minimumIssuedAt?: number;
    maxLifetimeSeconds?: number;
    maxConsumedGrants?: number;
};
export type SpawnVerifiedLaunch = {
    playerId: string;
    displayName: string;
    handle: string;
    sessionId: string;
    grantId: string;
    expiresAt: number;
    environment: string;
};
export type SpawnLaunchVerifier = {
    readonly configured: boolean;
    verify(ticket: string): SpawnVerifiedLaunch;
    consume(ticket: string): SpawnVerifiedLaunch;
};
const INVALID = 'Invalid Spawn launch grant.';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const label = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
const decoder = new TextDecoder('utf-8', { fatal: true });
function decode(value: string) { if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(INVALID); const bytes = Buffer.from(value, 'base64url'); if (!bytes.length || bytes.toString('base64url') !== value)
    throw new Error(INVALID); return bytes; }
function json(value: string): unknown { return JSON.parse(decoder.decode(decode(value))); }
function publicKeys(value: unknown) {
    if (!object(value))
        return null;
    const entries = Object.entries(value);
    if (!entries.length || entries.length > 8)
        return null;
    const keys = new Map<string, unknown>();
    try {
        for (const [id, pem] of entries) {
            if (!label(id, 128) || typeof pem !== 'string' || pem.length > 8192 || pem.includes('PRIVATE KEY'))
                return null;
            const key = createPublicKey(pem);
            if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519')
                return null;
            keys.set(id, key);
        }
        return keys;
    }
    catch {
        return null;
    }
}
/**
 * Pinned-key verifier for a creator-operated Node server. No network or filesystem access.
 * consume() provides bounded one-process replay protection; verify() does not consume.
 */
export function createSpawnLaunchVerifier(options: SpawnLaunchVerificationOptions): SpawnLaunchVerifier {
    const input: Record<string, unknown> = object(options) ? { ...options } : {};
    const now = typeof input.now === 'function' ? input.now as () => number : () => Date.now();
    let startedAt: number;
    try {
        startedAt = now();
    }
    catch {
        startedAt = NaN;
    }
    const minimumIssuedAt = input.minimumIssuedAt ?? Math.ceil(startedAt / 1000), maxLifetime = input.maxLifetimeSeconds ?? 120, maxConsumed = input.maxConsumedGrants ?? 32768;
    const keys = publicKeys(input.publicKeys);
    const configured = !!keys && ['issuer', 'audience', 'gameId', 'environment'].every(name => label(input[name], 256)) &&
        (input.now === undefined || typeof input.now === 'function') && Number.isFinite(startedAt) &&
        typeof minimumIssuedAt === 'number' && Number.isSafeInteger(minimumIssuedAt) && minimumIssuedAt >= 0 &&
        typeof maxLifetime === 'number' && Number.isSafeInteger(maxLifetime) && maxLifetime > 0 && maxLifetime <= 120 &&
        typeof maxConsumed === 'number' && Number.isSafeInteger(maxConsumed) && maxConsumed >= 1 && maxConsumed <= 32768;
    const consumed = new Map<string, number>();
    let lastSweep = -Infinity;
    function verify(ticket: string): SpawnVerifiedLaunch {
        if (!configured)
            throw new Error('Spawn public-key verification is not configured.');
        try {
            if (typeof ticket !== 'string' || Buffer.byteLength(ticket, 'utf8') > 4096)
                throw new Error(INVALID);
            const parts = ticket.split('.');
            if (parts.length !== 3 || parts.some(value => !value))
                throw new Error(INVALID);
            const header = json(parts[0]), claims = json(parts[1]), signature = decode(parts[2]);
            if (!object(header) || !object(claims) || signature.length !== 64 || Object.keys(header).length !== 3 || !['alg', 'typ', 'kid'].every(key => Object.hasOwn(header, key)) || header.alg !== 'EdDSA' || header.typ !== 'JWT' || !label(header.kid, 128))
                throw new Error(INVALID);
            const key = keys!.get(header.kid);
            if (!key || !verifySignature(null, Buffer.from(parts[0] + '.' + parts[1], 'ascii'), key, signature))
                throw new Error(INVALID);
            for (const [claim, expected] of [['iss', input.issuer], ['aud', input.audience], ['gameId', input.gameId], ['environment', input.environment]])
                if (claims[claim as string] !== expected)
                    throw new Error(INVALID);
            if (!label(claims.sub, 128) || !label(claims.sid, 128) || !label(claims.jti, 128) || !label(claims.handle, 64) || !label(claims.displayName, 64))
                throw new Error(INVALID);
            if (!Array.isArray(claims.scope) || claims.scope.length !== 1 || claims.scope[0] !== 'multiplayer:join' || ['clientId', 'clientID', 'client_id'].some(name => Object.hasOwn(claims, name)))
                throw new Error(INVALID);
            const { iat, nbf, exp } = claims, current = now() / 1000;
            if (!Number.isFinite(current) || typeof iat !== 'number' || typeof nbf !== 'number' || typeof exp !== 'number' || ![iat, nbf, exp].every(Number.isSafeInteger) || exp <= current || iat > current || iat < (minimumIssuedAt as number) || nbf > current + 5 || nbf > exp || exp <= iat || exp - iat > (maxLifetime as number))
                throw new Error(INVALID);
            return { playerId: claims.sub, sessionId: claims.sid, grantId: claims.jti, handle: claims.handle, displayName: claims.displayName, environment: input.environment as string, expiresAt: exp * 1000 };
        }
        catch {
            throw new Error(INVALID);
        }
    }
    function consume(ticket: string) {
        const identity = verify(ticket), current = now();
        if (!Number.isFinite(current) || identity.expiresAt <= current)
            throw new Error(INVALID);
        if (current - lastSweep >= 1000 || consumed.size >= (maxConsumed as number)) {
            lastSweep = current;
            for (const [id, expiry] of consumed)
                if (expiry <= current)
                    consumed.delete(id);
        }
        if (consumed.has(identity.grantId))
            throw new Error('This Spawn launch grant was already used.');
        if (consumed.size >= (maxConsumed as number))
            throw new Error('Spawn launch verification is at capacity.');
        consumed.set(identity.grantId, identity.expiresAt);
        return identity;
    }
    return Object.freeze({ configured, verify, consume });
}
