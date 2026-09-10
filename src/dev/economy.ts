export type LocalPlayer = 'alice' | 'bob' | 'empty';
type Account = LocalPlayer | 'creator' | 'pool';
export type LocalTransfer = {
  id: string;
  kind: 'entry' | 'funding' | 'reward' | 'withdrawal';
  from: Account;
  to: Account;
  amount: number;
};

export function localPlayer(value: string): asserts value is LocalPlayer {
  if (!['alice', 'bob', 'empty'].includes(value)) throw new Error('Unknown local test player.');
}

/** Launcher-owned fake ledger. Never exposed through the game's MessageChannel. */
export class LocalTestEconomy {
  private balances: Record<Account, number> = { alice: 100, bob: 100, empty: 0, creator: 1000, pool: 0 };
  private transfers: LocalTransfer[] = [];

  balance(account: string) {
    if (!Object.hasOwn(this.balances, account)) throw new Error('Unknown local test account.');
    return this.balances[account as Account];
  }
  get history() { return structuredClone(this.transfers); }

  private transfer(from: Account, to: Account, amount: number, kind: LocalTransfer['kind'], id = 'local_' + crypto.randomUUID()) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Enter a positive whole number of TEST tokens.');
    if (this.balance(from) < amount) throw new Error('Insufficient local test balance.');
    if (!Number.isSafeInteger(this.balance(to) + amount)) throw new Error('Local test balance limit reached.');
    const receipt: LocalTransfer = { id, kind, from, to, amount };
    this.balances[from] -= amount;
    this.balances[to] += amount;
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
