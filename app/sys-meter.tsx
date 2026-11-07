// The switcher bar's system meter (Settings → System monitor → Show in the bar): two mini bars,
// "CPU 23%" and "GPU 61%", from app/use-sysstats.ts. A figure the machine does not give (no GPU
// reading) is left out; along a side bar the labels are dropped and the bars stack.

import { formatStats, type Smoothed } from "../lib/sysstats.ts";

/** How full a bar looks: calm, busy (≥ 60%), or hot (≥ 85%). */
function level(v: number): "calm" | "busy" | "hot" {
  return v >= 85 ? "hot" : v >= 60 ? "busy" : "calm";
}

export function SysMeter(props: { stats: Smoothed; vertical: boolean }) {
  const { stats } = props;
  const rows = ([["cpu", "CPU"], ["gpu", "GPU"]] as const).filter(([k]) =>
    stats[k] !== null
  );
  const title = [
    formatStats(stats) || "Reading the CPU and GPU…",
    stats.mem === null ? "" : `memory ${Math.round(stats.mem)}%`,
  ].filter(Boolean).join(" · ");
  return (
    <div
      class={`sys-meter${props.vertical ? " is-vertical" : ""}`}
      data-testid="sys-meter"
      role="group"
      aria-label={title}
      title={title}
    >
      {rows.map(([key, label]) => {
        const v = Math.round(stats[key]!);
        return (
          <span
            class="sys-meter-row"
            data-testid={`sys-meter-${key}`}
            data-value={v}
            data-level={level(v)}
            key={key}
          >
            {!props.vertical && <span class="sys-meter-label">{label}</span>}
            <span class="sys-meter-bar" aria-hidden="true">
              <span style={{ width: `${v}%` }} />
            </span>
            {!props.vertical && <span class="sys-meter-value">{v}%</span>}
          </span>
        );
      })}
    </div>
  );
}
