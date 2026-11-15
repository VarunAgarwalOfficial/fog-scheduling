import type { Config, Point, Task, Topology } from "../core/model.ts";
import type { Snapshot } from "../core/sim.ts";
import type { Palette } from "./shared/theme.js";

interface Particle {
  from: Point;
  to: Point;
  /** Time of departure and of arrival, in ticks. */
  start: number;
  end: number;
  urgent: boolean;
}

const URGENT = 7;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Whether the segment a-b enters the box (Liang-Barsky clipping). */
function crosses(a: { x: number; y: number }, b: { x: number; y: number }, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sides: [number, number][] = [
    [-dx, a.x - box.x0],
    [dx, box.x1 - a.x],
    [-dy, a.y - box.y0],
    [dy, box.y1 - a.y],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      t0 = Math.max(t0, r);
    } else {
      if (r < t0) return false;
      t1 = Math.min(t1, r);
    }
  }
  return t0 <= t1;
}

/** Whether a circle and a box overlap. */
function touches(c: { x: number; y: number; r: number }, box: Box): boolean {
  const x = Math.max(box.x0, Math.min(c.x, box.x1));
  const y = Math.max(box.y0, Math.min(c.y, box.y1));
  return Math.hypot(x - c.x, y - c.y) < c.r;
}
/** The page's typeface and smallest size, for every label on the canvas. */
const FONT = `17px "Newsreader", "CM Web Serif", Georgia, serif`;
const LINE = 20;
/** The band above the cloud kept for its two-line name on a narrow screen. */
const headroom = (width: number) => (width < 560 ? 2 * LINE + 12 : 0);

/** Draws the network on a canvas and animates tasks moving along its links. */
export class NetworkView {
  private particles: Particle[] = [];
  private last: Snapshot | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private topology: Topology;
  private config: Config;
  private colours: Palette | null = null;

  constructor(canvas: HTMLCanvasElement, topology: Topology, config: Config) {
    this.canvas = canvas;
    this.topology = topology;
    this.config = config;
    this.ctx = canvas.getContext("2d")!;
  }

  reset(topology: Topology, config: Config): void {
    this.topology = topology;
    this.config = config;
    this.particles = [];
    this.last = null;
  }

  /** Colours for the current theme, from the shared palette. */
  setColours(colours: Palette): void {
    this.colours = colours;
  }

  /** Match the drawing buffer to the displayed size, for sharp lines on any screen. */
  private fit(): { width: number; height: number } {
    const { canvas } = this;
    const width = canvas.clientWidth || 600;
    // Tall enough for the network, short enough that it and its controls share one screen.
    const height = Math.round(
      Math.min(width * 1.2, Math.max(300, window.innerHeight * 0.55)) + headroom(width),
    );
    const ratio = window.devicePixelRatio || 1;
    if (
      canvas.width !== Math.round(width * ratio) ||
      canvas.height !== Math.round(height * ratio)
    ) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.height = `${height}px`;
    }
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height };
  }

  /** Record what happened in a tick so it can be drawn. */
  record(snapshot: Snapshot): void {
    this.last = snapshot;
    const t = snapshot.tick;
    const send = (task: Task, from: Point, to: Point, start: number, end: number) =>
      this.particles.push({ from, to, start, end, urgent: task.priority >= URGENT });
    const offloaded = new Set(snapshot.offloads);
    for (const task of snapshot.arrivals) {
      const user = this.topology.users[task.user]!;
      const fog = this.topology.fogs[task.fog]!;
      send(task, user, fog, t, t + 1);
      if (offloaded.has(task)) offloaded.delete(task);
      else continue;
      send(task, fog, this.topology.cloud, t + 1, t + 1 + this.config.cloudLatency);
    }
    // Tasks evicted from a fog queue that did not arrive this tick.
    for (const task of offloaded) {
      const fog = this.topology.fogs[task.fog]!;
      send(task, fog, this.topology.cloud, t + 1, t + 1 + this.config.cloudLatency);
    }
  }

  /** Draw the state at a fractional tick. */
  draw(time: number): void {
    const { ctx, topology, colours: c } = this;
    if (!c) return;
    const { width, height } = this.fit();
    // World coordinates run from -300 to 300 across and from -420 (the cloud) to 300 down. On a
    // narrow screen a band is kept above the cloud for its name, which has no room beside it.
    const top = headroom(width);
    const scale = Math.min((width - 32) / 600, (height - 32 - top) / 720);
    const px = (p: Point) => ({
      x: width / 2 + p.x * scale,
      y: top + (height - top) / 2 + (p.y + 60) * scale,
    });
    const radius = (r: number) => Math.max(r * 0.6, r * Math.min(1, scale * 1.4));
    // A fog node holds a two-figure count at the text size.
    const fogR = Math.max(14, radius(14));
    ctx.clearRect(0, 0, width, height);

    ctx.lineWidth = 0.75;
    ctx.strokeStyle = c.muted;
    topology.users.forEach((user, i) => {
      const a = px(user);
      const b = px(topology.fogs[topology.userFog[i]!]!);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    const cloud = px(topology.cloud);
    for (const fog of topology.fogs) {
      const a = px(fog);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(cloud.x, cloud.y);
      ctx.stroke();
    }

    // Users are small rings, so they read apart from the tasks, which are filled dots.
    ctx.fillStyle = c.bg;
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    for (const user of topology.users) {
      const p = px(user);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    this.particles = this.particles.filter((p) => p.end > time);
    for (const p of this.particles) {
      if (p.start > time) continue;
      const k = (time - p.start) / (p.end - p.start);
      const a = px(p.from);
      const b = px(p.to);
      ctx.fillStyle = p.urgent ? c.change : c.ink;
      ctx.beginPath();
      ctx.arc(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, p.urgent ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const label = (p: { x: number; y: number }, r: number, fill: string, text: string) => {
      ctx.fillStyle = fill;
      ctx.strokeStyle = c.bg;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c.bg;
      ctx.font = FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, p.x, p.y + 0.5);
    };
    topology.fogs.forEach((fog, i) => {
      label(px(fog), fogR, c.accent, String(this.last?.fogLoad[i] ?? 0));
    });
    const busy = this.last?.cloudBusy ?? 0;
    const waiting = this.last?.cloudWaiting ?? 0;
    const cloudText = `${busy}+${waiting}`;
    ctx.font = FONT;
    // Wide enough for its count at the text size, whatever the count.
    const cloudR = Math.max(radius(24), ctx.measureText(cloudText).width / 2 + 10);
    label(cloud, cloudR, c.series[2]!, cloudText);

    // Name the parts where they sit: the cloud, and one fog node and one user as examples. Each
    // name goes where it crosses no link, dot, node or other name, trying the examples in turn.
    const links: [Point, Point][] = [
      ...topology.users.map((u, i): [Point, Point] => [
        px(u),
        px(topology.fogs[topology.userFog[i]!]!),
      ]),
      ...topology.fogs.map((f): [Point, Point] => [px(f), cloud]),
    ];
    const fogs = topology.fogs.map(px);
    const users = topology.users.map(px);
    const discs = [
      ...fogs.map((f) => ({ ...f, r: fogR + 2 })),
      ...users.map((u) => ({ ...u, r: 5 })),
      { ...cloud, r: cloudR + 2 },
    ];
    const placed: Box[] = [];
    ctx.font = FONT;
    const ink = ctx.measureText("Hg");
    const asc = ink.actualBoundingBoxAscent;
    const desc = ink.actualBoundingBoxDescent;
    const boxOf = (x: number, y: number, lines: string[], align: CanvasTextAlign): Box => {
      const w = Math.max(...lines.map((line) => ctx.measureText(line).width));
      const x0 = align === "left" ? x : align === "right" ? x - w : x - w / 2;
      const top = y - ((lines.length - 1) / 2) * LINE - asc;
      return {
        x0: x0 - 2,
        x1: x0 + w + 2,
        y0: top - 2,
        y1: top + (lines.length - 1) * LINE + asc + desc + 2,
      };
    };
    const clashes = (box: Box): number => {
      let n = 0;
      if (box.x0 < 2 || box.y0 < 2 || box.x1 > width - 2 || box.y1 > height - 2) n += 100;
      for (const d of discs) if (touches(d, box)) n += 10;
      for (const b of placed)
        if (b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1) n += 10;
      for (const [a, b] of links) if (crosses(a, b, box)) n += 1;
      return n;
    };
    const name = (anchors: { x: number; y: number }[], r: number, lines: string[]) => {
      const h = (lines.length - 1) * LINE + asc + desc;
      let best: { x: number; y: number; align: CanvasTextAlign; box: Box; n: number } | null = null;
      for (const p of anchors) {
        const spots: [number, number, CanvasTextAlign][] = [
          [p.x + r + 7, p.y, "left"],
          [p.x - r - 7, p.y, "right"],
          [p.x, p.y - r - 6 - h / 2, "center"],
          [p.x, p.y + r + 6 + h / 2, "center"],
          [p.x + r + 4, p.y - r - h / 2, "left"],
          [p.x - r - 4, p.y - r - h / 2, "right"],
          [p.x + r + 4, p.y + r + h / 2, "left"],
          [p.x - r - 4, p.y + r + h / 2, "right"],
        ];
        for (const [x, y, align] of spots) {
          const box = boxOf(x, y, lines, align);
          const n = clashes(box);
          if (!best || n < best.n) best = { x, y, align, box, n };
          if (n === 0) break;
        }
        if (best?.n === 0) break;
      }
      if (!best) return;
      const at = best;
      placed.push(at.box);
      ctx.textAlign = at.align;
      ctx.textBaseline = "middle";
      ctx.font = FONT;
      ctx.lineJoin = "round";
      ctx.lineWidth = 5;
      ctx.strokeStyle = c.bg;
      ctx.fillStyle = c.ink;
      lines.forEach((line, i) => {
        const y = at.y + (i - (lines.length - 1) / 2) * LINE;
        // A halo in the page colour, so a link passing close by stops short of the letters.
        ctx.strokeText(line, at.x, y);
        ctx.fillText(line, at.x, y);
      });
    };
    name([cloud], cloudR + 1, ["cloud: busy servers", "+ tasks waiting"]);
    name(
      [...fogs].sort((a, b) => a.x - b.x),
      fogR,
      ["fog node"],
    );
    name(
      [...users].sort((a, b) => b.y - a.y),
      3,
      ["user"],
    );
  }
}
