// Single near-plane clip in clip space.
// The near plane is z_clip = 0 with the valid half-space z_clip >= 0.
// Points at or behind the camera have w <= 0 and are removed before any
// perspective divide, so zero-w data can never reach the rasterizer.

function isFiniteVertex(v) {
  return (
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2]) &&
    Number.isFinite(v[3])
  );
}

function inside(v) {
  return isFiniteVertex(v) && v[2] >= 0 && v[3] > 0;
}

function clipSegment(a, b) {
  const da = a[2];
  const db = b[2];
  const t = da / (da - db);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    0,
    a[3] + (b[3] - a[3]) * t,
  ];
}

function clipPolygon(polygon) {
  const out = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const previous = polygon[(i - 1 + polygon.length) % polygon.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside) {
      if (!previousInside) {
        const hit = clipSegment(previous, current);
        if (inside(hit)) {
          out.push(hit);
        }
      }
      out.push(current);
    } else if (previousInside) {
      const hit = clipSegment(current, previous);
      if (inside(hit)) {
        out.push(hit);
      }
    }
  }
  return out;
}

// Returns zero or more clipped triangles. Each output vertex is guaranteed
// to have a strictly positive w and finite coordinates.
export function clipTriangle(vertices) {
  if (!vertices.every(isFiniteVertex)) {
    return [];
  }
  const polygon = clipPolygon(vertices);
  if (polygon.length < 3) {
    return [];
  }
  const triangles = [];
  for (let i = 1; i + 1 < polygon.length; i++) {
    const tri = [polygon[0], polygon[i], polygon[i + 1]];
    if (tri.every(inside)) {
      triangles.push(tri);
    }
  }
  return triangles;
}
