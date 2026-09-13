export type LeaderboardQuery = { limit?: number; offset?: number };
export type LeaderboardPolicy = { enabled: boolean; mode: 'best' | 'latest' | 'all'; direction: 'higher' | 'lower' };
export type LeaderboardEntry = {
  id: string; score: number; submittedAt: string; verification: 'unverified' | 'creator_reviewed';
  player: { id: string; handle: string; displayName: string; avatarUrl: string | null };
};
export type LeaderboardPage = { mode: LeaderboardPolicy['mode']; direction: LeaderboardPolicy['direction']; items: LeaderboardEntry[]; nextOffset: number | null };
export type SaveIndex = { items: { key: string; version: number; updatedAt: string }[] };
export function leaderboardQuery(value: LeaderboardQuery = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['limit', 'offset'].includes(key))) throw new Error('Invalid leaderboard query.');
  const limit = value.limit ?? 20, offset = value.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error('Use a limit from 1 to 50 and an offset from 0 to 100000.');
  return { limit, offset };
}
/** Reject lossy JavaScript values; the database stores JSON, not executable objects. */
export function jsonSave(value: unknown) {
  const parents = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 64) throw new Error('Save nesting exceeds 64 levels.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || parents.has(item)) throw new Error('Saves require JSON values without cycles or non-finite numbers.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Use JSON objects and arrays for saves.');
    parents.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) visit(child, depth + 1);
    parents.delete(item);
  }
  visit(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > 65536) throw new Error('Save exceeds the 64 KiB record limit.');
  return JSON.parse(text) as unknown;
}
