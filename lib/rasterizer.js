// Screen-space nearest-depth triangle rasterizer.
//
// Determinism guarantees:
//   * edge functions and barycentric weights use float64 arithmetic;
//   * the top-left fill rule resolves every tie identically;
//   * every pixel index is clamped to the viewport, so triangles of any size
//     or position can never write outside the depth buffer.

import { INVALID_DEPTH, quantizeDepth } from "./depth.js";

function toScreen(vertex, width, height) {
  const invW = 1 / vertex[3];
  const ndcX = vertex[0] * invW;
  const ndcY = vertex[1] * invW;
  const ndcZ = vertex[2] * invW;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1 - (ndcY * 0.5 + 0.5)) * height,
    z: ndcZ,
  };
}

// Edge e0 is opposite v0 (edge v1 -> v2), matching the barycentric weights.
function edge(v1, v2, px, py) {
  return (px - v1.x) * (v2.y - v1.y) - (py - v1.y) * (v2.x - v1.x);
}

function isTopLeft(v1, v2) {
  const dx = v2.x - v1.x;
  const dy = v2.y - v1.y;
  return dy < 0 || (dy === 0 && dx > 0);
}

export function rasterizeTriangle(clipVertices, width, height, depthBuffer, stats) {
  const v0 = toScreen(clipVertices[0], width, height);
  const v1 = toScreen(clipVertices[1], width, height);
  const v2 = toScreen(clipVertices[2], width, height);

  const area = edge(v1, v2, v0.x, v0.y);
  if (area === 0 || !Number.isFinite(area)) {
    return; // Degenerate or non-finite triangle: no coverage.
  }

  const minX = Math.max(0, Math.floor(Math.min(v0.x, v1.x, v2.x)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(v0.x, v1.x, v2.x)) - 1);
  const minY = Math.max(0, Math.floor(Math.min(v0.y, v1.y, v2.y)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(v0.y, v1.y, v2.y)) - 1);
  if (minX > maxX || minY > maxY) {
    return;
  }

  const topLeft0 = isTopLeft(v1, v2);
  const topLeft1 = isTopLeft(v2, v0);
  const topLeft2 = isTopLeft(v0, v1);

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const w0 = edge(v1, v2, px + 0.5, py + 0.5);
      const w1 = edge(v2, v0, px + 0.5, py + 0.5);
      const w2 = edge(v0, v1, px + 0.5, py + 0.5);

      const c0 = w0 > 0 || (w0 === 0 && topLeft0);
      const c1 = w1 > 0 || (w1 === 0 && topLeft1);
      const c2 = w2 > 0 || (w2 === 0 && topLeft2);
      if (!(c0 && c1 && c2)) {
        continue;
      }

      const invArea = 1 / area;
      const b0 = w0 * invArea;
      const b1 = w1 * invArea;
      const b2 = w2 * invArea;
      const ndcZ = b0 * v0.z + b1 * v1.z + b2 * v2.z;
      const depth = quantizeDepth(ndcZ);
      if (depth === INVALID_DEPTH) {
        continue;
      }

      const index = py * width + px;
      const previous = depthBuffer[index];
      if (previous === INVALID_DEPTH) {
        depthBuffer[index] = depth;
        stats.depthWrites += 1;
      } else if (depth < previous) {
        depthBuffer[index] = depth;
        stats.depthWrites += 1;
      }
    }
  }
}

export function createDepthBuffer(width, height) {
  const buffer = new Uint32Array(width * height);
  buffer.fill(INVALID_DEPTH);
  return buffer;
}
