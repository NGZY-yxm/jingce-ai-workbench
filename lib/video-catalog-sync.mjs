const DEFAULT_INTERVAL_MS = 60000;
const MISSING_KEY_ERROR = '请先保存视频 API Key，再读取当前密钥的模型目录。';
const SETTINGS_ERROR = '视频模型连接暂时无法读取，请检查连接后刷新模型。';
const CATALOG_ERROR = '当前密钥的模型目录读取失败，请检查密钥或稍后刷新。';

// Keep credentials and in-flight request identities private. Public snapshots
// contain only the current connection's usable catalog and synchronization status.
export function createVideoCatalogSync({ readSettings, load, initialCatalog, intervalMs = DEFAULT_INTERVAL_MS, now = Date.now, onWarning = () => {} }) {
  const fixed = Array.isArray(initialCatalog);
  const syncIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  let catalog = fixed ? initialCatalog : [];
  let catalogSettings = null;
  let catalogError = '';
  let catalogWarning = initialCatalog?.catalogWarning || '';
  let catalogDiagnostics = initialCatalog?.catalogDiagnostics || null;
  let syncedAt = null;
  let checkedAt = null;
  let connection = null;
  let generation = 0;
  let readSequence = 0;
  let appliedReadSequence = 0;
  let inFlight = null;
  let timer = null;
  let closed = false;

  function snapshot() {
    return {
      catalog,
      catalogError,
      catalogWarning,
      catalogDiagnostics,
      catalogSyncedAt: syncedAt === null ? null : new Date(syncedAt).toISOString(),
      catalogCheckedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
      catalogSyncIntervalMs: syncIntervalMs,
    };
  }

  function sameConnection(next) {
    return connection && connection.apiKey === next.apiKey && connection.baseUrl === next.baseUrl && connection.routingVersion === next.routingVersion;
  }

  function changeConnection(next) {
    generation += 1;
    connection = next;
    inFlight = null;
    catalog = [];
    catalogSettings = null;
    catalogError = '';
    catalogWarning = '';
    catalogDiagnostics = null;
    syncedAt = null;
    checkedAt = null;
  }

  async function refresh({ force = false } = {}) {
    if (fixed || closed) return snapshot();
    const sequence = ++readSequence;
    let settings;
    try {
      settings = { ...await readSettings() };
    } catch {
      if (closed || sequence < appliedReadSequence) return snapshot();
      appliedReadSequence = sequence;
      generation += 1;
      inFlight = null;
      catalog = [];
      catalogSettings = null;
      catalogError = SETTINGS_ERROR;
      catalogWarning = '';
      catalogDiagnostics = null;
      checkedAt = now();
      return snapshot();
    }
    if (closed || sequence < appliedReadSequence) return snapshot();
    appliedReadSequence = sequence;
    const nextConnection = { apiKey: settings.apiKey || '', baseUrl: settings.baseUrl || '', routingVersion: settings.routingVersion || '' };
    if (!sameConnection(nextConnection)) changeConnection(nextConnection);
    if (!String(nextConnection.apiKey).trim()) {
      catalog = [];
      catalogError = MISSING_KEY_ERROR;
      catalogWarning = '';
      catalogDiagnostics = null;
      checkedAt = now();
      return snapshot();
    }
    if (inFlight) return inFlight.promise;
    if (!force && checkedAt !== null && now() - checkedAt < syncIntervalMs) return snapshot();

    const requestGeneration = generation;
    checkedAt = now();
    const request = { promise: null };
    // Starting in a microtask ensures the request is registered before a loader
    // that returns synchronously can settle, so concurrent callers share it.
    request.promise = Promise.resolve().then(() => load(settings)).then(nextCatalog => {
      if (closed || requestGeneration !== generation) return snapshot();
      if (!Array.isArray(nextCatalog)) throw new Error('Invalid video model catalog');
      catalog = nextCatalog;
      catalogSettings = settings;
      catalogError = '';
      const previousWarning = catalogWarning;
      catalogWarning = nextCatalog.catalogWarning || '';
      catalogDiagnostics = nextCatalog.catalogDiagnostics || null;
      if (catalogWarning && catalogWarning !== previousWarning) {
        try { onWarning(catalogWarning); } catch { /* Diagnostics must not invalidate a successful catalog read. */ }
      }
      checkedAt = now();
      syncedAt = checkedAt;
      return snapshot();
    }).catch(() => {
      if (!closed && requestGeneration === generation) {
        catalog = [];
        catalogSettings = null;
        catalogError = CATALOG_ERROR;
        catalogWarning = '';
        catalogDiagnostics = null;
        checkedAt = now();
      }
      return snapshot();
    }).finally(() => {
      if (inFlight === request) inFlight = null;
    });
    inFlight = request;
    return request.promise;
  }

  // Only the server's submission path receives this private settings snapshot.
  // Pair the catalog with the credentials that actually loaded it, even if the
  // default connection changes while a request is waiting to create its jobs.
  async function forSubmission() {
    if (fixed) return { ...snapshot(), settings: { ...await readSettings() } };
    await refresh({ force: true });
    return { ...snapshot(), settings: catalogSettings ? { ...catalogSettings } : null };
  }

  function start() {
    if (!closed && !fixed && timer === null) {
      timer = setInterval(() => refresh({ force: true }), syncIntervalMs);
      timer.unref?.();
    }
    return api;
  }

  function close() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    closed = true;
    generation += 1;
    inFlight = null;
  }

  const api = { refresh, snapshot, forSubmission, start, close };
  return api;
}
