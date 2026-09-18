/**
 * Shared scenario runner for the loopback table harness.
 *
 * Use it when you add your own outcome rules (who wins, rake, blinds, ties, voids) so your
 * scenarios run through the same runner the SDK ships and produce identical output:
 *
 *   import { runScenarios, checkConservation, wantsJson } from
 *     '@spawndotfamily/sdk/testing/scenario-runner.mjs';
 *
 *   const summary = await runScenarios([
 *     { name: 'house takes a 5% rake', async () => { ... assert ... } },
 *   ], { json: wantsJson() });
 *   process.exitCode = summary.failed === 0 ? 0 : 1;
 *
 * A scenario is `{ name, run }`; `run` throws on failure (use `node:assert/strict`).
 * `summary.results` is `[{ name, ok, error? }]`, so an agent can assert on the run without
 * parsing console text. `--json` prints that summary as JSON instead of prose.
 */
import assert from 'node:assert/strict';

/** True when `--json` is present in argv (pass your own argv when testing). */
export function wantsJson(argv = process.argv) {
  return argv.includes('--json');
}

/** Assert the money invariant, with the imbalance stated in the failure message. */
export function checkConservation(service, note = 'conservation broken') {
  const { balanced, detail } = service.conservation();
  assert.equal(balanced, true, `${note}: ${detail}`);
}

/**
 * Run one scenario, printing `PASS`/`FAIL` (and the failure message) unless `json`.
 * Returns `{ name, ok, error? }`.
 */
export async function executeScenario(name, run, { json = false, log = console.log } = {}) {
  try {
    await run();
    if (!json) log(`PASS  ${name}`);
    return { name, ok: true };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!json) {
      log(`FAIL  ${name}`);
      log(`      ${message}`);
    }
    return { name, ok: false, error: message };
  }
}

/**
 * Print (or emit) the run summary. Returns `{ title, total, passed, failed, results }`.
 */
export function summarize(results, { json = false, title = 'table scenarios', log = console.log } = {}) {
  const failed = results.filter((result) => !result.ok);
  const summary = {
    title,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  if (json) log(JSON.stringify(summary, null, 2));
  else {
    log('');
    log(`${summary.passed}/${summary.total} scenarios passed`);
    if (failed.length > 0) log('Failed:', failed.map((result) => result.name).join(', '));
  }
  return summary;
}

/** Declare-and-run form: `await runScenarios([{ name, run }, ...], { json })`. */
export async function runScenarios(scenarios, options = {}) {
  const results = [];
  for (const { name, run } of scenarios) results.push(await executeScenario(name, run, options));
  return summarize(results, options);
}
