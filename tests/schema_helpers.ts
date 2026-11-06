// Shared by the extension schema tests (pty_schema_test.ts, ssh_schema_test.ts): run a method's
// input schema the way the desktop bridge does and assert on the outcome. Not a test module.

import { assert, assertEquals } from "@std/assert";

type Validate = (v: unknown) => unknown;

/** What a Standard Schema `validate` answers. */
export type Result = {
  value?: unknown;
  issues?: { message: string; path?: PropertyKey[] }[];
};

interface Extension {
  name: string;
  events?: readonly string[];
  perWindow?: boolean;
  methods: Record<
    string,
    {
      input: {
        "~standard": { validate: unknown; version: number; vendor: string };
      };
    }
  >;
}

/** The extension's declared shape: name, events, method names, `perWindow`, our vendor tag. */
export function assertExtensionShape(
  ext: Extension,
  expected: { name: string; events: string[]; methods: string[] },
): void {
  assertEquals(ext.name, expected.name);
  assertEquals([...(ext.events ?? [])].sort(), [...expected.events].sort());
  assertEquals(Object.keys(ext.methods).sort(), [...expected.methods].sort());
  assertEquals(ext.perWindow, true);
  for (const m of Object.values(ext.methods)) {
    assertEquals(m.input["~standard"].version, 1);
    assertEquals(m.input["~standard"].vendor, "qutty");
  }
}

/** What no method input may be. */
const NON_OBJECTS: unknown[] = [
  null,
  undefined,
  0,
  1,
  "x",
  "",
  true,
  [],
  [1, 2],
  () => {},
  Symbol("s"),
];

/** Validators over `ext`'s methods: `v` runs one, `ok` expects a value, `bad` expects issues. */
export function schemaTesters<E extends Extension>(ext: E) {
  type Method = keyof E["methods"] & string;
  const v = (name: Method): Validate => (x) =>
    (ext.methods[name].input["~standard"].validate as Validate)(x);

  const ok = (name: Method, input: unknown): unknown => {
    const r = v(name)(input) as Result;
    assert(
      !r.issues,
      `${name} ${JSON.stringify(input)} rejected: ${JSON.stringify(r.issues)}`,
    );
    return r.value;
  };

  /** `paths`: the distinct first path segments of the issues, in any order. */
  const bad = (name: Method, input: unknown, paths?: string[]): void => {
    const r = v(name)(input) as Result;
    assert(
      r.issues && r.issues.length > 0,
      `${name} accepted ${String(JSON.stringify(input))}`,
    );
    assert(!("value" in r), "no value alongside issues");
    for (const i of r.issues!) {
      assert(typeof i.message === "string" && i.message.length > 0);
    }
    if (paths) {
      assertEquals(
        [...new Set(r.issues!.map((i) => String(i.path?.[0])))].sort(),
        [...paths].sort(),
        `${name} ${JSON.stringify(input)} issue paths: ${
          JSON.stringify(r.issues)
        }`,
      );
    }
  };

  /** Every method rejects every {@linkcode NON_OBJECTS} entry. */
  const rejectsNonObjects = (): void => {
    for (const name of Object.keys(ext.methods) as Method[]) {
      for (const x of NON_OBJECTS) bad(name, x);
    }
  };

  return { v, ok, bad, rejectsNonObjects };
}
