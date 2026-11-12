import { AISDKError } from '@ai-sdk/provider';

const name = 'AI_WiroTaskError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

/**
 * Why a Wiro task gave no result:
 *
 * - `failed`: the model ended with an error.
 * - `cancelled`: the task was cancelled.
 * - `timeout`: the task did not finish within the wait limit. It keeps
 *   running on Wiro.
 * - `no-output`: the task finished without the kind of file this call needs.
 * - `status`: the task status could not be read.
 * - `download`: the task finished, but its output could not be downloaded.
 */
export type WiroTaskErrorReason =
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'no-output'
  | 'status'
  | 'download';

/**
 * A Wiro task was created but gave no usable result. `taskId` names the task,
 * so it can be looked up in the Wiro dashboard or with the `Task/Detail` API.
 */
export class WiroTaskError extends AISDKError {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: the marker lets isInstance recognize the error across copies of the package.
  private readonly [symbol] = true;

  readonly reason: WiroTaskErrorReason;
  readonly taskId: string | undefined;
  readonly modelId: string;
  /** The task status Wiro reported last, such as `task_postprocess_end`. */
  readonly status: string | undefined;

  constructor({
    reason,
    taskId,
    modelId,
    status,
    message,
    cause,
  }: {
    reason: WiroTaskErrorReason;
    taskId: string | undefined;
    modelId: string;
    status?: string;
    message: string;
    cause?: unknown;
  }) {
    super({ name, message, cause });
    this.reason = reason;
    this.taskId = taskId;
    this.modelId = modelId;
    this.status = status;
  }

  static isInstance(error: unknown): error is WiroTaskError {
    return AISDKError.hasMarker(error, marker);
  }
}
