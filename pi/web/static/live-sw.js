// jafo /live service worker — push alerts + installable app. No offline caching:
// this is a live feed, stale data would be worse than none.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "JAFO", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "JAFO Live", {
    body: d.body || "",
    tag: d.tag,
    renotify: false,
    icon: "/static/logo.png",
    badge: "/static/logo.png",
    data: { url: d.url || "/live" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/live";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.includes("/live")) { await w.focus(); w.navigate(url); return; }
    }
    await self.clients.openWindow(url);
  })());
});
