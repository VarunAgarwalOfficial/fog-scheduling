import { type Config, defaultConfig, type Task } from "../src/core/model.ts";

export function task(partial: Partial<Task> & { id: number }): Task {
  return { user: 0, fog: 0, arrival: 0, priority: 5, work: 3, deadline: 10, ...partial };
}

/** One fog node, one cloud server, round numbers, so runs can be worked out by hand. */
export const tiny: Config = {
  ...defaultConfig,
  users: 1,
  fogNodes: 1,
  ticks: 10,
  fogSpeed: 3,
  fogCapacity: 2,
  fogCostPerTick: 2,
  cloudSpeed: 4,
  cloudServers: 1,
  cloudCostPerUnit: 1,
  cloudLatency: 3,
};
