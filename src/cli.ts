import { parseArgs } from "node:util";
import { type Experiment, type Interval, replicate, seedsFor } from "./core/experiment.ts";
import { type Config, defaultConfig } from "./core/model.ts";
import { policies } from "./core/policies.ts";
import { type LoadPoint, singleQueue, sweepLoads } from "./core/theory.ts";

const numericOptions = {
  seed: "seed",
  users: "users",
  "fog-nodes": "fogNodes",
  ticks: "ticks",
  "arrival-prob": "arrivalProb",
  "fog-speed": "fogSpeed",
  "fog-capacity": "fogCapacity",
  "fog-cost": "fogCostPerTick",
  "cloud-speed": "cloudSpeed",
  "cloud-servers": "cloudServers",
  "cloud-cost": "cloudCostPerUnit",
  "cloud-latency": "cloudLatency",
  ageing: "ageing",
} as const satisfies Record<string, keyof Config>;

const DEFAULT_SEEDS = 10;
const LOADS = [0.3, 0.5, 0.7, 0.8, 0.9];

function usage(): string {
  const lines = [
    "Usage: npm run compare -- [options]",
    "       npm run theory -- [--seeds N] [--seed N]",
    "",
    "compare  runs every scheduling policy on the same generated workloads, one per seed,",
    "         and prints each measure as a mean with its 95% confidence interval.",
    "theory   runs the ordering rules on a single queue at several loads and compares",
    "         first come, first served with the exact formula for that queue.",
    "",
    "Options (defaults in brackets):",
  ];
  for (const [flag, key] of Object.entries(numericOptions)) {
    lines.push(`  --${flag.padEnd(14)} [${defaultConfig[key]}]`);
  }
  lines.push(
    `  --seeds          [${DEFAULT_SEEDS}] number of workloads; seeds run from --seed upwards`,
    "  --json           print the results as JSON",
    "  --help           show this text",
  );
  return lines.join("\n");
}

function parseConfig(values: Record<string, string | boolean | undefined>): Config {
  const config: Config = { ...defaultConfig };
  for (const [flag, key] of Object.entries(numericOptions)) {
    const raw = values[flag];
    if (typeof raw !== "string") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`--${flag} needs a number, got "${raw}"`);
    config[key] = value;
  }
  if (config.arrivalProb > 1) throw new Error("--arrival-prob must be between 0 and 1");
  return config;
}

function parseSeeds(raw: string | boolean | undefined): number {
  if (typeof raw !== "string") return DEFAULT_SEEDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 2 || value > 1000)
    throw new Error(`--seeds needs a whole number from 2 to 1000, got "${raw}"`);
  return value;
}

const fmt = (value: number, digits = 2): string =>
  Number.isFinite(value) ? value.toFixed(digits) : "-";
const ci = (i: Interval, digits = 2, scale = 1): string =>
  `${fmt(i.mean * scale, digits)} ± ${fmt(i.half * scale, digits)}`;

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  const line = (row: string[]): string =>
    row
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join("  ");
  const [head, ...body] = rows;
  return [line(head!), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

function compareReport(e: Experiment): string {
  const c = e.config;
  const out: string[] = [
    `${c.users} users, ${c.fogNodes} fog nodes, cloud of ${c.cloudServers} servers, ` +
      `${c.ticks} ticks, about ${Math.round(e.tasks.mean)} tasks per seed, ` +
      `seeds ${e.seeds[0]} to ${e.seeds.at(-1)}`,
    "",
    "Each cell is the mean over seeds with its 95% confidence interval. Response time is in",
    "ticks from request to answer. Urgent means priority 7 to 9; weighted weighs each task",
    "by its priority; p1 tail is the 99th percentile response of priority 1 tasks.",
    "",
    table([
      ["policy", "mean", "weighted", "urgent", "p1 tail", "urgent late", "on fog", "total cost"],
      ...e.results.map(({ policy, stats: s }) => [
        policy.label,
        ci(s.meanResponse),
        ci(s.weightedResponse),
        ci(s.urgentResponse),
        ci(s.lowTail, 0),
        `${ci(s.urgentLateShare, 1, 100)}%`,
        `${ci(s.fogShare, 1, 100)}%`,
        ci(s.totalCost, 0),
      ]),
    ]),
    "",
    "Difference from first come, first served on the same tasks, seed by seed",
    "",
    table([
      ["policy", "mean", "weighted", "urgent", "p1 tail", "total cost"],
      ...e.results
        .slice(1)
        .map(({ policy, vsFirst: d }) => [
          policy.label,
          ci(d.meanResponse),
          ci(d.weightedResponse),
          ci(d.urgentResponse),
          ci(d.lowTail, 0),
          ci(d.totalCost, 0),
        ]),
    ]),
    "",
    "Mean response time by priority",
    "",
    table([
      ["policy", ...e.results[0]!.byPriority.map((_, i) => `p${i + 1}`)],
      ...e.results.map((r) => [r.policy.label, ...r.byPriority.map((v) => fmt(v.mean))]),
    ]),
  ];
  return out.join("\n");
}

function theoryReport(points: LoadPoint[], seeds: number[], base: Partial<Config>): string {
  const config = singleQueue(points[0]!.load, base);
  const out: string[] = [
    `One queue: one fog node at speed ${config.fogSpeed} that keeps every task, ${config.users} users,`,
    `${config.ticks} ticks, work 1 to 9 units, seeds ${seeds[0]} to ${seeds.at(-1)}. Waits are in ticks`,
    "from arrival to start of service, mean ± 95% interval over seeds.",
    "",
    "First come, first served against the exact mean wait for this queue",
    "",
    table([
      ["load", "simulated", "formula", "inside"],
      ...points.map((pt) => {
        const s = pt.runs[0]!.meanWait;
        const inside = Math.abs(s.mean - pt.formula) <= s.half;
        return [pt.load.toFixed(2), ci(s), fmt(pt.formula), inside ? "yes" : "no"];
      }),
    ]),
    "",
  ];
  const block = (title: string, key: "meanWait" | "weightedWait" | "lowTailWait", digits = 2) => {
    out.push(
      title,
      "",
      table([
        ["load", ...policies.map((p) => p.label)],
        ...points.map((pt) => [
          pt.load.toFixed(2),
          ...pt.runs.map((r) => fmt(r[key].mean, digits)),
        ]),
      ]),
      "",
    );
  };
  block("Mean wait (shortest job first should be lowest)", "meanWait");
  block("Priority-weighted mean wait (weighted shortest job should be lowest)", "weightedWait");
  block("99th percentile wait of priority 1 tasks (starvation)", "lowTailWait", 0);
  const spread = points.map((pt) => {
    const values = pt.runs.map((r) => r.workWeightedWait.mean);
    return Math.max(...values) - Math.min(...values);
  });
  out.push(
    "Work-weighted mean wait, the conservation law: the same for every order on the same tasks.",
    `Largest difference between orders at any load: ${
      Math.max(...spread) < 1e-9
        ? "none beyond rounding error"
        : `${Math.max(...spread).toExponential(1)} ticks`
    }.`,
  );
  return out.join("\n");
}

function main(): void {
  const options: Record<string, { type: "string" | "boolean" }> = {
    json: { type: "boolean" },
    help: { type: "boolean" },
    seeds: { type: "string" },
  };
  for (const flag of Object.keys(numericOptions)) options[flag] = { type: "string" };
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  if (values.help) {
    console.log(usage());
    return;
  }
  const command = positionals[0] ?? "compare";
  if (positionals.length > 1 || !["compare", "theory"].includes(command))
    throw new Error(`unknown command "${positionals.join(" ")}"`);
  const config = parseConfig(values);
  const count = parseSeeds(values.seeds);
  if (command === "theory") {
    const seeds = seedsFor(config, count);
    const base: Partial<Config> = {};
    if (typeof values.ticks === "string") base.ticks = config.ticks;
    const points = sweepLoads(LOADS, seeds, base);
    if (values.json) console.log(JSON.stringify({ seeds, points }, null, 2));
    else console.log(theoryReport(points, seeds, base));
    return;
  }
  const experiment = replicate(config, count);
  if (values.json) {
    const results = experiment.results.map(({ policy, ...rest }) => ({
      policy: policy.id,
      ...rest,
    }));
    console.log(JSON.stringify({ ...experiment, results }, null, 2));
  } else {
    console.log(compareReport(experiment));
  }
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  console.error("Run with --help for the list of options.");
  process.exitCode = 1;
}
