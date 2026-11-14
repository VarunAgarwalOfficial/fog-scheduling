import type { Config, Task } from "./model.ts";

/**
 * Negative when `a` should run before `b`. Every order here is fixed once both tasks exist
 * (ageing included, see below), so a queue never has to be re-sorted as time passes.
 */
export type Order = (a: Task, b: Task, config: Config) => number;

export interface Policy {
  id: PolicyId;
  label: string;
  summary: string;
  /** Should a new task be kept at the fog node at all? Otherwise it goes straight to the cloud. */
  admit(task: Task): boolean;
  /** Order of the fog queue. When the node is full the task ranked last is sent to the cloud. */
  fogOrder: Order;
  /** Order of the cloud queue. */
  cloudOrder: Order;
}

export type PolicyId = "fcfs" | "priority" | "sjf" | "hybrid" | "wsjf" | "ageing";

/** Tasks below this priority are never worth a fog slot under the priority rules. */
export const URGENT_FROM = 5;

const byArrival: Order = (a, b) => a.arrival - b.arrival || a.id - b.id;
const byPriority: Order = (a, b, c) => b.priority - a.priority || byArrival(a, b, c);
const byWork: Order = (a, b, c) => a.work - b.work || byArrival(a, b, c);
const byPriorityThenWork: Order = (a, b, c) => b.priority - a.priority || byWork(a, b, c);

/**
 * Smith's rule: the smallest work per unit of priority first, that is work / priority
 * ascending (compared without division). Highest priority first among equal ratios.
 */
const byWorkPerPriority: Order = (a, b, c) =>
  a.work * b.priority - b.work * a.priority || byPriority(a, b, c);

/**
 * Priority with ageing: a waiting task gains one priority level every `config.ageing` ticks.
 * Task a is ahead of b at time t when
 *   a.priority + (t - a.arrival) / ageing > b.priority + (t - b.arrival) / ageing,
 * and t cancels, so the order is a fixed key: arrival - ageing * priority, smallest first.
 * A task can then only be overtaken by tasks that arrive at most 8 * ageing ticks after it.
 */
const byAgedPriority: Order = (a, b, c) =>
  a.arrival - c.ageing * a.priority - (b.arrival - c.ageing * b.priority) || byPriority(a, b, c);

const urgentOnly = (task: Task): boolean => task.priority >= URGENT_FROM;
const everyone = (): boolean => true;

/** In a fixed order: chart colours follow this order. */
export const policies: Policy[] = [
  {
    id: "fcfs",
    label: "First come, first served",
    summary: "Baseline. Run tasks in arrival order; a full fog node passes new tasks to the cloud.",
    admit: everyone,
    fogOrder: byArrival,
    cloudOrder: byArrival,
  },
  {
    id: "priority",
    label: "Priority",
    summary:
      "Fog nodes only take tasks of priority 5 and up and run the most urgent first. The cloud does the same.",
    admit: urgentOnly,
    fogOrder: byPriority,
    cloudOrder: byPriority,
  },
  {
    id: "sjf",
    label: "Shortest job first",
    summary:
      "Run the shortest task first everywhere. A full fog node sends its longest task to the cloud.",
    admit: everyone,
    fogOrder: byWork,
    cloudOrder: byWork,
  },
  {
    id: "hybrid",
    label: "SJF + priority",
    summary:
      "Fog nodes take priority 5 and up, most urgent first and shortest first among equals. The cloud runs the shortest first.",
    admit: urgentOnly,
    fogOrder: byPriorityThenWork,
    cloudOrder: byWork,
  },
  {
    id: "wsjf",
    label: "Weighted shortest job",
    summary:
      "Run the task with the least work per unit of priority first, everywhere (Smith's rule). Fog nodes take every task.",
    admit: everyone,
    fogOrder: byWorkPerPriority,
    cloudOrder: byWorkPerPriority,
  },
  {
    id: "ageing",
    label: "Priority with ageing",
    summary:
      "As Priority, but a waiting task gains one priority level every few ticks, so routine tasks cannot wait forever.",
    admit: urgentOnly,
    fogOrder: byAgedPriority,
    cloudOrder: byAgedPriority,
  },
];

export function getPolicy(id: string): Policy {
  const policy = policies.find((p) => p.id === id);
  if (!policy) {
    throw new Error(
      `unknown policy "${id}" (expected one of ${policies.map((p) => p.id).join(", ")})`,
    );
  }
  return policy;
}

/** The same ordering with every task admitted: used to study the order alone on one queue. */
export function orderOnly(policy: Policy): Policy {
  return { ...policy, admit: everyone };
}
