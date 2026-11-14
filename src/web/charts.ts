/** Small SVG charts drawn by hand: horizontal bars and a multi-series line chart. */

const NS = "http://www.w3.org/2000/svg";

function el(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

const tooltip = (): HTMLElement => document.getElementById("tooltip")!;

function showTooltip(event: MouseEvent, html: string): void {
  const tip = tooltip();
  tip.innerHTML = html;
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  const x = Math.min(event.clientX + 12, window.innerWidth - box.width - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${event.clientY + 12}px`;
}

function hideTooltip(): void {
  tooltip().hidden = true;
}

/** Round a maximum up to a tidy axis end and give tick values. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough)!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function caption(figure: HTMLElement, title: string, subtitle: string): void {
  const cap = document.createElement("figcaption");
  cap.textContent = title;
  const small = document.createElement("small");
  small.textContent = subtitle;
  cap.append(small);
  figure.replaceChildren(cap);
}

export interface Bar {
  label: string;
  value: number;
  color: string;
}

export function barChart(
  figure: HTMLElement,
  title: string,
  subtitle: string,
  bars: Bar[],
  format: (value: number) => string,
): void {
  caption(figure, title, subtitle);
  const width = 320;
  const rowHeight = 26;
  const left = 0;
  const right = 56;
  const top = 4;
  const height = top + bars.length * rowHeight + 4;
  const ticks = niceTicks(Math.max(...bars.map((b) => b.value || 0)));
  const end = ticks.at(-1)!;
  const scale = (value: number) => left + (value / end) * (width - left - right);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title });
  svg.append(el("line", { class: "axis", x1: left, x2: left, y1: top, y2: height - 4 }));
  bars.forEach((bar, i) => {
    const y = top + i * rowHeight;
    const w = Number.isFinite(bar.value) ? Math.max(scale(bar.value) - left, 1) : 0;
    const group = el("g", {});
    group.append(
      el("rect", { x: left, y, width: width, height: rowHeight, fill: "transparent" }),
      el("rect", { x: left, y: y + 12, width: w, height: 10, rx: 3, fill: bar.color }),
      el("text", { x: left + 2, y: y + 9 }, bar.label),
      el("text", { class: "value", x: left + w + 6, y: y + 21 }, format(bar.value)),
    );
    group.addEventListener("mousemove", (event) =>
      showTooltip(
        event as MouseEvent,
        `<strong>${bar.label}</strong>${title}: ${format(bar.value)}`,
      ),
    );
    group.addEventListener("mouseleave", hideTooltip);
    svg.append(group);
  });
  figure.append(svg);
}

export interface Series {
  label: string;
  color: string;
  values: number[];
}

export function lineChart(
  figure: HTMLElement,
  title: string,
  subtitle: string,
  xLabels: string[],
  series: Series[],
  format: (value: number) => string,
): void {
  caption(figure, title, subtitle);

  const legend = document.createElement("ul");
  legend.className = "legend";
  for (const s of series) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = s.color;
    item.append(swatch, s.label);
    legend.append(item);
  }
  figure.append(legend);

  const width = 640;
  const height = 240;
  const m = { left: 40, right: 16, top: 8, bottom: 36 };
  const all = series.flatMap((s) => s.values).filter(Number.isFinite);
  const ticks = niceTicks(Math.max(...all, 0));
  const end = ticks.at(-1)!;
  const x = (i: number) => m.left + (i / (xLabels.length - 1)) * (width - m.left - m.right);
  const y = (v: number) => height - m.bottom - (v / end) * (height - m.top - m.bottom);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title });

  for (const tick of ticks) {
    svg.append(
      el("line", { class: "grid", x1: m.left, x2: width - m.right, y1: y(tick), y2: y(tick) }),
      el("text", { x: m.left - 6, y: y(tick) + 4, "text-anchor": "end" }, String(tick)),
    );
  }
  xLabels.forEach((label, i) => {
    svg.append(el("text", { x: x(i), y: height - m.bottom + 16, "text-anchor": "middle" }, label));
  });
  svg.append(
    el(
      "text",
      { x: (m.left + width - m.right) / 2, y: height - 4, "text-anchor": "middle" },
      "task priority",
    ),
  );

  for (const s of series) {
    const points = s.values
      .map((v, i) => (Number.isFinite(v) ? `${x(i)},${y(v)}` : null))
      .filter((p) => p !== null);
    svg.append(
      el("polyline", {
        points: points.join(" "),
        fill: "none",
        stroke: s.color,
        "stroke-width": 2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
    s.values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      svg.append(
        el("circle", {
          cx: x(i),
          cy: y(v),
          r: 4,
          fill: s.color,
          stroke: "var(--surface)",
          "stroke-width": 2,
        }),
      );
    });
  }

  // Hover layer: a crosshair that snaps to the nearest priority and lists every series.
  const cross = el("line", {
    class: "axis",
    y1: m.top,
    y2: height - m.bottom,
    visibility: "hidden",
  });
  const hit = el("rect", {
    x: m.left - 10,
    y: m.top,
    width: width - m.left - m.right + 20,
    height: height - m.top - m.bottom,
    fill: "transparent",
  });
  hit.addEventListener("mousemove", (event) => {
    const mouse = event as MouseEvent;
    const box = svg.getBoundingClientRect();
    const px = ((mouse.clientX - box.left) / box.width) * width;
    const step = (width - m.left - m.right) / (xLabels.length - 1);
    const i = Math.min(xLabels.length - 1, Math.max(0, Math.round((px - m.left) / step)));
    cross.setAttribute("x1", String(x(i)));
    cross.setAttribute("x2", String(x(i)));
    cross.setAttribute("visibility", "visible");
    const rows = series
      .map(
        (s) =>
          `<div><span class="swatch" style="background:${s.color}"></span>${s.label}: ${format(s.values[i]!)}</div>`,
      )
      .join("");
    showTooltip(mouse, `<strong>Priority ${xLabels[i]}</strong>${rows}`);
  });
  hit.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideTooltip();
  });
  svg.append(cross, hit);
  figure.append(svg);
}
