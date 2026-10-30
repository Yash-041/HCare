import { useId, useRef, useState } from "react";

export interface SparkSeries {
  name: string;
  /** Validated pair (dataviz validator, light surface): teal #0d9488 + orange #eb6834. */
  color: string;
  points: { date: string; value: number }[];
}

const W = 240;
const H = 56;
const PAD = 6;

const fmtDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });

/**
 * Tiny trend chart: 2px lines, ringed end-dots, crosshair + tooltip on hover/tap, and a
 * table view for screen readers. One y-axis only; multiple series share the same unit.
 */
export function Sparkline({ title, unit, series, decimals = 0 }: { title: string; unit: string; series: SparkSeries[]; decimals?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tableId = useId();

  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const values = series.flatMap((s) => s.points.map((p) => p.value));
  if (dates.length === 0) return null;
  const t = dates.map((d) => Date.parse(d));
  const [t0, t1] = [t[0], t[t.length - 1]];
  let [v0, v1] = [Math.min(...values), Math.max(...values)];
  if (v1 - v0 < 1e-9) [v0, v1] = [v0 - 1, v1 + 1];
  const x = (d: string) => (t1 === t0 ? W / 2 : PAD + ((Date.parse(d) - t0) / (t1 - t0)) * (W - 2 * PAD));
  const y = (v: number) => H - PAD - ((v - v0) / (v1 - v0)) * (H - 2 * PAD);
  const fmt = (v: number) => v.toFixed(decimals);

  function pick(clientX: number) {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((clientX - box.left) / box.width) * W;
    let best = 0;
    dates.forEach((d, i) => {
      if (Math.abs(x(d) - px) < Math.abs(x(dates[best]) - px)) best = i;
    });
    setHover(best);
  }

  const hoverDate = hover !== null ? dates[hover] : null;
  const latest = series.map((s) => s.points[s.points.length - 1]);

  return (
    <figure className="spark">
      <figcaption className="spark-head">
        <span className="spark-title">{title}</span>
        {/* Latest value as text in ink, not series color; legend only when >1 series. */}
        <span className="spark-latest">
          {latest.map((p) => (p ? fmt(p.value) : "–")).join(" / ")} <span className="muted">{unit}</span>
        </span>
      </figcaption>
      {series.length > 1 && (
        <div className="spark-legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="spark-plot">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title} trend, ${dates.length} readings`}
          aria-describedby={tableId}
          onPointerMove={(e) => pick(e.clientX)}
          onPointerDown={(e) => pick(e.clientX)}
          onPointerLeave={() => setHover(null)}
        >
          {hoverDate && <line x1={x(hoverDate)} x2={x(hoverDate)} y1={0} y2={H} className="spark-cross" vectorEffect="non-scaling-stroke" />}
          {series.map((s) => (
            <g key={s.name}>
              {s.points.length > 1 && (
                <polyline
                  points={s.points.map((p) => `${x(p.date)},${y(p.value)}`).join(" ")}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          ))}
        </svg>
        {/* Dots in HTML so they stay round while the SVG stretches horizontally. */}
        {series.map((s) =>
          s.points.map((p, i) => {
            const isEnd = i === s.points.length - 1;
            const isHover = p.date === hoverDate;
            if (!isEnd && !isHover) return null;
            return (
              <span
                key={`${s.name}-${p.date}`}
                className="spark-dot"
                style={{ left: `${(x(p.date) / W) * 100}%`, top: `${(y(p.value) / H) * 100}%`, background: s.color }}
              />
            );
          }),
        )}
        {hoverDate && (
          <div className="spark-tip" style={{ left: `${(x(hoverDate) / W) * 100}%` }} role="status">
            <strong>{fmtDate(hoverDate)}</strong>
            {series.map((s) => {
              const p = s.points.find((q) => q.date === hoverDate);
              return p ? (
                <span key={s.name}>
                  {series.length > 1 && <i style={{ background: s.color }} />}
                  {series.length > 1 ? `${s.name} ` : ""}
                  {fmt(p.value)} {unit}
                </span>
              ) : null;
            })}
          </div>
        )}
      </div>
      <table id={tableId} className="visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Date</th>
            {series.map((s) => (
              <th key={s.name}>
                {s.name} ({unit})
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((d) => (
            <tr key={d}>
              <td>{d}</td>
              {series.map((s) => (
                <td key={s.name}>{s.points.find((p) => p.date === d)?.value ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
