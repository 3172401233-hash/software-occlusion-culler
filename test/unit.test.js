import test from "node:test";
import assert from "node:assert/strict";

import {
  INVALID_DEPTH,
  MAX_STORED_DEPTH,
  buildHiZ,
  clipTriangle,
  createDepthBuffer,
  extractPlanes,
  lookAt,
  multiply,
  perspective,
  quantizeDepth,
  queryRect,
  rasterizeTriangle,
  transformPoint,
} from "../lib/index.js";

test("quantizeDepth clamps, rounds and rejects NaN", () => {
  assert.equal(quantizeDepth(0), 0);
  assert.equal(quantizeDepth(1), MAX_STORED_DEPTH);
  assert.equal(quantizeDepth(-0.5), 0);
  assert.equal(quantizeDepth(1.5), MAX_STORED_DEPTH);
  assert.equal(quantizeDepth(Number.NaN), INVALID_DEPTH);
  assert.ok(quantizeDepth(0.5) > 0 && quantizeDepth(0.5) < MAX_STORED_DEPTH);
});

test("near clipping keeps positive-w vertices and drops fully behind-camera triangles", () => {
  // Two vertices behind the camera (negative w), one in front. The segment
  // crosses z_clip = 0 where w also becomes positive after interpolation.
  const behind = [
    [0, 0, -4, -2],
    [1, 0, -4, -2],
    [0, 1, 5, 5],
  ];
  const clipped = clipTriangle(behind);
  assert.ok(clipped.length >= 1);
  for (const triangle of clipped) {
    for (const vertex of triangle) {
      assert.ok(vertex[3] > 0);
      assert.ok(vertex[2] >= 0);
    }
  }

  const fullyBehind = [
    [0, 0, -2, -2],
    [1, 0, -2, -2],
    [0, 1, -2, -2],
  ];
  assert.deepEqual(clipTriangle(fullyBehind), []);

  const zeroW = [
    [0, 0, 0, 0],
    [1, 0, -1, -1],
    [0, 1, -1, -1],
  ];
  assert.deepEqual(clipTriangle(zeroW), []);
});

test("rasterizer never writes outside the viewport", () => {
  const width = 8;
  const height = 6;
  const depthBuffer = createDepthBuffer(width, height);
  const stats = { depthWrites: 0 };

  // Huge triangle spanning far beyond the viewport in clip space.
  const huge = [
    [-50, -50, 0.5, 1],
    [50, -50, 0.5, 1],
    [0, 50, 0.5, 1],
  ];
  rasterizeTriangle(huge, width, height, depthBuffer, stats);
  assert.ok(stats.depthWrites > 0);
  for (const value of depthBuffer) {
    assert.notEqual(value, undefined);
  }
  assert.equal(depthBuffer.length, width * height);

  // Degenerate zero-area triangle performs no writes.
  const before = stats.depthWrites;
  const degenerate = [
    [0, 0, 0.5, 1],
    [0, 0, 0.5, 1],
    [1, 1, 0.5, 1],
  ];
  rasterizeTriangle(degenerate, width, height, depthBuffer, stats);
  assert.equal(stats.depthWrites, before);
});

test("nearest depth wins and far triangles do not overwrite near ones", () => {
  const width = 4;
  const height = 4;
  const depthBuffer = createDepthBuffer(width, height);
  const stats = { depthWrites: 0 };
  const far = [
    [-2, -2, 0.9, 1],
    [2, -2, 0.9, 1],
    [0, 2, 0.9, 1],
  ];
  const near = [
    [-2, -2, 0.1, 1],
    [2, -2, 0.1, 1],
    [0, 2, 0.1, 1],
  ];
  rasterizeTriangle(far, width, height, depthBuffer, stats);
  const afterFar = stats.depthWrites;
  rasterizeTriangle(near, width, height, depthBuffer, stats);
  assert.ok(stats.depthWrites > afterFar);

  const writesBefore = stats.depthWrites;
  rasterizeTriangle(far, width, height, depthBuffer, stats);
  assert.equal(stats.depthWrites, writesBefore);
  for (const value of depthBuffer) {
    if (value !== INVALID_DEPTH) {
      assert.ok(value <= quantizeDepth(0.1));
    }
  }
});

test("HiZ pyramid stores max depth and keeps invalid regions", () => {
  const depthBuffer = new Uint32Array([
    10, 20, INVALID_DEPTH, 40,
    30, INVALID_DEPTH, 50, 60,
  ]);
  const levels = buildHiZ(depthBuffer, 4, 2);
  assert.deepEqual(Array.from(levels[0].data), Array.from(depthBuffer));
  assert.equal(levels[1].width, 2);
  assert.equal(levels[1].height, 1);
  assert.equal(levels[1].data[0], 30);
  assert.equal(levels[1].data[1], 60);
  assert.equal(levels[2].data[0], 60);

  const full = queryRect(levels, 0, 0, 0, 3, 1);
  assert.equal(full.hasInvalid, true);
  assert.equal(full.maxDepth, 60);

  const covered = queryRect(levels, 0, 0, 0, 0, 0);
  assert.equal(covered.hasInvalid, false);
  assert.equal(covered.maxDepth, 10);

  const padded = queryRect(levels, 1, 0, 0, 4, 0);
  assert.equal(padded.hasInvalid, true);
});

test("projection and view matrices map the camera target to the view axis", () => {
  const camera = {
    eye: [0, 0, 5],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fovY: Math.PI / 2,
    near: 1,
    far: 20,
  };
  const view = lookAt(camera.eye, camera.target, camera.up);
  const projection = perspective(camera.fovY, 1, camera.near, camera.far);
  const vp = multiply(projection, view);

  const atTarget = transformPoint(vp, [0, 0, 0]);
  const ndcZ = atTarget[2] / atTarget[3];
  // View-space depth 5 with near=1, far=20:
  // ndcZ = far / (far-near) * (1 - near/depth) = (20/19) * (4/5).
  assert.ok(Math.abs(ndcZ - (20 / 19) * (4 / 5)) < 1e-12);

  const behind = transformPoint(vp, [0, 0, 10]);
  assert.ok(behind[3] < 0);

  const planes = extractPlanes(vp);
  for (const name of ["left", "right", "bottom", "top", "near", "far"]) {
    assert.ok(Number.isFinite(planes[name].a));
    assert.ok(Math.abs(Math.hypot(planes[name].a, planes[name].b, planes[name].c) - 1) < 1e-12);
  }
});
