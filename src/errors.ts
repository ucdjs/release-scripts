import { Data } from "effect";

export class GitError extends Data.TaggedError("GitError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {}

export class GitNotRepositoryError extends Data.TaggedError("GitNotRepositoryError")<{
  readonly path: string;
}> {}

export class BranchNotFoundError extends Data.TaggedError("BranchNotFoundError")<{
  readonly branchName: string;
}> {}

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  message: string;
  operation?: string;
  cause?: unknown;
}> { }
