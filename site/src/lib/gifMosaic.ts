/** Telegram-style justified GIF mosaic — equal-height rows, width from aspect. */

export type GifMosaicSize = {
  width: number;
  height: number;
};

export type GifMosaicTile = {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GifMosaicLayout = {
  tiles: GifMosaicTile[];
  height: number;
};

/** `st::emojiPanPad` / inline GIF skip in tdesktop — 2px air between tiles. */
export const GIF_MOSAIC_SPACING = 2;
/** Target row height for a ~420px picker (Telegram Web / tdesktop GIF panel). */
export const GIF_MOSAIC_TARGET_HEIGHT = 104;
export const GIF_MOSAIC_MAX_HEIGHT = 168;
export const GIF_MOSAIC_MIN_ITEM_WIDTH = 58;

function aspectOf(size: GifMosaicSize) {
  const width = Math.max(1, size.width || 1);
  const height = Math.max(1, size.height || 1);
  return Math.min(3.6, Math.max(0.28, width / height));
}

export function layoutGifMosaic(
  sizes: GifMosaicSize[],
  containerWidth: number,
  spacing = GIF_MOSAIC_SPACING,
  targetRowHeight = GIF_MOSAIC_TARGET_HEIGHT,
  maxHeight = GIF_MOSAIC_MAX_HEIGHT,
  minItemWidth = GIF_MOSAIC_MIN_ITEM_WIDTH,
): GifMosaicLayout {
  const width = Math.max(0, Math.floor(containerWidth));
  if (!sizes.length || width < 1) {
    return { tiles: [], height: 0 };
  }

  const aspects = sizes.map(aspectOf);
  const rows: number[][] = [];
  let row: number[] = [];
  let rowAspect = 0;

  const heightIf = (count: number, sum: number) => {
    const gaps = Math.max(0, count - 1) * spacing;
    return (width - gaps) / Math.max(sum, 0.01);
  };

  for (let i = 0; i < aspects.length; i += 1) {
    const nextCount = row.length + 1;
    const nextSum = rowAspect + aspects[i];
    const nextHeight = heightIf(nextCount, nextSum);
    const nextMinWidth = (width - (nextCount - 1) * spacing) / nextCount;
    const overflow =
      row.length > 0 &&
      (nextHeight < targetRowHeight || nextMinWidth < minItemWidth);

    if (overflow) {
      rows.push(row);
      row = [];
      rowAspect = 0;
    }
    row.push(i);
    rowAspect += aspects[i];
  }
  if (row.length) rows.push(row);

  const tiles: GifMosaicTile[] = new Array(sizes.length);
  let y = 0;

  for (let r = 0; r < rows.length; r += 1) {
    const indices = rows[r];
    const lastRow = r === rows.length - 1;
    const gaps = Math.max(0, indices.length - 1) * spacing;
    const sum = indices.reduce((acc, i) => acc + aspects[i], 0);
    const fillHeight = heightIf(indices.length, sum);
    let rowHeight = fillHeight;
    let widow = false;
    if (lastRow && fillHeight > targetRowHeight) {
      const unstretchedWidth = targetRowHeight * sum + gaps;
      // Widow row stays at target height; an almost-full last row still fills.
      if (unstretchedWidth / width < 0.72) {
        rowHeight = targetRowHeight;
        widow = true;
      }
    }
    rowHeight = Math.min(maxHeight, Math.max(1, Math.round(rowHeight)));
    const stretch = !widow;
    let x = 0;

    for (let c = 0; c < indices.length; c += 1) {
      const i = indices[c];
      const lastCol = c === indices.length - 1;
      let tileW = Math.round(aspects[i] * rowHeight);
      if (stretch && lastCol) {
        tileW = Math.max(1, width - x);
      }
      tiles[i] = {
        index: i,
        x,
        y,
        width: Math.max(1, tileW),
        height: rowHeight,
      };
      x += tileW + spacing;
    }

    y += rowHeight + spacing;
  }

  return { tiles, height: Math.max(0, y - spacing) };
}
