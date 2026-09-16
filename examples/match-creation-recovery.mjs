/**
 * Server-side example. Call deliberately, under your coordinator's per-match lock,
 * with the EXACT definition saved before the original create. Never broadcast
 * an approval request during recovery. Persist the returned result privately.
 * This example uses only the public SDK; it needs no platform operator access.
 */
export async function cancelUncertainCreation(matches, definition) {
  const unresolved = (error) => ({
    matchId: definition.matchId.toLowerCase(), resolution: 'unresolved', replacementAllowed: false,
    // SDK diagnostics only. Never serialize arbitrary transport errors or credentials.
    error: error?.name === 'SpawnMatchRequestError' && typeof error.toJSON === 'function'
      ? error.toJSON() : { code: 'RECOVERY_UNRESOLVED' },
  });
  function confirmedCancellation(result) {
    return result?.matchId === definition.matchId.toLowerCase() && result.status === 'cancelled' &&
      typeof result.reason === 'string' && Number.isSafeInteger(result.cancelledAt) &&
      result.cancelledAt >= 0 && typeof result.potAmount === 'string' &&
      /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(result.potAmount) &&
      Array.isArray(result.refunds) && result.refunds.length <= 2 &&
      result.refunds.every(r => definition.players.some(p => p.playerId.toLowerCase() === r.playerId) &&
        typeof r.amount === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(r.amount));
  }
  try {
    let state;
    try { state = await matches.status(definition.matchId); }
    catch (error) {
      if (error?.name !== 'SpawnMatchRequestError' || error.status !== 404) throw error;
      // Explicit same-ID reconciliation, NOT a retry with a new wager, roster or ID.
      // Spawn's immutable-ID create is idempotent, including after cancellation.
      state = await matches.create(definition);
    }
    if (state.status === 'running' || state.status === 'settled') {
      return { matchId: state.matchId, resolution: state.status, replacementAllowed: false };
    }
    const result = state.status === 'cancelled' ? state.result
      : state.status === 'pending' ? await matches.cancel(definition.matchId, 'technical') : null;
    if (!confirmedCancellation(result)) return unresolved();
    return { matchId: result.matchId, resolution: 'cancelled', replacementAllowed: true, result };
  } catch (error) {
    // Even a definite rejection of THIS request cannot erase an older timeout.
    return unresolved(error);
  }
}
