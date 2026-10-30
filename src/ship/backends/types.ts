import { LogRecord } from '../record';

export interface Backend {
  readonly name: string;
  readonly kind: string;
  /** Resolves on acceptance. Throws DeliveryError to signal whether a retry helps. */
  send(records: LogRecord[]): Promise<void>;
}

export class DeliveryError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'DeliveryError';
  }
}
