const TITLEBAR = 42;
const RADIUS = 0;
// Fit half/quarter Snap zones, including smaller displays and scaled desktops.
const MIN_WIDTH = 500;
const MIN_HEIGHT = 360;

function siteBounds(width, height) {
  // Windows owns resizing outside the client area; no inner gutter is needed.
  return { x: 0, y: TITLEBAR, width: Math.max(1, width), height: Math.max(1, height - TITLEBAR) };
}

function makeWindowRectangular(window) {
  // Native resizable windows need their system hit-test region outside the
  // client area. Only fixed-size dialogs need an explicit rectangular region.
  if (process.platform !== 'win32' || window.isResizable()) return;
  let previousWidth, previousHeight;
  const sync = () => {
    if (window.isDestroyed()) return;
    const [width, height] = window.getSize();
    if (width === previousWidth && height === previousHeight) return;
    previousWidth = width; previousHeight = height;
    // Windows 10 can clip the top corners of a caption-style window even
    // when roundedCorners is false. An explicit region fills the whole frame.
    window.setShape([{ x: 0, y: 0, width, height }]);
  };
  window.on('resize', sync);
  sync();
}

module.exports = { RADIUS, MIN_WIDTH, MIN_HEIGHT, siteBounds, makeWindowRectangular };
