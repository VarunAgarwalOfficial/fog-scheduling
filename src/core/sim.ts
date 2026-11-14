import type { Config, Task } from "./model.ts";
import type { Order, Policy } from "./policies.ts";

export type Place = "fog" | "cloud";

/** What happened to one finished task. */
export interface Outcome {
  task: Task;
  place: Place;
  /** Tick at which the answer was ready. */
  finished: number;
  /** Ticks from creation to answer. */
  response: number;
  late: boolean;
}

interface Running {
  task: Task;
  remaining: number;
}

interface FogNode {
  running: Running | null;
  waiting: Task[];
}

/** A read-only picture of the system after a tick, for display. */
export interface Snapshot {
  tick: number;
  /** Tasks held by each fog node (running plus waiting). */
  fogLoad: number[];
  fogBusy: boolean[];
  /** Tasks currently on the network towards the cloud. */
  inTransit: number;
  cloudBusy: number;
  cloudWaiting: number;
  /** Events of this tick. */
  arrivals: Task[];
  offloads: Task[];
  completed: Outcome[];
  done: boolean;
}

export interface Simulation {
  /** Advance one tick. */
  step(): Snapshot;
  readonly outcomes: Outcome[];
  readonly fogCost: number;
  readonly cloudCost: number;
  readonly done: boolean;
}

function takeFirst(queue: Task[], order: Order): Task | undefined {
  if (queue.length === 0) return undefined;
  let best = 0;
  for (let i = 1; i < queue.length; i++) {
    if (order(queue[i]!, queue[best]!) < 0) best = i;
  }
  return queue.splice(best, 1)[0];
}

function takeLast(queue: Task[], order: Order): Task {
  let worst = 0;
  for (let i = 1; i < queue.length; i++) {
    if (order(queue[i]!, queue[worst]!) > 0) worst = i;
  }
  return queue.splice(worst, 1)[0]!;
}

/**
 * Tick-based simulation of users, fog nodes and one cloud.
 *
 * Each tick, in order:
 *  1. new tasks reach their fog node, which keeps them or sends them to the cloud;
 *  2. tasks that have crossed the network join the cloud queue;
 *  3. every fog node and every cloud server works for one tick.
 * Scheduling is non-preemptive: a started task runs to completion.
 * `workload` must be sorted by arrival tick.
 */
export function createSimulation(config: Config, policy: Policy, workload: Task[]): Simulation {
  if (config.fogSpeed <= 0 || config.cloudSpeed <= 0) throw new Error("speeds must be positive");
  if (config.cloudServers < 1) throw new Error("at least one cloud server is required");
  if (config.fogCapacity < 1) throw new Error("fog capacity must be at least 1");

  const fogs: FogNode[] = Array.from({ length: config.fogNodes }, () => ({
    running: null,
    waiting: [],
  }));
  const transit: { task: Task; arrives: number }[] = [];
  const cloudWaiting: Task[] = [];
  const cloudRunning: Running[] = [];
  const outcomes: Outcome[] = [];
  let fogCost = 0;
  let cloudCost = 0;
  let tick = 0;
  let nextTask = 0;

  const finish = (task: Task, place: Place, completed: Outcome[]): void => {
    const finished = tick + 1;
    const response = finished - task.arrival;
    const outcome = { task, place, finished, response, late: response > task.deadline };
    outcomes.push(outcome);
    completed.push(outcome);
  };

  const isDone = (): boolean =>
    nextTask >= workload.length &&
    transit.length === 0 &&
    cloudWaiting.length === 0 &&
    cloudRunning.length === 0 &&
    fogs.every((fog) => fog.running === null && fog.waiting.length === 0);

  const step = (): Snapshot => {
    const arrivals: Task[] = [];
    const offloads: Task[] = [];
    const completed: Outcome[] = [];
    const offload = (task: Task): void => {
      offloads.push(task);
      transit.push({ task, arrives: tick + config.cloudLatency });
    };

    // 1. Arrivals and the keep-or-offload decision.
    while (nextTask < workload.length && workload[nextTask]!.arrival <= tick) {
      const task = workload[nextTask++]!;
      arrivals.push(task);
      const fog = fogs[task.fog];
      if (!fog) throw new Error(`task ${task.id} names fog node ${task.fog}, which does not exist`);
      if (!policy.admit(task)) {
        offload(task);
        continue;
      }
      fog.waiting.push(task);
      const held = fog.waiting.length + (fog.running ? 1 : 0);
      if (held > config.fogCapacity) offload(takeLast(fog.waiting, policy.fogOrder));
    }

    // 2. Tasks leave the network and join the cloud queue.
    for (let i = transit.length - 1; i >= 0; i--) {
      if (transit[i]!.arrives <= tick) cloudWaiting.push(transit.splice(i, 1)[0]!.task);
    }

    // 3a. Fog nodes work.
    for (const fog of fogs) {
      if (!fog.running) {
        const task = takeFirst(fog.waiting, policy.fogOrder);
        if (task) fog.running = { task, remaining: task.work };
      }
      if (!fog.running) continue;
      fogCost += config.fogCostPerTick;
      fog.running.remaining -= config.fogSpeed;
      if (fog.running.remaining <= 0) {
        finish(fog.running.task, "fog", completed);
        fog.running = null;
      }
    }

    // 3b. Cloud servers work.
    while (cloudRunning.length < config.cloudServers) {
      const task = takeFirst(cloudWaiting, policy.cloudOrder);
      if (!task) break;
      cloudCost += task.work * config.cloudCostPerUnit;
      cloudRunning.push({ task, remaining: task.work });
    }
    for (let i = cloudRunning.length - 1; i >= 0; i--) {
      const job = cloudRunning[i]!;
      job.remaining -= config.cloudSpeed;
      if (job.remaining <= 0) {
        finish(job.task, "cloud", completed);
        cloudRunning.splice(i, 1);
      }
    }

    const snapshot: Snapshot = {
      tick,
      fogLoad: fogs.map((fog) => fog.waiting.length + (fog.running ? 1 : 0)),
      fogBusy: fogs.map((fog) => fog.running !== null),
      inTransit: transit.length,
      cloudBusy: cloudRunning.length,
      cloudWaiting: cloudWaiting.length,
      arrivals,
      offloads,
      completed,
      done: isDone(),
    };
    tick++;
    return snapshot;
  };

  return {
    step,
    outcomes,
    get fogCost() {
      return fogCost;
    },
    get cloudCost() {
      return cloudCost;
    },
    get done() {
      return isDone();
    },
  };
}
