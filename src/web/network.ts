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
    const height = Math.round(width * 1.1);
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio)) {
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
    // World coordinates run from -300 to 300 across and from -420 (the cloud) to 300 down.
    const scale = Math.min((width - 32) / 600, (height - 32) / 720);
    const px = (p: Point) => ({
      x: width / 2 + p.x * scale,
      y: height / 2 + (p.y + 60) * scale,
    });
    const radius = (r: number) => Math.max(r * 0.6, r * Math.min(1, scale * 1.4));
    ctx.clearRect(0, 0, width, height);

    ctx.lineWidth = 1;
    ctx.strokeStyle = c.faint;
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

    ctx.fillStyle = c.muted;
    for (const user of topology.users) {
      const p = px(user);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
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
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c.bg;
      ctx.font = `600 ${r > 14 ? 12 : 11}px "IBM Plex Sans", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, p.x, p.y + 0.5);
    };
    topology.fogs.forEach((fog, i) => {
      label(px(fog), radius(11), c.accent, String(this.last?.fogLoad[i] ?? 0));
    });
    const busy = this.last?.cloudBusy ?? 0;
    const waiting = this.last?.cloudWaiting ?? 0;
    label(cloud, radius(22), c.series[2]!, `${busy}+${waiting}`);
  }
}
