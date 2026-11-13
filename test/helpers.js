// Deterministic test data generation. mulberry32 is a fixed integer PRNG so
// generated geometry is reproducible bit-for-bit.

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function defaultCamera(overrides = {}) {
  return {
    eye: [0, 0, 0],
    target: [0, 0, -1],
    up: [0, 1, 0],
    fovY: Math.PI / 3,
    near: 1,
    far: 100,
    ...overrides,
  };
}

export function box(min, max) {
  return { min, max };
}

// Axis-aligned quad in the XY plane at a fixed z, split into two triangles.
export function quadAtZ(z, halfWidth, halfHeight, centerX = 0, centerY = 0) {
  const x0 = centerX - halfWidth;
  const x1 = centerX + halfWidth;
  const y0 = centerY - halfHeight;
  const y1 = centerY + halfHeight;
  const a = [x0, y0, z];
  const b = [x1, y0, z];
  const c = [x1, y1, z];
  const d = [x0, y1, z];
  return [
    [a, b, c],
    [a, c, d],
  ];
}

// Full-screen-ish occluder wall at depth z.
export function occluderWall(z = -10) {
  return quadAtZ(z, 8, 8);
}

export function randomTriangles(seed, count, zMin = -60, zMax = -6) {
  const random = mulberry32(seed);
  const triangles = [];
  for (let i = 0; i < count; i++) {
    const z = -(zMin + random() * (zMax - zMin));
    const cx = (random() - 0.5) * 10;
    const cy = (random() - 0.5) * 10;
    const size = 0.4 + random() * 1.6;
    triangles.push([
      [cx - size, cy - size, z],
      [cx + size, cy - size, z + (random() - 0.5) * 2],
      [cx, cy + size, z + (random() - 0.5) * 2],
    ]);
  }
  return triangles;
}

export function randomBoxes(seed, count) {
  const random = mulberry32(seed);
  const boxes = [];
  for (let i = 0; i < count; i++) {
    const cx = (random() - 0.5) * 12;
    const cy = (random() - 0.5) * 12;
    const z = -2 - random() * 70;
    const half = 0.25 + random() * 0.75;
    boxes.push(
      box(
        [cx - half, cy - half, z - half],
        [cx + half, cy + half, z + half]
      )
    );
  }
  return boxes;
}

export function buffersEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
