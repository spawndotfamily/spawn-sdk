import { jsonSave, leaderboardQuery, type LeaderboardPolicy, type LeaderboardQuery, type LeaderboardPage } from '../game-data.ts';
import type { Save, SpawnGameIdentity, SpawnScoreSubmission, SpawnTestPayment } from '../index.ts';
import { LocalTestEconomy, localPlayer, type LocalPlayer as Player } from './economy.ts';
type LocalScore = SpawnScoreSubmission & { player: Player; score: number; details: unknown };
export type LocalQuote = { id: string; player: Player; launch: string; status: 'pending' | 'paid' | 'cancelled'; receipt?: SpawnTestPayment };
/** In-memory fixtures only. This module never calls a platform API. */
export class LocalTestState {
  private readonly guestId = 'guest_' + crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  readonly economy = new LocalTestEconomy();
  leaderboard: LeaderboardPolicy = { enabled: false, mode: 'best', direction: 'higher' };
  private scoreTimes = new Map<string, string>();
  private submissions: LocalScore[] = [];
  get scores() { return structuredClone(this.submissions); }
  private saves = new Map<string, Save<unknown>>();
  private quotes = new Map<string, LocalQuote>();
  identity(player: string): SpawnGameIdentity {
    if (player === 'guest') return {id:this.guestId,handle:'Guest_'+this.guestId.slice(-8),displayName:'Guest (local test)',avatarUrl:null,environment:'sandbox',isGuest:true,capabilities:{play:true,submitScores:false,cloudSaves:false,payments:false,rewards:false}};
    this.player(player);
    return { id: 'local_test_' + player, handle: 'test_' + player,
      displayName: (player === 'alice' ? 'Alice' : player === 'bob' ? 'Bob' : 'Empty balance') + ' (local test)', avatarUrl: null, environment: 'sandbox' };
  }
  private player(value: string): asserts value is Player {
    if(value === 'guest') throw new Error('Sign in to use scores, cloud saves or payments.');
    localPlayer(value);
  }
  private recordKey(player: string, key: string) {
    this.player(player);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || key.startsWith('_spawn_')) throw new Error('Invalid record key.');
    return player + ':' + key;
  }
  balance(player: string) { if(player === 'guest') return 0; this.player(player); return this.economy.balance(player); }
  load(player: string, key: string) { return structuredClone(this.saves.get(this.recordKey(player, key)) ?? null); }
  save(player: string, key: string, value: unknown, version: number): Save<unknown> {
    const id = this.recordKey(player, key);
    if (!Number.isSafeInteger(version) || version < 0 || (this.saves.get(id)?.version ?? 0) !== version) throw new Error('Save changed; reload before saving.');
    const text = JSON.stringify(jsonSave(value));
    const own = [...this.saves].filter(([key]) => key.startsWith(player + ':') && key !== id);
    if (own.length >= 256 || own.reduce((sum, [, record]) => sum + new TextEncoder().encode(JSON.stringify(record.value)).byteLength, 0) + new TextEncoder().encode(text).byteLength > 1_048_576) throw new Error('Local player save limit reached.');
    const save = { value: JSON.parse(text) as unknown, version: version + 1, updatedAt: new Date().toISOString() };
    this.saves.set(id, save);
    return structuredClone(save);
  }
  score(player: string, score: number, details: unknown, submissionId?: string): SpawnScoreSubmission {
    this.player(player);
    if (!Number.isSafeInteger(score) || score < 0 || score > 1_000_000_000 || JSON.stringify(details ?? {}).length > 4000) throw new Error('Invalid local score.');
    if (submissionId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(submissionId)) throw new Error('submissionId must be a UUID.');
    const result: SpawnScoreSubmission = { id: 'local_' + player + '_' + (submissionId ?? crypto.randomUUID()), verification: 'unverified' };
    const prior = this.submissions.find(row => row.player === player && row.id === result.id);
    if (prior) {
      if (prior.score !== score || JSON.stringify(prior.details) !== JSON.stringify(details ?? {})) throw new Error('This submission ID was already used for another result.');
      return result;
    }
    this.scoreTimes.set(result.id, new Date().toISOString());
    this.submissions.unshift({ ...result, player, score, details: JSON.parse(JSON.stringify(details ?? {})) as unknown });
    for (const removed of this.submissions.splice(100)) this.scoreTimes.delete(removed.id);
    return result;
  }
  listSaves(player: string) {
    this.player(player);
    return { items: [...this.saves].filter(([key]) => key.startsWith(player + ':')).map(([key, record]) => ({ key: key.slice(player.length + 1), version: record.version, updatedAt: record.updatedAt })).sort((a, b) => a.key.localeCompare(b.key)) };
  }
  remove(player: string, key: string, version: number) {
    const id = this.recordKey(player, key);
    if (!Number.isSafeInteger(version) || version < 1 || this.saves.get(id)?.version !== version) throw new Error('Save changed; reload before deleting.');
    this.saves.delete(id);
    return { deleted: true as const };
  }
  getLeaderboard(query?: LeaderboardQuery): LeaderboardPage {
    const { limit, offset } = leaderboardQuery(query);
    if (!this.leaderboard.enabled) throw new Error('The creator has not enabled this leaderboard.');
    const { mode, direction } = this.leaderboard;
    const compare = (a: LocalScore, b: LocalScore) => direction === 'higher' ? b.score - a.score : a.score - b.score;
    let rows = [...this.submissions];
    if (mode === 'best') rows.reverse().sort(compare);
    if (mode !== 'all') rows = rows.filter((row, index, all) => all.findIndex(other => other.player === row.player) === index);
    rows.sort(compare);
    return { mode, direction, nextOffset: rows.length > offset + limit ? offset + limit : null,
      items: rows.slice(offset, offset + limit).map(row => {
        const { environment: _, ...player } = this.identity(row.player);
        return { id: row.id, score: row.score, verification: row.verification, submittedAt: this.scoreTimes.get(row.id)!, player };
      }) };
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
