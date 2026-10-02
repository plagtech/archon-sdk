import type { IntentStatus, IntentStatusInfo } from './types.js';

/** Base class for every error the SDK throws on purpose */
export class ArchonError extends Error {
  override name = 'ArchonError';
}

/** The solver answered with a non-2xx status (or could not be reached) */
export class SolverError extends ArchonError {
  override name = 'SolverError';
  constructor(
    message: string,
    /** HTTP status, or 0 if the request never got a response */
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
  }
}

/** A contract call reverted. `reason` is the decoded custom error name when the ABI knows it. */
export class ContractError extends ArchonError {
  override name = 'ContractError';
  constructor(
    message: string,
    /** e.g. "OnlyOperator", "CooldownNotElapsed"; undefined if the revert could not be decoded */
    readonly reason: string | undefined,
    readonly args: readonly unknown[],
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** An intent reached a terminal state other than settled */
export class IntentFailedError extends ArchonError {
  override name = 'IntentFailedError';
  constructor(
    readonly intentId: string,
    readonly status: Exclude<IntentStatus, 'settled'>,
    readonly info: IntentStatusInfo,
  ) {
    super(`Intent ${intentId} ${status}${info.reason ? `: ${info.reason}` : ''}`);
  }
}

export class TimeoutError extends ArchonError {
  override name = 'TimeoutError';
}
