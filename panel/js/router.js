export function readRoute(hash) {
  const [path, query] = hash.replace(/^#\/?/, "").split("?", 2);
  const params = new URLSearchParams(query);
  const id = /^f\/([mr][1-9]\d*)$/.exec(path)?.[1];
  const view = id ? "folder" : ["home", "office", "chat", "workspace", "meeting"].includes(path) ? path : "home";
  return {
    view, id,
    tab: params.get("tab") || "",
    anchor: params.get("anchor") || "",
    before: /^[1-9]\d*$/.test(params.get("handoffs_before") ?? "") ? params.get("handoffs_before") : "",
  };
}

export function routeHref({ view, id, tab, anchor, before }) {
  const params = new URLSearchParams();
  if (tab) params.set("tab", tab);
  if (anchor) params.set("anchor", anchor);
  if (before) params.set("handoffs_before", before);
  return "#/" + (view === "folder" ? "f/" + id : view) + (params.size ? "?" + params : "");
}

export function router(onRoute) {
  const session = history.state?.bridgeHistory ?? crypto.randomUUID();
  const key = "bridge.history." + session;
  let index = history.state?.index ?? 0;
  let end = index;
  try { end = Math.max(index, Number(sessionStorage.getItem(key)) || 0); } catch { /* Optional on reload. */ }
  let currentHash = "";
  history.scrollRestoration = "manual";
  const mark = () => ({ bridgeHistory: session, index });
  const remember = () => {
    end = index;
    try { sessionStorage.setItem(key, String(end)); } catch { /* In-document history still works. */ }
  };
  const apply = () => {
    currentHash = location.hash;
    onRoute(readRoute(currentHash), { back: index > 0, forward: index < end });
  };
  const changed = () => {
    if (history.state?.bridgeHistory === session) {
      if (currentHash === location.hash && index === history.state.index) return;
      index = history.state.index;
    } else {
      index++;
      remember();
      history.replaceState(mark(), "");
    }
    apply();
  };
  window.addEventListener("popstate", changed);
  window.addEventListener("hashchange", changed);
  history.replaceState(mark(), "", location.hash || "#/home");
  apply();
  return (target, replace = false) => {
    const href = routeHref(target);
    if (href !== currentHash) {
      if (replace) history.replaceState(mark(), "", href);
      else {
        index++;
        remember();
        history.pushState(mark(), "", href);
      }
    }
    apply();
  };
}
