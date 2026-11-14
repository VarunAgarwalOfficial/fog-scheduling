/**
 * The network with everything but one queue taken away, to check the simulator and the
 * ordering rules against queueing theory: one fog node that never sends work away, so it is
 * a single server with many users, each sending a task on a tick with a small probability.
 */
import { type Experiment, type Interval, interval } from "./experiment.ts";
import { type Config, defaultConfig, MIN_PRIORITY, type Task } from "./model.ts";
import { orderOnly, type Policy, policies } from "./policies.ts";
import { createSimulation } from "./sim.ts";
import { buildTopology, generateWorkload } from "./workload.ts";

const WORK = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Utilisations used for the load sweep in the browser view. */
export const LOADS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** Ticks the single server needs for a task. */
export const serviceTicks = (task: Task, config: Config): number =>
  Math.ceil(task.work / config.fogSpeed);

/** One fog node, nothing offloaded, at the given utilisation (busy share of ticks). */
export function singleQueue(load: number, base: Partial<Config> = {}): Config {
  const config: Config = {
    ...defaultConfig,
    users: 50,
    ticks: 20000,
    fogSpeed: 1,
    ...base,
    fogNodes: 1,
    fogCapacity: Number.MAX_SAFE_INTEGER,
  };
  const meanService = WORK.reduce((s, w) => s + Math.ceil(w / config.fogSpeed), 0) / WORK.length;
  return { ...config, arrivalProb: load / (config.users * meanService) };
}

/**
 * Mean wait (ticks from arrival to start of service) of first come, first served on this
 * queue, exactly. Each tick A tasks arrive, A ~ Binomial(users, p), and bring B ticks of
 * work. The work left at the start of a tick, U, follows U' = max(U + B - 1, 0), whose
 * stationary mean is (E[B^2] - rho) / (2 (1 - rho)), with rho = E[B] the utilisation.
 * A task waits for U plus the work of the tasks ahead of it in its own tick, on average
 * E[A(A - 1)] / (2 E[A]) * E[S] = (users - 1) p E[S] / 2. This is the discrete-time form
 * of the Pollaczek-Khinchine formula.
 */
export function firstComeWait(config: Config): number {
  const service = WORK.map((w) => Math.ceil(w / config.fogSpeed));
  const es = service.reduce((s, x) => s + x, 0) / service.length;
  const es2 = service.reduce((s, x) => s + x * x, 0) / service.length;
  const n = config.users;
  const p = config.arrivalProb;
  const arrivals = n * p;
  const rho = arrivals * es;
  if (rho >= 1) return Number.POSITIVE_INFINITY;
  const varB = arrivals * (es2 - es * es) + n * p * (1 - p) * es * es;
  const eb2 = varB + rho * rho;
  return (eb2 - rho) / (2 * (1 - rho)) + ((n - 1) * p * es) / 2;
}

export interface QueueRun {
  meanWait: number;
  /** Wait weighted by priority: what Smith's rule minimises. */
  weightedWait: number;
  /** Wait weighted by service time. The same for every order on the same tasks. */
  workWeightedWait: number;
  /** 99th percentile wait of priority 1 tasks. */
  lowTailWait: number;
}

/** Run one ordering rule on one queue; admission is ignored, every task is served there. */
export function runQueue(config: Config, policy: Policy, workload: Task[]): QueueRun {
  const sim = createSimulation(config, orderOnly(policy), workload);
  while (!sim.done) sim.step();
  let wait = 0;
  let byPriority = 0;
  let priorities = 0;
  let byWork = 0;
  let work = 0;
  const low: number[] = [];
  for (const o of sim.outcomes) {
    if (o.place !== "fog") throw new Error("a task left the single queue");
    const service = serviceTicks(o.task, config);
    const w = o.response - service;
    wait += w;
    byPriority += o.task.priority * w;
    priorities += o.task.priority;
    byWork += service * w;
    work += service;
    if (o.task.priority === MIN_PRIORITY) low.push(w);
  }
  low.sort((a, b) => a - b);
  const n = sim.outcomes.length;
  return {
    meanWait: wait / n,
    weightedWait: byPriority / priorities,
    workWeightedWait: byWork / work,
    lowTailWait: low.length ? low[Math.max(0, Math.ceil(0.99 * low.length) - 1)]! : Number.NaN,
  };
}

export interface LoadPoint {
  load: number;
  formula: number;
  /** Per policy, in the order of `policies`. */
  runs: Record<keyof QueueRun, Interval>[];
}

/** Every ordering rule at each load, `seeds` independent workloads per load. */
export function sweepLoads(
  loads: number[],
  seeds: Experiment["seeds"],
  base: Partial<Config> = {},
): LoadPoint[] {
  return loads.map((load) => {
    const config = singleQueue(load, base);
    const topology = buildTopology(config);
    const perPolicy: QueueRun[][] = policies.map(() => []);
    for (const seed of seeds) {
      const workload = generateWorkload(config, topology, seed);
      policies.forEach((policy, p) => {
        perPolicy[p]!.push(runQueue(config, policy, workload));
      });
    }
    const runs = perPolicy.map((list) => ({
      meanWait: interval(list.map((r) => r.meanWait)),
      weightedWait: interval(list.map((r) => r.weightedWait)),
      workWeightedWait: interval(list.map((r) => r.workWeightedWait)),
      lowTailWait: interval(list.map((r) => r.lowTailWait)),
    }));
    return { load, formula: firstComeWait(config), runs };
  });
}
