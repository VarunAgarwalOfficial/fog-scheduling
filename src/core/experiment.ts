import { type Result, runPolicy } from "./metrics.ts";
import type { Config } from "./model.ts";
import { type Policy, policies } from "./policies.ts";
import { buildTopology, generateWorkload } from "./workload.ts";

/** A mean with the half-width of its 95% confidence interval: mean ± half. */
export interface Interval {
  mean: number;
  half: number;
  /** Number of finite values the interval is based on. */
  n: number;
}

/** Two-sided 95% Student t quantiles for 1 to 30 degrees of freedom. */
const T975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];

/** The 0.975 quantile of Student's t distribution; a series expansion above 30 degrees. */
export function tQuantile(df: number): number {
  if (df < 1) return Number.NaN;
  if (df <= 30) return T975[Math.round(df) - 1]!;
  const z = 1.959964;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

/** Student t interval for the mean of independent values. NaN values are left out. */
export function interval(values: number[]): Interval {
  const xs = values.filter(Number.isFinite);
  const n = xs.length;
  if (n === 0) return { mean: Number.NaN, half: Number.NaN, n };
  const mean = xs.reduce((sum, x) => sum + x, 0) / n;
  if (n === 1) return { mean, half: Number.NaN, n };
  const variance = xs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1);
  return { mean, half: tQuantile(n - 1) * Math.sqrt(variance / n), n };
}

/** The measures that are compared across seeds. */
export const measures = [
  "meanResponse",
  "p95Response",
  "urgentResponse",
  "weightedResponse",
  "lowTail",
  "lateShare",
  "urgentLateShare",
  "fogShare",
  "totalCost",
] as const satisfies readonly (keyof Result)[];

export type Measure = (typeof measures)[number];

export interface Replicated {
  policy: Policy;
  /** One interval per measure, across seeds. */
  stats: Record<Measure, Interval>;
  /**
   * This policy minus first come, first served, seed by seed. Both ran on the same tasks,
   * so this interval is much narrower than the two separate ones suggest.
   */
  vsFirst: Record<Measure, Interval>;
  /** Mean response per priority (index 0 is priority 1), across seeds. */
  byPriority: Interval[];
}

export interface Experiment {
  config: Config;
  seeds: number[];
  /** Tasks per seed. */
  tasks: Interval;
  results: Replicated[];
}

/** Seeds used for `count` replications: the configured seed and the ones after it. */
export function seedsFor(config: Config, count: number): number[] {
  return Array.from({ length: Math.max(1, Math.floor(count)) }, (_, i) => config.seed + i);
}

/**
 * Run every policy on `count` independent workloads (one per seed; the network layout stays
 * the same) and summarise each measure as a 95% interval across seeds. Every policy sees the
 * same workload for a given seed. `onSeed` is called after each seed, for progress.
 */
export function replicate(
  config: Config,
  count: number,
  onSeed?: (done: number, total: number) => void,
): Experiment {
  const topology = buildTopology(config);
  const seeds = seedsFor(config, count);
  const runs: Result[][] = policies.map(() => []);
  const tasks: number[] = [];
  seeds.forEach((seed, i) => {
    const workload = generateWorkload(config, topology, seed);
    tasks.push(workload.length);
    policies.forEach((policy, p) => {
      runs[p]!.push(runPolicy(config, policy, workload));
    });
    onSeed?.(i + 1, seeds.length);
  });
  const first = runs[0]!;
  const results = policies.map((policy, p) => {
    const own = runs[p]!;
    const stats = {} as Record<Measure, Interval>;
    const vsFirst = {} as Record<Measure, Interval>;
    for (const m of measures) {
      stats[m] = interval(own.map((r) => r[m]));
      vsFirst[m] = interval(own.map((r, s) => r[m] - first[s]![m]));
    }
    const byPriority = own[0]!.responseByPriority.map((_, k) =>
      interval(own.map((r) => r.responseByPriority[k]!)),
    );
    return { policy, stats, vsFirst, byPriority };
  });
  return { config, seeds, tasks: interval(tasks), results };
}
