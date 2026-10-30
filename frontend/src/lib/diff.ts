/** Field-level three-way comparison (base / mine / server) for the conflict screen. */

export interface FieldDiff {
  field: string;
  base: unknown;
  mine: unknown;
  server: unknown;
  mineChanged: boolean;
  serverChanged: boolean;
  /** Both sides changed it to different values: needs a human decision. */
  clash: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function threeWayDiff(base: unknown, mine: unknown, server: unknown): FieldDiff[] {
  const b = (base ?? {}) as Record<string, unknown>;
  const m = (mine ?? {}) as Record<string, unknown>;
  const s = (server ?? {}) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(s)])].sort();
  return fields
    .map((field) => {
      const mineChanged = !same(b[field], m[field]);
      const serverChanged = !same(b[field], s[field]);
      return {
        field,
        base: b[field],
        mine: m[field],
        server: s[field],
        mineChanged,
        serverChanged,
        clash: mineChanged && serverChanged && !same(m[field], s[field]),
      };
    })
    .filter((d) => !same(d.mine, d.server));
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.map(formatValue).join(", ") : "—";
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== undefined);
    return entries.length ? entries.map(([k, x]) => `${k}: ${formatValue(x)}`).join("; ") : "—";
  }
  return String(v);
}
