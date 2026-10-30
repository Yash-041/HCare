export interface Column<T> {
  key: keyof T & string;
  label: string;
  options?: [string, string][];
  placeholder?: string;
  required?: boolean;
}

/** Small table editor for list fields (symptoms, medicines, allergies, labs). */
export function RowsEditor<T extends Record<string, unknown>>({
  rows,
  columns,
  blank,
  onChange,
  disabled,
  addLabel,
  errors,
  path,
}: {
  rows: T[];
  columns: Column<T>[];
  blank: T;
  onChange: (rows: T[]) => void;
  disabled?: boolean;
  addLabel: string;
  errors?: Record<string, string>;
  path: string;
}) {
  const update = (i: number, key: keyof T, value: string) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, [key]: value === "" ? null : value } : r)));

  return (
    <div className="rows">
      {rows.map((row, i) => (
        <div key={i} className={`row ${errors?.[`${path}.${i}`] ? "row-error" : ""}`}>
          {columns.map((c) =>
            c.options ? (
              <select
                key={c.key}
                aria-label={c.label}
                value={(row[c.key] as string | null) ?? ""}
                disabled={disabled}
                onChange={(e) => update(i, c.key, e.target.value)}
              >
                <option value="">{c.label}: —</option>
                {c.options.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            ) : (
              <input
                key={c.key}
                aria-label={c.label}
                placeholder={c.placeholder ?? c.label}
                value={(row[c.key] as string | null) ?? ""}
                disabled={disabled}
                onChange={(e) => update(i, c.key, e.target.value)}
              />
            ),
          )}
          {!disabled && (
            <button type="button" className="link danger-link" aria-label="Remove row" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          )}
          {errors?.[`${path}.${i}`] && <span className="error small row-msg">{errors[`${path}.${i}`]}</span>}
        </div>
      ))}
      {!disabled && (
        <button type="button" className="link" onClick={() => onChange([...rows, { ...blank }])}>
          + {addLabel}
        </button>
      )}
    </div>
  );
}
