"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ExternalStore } from "@/lib/externalStore";

/** Cache selected snapshots even when an inline selector changes between renders. */
export function useStoreSelector<T, S>(store: ExternalStore<T>, selector: (snapshot: T) => S, equal: (a: S, b: S) => boolean = Object.is): S {
  const committed = useRef<{ value: S } | null>(null);
  const getters = useMemo(() => {
    const select = (read: () => T) => {
      let cached: { source: T; value: S } | undefined;
      return () => {
        const source = read();
        if (cached && Object.is(cached.source, source)) return cached.value;
        const next = selector(source);
        const previous = cached ?? committed.current;
        const value = previous && equal(previous.value, next) ? previous.value : next;
        cached = { source, value };
        return value;
      };
    };
    return { client: select(store.getSnapshot), server: select(store.getServerSnapshot) };
  }, [store, selector, equal]);
  const value = useSyncExternalStore(store.subscribe, getters.client, getters.server);
  useEffect(() => { committed.current = { value }; }, [value]);
  return value;
}
