/**
 * Source Control: the history's graph lanes, VS Code style but simpler. Each commit row gets the
 * lanes that pass through it, the lane of its dot, and where its parents continue. Pure; drawn by
 * app/scm-history.tsx as a small SVG per row.
 *
 * The walk keeps a list of lanes, each waiting for a commit id. A commit takes the first lane
 * waiting for it (or a new one), every other lane waiting for it ends here (they merge into its
 * dot), its first parent continues in its lane and each further parent takes a lane of its own.
 *
 * @module
 */

/** What one row draws. */
export interface GraphRow {
  /** The dot's lane. */
  lane: number;
  /** Lanes with a line through the top half of the row (coming down from the row above). */
  above: number[];
  /** Lanes with a line through the bottom half (going on to the row below). */
  below: number[];
  /** Lines from the dot down to another lane (a merge's second parent, a branch point). */
  joins: number[];
  /** Lanes that end in the dot from above (another lane waiting for the same commit). */
  merges: number[];
}

/** The graph of `commits` (newest first, each with its parent ids). */
export function graphRows(
  commits: readonly { oid: string; parents: readonly string[] }[],
): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  const active = () => lanes.flatMap((l, i) => (l === null ? [] : [i]));
  for (const c of commits) {
    let lane = lanes.indexOf(c.oid);
    const above = active();
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.push(null) - 1;
    }
    const merges: number[] = [];
    lanes.forEach((l, i) => {
      if (l === c.oid && i !== lane) {
        merges.push(i);
        lanes[i] = null;
      }
    });
    lanes[lane] = c.parents[0] ?? null;
    const joins: number[] = [];
    for (const p of c.parents.slice(1)) {
      let pl = lanes.indexOf(p);
      if (pl < 0) {
        pl = lanes.indexOf(null);
        if (pl < 0) pl = lanes.push(null) - 1;
        lanes[pl] = p;
      }
      joins.push(pl);
    }
    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop();
    rows.push({ lane, above, below: active(), joins, merges });
  }
  return rows;
}

/** The widest row's lane count (the SVG's width). */
export function graphWidth(rows: readonly GraphRow[]): number {
  let n = 1;
  for (const r of rows) {
    n = Math.max(
      n,
      r.lane + 1,
      ...r.above.map((l) => l + 1),
      ...r.below.map((l) => l + 1),
    );
  }
  return n;
}
