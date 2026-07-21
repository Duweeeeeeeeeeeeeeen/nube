const DEFAULT_ENDPOINT = "http://127.0.0.1:5174/api/integrations/webhook/capture";
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;

const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const authModeInput = document.querySelector("#authMode");
const accountStatus = document.querySelector("#accountStatus");
const noteInput = document.querySelector("#note");
const status = document.querySelector("#status");
const includePageInput = document.querySelector("#includePage");
const fullArticleInput = document.querySelector("#fullArticle");
const filesInput = document.querySelector("#files");
const fileSummary = document.querySelector("#fileSummary");
const duePresetInput = document.querySelector("#duePreset");
const priorityInput = document.querySelector("#priority");
const starredInput = document.querySelector("#starred");
const recentList = document.querySelector("#recentList");
const templateButtons = Array.from(document.querySelectorAll("[data-template]"));
const modeButtons = {
  note: document.querySelector("#modeNote"),
  page: document.querySelector("#modePage"),
  selection: document.querySelector("#modeSelection"),
};

let captureMode = "note";
let template = "auto";
let selectedFiles = [];
let extraAttachments = [];

const templateConfig = {
  auto: { type: "", tags: [], placeholder: "Write a note, task, place, reminder, or anything to remember..." },
  task: { type: "Actionable", tags: ["Task"], placeholder: "What needs to be done?" },
  idea: { type: "Idea", tags: ["Idea"], placeholder: "Capture the idea before it disappears..." },
  expense: { type: "Expense", tags: ["Expense"], placeholder: "What did you spend or receive?" },
  place: { type: "Place", tags: ["Place"], placeholder: "Restaurant, shop, city, address, or place to try..." },
  document: { type: "Document", tags: ["Document"], placeholder: "What file, receipt, contract, or resource is this?" },
};

const setStatus = (message, tone = "neutral") => {
  status.textContent = message;
  status.dataset.tone = tone;
};

const apiBase = () => (endpointInput.value.trim() || DEFAULT_ENDPOINT).replace(/\/api\/integrations\/webhook\/capture\/?$/, "");

const setMode = (mode) => {
  captureMode = mode;
  Object.entries(modeButtons).forEach(([key, button]) => button.classList.toggle("active", key === mode));
  includePageInput.checked = mode !== "note";
  fullArticleInput.disabled = mode === "note" && !includePageInput.checked;
};

const setTemplate = (nextTemplate) => {
  template = nextTemplate;
  templateButtons.forEach((button) => button.classList.toggle("active", button.dataset.template === template));
  noteInput.placeholder = templateConfig[template]?.placeholder ?? templateConfig.auto.placeholder;
};

const activeTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const isRestrictedUrl = (url = "") => /^(chrome|edge|about|devtools):\/\//i.test(url);

const executeInTab = async (tabId, func) => {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func });
  return result?.result || "";
};

const getSelectionText = async (tabId) => executeInTab(tabId, () => window.getSelection()?.toString() || "");

const getReadableText = async (tabId) => executeInTab(tabId, () => {
  const article = document.querySelector("article") || document.querySelector("main") || document.body;
  return (article?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 12000);
});

const saveSettings = async () => {
  await chrome.storage.sync.set({
    endpoint: endpointInput.value.trim() || DEFAULT_ENDPOINT,
    token: tokenInput.value.trim(),
    authMode: authModeInput.value,
  });
};

const fileToAttachment = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    resolve({
      id: `ext-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      dataUrl: reader.result,
    });
  });
  reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}.`)));
  reader.readAsDataURL(file);
});

const readAttachments = async () => {
  const files = Array.from(selectedFiles);
  const tooLarge = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
  if (tooLarge) throw new Error(`${tooLarge.name} is larger than 6 MB.`);
  return [...extraAttachments, ...(await Promise.all(files.map(fileToAttachment)))];
};

const summarizeFiles = () => {
  const total = selectedFiles.length + extraAttachments.length;
  if (!total) {
    fileSummary.textContent = "No attachments";
    return;
  }
  const totalKb = Math.max(1, Math.round((selectedFiles.reduce((sum, file) => sum + file.size, 0) + extraAttachments.reduce((sum, item) => sum + item.size, 0)) / 1024));
  fileSummary.textContent = `${total} attached - ${totalKb} KB`;
};

const dueFromPreset = () => {
  const now = new Date();
  if (duePresetInput.value === "today") return now.toISOString();
  if (duePresetInput.value === "tomorrow") {
    now.setDate(now.getDate() + 1);
    return now.toISOString();
  }
  if (duePresetInput.value === "weekend") {
    const day = now.getDay();
    const daysUntilSaturday = (6 - day + 7) % 7 || 7;
    now.setDate(now.getDate() + daysUntilSaturday);
    now.setHours(10, 0, 0, 0);
    return now.toISOString();
  }
  return null;
};

const sendCapture = async (payload) => {
  setStatus("Sending to Nube...");
  const response = await chrome.runtime.sendMessage({ type: "SAVE_TO_NUBE", payload });
  if (!response?.ok) {
    setStatus(response?.queued ? `Queued offline (${response.queued}).` : response?.error || "Could not reach Nube.", response?.queued ? "warning" : "error");
    renderRecent();
    return Boolean(response?.queued);
  }
  setStatus(response.data?.duplicate ? "Already saved in Nube." : "Saved to Nube.", response.data?.duplicate ? "warning" : "success");
  renderRecent();
  return true;
};

const inferTitle = (note, attachments, tab, selection) => {
  if (selection) return `Selection from ${tab?.title || "page"}`;
  if (note) return note.split(/\n|[.!?]/).find(Boolean)?.trim().slice(0, 90) || "Quick note";
  if (captureMode === "page" && tab?.title) return tab.title;
  if (attachments.length === 1) return attachments[0].name;
  if (attachments.length > 1) return `${attachments.length} attachments`;
  return "Quick note";
};

const buildPayload = async () => {
  const tab = await activeTab();
  const note = noteInput.value.trim();
  const attachments = await readAttachments();
  const shouldIncludePage = includePageInput.checked || captureMode === "page" || captureMode === "selection";
  if ((captureMode === "selection" || fullArticleInput.checked) && isRestrictedUrl(tab?.url)) {
    throw new Error("Chrome blocks page access here. Try this on a normal website tab.");
  }
  const selection = captureMode === "selection" && tab?.id ? await getSelectionText(tab.id) : "";
  const articleText = fullArticleInput.checked && shouldIncludePage && tab?.id ? await getReadableText(tab.id) : "";
  const url = shouldIncludePage ? tab?.url || "" : "";
  const textParts = [];
  if (selection) textParts.push(selection);
  if (note) textParts.push(note);
  if (articleText && !selection) textParts.push(`Page text:\n${articleText}`);
  if (!textParts.length && captureMode === "page" && url) textParts.push(`Saved page: ${url}`);
  if (!textParts.length && attachments.length) textParts.push(`Attached ${attachments.length} file${attachments.length === 1 ? "" : "s"}.`);
  if (!textParts.length) throw new Error("Write a note, include a page, select text, or attach a file.");

  const kind = captureMode === "selection" && selection ? "selection" : captureMode === "page" ? "page" : attachments.length ? "attachment" : "note";
  const tags = Array.from(new Set(["Browser", ...(templateConfig[template]?.tags ?? []), kind === "note" ? "Note" : null, kind === "attachment" ? "Attachment" : null, kind === "page" ? "Page" : null, kind === "selection" ? "Selection" : null].filter(Boolean)));
  const templateType = templateConfig[template]?.type;

  return {
    title: inferTitle(note, attachments, tab, selection),
    text: textParts.join("\n\n"),
    url,
    type: templateType || (url ? "Link" : attachments.length ? "Document" : "Note"),
    kind,
    source: "browser extension",
    tags,
    attachments,
    due: dueFromPreset(),
    priority: priorityInput.value,
    starred: starredInput.checked,
  };
};

const renderRecent = async () => {
  const response = await chrome.runtime.sendMessage({ type: "GET_RECENT_CAPTURES" });
  if (!response?.ok) {
    recentList.innerHTML = `<p>${response?.error || "Recent captures unavailable."}</p>`;
    return;
  }
  const captures = Array.isArray(response.captures) ? response.captures.slice(0, 3) : [];
  const queueLine = response.queued ? `<p class="queue-line">${response.queued} waiting to sync</p>` : "";
  recentList.innerHTML = `${queueLine}${captures.length ? captures.map((capture) => `<article><strong>${capture.title || "Untitled"}</strong><span>${capture.type || "Capture"}</span></article>`).join("") : "<p>No recent captures yet.</p>"}`;
};

const renderAccountStatus = async () => {
  const response = await chrome.runtime.sendMessage({ type: "GET_EXTENSION_SESSION" });
  if (response?.ok && response.data?.signedIn) {
    accountStatus.textContent = `Signed in as ${response.data.user?.email || "Nube user"}`;
    accountStatus.dataset.tone = "success";
    return;
  }
  accountStatus.textContent = authModeInput.value === "token" ? "Using fallback token mode." : "Open Nube and sign in to use account session.";
  accountStatus.dataset.tone = authModeInput.value === "token" ? "warning" : "neutral";
};

document.querySelector("#saveSettings").addEventListener("click", async () => {
  await saveSettings();
  await chrome.runtime.sendMessage({ type: "FLUSH_QUEUE" });
  setStatus("Settings saved.", "success");
  renderRecent();
});

document.querySelector("#saveCapture").addEventListener("click", async () => {
  try {
    await saveSettings();
    const saved = await sendCapture(await buildPayload());
    if (saved) {
      noteInput.value = "";
      filesInput.value = "";
      selectedFiles = [];
      extraAttachments = [];
      summarizeFiles();
    }
  } catch (error) {
    setStatus(error.message || "Could not create capture.", "error");
  }
});

document.querySelector("#clearCapture").addEventListener("click", () => {
  noteInput.value = "";
  filesInput.value = "";
  selectedFiles = [];
  extraAttachments = [];
  duePresetInput.value = "";
  priorityInput.value = "Medium";
  starredInput.checked = false;
  summarizeFiles();
  setMode("note");
  setTemplate("auto");
  setStatus("Ready.");
});

document.querySelector("#captureScreenshot").addEventListener("click", async () => {
  setStatus("Capturing screenshot...");
  const response = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
  if (!response?.ok) {
    setStatus(response?.error || "Could not capture screenshot.", "error");
    return;
  }
  extraAttachments.push(response.attachment);
  summarizeFiles();
  setStatus("Screenshot attached.", "success");
});

document.querySelector("#openNube").addEventListener("click", () => {
  chrome.tabs.create({ url: apiBase() });
});

modeButtons.note.addEventListener("click", () => setMode("note"));
modeButtons.page.addEventListener("click", () => setMode("page"));
modeButtons.selection.addEventListener("click", () => setMode("selection"));
templateButtons.forEach((button) => button.addEventListener("click", () => setTemplate(button.dataset.template)));

includePageInput.addEventListener("change", () => {
  fullArticleInput.disabled = !includePageInput.checked && captureMode === "note";
});

filesInput.addEventListener("change", () => {
  selectedFiles = Array.from(filesInput.files || []);
  summarizeFiles();
});

chrome.storage.sync.get(["endpoint", "token", "authMode"], (settings) => {
  endpointInput.value = settings.endpoint || DEFAULT_ENDPOINT;
  tokenInput.value = settings.token || "";
  authModeInput.value = settings.authMode || "session";
  renderAccountStatus();
  renderRecent();
});

summarizeFiles();
setMode("note");
authModeInput.addEventListener("change", () => {
  void saveSettings();
  void renderAccountStatus();
});
