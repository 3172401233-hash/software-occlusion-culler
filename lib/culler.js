import { lookAt, multiply, perspective, transformPoint } from "./mat4.js";
import { clipTriangle } from "./clip.js";
import { INVALID_DEPTH, MAX_STORED_DEPTH } from "./depth.js";
import { boxCorners, boxOutsideFrustum, extractPlanes } from "./frustum.js";
import { buildHiZ, chooseLevel, queryRect } from "./hiz.js";
import { createDepthBuffer, rasterizeTriangle } from "./rasterizer.js";

export const OcclusionStatus = Object.freeze({
  VISIBLE: "visible",
  OCCLUDED: "occluded",
  UNCERTAIN: "uncertain",
});

export class OcclusionCuller {
  constructor(options = {}) {
    const width = options.depthWidth;
    const height = options.depthHeight;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError("depthWidth and depthHeight must be positive integers");
    }
    this.width = width;
    this.height = height;
    this.depthBuffer = createDepthBuffer(width, height);
    this.levels = buildHiZ(this.depthBuffer, width, height);
    this.stats = {
      candidatesTested: 0,
      occluderTrianglesSubmitted: 0,
      occluderTrianglesRasterized: 0,
      depthWrites: 0,
      occupiedPixels: 0,
      occluded: 0,
      visible: 0,
      uncertain: 0,
      frustumRejected: 0,
    };
  }

  // Rasterize all occluder triangles seen through the given perspective
  // camera and rebuild the hierarchical Z pyramid.
  renderOccluders(camera, triangles) {
    const view = camera.viewMatrix ?? lookAt(camera.eye, camera.target, camera.up ?? [0, 1, 0]);
    const aspect = camera.aspect ?? this.width / this.height;
    const projection =
      camera.projectionMatrix ??
      perspective(camera.fovY, aspect, camera.near, camera.far);
    const viewProjection = multiply(projection, view);

    this.stats.occluderTrianglesSubmitted += triangles.length;

    for (const triangle of triangles) {
      const clipVertices = triangle.map((p) => transformPoint(viewProjection, p));
      const clipped = clipTriangle(clipVertices);
      for (const piece of clipped) {
        this.stats.occluderTrianglesRasterized += 1;
        rasterizeTriangle(piece, this.width, this.height, this.depthBuffer, this.stats);
      }
    }

    this.levels = buildHiZ(this.depthBuffer, this.width, this.height);
    this.stats.occupiedPixels = countOccupied(this.depthBuffer);
    return this.snapshot();
  }

  // Classify one world-space axis-aligned box.
  classifyBox(camera, box) {
    this.stats.candidatesTested += 1;
    const corners = boxCorners(box);
    const planes = extractPlanes(this._viewProjection(camera));
    const outsidePlane = boxOutsideFrustum(planes, corners);
    if (outsidePlane !== null) {
      this.stats.frustumRejected += 1;
      this.stats.uncertain += 1;
      return {
        status: OcclusionStatus.UNCERTAIN,
        frustum: "outside",
        reason: `frustum:${outsidePlane}`,
      };
    }

    const vp = this._viewProjection(camera);
    const projected = [];
    for (const corner of corners) {
      const clip = transformPoint(vp, corner);
      if (!(clip[3] > 0)) {
        // Any box corner at or behind the near plane makes the volume
        // provably visible because it intersects the camera's near region.
        this.stats.visible += 1;
        return {
          status: OcclusionStatus.VISIBLE,
          frustum: "intersects",
          reason: "near-plane-intersection",
        };
      }
      projected.push(clip);
    }

    let minNdcX = Infinity;
    let maxNdcX = -Infinity;
    let minNdcY = Infinity;
    let maxNdcY = -Infinity;
    let minDepth = INVALID_DEPTH;

    for (const clip of projected) {
      const invW = 1 / clip[3];
      const ndcX = clip[0] * invW;
      const ndcY = clip[1] * invW;
      const ndcZ = clip[2] * invW;
      minNdcX = Math.min(minNdcX, ndcX);
      maxNdcX = Math.max(maxNdcX, ndcX);
      minNdcY = Math.min(minNdcY, ndcY);
      maxNdcY = Math.max(maxNdcY, ndcY);

      // The box's nearest possible surface: quantize downward so equality
      // can never be misread as "behind" an occluder.
      const clampedZ = ndcZ < 0 ? 0 : ndcZ > 1 ? 1 : ndcZ;
      const depth = Math.floor(clampedZ * MAX_STORED_DEPTH);
      if (depth < minDepth) {
        minDepth = depth;
      }
    }

    // One-pixel outward dilation in each direction keeps box borders and
    // thin slivers inside the tested footprint.
    const x0 = Math.floor((minNdcX * 0.5 + 0.5) * this.width) - 1;
    const x1 = Math.ceil((maxNdcX * 0.5 + 0.5) * this.width);
    const y0 = Math.floor((1 - (maxNdcY * 0.5 + 0.5)) * this.height) - 1;
    const y1 = Math.ceil((1 - (minNdcY * 0.5 + 0.5)) * this.height);

    if (x1 < 0 || y1 < 0 || x0 >= this.width || y0 >= this.height) {
      this.stats.uncertain += 1;
      return {
        status: OcclusionStatus.UNCERTAIN,
        frustum: "inside",
        reason: "projection-outside-viewport",
      };
    }

    const level = chooseLevel(this.levels, Math.max(1, x1 - x0 + 1), Math.max(1, y1 - y0 + 1));
    const scale = 2 ** level;
    const tileMinX = Math.floor(x0 / scale);
    const tileMinY = Math.floor(y0 / scale);
    const tileMaxX = Math.floor(x1 / scale);
    const tileMaxY = Math.floor(y1 / scale);
    const result = queryRect(this.levels, level, tileMinX, tileMinY, tileMaxX, tileMaxY);

    if (result.hasInvalid) {
      this.stats.uncertain += 1;
      return {
        status: OcclusionStatus.UNCERTAIN,
        frustum: "inside",
        reason: result.offScreen ? "footprint-off-screen" : "footprint-touches-empty-depth",
        hizLevel: level,
      };
    }
    // Strict comparison: a tie means the box may touch the occluder and
    // must remain visible.
    if (result.maxDepth < minDepth) {
      this.stats.occluded += 1;
      return {
        status: OcclusionStatus.OCCLUDED,
        frustum: "inside",
        reason: "all-covered-and-behind",
        hizLevel: level,
      };
    }
    this.stats.visible += 1;
    return {
      status: OcclusionStatus.VISIBLE,
      frustum: "inside",
      reason: "closer-than-or-level-with-occluder",
      hizLevel: level,
    };
  }

  classifyBoxes(camera, boxes) {
    return boxes.map((box) => this.classifyBox(camera, box));
  }

  reset() {
    this.depthBuffer.fill(INVALID_DEPTH);
    this.levels = buildHiZ(this.depthBuffer, this.width, this.height);
    for (const key of Object.keys(this.stats)) {
      this.stats[key] = 0;
    }
  }

  snapshot() {
    return {
      width: this.width,
      height: this.height,
      depthBuffer: Uint32Array.from(this.depthBuffer),
      levels: this.levels.map((level) => ({
        width: level.width,
        height: level.height,
        data: Uint32Array.from(level.data),
      })),
      stats: { ...this.stats },
    };
  }

  _viewProjection(camera) {
    const view = camera.viewMatrix ?? lookAt(camera.eye, camera.target, camera.up ?? [0, 1, 0]);
    const aspect = camera.aspect ?? this.width / this.height;
    const projection =
      camera.projectionMatrix ??
      perspective(camera.fovY, aspect, camera.near, camera.far);
    return multiply(projection, view);
  }
}

function countOccupied(buffer) {
  let count = 0;
  for (const value of buffer) {
    if (value !== INVALID_DEPTH) {
      count += 1;
    }
  }
  return count;
}
