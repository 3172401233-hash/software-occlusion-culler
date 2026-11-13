// Hierarchical Z pyramid.
//
// Level 0 is the full-resolution depth buffer. Every higher texel stores the
// maximum depth (farthest nearest surface) of its 2x2 children. Missing
// children and uncovered pixels stay INVALID, so a query touching any empty
// region can never claim occlusion.

import { INVALID_DEPTH } from "./depth.js";

export function buildHiZ(depthBuffer, width, height) {
  const levels = [
    {
      width,
      height,
      data: Uint32Array.from(depthBuffer),
    },
  ];

  while (levels[levels.length - 1].width > 1 || levels[levels.length - 1].height > 1) {
    const parent = levels[levels.length - 1];
    const childWidth = Math.max(1, Math.ceil(parent.width / 2));
    const childHeight = Math.max(1, Math.ceil(parent.height / 2));
    const data = new Uint32Array(childWidth * childHeight);
    data.fill(INVALID_DEPTH);

    for (let cy = 0; cy < childHeight; cy++) {
      for (let cx = 0; cx < childWidth; cx++) {
        let value = INVALID_DEPTH;
        for (let oy = 0; oy < 2; oy++) {
          for (let ox = 0; ox < 2; ox++) {
            const px = cx * 2 + ox;
            const py = cy * 2 + oy;
            if (px >= parent.width || py >= parent.height) {
              continue;
            }
            const sample = parent.data[py * parent.width + px];
            if (sample === INVALID_DEPTH) {
              continue;
            }
            if (value === INVALID_DEPTH || sample > value) {
              value = sample;
            }
          }
        }
        data[cy * childWidth + cx] = value;
      }
    }
    levels.push({ width: childWidth, height: childHeight, data });
  }
  return levels;
}

// Conservative rectangular query at a single mip level.
// Returns:
//   hasInvalid  - a covered texel (or padding) contains no occluder sample;
//   maxDepth    - farthest stored depth across covered texels.
export function queryRect(levels, level, minX, minY, maxX, maxY) {
  const pyramidLevel = levels[level];
  const x0 = Math.max(0, minX);
  const y0 = Math.max(0, minY);
  const x1 = Math.min(pyramidLevel.width - 1, maxX);
  const y1 = Math.min(pyramidLevel.height - 1, maxY);

  let hasInvalid = false;
  let maxDepth = INVALID_DEPTH;

  if (x0 > x1 || y0 > y1) {
    return { hasInvalid: true, maxDepth: INVALID_DEPTH, offScreen: true };
  }
  if (x0 !== minX || y0 !== minY || x1 !== maxX || y1 !== maxY) {
    hasInvalid = true;
  }

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const sample = pyramidLevel.data[ty * pyramidLevel.width + tx];
      if (sample === INVALID_DEPTH) {
        hasInvalid = true;
      } else if (maxDepth === INVALID_DEPTH || sample > maxDepth) {
        maxDepth = sample;
      }
    }
  }
  return { hasInvalid, maxDepth, offScreen: false };
}

// Select the finest level whose texels are at least as wide as the query.
// Finer texels preserve information; coarser levels would only introduce
// INVALID padding around partial tiles.
export function chooseLevel(levels, rectWidth, rectHeight) {
  const span = Math.max(rectWidth, rectHeight);
  let level = 0;
  while (level + 1 < levels.length) {
    const scale = 2 ** (level + 1);
    if (span <= scale) {
      level += 1;
    } else {
      break;
    }
  }
  return level;
}
