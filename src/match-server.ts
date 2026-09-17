import { SpawnMatchRequestError, httpCode, publicErrorDetails } from "./match-errors.ts";
export { SpawnMatchRequestError } from "./match-errors.ts";
/** Server-only client for operator-enabled, per-game Listing-token match escrow. */
export type SpawnMatchPlayer = { playerId: string; launchId: string };
export type SpawnMatchDefinition = {
  matchId: string;
  amount: string;
  players: [SpawnMatchPlayer, SpawnMatchPlayer] | SpawnMatchPlayer[];
};
export type SpawnMatchSettlement = {
  reason: "victory" | "timeout" | "forfeit" | "draw";
  payouts: { playerId: string; amount: string }[];
};
export type SpawnMatchAsset = {
  id: string;
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  image: string;
  source: "spawn" | "partner";
  enabled: boolean;
};
export type SpawnMatchCancelResult = {
  matchId: string;
  status: "cancelled";
  reason: string;
  cancelledAt: number;
  refunds: { playerId: string; amount: string }[];
  potAmount: string;
};
export type SpawnMatchClosureResult = SpawnMatchCancelResult & {
  projectId: string;
  /** Durable proof that this ID cannot reserve funds in the future. */
  creationClosed: true;
  closedBeforeCreation: boolean;
  remainingReservedAmount: "0";
};
export type SpawnMatchSettlementResult = {
  matchId: string;
  status: "settled";
  reason: string;
  settledAt: number;
  payouts: { playerId: string; amount: string }[];
  potAmount: string;
  platformFee: "0";
};
export type SpawnMatchStatus = {
  matchId: string;
  projectId: string;
  status: "pending" | "running" | "settled" | "cancelled";
  createdAt: number;
  expiresAt: number;
  maxEndsAt: number;
  leaseExpiresAt: number | null;
  asset: SpawnMatchAsset;
  settingsVersion: number;
  /** Exact human-readable token units. */
  entryAmount: string;
  potAmount: string;
  confirmedPlayers: number;
  totalPlayers: number;
  allConfirmed: boolean;
  players: { playerId: string; confirmed: boolean }[];
  terminalReason: string | null;
  result: SpawnMatchCancelResult | SpawnMatchSettlementResult | null;
};
export type SpawnMatchClientOptions = {
  platformOrigin: string;
  projectId: string;
  /** A separately provisioned match server secret, never a publishing or storage key. */
  credential: string;
  timeoutMs?: number;
  /** Optional server transport, useful for isolated tests. Must enforce the supplied request options. */
  fetch?: typeof globalThis.fetch;
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, fields: string[]) {
  if (
    !record(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error("Invalid match request fields.");
}
function amount(value: unknown, positive: boolean) {
  if (
    typeof value !== "string" ||
    value.length > 115 ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,36})?$/.test(value) ||
    (positive && !/[1-9]/.test(value))
  )
    throw new Error("Use an exact decimal token amount.");
}
function origin(value: string) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Use a trusted Spawn HTTPS origin, or exact loopback for local testing.");
  return url.origin;
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65536) throw new Error("Response too large.");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
/** Never retries a mutation. Reconcile an unknown outcome with status(matchId). */
export function createSpawnMatchClient(options: SpawnMatchClientOptions) {
  if (typeof window !== "undefined")
    throw new Error("Spawn match credentials belong only on an authoritative server.");
  const platform = origin(options.platformOrigin),
    project =
      typeof options.projectId === "string" ? options.projectId.toLowerCase() : options.projectId,
    credential = options.credential;
  if (!uuid(project) || typeof credential !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(credential))
    throw new Error("A project ID and dedicated match server credential are required.");
  const timeout = options.timeoutMs ?? 10000,
    transport = options.fetch ?? globalThis.fetch;
  if (
    !Number.isInteger(timeout) ||
    timeout < 100 ||
    timeout > 30000 ||
    typeof transport !== "function"
  )
    throw new Error("Invalid match transport configuration.");
  const base = platform + "/api/v1/registered-games/" + project + "/matches";
  async function request<T = SpawnMatchStatus>(
    matchId: string,
    action: string,
    payload?: unknown,
  ): Promise<T> {
    if (!uuid(matchId)) throw new Error("A UUID match ID is required.");
    matchId = matchId.toLowerCase();
    const mutation = payload !== undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let responseStatus: number | undefined;
    try {
      const response = await transport(
        base + (action === "create" ? "" : "/" + matchId + (action ? "/" + action : "")),
        {
          method: mutation ? "POST" : "GET",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            authorization: "Bearer " + credential,
            accept: "application/json",
            ...(mutation ? { "content-type": "application/json" } : {}),
          },
          ...(mutation ? { body: JSON.stringify(payload) } : {}),
        },
      );
      responseStatus = response.status;
      if (!response.ok) {
        let errorBody: unknown;
        try { errorBody = await boundedJson(response); } catch { /* Keep the known HTTP status. */ }
        const details = publicErrorDetails(errorBody, response, credential);
        throw new SpawnMatchRequestError(
          details.reason ?? (response.status === 401 || response.status === 403
            ? "Dedicated match server authorization is required."
            : "Spawn rejected the match request. Check its status and configuration."),
          response.status,
          mutation && (response.status >= 500 || response.status === 408),
          { ...details, code: httpCode(response.status), action: action || "status", matchId, projectId: project },
        );
      }
      const value = await boundedJson(response);
      if (
        !record(value) ||
        value.matchId !== matchId ||
        !["pending", "running", "settled", "cancelled"].includes(String(value.status))
      )
        throw new Error("Invalid response.");
      if (
        (action === "cancel" && value.status !== "cancelled") ||
        (action === "settle" && value.status !== "settled") ||
        (["capture", "heartbeat"].includes(action) && value.status !== "running")
      )
        throw new Error("Unexpected match result.");
      if (
        action !== "cancel" &&
        action !== "settle" &&
        action !== "close-creation" &&
        (value.projectId !== project ||
          typeof value.allConfirmed !== "boolean" ||
          !Array.isArray(value.players) ||
          value.players.length !== 2)
      )
        throw new Error("Invalid match status.");
      if (action === "close-creation") {
        if (value.status !== "cancelled" || value.projectId !== project ||
            value.creationClosed !== true || value.remainingReservedAmount !== "0" || typeof value.closedBeforeCreation !== "boolean" ||
            typeof value.reason !== "string" || !value.reason || value.reason.length > 128 ||
            !Number.isSafeInteger(value.cancelledAt) || (value.cancelledAt as number) < 0 ||
            !Array.isArray(value.refunds) || value.refunds.length > 2)
          throw new Error("Invalid creation closure proof.");
        amount(value.potAmount, false);
        const units = (v: string) => {
          const [whole, fraction = ""] = v.split(".");
          return BigInt(whole! + fraction.padEnd(36, "0"));
        };
        let refunded = 0n;
        const players = new Set<string>();
        for (const refund of value.refunds) {
          if (!record(refund) || !uuid(refund.playerId) || players.has(refund.playerId.toLowerCase()))
            throw new Error("Invalid closure refund.");
          players.add(refund.playerId.toLowerCase());
          amount(refund.amount, true);
          const refundUnits = units(refund.amount as string);
          if (refundUnits * 2n !== units(value.potAmount as string))
            throw new Error("Refund does not match an equal-entry match.");
          refunded += refundUnits;
        }
        if (refunded > units(value.potAmount as string)) throw new Error("Refund exceeds match pot.");
        if (!value.closedBeforeCreation) amount(value.potAmount, true);
        if (value.closedBeforeCreation && (value.potAmount !== "0" || value.refunds.length !== 0))
          throw new Error("An absent creation cannot have reserved funds.");
      }
      return value as T;
    } catch (error) {
      if (error instanceof SpawnMatchRequestError) throw error;
      throw new SpawnMatchRequestError(
        mutation
          ? action === "close-creation"
            ? "Creation closure is unconfirmed. Keep the attempt blocked and explicitly repeat closeCreation with the same ID."
            : "Match outcome is unknown. Query status with the same match ID before taking another action."
          : "Could not read match status.",
        responseStatus,
        mutation,
        { code: controller.signal.aborted ? "REQUEST_TIMEOUT" : responseStatus === undefined ? "TRANSPORT_ERROR" : "INVALID_RESPONSE",
          action: action || "status", matchId, projectId: project },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    async create(input: SpawnMatchDefinition) {
      exact(input, ["matchId", "amount", "players"]);
      amount(input.amount, true);
      if (!Array.isArray(input.players) || input.players.length !== 2)
        throw new Error("Exactly two players are required.");
      for (const player of input.players) {
        exact(player, ["playerId", "launchId"]);
        if (!uuid(player.playerId) || !uuid(player.launchId))
          throw new Error("Use verified Spawn player and launch IDs.");
      }
      if (
        new Set(input.players.map((p) => p.playerId.toLowerCase())).size !== 2 ||
        new Set(input.players.map((p) => p.launchId.toLowerCase())).size !== 2
      )
        throw new Error("Distinct players and launches are required.");
      return request(input.matchId, "create", {
        ...input,
        matchId: input.matchId.toLowerCase(),
        players: input.players.map((p) => ({
          playerId: p.playerId.toLowerCase(),
          launchId: p.launchId.toLowerCase(),
        })),
      });
    },
    /** Explicitly abandon an uncertain creation. Safe to repeat with the same ID after a lost reply. */
    closeCreation: (matchId: string) => request<SpawnMatchClosureResult>(matchId, "close-creation", {}),
    status: (matchId: string) => request(matchId, ""),
    capture: (matchId: string) => request(matchId, "capture", {}),
    heartbeat: (matchId: string) => request(matchId, "heartbeat", {}),
    async cancel(matchId: string, reason: "technical" | "cancelled" | "expired" | "shutdown") {
      if (!["technical", "cancelled", "expired", "shutdown"].includes(reason))
        throw new Error("Invalid cancellation reason.");
      return request<SpawnMatchCancelResult>(matchId, "cancel", { reason });
    },
    async settle(matchId: string, input: SpawnMatchSettlement) {
      exact(input, ["reason", "payouts"]);
      if (
        !["victory", "timeout", "forfeit", "draw"].includes(input.reason) ||
        !Array.isArray(input.payouts) ||
        input.payouts.length < 1 ||
        input.payouts.length > 2
      )
        throw new Error("Invalid settlement.");
      for (const payout of input.payouts) {
        exact(payout, ["playerId", "amount"]);
        if (!uuid(payout.playerId)) throw new Error("Invalid payout player.");
        amount(payout.amount, false);
      }
      if (new Set(input.payouts.map((p) => p.playerId.toLowerCase())).size !== input.payouts.length)
        throw new Error("Duplicate payout player.");
      return request<SpawnMatchSettlementResult>(matchId, "settle", {
        ...input,
        payouts: input.payouts.map((p) => ({ ...p, playerId: p.playerId.toLowerCase() })),
      });
    },
  });
}

export type SpawnMatchClient = ReturnType<typeof createSpawnMatchClient>;
