// Integration seam: the chain implementation supplies this object before app.mjs
// starts, or replaces this function with its arena.mjs factory/import.
// No demo data or wallet implementation belongs here.
export async function loadArena() {
  return globalThis.gnomehallArena ?? null;
}
