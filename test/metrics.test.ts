import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePolicies, percentile, runPolicy, summarise } from "../src/core/metrics.ts";
import { defaultConfig } from "../src/core/model.ts";
import { getPolicy, policies } from "../src/core/policies.ts";
import { buildTopology, generateWorkload } from "../src/core/workload.ts";
import { task, tiny } from "./helpers.ts";

test("percentile uses the nearest rank", () => {
  const values = [5, 1, 4, 2, 3];
  assert.equal(percentile(values, 50), 3);
  assert.equal(percentile(values, 95), 5);
  assert.equal(percentile(values, 0), 1);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test("summary of a hand-worked run", () => {
  // Under the priority policy: task 0 (priority 9, 3 units) runs on fog in 1 tick,
  // task 1 (priority 1, 4 units) goes to the cloud: 3 ticks of network + 1 tick of work.
  const result = runPolicy(tiny, getPolicy("priority"), [
    task({ id: 0, work: 3, priority: 9, deadline: 5 }),
    task({ id: 1, work: 4, priority: 1, deadline: 3 }),
  ]);
  assert.equal(result.tasks, 2);
  assert.equal(result.meanResponse, 2.5);
  assert.equal(result.urgentResponse, 1);
  assert.equal(result.responseByPriority[8], 1);
  assert.equal(result.responseByPriority[0], 4);
  assert.ok(Number.isNaN(result.responseByPriority[4]));
  assert.equal(result.lateShare, 0.5);
  assert.equal(result.urgentLateShare, 0);
  assert.equal(result.fogShare, 0.5);
  assert.equal(result.fogCost, 2);
  assert.equal(result.cloudCost, 4);
  assert.equal(result.totalCost, 6);
  assert.equal(result.makespan, 4);
});

test("summary of nothing has no divisions by zero", () => {
  const result = summarise(getPolicy("fcfs"), [], 0, 0);
  assert.equal(result.tasks, 0);
  assert.equal(result.lateShare, 0);
  assert.equal(result.fogShare, 0);
  assert.ok(Number.isNaN(result.meanResponse));
});

test("all policies are compared on the same tasks, and the run is repeatable", () => {
  const config = { ...defaultConfig, ticks: 400 };
  const workload = generateWorkload(config, buildTopology(config));
  const results = comparePolicies(config, workload);
  assert.deepEqual(
    results.map((r) => r.policy.id),
    policies.map((p) => p.id),
  );
  for (const r of results) assert.equal(r.tasks, workload.length);
  assert.deepEqual(comparePolicies(config, workload), results);
});

test("the policies do what they are for", () => {
  const workload = generateWorkload(defaultConfig, buildTopology(defaultConfig));
  const [fcfs, priority, sjf] = comparePolicies(defaultConfig, workload);
  // Priority scheduling answers emergencies faster than it answers routine tasks,
  // and faster than a scheduler that ignores priority.
  assert.ok(priority!.responseByPriority[8]! < priority!.responseByPriority[0]!);
  assert.ok(priority!.urgentResponse < fcfs!.urgentResponse);
  // Shortest job first gives the lowest mean response time.
  assert.ok(sjf!.meanResponse < fcfs!.meanResponse);
  assert.ok(sjf!.meanResponse < priority!.meanResponse);
});
