/**
 * ===================================================================
 * ⚡ CLOUDFLARE WORKER POOL & SMART FAILOVER MANAGER
 * Supports multiple Cloudflare Workers with automatic health checks,
 * round-robin load distribution, and zero-downtime failover shifting.
 * ===================================================================
 */

class CloudflareWorkerPool {
  constructor() {
    this.workers = [];
    this.currentIndex = 0;
    this.workerStats = new Map();
    this.reloadWorkers();
  }

  /**
   * Parse worker list from environment variables
   * Priority: CLOUDFLARE_WORKERS -> CF_WORKERS -> BASE_HOST_URL -> HOST_URL
   */
  reloadWorkers() {
    const rawList = (
      process.env.CLOUDFLARE_WORKERS ||
      process.env.CF_WORKERS ||
      process.env.WORKER_POOLS ||
      process.env.BASE_HOST_URL ||
      process.env.HOST_URL ||
      "https://live.betadda.workers.dev"
    ).trim();

    // Split comma-separated URLs and clean up
    const list = rawList
      .split(/[,;\s\n]+/)
      .map((w) => w.trim().replace(/\/+$/, ""))
      .filter((w) => w.startsWith("http://") || w.startsWith("https://"));

    this.workers = list.length > 0 ? list : ["https://live.betadda.workers.dev"];

    // Initialize stats map for each worker
    for (const w of this.workers) {
      if (!this.workerStats.has(w)) {
        this.workerStats.set(w, {
          url: w,
          consecutiveErrors: 0,
          totalSuccess: 0,
          totalErrors: 0,
          lastFailureTime: 0,
          isHealthy: true,
        });
      }
    }

    console.log(`⚡ [WorkerPool] Loaded ${this.workers.length} Cloudflare Workers:`);
    this.workers.forEach((w, idx) => console.log(`   [${idx + 1}] ${w}`));
  }

  /**
   * Get all registered workers
   */
  getAllWorkers() {
    return [...this.workers];
  }

  /**
   * Get the primary or best healthy worker
   * Uses round-robin among healthy workers, with circuit breaker protection
   */
  getBestWorker() {
    if (this.workers.length === 0) {
      return "https://live.betadda.workers.dev";
    }

    const now = Date.now();
    const COOL_DOWN_MS = 45 * 1000; // 45s cooldown after failure

    // Find all workers that are either healthy or whose cooldown has expired
    const available = this.workers.filter((w) => {
      const stats = this.workerStats.get(w);
      if (!stats) return true;
      if (stats.isHealthy) return true;
      if (now - stats.lastFailureTime > COOL_DOWN_MS) {
        // Cooldown passed, allow retry (half-open state)
        stats.isHealthy = true;
        stats.consecutiveErrors = 0;
        return true;
      }
      return false;
    });

    const poolToUse = available.length > 0 ? available : this.workers;
    this.currentIndex = (this.currentIndex + 1) % poolToUse.length;
    return poolToUse[this.currentIndex];
  }

  /**
   * Report success on a worker
   */
  reportSuccess(workerUrl) {
    if (!workerUrl) return;
    const clean = String(workerUrl).trim().replace(/\/+$/, "");
    const found = this.workers.find((w) => clean.startsWith(w));
    if (found) {
      const stats = this.workerStats.get(found);
      if (stats) {
        stats.isHealthy = true;
        stats.consecutiveErrors = 0;
        stats.totalSuccess++;
      }
    }
  }

  /**
   * Report failure on a worker (triggers smart failover shift)
   */
  reportFailure(workerUrl, errorMsg = "") {
    if (!workerUrl) return;
    const clean = String(workerUrl).trim().replace(/\/+$/, "");
    const found = this.workers.find((w) => clean.startsWith(w));
    if (found) {
      const stats = this.workerStats.get(found);
      if (stats) {
        stats.consecutiveErrors++;
        stats.totalErrors++;
        stats.lastFailureTime = Date.now();
        if (stats.consecutiveErrors >= 2) {
          stats.isHealthy = false;
          console.warn(`⚠️ [WorkerPool] Worker marked degraded/offline: ${found} (${errorMsg})`);
        }
      }
    }
  }

  /**
   * Helper to swap origin/domain in any stream URL to the target worker
   */
  replaceWorkerHost(streamUrl, targetWorker) {
    if (!streamUrl || !targetWorker) return streamUrl;
    try {
      const urlObj = new URL(streamUrl);
      const targetObj = new URL(targetWorker);
      urlObj.protocol = targetObj.protocol;
      urlObj.host = targetObj.host;
      urlObj.port = targetObj.port;
      return urlObj.toString();
    } catch (_) {
      return streamUrl;
    }
  }
}

const workerPoolInstance = new CloudflareWorkerPool();

module.exports = {
  CloudflareWorkerPool,
  workerPool: workerPoolInstance,
};
