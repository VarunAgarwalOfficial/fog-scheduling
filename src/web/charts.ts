/**
 * Small SVG charts drawn by hand: horizontal bars with confidence intervals and a line chart
 * with optional interval bands. Drawn at the width of their container in CSS pixels, so text
 * keeps its size on a phone. Colours are CSS variables, so a theme change needs no redraw.
 */

const NS = "http://www.w3.org/2000/svg";

function el(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

const tooltip = (): HTMLElement => document.getElementById("tooltip")!;

function showTooltip(x: number, y: number, lines: [string, string | null][]): void {
  const tip = tooltip();
  tip.replaceChildren(
    ...lines.map(([text, colour]) => {
      const row = document.createElement("div");
      if (colour) {
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.color = colour;
        row.append(swatch);
      }
      row.append(text);
      return row;
    }),
  );
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - box.width - 8))}px`;
  tip.style.top = `${Math.min(y + 14, window.innerHeight - box.height - 8)}px`;
}

export function hideTooltip(): void {
  tooltip().hidden = true;
}

/** Round a maximum up to a tidy axis end and give tick values from zero. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough)!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function frame(figure: HTMLElement, title: string, subtitle: string): number {
  const cap = document.createElement("figcaption");
  cap.textContent = title;
  const small = document.createElement("small");
  small.textContent = subtitle;
  cap.append(small);
  figure.replaceChildren(cap);
  return Math.max(260, Math.round(figure.clientWidth || 320));
}

export interface BarRow {
  label: string;
  colour: string;
  mean: number;
  /** Half-width of the 95% interval. */
  half: number;
  /** Drawn as an outline rather than filled, for a policy sharing its colour with another. */
  hollow?: boolean;
}

export function barChart(
  figure: HTMLElement,
  title: string,
  subtitle: string,
  rows: BarRow[],
  format: (value: number) => string,
): void {
  const width = frame(figure, title, subtitle);
  // Each row: the label and value on one line at the text size, the bar under them.
  const rowHeight = 46;
  const top = 2;
  const axis = 28;
  const right = 12;
  const height = top + rows.length * rowHeight + axis;
  const highest = Math.max(...rows.map((r) => r.mean + (Number.isFinite(r.half) ? r.half : 0)));
  const ticks = niceTicks(Number.isFinite(highest) ? highest : 1);
  const end = ticks.at(-1)!;
  const x = (value: number) => (Math.max(0, value) / end) * (width - right);
  const svg = el("svg", {
    class: "chart",
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${title}, ${subtitle}. ${rows.map((r) => `${r.label} ${format(r.mean)}`).join("; ")}.`,
  });
  const base = height - axis;
  for (const tick of ticks) {
    svg.append(
      el("line", { class: "grid", x1: x(tick), x2: x(tick), y1: top, y2: base }),
      el(
        "text",
        {
          class: "tick",
          x: Math.min(x(tick), width - 4),
          y: height - 6,
          "text-anchor": tick === 0 ? "start" : "end",
        },
        format(tick),
      ),
    );
  }
  rows.forEach((row, i) => {
    const y = top + i * rowHeight;
    const group = el("g", {});
    const w = Number.isFinite(row.mean) ? Math.max(x(row.mean), 4) : 0;
    const lo = x(row.mean - row.half);
    const hi = x(row.mean + row.half);
    const value = `${format(row.mean)}${Number.isFinite(row.half) ? ` ± ${format(row.half)}` : ""}`;
    group.append(
      el("rect", { x: 0, y, width, height: rowHeight, fill: "transparent" }),
      el("text", { class: "label", x: 6, y: y + 17 }, row.label),
      el("text", { class: "value", x: width - right, y: y + 17, "text-anchor": "end" }, value),
      row.hollow
        ? el("rect", {
            class: "hollow",
            x: 1,
            y: y + 26,
            width: Math.max(w - 2, 2),
            height: 10,
            style: `stroke: ${row.colour}`,
          })
        : el("rect", { x: 0, y: y + 25, width: w, height: 12, style: `fill: ${row.colour}` }),
    );
    if (Number.isFinite(row.half) && hi - lo >= 1) {
      group.append(
        el("path", {
          class: "whisker",
          d: `M${lo} ${y + 31}H${hi}M${lo} ${y + 26}v10M${hi} ${y + 26}v10`,
        }),
      );
    }
    group.addEventListener("pointermove", (event) =>
      showTooltip((event as PointerEvent).clientX, (event as PointerEvent).clientY, [
        [row.label, row.colour],
        [`${title}: ${value}`, null],
      ]),
    );
    group.addEventListener("pointerleave", hideTooltip);
    svg.append(group);
  });
  svg.append(el("line", { class: "axis", x1: 0, x2: 0, y1: top, y2: base }));
  figure.append(svg);
}

export interface LineSeries {
  label: string;
  colour: string;
  values: number[];
  /** Half-widths of 95% intervals, drawn as a band. */
  half?: number[];
  dashed?: boolean;
}

export interface LineOptions {
  title: string;
  subtitle: string;
  x: number[];
  xFormat: (value: number) => string;
  yFormat: (value: number) => string;
  xTitle: string;
  yTitle: string;
  series: LineSeries[];
  /** Where the legend goes; it is always drawn for two series or more. */
  legend: HTMLElement;
}

export function lineChart(figure: HTMLElement, o: LineOptions): void {
  const width = frame(figure, o.title, o.subtitle);
  const height = 290;
  const all = o.series.flatMap((s) => s.values.map((v, i) => v + (s.half?.[i] ?? 0)));
  const ticks = niceTicks(Math.max(...all.filter(Number.isFinite), 0));
  // Room on the left for the longest y label at the text size (a figure is about 9 px wide).
  const longest = Math.max(...ticks.map((t) => o.yFormat(t).length));
  const m = { left: longest * 9 + 14, right: 14, top: 36, bottom: 56 };
  const end = ticks.at(-1)!;
  const x0 = o.x[0]!;
  const x1 = o.x.at(-1)!;
  const sx = (v: number) => m.left + ((v - x0) / (x1 - x0 || 1)) * (width - m.left - m.right);
  const sy = (v: number) => height - m.bottom - (v / end) * (height - m.top - m.bottom);
  const svg = el("svg", {
    class: "chart",
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${o.title}, ${o.subtitle}. The table below gives the values.`,
  });
  for (const tick of ticks) {
    svg.append(
      el("line", { class: "grid", x1: m.left, x2: width - m.right, y1: sy(tick), y2: sy(tick) }),
      el(
        "text",
        { class: "tick", x: m.left - 8, y: sy(tick) + 6, "text-anchor": "end" },
        o.yFormat(tick),
      ),
    );
  }
  const every = Math.ceil(o.x.length / Math.max(2, Math.floor((width - m.left) / 64)));
  o.x.forEach((v, i) => {
    if (i % every !== 0 && i !== o.x.length - 1) return;
    svg.append(
      el(
        "text",
        { class: "tick", x: sx(v), y: height - m.bottom + 22, "text-anchor": "middle" },
        o.xFormat(v),
      ),
    );
  });
  svg.append(
    el("line", { class: "axis", x1: m.left, x2: width - m.right, y1: sy(0), y2: sy(0) }),
    el(
      "text",
      { class: "tick", x: (m.left + width - m.right) / 2, y: height - 5, "text-anchor": "middle" },
      o.xTitle,
    ),
    el("text", { class: "tick", x: 0, y: 17 }, o.yTitle),
  );
  for (const s of o.series) {
    const points = s.values
      .map((v, i) => [sx(o.x[i]!), v] as const)
      .filter(([, v]) => Number.isFinite(v));
    if (s.half) {
      const upper = s.values.map((v, i) => `${sx(o.x[i]!)},${sy(v + (s.half![i] || 0))}`);
      const lower = s.values.map(
        (v, i) => `${sx(o.x[i]!)},${sy(Math.max(0, v - (s.half![i] || 0)))}`,
      );
      svg.append(
        el("polygon", {
          class: "band",
          points: [...upper, ...lower.reverse()].join(" "),
          style: `fill: ${s.colour}`,
        }),
      );
    }
    svg.append(
      el("polyline", {
        class: s.dashed ? "series dashed" : "series",
        points: points.map(([px, v]) => `${px.toFixed(1)},${sy(v).toFixed(1)}`).join(" "),
        style: `stroke: ${s.colour}`,
      }),
    );
    if (!s.dashed) {
      for (const [px, v] of points) {
        svg.append(
          el("circle", { class: "dot", cx: px, cy: sy(v), r: 3.5, style: `fill: ${s.colour}` }),
        );
      }
    }
  }

  // Hover: a crosshair at the nearest x, with every series' value.
  const cursor = el("line", {
    class: "cursor",
    y1: m.top,
    y2: height - m.bottom,
    visibility: "hidden",
  });
  const hit = el("rect", {
    x: m.left,
    y: m.top,
    width: width - m.left - m.right,
    height: height - m.top - m.bottom,
    fill: "transparent",
  });
  svg.append(cursor, hit);
  hit.addEventListener("pointermove", (event) => {
    const e = event as PointerEvent;
    const box = svg.getBoundingClientRect();
    const px = e.clientX - box.left;
    let best = 0;
    o.x.forEach((v, i) => {
      if (Math.abs(sx(v) - px) < Math.abs(sx(o.x[best]!) - px)) best = i;
    });
    cursor.setAttribute("x1", String(sx(o.x[best]!)));
    cursor.setAttribute("x2", String(sx(o.x[best]!)));
    cursor.setAttribute("visibility", "visible");
    showTooltip(e.clientX, e.clientY, [
      [`${o.xTitle}: ${o.xFormat(o.x[best]!)}`, null],
      ...o.series.map((s): [string, string] => {
        const half = s.half?.[best];
        const v = s.values[best]!;
        const tail = half !== undefined && Number.isFinite(half) ? ` ± ${o.yFormat(half)}` : "";
        return [`${s.label}: ${Number.isFinite(v) ? o.yFormat(v) : "-"}${tail}`, s.colour];
      }),
    ]);
  });
  hit.addEventListener("pointerleave", () => {
    cursor.setAttribute("visibility", "hidden");
    hideTooltip();
  });
  figure.append(svg);

  o.legend.replaceChildren(
    ...o.series.map((s) => {
      const li = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = s.dashed ? "swatch dashed" : "swatch line";
      swatch.style.color = s.colour;
      li.append(swatch, s.label);
      return li;
    }),
  );
}
