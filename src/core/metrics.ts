import { type Config, MAX_PRIORITY, MIN_PRIORITY, type Task } from "./model.ts";
import { type Policy, policies } from "./policies.ts";
import { createSimulation, type Outcome } from "./sim.ts";

export interface Result {
  policy: Policy;
  tasks: number;
  meanResponse: number;
  p95Response: number;
  /** Mean response of tasks with priority 7 to 9. */
  urgentResponse: number;
  /** Mean response per priority; index 0 is priority 1. NaN when there were no such tasks. */
  responseByPriority: number[];
  /** Share of tasks answered after their deadline. */
  lateShare: number;
  urgentLateShare: number;
  /** Share of tasks that ran on a fog node. */
  fogShare: number;
  fogCost: number;
  cloudCost: number;
  totalCost: number;
  /** Tick at which the last task finished. */
  makespan: number;
}

export const URGENT_BAND = 7;

function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

export function summarise(
  policy: Policy,
  outcomes: Outcome[],
  fogCost: number,
  cloudCost: number,
): Result {
  const responses = outcomes.map((o) => o.response);
  const urgent = outcomes.filter((o) => o.task.priority >= URGENT_BAND);
  const responseByPriority: number[] = [];
  for (let p = MIN_PRIORITY; p <= MAX_PRIORITY; p++) {
    responseByPriority.push(
      mean(outcomes.filter((o) => o.task.priority === p).map((o) => o.response)),
    );
  }
  return {
    policy,
    tasks: outcomes.length,
    meanResponse: mean(responses),
    p95Response: percentile(responses, 95),
    urgentResponse: mean(urgent.map((o) => o.response)),
    responseByPriority,
    lateShare: share(outcomes.filter((o) => o.late).length, outcomes.length),
    urgentLateShare: share(urgent.filter((o) => o.late).length, urgent.length),
    fogShare: share(outcomes.filter((o) => o.place === "fog").length, outcomes.length),
    fogCost,
    cloudCost,
    totalCost: fogCost + cloudCost,
    makespan: outcomes.reduce((max, o) => Math.max(max, o.finished), 0),
  };
}

/** Run one policy until every task has been answered. */
export function runPolicy(config: Config, policy: Policy, workload: Task[]): Result {
  const sim = createSimulation(config, policy, workload);
  // Generous bound: a cloud that cannot keep up still drains at one task per few ticks.
  const limit = config.ticks + config.cloudLatency + workload.length * 10 + 100;
  for (let i = 0; !sim.done; i++) {
    if (i > limit) throw new Error("simulation did not finish; the model is stuck");
    sim.step();
  }
  return summarise(policy, sim.outcomes, sim.fogCost, sim.cloudCost);
}

/** Run every policy on the same workload. */
export function comparePolicies(config: Config, workload: Task[]): Result[] {
  return policies.map((policy) => runPolicy(config, policy, workload));
}
