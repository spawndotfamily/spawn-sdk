import type { Save, SpawnGameIdentity, SpawnScoreSubmission, SpawnTestPayment } from '../index.ts';
import { LocalTestEconomy, localPlayer, type LocalPlayer as Player } from './economy.ts';
type LocalScore = SpawnScoreSubmission & { player: Player; score: number; details: unknown };
export type LocalQuote = { id: string; player: Player; launch: string; status: 'pending' | 'paid' | 'cancelled'; receipt?: SpawnTestPayment };
/** In-memory fixtures only. This module never calls a platform API. */
export class LocalTestState {
  readonly economy = new LocalTestEconomy();
  private submissions: LocalScore[] = [];
  get scores() { return structuredClone(this.submissions); }
  private saves = new Map<string, Save<unknown>>();
  private quotes = new Map<string, LocalQuote>();
  identity(player: string): SpawnGameIdentity {
    this.player(player);
    return { id: 'local_test_' + player, handle: 'test_' + player,
      displayName: (player === 'alice' ? 'Alice' : player === 'bob' ? 'Bob' : 'Empty balance') + ' (local test)', avatarUrl: null, environment: 'sandbox' };
  }
  private player(value: string): asserts value is Player {
    localPlayer(value);
  }
  private recordKey(player: string, key: string) {
    this.player(player);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) throw new Error('Invalid record key.');
    return player + ':' + key;
  }
  balance(player: string) { this.player(player); return this.economy.balance(player); }
  load(player: string, key: string) { return structuredClone(this.saves.get(this.recordKey(player, key)) ?? null); }
  save(player: string, key: string, value: unknown, version: number): Save<unknown> {
    const id = this.recordKey(player, key);
    if (!Number.isSafeInteger(version) || version < 0 || (this.saves.get(id)?.version ?? 0) !== version) throw new Error('Save changed; reload before saving.');
    const text = JSON.stringify(value);
    if (text === undefined || text.length > 16000 || this.saves.size >= 1000 && !this.saves.has(id)) throw new Error('Local record limit reached.');
    const save = { value: JSON.parse(text) as unknown, version: version + 1, updatedAt: new Date().toISOString() };
    this.saves.set(id, save);
    return structuredClone(save);
  }
  score(player: string, score: number, details: unknown): SpawnScoreSubmission {
    this.player(player);
    if (!Number.isFinite(score) || JSON.stringify(details ?? {}).length > 4000) throw new Error('Invalid local score.');
    const result: SpawnScoreSubmission = { id: 'local_' + crypto.randomUUID(), verification: 'unverified' };
    this.submissions.unshift({ ...result, player, score, details: JSON.parse(JSON.stringify(details ?? {})) as unknown });
    this.submissions.splice(100);
    return result;
  }
  quote(player: string, launch: string, product: string): LocalQuote {
    this.player(player);
    if (product !== 'entry') throw new Error('Only the entry test product is available.');
    const existing = [...this.quotes.values()].find(q => q.player === player && q.launch === launch && q.status !== 'cancelled');
    if (existing) return structuredClone(existing);
    if (this.balance(player) < 10) throw new Error('Insufficient local test balance. Choose Alice or Bob, or reset testing.');
    if (this.quotes.size >= 1000) throw new Error('Local test limit reached. Reset testing.');
    const quote: LocalQuote = { id: 'local_' + crypto.randomUUID(), player, launch, status: 'pending' };
    this.quotes.set(quote.id, quote);
    return structuredClone(quote);
  }
  cancel(id: string) {
    const quote = this.quotes.get(id);
    if (quote?.status === 'pending') quote.status = 'cancelled';
  }
  confirm(id: string): SpawnTestPayment {
    const quote = this.quotes.get(id);
    if (!quote || quote.status === 'cancelled') throw new Error('Local payment cancelled.');
    if (quote.receipt) return structuredClone(quote.receipt);
    const receipt: SpawnTestPayment = { id: 'local_' + crypto.randomUUID(), intentId: id, amount: 10, asset: 'TEST', environment: 'sandbox', status: 'paid' };
    this.economy.entry(quote.player, receipt.id);
    quote.status = 'paid';
    quote.receipt = receipt;
    return structuredClone(quote.receipt);
  }
}
