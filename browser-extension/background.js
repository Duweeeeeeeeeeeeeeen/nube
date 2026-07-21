const DEFAULT_ENDPOINT = "http://127.0.0.1:5174/api/integrations/webhook/capture";
const QUEUE_KEY = "offlineQueue";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "nube-save-page", title: "Save page to Nube", contexts: ["page"] });
  chrome.contextMenus.create({ id: "nube-save-selection", title: "Save selection to Nube", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "nube-save-link", title: "Save link to Nube", contexts: ["link"] });
  chrome.contextMenus.create({ id: "nube-save-image", title: "Save image to Nube", contexts: ["image"] });
});

const readSettings = async () => {
  const settings = await chrome.storage.sync.get(["endpoint", "token", "authMode"]);
  return {
    endpoint: settings.endpoint || DEFAULT_ENDPOINT,
    token: settings.token || "",
    authMode: settings.authMode || "session",
  };
};

const apiBaseFromEndpoint = (endpoint) => endpoint.replace(/\/api\/integrations\/webhook\/capture\/?$/, "");
const sessionEndpointFrom = (endpoint) => `${apiBaseFromEndpoint(endpoint)}/api/extension/capture`;

const queuedCaptures = async () => {
  const store = await chrome.storage.local.get([QUEUE_KEY]);
  return Array.isArray(store[QUEUE_KEY]) ? store[QUEUE_KEY] : [];
};

const queueCapture = async (payload) => {
  const queue = await queuedCaptures();
  queue.push({ id: crypto.randomUUID(), payload, createdAt: new Date().toISOString() });
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-30) });
  return queue.length + 1;
};

const removeQueuedCapture = async (id) => {
  const queue = await queuedCaptures();
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.filter((item) => item.id !== id) });
};

const saveToNube = async (payload, options = {}) => {
  const { endpoint, token, authMode } = await readSettings();
  const useSession = authMode !== "token";
  let response = useSession ? await fetch(sessionEndpointFrom(endpoint), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }) : null;
  if ((!response || response.status === 401 || response.status === 403) && token) {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  }
  if (!response) throw new Error("Sign in to Nube or add a fallback integration token.");
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Nube returned ${response.status}`);
  }
  const data = await response.json();
  if (!options.skipFlush) void flushQueue();
  return data;
};

const sessionHeaders = async () => {
  const { token, authMode } = await readSettings();
  return authMode === "token" && token ? { Authorization: `Bearer ${token}` } : {};
};

const fetchRecentCaptures = async () => {
  const { endpoint, token, authMode } = await readSettings();
  const base = apiBaseFromEndpoint(endpoint);
  let response = authMode !== "token" ? await fetch(`${base}/api/captures/recent?limit=3`, {
    credentials: "include",
    headers: await sessionHeaders(),
  }) : null;
  if ((!response || response.status === 401 || response.status === 403) && token) {
    response = await fetch(`${base}/api/captures/recent?limit=3`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (!response?.ok) throw new Error("Recent captures unavailable.");
  return response.json();
};

const readExtensionSession = async () => {
  const { endpoint } = await readSettings();
  const response = await fetch(`${apiBaseFromEndpoint(endpoint)}/api/extension/session`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error("Nube session unavailable.");
  return response.json();
};

const flushQueue = async () => {
  const queue = await queuedCaptures();
  for (const item of queue) {
    try {
      await saveToNube(item.payload, { skipFlush: true });
      await removeQueuedCapture(item.id);
    } catch {
      return false;
    }
  }
  return true;
};

const captureVisibleScreenshot = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || /^(chrome|edge|about|devtools):\/\//i.test(tab.url)) {
    throw new Error("Chrome does not allow screenshots on this page. Try a normal website tab.");
  }
  const windowId = tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
  const dataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || "Screenshot permission was blocked."));
        return;
      }
      if (!result) {
        reject(new Error("No screenshot was returned by Chrome."));
        return;
      }
      resolve(result);
    });
  });
  return {
    id: `screenshot-${Date.now()}`,
    name: `nube-screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    size: Math.round((dataUrl.length * 3) / 4),
    mimeType: "image/png",
    dataUrl,
  };
};

const setBadge = (tabId, text, color, delay = 1800) => {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), delay);
};

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const pageUrl = info.pageUrl || tab?.url || "";
  const pageTitle = tab?.title || "Browser capture";
  const payloads = {
    "nube-save-page": {
      title: pageTitle,
      text: `Saved page: ${pageUrl}`,
      url: pageUrl,
      type: "Link",
      kind: "page",
      source: "browser extension",
      tags: ["Browser", "Page"],
    },
    "nube-save-selection": {
      title: `Selection from ${pageTitle}`,
      text: info.selectionText || pageUrl,
      url: pageUrl,
      type: "Link",
      kind: "selection",
      source: "browser extension",
      tags: ["Browser", "Selection"],
    },
    "nube-save-link": {
      title: info.linkText || pageTitle,
      text: `Saved link: ${info.linkUrl}`,
      url: info.linkUrl || pageUrl,
      type: "Link",
      kind: "link",
      source: "browser extension",
      tags: ["Browser", "Link"],
    },
    "nube-save-image": {
      title: `Image from ${pageTitle}`,
      text: `Saved image: ${info.srcUrl}`,
      url: info.srcUrl || pageUrl,
      type: "Link",
      kind: "image",
      source: "browser extension",
      tags: ["Browser", "Image"],
    },
  };

  saveToNube(payloads[info.menuItemId])
    .then((result) => setBadge(tab?.id, result.duplicate ? "Dup" : "OK", result.duplicate ? "#f59e0b" : "#6366f1"))
    .catch(async () => {
      await queueCapture(payloads[info.menuItemId]);
      setBadge(tab?.id, "Q", "#f59e0b", 2200);
    });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SAVE_TO_NUBE") {
    saveToNube(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch(async (error) => {
        const queued = await queueCapture(message.payload);
        sendResponse({ ok: false, queued, error: `${error.message} Saved to offline queue.` });
      });
    return true;
  }
  if (message?.type === "CAPTURE_SCREENSHOT") {
    captureVisibleScreenshot()
      .then((attachment) => sendResponse({ ok: true, attachment }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_RECENT_CAPTURES") {
    Promise.all([fetchRecentCaptures(), queuedCaptures()])
      .then(([data, queue]) => sendResponse({ ok: true, captures: data.captures ?? data, queued: queue.length }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "FLUSH_QUEUE") {
    flushQueue()
      .then((ok) => sendResponse({ ok }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_EXTENSION_SESSION") {
    readExtensionSession()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
