"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

// Share observers across the message list and pickers, including nested scrollers.
const pools = new Map<string, {
  observer: IntersectionObserver;
  listeners: Map<Element, (visible: boolean) => void>;
}>();

export function useMediaIntersection<T extends HTMLElement>(rootMargin = "400px", once = true, targetRef?: RefObject<T | null>) {
  const ownRef = useRef<T>(null);
  const ref = targetRef ?? ownRef;
  const [intersecting, setIntersecting] = useState(false);
  const done = once && intersecting;

  useEffect(() => {
    const node = ref.current;
    if (!node || done) return;
    if (typeof IntersectionObserver === "undefined") {
      setIntersecting(true);
      return;
    }
    let pool = pools.get(rootMargin);
    if (!pool) {
      const listeners = new Map<Element, (visible: boolean) => void>();
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
        // scrollMargin also expands clipping inside chat/picker scroll containers.
        // Browsers without it still load when the item becomes visible.
      }, { rootMargin, scrollMargin: rootMargin } as IntersectionObserverInit);
      pool = { observer, listeners };
      pools.set(rootMargin, pool);
    }
    pool.listeners.set(node, setIntersecting);
    pool.observer.observe(node);
    return () => {
      pool.listeners.delete(node);
      pool.observer.unobserve(node);
      if (!pool.listeners.size) {
        pool.observer.disconnect();
        pools.delete(rootMargin);
      }
    };
  }, [rootMargin, done, ref]);

  return { ref, intersecting };
}
