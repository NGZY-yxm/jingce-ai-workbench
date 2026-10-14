// Declared mock capabilities for pricing and task lifecycle tests only.
// These are not claims about real provider models.
export function videoModelFixture(id) {
  return {id, durations_by_resolution: Object.fromEntries(
    (id.includes('-mini-') ? ['480p','720p'] : ['480p','720p','1080p'])
      .map(resolution=>[resolution,Array.from({length:15},(_,i)=>i+1)]))};
}
