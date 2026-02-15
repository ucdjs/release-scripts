import type { Result } from "#types";
import { err, ok } from "#types";

export function map<T, E, U>(result: Result<T, E>, mapper: (value: T) => U): Result<U, E> {
  if (!result.ok) {
    return result;
  }

  return ok(mapper(result.value));
}

export async function mapAsync<T, E, U>(result: Result<T, E>, mapper: (value: T) => Promise<U>): Promise<Result<U, E>> {
  if (!result.ok) {
    return result;
  }

  return ok(await mapper(result.value));
}

export function mapErr<T, E, F>(result: Result<T, E>, mapper: (error: E) => F): Result<T, F> {
  if (result.ok) {
    return result;
  }

  return err(mapper(result.error));
}

export function andThen<T, E, U>(result: Result<T, E>, mapper: (value: T) => Result<U, E>): Result<U, E> {
  if (!result.ok) {
    return result;
  }

  return mapper(result.value);
}

export async function andThenAsync<T, E, U>(result: Result<T, E>, mapper: (value: T) => Promise<Result<U, E>>): Promise<Result<U, E>> {
  if (!result.ok) {
    return result;
  }

  return mapper(result.value);
}
