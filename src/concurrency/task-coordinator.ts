interface WaitingTask {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(): Error {
  return new DOMException("Operation aborted", "AbortError");
}

class Semaphore {
  #available: number;
  readonly #waiting: WaitingTask[] = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Concurrency limit must be a positive integer");
    }
    this.#available = limit;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#releaseFunction());
    }

    return new Promise((resolve, reject) => {
      const waiting: WaitingTask = { resolve, reject };
      if (signal) {
        waiting.signal = signal;
        waiting.onAbort = () => {
          const index = this.#waiting.indexOf(waiting);
          if (index >= 0) {
            this.#waiting.splice(index, 1);
          }
          reject(abortError());
        };
        signal.addEventListener("abort", waiting.onAbort, { once: true });
      }
      this.#waiting.push(waiting);
    });
  }

  #releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#release();
    };
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (!next) {
      this.#available += 1;
      return;
    }
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    next.resolve(this.#releaseFunction());
  }
}

export class TaskCoordinator {
  readonly #semaphore: Semaphore;
  readonly #userTails = new Map<string, Promise<void>>();
  readonly #activeControllers = new Map<string, AbortController>();

  constructor(globalLimit = 2) {
    this.#semaphore = new Semaphore(globalLimit);
  }

  enqueue(
    userId: string,
    task: (signal: AbortSignal) => Promise<void>,
    serviceSignal: AbortSignal,
  ): Promise<void> {
    const previous = this.#userTails.get(userId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const release = await this.#semaphore.acquire(serviceSignal);
        const controller = new AbortController();
        const abort = () => controller.abort();
        serviceSignal.addEventListener("abort", abort, { once: true });
        this.#activeControllers.set(userId, controller);

        try {
          if (serviceSignal.aborted) {
            controller.abort();
          }
          await task(controller.signal);
        } finally {
          serviceSignal.removeEventListener("abort", abort);
          if (this.#activeControllers.get(userId) === controller) {
            this.#activeControllers.delete(userId);
          }
          release();
        }
      });

    this.#userTails.set(userId, current);
    const cleanup = (): void => {
      if (this.#userTails.get(userId) === current) {
        this.#userTails.delete(userId);
      }
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  cancel(userId: string): boolean {
    const controller = this.#activeControllers.get(userId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#userTails.values()]);
  }
}
