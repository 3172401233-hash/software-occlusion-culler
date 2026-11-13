// Frustum plane extraction and conservative axis-aligned box tests.
// Planes are derived directly from a column-major view-projection matrix.
// NDC convention used by this library: -1 <= x,y <= 1 and 0 <= z <= 1.

function plane(a, b, c, d) {
  // Normalize so distance comparisons use physical units. Deterministic
  // because Math.hypot and division are IEEE-754 operations.
  const len = Math.hypot(a, b, c);
  if (len === 0) {
    return { a: 0, b: 0, c: 0, d: 0 };
  }
  return { a: a / len, b: b / len, c: c / len, d: d / len };
}

export function extractPlanes(vp) {
  // Row accessors for the column-major matrix.
  const r0 = [vp[0], vp[4], vp[8], vp[12]];
  const r1 = [vp[1], vp[5], vp[9], vp[13]];
  const r2 = [vp[2], vp[6], vp[10], vp[14]];
  const r3 = [vp[3], vp[7], vp[11], vp[15]];
  const add = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2], p[3] + q[3]];
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2], p[3] - q[3]];
  const mk = (v) => plane(v[0], v[1], v[2], v[3]);
  return {
    left: mk(add(r3, r0)),
    right: mk(sub(r3, r0)),
    bottom: mk(add(r3, r1)),
    top: mk(sub(r3, r1)),
    near: mk(r2),
    far: mk(sub(r3, r2)),
  };
}

export function boxCorners(box) {
  const [minX, minY, minZ] = box.min;
  const [maxX, maxY, maxZ] = box.max;
  return [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [maxX, maxY, minZ],
    [minX, maxY, minZ],
    [minX, minY, maxZ],
    [maxX, minY, maxZ],
    [maxX, maxY, maxZ],
    [minX, maxY, maxZ],
  ];
}

function signedDistance(p, corner) {
  return p.a * corner[0] + p.b * corner[1] + p.c * corner[2] + p.d;
}

// p-vertex test: a box is fully outside a plane only when every corner is on
// the negative side. No epsilon is used; ties count as intersecting, which is
// the conservative choice for visibility.
export function boxOutsideFrustum(planes, corners) {
  for (const name of ["left", "right", "bottom", "top", "near", "far"]) {
    const p = planes[name];
    let allNegative = true;
    for (const corner of corners) {
      if (signedDistance(p, corner) >= 0) {
        allNegative = false;
        break;
      }
    }
    if (allNegative) {
      return name;
    }
  }
  return null;
}
