import assert from "node:assert/strict";
import { test } from "node:test";
import { interval, replicate, tQuantile } from "../src/core/experiment.ts";
import { runPolicy } from "../src/core/metrics.ts";
import { defaultConfig, type Task } from "../src/core/model.ts";
import { getPolicy, orderOnly, policies } from "../src/core/policies.ts";
import { createSimulation } from "../src/core/sim.ts";
import { firstComeWait, runQueue, singleQueue } from "../src/core/theory.ts";
import { buildTopology, generateWorkload } from "../src/core/workload.ts";
import { task, tiny } from "./helpers.ts";

function places(policy: string, workload: Task[]): string[] {
  const sim = createSimulation(tiny, getPolicy(policy), workload);
  while (!sim.done) sim.step();
  return workload.map((t) => sim.outcomes.find((o) => o.task.id === t.id)!.place);
}

test("the workload is repeatable and users attach to their nearest fog node", () => {
  const topology = buildTopology(defaultConfig);
  const tasks = generateWorkload(defaultConfig, topology);
  assert.deepEqual(tasks, generateWorkload(defaultConfig, topology));
  const expected = defaultConfig.ticks * defaultConfig.users * defaultConfig.arrivalProb;
  assert.ok(Math.abs(tasks.length - expected) / expected < 0.05);
  topology.users.forEach((user, i) => {
    const dist = (f: number) =>
      Math.hypot(user.x - topology.fogs[f]!.x, user.y - topology.fogs[f]!.y);
    for (let f = 0; f < topology.fogs.length; f++) assert.ok(dist(topology.userFog[i]!) <= dist(f));
  });
});

test("a hand-worked run: times, places, lateness and cost", () => {
  // Priority policy, one fog node (3 units per tick, 2 per busy tick), one cloud server
  // (4 units per tick, 1 per unit, 3 ticks away).
  // Task 0 (priority 9, 7 units) runs on fog: 3 ticks, cost 6.
  // Task 1 (priority 1, 7 units) is refused by fog: 3 ticks of network + 2 ticks, cost 7.
  const result = runPolicy(tiny, getPolicy("priority"), [
    task({ id: 0, work: 7, priority: 9, deadline: 5 }),
    task({ id: 1, work: 7, priority: 1, deadline: 4 }),
  ]);
  assert.equal(result.responseByPriority[8], 3);
  assert.equal(result.responseByPriority[0], 5);
  assert.equal(result.meanResponse, 4);
  assert.equal(result.urgentResponse, 3);
  assert.equal(result.lateShare, 0.5);
  assert.equal(result.fogShare, 0.5);
  assert.deepEqual([result.fogCost, result.cloudCost, result.totalCost], [6, 7, 13]);
});

test("a full fog node sends away the task its policy ranks last", () => {
  // Capacity 2 and three arrivals in one tick: exactly one must go to the cloud.
  const three = [
    task({ id: 0, work: 9, priority: 5 }),
    task({ id: 1, work: 2, priority: 6 }),
    task({ id: 2, work: 5, priority: 9 }),
  ];
  assert.deepEqual(places("fcfs", three), ["fog", "fog", "cloud"], "newest leaves");
  assert.deepEqual(places("priority", three), ["cloud", "fog", "fog"], "least urgent leaves");
  assert.deepEqual(places("sjf", three), ["cloud", "fog", "fog"], "longest leaves");
});

test("queues follow the policy and a started task is not interrupted", () => {
  const finishOrder = (policy: string, workload: Task[], admitAll = false) => {
    const chosen = admitAll ? orderOnly(getPolicy(policy)) : getPolicy(policy);
    const sim = createSimulation({ ...tiny, fogCapacity: 10 }, chosen, workload);
    while (!sim.done) sim.step();
    return sim.outcomes.map((o) => o.task.id);
  };
  const two = [task({ id: 0, work: 6, priority: 6 }), task({ id: 1, work: 3, priority: 9 })];
  assert.deepEqual(finishOrder("fcfs", two), [0, 1]);
  assert.deepEqual(finishOrder("priority", two), [1, 0]);
  assert.deepEqual(finishOrder("sjf", two), [1, 0]);
  // The long task starts alone; an emergency arriving a tick later must wait for it.
  const late = [task({ id: 0, work: 9, priority: 5 }), task({ id: 1, arrival: 1, priority: 9 })];
  assert.deepEqual(finishOrder("priority", late), [0, 1]);
  // Three tasks queue behind a running one. Work per unit of priority: 2, 1 and 0.67,
  // so the weighted rule differs from both shortest-first and most-urgent-first.
  const three = [
    task({ id: 0, work: 3, priority: 5 }),
    task({ id: 1, work: 2, priority: 1, arrival: 1 }),
    task({ id: 2, work: 9, priority: 9, arrival: 1 }),
    task({ id: 3, work: 4, priority: 6, arrival: 1 }),
  ];
  assert.deepEqual(finishOrder("sjf", three, true), [0, 1, 3, 2]);
  assert.deepEqual(finishOrder("priority", three, true), [0, 2, 3, 1]);
  assert.deepEqual(finishOrder("wsjf", three, true), [0, 3, 2, 1]);
  // The mix: urgent first on fog with shortest as tie-break, shortest first on the cloud.
  const hybrid = getPolicy("hybrid");
  const short = task({ id: 1, work: 2, priority: 7 });
  assert.ok(hybrid.fogOrder(short, task({ id: 0, work: 8, priority: 7 }), tiny) < 0);
  assert.ok(hybrid.fogOrder(task({ id: 2, work: 9, priority: 9 }), short, tiny) < 0);
  assert.ok(hybrid.cloudOrder(short, task({ id: 2, work: 9, priority: 9 }), tiny) < 0);
});

test("ageing bounds how long an emergency stream can hold back a routine task", () => {
  // One task per tick of service, a priority 1 task at tick 0 and an emergency every tick.
  // Strict priority serves it after all 40 emergencies. With one level per 2 ticks it can
  // only be overtaken by emergencies that arrive at most 8 * 2 ticks after it.
  const config = { ...tiny, fogCapacity: 100, ageing: 2 };
  const workload = [
    task({ id: 0, priority: 9 }),
    task({ id: 1, priority: 1 }),
    ...Array.from({ length: 40 }, (_, i) => task({ id: i + 2, priority: 9, arrival: i + 1 })),
  ];
  const lowResponse = (policy: string) => {
    const sim = createSimulation(config, orderOnly(getPolicy(policy)), workload);
    while (!sim.done) sim.step();
    return sim.outcomes.find((o) => o.task.id === 1)!.response;
  };
  assert.equal(lowResponse("priority"), 42);
  assert.equal(lowResponse("ageing"), 1 + 8 * 2 + 1);
});

test("one queue: first come, first served matches the formula and work is conserved", () => {
  const config = singleQueue(0.5, { ticks: 100000 });
  const workload = generateWorkload(config, buildTopology(config));
  const runs = policies.map((p) => runQueue(config, p, workload));
  const formula = firstComeWait(config);
  assert.ok(Math.abs(runs[0]!.meanWait - formula) / formula < 0.05, `${runs[0]!.meanWait}`);
  // Kleinrock's conservation law holds sample path by sample path: every order that keeps
  // the server busy whenever there is work gives the same work-weighted wait.
  for (const run of runs)
    assert.ok(Math.abs(run.workWeightedWait - runs[0]!.workWeightedWait) < 1e-9);
  const byId = Object.fromEntries(policies.map((p, i) => [p.id, runs[i]!]));
  for (const run of runs) {
    assert.ok(byId.sjf!.meanWait <= run.meanWait);
    assert.ok(byId.wsjf!.weightedWait <= run.weightedWait);
  }
});

test("confidence intervals use Student's t", () => {
  const ci = interval([1, 2, 3, 4, 5, Number.NaN]);
  assert.equal(ci.n, 5);
  assert.equal(ci.mean, 3);
  assert.ok(Math.abs(ci.half - 2.776 * Math.sqrt(2.5 / 5)) < 1e-9);
  assert.ok(tQuantile(31) < tQuantile(30) && tQuantile(31) > 2.03);
  assert.ok(Math.abs(tQuantile(1000) - 1.962) < 0.001);
});

test("every task is answered once, within capacity and physical limits", () => {
  for (const policy of policies) {
    const config = { ...defaultConfig, ticks: 300 };
    const workload = generateWorkload(config, buildTopology(config));
    const sim = createSimulation(config, policy, workload);
    while (!sim.done) {
      const s = sim.step();
      for (const load of s.fogLoad) assert.ok(load <= config.fogCapacity);
      assert.ok(s.cloudBusy <= config.cloudServers);
    }
    assert.equal(new Set(sim.outcomes.map((o) => o.task.id)).size, workload.length);
    assert.equal(sim.outcomes.length, workload.length);
    let cloudWork = 0;
    for (const { task: t, place, response } of sim.outcomes) {
      if (place === "fog") {
        assert.ok(policy.admit(t));
        assert.ok(response >= Math.ceil(t.work / config.fogSpeed));
      } else {
        cloudWork += t.work;
        assert.ok(response >= config.cloudLatency + Math.ceil(t.work / config.cloudSpeed));
      }
    }
    assert.equal(sim.cloudCost, cloudWork * config.cloudCostPerUnit);
  }
});

test("over several workloads the policies do what they are for", () => {
  const { results } = replicate({ ...defaultConfig, cloudServers: 13 }, 4);
  const [fcfs, priority, sjf, , wsjf, ageing] = results.map((r) => r.stats);
  // Priority answers emergencies faster than a blind scheduler and starves priority 1.
  assert.ok(priority!.urgentResponse.mean < fcfs!.urgentResponse.mean);
  assert.ok(priority!.lowTail.mean > 4 * fcfs!.lowTail.mean);
  // Ageing cuts that tail and keeps most of the gain for emergencies.
  assert.ok(ageing!.lowTail.mean < priority!.lowTail.mean / 2);
  assert.ok(ageing!.urgentResponse.mean < fcfs!.urgentResponse.mean);
  // Shortest job first gives the lowest mean, the weighted rule the lowest weighted mean.
  for (const r of results) {
    assert.ok(sjf!.meanResponse.mean <= r.stats.meanResponse.mean);
    assert.ok(wsjf!.weightedResponse.mean <= r.stats.weightedResponse.mean);
  }
});
