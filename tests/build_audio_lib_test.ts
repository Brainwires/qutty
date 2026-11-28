import { assertEquals } from "@std/assert";
import { buildEnv } from "../scripts/build-audio-lib.ts";

Deno.test("audio lib: a packaging build turns off host CPU tuning; a dev build keeps it", () => {
  assertEquals(buildEnv(true, {}), { SOURCE_DATE_EPOCH: "0" });
  assertEquals(buildEnv(true, { SOURCE_DATE_EPOCH: "1700000000" }), {});
  assertEquals(buildEnv(false, {}), {});
});
