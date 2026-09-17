import type { SpawnMatchAsset } from "./match-server.ts";
export type SpawnTradeParty = {
  playerId: string;
  handle: string;
  amount: string;
  confirmed: boolean;
};
/** Amounts in returned views are exact ERC-20 base units. */
export type SpawnTrade = {
  tradeId: string;
  projectId: string;
  version: number;
  quoteId: string;
  status: "pending" | "settled" | "cancelled" | "expired";
  asset: SpawnMatchAsset;
  self: SpawnTradeParty;
  other: SpawnTradeParty;
  balance: string;
  expiresAt: number;
  settledAt: number | null;
  platformFee: "0";
};
export type SpawnTradeCreate = {
  tradeId: string;
  recipientPlayerId: string;
  recipientLaunchId: string;
  amount: string;
};
export type SpawnTradeAction = "balances" | "context" | "create" | "view" | "offer" | "accept" | "cancel";
export type SpawnTrades = {
  context(): Promise<{ playerId: string; launchId: string; projectId: string }>;
  create(input: SpawnTradeCreate): Promise<SpawnTrade>;
  get(tradeId: string): Promise<SpawnTrade>;
  offer(tradeId: string, version: number, amount: string): Promise<SpawnTrade>;
  /** Call after the player accepts this exact revision in-game. Senders also see Spawn approval. Null means the popup was dismissed, not that the trade was cancelled. */
  accept(tradeId: string, version: number): Promise<SpawnTrade | null>;
  cancel(tradeId: string): Promise<SpawnTrade>;
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const base = (v: unknown) => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v);
function decimal(v: unknown) {
  if (typeof v !== "string" || v.length > 115 || !/^(0|[1-9][0-9]*)(\.[0-9]{1,36})?$/.test(v))
    throw new Error("Use an exact decimal amount, including zero for a receive-only offer.");
}
function revision(v: unknown) {
  if (!Number.isSafeInteger(v) || Number(v) < 1) throw new Error("Use the current trade version.");
}
export function validateTrade(value: unknown, tradeId: string): SpawnTrade {
  if (
    !object(value) ||
    value.tradeId !== tradeId ||
    !uuid(value.projectId) ||
    !uuid(value.quoteId) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    !["pending", "settled", "cancelled", "expired"].includes(String(value.status)) ||
    !base(value.balance) ||
    value.platformFee !== "0" ||
    !Number.isSafeInteger(value.expiresAt) ||
    !object(value.asset)
  )
    throw new Error("Invalid Spawn trade response. Query its status.");
  const a = value.asset;
  if (
    !Number.isSafeInteger(a.chainId) ||
    ![46630, 31337].includes(Number(a.chainId)) ||
    a.enabled !== true ||
    !["spawn", "partner"].includes(String(a.source)) ||
    typeof a.image !== "string" ||
    typeof a.address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(a.address) ||
    a.id !== `erc20:${a.chainId}:${a.address.toLowerCase()}` ||
    !Number.isInteger(a.decimals) ||
    Number(a.decimals) < 0 ||
    Number(a.decimals) > 36 ||
    typeof a.name !== "string" ||
    typeof a.symbol !== "string"
  )
    throw new Error("Invalid trade asset identity.");
  for (const p of [value.self, value.other])
    if (
      !object(p) ||
      !uuid(p.playerId) ||
      typeof p.handle !== "string" ||
      !base(p.amount) ||
      typeof p.confirmed !== "boolean"
    )
      throw new Error("Invalid trade participant.");
  if ((value.self as SpawnTradeParty).playerId === (value.other as SpawnTradeParty).playerId)
    throw new Error("Invalid trade roster.");
  if (
    value.status === "settled" &&
    (!Number.isSafeInteger(value.settledAt) ||
      !(value.self as SpawnTradeParty).confirmed ||
      !(value.other as SpawnTradeParty).confirmed)
  )
    throw new Error("Missing trade settlement confirmation.");
  return value as SpawnTrade;
}
/** Internal transport adapter shared by isolated and registered multiplayer clients. */
export function createTradeMethods(
  send: (action: SpawnTradeAction, payload: Record<string, unknown>) => Promise<unknown>,
): SpawnTrades {
  async function call(action: SpawnTradeAction, payload: Record<string, unknown>) {
    if (!uuid(payload.tradeId)) throw new Error("A canonical UUID trade ID is required.");
    const value = await send(action, payload);
    if (value === null && action === "accept") return null;
    return validateTrade(value, payload.tradeId);
  }
  return Object.freeze({
    async context() {
      const v = await send("context", {});
      if (!object(v) || !uuid(v.playerId) || !uuid(v.launchId) || !uuid(v.projectId))
        throw new Error("Invalid Spawn trade context.");
      return { playerId: v.playerId, launchId: v.launchId, projectId: v.projectId };
    },
    async create(input: SpawnTradeCreate) {
      if (
        !object(input) ||
        Object.keys(input).length !== 4 ||
        !["tradeId", "recipientPlayerId", "recipientLaunchId", "amount"].every((k) =>
          Object.hasOwn(input, k),
        ) ||
        !uuid(input.recipientPlayerId) ||
        !uuid(input.recipientLaunchId)
      )
        throw new Error("Use the other player’s verified Spawn player and launch IDs.");
      decimal(input.amount);
      return (await call("create", { ...input }))!;
    },
    get: async (tradeId: string) => (await call("view", { tradeId }))!,
    offer: async (tradeId: string, version: number, amount: string) => {
      revision(version);
      decimal(amount);
      return (await call("offer", { tradeId, version, amount }))!;
    },
    accept: async (tradeId: string, version: number) => {
      revision(version);
      return call("accept", { tradeId, version });
    },
    cancel: async (tradeId: string) => (await call("cancel", { tradeId }))!,
  });
}
