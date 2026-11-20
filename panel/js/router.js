const views = new Set(["chat", "meeting", "office"]);

export function readRoute(hash) {
  const [path, query] = hash.replace(/^#\/?/, "").split("?", 2);
  return { view: views.has(path) ? path : "chat", anchor: new URLSearchParams(query).get("anchor") || "" };
}

export function routeHref({ view, anchor }) {
  return "#/" + view + (anchor ? "?" + new URLSearchParams({ anchor }) : "");
}

export function router(onRoute) {
  const changed = () => onRoute(readRoute(window.location.hash));
  window.addEventListener("hashchange", changed);
  changed();
  return (target) => {
    const next = routeHref(target);
    if (window.location.hash === next) changed();
    else window.location.hash = next;
  };
}
