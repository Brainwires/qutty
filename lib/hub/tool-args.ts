/**
 * The hub tools' argument readers (lib/hub/tools.ts, lib/hub/web-tools.ts): a bad argument is
 * the caller's mistake, a {@linkcode HubError} (an `isError` result the model can read and act
 * on). Client-safe.
 *
 * @module
 */

import { HubError } from "./core.ts";

export function str(
  args: Record<string, unknown>,
  key: string,
  max = 32 * 1024,
): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new HubError(`"${key}" must be a non-empty string`);
  }
  if (v.length > max) throw new HubError(`"${key}" is too long`);
  return v;
}

export function optStr(
  args: Record<string, unknown>,
  key: string,
  max?: number,
): string | undefined {
  return args[key] === undefined || args[key] === null
    ? undefined
    : str(args, key, max);
}

export function optInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HubError(`"${key}" must be an integer in ${min}..${max}`);
  }
  return v;
}

export function optBool(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    throw new HubError(`"${key}" must be true or false`);
  }
  return v;
}
