import type { Task } from "./model.ts";

/** Negative when `a` should run before `b`. */
export type Order = (a: Task, b: Task) => number;

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

export type PolicyId = "fcfs" | "priority" | "sjf" | "hybrid";

/** Tasks below this priority are never worth a fog slot under the priority rules. */
export const URGENT_FROM = 5;

const byArrival: Order = (a, b) => a.arrival - b.arrival || a.id - b.id;
const byPriority: Order = (a, b) => b.priority - a.priority || byArrival(a, b);
const byWork: Order = (a, b) => a.work - b.work || byArrival(a, b);
const byPriorityThenWork: Order = (a, b) => b.priority - a.priority || byWork(a, b);

export const policies: Policy[] = [
  {
    id: "fcfs",
    label: "First come, first served",
    summary: "Baseline. Run tasks in arrival order; a full fog node passes new tasks to the cloud.",
    admit: () => true,
    fogOrder: byArrival,
    cloudOrder: byArrival,
  },
  {
    id: "priority",
    label: "Priority",
    summary:
      "Fog nodes only take tasks of priority 5 and up and run the most urgent first. The cloud does the same.",
    admit: (task) => task.priority >= URGENT_FROM,
    fogOrder: byPriority,
    cloudOrder: byPriority,
  },
  {
    id: "sjf",
    label: "Shortest job first",
    summary:
      "Run the shortest task first everywhere. A full fog node sends its longest task to the cloud.",
    admit: () => true,
    fogOrder: byWork,
    cloudOrder: byWork,
  },
  {
    id: "hybrid",
    label: "SJF + priority",
    summary:
      "Fog nodes take priority 5 and up, most urgent first and shortest first among equals. The cloud runs the shortest first.",
    admit: (task) => task.priority >= URGENT_FROM,
    fogOrder: byPriorityThenWork,
    cloudOrder: byWork,
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
