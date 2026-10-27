"use client";

import { useState } from "react";

/** Keep each live tile in one slot, including after a camera/share disappears. */
export function useCallTileLayout<T extends { id: string }>(tiles: T[]) {
  const [placements, setPlacements] = useState<Record<string, string>>({});
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const used = new Set<string>();
  const positions = new Map<string, string>();
  for (const tile of tiles) {
    const assigned = placements[tile.id];
    if (assigned && byId.has(assigned) && !used.has(assigned)) {
      positions.set(tile.id, assigned);
      used.add(assigned);
    }
  }
  for (const tile of tiles) {
    if (positions.has(tile.id)) continue;
    const available = !used.has(tile.id)
      ? tile.id
      : tiles.find((candidate) => !used.has(candidate.id))!.id;
    positions.set(tile.id, available);
    used.add(available);
  }

  const ordered = tiles.map((tile) => byId.get(positions.get(tile.id)!)!);
  const swap = (fromId: string, toId: string) => {
    if (fromId === toId || !byId.has(fromId) || !byId.has(toId)) return;
    const next = Object.fromEntries(positions);
    for (const [slot, id] of positions) {
      if (id === fromId) next[slot] = toId;
      else if (id === toId) next[slot] = fromId;
    }
    setPlacements(next);
  };

  return { ordered, swap };
}
