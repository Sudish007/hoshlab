// Token store: sessionStorage by default (this tab only), localStorage only when the owner ticks
// "Remember on this device". The origin is shared with the owner's other GitHub Pages sites, hence
// the cautious default. (ai-batkahi pattern; design §13 key.)
export const KEY = "hoshlab.admin.token";

export function createStore({ session = globalThis.sessionStorage, local = globalThis.localStorage } = {}) {
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  return {
    get: () => safe(() => session.getItem(KEY)) || safe(() => local.getItem(KEY)) || null,
    set(token, remember) {
      const target = remember ? local : session;
      const other = remember ? session : local;
      safe(() => other.removeItem(KEY));
      try {
        target.setItem(KEY, token);
        return { persisted: true };
      } catch {
        return { persisted: false };
      }
    },
    clear() {
      safe(() => session.removeItem(KEY));
      safe(() => local.removeItem(KEY));
    },
    remembered: () => Boolean(safe(() => local.getItem(KEY))),
  };
}
