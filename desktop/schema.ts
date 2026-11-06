// Tiny Standard Schema validators for the desktop extensions' method inputs (no schema library
// dependency). Shared by desktop/pty.ts and desktop/ssh.ts.

export type Issue = { message: string; path?: PropertyKey[] };

/** A Standard Schema v1 (structurally what `DesktopCapabilityMethod.input` takes), typed for the page. */
export interface Schema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => { readonly value: T; readonly issues?: undefined } | {
      readonly issues: readonly Issue[];
    };
    readonly types?: { readonly input: T; readonly output: T };
  };
}

export function objectSchema<T>(
  parse: (v: Record<string, unknown>, issues: Issue[]) => T,
): Schema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "qutty",
      validate(value: unknown) {
        if (
          typeof value !== "object" || value === null || Array.isArray(value)
        ) {
          return { issues: [{ message: "expected an object" }] };
        }
        const issues: Issue[] = [];
        const out = parse(value as Record<string, unknown>, issues);
        return issues.length > 0 ? { issues } : { value: out };
      },
    },
  };
}

export const emptyInput: Schema<Record<string, never>> = objectSchema(
  () => ({}),
);

export const MAX_DIM = 10_000;

export function dim(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
): number {
  const n = v[key];
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_DIM) {
    issues.push({
      message: `${key} must be an integer in 1..${MAX_DIM}`,
      path: [key],
    });
    return 1;
  }
  return n;
}

/** A non-empty string of at most `max` chars. A NUL would truncate it on the way to a C string. */
export function str(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
  max = 4096,
): string {
  const s = v[key];
  if (typeof s !== "string" || s === "" || s.length > max) {
    issues.push({ message: `${key} must be a non-empty string`, path: [key] });
    return "";
  }
  if (s.includes("\0")) {
    issues.push({ message: `${key} must not contain NUL`, path: [key] });
    return "";
  }
  return s;
}

export function optStr(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
  max = 4096,
): string | undefined {
  return v[key] === undefined ? undefined : str(v, key, issues, max);
}

/** A list of at most `maxItems` strings, each a valid `str`. */
export function strList(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
  maxItems: number,
  maxLen = 4096,
): string[] {
  const list = v[key];
  if (!Array.isArray(list) || list.length > maxItems) {
    issues.push({
      message: `${key} must be a list of at most ${maxItems} strings`,
      path: [key],
    });
    return [];
  }
  return list.map((item, i) => {
    if (typeof item !== "string" || item === "" || item.length > maxLen) {
      issues.push({
        message: `${key} must hold non-empty strings`,
        path: [key, i],
      });
      return "";
    }
    if (item.includes("\0")) {
      issues.push({ message: `${key} must not contain NUL`, path: [key, i] });
      return "";
    }
    return item;
  });
}

export function optStrList(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
  maxItems: number,
  maxLen = 4096,
): string[] | undefined {
  return v[key] === undefined
    ? undefined
    : strList(v, key, issues, maxItems, maxLen);
}

export function optBool(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
): boolean | undefined {
  const b = v[key];
  if (b !== undefined && typeof b !== "boolean") {
    issues.push({ message: `${key} must be a boolean`, path: [key] });
    return undefined;
  }
  return b;
}

/** An optional integer in `min..max`. */
export function optInt(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
  min: number,
  max: number,
): number | undefined {
  const n = v[key];
  if (n === undefined) return undefined;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    issues.push({
      message: `${key} must be an integer in ${min}..${max}`,
      path: [key],
    });
    return undefined;
  }
  return n;
}
