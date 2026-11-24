// The e2e runner (`deno task test:e2e [files…]`): every test file in its own `deno test`
// process with a time limit, so one file that hangs fails on its own instead of eating the whole
// CI job's time. The app is exported and the files type-checked once, up front.
//
// Environment:
//   E2E_ONLY=<a,b>           only the files whose name contains one of these (`motion`, `bar_test`)
//   E2E_REPEAT=<n>           run the selection n times (a flake hunt); stops at the first failure
//   E2E_FILE_TIMEOUT_MIN=<m> one file's limit in minutes (default 10)
// and everything the harness reads (E2E_FILTER, E2E_TIMEOUT_SCALE, E2E_CPU_THROTTLE, …).

import { basename, fromFileUrl, join, relative } from "@std/path";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));
const DIR = fromFileUrl(new URL(".", import.meta.url));

const only = (Deno.env.get("E2E_ONLY") ?? "").split(",").map((s) => s.trim())
  .filter(Boolean);
const repeat = Math.max(1, Number(Deno.env.get("E2E_REPEAT")) || 1);
const limitMs = (Number(Deno.env.get("E2E_FILE_TIMEOUT_MIN")) || 10) * 60_000;

async function testFiles(): Promise<string[]> {
  if (Deno.args.length > 0) return Deno.args.map((a) => relative(ROOT, a));
  const out: string[] = [];
  for await (const e of Deno.readDir(DIR)) {
    if (e.isFile && e.name.endsWith("_test.ts")) {
      out.push(relative(ROOT, join(DIR, e.name)));
    }
  }
  return out.sort();
}

async function run(args: string[], env: Record<string, string> = {}) {
  return await new Deno.Command(Deno.execPath(), { args, cwd: ROOT, env })
    .spawn().status;
}

/** Kill a timed-out file's test process and every Chromium it launched (their profiles carry `tag`). */
async function killFile(child: Deno.ChildProcess, tag: string) {
  try {
    child.kill("SIGKILL");
  } catch {
    // Exited already.
  }
  await child.status;
  await new Deno.Command("pkill", {
    args: ["-9", "-f", `gui-terminal-e2e-chrome-${tag}-`],
  }).output().catch(() => {});
}

const files = (await testFiles()).filter((f) =>
  only.length === 0 || only.some((o) => basename(f).includes(o))
);
if (files.length === 0) {
  console.error(`e2e: no test file matches E2E_ONLY=${only.join(",")}`);
  Deno.exit(1);
}

if (Deno.env.get("E2E_NO_BUILD") !== "1") {
  const built = await run(["task", "export"]);
  if (!built.success) Deno.exit(built.code || 1);
}
const checked = await run(["check", ...files]);
if (!checked.success) Deno.exit(checked.code || 1);

const results: { file: string; round: number; outcome: string }[] = [];
let failed = false;
for (let round = 1; round <= repeat && !failed; round++) {
  for (const file of files) {
    const tag = `${Deno.pid}-${results.length}`;
    if (repeat > 1) console.log(`\ne2e: round ${round}/${repeat}: ${file}`);
    const child = new Deno.Command(Deno.execPath(), {
      args: ["test", "-A", "--no-check", file],
      cwd: ROOT,
      env: { E2E_NO_BUILD: "1", E2E_PROFILE_TAG: tag },
    }).spawn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), limitMs);
    });
    const status = await Promise.race([child.status, timedOut]);
    clearTimeout(timer);
    let outcome: string;
    if (status === "timeout") {
      await killFile(child, tag);
      outcome = `TIMED OUT after ${limitMs / 60_000} min (killed)`;
      console.error(`\ne2e: ${file} ${outcome}`);
    } else {
      outcome = status.success ? "ok" : `FAILED (exit ${status.code})`;
    }
    results.push({ file, round, outcome });
    if (outcome !== "ok") failed = true;
    if (failed && repeat > 1) break;
  }
}

console.log("\ne2e summary:");
for (const r of results) {
  console.log(
    `  ${repeat > 1 ? `[${r.round}] ` : ""}${r.file}: ${r.outcome}`,
  );
}
Deno.exit(failed ? 1 : 0);
