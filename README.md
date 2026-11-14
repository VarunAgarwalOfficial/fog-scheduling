# Fog scheduling

A simulation of users, fog nodes and a cloud that compares task scheduling policies on the same
workload: first come first served, priority, shortest job first, and a mix of the last two.

## The idea

Devices at the edge of a network, such as medical sensors, produce more tasks than they can
process. A fog node sits close to them and answers quickly, but it is small. The cloud is large,
but every task sent there pays a network delay. So someone has to decide, for every task, whether
it stays at the fog node or goes to the cloud, and what runs first. The original project built this
three-tier network as a small simulation, gave every task a priority from 1 to 9 with emergencies
in mind, and asked a direct question: if you schedule by priority, by shortest job, or by both,
what happens to response time and to cost? The good part was that it did not argue the answer, it
measured it.

## How it works

Time moves in ticks. Each user is attached to its nearest fog node. On every tick each user creates
a task with a fixed probability. A task has a priority (1 to 9), an amount of work (1 to 9 units)
and a deadline (5 to 19 ticks).

Each tick, in order:

1. New tasks reach their fog node. The policy either admits a task or sends it to the cloud. If the
   node now holds more tasks than its capacity, the task the policy ranks last is sent to the cloud.
2. Tasks sent to the cloud spend `cloudLatency` ticks on the network, then join the cloud queue.
3. Each fog node works on one task, each cloud server works on one task. A started task runs to
   completion (no preemption). Free nodes and servers pick the task the policy ranks first.

|       | Fog node                            | Cloud                                |
| ----- | ----------------------------------- | ------------------------------------ |
| Speed | 3 work units per tick               | 4 work units per tick, per server    |
| Size  | holds 2 tasks                       | 14 servers ("elastic up to a point") |
| Delay | none                                | 3 ticks                              |
| Price | 2 per busy tick (reserved hardware) | 1 per work unit (pay per use)        |

These are the defaults; all of them can be changed.

| Policy                   | Admitted to fog   | Fog order                  | Sent away when full | Cloud order       |
| ------------------------ | ----------------- | -------------------------- | ------------------- | ----------------- |
| First come, first served | all               | oldest first               | newest              | oldest first      |
| Priority                 | priority 5 and up | most urgent first          | least urgent        | most urgent first |
| Shortest job first       | all               | shortest first             | longest             | shortest first    |
| SJF + priority           | priority 5 and up | most urgent, then shortest | least urgent        | shortest first    |

The workload is generated once from a seed and every policy runs on that same list of tasks, so a
difference between two rows is caused by the policy and not by chance.

Measured per policy: mean and 95th percentile response time (ticks from request to answer), mean
response for urgent tasks (priority 7 to 9) and for each priority, share of tasks past their
deadline, share of tasks run on fog, and cost.

### What it shows

With the defaults (50 users, 5 fog nodes, 19,871 tasks, seed 2):

| Policy                   | Mean | 95th pct | Urgent | Urgent late | Total cost |
| ------------------------ | ---: | -------: | -----: | ----------: | ---------: |
| First come, first served | 5.04 |        7 |   5.03 |        3.3% |     94,856 |
| Priority                 | 5.23 |       10 |   3.98 |        1.4% |     95,167 |
| Shortest job first       | 4.37 |        8 |   4.34 |        3.4% |     98,868 |
| SJF + priority           | 4.92 |        9 |   4.19 |        3.7% |     95,570 |

- Priority answers emergencies fastest and pays for it with the worst mean: the least important
  tasks wait behind everything else. Take one cloud server away (`--cloud-servers 13`) and
  priority 1 tasks wait well over a hundred ticks while priority 9 tasks do not notice.
- Shortest job first has the best mean, as theory says, but is blind to urgency and costs the most,
  because short jobs fill the fog nodes, which are charged per tick, and long jobs go to the cloud,
  which is charged per unit of work.
- The mix sits between the two on both response time and cost. That agrees with the conclusion of
  the original report.

These numbers describe this model, not a real network.

## Run

Needs Node 23.6 or newer (it runs TypeScript directly).

```
npm install
npm run compare                           # table for the default setup
npm run compare -- --cloud-servers 13     # an overloaded cloud
npm run compare -- --help                 # all options; --json for machine output
npm run dev                               # interactive view at http://localhost:5173
```

The view animates one policy on the network and shows the comparison of all four as charts and a
table. Changing a setting reruns everything. `npm run build` writes a static site to `dist/`.
To use another port, run `PORT=4000 npm run dev` or copy `.env.example` to `.env`.

## Test

```
npm test          # core logic, with node:test
npm run lint      # Biome: lint and format check
npm run build     # type check and production build
```

## Layout

```
src/core/   pure simulation: rng, model, workload, policies, sim, metrics
src/cli.ts  command line comparison
src/web/    browser view: network animation and SVG charts
test/       tests for the core
```

## Differences from the original

- The original fog node worked on one task and sent every other task to the cloud at once. Here a
  node has a small queue, so the order of the queue matters.
- The original cloud finished everything immediately. Here it has a limited number of servers, so
  it can be overloaded.
- The original shortest-job-first sent short jobs to the cloud. Here the longest job leaves, since
  a long job loses the least from the network delay.
- First come, first served was added as a baseline.

## Credit

Rebuilt from a 2022 university project on fog and edge computing by Varun Agarwal, Anirudh Yadav
and Ruksana Tabassum.
