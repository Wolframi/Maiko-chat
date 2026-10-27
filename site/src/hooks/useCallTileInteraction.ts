"use client";

import { useEffect, useRef, type PointerEvent, type MouseEvent, type KeyboardEvent } from "react";

type Gesture = {
  pointerId: number;
  x: number;
  y: number;
  dragging: boolean;
  element: HTMLDivElement;
  scope: Element;
  target: HTMLElement | null;
};

/** A click opens the tile; movement past the threshold starts a swap gesture. */
export function useCallTileInteraction({
  id,
  onSwap,
  open = true,
}: {
  id: string;
  onSwap?: (fromId: string, toId: string) => void;
  open?: boolean;
}) {
  const gestureRef = useRef<Gesture | null>(null);
  const suppressClickRef = useRef(false);

  function clearGesture() {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    gesture.element.classList.remove("is-dragging");
    gesture.target?.classList.remove("is-drop-target");
    if (gesture.element.hasPointerCapture(gesture.pointerId)) {
      gesture.element.releasePointerCapture(gesture.pointerId);
    }
  }

  useEffect(() => clearGesture, []);

  function targetAt(event: PointerEvent<HTMLDivElement>, gesture: Gesture) {
    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-call-tile-id]") ?? null;
    return target && target !== gesture.element && gesture.scope.contains(target)
      ? target
      : null;
  }

  function openTile(element: HTMLDivElement) {
    if (!open) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void element.requestFullscreen?.().catch(() => undefined);
    }
  }

  return {
    "data-call-tile-id": onSwap ? id : undefined,
    "data-call-tile-draggable": onSwap ? true : undefined,
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (!onSwap || !event.isPrimary || event.button !== 0) return;
      if ((event.target as Element).closest("button, input, select, a, .call__screen-controls")) return;
      clearGesture();
      suppressClickRef.current = false;
      const element = event.currentTarget;
      const scope = element.closest(".call__stage-body") ?? element.closest(".call__screens") ?? element.parentElement;
      if (!scope) return;
      gestureRef.current = {
        pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        dragging: false, element, scope, target: null,
      };
      element.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (!gesture.dragging && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 8) return;
      event.preventDefault();
      gesture.dragging = true;
      suppressClickRef.current = true;
      gesture.element.classList.add("is-dragging");
      gesture.target?.classList.remove("is-drop-target");
      gesture.target = targetAt(event, gesture);
      gesture.target?.classList.add("is-drop-target");
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const target = gesture.dragging ? targetAt(event, gesture) : null;
      clearGesture();
      if (target?.dataset.callTileId) onSwap?.(id, target.dataset.callTileId);
    },
    onPointerCancel(event: PointerEvent<HTMLDivElement>) {
      if (gestureRef.current?.pointerId !== event.pointerId) return;
      suppressClickRef.current = true;
      clearGesture();
    },
    onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
      if (gestureRef.current?.pointerId !== event.pointerId) return;
      clearGesture();
    },
    onClick(event: MouseEvent<HTMLDivElement>) {
      if (suppressClickRef.current && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      openTile(event.currentTarget);
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.key === "Escape" && gestureRef.current) {
        event.preventDefault();
        suppressClickRef.current = true;
        clearGesture();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openTile(event.currentTarget);
      } else if (onSwap && event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        const scope = event.currentTarget.closest(".call__stage-body") ?? event.currentTarget.closest(".call__screens");
        const tiles = Array.from(scope?.querySelectorAll<HTMLElement>("[data-call-tile-id]") ?? []);
        const index = tiles.indexOf(event.currentTarget);
        const target = tiles[index + (event.key === "ArrowLeft" ? -1 : 1)];
        if (target?.dataset.callTileId) {
          event.preventDefault();
          onSwap(id, target.dataset.callTileId);
        }
      }
    },
  };
}
