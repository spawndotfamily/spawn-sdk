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
    const decimal = value => typeof value === 'string' && value.length <= 115 &&
      /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,36})?$/.test(value);
    const units = value => {
      const [whole, fraction = ''] = value.split('.');
      return BigInt(whole + fraction.padEnd(36, '0'));
    };
    if (result?.matchId !== definition.matchId.toLowerCase() || result.status !== 'cancelled' ||
        result.creationClosed !== true || result.remainingReservedAmount !== '0' ||
        typeof result.closedBeforeCreation !== 'boolean' || typeof result.reason !== 'string' ||
        !Number.isSafeInteger(result.cancelledAt) || result.cancelledAt < 0 ||
        !decimal(result.potAmount) || !decimal(definition.amount) ||
        !Array.isArray(result.refunds) || result.refunds.length > 2) return false;
    if (result.closedBeforeCreation) return result.potAmount === '0' && result.refunds.length === 0;
    const entry = units(definition.amount);
    const seen = new Set();
    return entry > 0n && units(result.potAmount) === entry * 2n && result.refunds.every(r => {
      if (typeof r.playerId !== 'string') return false;
      const id = r.playerId.toLowerCase();
      if (seen.has(id) || !definition.players.some(p => p.playerId.toLowerCase() === id) ||
          !decimal(r.amount) || units(r.amount) !== entry) return false;
      seen.add(id);
      return true;
    });
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
