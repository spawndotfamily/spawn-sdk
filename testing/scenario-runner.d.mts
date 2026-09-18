/**
 * Types for the shared scenario runner. Ships with the package so a creator (or their agent) can
 * add outcome rules with full signatures.
 */

export interface Scenario {
  name: string;
  /** Throws on failure — use `node:assert/strict`. */
  run: () => void | Promise<void>;
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ScenarioSummary {
  title: string;
  total: number;
  passed: number;
  failed: number;
  results: ScenarioResult[];
}

export interface RunnerOptions {
  /** Print the summary as JSON instead of prose (per-scenario lines are suppressed). */
  json?: boolean;
  title?: string;
  log?: (...args: unknown[]) => void;
}

/** True when `--json` is present in argv. */
export function wantsJson(argv?: readonly string[]): boolean;

/** Assert the money invariant, stating the imbalance in the failure message. */
export function checkConservation(
  service: { conservation(): { balanced: boolean; detail: string } },
  note?: string,
): void;

export function executeScenario(
  name: string,
  run: () => void | Promise<void>,
  options?: RunnerOptions,
): Promise<ScenarioResult>;

export function summarize(results: ScenarioResult[], options?: RunnerOptions): ScenarioSummary;

/** Run `[{ name, run }, ...]` in order and return the summary (assert on `summary.failed`). */
export function runScenarios(scenarios: Scenario[], options?: RunnerOptions): Promise<ScenarioSummary>;
