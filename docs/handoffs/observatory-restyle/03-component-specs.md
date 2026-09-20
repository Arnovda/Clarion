# Component specs

Every component here has: **purpose**, **markup pattern**, **variants**, **behaviors**, **notes**. Copy the markup as-is unless a note says "adapt to existing props." Classes assume the Tailwind extension from `02-tokens-and-config.md` is installed.

---

## Button

**Purpose.** The only button primitive. All call-to-actions route through it.

**Markup.**
```tsx
<button className="inline-flex items-center gap-2 font-sans font-medium text-[13.5px] leading-none
                   px-4 py-[9px] rounded-sm border transition-all duration-1 ease-observatory
                   [variant classes]">
  {icon} {label}
</button>
```

**Variants.**
| Variant | Classes |
|---|---|
| `primary` | `bg-ocean text-white border-ocean hover:bg-ocean-hover hover:border-ocean-hover` |
| `secondary` | `bg-raised text-ink border-line hover:border-line-strong hover:bg-softer` |
| `ghost` | `bg-transparent text-ink-2 border-transparent hover:bg-soft` |
| `danger` | `bg-err text-white border-err hover:opacity-90` |

**Sizes.**
| Size | Padding / font |
|---|---|
| `sm` | `px-3 py-[6px] text-[12.5px]` |
| `md` | (default) `px-4 py-[9px] text-[13.5px]` |
| `lg` | `px-[22px] py-[12px] text-[14.5px]` |

**Behaviors.** Disabled state: `opacity-50 cursor-not-allowed`. Loading state shows a spinner in the icon slot, label stays. Focus ring: `focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]`.

---

## Input

**Markup.**
```tsx
<div className="flex flex-col gap-1.5">
  {label && <label className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium">{label}</label>}
  <input className="font-sans text-[14px] px-[13px] py-[10px] rounded-sm border border-line bg-raised text-ink
                    outline-none transition-all duration-1 focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)]" />
  {hint && <span className="font-mono text-[10.5px] text-muted-2">{hint}</span>}
  {error && <span className="font-mono text-[10.5px] text-err">{error}</span>}
</div>
```

---

## Select / dropdown

If Radix or Headless UI is already in the repo, style their trigger to match the Input spec above. Dropdown menu: `bg-raised border border-line rounded-md shadow-2 py-1`. Items: `px-3 py-1.5 text-[13.5px] text-ink-2 hover:bg-softer hover:text-ink cursor-pointer`.

---

## Badge

```tsx
<span className="inline-flex items-center gap-1.5 px-[9px] py-[3px] rounded-full
                 font-mono text-[10.5px] tracking-[0.04em] font-medium uppercase
                 [variant classes]">
  <span className="w-1.5 h-1.5 rounded-full bg-current" />
  {children}
</span>
```

| Variant | Classes |
|---|---|
| `ai` | `bg-ai-soft text-ai` |
| `ocean` | `bg-ocean-soft text-ocean` |
| `ok` | `bg-ok-soft text-ok` |
| `warn` | `bg-warn-soft text-warn` |
| `err` | `bg-err-soft text-err` |
| `neu` | `bg-soft text-ink-3` |

The pip dot is optional — include when the badge is a live/status indicator.

---

## Card

**Variants.**
- `default` — `bg-raised border border-line rounded-md shadow-1`
- `raised` — `bg-raised rounded-lg shadow-2` (no border)
- `outlined` — `bg-transparent border border-line rounded-md` (no shadow)

Padding: `p-5` (card body), `px-5 py-4` (card header with bottom border `border-b border-softer`).

---

## Table

```tsx
<table className="w-full border-collapse text-[13px]">
  <thead>
    <tr>
      <th className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted font-medium
                     px-3 py-2 text-left border-b border-line bg-softer">
        Header
      </th>
    </tr>
  </thead>
  <tbody>
    <tr className="hover:bg-softer">
      <td className="px-3 py-2.5 border-b border-softer text-ink-2">Cell</td>
      <td className="px-3 py-2.5 border-b border-softer text-right font-mono tabular-nums text-ink">Numbers</td>
    </tr>
  </tbody>
</table>
```

Rule: **every numeric column uses `font-mono tabular-nums text-right`**. Never center-align numbers.

---

## Tabs

```tsx
<div className="flex gap-1 border-b border-line">
  <button className="px-4 py-2.5 text-[13px] text-muted border-b-2 border-transparent hover:text-ink">Inactive</button>
  <button className="px-4 py-2.5 text-[13px] text-ocean border-b-2 border-ocean font-medium">Active</button>
</div>
```

---

## Toast

Position fixed top-right, `top-4 right-4 z-50`. `bg-raised border border-line rounded-md shadow-3 px-4 py-3 flex gap-3 items-start min-w-[320px]`. Success: add `border-l-2 border-l-ok`. Error: `border-l-2 border-l-err`. Title: `font-sans font-medium text-[13.5px]`. Body: `text-[12.5px] text-ink-3`.

---

## Modal

Overlay: `fixed inset-0 bg-ink/40 backdrop-blur-[2px] z-50`. Dialog: `bg-raised rounded-lg shadow-3 max-w-[480px] w-full mx-auto mt-[15vh]`. Header: `px-7 py-5 border-b border-softer`. Title: `font-display font-medium text-[22px] tracking-[-0.02em]`. Eyebrow above title: mono, muted. Body: `px-7 py-6`. Footer: `px-7 py-4 border-t border-softer flex gap-2 justify-end bg-surface rounded-b-lg`.

---

## Skeleton

```tsx
<div className="bg-softer rounded-sm animate-pulse" style={{height: 16, width: '60%'}} />
```

Prefer: three stacked skeleton bars at 80%, 60%, 40% width for text blocks. For charts, a flat `h-40 bg-softer rounded-sm`.

---

# Composite components

## KPITile

```tsx
<div className="bg-raised border border-line rounded-md p-5 shadow-1">
  <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted mb-2">{label}</div>
  <div className="font-display font-medium text-[44px] leading-none tracking-[-0.02em] tabular-nums">{value}</div>
  {delta && (
    <div className={cn("font-mono text-[11.5px] mt-1.5", delta > 0 ? "text-ok" : "text-err")}>
      {delta > 0 ? '↑' : '↓'} {Math.abs(delta)}{unit}
    </div>
  )}
  {subtitle && <div className="text-[12px] text-muted mt-1">{subtitle}</div>}
</div>
```

## ChartCard

```tsx
<div className="bg-raised border border-line rounded-md p-5 shadow-1">
  <div className="flex justify-between items-baseline mb-4">
    <div>
      <div className="font-sans font-semibold text-[14px]">{title}</div>
      <div className="font-mono text-[10.5px] text-muted tracking-[0.04em] mt-0.5">{subtitle}</div>
    </div>
    {actions}
  </div>
  <div className="h-[260px]">{/* Recharts goes here */}</div>
</div>
```

**Recharts theming.** Use `--c1`..`--c6` for series. Grid lines: `stroke="var(--line)"`, `strokeDasharray="2 3"`, `strokeOpacity={0.6}`. Axes: `tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--muted)' }}`. No chart background. Tooltip: `contentStyle={{ background: 'var(--raised)', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12, fontFamily: 'var(--font-mono)' }}`.

## AIResponseBlock

```tsx
<div className="bg-surface border border-softer border-l-2 border-l-ai rounded-sm px-5 py-4">
  <div className="font-display text-[16px] leading-[1.55] text-ink">{/* body with <em> and <b> */}</div>
  <div className="mt-3 pt-2.5 border-t border-softer flex gap-3 font-mono text-[10px] tracking-[0.06em] text-muted">
    <span>{confidence}% · {sources.length} tables</span>
    <span>·</span>
    <a className="text-ink-2 underline decoration-line-strong">show SQL</a>
    <a className="text-ink-2 underline decoration-line-strong">pin</a>
  </div>
</div>
```

## JobProgressBanner

Sticky top of relevant pages. `bg-ocean-softer border-b border-ocean-soft px-6 py-3 flex items-center gap-4`. Step list: `font-mono text-[10.5px] uppercase tracking-[0.08em] text-ocean`. Progress bar: `h-0.5 bg-ocean-soft` with `bg-ocean` width %.

## NotificationBell

Plain icon button. Dot indicator: `absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-err`. Dropdown uses the standard menu pattern.

## SourceCard

```tsx
<div className="bg-raised border border-line rounded-md p-4 flex items-center gap-3 hover:border-line-strong">
  <div className="w-10 h-10 rounded-sm bg-softer flex items-center justify-center font-mono text-[13px] font-semibold text-ink">
    {abbr /* e.g. "PG" */}
  </div>
  <div className="flex-1 min-w-0">
    <div className="font-mono text-[12.5px] font-medium text-ink truncate">{name}</div>
    <div className="text-[11.5px] text-muted">{rows} rows · synced {when}</div>
  </div>
  <Badge variant="ok">LIVE</Badge>
</div>
```

## OutlineRail

Sticky right column on Reports and Notebooks. `bg-raised border border-line rounded-md p-4 sticky top-20`. Items: `block py-1.5 px-2.5 text-[12px] text-ink-2 border-l-2 border-softer -ml-0.5 hover:border-line-strong hover:text-ocean`. Active: `border-ocean text-ocean font-medium`. Eyebrow above each: `font-mono text-[9.5px] uppercase tracking-[0.04em] text-muted-2 mb-0.5`.

## NotebookCell

A polymorphic shell. The wrapper provides the hover bar on the left and the header row; each cell-type component renders its own body.

Shell markup:
```tsx
<div className="group relative py-3.5 rounded-sm">
  <div className="absolute -left-4 top-3.5 bottom-3.5 w-0.5 rounded-sm bg-transparent
                  group-hover:bg-line group-data-[active]:bg-ocean transition-colors" />
  <div className="flex items-center gap-2.5 mb-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
    <span className="text-muted-2 tabular-nums">{String(index+1).padStart(2,'0')}</span>
    <span className={typePillClass}>{cellType}</span>
    {runtime && <span className="px-1.5 py-0.5 rounded-full bg-ok-soft text-ok">{runtime}</span>}
    <span className="flex-1" />
    <button className="px-1.5 text-muted-2 hover:text-ink">Re-run</button>
    <button className="px-1.5 text-muted-2 hover:text-ink">⋯</button>
  </div>
  {children /* per-cell body */}
</div>
```

Cell-type pills:
| Type | Class |
|---|---|
| `ask` | `px-1.5 py-0.5 rounded bg-ai-soft text-ai` |
| `sql` | `px-1.5 py-0.5 rounded bg-softer text-ink-2` |
| `chart` | `px-1.5 py-0.5 rounded bg-ocean-softer text-ocean` |
| `kpi` | `px-1.5 py-0.5 rounded bg-ocean-softer text-ocean` |
| `md` | `px-1.5 py-0.5 rounded bg-softer text-ink-3` |
| `table` | `px-1.5 py-0.5 rounded bg-softer text-ink-2` |
| `filter` | `px-1.5 py-0.5 rounded bg-softer text-ink-2` |
| `python` | `px-1.5 py-0.5 rounded bg-softer text-ink-2` |

**Cell bodies.** SQL cell = dark `bg-[#0f1a22] text-[#e3e6ea]` code block + a result table beneath. Ask cell = serif question + `AIResponseBlock`. Chart cell = `ChartCard` body only. KPI cell = 3-col grid of `KPITile`. Markdown cell = `font-display text-[17px] text-ink-2`. Filter cell = `Cell-filter` from reference.

**Add-cell menu.** Centered chip strip below last cell: small pill buttons reading `+ ASK`, `+ SQL`, etc., same classes as the type pills, muted state.
