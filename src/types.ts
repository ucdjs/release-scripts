import type { PackageRelease } from "#shared/types";

export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  ok: true;
  value: T;
}

export interface Err<E> {
  ok: false;
  error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export interface ReleaseResult {
  /**
   * Packages that will be updated
   */
  updates: PackageRelease[];

  /**
   * URL of the created or updated PR
   */
  prUrl?: string;

  /**
   * Whether a new PR was created (vs updating existing)
   */
  created: boolean;
}
