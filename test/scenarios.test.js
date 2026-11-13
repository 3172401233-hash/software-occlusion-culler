import test from "node:test";
import assert from "node:assert/strict";

import { OcclusionCuller, OcclusionStatus, INVALID_DEPTH } from "../lib/index.js";
import {
  box,
  buffersEqual,
  defaultCamera,
  occluderWall,
  quadAtZ,
  randomBoxes,
  randomTriangles,
} from "./helpers.js";

const W = 32;
const H = 24;

function newCuller() {
  return new OcclusionCuller({ depthWidth: W, depthHeight: H });
}

test("front and rear boxes: occluder hides only objects behind it", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  culler.renderOccluders(camera, occluderWall(-10));

  const behind = culler.classifyBox(camera, box([-0.5, -0.5, -12], [0.5, 0.5, -11]));
  const inFront = culler.classifyBox(camera, box([-0.5, -0.5, -8], [0.5, 0.5, -7]));

  assert.equal(behind.status, OcclusionStatus.OCCLUDED);
  assert.equal(inFront.status, OcclusionStatus.VISIBLE);
  assert.equal(behind.reason, "all-covered-and-behind");
});

test("edge hole: a box touching an uncovered region is uncertain, never occluded", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  culler.renderOccluders(camera, quadAtZ(-10, 1.2, 1.2));

  const fullyCovered = culler.classifyBox(
    camera,
    box([-0.25, -0.25, -11.2], [0.25, 0.25, -10.8])
  );
  const crossingEdge = culler.classifyBox(
    camera,
    box([0.8, -0.25, -11.2], [1.8, 0.25, -10.8])
  );

  assert.equal(fullyCovered.status, OcclusionStatus.OCCLUDED);
  assert.equal(crossingEdge.status, OcclusionStatus.UNCERTAIN);
  assert.equal(crossingEdge.reason, "footprint-touches-empty-depth");
});

test("thin gap between two occluder triangles keeps the gap visible", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  const left = quadAtZ(-10, 1.0, 4, -1.6, 0);
  const right = quadAtZ(-10, 1.0, 4, 1.6, 0);
  culler.renderOccluders(camera, [...left, ...right]);

  const inSlit = culler.classifyBox(
    camera,
    box([-0.12, -0.25, -12], [0.12, 0.25, -11])
  );
  const behindWall = culler.classifyBox(
    camera,
    box([-2.0, -0.25, -12], [-1.3, 0.25, -11])
  );

  assert.notEqual(inSlit.status, OcclusionStatus.OCCLUDED);
  assert.equal(behindWall.status, OcclusionStatus.OCCLUDED);
});

test("near-plane interpenetration is always visible", () => {
  const culler = newCuller();
  const camera = defaultCamera({ near: 1 });
  culler.renderOccluders(camera, occluderWall(-5));

  const result = culler.classifyBox(camera, box([-0.5, -0.5, 2], [0.5, 0.5, -8]));
  assert.equal(result.status, OcclusionStatus.VISIBLE);
  assert.equal(result.reason, "near-plane-intersection");
});

test("a box entirely behind the camera is frustum rejected", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  culler.renderOccluders(camera, occluderWall(-10));

  const result = culler.classifyBox(camera, box([-1, -1, 4], [1, 1, 8]));
  assert.equal(result.status, OcclusionStatus.UNCERTAIN);
  assert.equal(result.frustum, "outside");
  assert.ok(result.reason.startsWith("frustum:"));
});

test("empty occluder set leaves every inside box uncertain through empty depth", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  culler.renderOccluders(camera, []);

  const result = culler.classifyBox(camera, box([-0.5, -0.5, -12], [0.5, 0.5, -11]));
  assert.equal(result.status, OcclusionStatus.UNCERTAIN);
  assert.equal(result.reason, "footprint-touches-empty-depth");
  assert.equal(culler.stats.occupiedPixels, 0);
  assert.equal(culler.stats.depthWrites, 0);
});

test("hierarchical query uses mip levels and returns correct statuses", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  culler.renderOccluders(camera, occluderWall(-10));

  assert.ok(culler.levels.length > 1);
  const small = culler.classifyBox(camera, box([-0.2, -0.2, -12], [0.2, 0.2, -11.5]));
  const large = culler.classifyBox(camera, box([-3, -3, -12], [3, 3, -11.5]));
  assert.equal(small.status, OcclusionStatus.OCCLUDED);
  assert.equal(large.status, OcclusionStatus.OCCLUDED);
  assert.ok(large.hizLevel >= small.hizLevel);
});

test("high resolution non-power-of-two buffers keep borders conservative", () => {
  const hiRes = new OcclusionCuller({ depthWidth: 197, depthHeight: 131 });
  const camera = defaultCamera();
  // Wall whose edge stays well inside the wide viewport while still leaving
  // plenty of covered pixels around the candidate's dilated footprint.
  hiRes.renderOccluders(camera, quadAtZ(-10, 3, 3));

  const center = hiRes.classifyBox(camera, box([-0.3, -0.3, -12], [0.3, 0.3, -11]));
  const border = hiRes.classifyBox(camera, box([7.2, -0.5, -12], [8.4, 0.5, -11]));

  assert.equal(center.status, OcclusionStatus.OCCLUDED);
  assert.notEqual(border.status, OcclusionStatus.OCCLUDED);
  assert.equal(hiRes.levels.at(-1).width, 1);
  assert.equal(hiRes.levels.at(-1).height, 1);
});

test("identical inputs produce bit-identical depth pyramids and classifications", () => {
  const camera = defaultCamera();
  const triangles = randomTriangles(42, 40);
  const boxes = randomBoxes(7, 25);

  const first = newCuller();
  first.renderOccluders(camera, triangles);
  const firstResults = first.classifyBoxes(camera, boxes);

  const second = newCuller();
  second.renderOccluders(camera, triangles);
  const secondResults = second.classifyBoxes(camera, boxes);

  assert.ok(buffersEqual(first.depthBuffer, second.depthBuffer));
  assert.equal(first.levels.length, second.levels.length);
  for (let i = 0; i < first.levels.length; i++) {
    assert.ok(buffersEqual(first.levels[i].data, second.levels[i].data));
  }
  assert.deepEqual(firstResults, secondResults);
});

test("depth ties resolve as visible rather than occluded", () => {
  const culler = newCuller();
  const camera = defaultCamera({ near: 1, far: 100 });
  culler.renderOccluders(camera, quadAtZ(-10, 3, 3));

  const tied = culler.classifyBox(camera, box([-0.5, -0.5, -10], [0.5, 0.5, -9.5]));
  assert.equal(tied.status, OcclusionStatus.VISIBLE);
});

test("multiple occluder triangles combine into one conservative result", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  const pieces = [
    ...quadAtZ(-10, 2, 2, -2, 0),
    ...quadAtZ(-12, 2, 2, 2, 0),
  ];
  culler.renderOccluders(camera, pieces);

  const nearSide = culler.classifyBox(camera, box([-2.2, -0.4, -11], [-1.8, 0.4, -10.6]));
  const farSide = culler.classifyBox(camera, box([1.8, -0.4, -14], [2.2, 0.4, -13.6]));
  assert.equal(nearSide.status, OcclusionStatus.OCCLUDED);
  assert.equal(farSide.status, OcclusionStatus.OCCLUDED);
});

test("stats count candidates, writes, occupancy and classification totals", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  culler.renderOccluders(camera, occluderWall(-10));
  const initialWrites = culler.stats.depthWrites;

  culler.classifyBox(camera, box([-0.5, -0.5, -12], [0.5, 0.5, -11]));
  culler.classifyBox(camera, box([-0.5, -0.5, -8], [0.5, 0.5, -7]));
  culler.classifyBox(camera, box([-1, -1, 4], [1, 1, 8]));

  assert.equal(culler.stats.candidatesTested, 3);
  assert.equal(culler.stats.occluded + culler.stats.visible + culler.stats.uncertain, 3);
  assert.equal(culler.stats.occluded, 1);
  assert.equal(culler.stats.visible, 1);
  assert.equal(culler.stats.uncertain, 1);
  assert.equal(culler.stats.frustumRejected, 1);
  assert.ok(culler.stats.occupiedPixels > 0);
  assert.equal(culler.stats.depthWrites, initialWrites);
  assert.ok(culler.stats.occluderTrianglesSubmitted >= 2);
  assert.ok(culler.stats.occluderTrianglesRasterized >= 2);
});

test("reset clears all depth data and statistics", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  culler.renderOccluders(camera, occluderWall(-10));
  culler.classifyBox(camera, box([-0.5, -0.5, -12], [0.5, 0.5, -11]));
  culler.reset();

  assert.ok(culler.depthBuffer.every((value) => value === INVALID_DEPTH));
  assert.equal(culler.stats.occupiedPixels, 0);
  assert.equal(culler.stats.candidatesTested, 0);
  assert.equal(culler.stats.depthWrites, 0);

  const result = culler.classifyBox(camera, box([-0.5, -0.5, -12], [0.5, 0.5, -11]));
  assert.equal(result.status, OcclusionStatus.UNCERTAIN);
});

test("conservative sweep: in-front boxes are never marked occluded", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  culler.renderOccluders(camera, occluderWall(-10));

  for (let z = -9.8; z > -3; z += 0.35) {
    const result = culler.classifyBox(
      camera,
      box([-0.3, -0.3, z - 0.2], [0.3, 0.3, z + 0.2])
    );
    assert.notEqual(result.status, OcclusionStatus.OCCLUDED);
  }
});

test("off-viewport and behind-camera triangles never corrupt the buffer", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  const hostile = [
    // Entirely outside the viewport after projection.
    [
      [50, 50, -5],
      [60, 50, -5],
      [50, 60, -5],
    ],
    // Entirely behind the camera (negative w).
    [
      [-1, -1, 5],
      [1, -1, 5],
      [0, 1, 5],
    ],
    // Contains NaN-like non-finite coordinates.
    [
      [Number.NaN, 0, -10],
      [1, 0, -10],
      [0, 1, -10],
    ],
  ];
  culler.renderOccluders(camera, hostile);
  assert.equal(culler.stats.depthWrites, 0);
  assert.equal(culler.stats.occupiedPixels, 0);
  for (const value of culler.depthBuffer) {
    assert.equal(value, INVALID_DEPTH);
  }
});

test("repeated renderOccluders calls accumulate while reset starts fresh", () => {
  const culler = newCuller();
  const camera = defaultCamera();
  culler.renderOccluders(camera, quadAtZ(-12, 1, 1, -3, 0));
  const firstWrites = culler.stats.depthWrites;
  culler.renderOccluders(camera, quadAtZ(-8, 1, 1, 3, 0));
  assert.ok(culler.stats.depthWrites >= firstWrites);
  assert.equal(culler.stats.occluderTrianglesSubmitted, 4);

  culler.reset();
  assert.equal(culler.stats.occluderTrianglesSubmitted, 0);
  assert.equal(culler.depthBuffer.length, W * H);
});
