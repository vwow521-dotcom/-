export function createState(connectionChanged) {
  const subscribers = [];
  let current = null;
  let refreshing = false;
  let pending = false;

  async function refresh() {
    if (refreshing) {
      pending = true;
      return;
    }
    refreshing = true;
    try {
      do {
        pending = false;
        try {
          const response = await fetch("/api/state", { cache: "no-store" });
          if (!response.ok) throw new Error("HTTP " + response.status);
          current = await response.json();
          connectionChanged(null);
        } catch (error) {
          connectionChanged(error);
          continue;
        }
        for (const subscriber of subscribers) {
          const data = subscriber.select(current);
          const signature = JSON.stringify(data);
          if (signature === subscriber.signature) continue;
          subscriber.render(data);
          subscriber.signature = signature;
        }
      } while (pending);
    } finally {
      refreshing = false;
    }
  }

  return {
    subscribe(select, render) { subscribers.push({ select, render, signature: undefined }); },
    get current() { return current; },
    refresh,
    start() {
      void refresh();
      const stream = new EventSource("/api/stream");
      stream.onmessage = refresh;
      setInterval(refresh, 5000);
    },
  };
}
