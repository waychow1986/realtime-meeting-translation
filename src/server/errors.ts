export type UpstreamName = 'speech-sts' | 'chat-model';

/** Upstream failure carrying only metadata (never upstream messages, which may echo input). */
export class UpstreamError extends Error {
  constructor(
    readonly upstream: UpstreamName,
    readonly upstreamStatus?: number,
  ) {
    super(`${upstream} request failed`);
    this.name = 'UpstreamError';
  }
}
