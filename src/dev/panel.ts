import type { LocalTestState } from './state.ts';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const names: Record<string, string> = { alice: 'Alice', bob: 'Bob', empty: 'Empty balance', creator: 'Creator wallet', pool: 'Game pool', platform: 'Spawn platform' };

/** Operator controls belong to the launcher, not to the untrusted game frame. */
export function createCreatorPanel(getState: () => LocalTestState, getPlayer: () => string, onRefresh: () => void = () => {}) {
  const amount = element<HTMLInputElement>('transfer-amount');
  const feedback = element('transfer-feedback');
  function refresh() {
    const state = getState(), player = getPlayer();
    element('balance').textContent = `${names[player]} · ${state.balance(player)} TEST`;
    element('platform-balance').textContent = `${state.economy.balance('platform')} TEST`;
    element('pool-balance').textContent = `${state.economy.balance('pool')} TEST`;
    element('creator-balance').textContent = `${state.economy.balance('creator')} TEST`;
    element('reward-player').textContent = `Reward ${names[player]}`;
    const history = element('history'); history.replaceChildren();
    for (const item of state.economy.history.slice(0, 12)) {
      const row = document.createElement('li');
      const title = document.createElement('strong'); title.textContent = `${item.amount} TEST · ${item.kind}`;
      const route = document.createElement('span'); route.textContent = `${names[item.from]} → ${names[item.to]} · ${item.netAmount} TEST received · ${item.platformFee} TEST Spawn fee`;
      const details = document.createElement('details'), summary = document.createElement('summary'), id = document.createElement('code');
      summary.textContent = 'Local receipt'; id.textContent = item.id; details.append(summary, id);
      row.append(title, route, details); history.append(row);
    }
    element('no-transactions').hidden = state.economy.history.length !== 0;
    const scores = element('scores'); scores.replaceChildren();
    for (const item of state.scores.slice(0, 5)) {
      const row = document.createElement('li'); row.textContent = `${names[item.player]} · ${item.score} · unverified`; scores.append(row);
    }
    element('no-scores').hidden = state.scores.length !== 0;
    onRefresh();
  }
  function transfer(kind: 'fund' | 'withdraw' | 'reward') {
    try {
      const state = getState(), quantity = amount.valueAsNumber;
      const receipt = kind === 'reward' ? state.economy.reward(getPlayer(), quantity) : state.economy[kind](quantity);
      feedback.textContent = `${receipt.amount} TEST paid; ${receipt.netAmount} to ${names[receipt.to]}, ${receipt.platformFee} Spawn fee.`;
      feedback.dataset.error = 'false';
      refresh();
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : 'Local transfer failed.';
      feedback.dataset.error = 'true';
    }
  }
  element('fund-pool').onclick = () => transfer('fund');
  element('withdraw-pool').onclick = () => transfer('withdraw');
  element('reward-player').onclick = () => transfer('reward');
  function reset() {
    amount.value = '10';
    feedback.textContent = 'Rewards go to the selected test player.';
    feedback.dataset.error = 'false';
    refresh();
  }
  return { refresh, reset };
}
