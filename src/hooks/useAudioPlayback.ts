"use client";

import { useRef, useSyncExternalStore } from "react";
import {
  getAudioPlaybackServerState,
  getAudioPlaybackState,
  subscribeAudioPlayback,
  type AudioPlaybackState,
} from "@/lib/audioPlayback";

export function useAudioPlayback() {
  return useSyncExternalStore(
    subscribeAudioPlayback,
    getAudioPlaybackState,
    getAudioPlaybackServerState,
  );
}

export function useAudioPlaybackSelector<T>(
  selector: (state: AudioPlaybackState) => T,
) {
  const cache = useRef<T>(selector(getAudioPlaybackState()));
  return useSyncExternalStore(
    subscribeAudioPlayback,
    () => {
      const next = selector(getAudioPlaybackState());
      if (Object.is(next, cache.current)) return cache.current;
      cache.current = next;
      return next;
    },
    () => selector(getAudioPlaybackServerState()),
  );
}
