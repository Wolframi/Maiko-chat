export type ExternalStore<T> = {
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
  publish: (snapshot: T) => void;
};

export function shallowEqual(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.prototype.hasOwnProperty.call(right, key) &&
    Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Immutable snapshots, stable subscriptions and a fixed hydration snapshot. */
export function createExternalStore<T>(initial: T, equal: (a: T, b: T) => boolean = Object.is): ExternalStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(next) {
      if (equal(snapshot, next)) return;
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
