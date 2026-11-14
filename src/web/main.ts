import { comparePolicies, type Result } from "../core/metrics.ts";
import { type Config, defaultConfig, type Task, type Topology } from "../core/model.ts";
import { getPolicy, policies } from "../core/policies.ts";
import { createSimulation, type Simulation } from "../core/sim.ts";
import { buildTopology, generateWorkload } from "../core/workload.ts";
import { barChart, lineChart } from "./charts.ts";
import { NetworkView } from "./network.ts";

interface Field {
  key: keyof Config;
  label: string;
  min: number;
  max: number;
  step: number;
}

const fields: Field[] = [
  { key: "users", label: "Users", min: 1, max: 200, step: 1 },
  { key: "fogNodes", label: "Fog nodes", min: 1, max: 20, step: 1 },
  { key: "arrivalProb", label: "Task chance per tick", min: 0.01, max: 1, step: 0.01 },
  { key: "fogCapacity", label: "Fog capacity (tasks)", min: 1, max: 20, step: 1 },
  { key: "cloudServers", label: "Cloud servers", min: 1, max: 200, step: 1 },
  { key: "cloudLatency", label: "Cloud delay (ticks)", min: 0, max: 30, step: 1 },
  { key: "ticks", label: "Ticks", min: 50, max: 10000, step: 50 },
  { key: "seed", label: "Seed", min: 0, max: 999999, step: 1 },
];

const seriesColor = ["--series-1", "--series-2", "--series-3", "--series-4"].map(
  (name) => `var(${name})`,
);
const colorOf = (policyId: string): string =>
  seriesColor[policies.findIndex((p) => p.id === policyId)]!;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const fmt = (value: number, digits = 2): string =>
  Number.isFinite(value) ? value.toFixed(digits) : "-";
const whole = (value: number): string =>
  Number.isFinite(value) ? Math.round(value).toLocaleString("en") : "-";
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

let config: Config = { ...defaultConfig };
let topology: Topology = buildTopology(config);
let workload: Task[] = generateWorkload(config, topology);
let sim: Simulation;
let playing = true;
/** Simulated time in ticks; the whole part is the number of ticks already run. */
let clock = 0;
let stepsRun = 0;
let lastFrame = 0;

const view = new NetworkView($<HTMLCanvasElement>("network"), topology, config);

function buildControls(): void {
  const form = $<HTMLFormElement>("controls");
  for (const field of fields) {
    const label = document.createElement("label");
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type = "number";
    input.name = field.key;
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    input.value = String(config[field.key]);
    label.append(input);
    form.append(label);
  }
  form.addEventListener("change", () => {
    const next: Config = { ...config };
    for (const field of fields) {
      const input = form.elements.namedItem(field.key) as HTMLInputElement;
      const value = Number(input.value);
      const valid = Number.isFinite(value) && value >= field.min && value <= field.max;
      if (valid) next[field.key] = value;
      else input.value = String(config[field.key]);
    }
    config = next;
    rebuild();
  });
  form.addEventListener("submit", (event) => event.preventDefault());

  const select = $<HTMLSelectElement>("policy");
  for (const policy of policies) select.add(new Option(policy.label, policy.id));
  select.value = "priority";
  select.addEventListener("change", restart);
  $("restart").addEventListener("click", restart);
  $("play").addEventListener("click", () => {
    playing = !playing;
    $("play").textContent = playing ? "Pause" : "Play";
  });
}

function rebuild(): void {
  topology = buildTopology(config);
  workload = generateWorkload(config, topology);
  renderComparison(comparePolicies(config, workload));
  restart();
}

function restart(): void {
  const policy = getPolicy($<HTMLSelectElement>("policy").value);
  $("policy-summary").textContent = policy.summary;
  sim = createSimulation(config, policy, workload);
  view.reset(topology, config);
  clock = 0;
  stepsRun = 0;
  renderLive();
}

function renderLive(): void {
  const outcomes = sim.outcomes;
  const mean = outcomes.reduce((sum, o) => sum + o.response, 0) / outcomes.length;
  const urgent = outcomes.filter((o) => o.task.priority >= 7);
  const urgentMean = urgent.reduce((sum, o) => sum + o.response, 0) / urgent.length;
  const stats: [string, string, string][] = [
    ["Tick", String(stepsRun), "tick"],
    ["Tasks answered", `${outcomes.length} / ${workload.length}`, "answered"],
    ["Mean response", fmt(mean), "mean"],
    ["Urgent response", fmt(urgentMean), "urgent"],
    ["Cost so far", whole(sim.fogCost + sim.cloudCost), "cost"],
  ];
  $("live").replaceChildren(
    ...stats.map(([name, value, id]) => {
      const wrap = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = name;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dd.dataset.stat = id;
      wrap.append(dt, dd);
      return wrap;
    }),
  );
}

function renderComparison(results: Result[]): void {
  $("workload-note").textContent =
    `${workload.length.toLocaleString("en")} tasks, the same for every policy`;
  const bars = (pick: (r: Result) => number) =>
    results.map((r) => ({ label: r.policy.label, value: pick(r), color: colorOf(r.policy.id) }));
  barChart(
    $("chart-mean"),
    "Mean response time",
    "ticks, all tasks",
    bars((r) => r.meanResponse),
    fmt,
  );
  barChart(
    $("chart-urgent"),
    "Urgent response time",
    "ticks, priority 7 to 9",
    bars((r) => r.urgentResponse),
    fmt,
  );
  barChart(
    $("chart-cost"),
    "Total cost",
    "fog busy ticks + cloud work",
    bars((r) => r.totalCost),
    whole,
  );
  barChart(
    $("chart-late"),
    "Urgent tasks answered late",
    "share past their deadline",
    bars((r) => r.urgentLateShare * 100),
    (v) => `${fmt(v, 1)}%`,
  );
  lineChart(
    $("chart-priority"),
    "Mean response time by priority",
    "ticks; 1 can wait, 9 is an emergency",
    results[0]!.responseByPriority.map((_, i) => String(i + 1)),
    results.map((r) => ({
      label: r.policy.label,
      color: colorOf(r.policy.id),
      values: r.responseByPriority,
    })),
    (v) => fmt(v, v >= 100 ? 0 : 1),
  );

  const head = [
    "Policy",
    "Mean",
    "95th pct",
    "Urgent",
    "Late",
    "Urgent late",
    "On fog",
    "Fog cost",
    "Cloud cost",
    "Total cost",
  ];
  const table = $<HTMLTableElement>("results");
  table.replaceChildren();
  const headRow = table.createTHead().insertRow();
  for (const text of head) {
    const th = document.createElement("th");
    th.textContent = text;
    headRow.append(th);
  }
  const body = table.createTBody();
  for (const r of results) {
    const row = body.insertRow();
    const cells = [
      r.policy.label,
      fmt(r.meanResponse),
      fmt(r.p95Response, 0),
      fmt(r.urgentResponse),
      pct(r.lateShare),
      pct(r.urgentLateShare),
      pct(r.fogShare),
      whole(r.fogCost),
      whole(r.cloudCost),
      whole(r.totalCost),
    ];
    for (const text of cells) row.insertCell().textContent = text;
  }
}

function frame(now: number): void {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (playing && !sim.done) {
    clock += dt * Number($<HTMLInputElement>("speed").value);
    let ran = false;
    while (stepsRun < clock && !sim.done) {
      view.record(sim.step());
      stepsRun++;
      ran = true;
    }
    if (ran) renderLive();
  }
  view.draw(clock);
  requestAnimationFrame(frame);
}

buildControls();
rebuild();
requestAnimationFrame((now) => {
  lastFrame = now;
  frame(now);
});
