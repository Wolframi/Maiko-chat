const EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const INSET = 6;
const TITLEBAR = 42;
const RADIUS = 16;

function resizedBounds(bounds, edge, dx, dy, minWidth = 800, minHeight = 600) {
  if (!EDGES.has(edge) || !Number.isFinite(dx) || !Number.isFinite(dy)) return bounds;
  const next = { ...bounds };
  if (edge.includes('e')) next.width = Math.max(minWidth, bounds.width + Math.round(dx));
  if (edge.includes('s')) next.height = Math.max(minHeight, bounds.height + Math.round(dy));
  if (edge.includes('w')) {
    next.width = Math.max(minWidth, bounds.width - Math.round(dx));
    next.x = bounds.x + bounds.width - next.width;
  }
  if (edge.includes('n')) {
    next.height = Math.max(minHeight, bounds.height - Math.round(dy));
    next.y = bounds.y + bounds.height - next.height;
  }
  return next;
}

function siteBounds(width, height, expanded) {
  const inset = expanded ? 0 : INSET;
  return { x: inset, y: TITLEBAR, width: Math.max(1, width - inset * 2), height: Math.max(1, height - TITLEBAR - inset) };
}

module.exports = { EDGES, RADIUS, resizedBounds, siteBounds };
