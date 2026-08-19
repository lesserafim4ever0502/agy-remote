export function mergeStepsUpdate(current, update = {}) {
  const full = Array.isArray(current) ? current : [];
  const indices = update.indices || [];
  const steps = update.steps || [];
  const totalLength = Number(update.totalLength ?? update.total_length ?? 0);

  if (indices.length > 0 && indices.length === steps.length) {
    const next = [...full];
    if (totalLength > next.length) next.length = totalLength;
    for (let i = 0; i < indices.length; i += 1) next[indices[i]] = steps[i];
    return next;
  }
  if (steps.length >= full.filter(Boolean).length) return [...steps];
  return full;
}

export function changedIndices(update = {}, beforeLength = 0) {
  const indices = update.indices || [];
  if (indices.length) return [...indices];
  const steps = update.steps || [];
  return steps.map((_, index) => index).filter((index) => index >= 0 || index >= beforeLength);
}
