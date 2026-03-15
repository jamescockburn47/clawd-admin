// Circuit breaker — protects against cascading API failures
// States: closed (normal) → open (failing, fast-reject) → half-open (testing) → closed
import logger from './logger.js';

export class CircuitBreaker {
  constructor(name, opts = {}) {
    this.name = name;
    this.threshold = opts.threshold || 3;        // failures before opening
    this.resetTimeout = opts.resetTimeout || 60000; // ms before trying again
    this.state = 'closed';
    this.failures = 0;
    this.lastFailure = 0;
    this.lastSuccess = 0;
  }

  /** Wrap an async function with circuit breaker logic.
   *  Returns the function's result, or fallback value if circuit is open. */
  async call(fn, fallback) {
    if (this.state === 'open') {
      // Check if enough time has passed to try again
      if (Date.now() - this.lastFailure >= this.resetTimeout) {
        this.state = 'half-open';
        logger.info({ breaker: this.name }, 'circuit half-open, testing');
      } else {
        logger.debug({ breaker: this.name }, 'circuit open, returning fallback');
        return typeof fallback === 'function' ? fallback() : fallback;
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      return typeof fallback === 'function' ? fallback() : fallback;
    }
  }

  _onSuccess() {
    if (this.state === 'half-open') {
      logger.info({ breaker: this.name }, 'circuit closed (recovered)');
    }
    this.failures = 0;
    this.state = 'closed';
    this.lastSuccess = Date.now();
  }

  _onFailure(err) {
    this.failures++;
    this.lastFailure = Date.now();
    logger.warn({ breaker: this.name, failures: this.failures, err: err.message }, 'circuit breaker failure');

    if (this.failures >= this.threshold) {
      this.state = 'open';
      logger.error({ breaker: this.name, threshold: this.threshold }, 'circuit OPEN — blocking calls');
    }
  }

  /** Get current state for health reporting */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure || null,
      lastSuccess: this.lastSuccess || null,
    };
  }

  /** Force reset (e.g. after config change) */
  reset() {
    this.state = 'closed';
    this.failures = 0;
    logger.info({ breaker: this.name }, 'circuit manually reset');
  }
}
