import process from "node:process";
import farver from "farver";
import mri from "mri";

const args = mri(process.argv.slice(2));
const isVerbose = !!args.verbose;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (value instanceof Uint8Array) {
    const normalized = new TextDecoder().decode(value).trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (isRecord(value) && typeof value.toString === "function") {
    const rendered = value.toString();
    if (typeof rendered === "string" && rendered !== "[object Object]") {
      const normalized = rendered.trim();
      return normalized.length > 0 ? normalized : undefined;
    }
  }

  return undefined;
}

function getNestedField(record: UnknownRecord, keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

function extractStderrLike(record: UnknownRecord): string | undefined {
  const candidates: unknown[] = [
    record.stderr,
    record.stdout,
    record.shortMessage,
    record.originalMessage,
    getNestedField(record, ["result", "stderr"]),
    getNestedField(record, ["result", "stdout"]),
    getNestedField(record, ["output", "stderr"]),
    getNestedField(record, ["output", "stdout"]),
    getNestedField(record, ["cause", "stderr"]),
    getNestedField(record, ["cause", "stdout"]),
    getNestedField(record, ["cause", "shortMessage"]),
    getNestedField(record, ["cause", "originalMessage"]),
  ];

  for (const candidate of candidates) {
    const rendered = toTrimmedString(candidate);
    if (rendered) {
      return rendered;
    }
  }

  return undefined;
}

export interface FormattedUnknownError {
  message: string;
  stderr?: string;
  code?: string;
  status?: number;
  stack?: string;
}

export function formatUnknownError(error: unknown): FormattedUnknownError {
  if (error instanceof Error) {
    const base: FormattedUnknownError = {
      message: error.message || error.name,
      stack: error.stack,
    };

    const maybeError = error as Error & UnknownRecord;

    if (typeof maybeError.code === "string") {
      base.code = maybeError.code;
    }

    if (typeof maybeError.status === "number") {
      base.status = maybeError.status;
    }

    base.stderr = extractStderrLike(maybeError);

    if (
      typeof maybeError.shortMessage === "string"
      && maybeError.shortMessage.trim()
      && base.message.startsWith("Process exited with non-zero status")
    ) {
      base.message = maybeError.shortMessage.trim();
    }

    if (!base.stderr && typeof maybeError.cause === "string" && maybeError.cause.trim()) {
      base.stderr = maybeError.cause.trim();
    }

    return base;
  }

  if (typeof error === "string") {
    return {
      message: error,
    };
  }

  if (isRecord(error)) {
    const message = typeof error.message === "string"
      ? error.message
      : typeof error.error === "string"
        ? error.error
        : JSON.stringify(error);

    const formatted: FormattedUnknownError = {
      message,
    };

    if (typeof error.code === "string") {
      formatted.code = error.code;
    }

    if (typeof error.status === "number") {
      formatted.status = error.status;
    }

    formatted.stderr = extractStderrLike(error);

    return formatted;
  }

  return {
    message: String(error),
  };
}

export function exitWithError(message: string, hint?: string, cause?: unknown): never {
  console.error(`  ${farver.red("✖")} ${farver.bold(message)}`);

  if (cause !== undefined) {
    const formatted = formatUnknownError(cause);
    if (formatted.message && formatted.message !== message) {
      console.error(farver.gray(`  Cause: ${formatted.message}`));
    }

    if (formatted.code) {
      console.error(farver.gray(`  Code: ${formatted.code}`));
    }

    if (typeof formatted.status === "number") {
      console.error(farver.gray(`  Status: ${formatted.status}`));
    }

    if (formatted.stderr) {
      console.error(farver.gray("  Stderr:"));
      console.error(farver.gray(`  ${formatted.stderr}`));
    }

    if (isVerbose && formatted.stack) {
      console.error(farver.gray("  Stack:"));
      console.error(farver.gray(`  ${formatted.stack}`));
    }
  }

  if (hint) {
    console.error(farver.gray(`  ${hint}`));
  }

  process.exit(1);
}
