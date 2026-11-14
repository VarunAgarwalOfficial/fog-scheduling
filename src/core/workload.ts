import { type Config, MAX_PRIORITY, MIN_PRIORITY, type Task, type Topology } from "./model.ts";
import { createRng } from "./rng.ts";

/**
 * Place the cloud at the centre, fog nodes near it and users further out,
 * then attach every user to its nearest fog node.
 */
export function buildTopology(config: Config): Topology {
  if (config.fogNodes < 1) throw new Error("at least one fog node is required");
  const rng = createRng(config.seed);
  const fogs = Array.from({ length: config.fogNodes }, () => ({
    x: rng.int(-100, 100),
    y: rng.int(-100, 100),
  }));
  const users = Array.from({ length: config.users }, () => ({
    x: rng.int(-300, 300),
    y: rng.int(-300, 300),
  }));
  const userFog = users.map((user) => {
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    fogs.forEach((fog, i) => {
      const dist = Math.hypot(user.x - fog.x, user.y - fog.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  });
  return { cloud: { x: 0, y: 0 }, fogs, users, userFog };
}

/**
 * Create the full list of tasks up front, ordered by arrival tick.
 * Every policy is then run on this same list, so differences in the
 * results come from the policy and not from luck.
 */
export function generateWorkload(config: Config, topology: Topology): Task[] {
  // A different stream from the topology, so changing one does not shift the other.
  const rng = createRng(config.seed ^ 0x9e3779b9);
  const tasks: Task[] = [];
  for (let tick = 0; tick < config.ticks; tick++) {
    for (let user = 0; user < config.users; user++) {
      if (rng.next() >= config.arrivalProb) continue;
      tasks.push({
        id: tasks.length,
        user,
        fog: topology.userFog[user]!,
        arrival: tick,
        priority: rng.int(MIN_PRIORITY, MAX_PRIORITY),
        work: rng.int(1, 9),
        deadline: rng.int(5, 19),
      });
    }
  }
  return tasks;
}
