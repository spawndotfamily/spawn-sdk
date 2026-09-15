export type LocalPlayer = 'alice' | 'bob' | 'empty';
type Account = LocalPlayer | 'creator' | 'pool' | 'platform';
/** New game transfers in the local launcher are permanently fee-free. */
export const LOCAL_PLATFORM_FEE_BPS = 0;
export type LocalTransfer = {
  id: string;
  kind: 'entry' | 'funding' | 'reward' | 'withdrawal';
  from: Account;
  to: Account;
  amount: number;
  platformFee: number;
  netAmount: number;
  feeBps: number;
};

export function localPlayer(value: string): asserts value is LocalPlayer {
  if (!['alice', 'bob', 'empty'].includes(value)) throw new Error('Unknown local test player.');
}

/** Launcher-owned fake ledger. Never exposed through the game's MessageChannel. */
export class LocalTestEconomy {
  private balances: Record<Account, number> = { alice: 10000, bob: 10000, empty: 0, creator: 100000, pool: 0, platform: 0 };
  private transfers: LocalTransfer[] = [];

  readonly feeBps: number;
  constructor(feeBps = LOCAL_PLATFORM_FEE_BPS) {
    // Keep the argument as a compatibility guard so stale fee configuration
    // cannot silently create a new non-zero transfer. Historical receipts keep
    // their fee fields, but this ledger only creates zero-fee receipts.
    if (feeBps !== LOCAL_PLATFORM_FEE_BPS) throw new Error('Platform fees are disabled for local test transfers.');
    this.feeBps = LOCAL_PLATFORM_FEE_BPS;
  }

  balance(account: string) {
    if (!Object.hasOwn(this.balances, account)) throw new Error('Unknown local test account.');
    return this.balances[account as Account] / 100;
  }
  get history() { return structuredClone(this.transfers); }

  private transfer(from: Account, to: Account, amount: number, kind: LocalTransfer['kind'], id = 'local_' + crypto.randomUUID()) {
    const minor = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount <= 0 || Number(amount.toFixed(2)) !== amount || !Number.isSafeInteger(minor)) throw new Error('Use positive TEST amounts with at most two decimal places.');
    if (this.balances[from] < minor) throw new Error('Insufficient local test balance.');
    const fee = 0;
    if (!Number.isSafeInteger(this.balances[to] + minor - fee) || !Number.isSafeInteger(this.balances.platform + fee)) throw new Error('Local test balance limit reached.');
    const receipt: LocalTransfer = { id, kind, from, to, amount, platformFee: fee / 100, netAmount: (minor - fee) / 100, feeBps: to === 'pool' ? this.feeBps : 0 };
    this.balances[from] -= minor;
    this.balances[to] += minor - fee;
    this.balances.platform += fee;
    this.transfers.unshift(receipt);
    this.transfers.splice(100);
    return structuredClone(receipt);
  }

  /** Called only after LocalTestState has checked the pending payment quote. */
  entry(player: string, receiptId: string) {
    localPlayer(player);
    return this.transfer(player, 'pool', 10, 'entry', receiptId);
  }
  fund(amount: number) { return this.transfer('creator', 'pool', amount, 'funding'); }
  withdraw(amount: number) { return this.transfer('pool', 'creator', amount, 'withdrawal'); }
  reward(player: string, amount: number) {
    localPlayer(player);
    return this.transfer('pool', player, amount, 'reward');
  }
}
