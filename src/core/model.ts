/** One unit of work requested by a user device. */
export interface Task {
  id: number;
  /** Index of the user that created it. */
  user: number;
  /** Index of the fog node that user is attached to. */
  fog: number;
  /** Tick at which the task is created. */
  arrival: number;
  /** 1 (can wait) to 9 (emergency). */
  priority: number;
  /** Amount of work, in work units. */
  work: number;
  /** The answer is late if it takes more than this many ticks. */
  deadline: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Topology {
  cloud: Point;
  fogs: Point[];
  users: Point[];
  /** For each user, the index of its nearest fog node. */
  userFog: number[];
}

export interface Config {
  seed: number;
  users: number;
  fogNodes: number;
  /** Number of ticks during which users create tasks. */
  ticks: number;
  /** Chance that a user creates a task on a given tick. */
  arrivalProb: number;
  /** Work units a fog node finishes per tick. */
  fogSpeed: number;
  /** Tasks a fog node can hold, counting the one it is running. */
  fogCapacity: number;
  /** A fog node is reserved hardware: it is charged per busy tick. */
  fogCostPerTick: number;
  /** Work units one cloud server finishes per tick. */
  cloudSpeed: number;
  /** The cloud is elastic up to this many servers. */
  cloudServers: number;
  /** The cloud is pay per use: it is charged per work unit. */
  cloudCostPerUnit: number;
  /** Ticks a task spends on the network when it is sent to the cloud. */
  cloudLatency: number;
}

export const defaultConfig: Config = {
  seed: 2,
  users: 50,
  fogNodes: 5,
  ticks: 2000,
  arrivalProb: 0.2,
  fogSpeed: 3,
  fogCapacity: 2,
  fogCostPerTick: 2,
  cloudSpeed: 4,
  cloudServers: 14,
  cloudCostPerUnit: 1,
  cloudLatency: 3,
};

export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 9;
