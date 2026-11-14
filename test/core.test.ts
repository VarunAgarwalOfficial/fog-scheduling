import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePolicies, runPolicy } from "../src/core/metrics.ts";
import { defaultConfig, type Task } from "../src/core/model.ts";
import { getPolicy, policies } from "../src/core/policies.ts";
import { createSimulation } from "../src/core/sim.ts";
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
  const finishOrder = (policy: string, workload: Task[]) => {
    const sim = createSimulation(tiny, getPolicy(policy), workload);
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
  // The mix: urgent first on fog with shortest as tie-break, shortest first on the cloud.
  const hybrid = getPolicy("hybrid");
  const short = task({ id: 1, work: 2, priority: 7 });
  assert.ok(hybrid.fogOrder(short, task({ id: 0, work: 8, priority: 7 })) < 0);
  assert.ok(hybrid.fogOrder(task({ id: 2, work: 9, priority: 9 }), short) < 0);
  assert.ok(hybrid.cloudOrder(short, task({ id: 2, work: 9, priority: 9 })) < 0);
});

for (const policy of policies) {
  test(`${policy.id}: every task is answered once, within capacity and physical limits`, () => {
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
  });
}

test("on the same workload the policies do what they are for", () => {
  const workload = generateWorkload(defaultConfig, buildTopology(defaultConfig));
  const [fcfs, priority, sjf] = comparePolicies(defaultConfig, workload);
  assert.deepEqual(comparePolicies(defaultConfig, workload)[1], priority, "repeatable");
  // Priority answers emergencies faster than routine tasks and faster than a blind scheduler.
  assert.ok(priority!.responseByPriority[8]! < priority!.responseByPriority[0]!);
  assert.ok(priority!.urgentResponse < fcfs!.urgentResponse);
  // Shortest job first gives the lowest mean response time.
  assert.ok(sjf!.meanResponse < fcfs!.meanResponse);
  assert.ok(sjf!.meanResponse < priority!.meanResponse);
});
