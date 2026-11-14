/// <reference lib="webworker" />
// Runs the experiments off the main thread so the page stays responsive.
import { type Experiment, replicate, seedsFor } from "../core/experiment.ts";
import type { Config } from "../core/model.ts";
import { LOADS, type LoadPoint, sweepLoads } from "../core/theory.ts";

export interface Job {
  id: number;
  config: Config;
  seeds: number;
  /** Also run the one-queue load sweep. */
  theory: boolean;
}

/** An experiment with policy ids in place of policy objects, which cannot be posted. */
export type PlainExperiment = Omit<Experiment, "results"> & {
  results: (Omit<Experiment["results"][number], "policy"> & { policy: string })[];
};

export type Reply =
  | { id: number; kind: "progress"; done: number; total: number }
  | { id: number; kind: "compare"; experiment: PlainExperiment }
  | { id: number; kind: "theory"; loads: LoadPoint[] }
  | { id: number; kind: "error"; message: string };

const post = (reply: Reply): void => postMessage(reply);

addEventListener("message", (event: MessageEvent<Job>) => {
  const { id, config, seeds, theory } = event.data;
  try {
    const experiment = replicate(config, seeds, (done, total) =>
      post({ id, kind: "progress", done, total }),
    );
    const results = experiment.results.map(({ policy, ...rest }) => ({
      ...rest,
      policy: policy.id,
    }));
    post({ id, kind: "compare", experiment: { ...experiment, results } });
    if (theory) {
      const loads = sweepLoads(LOADS, seedsFor(config, seeds), { ageing: config.ageing });
      post({ id, kind: "theory", loads });
    }
  } catch (error) {
    post({ id, kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
