// Type-checks the shipped harness declarations the way a consumer would use them.
//
// This file is NOT executed (it is `.consumer.ts`, not `.test.ts`); it exists so
// `npm run check` fails if `testing/*.d.mts` stops describing the real surface. It was
// added because a creator-side agent could not verify the declarations in its own
// sandbox — CI should be the witness, not a report.
import { createLoopbackTableService, stubClient } from '@spawndotfamily/sdk/testing/loopback-table-service.mjs';
import { runFleet } from '@spawndotfamily/sdk/testing/table-fleet.mjs';
import { runScenarios, checkConservation, executeScenario, summarize, wantsJson } from '@spawndotfamily/sdk/testing/scenario-runner.mjs';

const service = createLoopbackTableService({ now: () => Date.now() });
const funded = createLoopbackTableService({ balances: { 'player-1': '1000', 'player-2': 500 } });
const trackedBalance: string | null = funded.balance('player-1');

// Amounts are base-unit strings; the snapshot and conservation shapes are typed.
const buyIns: string = service.state('player-1').totals.buyIns;
const pendingQuote = service.state('player-1').pendingQuote;
const conservation: { balanced: boolean; delta: string; detail: string } = service.conservation();
const advanced: unknown = service.advance(30_000);
const seat = service.reconnect('player-1');
service.confirmBuyIn('player-1');
service.loseNextResponse('commitHand');
checkConservation(service, 'after settle');

// stubbing one method keeps the rest of the client typed
const wrapped = stubClient(service.client, { settleHand: async () => { throw new Error('offline'); } } as never);
const fromService = service.stubClient({});

const summary = await runScenarios(
  [{ name: 'mine', run: () => { void conservation.delta; } }],
  { json: wantsJson([]), title: 'types' },
);
const one: { name: string; ok: boolean; error?: string } = await executeScenario('x', () => {});
const printed: { total: number; passed: number; failed: number } = summarize([one], { json: true });

// the fleet driver is typed too: options in, per-table + aggregate report out
const fleet = await runFleet({ players: 18, maxSeats: 6 });
const fleetBalanced: boolean = fleet.balanced && fleet.aggregate.balanced;
const fleetRefusals: number = fleet.refusals.insufficientBalance + fleet.refusals.zeroBalance;
const fleetTableBuyIns: string = fleet.perTable[0]!.totals.buyIns;

void buyIns;
void pendingQuote;
void advanced;
void seat;
void wrapped;
void fromService;
void summary.results;
void printed.failed;
void trackedBalance;
void fleetBalanced;
void fleetRefusals;
void fleetTableBuyIns;
