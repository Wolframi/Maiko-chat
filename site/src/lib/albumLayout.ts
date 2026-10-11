/** Telegram Desktop `Ui::LayoutMediaGroup` — mosaic for photo/video albums. */

export type MediaSize = {
  width: number;
  height: number;
};

export type AlbumCell = {
  x: number;
  y: number;
  width: number;
  height: number;
  sides: number;
};

export const SIDE_LEFT = 1;
export const SIDE_TOP = 2;
export const SIDE_RIGHT = 4;
export const SIDE_BOTTOM = 8;

/** Matches `st::msgMaxWidth` used for our media bubbles. */
export const ALBUM_MAX_WIDTH = 430;
/** `st::historyGroupWidthMin` in tdesktop. */
export const ALBUM_MIN_WIDTH = 100;
/** Air between rounded tiles — same as tdesktop skip, plus cell radius. */
export const ALBUM_SPACING = 3;

function round(value: number) {
  return Math.round(value);
}

function idiv(a: number, b: number) {
  return Math.trunc(a / b);
}

function ratiosOf(sizes: MediaSize[]) {
  return sizes.map((size) => {
    const width = Math.max(1, size.width);
    const height = Math.max(1, size.height);
    return width / height;
  });
}

function proportionsOf(ratios: number[]) {
  return ratios
    .map((ratio) => (ratio > 1.2 ? "w" : ratio < 0.8 ? "n" : "q"))
    .join("");
}

/** tdesktop: `accumulate(ratios, 1.) / count` */
function averageRatioOf(ratios: number[]) {
  return ratios.reduce((sum, ratio) => sum + ratio, 1) / ratios.length;
}

function cropRatios(ratios: number[], averageRatio: number) {
  const maxRatio = 2.75;
  const minRatio = 0.6667;
  return ratios.map((ratio) =>
    averageRatio > 1.1
      ? Math.min(maxRatio, Math.max(1, ratio))
      : Math.min(1, Math.max(minRatio, ratio)),
  );
}

function cell(
  x: number,
  y: number,
  width: number,
  height: number,
  sides: number,
): AlbumCell {
  return { x, y, width, height, sides };
}

export function albumBounds(cells: AlbumCell[]) {
  let width = 0;
  let height = 0;
  for (const item of cells) {
    width = Math.max(width, item.x + item.width);
    height = Math.max(height, item.y + item.height);
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

export function layoutMediaGroup(
  sizes: MediaSize[],
  maxWidth = ALBUM_MAX_WIDTH,
  minWidth = ALBUM_MIN_WIDTH,
  spacing = ALBUM_SPACING,
): AlbumCell[] {
  const count = sizes.length;
  if (!count) return [];

  const ratios = ratiosOf(sizes);
  const proportions = proportionsOf(ratios);
  const averageRatio = averageRatioOf(ratios);
  const maxHeight = maxWidth;
  const maxSizeRatio = maxWidth / maxHeight;

  if (count === 1) {
    const width = maxWidth;
    const height = Math.max(1, idiv(sizes[0].height * width, sizes[0].width));
    return [
      cell(
        0,
        0,
        width,
        height,
        SIDE_LEFT | SIDE_TOP | SIDE_RIGHT | SIDE_BOTTOM,
      ),
    ];
  }

  if (count >= 5 || ratios.some((ratio) => ratio > 2)) {
    return layoutComplex(ratios, averageRatio, maxWidth, minWidth, spacing);
  }

  if (count === 2) {
    return layoutTwo(
      ratios,
      proportions,
      averageRatio,
      maxSizeRatio,
      maxWidth,
      maxHeight,
      minWidth,
      spacing,
    );
  }
  if (count === 3) {
    return layoutThree(ratios, proportions, maxWidth, maxHeight, minWidth, spacing);
  }
  return layoutFour(ratios, proportions, maxWidth, maxHeight, minWidth, spacing);
}

function layoutTwo(
  ratios: number[],
  proportions: string,
  averageRatio: number,
  maxSizeRatio: number,
  maxWidth: number,
  maxHeight: number,
  minWidth: number,
  spacing: number,
) {
  if (
    proportions === "ww" &&
    averageRatio > 1.4 * maxSizeRatio &&
    ratios[1] - ratios[0] < 0.2
  ) {
    const width = maxWidth;
    const height = round(
      Math.min(width / ratios[0], Math.min(width / ratios[1], (maxHeight - spacing) / 2)),
    );
    return [
      cell(0, 0, width, height, SIDE_LEFT | SIDE_TOP | SIDE_RIGHT),
      cell(0, height + spacing, width, height, SIDE_LEFT | SIDE_BOTTOM | SIDE_RIGHT),
    ];
  }

  if (proportions === "ww" || proportions === "qq") {
    const width = idiv(maxWidth - spacing, 2);
    const height = round(
      Math.min(width / ratios[0], Math.min(width / ratios[1], maxHeight)),
    );
    return [
      cell(0, 0, width, height, SIDE_TOP | SIDE_LEFT | SIDE_BOTTOM),
      cell(width + spacing, 0, width, height, SIDE_TOP | SIDE_RIGHT | SIDE_BOTTOM),
    ];
  }

  const minimalWidth = round(minWidth * 1.5);
  const secondWidth = Math.min(
    round(
      Math.max(
        0.4 * (maxWidth - spacing),
        (maxWidth - spacing) / ratios[0] / (1 / ratios[0] + 1 / ratios[1]),
      ),
    ),
    maxWidth - spacing - minimalWidth,
  );
  const firstWidth = maxWidth - secondWidth - spacing;
  const height = Math.min(
    maxHeight,
    round(Math.min(firstWidth / ratios[0], secondWidth / ratios[1])),
  );
  return [
    cell(0, 0, firstWidth, height, SIDE_TOP | SIDE_LEFT | SIDE_BOTTOM),
    cell(firstWidth + spacing, 0, secondWidth, height, SIDE_TOP | SIDE_RIGHT | SIDE_BOTTOM),
  ];
}

function layoutThree(
  ratios: number[],
  proportions: string,
  maxWidth: number,
  maxHeight: number,
  minWidth: number,
  spacing: number,
) {
  if (proportions[0] === "n") {
    const firstHeight = maxHeight;
    const thirdHeight = round(
      Math.min(
        (maxHeight - spacing) / 2,
        (ratios[1] * (maxWidth - spacing)) / (ratios[2] + ratios[1]),
      ),
    );
    const secondHeight = firstHeight - thirdHeight - spacing;
    const rightWidth = Math.max(
      minWidth,
      round(
        Math.min(
          (maxWidth - spacing) / 2,
          Math.min(thirdHeight * ratios[2], secondHeight * ratios[1]),
        ),
      ),
    );
    const leftWidth = Math.min(
      round(firstHeight * ratios[0]),
      maxWidth - spacing - rightWidth,
    );
    return [
      cell(0, 0, leftWidth, firstHeight, SIDE_TOP | SIDE_LEFT | SIDE_BOTTOM),
      cell(leftWidth + spacing, 0, rightWidth, secondHeight, SIDE_TOP | SIDE_RIGHT),
      cell(
        leftWidth + spacing,
        secondHeight + spacing,
        rightWidth,
        thirdHeight,
        SIDE_BOTTOM | SIDE_RIGHT,
      ),
    ];
  }

  const firstWidth = maxWidth;
  const firstHeight = round(
    Math.min(firstWidth / ratios[0], (maxHeight - spacing) * 0.66),
  );
  const secondWidth = idiv(maxWidth - spacing, 2);
  const secondHeight = Math.min(
    maxHeight - firstHeight - spacing,
    round(Math.min(secondWidth / ratios[1], secondWidth / ratios[2])),
  );
  const thirdWidth = firstWidth - secondWidth - spacing;
  return [
    cell(0, 0, firstWidth, firstHeight, SIDE_LEFT | SIDE_TOP | SIDE_RIGHT),
    cell(0, firstHeight + spacing, secondWidth, secondHeight, SIDE_BOTTOM | SIDE_LEFT),
    cell(
      secondWidth + spacing,
      firstHeight + spacing,
      thirdWidth,
      secondHeight,
      SIDE_BOTTOM | SIDE_RIGHT,
    ),
  ];
}

function layoutFour(
  ratios: number[],
  proportions: string,
  maxWidth: number,
  maxHeight: number,
  minWidth: number,
  spacing: number,
) {
  if (proportions[0] === "w") {
    const w = maxWidth;
    const h0 = round(Math.min(w / ratios[0], (maxHeight - spacing) * 0.66));
    const h = round((maxWidth - 2 * spacing) / (ratios[1] + ratios[2] + ratios[3]));
    const w0 = Math.max(
      minWidth,
      round(Math.min((maxWidth - 2 * spacing) * 0.4, h * ratios[1])),
    );
    const w2 = round(
      Math.max(Math.max(minWidth, (maxWidth - 2 * spacing) * 0.33), h * ratios[3]),
    );
    const w1 = w - w0 - w2 - 2 * spacing;
    const h1 = Math.min(maxHeight - h0 - spacing, h);
    return [
      cell(0, 0, w, h0, SIDE_LEFT | SIDE_TOP | SIDE_RIGHT),
      cell(0, h0 + spacing, w0, h1, SIDE_BOTTOM | SIDE_LEFT),
      cell(w0 + spacing, h0 + spacing, w1, h1, SIDE_BOTTOM),
      cell(w0 + spacing + w1 + spacing, h0 + spacing, w2, h1, SIDE_RIGHT | SIDE_BOTTOM),
    ];
  }

  const h = maxHeight;
  const w0 = round(Math.min(h * ratios[0], (maxWidth - spacing) * 0.6));
  const w = round(
    (maxHeight - 2 * spacing) /
      (1 / ratios[1] + 1 / ratios[2] + 1 / ratios[3]),
  );
  const h0 = round(w / ratios[1]);
  const h1 = round(w / ratios[2]);
  const h2 = h - h0 - h1 - 2 * spacing;
  const w1 = Math.max(minWidth, Math.min(maxWidth - w0 - spacing, w));
  return [
    cell(0, 0, w0, h, SIDE_TOP | SIDE_LEFT | SIDE_BOTTOM),
    cell(w0 + spacing, 0, w1, h0, SIDE_TOP | SIDE_RIGHT),
    cell(w0 + spacing, h0 + spacing, w1, h1, SIDE_RIGHT),
    cell(w0 + spacing, h0 + h1 + 2 * spacing, w1, h2, SIDE_BOTTOM | SIDE_RIGHT),
  ];
}

function layoutComplex(
  rawRatios: number[],
  averageRatio: number,
  maxWidth: number,
  minWidth: number,
  spacing: number,
) {
  const ratios = cropRatios(rawRatios, averageRatio);
  const count = ratios.length;
  const maxHeight = idiv(maxWidth * 4, 3);

  type Attempt = { lineCounts: number[]; heights: number[] };
  const attempts: Attempt[] = [];

  const multiHeight = (offset: number, countOnLine: number) => {
    let sum = 0;
    for (let i = 0; i < countOnLine; i += 1) sum += ratios[offset + i];
    return (maxWidth - (countOnLine - 1) * spacing) / sum;
  };

  const pushAttempt = (lineCounts: number[]) => {
    const heights: number[] = [];
    let offset = 0;
    for (const lineCount of lineCounts) {
      heights.push(multiHeight(offset, lineCount));
      offset += lineCount;
    }
    attempts.push({ lineCounts, heights });
  };

  for (let first = 1; first !== count; first += 1) {
    const second = count - first;
    if (first > 3 || second > 3) continue;
    pushAttempt([first, second]);
  }
  for (let first = 1; first !== count - 1; first += 1) {
    for (let second = 1; second !== count - first; second += 1) {
      const third = count - first - second;
      if (first > 3 || second > (averageRatio < 0.85 ? 4 : 3) || third > 3) {
        continue;
      }
      pushAttempt([first, second, third]);
    }
  }
  for (let first = 1; first !== count - 1; first += 1) {
    for (let second = 1; second !== count - first; second += 1) {
      for (let third = 1; third !== count - first - second; third += 1) {
        const fourth = count - first - second - third;
        if (first > 3 || second > 3 || third > 3 || fourth > 3) continue;
        pushAttempt([first, second, third, fourth]);
      }
    }
  }

  let optimal = attempts[0];
  let optimalDiff = Number.POSITIVE_INFINITY;
  for (const attempt of attempts) {
    const { heights, lineCounts } = attempt;
    const lineCount = lineCounts.length;
    const totalHeight =
      heights.reduce((sum, value) => sum + value, 0) + spacing * (lineCount - 1);
    const minLineHeight = Math.min(...heights);
    const bad1 = minLineHeight < minWidth ? 1.5 : 1;
    let bad2 = 1;
    for (let line = 1; line !== lineCount; line += 1) {
      if (lineCounts[line - 1] > lineCounts[line]) {
        bad2 = 1.5;
        break;
      }
    }
    const diff = Math.abs(totalHeight - maxHeight) * bad1 * bad2;
    if (diff < optimalDiff) {
      optimal = attempt;
      optimalDiff = diff;
    }
  }

  const result: AlbumCell[] = new Array(count);
  const { lineCounts, heights } = optimal;
  const rowCount = lineCounts.length;
  let index = 0;
  let y = 0;
  for (let row = 0; row !== rowCount; row += 1) {
    const colCount = lineCounts[row];
    const lineHeight = heights[row];
    const height = round(lineHeight);
    let x = 0;
    for (let col = 0; col !== colCount; col += 1) {
      let sides = 0;
      if (row === 0) sides |= SIDE_TOP;
      if (row === rowCount - 1) sides |= SIDE_BOTTOM;
      if (col === 0) sides |= SIDE_LEFT;
      if (col === colCount - 1) sides |= SIDE_RIGHT;
      const ratio = ratios[index];
      const width = col === colCount - 1 ? maxWidth - x : round(ratio * lineHeight);
      result[index] = cell(x, round(y), width, height, sides);
      x += width + spacing;
      index += 1;
    }
    y += height + spacing;
  }
  return result;
}
