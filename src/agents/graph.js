export function linkDependencies(items, finishedIds) {
  for (const [index, item] of items.entries()) {
    item.predecessors = [];
    item.earlierResults = [];
    for (const id of item.dependsOn) linkNamedDependency(item, id, items, finishedIds);
    for (const earlier of items.slice(0, index)) {
      if (sharesFiles(item, earlier) && !item.predecessors.includes(earlier)) item.predecessors.push(earlier);
    }
  }
}

function linkNamedDependency(item, id, items, finishedIds) {
  const predecessor = items.find((candidate) => candidate !== item && candidate.id === id);
  if (predecessor) {
    item.predecessors.push(predecessor);
    return;
  }
  if (finishedIds.has(id)) {
    item.earlierResults.push({ id, result: finishedIds.get(id) });
    return;
  }
  item.result = `Error: depends_on names '${id}', but no task in this reply or earlier has that id.`;
}

function sharesFiles(item, earlier) {
  if (item.role !== "worker" || earlier.role !== "worker") return false;
  return item.files.some((file) => earlier.files.includes(file));
}

export function pickWave(pending, maxParallel) {
  const ready = pending.filter((item) => item.predecessors.every((predecessor) => predecessor.result !== null));
  return ready.slice(0, maxParallel);
}

export function applyFanOutRule(items, settings) {
  const workers = items.filter((item) => item.role === "worker" && item.result === null);
  if (workers.length === 0) return;
  const independent = workers.filter((item) => !item.predecessors.some((predecessor) => predecessor.role === "worker"));
  const fileCount = new Set(workers.flatMap((item) => item.files)).size;
  if (independent.length >= settings.fanOutMinItems || fileCount >= settings.fanOutMinFiles) return;
  for (const item of workers) {
    item.result = `Refused: ${workers.length} small worker task(s) touching ${fileCount} file(s) is not worth a sub-agent (workers need ${settings.fanOutMinItems}+ independent pieces or ${settings.fanOutMinFiles}+ files). Do this change yourself.`;
  }
}
