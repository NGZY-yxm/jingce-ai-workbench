export const CARD_WIDTH = 320;
export const CARD_HEIGHT = 260;
export const CARD_SIZE_VERSION = 1;

// Normalize existing covers once; later manual resizing remains a user choice.
export function normalizeCardSizes(graph) {
  const migrate = graph.cardSizeVersion !== CARD_SIZE_VERSION;
  let changed = migrate;
  for (const node of graph.nodes) {
    if (migrate || !Number.isFinite(node.width)) { node.width = CARD_WIDTH; changed = true; }
    if (migrate || !Number.isFinite(node.height)) { node.height = CARD_HEIGHT; changed = true; }
  }
  graph.cardSizeVersion = CARD_SIZE_VERSION;
  return changed;
}
