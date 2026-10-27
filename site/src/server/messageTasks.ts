/** Serialize read/modify/write operations per room while unrelated rooms proceed. */
export class MessageTasks {
  private rooms = new Map<string, Promise<void>>();
  private barrier: Promise<void> = Promise.resolve();

  run<T>(keys: readonly string[], action: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)];
    const pending = [this.barrier, ...unique.map(key => this.rooms.get(key) ?? Promise.resolve())];
    const task = Promise.all(pending).then(action);
    const settled = task.then(() => {}, () => {});
    for (const key of unique) this.rooms.set(key, settled);
    void settled.then(() => {
      for (const key of unique) if (this.rooms.get(key) === settled) this.rooms.delete(key);
    });
    return task;
  }

  /** Membership changes and cross-room invite expiry must see a consistent view. */
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const task = Promise.all([this.barrier, ...this.rooms.values()]).then(action);
    this.barrier = task.then(() => {}, () => {});
    return task;
  }

  async idle() {
    while (true) {
      const barrier = this.barrier;
      await Promise.all([barrier, ...this.rooms.values()]);
      if (barrier === this.barrier && this.rooms.size === 0) return;
    }
  }
}
