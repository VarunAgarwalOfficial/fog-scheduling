import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/core/model.ts";
import { createRng } from "../src/core/rng.ts";
import { buildTopology, generateWorkload } from "../src/core/workload.ts";

test("rng repeats for a seed and differs between seeds", () => {
  const a = createRng(42);
  const b = createRng(42);
  const c = createRng(43);
  const seqA = Array.from({ length: 20 }, () => a.next());
  assert.deepEqual(
    seqA,
    Array.from({ length: 20 }, () => b.next()),
  );
  assert.notDeepEqual(
    seqA,
    Array.from({ length: 20 }, () => c.next()),
  );
});

test("rng stays in range and covers it", () => {
  const rng = createRng(1);
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const f = rng.next();
    assert.ok(f >= 0 && f < 1);
    const n = rng.int(1, 9);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 9);
    seen.add(n);
  }
  assert.equal(seen.size, 9);
});

test("every user is attached to its nearest fog node", () => {
  const topology = buildTopology(defaultConfig);
  assert.equal(topology.fogs.length, defaultConfig.fogNodes);
  assert.equal(topology.users.length, defaultConfig.users);
  topology.users.forEach((user, i) => {
    const dist = (f: number) =>
      Math.hypot(user.x - topology.fogs[f]!.x, user.y - topology.fogs[f]!.y);
    const chosen = dist(topology.userFog[i]!);
    for (let f = 0; f < topology.fogs.length; f++) assert.ok(chosen <= dist(f));
  });
});

test("a topology needs a fog node", () => {
  assert.throws(() => buildTopology({ ...defaultConfig, fogNodes: 0 }));
});

test("workload is repeatable, ordered and within the stated ranges", () => {
  const topology = buildTopology(defaultConfig);
  const tasks = generateWorkload(defaultConfig, topology);
  assert.deepEqual(tasks, generateWorkload(defaultConfig, topology));
  tasks.forEach((t, i) => {
    assert.equal(t.id, i);
    if (i > 0) assert.ok(t.arrival >= tasks[i - 1]!.arrival);
    assert.ok(t.arrival >= 0 && t.arrival < defaultConfig.ticks);
    assert.ok(t.priority >= 1 && t.priority <= 9);
    assert.ok(t.work >= 1 && t.work <= 9);
    assert.ok(t.deadline >= 5 && t.deadline <= 19);
    assert.equal(t.fog, topology.userFog[t.user]);
  });
});

test("arrival rate matches the configured probability", () => {
  const config = { ...defaultConfig, ticks: 4000 };
  const tasks = generateWorkload(config, buildTopology(config));
  const expected = config.ticks * config.users * config.arrivalProb;
  assert.ok(Math.abs(tasks.length - expected) / expected < 0.03);
});

test("no arrivals when the probability is zero", () => {
  const config = { ...defaultConfig, arrivalProb: 0 };
  assert.equal(generateWorkload(config, buildTopology(config)).length, 0);
});
