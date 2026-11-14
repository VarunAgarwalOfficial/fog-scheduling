import { parseArgs } from "node:util";
import { comparePolicies, type Result } from "./core/metrics.ts";
import { type Config, defaultConfig } from "./core/model.ts";
import { buildTopology, generateWorkload } from "./core/workload.ts";

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
} as const satisfies Record<string, keyof Config>;

function usage(): string {
  const lines = [
    "Usage: npm run compare -- [options]",
    "",
    "Runs every scheduling policy on the same generated workload and prints a comparison.",
    "",
    "Options (defaults in brackets):",
  ];
  for (const [flag, key] of Object.entries(numericOptions)) {
    lines.push(`  --${flag.padEnd(14)} [${defaultConfig[key]}]`);
  }
  lines.push("  --json           print the results as JSON", "  --help           show this text");
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

const fmt = (value: number, digits = 2): string =>
  Number.isNaN(value) ? "-" : value.toFixed(digits);
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  const line = (row: string[]): string =>
    row
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join("  ");
  const [head, ...body] = rows;
  return [line(head!), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

function report(config: Config, tasks: number, results: Result[]): string {
  const out: string[] = [];
  out.push(
    `${config.users} users, ${config.fogNodes} fog nodes, cloud of ${config.cloudServers} servers, ` +
      `${tasks} tasks over ${config.ticks} ticks, seed ${config.seed}`,
    "",
    "Response time is in ticks from request to answer. Urgent means priority 7 to 9.",
    "",
  );
  out.push(
    table([
      [
        "policy",
        "mean",
        "p95",
        "urgent",
        "late",
        "urgent late",
        "on fog",
        "fog cost",
        "cloud cost",
        "total",
      ],
      ...results.map((r) => [
        r.policy.label,
        fmt(r.meanResponse),
        fmt(r.p95Response, 0),
        fmt(r.urgentResponse),
        pct(r.lateShare),
        pct(r.urgentLateShare),
        pct(r.fogShare),
        fmt(r.fogCost, 0),
        fmt(r.cloudCost, 0),
        fmt(r.totalCost, 0),
      ]),
    ]),
    "",
    "Mean response time by priority",
    "",
  );
  out.push(
    table([
      ["policy", ...results[0]!.responseByPriority.map((_, i) => `p${i + 1}`)],
      ...results.map((r) => [r.policy.label, ...r.responseByPriority.map((v) => fmt(v))]),
    ]),
  );
  return out.join("\n");
}

function main(): void {
  const options: Record<string, { type: "string" | "boolean" }> = {
    json: { type: "boolean" },
    help: { type: "boolean" },
  };
  for (const flag of Object.keys(numericOptions)) options[flag] = { type: "string" };
  const { values } = parseArgs({ options });
  if (values.help) {
    console.log(usage());
    return;
  }
  const config = parseConfig(values);
  const workload = generateWorkload(config, buildTopology(config));
  const results = comparePolicies(config, workload);
  if (values.json) {
    const plain = results.map(({ policy, ...rest }) => ({ policy: policy.id, ...rest }));
    console.log(JSON.stringify({ config, tasks: workload.length, results: plain }, null, 2));
  } else {
    console.log(report(config, workload.length, results));
  }
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  console.error("Run with --help for the list of options.");
  process.exitCode = 1;
}
