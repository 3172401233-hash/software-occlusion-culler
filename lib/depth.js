// Fixed-point depth encoding. All persistent depth values are uint32 so the
// pipeline is bit-identical across machines (float64 is only used for
// intermediate math).

export const INVALID_DEPTH = 0xffffffff;
export const MAX_STORED_DEPTH = 0xfffffffe;

// NDC z is in [0, 1]. Values slightly outside that range are clamped; NaN is
// treated as invalid so it can never produce a depth write.
export function quantizeDepth(ndcZ) {
  if (!Number.isFinite(ndcZ)) {
    return INVALID_DEPTH;
  }
  const clamped = ndcZ < 0 ? 0 : ndcZ > 1 ? 1 : ndcZ;
  const scaled = Math.round(clamped * MAX_STORED_DEPTH);
  return scaled < 0 ? 0 : scaled > MAX_STORED_DEPTH ? MAX_STORED_DEPTH : scaled;
}
