export type Save<T> = { value: T; version: number; updatedAt: string };
/** First-party same-origin prototype. Never supplies private keys or writes token balances. */
export function createSpawnClient(gameId: string) {
  if (gameId !== 'rob-the-rich')
    throw new Error('Game is not enabled for this SDK prototype.');
  async function request<T>(key: string, init?: RequestInit): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key))
      throw new Error('Invalid save key.');
    const response = await fetch('/api/v1/game-storage/' + gameId + '/' + key, {
      credentials: 'same-origin',
      ...init,
    });
    const result = await response.json();
    if (!response.ok) {
      const message =
        typeof result === 'object' &&
        result !== null &&
        'error' in result &&
        typeof result.error === 'string'
          ? result.error
          : 'Spawn request failed.';
      throw new Error(message);
    }
    return result as T;
  }
  return {
    load: <T>(key: string) => request<Save<T> | null>(key),
    save: <T>(key: string, value: T, expectedVersion: number) =>
      request<Save<T>>(key, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, expectedVersion }),
      }),
  };
}
