/**
 * Poll ndsctl trên router mỗi N phút → đóng phiên visit khi MAC không còn online.
 */
const store = require("./db");
const routerCtl = require("./router");

async function syncLocation(router) {
  if (!router?.ssh_host || !router.location_id) return { ended: 0, online: 0 };
  const clients = await routerCtl.listClients(router);
  const onlineMacs = clients
    .filter((c) => /auth|pre/i.test(String(c.state || "")))
    .map((c) => String(c.mac || "").toLowerCase())
    .filter(Boolean);
  const ended = store.endStaleActiveVisits(router.location_id, onlineMacs);
  return { ended, online: onlineMacs.length };
}

async function syncAll() {
  const routers = store.listRoutersWithLocation().filter((r) => r.ssh_host);
  let totalEnded = 0;
  for (const router of routers) {
    try {
      const { ended } = await syncLocation(router);
      totalEnded += ended || 0;
    } catch (e) {
      console.warn(`[session-sync] location ${router.location_id}: ${e.message}`);
    }
  }
  if (totalEnded > 0) console.log(`[session-sync] closed ${totalEnded} offline session(s)`);
  return totalEnded;
}

function startSessionSync(intervalMs) {
  const ms = Number(intervalMs || process.env.SESSION_SYNC_MS || 120_000);
  syncAll().catch((e) => console.warn("[session-sync]", e.message));
  setInterval(() => syncAll().catch((e) => console.warn("[session-sync]", e.message)), ms);
  console.log(`[session-sync] started every ${Math.round(ms / 1000)}s`);
}

module.exports = { syncAll, syncLocation, startSessionSync };
