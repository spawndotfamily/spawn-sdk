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
    // This deliberately abandons the attempt. It never replays create and does not
    // require active launches. Spawn fences absent IDs and refunds pending matches
    // in the same serialized transaction as create/confirm/capture.
    const result = await matches.closeCreation(definition.matchId);
    if (result?.creationClosed !== true || typeof result.closedBeforeCreation !== 'boolean') return unresolved();
    if (!confirmedCancellation(result)) return unresolved();
    return { matchId: result.matchId, resolution: 'cancelled', replacementAllowed: true, result };
  } catch (error) {
    // Even a definite rejection of THIS request cannot erase an older timeout.
    return unresolved(error);
  }
}
