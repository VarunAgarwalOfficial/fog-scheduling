import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig, type Task } from "../src/core/model.ts";
import { getPolicy, policies } from "../src/core/policies.ts";
import { createSimulation, type Outcome, type Snapshot } from "../src/core/sim.ts";
import { buildTopology, generateWorkload } from "../src/core/workload.ts";
import { task, tiny } from "./helpers.ts";

function runAll(config = tiny, policyId = "fcfs", workload: Task[] = []) {
  const sim = createSimulation(config, getPolicy(policyId), workload);
  const snapshots: Snapshot[] = [];
  for (let i = 0; !sim.done; i++) {
    assert.ok(i < 100000, "simulation should finish");
    snapshots.push(sim.step());
  }
  const byId = new Map<number, Outcome>(sim.outcomes.map((o) => [o.task.id, o]));
  return { sim, snapshots, byId };
}

test("an empty workload is done before the first step", () => {
  assert.equal(createSimulation(tiny, getPolicy("fcfs"), []).done, true);
});

test("a lone task runs on the fog node at fog speed", () => {
  // 7 units at 3 per tick is 3 ticks, charged 2 per busy tick.
  const { sim, byId } = runAll(tiny, "fcfs", [task({ id: 0, work: 7 })]);
  const o = byId.get(0)!;
  assert.equal(o.place, "fog");
  assert.equal(o.response, 3);
  assert.equal(sim.fogCost, 6);
  assert.equal(sim.cloudCost, 0);
});

test("a task refused by the fog node pays the network delay and the cloud price", () => {
  // Priority 2 is below the fog threshold: 3 ticks of network, then 7 units at 4 per tick is 2 ticks.
  const { sim, byId } = runAll(tiny, "priority", [task({ id: 0, work: 7, priority: 2 })]);
  const o = byId.get(0)!;
  assert.equal(o.place, "cloud");
  assert.equal(o.response, 5);
  assert.equal(sim.fogCost, 0);
  assert.equal(sim.cloudCost, 7);
});

test("lateness compares response with the deadline", () => {
  const { byId } = runAll(tiny, "fcfs", [
    task({ id: 0, work: 9, deadline: 3 }),
    task({ id: 1, arrival: 5, work: 9, deadline: 2 }),
  ]);
  assert.equal(byId.get(0)!.late, false);
  assert.equal(byId.get(1)!.late, true);
});

test("a full fog node sends away the task its policy ranks last", () => {
  const three = [
    task({ id: 0, work: 9, priority: 5 }),
    task({ id: 1, work: 2, priority: 6 }),
    task({ id: 2, work: 5, priority: 9 }),
  ];
  // Capacity 2 and three arrivals in one tick: exactly one must go to the cloud.
  const place = (policy: string) => {
    const { byId } = runAll(tiny, policy, three);
    return [0, 1, 2].map((id) => byId.get(id)!.place);
  };
  assert.deepEqual(place("fcfs"), ["fog", "fog", "cloud"], "newest leaves");
  assert.deepEqual(place("priority"), ["cloud", "fog", "fog"], "least urgent leaves");
  assert.deepEqual(place("sjf"), ["cloud", "fog", "fog"], "longest leaves");
});

test("fog queue order follows the policy", () => {
  const two = [task({ id: 0, work: 6, priority: 6 }), task({ id: 1, work: 3, priority: 9 })];
  const first = (policy: string) => {
    const { byId } = runAll(tiny, policy, two);
    return byId.get(0)!.finished < byId.get(1)!.finished ? 0 : 1;
  };
  assert.equal(first("fcfs"), 0);
  assert.equal(first("priority"), 1);
  assert.equal(first("sjf"), 1);
  assert.equal(first("hybrid"), 1);
});

test("hybrid breaks priority ties by shortest job and runs the cloud shortest first", () => {
  const hybrid = getPolicy("hybrid");
  const long = task({ id: 0, work: 8, priority: 7 });
  const short = task({ id: 1, work: 2, priority: 7 });
  const urgentLong = task({ id: 2, work: 9, priority: 9 });
  assert.ok(hybrid.fogOrder(short, long) < 0);
  assert.ok(hybrid.fogOrder(urgentLong, short) < 0);
  assert.ok(hybrid.cloudOrder(short, urgentLong) < 0);
  assert.equal(hybrid.admit(task({ id: 3, priority: 4 })), false);
  assert.equal(hybrid.admit(task({ id: 4, priority: 5 })), true);
});

test("scheduling is non-preemptive", () => {
  // The long task starts alone; an emergency arriving a tick later must wait for it.
  const { byId } = runAll(tiny, "priority", [
    task({ id: 0, work: 9, priority: 5 }),
    task({ id: 1, arrival: 1, work: 1, priority: 9 }),
  ]);
  assert.equal(byId.get(0)!.finished, 3);
  assert.equal(byId.get(1)!.finished, 4);
});

test("the cloud queues tasks when all servers are busy", () => {
  const low = [0, 1, 2].map((id) => task({ id, work: 4, priority: 1 }));
  const { byId, snapshots } = runAll(tiny, "priority", low);
  // One server, one tick each, after 3 ticks of network.
  assert.deepEqual(
    [0, 1, 2].map((id) => byId.get(id)!.response),
    [4, 5, 6],
  );
  assert.equal(snapshots[3]!.cloudWaiting, 2);
});

test("unknown policy and bad settings are rejected", () => {
  assert.throws(() => getPolicy("nope"), /unknown policy/);
  assert.throws(() => createSimulation({ ...tiny, cloudServers: 0 }, getPolicy("fcfs"), []));
  assert.throws(() => createSimulation({ ...tiny, fogSpeed: 0 }, getPolicy("fcfs"), []));
  assert.throws(() => createSimulation({ ...tiny, fogCapacity: 0 }, getPolicy("fcfs"), []));
  const sim = createSimulation(tiny, getPolicy("fcfs"), [task({ id: 0, fog: 4 })]);
  assert.throws(() => sim.step(), /does not exist/);
});

for (const policy of policies) {
  test(`${policy.id}: invariants hold on a generated workload`, () => {
    const config = { ...defaultConfig, ticks: 300 };
    const workload = generateWorkload(config, buildTopology(config));
    const { sim, snapshots } = runAll(config, policy.id, workload);

    // Every task is answered exactly once.
    assert.equal(sim.outcomes.length, workload.length);
    assert.equal(new Set(sim.outcomes.map((o) => o.task.id)).size, workload.length);

    let fogTicks = 0;
    for (const s of snapshots) {
      for (const load of s.fogLoad) assert.ok(load <= config.fogCapacity);
      assert.ok(s.cloudBusy <= config.cloudServers);
      fogTicks += s.fogBusy.filter(Boolean).length;
    }
    // A fog node that finished a task this tick was busy but shows as free afterwards.
    const fogFinishes = sim.outcomes.filter((o) => o.place === "fog").length;
    assert.equal(sim.fogCost, (fogTicks + fogFinishes) * config.fogCostPerTick);

    let cloudWork = 0;
    for (const o of sim.outcomes) {
      const t = o.task;
      if (o.place === "fog") {
        assert.ok(o.response >= Math.ceil(t.work / config.fogSpeed));
      } else {
        cloudWork += t.work;
        assert.ok(o.response >= config.cloudLatency + Math.ceil(t.work / config.cloudSpeed));
        continue;
      }
      assert.ok(policy.admit(t), "a task that ran on fog was admitted by the policy");
    }
    assert.equal(sim.cloudCost, cloudWork * config.cloudCostPerUnit);
  });
}
