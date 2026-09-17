import type { SpawnMatchAsset } from './match-server.ts';

/** From verified Spawn admission, never a peer's claimed account ID. */
export type SpawnBalancePlayer = { playerId: string; launchId: string };
/** Spendable deposited Listing-token units, not an on-chain wallet balance. */
export type SpawnTokenBalances = {
  projectId: string;
  asset: SpawnMatchAsset;
  settingsVersion: number;
  observedAt: number;
  players: { playerId: string; balance: string }[];
};
export type SpawnTokenBalance = Omit<SpawnTokenBalances, 'players'> & {
  playerId: string;
  balance: string;
};
export type SpawnTokens = {
  balance(): Promise<SpawnTokenBalance>;
};
const uuid = (v: unknown): v is string => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function validateBalancePlayers(value: unknown): SpawnBalancePlayer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50)
    throw new Error('Provide between 1 and 50 verified game players.');
  const players = new Set<string>(), launches = new Set<string>();
  return value.map(p => {
    if (!object(p) || Object.keys(p).length !== 2 || !uuid(p.playerId) || !uuid(p.launchId) ||
        players.has(p.playerId) || launches.has(p.launchId))
      throw new Error('Use unique verified player and launch IDs from this game.');
    players.add(p.playerId); launches.add(p.launchId);
    return { playerId: p.playerId, launchId: p.launchId };
  });
}

export function validateTokenBalances(value: unknown, players?: readonly SpawnBalancePlayer[], projectId?: string, allowLocal = false): SpawnTokenBalances {
  if (!object(value) || !uuid(value.projectId) || (projectId !== undefined && value.projectId !== projectId) ||
      !Number.isSafeInteger(value.settingsVersion) || Number(value.settingsVersion) < 1 ||
      !Number.isSafeInteger(value.observedAt) || Number(value.observedAt) < 0 || !object(value.asset) ||
      !Array.isArray(value.players) || value.players.length !== (players?.length ?? 1))
    throw new Error('Invalid Spawn token balance response.');
  const a = value.asset;
  if ((!allowLocal && a.chainId === 31337) || ![46630,31337].includes(Number(a.chainId)) || !Number.isSafeInteger(a.chainId) ||
      typeof a.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.address) ||
      a.id !== `erc20:${a.chainId}:${a.address.toLowerCase()}` || a.enabled !== true ||
      !['spawn','partner'].includes(String(a.source)) || !Number.isInteger(a.decimals) ||
      Number(a.decimals) < 0 || Number(a.decimals) > 36 ||
      typeof a.name !== 'string' || a.name.length > 256 ||
      typeof a.symbol !== 'string' || a.symbol.length > 64 ||
      typeof a.image !== 'string' || a.image.length > 2048)
    throw new Error('Invalid balance token identity.');
  const wanted = players && new Set(players.map(p => p.playerId)), seen = new Set<string>();
  for (const p of value.players) {
    if (!object(p) || !uuid(p.playerId) || seen.has(p.playerId) || (wanted && !wanted.has(p.playerId)) ||
        typeof p.balance !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(p.balance) || BigInt(p.balance) > (2n ** 256n - 1n))
      throw new Error('Invalid balance player or exact token amount.');
    seen.add(p.playerId);
  }
  return value as SpawnTokenBalances;
}

/** Shared by both isolated browser transports. Reads never open payment approval. */
export function createTokenMethods(send: (payload: Record<string, unknown>) => Promise<unknown>, allowLocal = false): SpawnTokens {
  return Object.freeze({
    async balance() {
      const { players: rows, ...snapshot } = validateTokenBalances(await send({}), undefined, undefined, allowLocal);
      return { ...snapshot, ...rows[0]! };
    },
  });
}

export function localBalanceOrigin(origin: string): boolean {
  return ['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname);
}
