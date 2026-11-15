import "./shared/base.css";
import "./style.css";
import type { Interval, Measure } from "../core/experiment.ts";
import { type Config, defaultConfig, type Task, type Topology } from "../core/model.ts";
import { getPolicy, policies } from "../core/policies.ts";
import { createSimulation, type Simulation, type Snapshot } from "../core/sim.ts";
import type { LoadPoint } from "../core/theory.ts";
import { buildTopology, generateWorkload } from "../core/workload.ts";
import { barChart, hideTooltip, lineChart } from "./charts.ts";
import { NetworkView } from "./network.ts";
import { palette } from "./shared/theme.js";
import type { Job, PlainExperiment, Reply } from "./worker.ts";

interface Field {
  key: keyof Config | "seeds";
  label: string;
  min: number;
  max: number;
  step: number;
}

const DEFAULT_SEEDS = 10;

const fields: Field[] = [
  { key: "users", label: "Users", min: 1, max: 200, step: 1 },
  { key: "fogNodes", label: "Fog nodes", min: 1, max: 20, step: 1 },
  { key: "arrivalProb", label: "Task chance per user and tick", min: 0.01, max: 1, step: 0.01 },
  { key: "fogCapacity", label: "Tasks a fog node holds", min: 1, max: 20, step: 1 },
  { key: "cloudServers", label: "Cloud servers", min: 1, max: 200, step: 1 },
  { key: "cloudLatency", label: "Cloud delay (ticks)", min: 0, max: 30, step: 1 },
  { key: "ageing", label: "Ageing: ticks per priority level", min: 1, max: 500, step: 1 },
  { key: "ticks", label: "Ticks of arrivals", min: 100, max: 5000, step: 100 },
  { key: "seed", label: "First seed", min: 0, max: 999999, step: 1 },
  { key: "seeds", label: "Seeds (workloads)", min: 2, max: 30, step: 1 },
];

/** Colour of a policy: fixed by its place in the list, never by rank. */
const colourOf = (id: string): string =>
  `var(--canvas-series-${policies.findIndex((p) => p.id === id) + 1})`;
/** Names as the page shows them: abbreviations spelled out. */
const plainLabels: Record<string, string> = { hybrid: "Shortest job first + priority" };
const labelOf = (id: string): string => plainLabels[id] ?? getPolicy(id).label;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const fmt = (value: number, digits = 2): string =>
  Number.isFinite(value) ? value.toFixed(digits) : "-";
const whole = (value: number): string =>
  Number.isFinite(value) ? Math.round(value).toLocaleString("en") : "-";
const pct = (value: number, digits = 1): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "-";
const ci = (i: Interval, f: (v: number) => string): string =>
  Number.isFinite(i.half) ? `${f(i.mean)} ± ${f(i.half)}` : f(i.mean);
const signed = (f: (v: number) => string) => (v: number) => (v > 0 ? `+${f(v)}` : f(v));

let config: Config = { ...defaultConfig };
let seeds = DEFAULT_SEEDS;
let policyId = "priority";
let topology: Topology = buildTopology(config);
let workload: Task[] = generateWorkload(config, topology);
let sim: Simulation;
/** Nothing moves until the reader presses Play. */
let playing = false;
let clock = 0;
let stepsRun = 0;
let lastFrame = 0;
let looping = false;
let last: Snapshot | null = null;
let experiment: PlainExperiment | null = null;
let loads: LoadPoint[] | null = null;
/** The settings the theory sweep was run for; it only depends on these. */
let theoryKey = "";

const view = new NetworkView($<HTMLCanvasElement>("network"), topology, config);

// ---------------------------------------------------------------- settings and the address

function readHash(): void {
  const params = new URLSearchParams(location.hash.slice(1));
  const next: Config = { ...defaultConfig };
  let nextSeeds = DEFAULT_SEEDS;
  for (const field of fields) {
    const raw = params.get(field.key);
    if (raw === null) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < field.min || value > field.max) continue;
    if (field.key === "seeds") nextSeeds = Math.round(value);
    else next[field.key] = value;
  }
  config = next;
  seeds = nextSeeds;
  const policy = params.get("policy");
  policyId = policies.some((p) => p.id === policy) ? policy! : "priority";
}

function writeHash(): void {
  const params = new URLSearchParams();
  for (const field of fields) {
    const value = field.key === "seeds" ? seeds : config[field.key];
    const fallback = field.key === "seeds" ? DEFAULT_SEEDS : defaultConfig[field.key];
    if (value !== fallback) params.set(field.key, String(value));
  }
  if (policyId !== "priority") params.set("policy", policyId);
  const hash = params.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
}

function buildSettings(): void {
  const form = $<HTMLFormElement>("settings");
  for (const field of fields) {
    const label = document.createElement("label");
    label.className = "field";
    label.htmlFor = `f-${field.key}`;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.id = `f-${field.key}`;
    input.type = "number";
    input.name = field.key;
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    input.inputMode = field.step < 1 ? "decimal" : "numeric";
    label.append(input);
    form.append(label);
  }
  form.addEventListener("change", () => {
    const next: Config = { ...config };
    let nextSeeds = seeds;
    for (const field of fields) {
      const input = form.elements.namedItem(field.key) as HTMLInputElement;
      const value = Number(input.value);
      const valid =
        input.value !== "" && Number.isFinite(value) && value >= field.min && value <= field.max;
      if (!valid) continue;
      if (field.key === "seeds") nextSeeds = Math.round(value);
      else next[field.key] = value;
    }
    config = next;
    seeds = nextSeeds;
    fillSettings();
    writeHash();
    rebuild();
  });
  form.addEventListener("submit", (event) => event.preventDefault());

  const select = $<HTMLSelectElement>("policy");
  for (const policy of policies) select.add(new Option(labelOf(policy.id), policy.id));
  select.addEventListener("change", () => {
    policyId = select.value;
    writeHash();
    restart();
  });
  $("restart").addEventListener("click", restart);
  $("play").addEventListener("click", () => {
    if (sim.done) restart();
    playing = !playing;
    showPlaying();
  });
  $("step").addEventListener("click", () => {
    playing = false;
    showPlaying();
    if (sim.done) return;
    stepOnce();
    // Halfway along this tick, so the tasks it sent are seen on their links.
    clock = stepsRun - 0.5;
    renderLive();
    view.draw(clock);
  });
  const speed = $<HTMLInputElement>("speed");
  speed.addEventListener("input", () => {
    $("speed-out").textContent = speed.value;
  });
  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("copy-status").textContent = "Link copied.";
    } catch {
      $("copy-status").textContent =
        "Copy the address from the address bar: it holds these settings.";
    }
  });
  $("defaults").addEventListener("click", () => {
    config = { ...defaultConfig };
    seeds = DEFAULT_SEEDS;
    policyId = "priority";
    fillSettings();
    writeHash();
    rebuild();
  });
  addEventListener("hashchange", () => {
    readHash();
    fillSettings();
    rebuild();
  });
}

/** Show the current settings in the form, including any value that was refused. */
function fillSettings(): void {
  const form = $<HTMLFormElement>("settings");
  for (const field of fields) {
    const input = form.elements.namedItem(field.key) as HTMLInputElement;
    input.value = String(field.key === "seeds" ? seeds : config[field.key]);
  }
  $<HTMLSelectElement>("policy").value = policyId;
}

function showPlaying(): void {
  $("play").textContent = playing ? "Pause" : sim?.done ? "Play again" : "Play";
  if (playing && !looping) {
    looping = true;
    requestAnimationFrame((now) => {
      lastFrame = now;
      frame(now);
    });
  }
}

function say(text: string): void {
  $("status").textContent = text;
}

// ---------------------------------------------------------------- experiments in a worker

let worker: Worker | null = null;
let busy = false;
let jobId = 0;

function startWorker(): Worker {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.addEventListener("message", (event: MessageEvent<Reply>) => onReply(event.data));
  return w;
}

function runExperiments(): void {
  const key = JSON.stringify([config.seed, seeds, config.ageing]);
  const theory = key !== theoryKey || loads === null;
  if (busy && worker) {
    // A run for old settings is still going: stop it rather than wait for it.
    worker.terminate();
    worker = null;
  }
  worker ??= startWorker();
  busy = true;
  jobId += 1;
  if (theory) loads = null;
  theoryKey = key;
  const job: Job = { id: jobId, config, seeds, theory };
  worker.postMessage(job);
  say(`Running ${seeds} workloads...`);
  document.body.classList.add("running");
}

function onReply(reply: Reply): void {
  if (reply.id !== jobId) return;
  if (reply.kind === "progress") {
    say(`Running workload ${reply.done} of ${reply.total}...`);
  } else if (reply.kind === "compare") {
    experiment = reply.experiment;
    renderComparison();
    const done = loads !== null;
    if (done) finish();
    else say(`Ran ${seeds} workloads. Now the one-queue check...`);
  } else if (reply.kind === "theory") {
    loads = reply.loads;
    renderTheory();
    finish();
  } else {
    busy = false;
    document.body.classList.remove("running");
    say(`Could not run: ${reply.message}`);
  }
}

function finish(): void {
  busy = false;
  document.body.classList.remove("running");
  say(`Done: ${seeds} workloads, seeds ${config.seed} to ${config.seed + seeds - 1}.`);
}

// ---------------------------------------------------------------- the animated network

function rebuild(): void {
  topology = buildTopology(config);
  workload = generateWorkload(config, topology);
  runExperiments();
  restart();
}

function restart(): void {
  const policy = getPolicy(policyId);
  $("policy-summary").textContent = `${labelOf(policy.id)}: ${policy.summary}`;
  sim = createSimulation(config, policy, workload);
  view.reset(topology, config);
  clock = 0;
  stepsRun = 0;
  last = null;
  renderLive();
  view.draw(0);
}

function stepOnce(): void {
  last = sim.step();
  view.record(last);
  stepsRun++;
}

/** One or two sentences on the last tick: what arrived, what went to the cloud, what finished. */
function describe(): string {
  const users = topology.users.length;
  const fogs = topology.fogs.length;
  if (!last) {
    return (
      `Nothing has run yet. The ${users} small grey dots are users, each linked to the nearest ` +
      `of ${fogs} fog nodes (the numbered circles, showing how many tasks each holds). The large ` +
      "circle at the top is the cloud, showing busy servers + tasks waiting. Press Play to start."
    );
  }
  if (sim.done) {
    return `Finished after ${stepsRun.toLocaleString("en")} ticks: every task has been answered. Press Restart or pick another policy to compare.`;
  }
  const arrived = last.arrivals.length;
  const urgent = last.arrivals.filter((t) => t.priority >= 7).length;
  const sent = last.offloads.length;
  const done = last.completed.length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [
    `Tick ${stepsRun.toLocaleString("en")}: ${plural(arrived, "new task")} arrived` +
      (urgent ? ` (${urgent} urgent)` : ""),
    sent
      ? `${sent} passed on to the cloud because the policy did not keep them at the fog node`
      : "",
    `${done} answered this tick`,
  ].filter(Boolean);
  return `${parts.join(", ")}. The cloud has ${last.cloudBusy} busy servers and ${last.cloudWaiting} tasks waiting.`;
}

function renderLive(): void {
  const outcomes = sim.outcomes;
  const mean = outcomes.reduce((sum, o) => sum + o.response, 0) / outcomes.length;
  const urgent = outcomes.filter((o) => o.task.priority >= 7);
  const urgentMean = urgent.reduce((sum, o) => sum + o.response, 0) / urgent.length;
  const ticks = (value: number) => (Number.isFinite(value) ? `${fmt(value)} ticks` : "none yet");
  const stats: [string, string][] = [
    ["Ticks run", stepsRun.toLocaleString("en")],
    [
      "Tasks answered",
      `${outcomes.length.toLocaleString("en")} of ${workload.length.toLocaleString("en")}`,
    ],
    ["Average time to answer", ticks(mean)],
    ["Average for urgent tasks", ticks(urgentMean)],
    ["Cost so far (made-up units)", whole(sim.fogCost + sim.cloudCost)],
  ];
  $("happened").textContent = describe();
  $("live").replaceChildren(
    ...stats.map(([name, value]) => {
      const wrap = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = name;
      const dd = document.createElement("dd");
      dd.textContent = value;
      wrap.append(dt, dd);
      return wrap;
    }),
  );
}

/** Runs only while playing: when paused or finished, nothing is redrawn. */
function frame(now: number): void {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (playing && !sim.done) {
    clock += dt * Number($<HTMLInputElement>("speed").value);
    let ran = false;
    while (stepsRun < clock && !sim.done) {
      stepOnce();
      ran = true;
    }
    if (ran) renderLive();
  }
  view.draw(clock);
  if (playing && sim.done) {
    playing = false;
    renderLive();
    showPlaying();
  }
  if (playing) requestAnimationFrame(frame);
  else looping = false;
}

// ---------------------------------------------------------------- comparison

interface Shown {
  key: Measure;
  figure: string;
  title: string;
  subtitle: string;
  format: (v: number) => string;
  scale?: number;
}

const shown: Shown[] = [
  {
    key: "meanResponse",
    figure: "chart-mean",
    title: "Mean response",
    subtitle: "ticks, all tasks; shortest job first is lowest",
    format: (v) => fmt(v),
  },
  {
    key: "weightedResponse",
    figure: "chart-weighted",
    title: "Priority-weighted response",
    subtitle: "ticks, each task counted by its priority",
    format: (v) => fmt(v),
  },
  {
    key: "urgentResponse",
    figure: "chart-urgent",
    title: "Urgent response",
    subtitle: "ticks, priority 7 to 9",
    format: (v) => fmt(v),
  },
  {
    key: "lowTail",
    figure: "chart-tail",
    title: "Starvation: priority 1, 99th percentile",
    subtitle: "ticks; the slowest 1% of the least urgent tasks",
    format: (v) => fmt(v, 0),
  },
  {
    key: "urgentLateShare",
    figure: "chart-late",
    title: "Urgent tasks answered late",
    subtitle: "share past their deadline",
    format: (v) => `${fmt(v, 1)}%`,
    scale: 100,
  },
  {
    key: "totalCost",
    figure: "chart-cost",
    title: "Total cost",
    subtitle: "fog busy ticks plus cloud work",
    format: whole,
  },
];

function renderLegend(target: HTMLElement): void {
  target.replaceChildren(
    ...policies.map((p) => {
      const li = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.color = colourOf(p.id);
      li.append(swatch, labelOf(p.id));
      return li;
    }),
  );
}

function renderComparison(): void {
  const e = experiment;
  if (!e) return;
  $("workload-note").textContent =
    `${e.seeds.length} workloads (seeds ${e.seeds[0]} to ${e.seeds.at(-1)}), about ` +
    `${Math.round(e.tasks.mean).toLocaleString("en")} tasks each. Every policy ran on the same tasks.`;
  for (const s of shown) {
    const scale = s.scale ?? 1;
    barChart(
      $(s.figure),
      s.title,
      s.subtitle,
      e.results.map((r) => ({
        label: labelOf(r.policy),
        colour: colourOf(r.policy),
        mean: r.stats[s.key].mean * scale,
        half: r.stats[s.key].half * scale,
      })),
      s.format,
    );
  }

  const table = $<HTMLTableElement>("results");
  table.replaceChildren();
  const caption = table.createCaption();
  caption.textContent =
    "Mean over seeds ± 95% interval. Below each row: the difference from first come, first served, seed by seed.";
  const head = ["Policy", "Mean", "Weighted", "Urgent", "P1 tail", "Urgent late", "On fog", "Cost"];
  const headRow = table.createTHead().insertRow();
  for (const text of head) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = text;
    headRow.append(th);
  }
  const body = table.createTBody();
  const columns: [Measure, (v: number) => string][] = [
    ["meanResponse", (v) => fmt(v)],
    ["weightedResponse", (v) => fmt(v)],
    ["urgentResponse", (v) => fmt(v)],
    ["lowTail", (v) => fmt(v, 0)],
    ["urgentLateShare", (v) => pct(v)],
    ["fogShare", (v) => pct(v)],
    ["totalCost", whole],
  ];
  e.results.forEach((r, i) => {
    const row = body.insertRow();
    const th = document.createElement("th");
    th.scope = "row";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.color = colourOf(r.policy);
    th.append(swatch, labelOf(r.policy));
    row.append(th);
    for (const [key, f] of columns) row.insertCell().textContent = ci(r.stats[key], f);
    if (i === 0) return;
    const diff = body.insertRow();
    diff.className = "diff";
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = "vs first come";
    diff.append(label);
    for (const [key, f] of columns) {
      const d = r.vsFirst[key];
      const sure = Number.isFinite(d.half) && Math.abs(d.mean) > d.half;
      const cell = diff.insertCell();
      cell.textContent = ci(d, signed(f));
      if (!sure) cell.classList.add("unsure");
    }
  });

  lineChart($("chart-priority"), {
    title: "Mean response by priority",
    subtitle: "ticks, mean over seeds; 1 can wait, 9 is an emergency",
    x: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    xFormat: (v) => String(v),
    yFormat: (v) => fmt(v, v >= 100 ? 0 : 1),
    xTitle: "priority",
    yTitle: "ticks",
    series: e.results.map((r) => ({
      label: labelOf(r.policy),
      colour: colourOf(r.policy),
      values: r.byPriority.map((i) => i.mean),
    })),
    legend: $("priority-legend"),
  });
}

// ---------------------------------------------------------------- theory

function renderTheory(): void {
  if (!loads) return;
  const x = loads.map((pt) => pt.load);
  const at = (id: string) => policies.findIndex((p) => p.id === id);
  const pick = (id: string, key: "meanWait" | "lowTailWait") => ({
    label: labelOf(id),
    colour: colourOf(id),
    values: loads!.map((pt) => pt.runs[at(id)]![key].mean),
    half: loads!.map((pt) => pt.runs[at(id)]![key].half),
  });
  lineChart($("chart-formula"), {
    title: "Mean wait against load",
    subtitle: "ticks from arrival to start of service",
    x,
    xFormat: (v) => `${Math.round(v * 100)}%`,
    yFormat: (v) => fmt(v, v >= 10 ? 0 : 1),
    xTitle: "load (share of ticks the server is busy)",
    yTitle: "ticks",
    series: [
      {
        label: "Formula, first come",
        colour: "var(--canvas-muted)",
        values: loads.map((pt) => pt.formula),
        dashed: true,
      },
      pick("fcfs", "meanWait"),
      pick("sjf", "meanWait"),
    ],
    legend: $("formula-legend"),
  });
  lineChart($("chart-starve"), {
    title: "Starvation against load",
    subtitle: "99th percentile wait of priority 1 tasks, ticks",
    x,
    xFormat: (v) => `${Math.round(v * 100)}%`,
    yFormat: (v) => fmt(v, 0),
    xTitle: "load",
    yTitle: "ticks",
    series: [
      pick("fcfs", "lowTailWait"),
      pick("priority", "lowTailWait"),
      pick("ageing", "lowTailWait"),
    ],
    legend: $("starve-legend"),
  });

  const inside = loads.filter(
    (pt) => Math.abs(pt.runs[0]!.meanWait.mean - pt.formula) <= pt.runs[0]!.meanWait.half,
  ).length;
  const spread = Math.max(
    ...loads.map((pt) => {
      const v = pt.runs.map((r) => r.workWeightedWait.mean);
      return Math.max(...v) - Math.min(...v);
    }),
  );
  $("conservation").textContent =
    `The formula lies inside the simulation's interval at ${inside} of ${loads.length} loads. ` +
    "Priority and ageing leave the mean wait where first come puts it and only move it between " +
    "tasks; shortest job first lowers it. The wait weighted by each task's service time is the " +
    `same for all six orders (${spread < 1e-9 ? "equal to rounding error" : `largest difference ${fmt(spread, 3)} ticks`}): Kleinrock's ` +
    "conservation law, which holds for any order that keeps the server busy.";

  const table = $<HTMLTableElement>("theory-table");
  table.replaceChildren();
  const headRow = table.createTHead().insertRow();
  for (const text of [
    "Load",
    "Formula",
    ...policies.map((p) => `${labelOf(p.id)}: mean wait`),
    "Priority: p1 tail",
    "Ageing: p1 tail",
  ]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = text;
    headRow.append(th);
  }
  const body = table.createTBody();
  for (const pt of loads) {
    const row = body.insertRow();
    const cells = [
      pct(pt.load, 0),
      fmt(pt.formula),
      ...pt.runs.map((r) => ci(r.meanWait, (v) => fmt(v))),
      ci(pt.runs[at("priority")]!.lowTailWait, (v) => fmt(v, 0)),
      ci(pt.runs[at("ageing")]!.lowTailWait, (v) => fmt(v, 0)),
    ];
    for (const text of cells) row.insertCell().textContent = text;
  }
}

// ---------------------------------------------------------------- start

function redrawAll(): void {
  view.setColours(palette());
  view.draw(clock);
  renderComparison();
  renderTheory();
}

// No theme button: the page follows the system colour scheme, as the host page does.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  view.setColours(palette());
  view.draw(clock);
});
let resizeTimer = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(redrawAll, 150);
});
addEventListener("scroll", hideTooltip, { passive: true });
// Charts are sized to their box, which is empty while a panel is closed: size them on opening.
for (const panel of document.querySelectorAll<HTMLDetailsElement>("details.panel")) {
  panel.addEventListener("toggle", () => {
    if (!panel.open) return;
    renderComparison();
    renderTheory();
  });
}
renderLegend($("policy-legend"));
buildSettings();
readHash();
fillSettings();
showPlaying();
view.setColours(palette());
rebuild();
// The canvas labels use the page font; draw once more when it has loaded.
document.fonts?.ready.then(() => view.draw(clock));
