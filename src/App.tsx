import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Archive,
  AlertTriangle,
  ArrowUp,
  Bell,
  BookOpen,
  Brain,
  Briefcase,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Cloud,
  Code2,
  ExternalLink,
  HeartPulse,
  Home,
  Image,
  Inbox,
  Lightbulb,
  ListTodo,
  Link2,
  Lock,
  Mail,
  MapPin,
  Maximize2,
  MessageCircle,
  Mic,
  NotebookText,
  Pause,
  Plane,
  Play,
  Pencil,
  Plus,
  Puzzle,
  RotateCcw,
  RotateCw,
  ReceiptText,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Upload,
  User,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { syncQueue, type SyncQueueSnapshot } from "./syncQueue";
import "./App.css";

const TRASH_RETENTION_DAYS = 15;

type View = "Inbox" | "Collections" | "Settings" | "Upgrade";
type CaptureType = "Actionable" | "Idea" | "Expense" | "Place" | "Document" | "Audio" | "Health" | "Home" | "Study" | "Work" | "Travel" | "Person" | "Journal" | "Link";
type Priority = "Low" | "Medium" | "High";

type PlaceDetails = {
  provider: "google-places";
  placeId: string;
  name: string;
  address: string | null;
  mapsUrl: string | null;
  rating: number | null;
  photoUrl: string | null;
};

type Capture = {
  id: number;
  title: string;
  text: string;
  type: CaptureType;
  source: string;
  time: string;
  metadata: string[];
  createdAt: string;
  completed?: boolean;
  archived?: boolean;
  deletedAt?: string;
  checklistItems?: ChecklistItem[];
  private?: boolean;
  privateEncryptedData?: PrivateEncryptedData;
  privateEncryptedAt?: string;
  due?: string;
  taskStartTime?: string;
  taskEndTime?: string;
  repeatDays?: number[];
  priority?: Priority;
  starred?: boolean;
  suggestedAction?: string;
  provider?: "openai" | "openrouter" | "google" | "local-fallback" | "browser-fallback";
  confidence?: number;
  place?: PlaceDetails;
  imageUrl?: string;
  attachmentName?: string;
  attachmentSize?: number;
  attachments?: Attachment[];
  calendar?: {
    provider?: string;
    eventId?: string;
    htmlLink?: string;
    start?: string;
    end?: string | null;
    location?: string | null;
  };
  external?: {
    source?: string | null;
    url?: string | null;
    rawType?: string | null;
  };
};

type PrivateEncryptedData = {
  version: 1;
  salt: string;
  iv: string;
  data: string;
};

type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

type Attachment = {
  id: string;
  name: string;
  title?: string;
  mimeType: string;
  dataUrl?: string;
  size: number;
};

type AiClassification = {
  title: string;
  summary: string;
  type: CaptureType;
  metadata: string[];
  due: string | null;
  priority?: Priority;
  suggestedAction: string;
  confidence: number;
  provider?: "openai" | "openrouter" | "google" | "local-fallback";
};

const stripHeavyCaptureData = (capture: Capture): Capture => {
  const masked = maskPrivateCaptureForStorage(capture);
  return {
    ...masked,
    imageUrl: masked.imageUrl?.startsWith("data:") ? undefined : masked.imageUrl,
    attachments: masked.attachments?.map((attachment) => attachment.mimeType.startsWith("audio/") ? attachment : { ...attachment, dataUrl: undefined }),
  };
};

const sanitizeLocalCapture = (capture: Capture): Capture => (
  {
    ...capture,
    metadata: visibleCaptureTags(capture.metadata ?? []),
    text: capture.source === "google calendar" || capture.calendar?.provider
      ? String(capture.text ?? "").replace(/(?:^|\n)\s*Ends:\s*[^\n]+/gi, "").replace(/\s*Ends:\s*\d{4}-\d{2}-\d{2}T\S+/gi, "").trim()
      : capture.text,
  }
);

const isBirthdayCalendarCapture = (capture: Capture) => (
  capture.source === "google calendar" &&
  /^(buon compleanno!?|happy birthday!?)/i.test(capture.title.trim())
);

const purgeExpiredTrash = (captures: Capture[]) => {
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return captures.filter((capture) => {
    if (!capture.deletedAt) return true;
    const deletedTime = new Date(capture.deletedAt).getTime();
    return Number.isNaN(deletedTime) || deletedTime >= cutoff;
  });
};

const trashExpiryLabel = (capture: Capture) => {
  if (!capture.deletedAt) return "";
  const deletedTime = new Date(capture.deletedAt).getTime();
  if (Number.isNaN(deletedTime)) return `Deletes after ${TRASH_RETENTION_DAYS} days`;
  const expiresAt = deletedTime + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const daysLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
  if (daysLeft <= 0) return "Deletes today";
  if (daysLeft === 1) return "Deletes tomorrow";
  return `Deletes in ${daysLeft} days`;
};

const readStoredCaptures = () => {
  try {
    const saved = localStorage.getItem("nube-second-brain-rebuilt");
    const captures = saved ? JSON.parse(saved) as Capture[] : initialCaptures;
    return purgeExpiredTrash(captures).filter((capture) => !isBirthdayCalendarCapture(capture)).map(sanitizeLocalCapture);
  } catch {
    localStorage.removeItem("nube-second-brain-rebuilt");
    return initialCaptures;
  }
};

const writeStoredCaptures = (captures: Capture[]) => {
  try {
    localStorage.removeItem("nube-second-brain-rebuilt");
    localStorage.setItem("nube-second-brain-rebuilt", JSON.stringify(purgeExpiredTrash(captures).filter((capture) => !isBirthdayCalendarCapture(capture)).map(maskPrivateCaptureForStorage).map(sanitizeLocalCapture).map(stripHeavyCaptureData)));
  } catch {
    localStorage.removeItem("nube-second-brain-rebuilt");
  }
};

type IngestResult = {
  filename: string;
  mimeType: string;
  size: number;
  storage?: "local" | "cloudflare-r2";
  fileKey?: string | null;
  fileUrl?: string | null;
  kind: "pdf" | "text" | "image" | "binary";
  pages: number | null;
  extractedText: string;
  classification: AiClassification;
};

type QueuedUpload = {
  id: string;
  captureId: number;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  retries: number;
  nextAttemptAt?: number;
  createdAt: string;
};

type MoneySignal = {
  id: number;
  key: string;
  title: string;
  amount: number;
  currency: string;
  direction: "income" | "expense" | "review";
  reason: string;
};

type AiReview = {
  headline: string;
  focus: string;
  nextActions: string[];
  patterns: string[];
  risks: string[];
  provider: "google" | "local-fallback";
  warning?: string;
};

type AskNubeResponse = {
  answer: string;
  related: { id: number; title: string; type: CaptureType }[];
  provider: "google" | "local-fallback";
};

type Profile = {
  name: string;
  avatar: string;
  avatarUrl?: string;
  email?: string;
  authProvider?: "google" | "local";
  city: string;
  locationLabel?: string;
  latitude?: number;
  longitude?: number;
  currency: "EUR" | "USD" | "GBP";
};

type AuthUser = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  picture?: string;
  profile?: Partial<Profile> | null;
  provider: "google";
  calendarConnected?: boolean;
};

type ActivityEvent = {
  id: string;
  time: string;
  level: "info" | "success" | "warning" | "error";
  source: string;
  title: string;
  detail: string;
  captureId?: number | null;
};

type ImportBatch = {
  id: string;
  createdAt: string;
  provider: string;
  title: string;
  detail: string;
  captureIds: number[];
  count: number;
  skipped: number;
};

type CloudSyncInfo = {
  signedIn: boolean;
  cloudConfigured: boolean;
  cloudReady: boolean;
  localCaptures: number;
  cloudCaptures: number;
  storage: string;
};

type BillingStatus = {
  configured: boolean;
  signedIn: boolean;
  currentPlan: "free" | "personal" | "pro";
  billing?: { plan?: string; status?: string; interval?: string };
  plans?: Record<"free" | "personal" | "pro", PlanLimit>;
};

type PlanLimit = {
  id: "free" | "personal" | "pro";
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  storageGb: number;
  capturesPerMonth: number | null;
  maxUploadMb: number;
  aiClassificationsPerMonth: number | null;
  askNubePerMonth: number | null;
  voiceMinutesPerMonth: number | null;
  ocr: boolean;
  cloudSync: boolean;
  gmailImport: boolean;
  calendarImport: boolean;
  browserExtension: boolean;
  developerApi: boolean;
};

type CollectionFilter = { title: string; types: CaptureType[] } | null;
type DateFilter = { day: string; label: string } | null;
type PluginSettings = {
  smartReminders: boolean;
  dueDates: boolean;
  highPriority: boolean;
  dailyReview: boolean;
  receiptScanner: boolean;
  receiptMoneySignals: boolean;
  receiptImageReview: boolean;
  privacyGuard: boolean;
  privacySensitiveText: boolean;
  privacyFileWarnings: boolean;
};

const defaultPluginSettings: PluginSettings = {
  smartReminders: true,
  dueDates: true,
  highPriority: true,
  dailyReview: true,
  receiptScanner: false,
  receiptMoneySignals: true,
  receiptImageReview: true,
  privacyGuard: false,
  privacySensitiveText: true,
  privacyFileWarnings: true,
};

const defaultProfile: Profile = {
  name: "Manuel",
  avatar: "M",
  authProvider: "local",
  city: "Ferrara",
  locationLabel: "Ferrara, Italy",
  currency: "EUR",
};

const fallbackPlanCatalog: Record<"free" | "personal" | "pro", PlanLimit> = {
  free: { id: "free", name: "Free", monthlyPrice: 0, annualPrice: 0, storageGb: 1, capturesPerMonth: 100, maxUploadMb: 5, aiClassificationsPerMonth: 50, askNubePerMonth: 10, voiceMinutesPerMonth: 15, ocr: false, cloudSync: false, gmailImport: false, calendarImport: true, browserExtension: true, developerApi: false },
  personal: { id: "personal", name: "Personal", monthlyPrice: 8, annualPrice: 79, storageGb: 20, capturesPerMonth: null, maxUploadMb: 25, aiClassificationsPerMonth: 2000, askNubePerMonth: 300, voiceMinutesPerMonth: 300, ocr: true, cloudSync: true, gmailImport: true, calendarImport: true, browserExtension: true, developerApi: false },
  pro: { id: "pro", name: "Pro", monthlyPrice: 15, annualPrice: 149, storageGb: 100, capturesPerMonth: null, maxUploadMb: 100, aiClassificationsPerMonth: 10000, askNubePerMonth: 1500, voiceMinutesPerMonth: 1500, ocr: true, cloudSync: true, gmailImport: true, calendarImport: true, browserExtension: true, developerApi: true },
};
const AI_BOT_OFFLINE = true;

const initialCaptures: Capture[] = [
  {
    id: 1,
    title: "Welcome to Nube",
    text: "This is your first capture. Write, speak, upload images, save links, or drop documents into the inbox. Nube classifies the capture, suggests tags, detects dates, finds places, and keeps everything searchable. You can edit this capture, change its tags and priority, attach files, or delete it when you are ready.",
    type: "Document",
    source: "system tutorial",
    time: "Just now",
    metadata: ["Tutorial", "Inbox", "Editable", "Nube basics"],
    createdAt: new Date().toISOString(),
    suggestedAction: "Try adding a real capture from the input above.",
  },
];

const collectionOrder: CaptureType[] = ["Actionable", "Idea", "Expense", "Place", "Document", "Audio", "Person", "Study", "Work", "Health", "Home", "Travel", "Journal", "Link"];
const presetTags = ["Tutorial", "Inbox", "Editable", "Important", "Work", "Personal", "Receipt", "Place", "Idea", "Follow up"];
const fileMetadataTags = new Set(["Image upload", "File indexed", "Cloud file", "Local file"]);
const systemMetadataTags = new Set(["Webhook", "browser extension", "Browser", "Selection", "Page"]);
const isFileSizeTag = (tag: string) => /^\d+(?:\.\d+)?\s?(?:B|KB|MB|GB)$/i.test(tag.trim());
const visibleCaptureTags = (tags: string[]) => {
  const hiddenTags = new Set([...fileMetadataTags, ...systemMetadataTags].map((tag) => tag.toLowerCase()));
  const cleaned = tags.map((tag) => tag.trim()).filter((tag) => tag && !hiddenTags.has(tag.toLowerCase()) && !isFileSizeTag(tag));
  const lowerSet = new Set(cleaned.map((tag) => tag.toLowerCase()));
  const hasVoice = lowerSet.has("voice note") || lowerSet.has("audio");
  const hasGoogleCalendar = lowerSet.has("google calendar");
  const hasWebPage = lowerSet.has("web page") || lowerSet.has("saved link") || lowerSet.has("link");
  const hasGmail = lowerSet.has("gmail");
  const topicAliases: Record<string, string> = {
    "google calendar": "Google Calendar",
    "calendar import": "Calendar",
    calendar: "Calendar",
    "web pages": "Web page",
    "web page": "Web page",
    webpage: "Web page",
    browser: "Web page",
    page: "Web page",
    selection: "Web page",
    "saved link": "Web page",
    link: "Web page",
    "task note": "Note",
    note: "Note",
    unicode: "Text tool",
    "text generator": "Text tool",
    generator: "Text tool",
    "copy paste": "Copy paste",
    "social media": "Social media",
    api: "API",
    weather: "Weather",
    gmail: "Gmail",
    attachment: "Attachment",
    "voice note": "Voice note",
    audio: "Audio",
  };
  const redundantWithWebPage = new Set(["Browser", "Selection", "Page", "Saved link", "Link"]);
  const noisyWithWebPage = new Set(["API", "Weather", "Text tool", "Generator", "Copy paste", "Social media", "Unicode", "Browser", "Selection", "Page", "Note"]);
  const redundantWithGoogleCalendar = new Set(["Calendar", "Calendar import"]);
  const redundantWithGmail = new Set(["Email", "Mail"]);
  const unique = new Map<string, string>();
  cleaned.forEach((tag) => {
    const lower = tag.toLowerCase();
    const normalized = topicAliases[lower] ?? tag;
    if (hasVoice && normalized === "Audio") return;
    if (hasGoogleCalendar && redundantWithGoogleCalendar.has(normalized)) return;
    if (hasWebPage && redundantWithWebPage.has(normalized)) return;
    if (hasWebPage && noisyWithWebPage.has(normalized)) return;
    if (hasGmail && redundantWithGmail.has(normalized)) return;
    const key = normalized.toLowerCase();
    if (!unique.has(key)) unique.set(key, normalized);
  });
  const priority = ["Google Calendar", "Gmail", "Web page", "Voice note", "Attachment", "Calendar", "Place", "Expense", "Actionable", "Idea", "Document", "Study", "Work", "Health", "Home", "Travel", "Person", "Journal", "API", "Weather"];
  return Array.from(unique.values())
    .sort((a, b) => {
      const aIndex = priority.indexOf(a);
      const bIndex = priority.indexOf(b);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    })
    .slice(0, 4);
};
const formatFileSize = (bytes?: number) => {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};
const fileSizeLabelFor = (capture: Capture) => formatFileSize(capture.attachmentSize) || capture.metadata.find(isFileSizeTag) || "";
const estimateStorageBytes = (captures: Capture[]) => captures.reduce((total, capture) => {
  const attached = capture.attachmentSize ?? capture.attachments?.reduce((sum, attachment) => sum + attachment.size, 0) ?? 0;
  const textBytes = new Blob([capture.title, capture.text, capture.metadata.join(" ")]).size;
  return total + attached + textBytes;
}, 0);
const formatStorageUsage = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};
const tagPalette = ["#6366f1", "#0f9f6e", "#e28700", "#dc2626", "#0891b2", "#7c3aed", "#be185d", "#4b5563"];
const priorityColor = (priority?: Priority) => ({ Low: "#0f9f6e", Medium: "#e28700", High: "#dc2626" })[priority ?? "Medium"];
const priorityScore = (priority?: Priority) => priority ? ({ Low: 1, Medium: 2, High: 3 })[priority] : 0;
const hashPrivatePin = (pin: string) => Array.from(pin).reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0).toString(36);
const bytesToBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const privateCryptoReady = () => typeof crypto !== "undefined" && Boolean(crypto.subtle);
const derivePrivateKey = async (pin: string, salt: Uint8Array) => {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer, iterations: 180_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};
const privatePayloadFor = (capture: Capture) => ({
  title: capture.title,
  text: capture.text,
  metadata: capture.metadata,
  checklistItems: capture.checklistItems,
  place: capture.place,
  imageUrl: capture.imageUrl,
  attachmentName: capture.attachmentName,
  attachmentSize: capture.attachmentSize,
  attachments: capture.attachments,
  calendar: capture.calendar,
  external: capture.external,
  suggestedAction: capture.suggestedAction,
  provider: capture.provider,
  confidence: capture.confidence,
});
const encryptPrivatePayload = async (capture: Capture, pin: string): Promise<PrivateEncryptedData> => {
  if (!privateCryptoReady()) throw new Error("Private encryption is not available in this browser.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePrivateKey(pin, salt);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(privatePayloadFor(capture))));
  return { version: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
};
const decryptPrivatePayload = async (encrypted: PrivateEncryptedData, pin: string): Promise<Partial<Capture>> => {
  if (!privateCryptoReady()) throw new Error("Private encryption is not available in this browser.");
  const key = await derivePrivateKey(pin, base64ToBytes(encrypted.salt));
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(encrypted.iv) }, key, base64ToBytes(encrypted.data));
  return JSON.parse(new TextDecoder().decode(decrypted)) as Partial<Capture>;
};
const maskPrivateCaptureForStorage = (capture: Capture): Capture => capture.private && capture.privateEncryptedData ? ({
  ...capture,
  title: "Private capture",
  text: "",
  metadata: [],
  checklistItems: undefined,
  place: undefined,
  imageUrl: undefined,
  attachmentName: undefined,
  attachmentSize: undefined,
  attachments: undefined,
  calendar: undefined,
  external: undefined,
  suggestedAction: undefined,
  provider: undefined,
  confidence: undefined,
}) : capture;
const inferPriorityFromText = (text: string): Priority | undefined => {
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\b(urgent|high priority|high|important|deadline|asap|urgente|importante|alta priorita|priorita alta|priorità alta|alta)\b/.test(lower)) return "High";
  if (/\b(low priority|low|when possible|not urgent|bassa priorita|bassa priorità|priorita bassa|priorità bassa|non urgente|bassa)\b/.test(lower)) return "Low";
  if (/\b(medium priority|normal priority|medium|med|priorita media|priorità media|media)\b/.test(lower)) return "Medium";
  return undefined;
};
const rankCaptures = (items: Capture[]) => [...items].sort((a, b) =>
  Number(Boolean(a.completed)) - Number(Boolean(b.completed))
  || Number(Boolean(b.starred)) - Number(Boolean(a.starred))
  || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
);
const compactTitle = (text: string, fallback = "Untitled capture") => {
  const firstLine = text.replace(/\s+/g, " ").trim().split(/[.!?\n]/)[0]?.trim() ?? "";
  if (!firstLine) return fallback;
  return firstLine.length > 52 ? `${firstLine.slice(0, 52)}...` : firstLine;
};
const splitCaptureText = (text: string, fallback = "Untitled capture") => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lineBreakParts = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  if (lineBreakParts.length > 1) return { title: compactTitle(lineBreakParts[0], fallback), body: lineBreakParts.slice(1).join("\n") };
  const commaParts = normalized.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaParts.length > 1 && commaParts[0].length <= 64) return { title: compactTitle(commaParts[0], fallback), body: commaParts.slice(1).join(", ") };
  return { title: compactTitle(normalized, fallback), body: normalized.length > 72 ? normalized : "" };
};

const extractListItems = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const afterColon = normalized.includes(":") ? normalized.split(":").slice(1).join(":") : normalized;
  const afterIntent = afterColon
    .replace(/^(fare\s+la\s+spesa|lista\s+spesa|shopping\s+list|grocery\s+list)\s*(oggi|domani|today|tomorrow)?\s*,?\s*/i, "")
    .replace(/^(comprare|buy|porta(?:re)?|portare|pack|metti(?:mi)?|ricordami(?:\s+di)?)\s+/i, "");
  const cleaned = afterIntent.replace(/\b(oggi|domani|today|tomorrow|mercoledi|mercoledì|wednesday)\b/gi, "").trim();
  const pieces = cleaned
    .split(/[,;\n]+|\s+-\s+/)
    .map((item) => item.replace(/^(and|e|poi|also|anche|comprare|buy|portare|porta)\s+/i, "").trim())
    .filter((item) => item.length > 1 && !/^(mi|me|i|io|devo|need|ho bisogno|voglio|want|fare la spesa|shopping list|lista spesa)$/i.test(item))
    .slice(0, 18);
  return Array.from(new Set(pieces));
};

const simpleTranslate = (text: string, target: "english" | "italian") => {
  const dictionary: Record<string, string> = target === "english"
    ? {
      "fare la spesa": "go grocery shopping",
      "comprare": "buy",
      "latte": "milk",
      "biscotti": "cookies",
      "carne": "meat",
      "sale": "salt",
      "zucchero": "sugar",
      "pepe": "pepper",
      "devo tornare a casa": "I have to go back home",
      "valigia": "suitcase",
      "mercoledi": "Wednesday",
      "mercoledì": "Wednesday",
    }
    : {
      "go grocery shopping": "fare la spesa",
      "buy": "comprare",
      "milk": "latte",
      "cookies": "biscotti",
      "meat": "carne",
      "salt": "sale",
      "sugar": "zucchero",
      "pepper": "pepe",
      "i have to go back home": "devo tornare a casa",
      "suitcase": "valigia",
      "wednesday": "mercoledì",
    };
  return Object.entries(dictionary).reduce((current, [from, to]) => current.replace(new RegExp(from, "gi"), to), text);
};

type IntentCapture = Partial<Capture> & { extraDueDates?: string[] };

const taskTitleFromText = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const beforeTiming = normalized
    .split(/\s*,?\s*(?:segna che|ricordamelo|mettimela|mettil[ao]|queste sono|cose che devo fare|dalle|from)\b/i)[0]
    ?.trim() ?? normalized;
  const cleaned = beforeTiming
    .replace(/^(?:devo|devi|mi serve di|ricordami di|ricorda di|ho bisogno di|i need to|need to|i have to)\s+/i, "")
    .replace(/^(?:scrivere|fare|preparare|comprare|studiare)\s+/i, (match) => match.trim().toLowerCase() === "scrivere" ? "" : match)
    .replace(/^(?:la|il|lo|le|gli|i|un|una|the|a)\s+/i, "")
    .trim();
  return compactTitle(cleaned || beforeTiming, "Task").replace(/^./, (letter) => letter.toUpperCase());
};

const buildIntentCapture = (text: string, source: string, fallbackType: CaptureType): IntentCapture | null => {
  const lower = text.toLowerCase();
  const normalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const asksEnglish = /\b(in english|translate.*english|traduci.*inglese|in inglese)\b/.test(normalized);
  const asksItalian = /\b(in italian|translate.*italian|traduci.*italiano|in italiano)\b/.test(normalized);
  const isTranslation = asksEnglish || asksItalian;
  if (isTranslation) {
    const content = text.replace(/traduci(?:mi)?|translate|in inglese|in english|in italiano|in italian/gi, "").replace(/[:\-]/g, " ").trim();
    const target = asksEnglish ? "english" : "italian";
    const translated = simpleTranslate(content || text, target);
    return {
      title: `Translate to ${target === "english" ? "English" : "Italian"}`,
      text: `Original:\n${content || text}\n\n${target === "english" ? "English" : "Italian"}:\n${translated}`,
      type: "Document" as CaptureType,
      metadata: ["Translation", target === "english" ? "English" : "Italian"],
    };
  }
  const isPacking = /\b(valigia|bagaglio|packing|pack|suitcase|partire|viaggio|travel|trip|tornare a casa)\b/.test(normalized) && /\b(cosa|what|lista|list|portare|pack|remember|ricord)\b/.test(normalized);
  if (isPacking) {
    const checklistItems = ["Clothes", "Underwear and socks", "Toiletries", "Phone charger", "Wallet", "ID or documents", "Keys", "Medicines", "Headphones", "Laptop and charger"].map((item, index) => ({ id: `packing-${index}`, text: item, done: false }));
    return {
      title: "Packing list",
      text: `${checklistTextFor(checklistItems)}\n\nNote:\n${text}`,
      type: "Travel" as CaptureType,
      metadata: ["Checklist", "Packing", "Travel"],
      checklistItems,
    };
  }
  const timeWindow = inferTimeWindowFromText(text);
  const explicitDues = explicitDateDuesFromText(text, timeWindow.taskStartTime);
  const hasTaskIntent = /\b(devo|ricordami|segna|segnala|task|todo|da fare|i need to|i have to)\b/.test(normalized);
  const hasChecklistPayload = /:\s*[^:]+(?:,|;|\n)/.test(text) || /\bqueste sono le cose che devo fare\b/.test(normalized);
  if (hasTaskIntent && (timeWindow.taskStartTime || explicitDues.length || hasChecklistPayload)) {
    const listSource = text.includes(":") ? text.split(":").slice(1).join(":") : "";
    const items = extractListItems(listSource || text);
    const checklistItems = items.length ? items.map((item, index) => ({ id: `task-list-${index}`, text: item, done: false })) : undefined;
    const inferred = inferDueFromText(text);
    const due = applyTimeToDue(inferred ?? explicitDues[0], timeWindow.taskStartTime);
    const extraDueDates = explicitDues.filter((item) => item !== due);
    return {
      title: taskTitleFromText(text),
      text: checklistItems ? checklistTextFor(checklistItems) : "",
      type: "Actionable",
      metadata: visibleCaptureTags(["Task", checklistItems ? "Checklist" : "Actionable"]),
      due,
      taskStartTime: timeWindow.taskStartTime,
      taskEndTime: timeWindow.taskEndTime,
      checklistItems,
      extraDueDates,
    };
  }
  const isChecklist = /\b(checklist|lista|list|cose da|things to|todo|to do)\b/.test(normalized);
  const isShopping = /\b(spesa|grocery|groceries|supermercato|comprare|buy)\b/.test(normalized);
  if (isChecklist || isShopping) {
    const items = extractListItems(text);
    const fallbackItems = isShopping ? ["Milk", "Bread", "Fruit", "Household basics"] : ["Review details", "Add missing items", "Set a reminder if needed"];
    const checklistItems = (items.length ? items : fallbackItems).map((item, index) => ({ id: `checklist-${index}`, text: item, done: false }));
    const due = inferDueFromText(text);
    return {
      title: isShopping ? (/\b(spesa|grocery|groceries)\b/i.test(text) ? "Grocery shopping" : "Shopping list") : compactTitle(text, "Checklist"),
      text: checklistTextFor(checklistItems),
      type: isShopping ? "Actionable" as CaptureType : fallbackType,
      due,
      metadata: visibleCaptureTags([isShopping ? "Shopping" : "Checklist", "Checklist"]),
      checklistItems,
    };
  }
  const isJournal = /\b(sfogo|mi sento|sono triste|sono stanco|mood|diary|journal|vent)\b/.test(normalized);
  if (isJournal && source.toLowerCase() !== "voice note") {
    return {
      title: "Personal note",
      text,
      type: "Journal" as CaptureType,
      metadata: ["Journal", "Personal note"],
    };
  }
  return null;
};
const wantsStar = (text: string) => /\b(star this|starred|star it|top priority|pin this|pinned|important|absolute priority)\b|con (?:la )?stella|metti(?:mi|la)? (?:la )?stella|stellina|priorita assoluta|priorità assoluta|importante/i.test(text);
const weekdayIndex: Record<string, number> = {
  sunday: 0,
  domenica: 0,
  monday: 1,
  lunedi: 1,
  "lunedi'": 1,
  tuesday: 2,
  martedi: 2,
  "martedi'": 2,
  wednesday: 3,
  mercoledi: 3,
  "mercoledi'": 3,
  thursday: 4,
  giovedi: 4,
  "giovedi'": 4,
  friday: 5,
  venerdi: 5,
  "venerdi'": 5,
  saturday: 6,
  sabato: 6,
};
const inferDueFromText = (text: string) => {
  const value = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const target = new Date();
  target.setHours(/\b(morning|mattina)\b/.test(value) ? 9 : /\b(afternoon|pomeriggio)\b/.test(value) ? 15 : /\b(evening|sera|tonight|stasera)\b/.test(value) ? 20 : 12, 0, 0, 0);
  if (/\b(today|oggi)\b/.test(value)) return target.toISOString();
  if (/\b(tomorrow|domani)\b/.test(value)) {
    target.setDate(target.getDate() + 1);
    return target.toISOString();
  }
  const weekday = Object.entries(weekdayIndex).find(([label]) => new RegExp(`\\b${label}\\b`, "i").test(value));
  if (weekday) {
    const delta = (weekday[1] - target.getDay() + 7) % 7 || 7;
    target.setDate(target.getDate() + delta);
    return target.toISOString();
  }
  return undefined;
};
const inferTimeWindowFromText = (text: string) => {
  const value = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const match = value.match(/\b(?:dalle|from)?\s*(\d{1,2})(?::|[.,])?(\d{2})?\s*(?:alle|a|to|-)\s*(\d{1,2})(?::|[.,])?(\d{2})?\b/);
  if (!match) return {};
  const pad = (raw: string, minutes = "00") => `${String(Math.min(23, Math.max(0, Number(raw)))).padStart(2, "0")}:${minutes ? String(Math.min(59, Math.max(0, Number(minutes)))).padStart(2, "0") : "00"}`;
  return { taskStartTime: pad(match[1], match[2] ?? "00"), taskEndTime: pad(match[3], match[4] ?? "00") };
};
const applyTimeToDue = (due: string | undefined, time?: string) => {
  if (!due || !time) return due;
  const date = parseDueDate(due);
  const [hours, minutes] = time.split(":").map(Number);
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return date.toISOString();
};
const explicitDateDuesFromText = (text: string, startTime?: string) => {
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const currentYear = new Date().getFullYear();
  const monthNames: Record<string, number> = {
    gennaio: 0, january: 0, febbraio: 1, february: 1, marzo: 2, march: 2, aprile: 3, april: 3, maggio: 4, may: 4, giugno: 5, june: 5,
    luglio: 6, july: 6, agosto: 7, august: 7, settembre: 8, september: 8, ottobre: 9, october: 9, novembre: 10, november: 10, dicembre: 11, december: 11,
  };
  const dues: string[] = [];
  for (const match of normalized.matchAll(/\b(?:il|per il|anche per il|for)?\s*(\d{1,2})\s+(gennaio|january|febbraio|february|marzo|march|aprile|april|maggio|may|giugno|june|luglio|july|agosto|august|settembre|september|ottobre|october|novembre|november|dicembre|december)\b/g)) {
    const date = new Date(currentYear, monthNames[match[2]], Number(match[1]));
    const [hours, minutes] = (startTime ?? "12:00").split(":").map(Number);
    date.setHours(hours || 0, minutes || 0, 0, 0);
    dues.push(date.toISOString());
  }
  return Array.from(new Set(dues));
};
const usefulSuggestedAction = (action?: string | null) => {
  const value = action?.trim();
  if (!value) return undefined;
  if (/keep (this )?(organized|saved)|organized in the inbox|no action needed|reminder scheduled/i.test(value)) return undefined;
  return value;
};
const iconForType = (type: CaptureType) => ({
  Actionable: ListTodo,
  Idea: Lightbulb,
  Expense: ReceiptText,
  Place: MapPin,
  Document: Archive,
  Audio: Mic,
  Health: HeartPulse,
  Home,
  Study: BookOpen,
  Work: Briefcase,
  Travel: Plane,
  Person: User,
  Journal: NotebookText,
  Link: Link2,
})[type];

const classifyCapture = (text: string): CaptureType => {
  const value = text.toLowerCase();
  if (inferDueFromText(text) || /\b(task|remind|andare|fare|comprare|pagare|portare|prenotare)\b/.test(value)) return "Actionable";
  if (/\b(call|send|deadline|todo|chiamare|ricordami)\b/.test(value)) return "Actionable";
  if (/\b(pay|spent|receipt|expense|eur|euro|benzina|speso|pagato)\b|\$|\u20ac/.test(value)) return "Expense";
  if (/https?:\/\/|www\.|youtube|video/.test(value)) return "Link";
  if (/\b(restaurant|ristorante|osteria|trattoria|place|milan|brera)\b/.test(value)) return "Place";
  if (/\b(tired|sleep|energy|health|stanco)\b/.test(value)) return "Health";
  if (/\b(study|course|lesson|exam|pdf)\b/.test(value)) return "Study";
  if (/\b(client|contract|meeting|work)\b/.test(value)) return "Work";
  if (/\b(home|house|laundry|detergent|milk)\b/.test(value)) return "Home";
  if (/\b(trip|flight|hotel|travel)\b/.test(value)) return "Travel";
  if (/\b(marco|luca|giulia)\b/.test(value)) return "Person";
  if (/\b(journal|diary|felt|mood)\b/.test(value)) return "Journal";
  if (/\b(audio|voice note|recording|vocale|registrazione)\b/.test(value)) return "Audio";
  if (/\b(doc|file)\b/.test(value)) return "Document";
  return "Idea";
};

const metadataFor = (text: string, type: CaptureType) => {
  const lower = text.toLowerCase();
  const tags = new Set<string>([type, "AI tagged"]);
  if (lower.includes("marco")) tags.add("Marco");
  if (lower.includes("luca")) tags.add("Luca");
  if (lower.includes("milan") || lower.includes("brera")) tags.add("Milan");
  if (/\b(restaurant|ristorante|osteria|trattoria)\b/.test(lower)) tags.add("Restaurant");
  if (type === "Actionable") tags.add("Reminder suggested");
  if (type === "Expense") tags.add("Receipt extraction");
  if (type === "Document") tags.add("File indexed");
  if (type === "Audio") tags.add("Voice note");
  if (type === "Link") tags.add("Saved link");
  if (tags.size < 3) tags.add("Auto organized");
  return Array.from(tags);
};

const tagColorFor = (tag: string, customColors: Record<string, string> = {}) => customColors[tag] ?? tagPalette[Array.from(tag).reduce((sum, char) => sum + char.charCodeAt(0), 0) % tagPalette.length];
const tagChipStyle = (tag: string, customColors: Record<string, string> = {}) => {
  const color = tagColorFor(tag, customColors);
  return { "--tag-color": color, "--tag-bg": `${color}18` } as React.CSSProperties;
};

const currencySymbol = (currency: string) => ({ EUR: "\u20ac", USD: "$", GBP: "\u00a3", "$": "$" }[currency] ?? currency);
const formatMoney = (amount: number, currency: string) => `${currencySymbol(currency)}${amount.toFixed(2)}`;
const formatSignedMoney = (amount: number, currency: string, direction: MoneySignal["direction"]) => `${direction === "income" ? "+" : direction === "expense" ? "-" : ""}${formatMoney(amount, currency)}`;

const toDateTimeLocal = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const normalizeDue = (value?: string) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};

const formatDue = (value?: string) => {
  if (!value) return "";
  const date = parseDueDate(value);
  if (Number.isNaN(date.getTime())) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const createIcs = (capture: Capture) => {
  const start = parseDueDate(capture.due);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nube//Personal Inbox//EN",
    createIcsEvent(capture, start, end),
    "END:VCALENDAR",
  ].join("\r\n");
};

const icsStamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsEscape = (value: string) => value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
const createIcsEvent = (capture: Capture, start = parseDueDate(capture.due), end = new Date(parseDueDate(capture.due).getTime() + 30 * 60 * 1000)) => [
  "BEGIN:VEVENT",
  `UID:nube-${capture.id}@local`,
  `DTSTAMP:${icsStamp(new Date())}`,
  `DTSTART:${icsStamp(start)}`,
  `DTEND:${icsStamp(end)}`,
  `SUMMARY:${icsEscape(capture.title)}`,
  `DESCRIPTION:${icsEscape(capture.text)}`,
  "END:VEVENT",
].join("\r\n");

const downloadTextFile = (filename: string, content: string, type = "text/plain") => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const downloadUrl = (filename: string, url: string) => {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
};

const exportCaptureIcs = (capture: Capture) => {
  const filename = `${capture.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "nube-task"}.ics`;
  downloadTextFile(filename, createIcs(capture), "text/calendar;charset=utf-8");
};

const vaultFilename = (extension: string) => `nube-vault-${new Date().toISOString().slice(0, 10)}.${extension}`;

const exportVaultJson = (captures: Capture[], profile: Profile) => {
  downloadTextFile(vaultFilename("json"), JSON.stringify({ app: "Nube", exportedAt: new Date().toISOString(), profile: { name: profile.name, city: profile.city, currency: profile.currency }, captures }, null, 2), "application/json;charset=utf-8");
};

const escapeCsvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;

const exportVaultCsv = (captures: Capture[]) => {
  const rows = [
    ["Title", "Type", "Priority", "Due", "Created", "Tags", "Text"],
    ...captures.map((capture) => [capture.title, capture.type, capture.priority ?? "", capture.due ?? "", capture.createdAt, visibleCaptureTags(capture.metadata).join(", "), capture.text]),
  ];
  downloadTextFile(vaultFilename("csv"), rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n"), "text/csv;charset=utf-8");
};

const exportVaultMarkdown = (captures: Capture[]) => {
  const content = [
    "# Nube Vault",
    "",
    `Exported: ${new Date().toLocaleString("en-US")}`,
    "",
    ...captures.map((capture) => [
      `## ${capture.title}`,
      "",
      `- Type: ${capture.type}`,
      `- Priority: ${priorityLabel(capture.priority) || "No priority"}`,
      capture.due ? `- Due: ${formatDue(capture.due)}` : null,
      visibleCaptureTags(capture.metadata).length ? `- Tags: ${visibleCaptureTags(capture.metadata).join(", ")}` : null,
      "",
      capture.text || "_No body text._",
      "",
    ].filter(Boolean).join("\n")),
  ].join("\n");
  downloadTextFile(vaultFilename("md"), content, "text/markdown;charset=utf-8");
};

const exportVaultIcs = (captures: Capture[]) => {
  const scheduled = captures.filter((capture) => capture.due);
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nube//Vault Export//EN",
    ...scheduled.map((capture) => createIcsEvent(capture)),
    "END:VCALENDAR",
  ].join("\r\n");
  downloadTextFile(vaultFilename("ics"), body, "text/calendar;charset=utf-8");
};

const unfoldIcs = (content: string) => content.replace(/\r?\n[ \t]/g, "");
const readIcsValue = (event: string, key: string) => {
  const line = event.split(/\r?\n/).find((item) => item.toUpperCase().startsWith(key));
  return line ? line.slice(line.indexOf(":") + 1).replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim() : "";
};
const parseIcsDate = (value: string) => {
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const cleaned = value.replace("Z", "");
  if (/^\d{8}T\d{6}$/.test(cleaned)) return new Date(`${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}T${cleaned.slice(9, 11)}:${cleaned.slice(11, 13)}:${cleaned.slice(13, 15)}`).toISOString();
  return "";
};
const parseIcsCaptures = (content: string): Partial<Capture>[] => {
  const normalized = unfoldIcs(content);
  return Array.from(normalized.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)).map((match) => {
    const event = match[1];
    const title = readIcsValue(event, "SUMMARY") || "Imported calendar event";
    const description = readIcsValue(event, "DESCRIPTION");
    const due = parseIcsDate(readIcsValue(event, "DTSTART"));
    const priority = inferPriorityFromText(`${title} ${description}`);
    return {
      title,
      text: description,
      type: "Actionable",
      source: "calendar import",
      due: due || undefined,
      priority,
      metadata: ["Calendar import"],
    };
  });
};

const moneySignalsFor = (captures: Capture[]): MoneySignal[] => {
  const amountPattern = /([+-]?\s?\d+(?:[.,]\d{1,2})?)\s?(\u20ac|eur|euro|euros|\$|usd|dollars?)/gi;
  const expenseWords = /\b(spent|paid|bought|cost|expense|receipt|fuel|gas|benzina|speso|pagato|comprato|costo|scontrino|bolletta)\b/i;
  const incomeWords = /\b(received|earned|income|refund|salary|paid me|rimborso|entrata|guadagnato|stipendio|incassato)\b/i;
  return captures.flatMap((capture) => {
    const text = `${capture.title} ${capture.text}`;
    return Array.from(text.matchAll(amountPattern)).map((match, index) => {
      const rawAmount = match[1].replace(/\s/g, "");
      const amount = Math.abs(Number(rawAmount.replace(",", ".").replace(/[+-]/, "")));
      const currency = /\$|usd|dollar/i.test(match[2]) ? "$" : "EUR";
      const manual: MoneySignal["direction"] | null = capture.metadata.includes("Money income") ? "income" : capture.metadata.includes("Money expense") ? "expense" : capture.metadata.includes("Money review") ? "review" : null;
      const direction: MoneySignal["direction"] = manual ?? (rawAmount.startsWith("+") ? "income" : rawAmount.startsWith("-") || capture.type === "Expense" || expenseWords.test(text) ? "expense" : incomeWords.test(text) ? "income" : "review");
      const reason = manual ? "Set manually" : rawAmount.startsWith("+") ? "Plus sign detected" : rawAmount.startsWith("-") ? "Minus sign detected" : capture.type === "Expense" || expenseWords.test(text) ? "Expense wording detected" : incomeWords.test(text) ? "Income wording detected" : "Needs review";
      return { id: capture.id, key: `${capture.id}-${index}-${rawAmount}-${currency}`, title: capture.title, amount, currency, direction, reason };
    });
}).filter((signal) => Number.isFinite(signal.amount) && signal.amount > 0);
};

const privacySignalsFor = (captures: Capture[]) => captures.flatMap((capture) => {
  const text = `${capture.title} ${capture.text}`;
  const signals: string[] = [];
  const longNumberMatches = Array.from(text.matchAll(/\+?\d[\d\s().-]{8,}\d/g)).filter((match) => match[0].replace(/\D/g, "").length >= 9);
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) signals.push("Email");
  if (longNumberMatches.length && (/\b(phone|tel|mobile|cell|id|client id|customer id|telefono|cellulare|codice|cliente)\b/i.test(text) || longNumberMatches.some((match) => match[0].replace(/\D/g, "").length >= 11))) signals.push("Phone or ID");
  if (/\b(password|passcode|token|secret|api key|iban|contract|passport)\b/i.test(text)) signals.push("Sensitive text");
  if (capture.attachmentName && /\b(contract|invoice|passport|id|bank|medical|tax)\b/i.test(capture.attachmentName)) signals.push("Sensitive file");
  return signals.map((kind) => ({ id: capture.id, title: capture.title, kind }));
});

const hasMoneySignal = (capture: Capture) => moneySignalsFor([capture]).length > 0 || capture.type === "Expense" || capture.metadata.some((tag) => tag.startsWith("Money "));
const dateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const parseDueDate = (due?: string) => {
  const direct = due ? new Date(due) : null;
  if (direct && !Number.isNaN(direct.getTime())) return direct;
  const target = new Date();
  target.setHours(9, 0, 0, 0);
  const value = due?.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") ?? "";
  if (/\b(today|oggi)\b/.test(value)) return target;
  if (/\b(tomorrow|domani)\b/.test(value)) {
    target.setDate(target.getDate() + 1);
    return target;
  }
  const weekday = Object.entries(weekdayIndex).find(([label]) => new RegExp(`\\b${label}\\b`, "i").test(value));
  if (weekday) {
    const delta = (weekday[1] - target.getDay() + 7) % 7 || 7;
    target.setDate(target.getDate() + delta);
  }
  return target;
};
const captureMatchesDate = (capture: Capture, day: string) => Boolean(capture.due && dateKey(parseDueDate(capture.due)) === day);

const formatCaptureAge = (capture: Capture) => {
  const created = new Date(capture.createdAt);
  if (Number.isNaN(created.getTime())) return capture.time || "";
  const diffMs = Date.now() - created.getTime();
  if (diffMs < 60_000) return "Now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return created.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const cardTimeLabel = (capture: Capture) => capture.due ? `Due ${formatDue(capture.due)}` : formatCaptureAge(capture);
const captureBodyText = (capture: Capture) => {
  const body = capture.text.trim();
  const title = capture.title.trim();
  if (!body || body === title) return "";
  if (capture.external?.url && body.replace(/^Saved (page|link|image):\s*/i, "").trim() === capture.external.url) return "";
  return body.startsWith(title) ? body.slice(title.length).trim() : body;
};

const checklistItemsFromText = (text: string): ChecklistItem[] => {
  const compactText = text.replace(/^Checklist:\s*/i, "").trim();
  const inlineMatches = Array.from(compactText.matchAll(/[-*]\s+\[( |x|X)\]\s+(.+?)(?=\s+[-*]\s+\[(?: |x|X)\]\s+|$)/g));
  if (inlineMatches.length > 1) {
    return inlineMatches.map((match, index) => ({
      id: `check-${index}-${match[2].slice(0, 12)}`,
      text: match[2].trim(),
      done: match[1].toLowerCase() === "x",
    }));
  }
  return text
    .split(/\r?\n/)
    .map((line, index) => {
      const match = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/);
      return match ? { id: `check-${index}-${match[2].slice(0, 12)}`, text: match[2].trim(), done: match[1].toLowerCase() === "x" } : null;
    })
    .filter(Boolean) as ChecklistItem[];
};

const checklistTextFor = (items: ChecklistItem[]) => `Checklist:\n${items.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`).join("\n")}`;

const checklistForCapture = (capture: Capture) => capture.checklistItems?.length ? capture.checklistItems : checklistItemsFromText(capture.text);

const audioAttachmentsFor = (capture: Pick<Capture, "attachments">) => capture.attachments?.filter((attachment) => attachment.mimeType.startsWith("audio/")) ?? [];
const isPinnedCapture = (capture: Pick<Capture, "starred">) => capture.starred === true || String(capture.starred).toLowerCase() === "true";

const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
};

const collapseRepeatedTranscript = (text: string) => {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const output: string[] = [];
  words.forEach((word) => {
    if (output.at(-1)?.toLowerCase() === word.toLowerCase() && word.length > 2) return;
    output.push(word);
    let changed = true;
    while (changed) {
      changed = false;
      for (let size = Math.min(12, Math.floor(output.length / 2)); size >= 3; size -= 1) {
        const previous = output.slice(output.length - size * 2, output.length - size).join(" ").toLowerCase();
        const recent = output.slice(output.length - size).join(" ").toLowerCase();
        if (previous && previous === recent) {
          output.splice(output.length - size, size);
          changed = true;
          break;
        }
      }
    }
  });
  return output.join(" ");
};

function VoiceNotePlayer({ attachment, compact = false, minimal = false, allowCardOpen = false, metaLabel, onRemove, onRename }: { attachment: Attachment; compact?: boolean; minimal?: boolean; allowCardOpen?: boolean; metaLabel?: string; onRemove?: () => void; onRename?: (title: string) => void }) {
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [current, setCurrent] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [rate, setRate] = React.useState(1);
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState("");
  const [waveBars, setWaveBars] = React.useState<number[]>([]);
  const progress = duration ? current / duration : 0;
  const fallbackBars = compact ? [18, 28, 24, 38, 52, 34, 44, 58, 40, 32, 24, 36, 28, 24, 30, 20, 18, 34, 26, 18] : [22, 34, 26, 46, 62, 38, 54, 70, 48, 36, 24, 42, 31, 28, 34, 20, 16, 40, 30, 18];
  const bars = waveBars.length ? waveBars : fallbackBars;
  const voiceLabel = attachment.title || (attachment.name.match(/voice-note/i) ? "Voice note" : attachment.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "));
  const playable = Boolean(attachment.dataUrl);
  React.useEffect(() => {
    if (!editingTitle) setTitleDraft(voiceLabel);
  }, [editingTitle, voiceLabel]);
  React.useEffect(() => {
    let cancelled = false;
    if (!attachment.dataUrl) return;
    const dataUrl = attachment.dataUrl;
    const buildWaveform = async () => {
      try {
        const response = await fetch(dataUrl);
        const buffer = await response.arrayBuffer();
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) return;
        const context = new AudioContextCtor();
        const audioBuffer = await context.decodeAudioData(buffer.slice(0));
        const samples = audioBuffer.getChannelData(0);
        const count = compact ? 22 : 28;
        const segment = Math.max(1, Math.floor(samples.length / count));
        const peaks = Array.from({ length: count }, (_, index) => {
          const start = index * segment;
          const end = Math.min(samples.length, start + segment);
          let sum = 0;
          for (let i = start; i < end; i += 1) sum += Math.abs(samples[i] ?? 0);
          return sum / Math.max(1, end - start);
        });
        const max = Math.max(...peaks, 0.01);
        const next = peaks.map((peak, index) => {
          const previous = peaks[Math.max(0, index - 1)] ?? peak;
          const following = peaks[Math.min(peaks.length - 1, index + 1)] ?? peak;
          const smoothed = (previous + peak * 1.8 + following) / 3.8;
          return Math.round(12 + Math.min(0.82, smoothed / max) * 38);
        });
        if (!cancelled) setWaveBars(next);
        void context.close();
      } catch {
        if (!cancelled) setWaveBars([]);
      }
    };
    void buildWaveform();
    return () => {
      cancelled = true;
    };
  }, [attachment.dataUrl, compact]);
  const seek = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta));
  };
  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  };
  const cycleRate = () => {
    const rates = [1, 1.5, 2, 0.5];
    const next = rates[(rates.indexOf(rate) + 1) % rates.length] ?? 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };
  const titleNode = (
    <div className="voice-title-row">
      {editingTitle && onRename ? <input autoFocus className="voice-title-input" value={titleDraft} onBlur={() => { onRename(titleDraft.trim() || "Voice note"); setEditingTitle(false); }} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setTitleDraft(voiceLabel); setEditingTitle(false); } }} /> : <b>{voiceLabel}</b>}
      {onRename && <button className="voice-title-edit" onClick={(event) => { event.stopPropagation(); setTitleDraft(voiceLabel); setEditingTitle((current) => !current); }} title="Rename voice note" type="button"><Pencil size={13} /></button>}
    </div>
  );
  return (
    <div className={`voice-player ${compact ? "compact" : ""}`} onClick={allowCardOpen ? undefined : (event) => event.stopPropagation()}>
      {attachment.dataUrl ? <audio
        ref={audioRef}
        src={attachment.dataUrl}
        onLoadedMetadata={(event) => {
          event.currentTarget.playbackRate = rate;
          setDuration(event.currentTarget.duration);
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      /> : null}
      <button className="voice-play" disabled={!playable} onClick={(event) => { event.stopPropagation(); toggle(); }} type="button">{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>
      {compact && titleNode}
      {compact && metaLabel && <small className="voice-card-time">{metaLabel}</small>}
      <div className="voice-body">
        {!compact && <div className="voice-topline">{titleNode}</div>}
        {playable ? minimal ? <button className="voice-progress-rail" onClick={(event) => {
          event.stopPropagation();
          const audio = audioRef.current;
          if (!audio || !duration) return;
          const rect = event.currentTarget.getBoundingClientRect();
          audio.currentTime = duration * ((event.clientX - rect.left) / rect.width);
        }} type="button"><span style={{ width: `${Math.max(1, progress * 100)}%` }} /></button> : <div className="voice-wave" style={{ "--voice-progress": progress } as React.CSSProperties}>
          {bars.map((height, index) => <button className={(index / Math.max(1, bars.length - 1)) <= progress ? "played" : ""} key={`${height}-${index}`} style={{ "--bar-height": `${height}%` } as React.CSSProperties} onClick={(event) => {
              event.stopPropagation();
              const audio = audioRef.current;
              if (!audio || !duration) return;
              audio.currentTime = duration * (index / Math.max(1, bars.length - 1));
            }} type="button" />)}
        </div> : <div className="voice-missing"><Mic size={15} />Audio is saved, but the playable file is only available on the device that recorded it.</div>}
        <div className="voice-controls">
          <time>{formatDuration(current)} / {formatDuration(duration)}</time>
          <div><button onClick={(event) => { event.stopPropagation(); seek(-10); }} type="button"><RotateCcw size={14} />10</button><button className="voice-rate" onClick={(event) => { event.stopPropagation(); cycleRate(); }} type="button">{rate.toFixed(1)}x</button><button onClick={(event) => { event.stopPropagation(); seek(10); }} type="button">10<RotateCw size={14} /></button></div>
          <div><button disabled={!playable} onClick={(event) => { event.stopPropagation(); downloadUrl(attachment.name, attachment.dataUrl ?? ""); }} type="button">Download</button>{onRemove && <button className="voice-remove" onClick={(event) => { event.stopPropagation(); onRemove(); }} type="button"><X size={13} /></button>}</div>
        </div>
      </div>
    </div>
  );
}

const searchMatchesCapture = (capture: Capture, query: string) => {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const haystack = `${capture.title} ${capture.text} ${capture.type} ${capture.source} ${capture.metadata.join(" ")} ${capture.place?.address ?? ""}`.toLowerCase();
  const typeAliases: Record<string, CaptureType[]> = {
    task: ["Actionable"],
    tasks: ["Actionable"],
    expense: ["Expense"],
    expenses: ["Expense"],
    money: ["Expense"],
    place: ["Place"],
    places: ["Place"],
    restaurant: ["Place"],
    restaurants: ["Place"],
    people: ["Person"],
    person: ["Person"],
    ideas: ["Idea"],
    idea: ["Idea"],
    documents: ["Document"],
    document: ["Document"],
  };
  const aliasHit = Object.entries(typeAliases).some(([word, types]) => q.includes(word) && types.includes(capture.type));
  const priorityHit = (["Low", "Medium", "High"] as Priority[]).some((priority) => q.includes(`${priority.toLowerCase()} priority`) && capture.priority === priority);
  const tagHit = capture.metadata.some((tag) => q.includes(tag.toLowerCase()));
  const todayHit = q.includes("today") && dateKey(new Date(capture.createdAt)) === dateKey(new Date());
  const monthHit = q.includes("this month") && new Date(capture.createdAt).getMonth() === new Date().getMonth();
  return haystack.includes(q) || aliasHit || priorityHit || tagHit || todayHit || monthHit;
};

const localAskNube = (question: string, captures: Capture[]): AskNubeResponse => {
  const normalizedQuestion = question.replace(/^ask:\s*/i, "").trim();
  const related = rankCaptures(captures.filter((capture) => searchMatchesCapture(capture, normalizedQuestion))).slice(0, 6);
  return {
    answer: related.length
      ? `Local mode found ${related.length} matching ${related.length === 1 ? "capture" : "captures"}. Open one to review details, tags, dates, or attachments.`
      : "Local mode did not find a matching capture. Try a place, tag, date, amount, or exact word from the note.",
    related: related.map((capture) => ({ id: capture.id, title: capture.title, type: capture.type })),
    provider: "local-fallback",
  };
};

const askNube = async (question: string, captures: Capture[]): Promise<AskNubeResponse> => {
  const normalizedQuestion = question.replace(/^ask:\s*/i, "").trim();
  if (AI_BOT_OFFLINE) return localAskNube(normalizedQuestion || question, captures);
  const payload = captures.slice(0, 100).map((capture) => ({
    id: capture.id,
    title: capture.title,
    text: capture.text,
    type: capture.type,
    metadata: capture.metadata,
    due: capture.due,
    createdAt: capture.createdAt,
    source: capture.source,
    priority: capture.priority,
    completed: capture.completed,
    starred: capture.starred,
    place: capture.place,
    imageUrl: capture.imageUrl,
    attachmentName: capture.attachmentName,
    attachmentSize: capture.attachmentSize,
    attachments: capture.attachments?.map((attachment) => ({ name: attachment.name, size: attachment.size, mimeType: attachment.mimeType })),
  }));
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: normalizedQuestion || question, captures: payload }),
  });
  if (!response.ok) throw new Error("Ask Nube is unavailable.");
  return await response.json() as AskNubeResponse;
};

const UPLOAD_QUEUE_KEY = "nube-upload-queue";
const PENDING_VOICE_KEY = "nube-pending-voice-note";
const MAX_QUEUED_UPLOAD_BYTES = 6 * 1024 * 1024;

const readUploadQueue = () => {
  try {
    const raw = localStorage.getItem(UPLOAD_QUEUE_KEY);
    return raw ? JSON.parse(raw) as QueuedUpload[] : [];
  } catch {
    return [];
  }
};

const writeUploadQueue = (queue: QueuedUpload[]) => {
  localStorage.setItem(UPLOAD_QUEUE_KEY, JSON.stringify(queue));
};

const enqueueUploadRetry = (item: QueuedUpload) => {
  const queue = readUploadQueue().filter((queued) => queued.id !== item.id);
  queue.push(item);
  writeUploadQueue(queue);
};

const dataUrlToBlob = async (dataUrl: string) => {
  const response = await fetch(dataUrl);
  return await response.blob();
};

const mergeCapturesById = (current: Capture[], incoming: Capture[]) => {
  if (!incoming.length) return current;
  const byId = new Map<number, Capture>();
  current.forEach((capture) => byId.set(capture.id, capture));
  let changed = false;
  incoming.forEach((capture) => {
    const existing = byId.get(capture.id);
    if (!existing) {
      byId.set(capture.id, capture);
      changed = true;
    } else if (capture.source === "browser extension" && JSON.stringify(existing) !== JSON.stringify(capture)) {
      byId.set(capture.id, { ...existing, ...capture });
      changed = true;
    }
  });
  if (!changed) return current;
  return Array.from(byId.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};

async function classifyCaptureWithApi(text: string, source: string): Promise<AiClassification | null> {
  if (AI_BOT_OFFLINE) return null;
  try {
    const response = await fetch("/api/classify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, source }) });
    return response.ok ? ((await response.json()) as AiClassification) : null;
  } catch {
    return null;
  }
}

async function enrichPlaceApi(query: string): Promise<PlaceDetails | null> {
  try {
    const response = await fetch("/api/place/enrich", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
    return response.ok ? ((await response.json()) as PlaceDetails) : null;
  } catch {
    return null;
  }
}

function localAiReview(captures: Capture[]): AiReview {
  const openTasks = captures.filter((capture) => capture.type === "Actionable" && !capture.completed);
  const money = moneySignalsFor(captures);
  return {
    headline: openTasks.length ? `${openTasks.length} open tasks need attention.` : "Your inbox is calm right now.",
    focus: openTasks[0]?.title ?? captures.find((capture) => capture.starred)?.title ?? captures[0]?.title ?? "Capture anything important when it appears.",
    nextActions: openTasks.slice(0, 3).map((capture) => capture.title),
    patterns: [`${captures.length} total captures`, `${new Set(captures.flatMap((capture) => visibleCaptureTags(capture.metadata))).size} active tags`, `${money.length} money signals`],
    risks: money.some((signal) => signal.direction === "review") ? ["Review unclear money items before they get buried."] : [],
    provider: "local-fallback",
  };
}

const aiReviewSignatureFor = (captures: Capture[]) => captures.map((capture) => `${capture.id}:${capture.title}:${capture.type}:${capture.completed ? 1 : 0}:${capture.starred ? 1 : 0}:${capture.due ?? ""}:${capture.priority ?? ""}:${capture.metadata.join(",")}`).join("|");

function useStableAiReview(captures: Capture[]) {
  const cache = React.useRef<{ signature: string; review: AiReview } | null>(null);
  const signature = React.useMemo(() => aiReviewSignatureFor(captures), [captures]);
  const [review, setReview] = React.useState<AiReview>(() => cache.current?.signature === signature ? cache.current.review : localAiReview(captures));
  React.useEffect(() => {
    let cancelled = false;
    if (cache.current?.signature === signature) {
      setReview(cache.current.review);
      return () => {
        cancelled = true;
      };
    }
    const fallback = localAiReview(captures);
    setReview(fallback);
    if (AI_BOT_OFFLINE) {
      cache.current = { signature, review: fallback };
      return () => {
        cancelled = true;
      };
    }
    const payload = captures.slice(0, 40).map((capture) => ({
      title: capture.title,
      text: capture.text,
      type: capture.type,
      metadata: capture.metadata,
      due: capture.due,
      priority: capture.priority,
      completed: capture.completed,
      starred: capture.starred,
    }));
    void fetch("/api/insights/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captures: payload }),
    })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Review unavailable")))
      .then((data: AiReview) => {
        cache.current = { signature, review: data };
        if (!cancelled) setReview(data);
      })
      .catch(() => {
        cache.current = { signature, review: fallback };
        if (!cancelled) setReview(fallback);
      });
    return () => {
      cancelled = true;
    };
  }, [captures, signature]);
  return review;
}

const placeImageFor = (capture: Capture) => `https://source.unsplash.com/900x420/?${encodeURIComponent(`${capture.title} restaurant interior`)}`;
const placeLocationFor = (capture: Capture) => capture.place?.address ?? (capture.metadata.includes("Milan") ? "Milan, Italy" : "Location to confirm");

type WeatherSnapshot = {
  city: string;
  temperature: string;
  condition: string;
  icon: typeof Sun;
};

const fallbackWeatherFor = (profile: Profile): WeatherSnapshot => ({
  city: profile.locationLabel || profile.city || "Current location",
  temperature: "--°C",
  condition: "Updating",
  icon: Sun,
});

function Avatar({ profile, size = "normal" }: { profile: Profile; size?: "mini" | "normal" | "large" | "button" }) {
  const initials = profile.avatar || profile.name.slice(0, 1).toUpperCase();
  const className = size === "button" ? "avatar-button" : `settings-avatar ${size === "normal" ? "" : size}`.trim();
  return profile.avatarUrl ? <span className={`${className} has-image`}><img src={profile.avatarUrl} alt={profile.name} /></span> : <span className={className}>{initials}</span>;
}

function AuthSplash({ googleConfigured, loading = false, onContinueLocally }: { googleConfigured: boolean; loading?: boolean; onContinueLocally: () => void }) {
  return (
    <main className="auth-splash">
      <div className="auth-cloudscape" aria-hidden="true">
        {Array.from({ length: 16 }, (_, index) => <span className={`cloud cloud-${index + 1}`} key={index}><Cloud size={index % 4 === 0 ? 68 : index % 4 === 1 ? 42 : index % 4 === 2 ? 28 : 54} /></span>)}
      </div>
      <section className="auth-splash-card">
        <div className="auth-splash-logo"><Cloud size={28} /><span>Nube</span></div>
        {loading && <p className="eyebrow">Checking account</p>}
        <h1><span>Drop it in.</span><span>Find it later.</span></h1>
        <p>Nube remembers notes, files, places, reminders, and money signals from one calm inbox.</p>
        <div className="auth-splash-actions">
          <button disabled={loading || !googleConfigured} onClick={() => { window.location.href = "/api/auth/google"; }}><Lock size={17} />Sign in with Google</button>
          <button className="secondary" disabled={loading} onClick={onContinueLocally}>Continue locally</button>
        </div>
        {!googleConfigured && !loading && <small>Google OAuth is not configured yet. Add the client ID and secret in .env.</small>}
        <div className="auth-splash-note">
          <span><CheckCircle2 size={15} />Local on this browser</span>
          <span><Cloud size={15} />Google sync ready</span>
        </div>
      </section>
    </main>
  );
}

const friendlyError = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : fallback;
  if (/accessNotConfigured|SERVICE_DISABLED|API has not been used/i.test(message)) return "The Google API is disabled in Google Cloud. Enable it, wait a minute, then try again.";
  if (/insufficient authentication scopes|gmail readonly|calendar readonly|grant/i.test(message)) return "Google permission is missing. Sign in with Google again and allow the requested access.";
  if (/network|fetch failed|failed to fetch/i.test(message)) return "Nube could not reach the server. Check your connection and try again.";
  if (/too many requests/i.test(message)) return "Nube is slowing requests for safety. Wait a moment, then try again.";
  if (/cloud database is not configured/i.test(message)) return "Cloud sync is not connected yet. Add the production database before using multi-device sync.";
  if (/Cloud storage is not configured|R2/i.test(message)) return "Cloud file storage is not connected yet. Add Cloudflare R2 credentials before publishing uploads.";
  return message || fallback;
};

function App() {
  const [view, setView] = React.useState<View>("Inbox");
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [captures, setCaptures] = React.useState<Capture[]>(readStoredCaptures);
  const [selectedCapture, setSelectedCapture] = React.useState<Capture | null>(null);
  const [previewImage, setPreviewImage] = React.useState<{ src: string; alt: string } | null>(null);
  const [collectionFilter, setCollectionFilter] = React.useState<CollectionFilter>(null);
  const [dateFilter, setDateFilter] = React.useState<DateFilter>(null);
  const [profile, setProfile] = React.useState<Profile>(() => {
    const saved = localStorage.getItem("nube-profile");
    const loaded = saved ? { ...defaultProfile, ...JSON.parse(saved) as Profile } : defaultProfile;
    return loaded.city === "Milan" ? { ...loaded, city: "Ferrara", locationLabel: "Ferrara, Italy" } : loaded;
  });
  const [authUser, setAuthUser] = React.useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = React.useState(false);
  const [localMode, setLocalMode] = React.useState(() => localStorage.getItem("nube-local-mode") === "true");
  const [welcomePreview, setWelcomePreview] = React.useState(() => new URLSearchParams(window.location.search).get("welcome") === "1");
  const [googleConfigured, setGoogleConfigured] = React.useState(false);
  const [tagColors, setTagColors] = React.useState<Record<string, string>>(() => {
    const saved = localStorage.getItem("nube-tag-colors");
    return saved ? JSON.parse(saved) as Record<string, string> : {};
  });
  const [pluginSettings, setPluginSettings] = React.useState<PluginSettings>(() => {
    const saved = localStorage.getItem("nube-plugin-settings");
    return saved ? { ...defaultPluginSettings, ...JSON.parse(saved) as Partial<PluginSettings> } : defaultPluginSettings;
  });
  const [privatePinHash, setPrivatePinHash] = React.useState(() => localStorage.getItem("nube-private-pin-hash") || "");
  const [unlockedPrivateIds, setUnlockedPrivateIds] = React.useState<Set<number>>(() => new Set());
  const [privateUnlockRequest, setPrivateUnlockRequest] = React.useState<{ capture: Capture; onSuccess?: () => void } | null>(null);
  const [privateUnlockDraft, setPrivateUnlockDraft] = React.useState("");
  const [privateUnlockError, setPrivateUnlockError] = React.useState("");
  const [privateSessionPin, setPrivateSessionPin] = React.useState("");
  const [syncStatus, setSyncStatus] = React.useState<SyncQueueSnapshot>(() => syncQueue.getSnapshot());
  const syncReady = React.useRef(false);
  const profileSyncReady = React.useRef(false);
  const publicReviewCaptures = React.useMemo(() => captures.filter((capture) => !capture.private), [captures]);
  const aiReview = useStableAiReview(publicReviewCaptures);

  React.useEffect(() => writeStoredCaptures(captures), [captures]);
  React.useEffect(() => syncQueue.subscribe(setSyncStatus), []);
  React.useEffect(() => {
    if (!syncReady.current) {
      syncReady.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      syncQueue.enqueuePutJson("brain-vault", "/api/brain", { captures: captures.map(stripHeavyCaptureData), focusText: "" });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [captures]);
  React.useEffect(() => localStorage.setItem("nube-profile", JSON.stringify(profile)), [profile]);
  React.useEffect(() => localStorage.setItem("nube-tag-colors", JSON.stringify(tagColors)), [tagColors]);
  React.useEffect(() => localStorage.setItem("nube-plugin-settings", JSON.stringify(pluginSettings)), [pluginSettings]);
  React.useEffect(() => {
    if (privatePinHash) localStorage.setItem("nube-private-pin-hash", privatePinHash);
    else localStorage.removeItem("nube-private-pin-hash");
  }, [privatePinHash]);
  React.useEffect(() => {
    if (!privateSessionPin || !unlockedPrivateIds.size) return;
    const lockPrivateSession = () => {
      setCaptures((current) => current.map((capture) => (
        capture.private && capture.privateEncryptedData ? maskPrivateCaptureForStorage(capture) : capture
      )));
      setUnlockedPrivateIds(new Set());
      setPrivateSessionPin("");
    };
    const events = ["pointerdown", "keydown", "scroll", "touchstart"];
    let timer = window.setTimeout(lockPrivateSession, 10 * 60_000);
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lockPrivateSession, 10 * 60_000);
    };
    events.forEach((event) => window.addEventListener(event, refresh, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, refresh));
    };
  }, [privateSessionPin, unlockedPrivateIds.size]);
  React.useEffect(() => {
    void fetch("/api/auth/me")
      .then((response) => response.json())
      .then((data: { user: AuthUser | null; googleConfigured: boolean }) => {
        setGoogleConfigured(Boolean(data.googleConfigured));
        if (!data.user) return;
        setAuthUser(data.user);
        setLocalMode(false);
        localStorage.removeItem("nube-local-mode");
        setProfile((current) => ({
          ...current,
          ...(data.user?.profile ?? {}),
          email: data.user?.email ?? current.email,
          name: data.user?.profile?.name || current.name || data.user?.name || defaultProfile.name,
          avatarUrl: current.avatarUrl || data.user?.avatarUrl || data.user?.picture,
          authProvider: "google",
        }));
      })
      .catch(() => setGoogleConfigured(false))
      .finally(() => setAuthChecked(true));
  }, []);
  React.useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    void fetch("/api/brain")
      .then((response) => response.ok ? response.json() : null)
      .then((vault: { captures?: Capture[] } | null) => {
        if (cancelled || !vault?.captures?.length) return;
        setCaptures((current) => {
          const merged = new Map<number, Capture>();
          for (const capture of current) merged.set(capture.id, capture);
          for (const capture of vault.captures ?? []) merged.set(capture.id, sanitizeLocalCapture(capture));
          return rankCaptures(Array.from(merged.values()));
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authUser]);
  React.useEffect(() => {
    if (!authUser) return;
    if (!profileSyncReady.current) {
      profileSyncReady.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      void fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: profile.name,
          city: profile.city,
          locationLabel: profile.locationLabel,
          latitude: profile.latitude,
          longitude: profile.longitude,
          currency: profile.currency,
        }),
      }).catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [authUser, profile.city, profile.currency, profile.latitude, profile.locationLabel, profile.longitude, profile.name]);
  React.useEffect(() => {
    let cancelled = false;
    void fetch("/api/brain")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("vault unavailable")))
      .then((data: { captures?: Capture[] }) => {
        if (cancelled || !Array.isArray(data.captures)) return;
        setCaptures((current) => mergeCapturesById(current, data.captures ?? []));
      })
      .catch(() => undefined);
    const pullRecentCaptures = () => {
      void fetch("/api/captures/recent?limit=40")
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("recent captures unavailable")))
        .then((data: { captures?: Capture[] }) => {
          if (cancelled || !Array.isArray(data.captures)) return;
          setCaptures((current) => mergeCapturesById(current, data.captures ?? []));
        })
        .catch(() => undefined);
    };
    pullRecentCaptures();
    const timer = window.setInterval(pullRecentCaptures, 4500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  React.useEffect(() => {
    captures.filter((capture) => capture.type === "Place" && !capture.place).forEach((capture) => {
      void enrichPlaceApi(`${capture.title} ${capture.metadata.join(" ")}`).then((place) => {
        if (!place) return;
        setCaptures((current) => current.map((item) => item.id === capture.id ? { ...item, title: place.name || item.title, place, metadata: Array.from(new Set([...item.metadata, "Google Places"])) } : item));
      });
    });
  }, [captures]);
  React.useEffect(() => {
    if (!pluginSettings.smartReminders || !pluginSettings.dueDates || typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") void Notification.requestPermission().catch(() => undefined);
    const notifiedKey = "nube-notified-reminders";
    const readNotified = () => {
      try {
        return new Set<string>(JSON.parse(localStorage.getItem(notifiedKey) || "[]") as string[]);
      } catch {
        return new Set<string>();
      }
    };
    const writeNotified = (ids: Set<string>) => localStorage.setItem(notifiedKey, JSON.stringify(Array.from(ids).slice(-120)));
    const checkReminders = () => {
      if (Notification.permission !== "granted") return;
      const now = Date.now();
      const windowEnd = now + 15 * 60 * 1000;
      const notified = readNotified();
      captures
        .filter((capture) => capture.due && !capture.completed)
        .forEach((capture) => {
          const dueAt = parseDueDate(capture.due).getTime();
          if (Number.isNaN(dueAt) || dueAt > windowEnd || dueAt < now - 60 * 60 * 1000) return;
          const id = `${capture.id}:${capture.due}`;
          if (notified.has(id)) return;
          notified.add(id);
          new Notification(capture.starred ? `Starred reminder: ${capture.title}` : `Nube reminder: ${capture.title}`, {
            body: dueAt <= now ? "This capture is due now." : `Due ${formatDue(capture.due)}.`,
            tag: id,
            silent: false,
          });
        });
      writeNotified(notified);
    };
    checkReminders();
    const timer = window.setInterval(checkReminders, 60_000);
    return () => window.clearInterval(timer);
  }, [captures, pluginSettings.dueDates, pluginSettings.smartReminders]);

  const updateCapture = (id: number, patch: Partial<Capture>) => setCaptures((current) => current.map((capture) => {
    const next = capture.id === id ? { ...capture, ...patch } : capture;
    return patch.metadata ? { ...next, metadata: visibleCaptureTags(patch.metadata) } : next;
  }));
  const trashCapture = (capture: Capture) => updateCapture(capture.id, { deletedAt: new Date().toISOString(), archived: false });
  const restoreCapture = (capture: Capture) => updateCapture(capture.id, { deletedAt: undefined });
  const deleteCaptureForever = (capture: Capture) => setCaptures((current) => current.filter((item) => item.id !== capture.id));
  const isCaptureUnlocked = (capture: Capture) => !capture.private || unlockedPrivateIds.has(capture.id);
  const unlockCapture = (capture: Capture, onSuccess?: () => void) => {
    if (!capture.private) return true;
    if (unlockedPrivateIds.has(capture.id)) return true;
    if (!privatePinHash) {
      localStorage.setItem("nube-settings-tab", "Data & Privacy");
      setView("Settings");
      return false;
    }
    setPrivateUnlockDraft("");
    setPrivateUnlockError("");
    setPrivateUnlockRequest({ capture, onSuccess });
    return false;
  };
  const lockCapture = async (capture: Capture, forceEncrypt = false) => {
    if (!privatePinHash) {
      localStorage.setItem("nube-settings-tab", "Data & Privacy");
      setView("Settings");
      return;
    }
    if (!privateSessionPin || hashPrivatePin(privateSessionPin) !== privatePinHash) {
      setPrivateUnlockDraft("");
      setPrivateUnlockError("");
      setPrivateUnlockRequest({ capture: { ...capture, private: true }, onSuccess: () => void lockCapture(capture, forceEncrypt) });
      return;
    }
    try {
      const privateEncryptedData = !forceEncrypt && capture.privateEncryptedData ? capture.privateEncryptedData : await encryptPrivatePayload(capture, privateSessionPin);
      updateCapture(capture.id, {
        ...maskPrivateCaptureForStorage(capture),
        private: true,
        privateEncryptedData,
        privateEncryptedAt: new Date().toISOString(),
      });
      setUnlockedPrivateIds((current) => {
        const next = new Set(current);
        next.delete(capture.id);
        return next;
      });
    } catch {
      setPrivateUnlockError("Private encryption is not available in this browser.");
    }
  };
  const setPrivatePin = (pin: string) => {
    const clean = pin.trim();
    if (clean.length < 4) return false;
    setPrivatePinHash(hashPrivatePin(clean));
    return true;
  };
  const confirmPrivateUnlock = () => {
    if (!privateUnlockRequest) return;
    const pin = privateUnlockDraft.trim();
    if (hashPrivatePin(pin) !== privatePinHash) {
      setPrivateUnlockError("That PIN does not match.");
      return;
    }
    const request = privateUnlockRequest;
    const finish = (patch: Partial<Capture> = {}) => {
      setPrivateSessionPin(pin);
      if (request.capture.privateEncryptedData) updateCapture(request.capture.id, { ...patch, private: true });
      setUnlockedPrivateIds((current) => new Set([...current, request.capture.id]));
      setPrivateUnlockRequest(null);
      setPrivateUnlockDraft("");
      setPrivateUnlockError("");
      request.onSuccess?.();
    };
    if (!request.capture.privateEncryptedData) {
      finish();
      return;
    }
    void decryptPrivatePayload(request.capture.privateEncryptedData, pin)
      .then((payload) => finish(payload))
      .catch(() => setPrivateUnlockError("That PIN could not decrypt this capture."));
  };
  const addCapture = async (text: string, source = "universal input", overrides: Partial<Capture> = {}) => {
    const isVoice = source.toLowerCase() === "voice note";
    const localType = overrides.type ?? (isVoice ? "Audio" : classifyCapture(text));
    const intentCapture = !isVoice ? buildIntentCapture(text, source, localType) : null;
    const shouldStar = overrides.starred ?? wantsStar(text);
    const inferredPriority = overrides.priority ?? inferPriorityFromText(text);
    const intentDue = intentCapture && "due" in intentCapture ? intentCapture.due as string | undefined : undefined;
    const inferredDue = overrides.due ?? intentDue ?? inferDueFromText(text);
    const taskStartTime = overrides.taskStartTime ?? intentCapture?.taskStartTime;
    const taskEndTime = overrides.taskEndTime ?? intentCapture?.taskEndTime;
    const splitText = splitCaptureText(text, isVoice ? "Voice note" : "Untitled capture");
    const localId = Date.now();
    const localCapture: Capture = {
      id: localId,
      title: overrides.title ?? intentCapture?.title ?? splitText.title,
      text: overrides.text ?? intentCapture?.text ?? splitText.body,
      type: overrides.type ?? intentCapture?.type ?? localType,
      source,
      time: "Now",
      metadata: visibleCaptureTags([...(overrides.metadata ?? []), ...(intentCapture?.metadata ?? []), ...metadataFor(text, intentCapture?.type ?? localType)]),
      createdAt: new Date().toISOString(),
      due: inferredDue,
      taskStartTime,
      taskEndTime,
      priority: inferredPriority,
      starred: shouldStar,
      suggestedAction: usefulSuggestedAction(inferredDue ? undefined : localType === "Actionable" ? "Add this to Today" : undefined),
      provider: "browser-fallback",
      confidence: 0.62,
      imageUrl: overrides.imageUrl,
      attachmentName: overrides.attachmentName,
      attachments: overrides.attachments,
      checklistItems: overrides.checklistItems ?? intentCapture?.checklistItems,
    };
    const extraLocalCaptures = (intentCapture?.extraDueDates ?? []).map((due, index) => ({
      ...localCapture,
      id: localId + index + 1,
      due,
      createdAt: new Date(Date.now() + index + 1).toISOString(),
      calendar: undefined,
    }));
    setCaptures((current) => [localCapture, ...extraLocalCaptures, ...current]);

    const ai = isVoice ? null : await classifyCaptureWithApi(text, source);
    if (!ai) return localId;
    const type = overrides.type ?? intentCapture?.type ?? ai?.type ?? classifyCapture(text);
    const capture: Capture = {
      id: localId,
      title: overrides.title ?? intentCapture?.title ?? splitText.title,
      text: overrides.text ?? intentCapture?.text ?? splitText.body,
      type,
      source,
      time: "Now",
      metadata: visibleCaptureTags([...(overrides.metadata ?? []), ...(intentCapture?.metadata ?? []), ...(ai?.metadata ?? metadataFor(text, type))]),
      createdAt: new Date().toISOString(),
      due: inferredDue ?? ai?.due ?? undefined,
      taskStartTime,
      taskEndTime,
      priority: overrides.priority ?? ai?.priority ?? inferredPriority,
      starred: shouldStar,
      suggestedAction: usefulSuggestedAction(inferredDue || ai?.due ? undefined : ai?.suggestedAction ?? (type === "Actionable" ? "Add this to Today" : undefined)),
      provider: ai?.provider ?? "browser-fallback",
      confidence: ai?.confidence ?? 0.62,
      imageUrl: overrides.imageUrl,
      attachmentName: overrides.attachmentName,
      attachments: overrides.attachments,
      checklistItems: overrides.checklistItems ?? intentCapture?.checklistItems,
    };
    setCaptures((current) => current.map((item) => item.id === localId ? capture : item));
    return localId;
  };

  const continueLocally = () => {
    localStorage.setItem("nube-local-mode", "true");
    setLocalMode(true);
    setWelcomePreview(false);
  };
  const appState = { captures, setCaptures, updateCapture, trashCapture, restoreCapture, deleteCaptureForever, addCapture, setSelectedCapture, setPreviewImage, setView, setInsightsOpen, collectionFilter, setCollectionFilter, dateFilter, setDateFilter, profile, setProfile, authUser, setAuthUser, googleConfigured, tagColors, setTagColors, aiReview, pluginSettings, setPluginSettings, syncStatus, privatePinHash, setPrivatePinHash, setPrivateSessionPin, setPrivatePin, isCaptureUnlocked, unlockCapture, lockCapture };
  const Screen = view === "Collections" ? CollectionsView : view === "Settings" ? SettingsView : view === "Upgrade" ? UpgradeView : InboxView;

  if (!authChecked) return <AuthSplash loading googleConfigured={googleConfigured} onContinueLocally={continueLocally} />;
  if (welcomePreview) return <AuthSplash googleConfigured={googleConfigured} onContinueLocally={() => setWelcomePreview(false)} />;
  if (!authUser && !localMode) return <AuthSplash googleConfigured={googleConfigured} onContinueLocally={continueLocally} />;

  return (
    <BrainContext.Provider value={appState}>
      <div className={`app-shell ${pluginSettings.smartReminders ? "smart-reminders-on" : "smart-reminders-off"}`}>
        <DesktopTopbar view={view} profile={profile} setView={setView} setCollectionFilter={setCollectionFilter} setDateFilter={setDateFilter} setHelpOpen={setHelpOpen} />
        <main className={`main ${view !== "Inbox" ? "wide-main" : ""}`}><section className="screen"><Screen /></section></main>
        <MobileBottomDock view={view} profile={profile} setView={setView} setCollectionFilter={setCollectionFilter} setDateFilter={setDateFilter} setHelpOpen={setHelpOpen} />
        {view === "Inbox" && <ContextRail captures={captures} />}
      </div>
      <AnimatePresence>{insightsOpen && <motion.div className="overlay-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setInsightsOpen(false)}><motion.div className="insights-modal" initial={{ opacity: 0, y: 18, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 18, scale: .98 }} transition={{ duration: .18 }} onClick={(event) => event.stopPropagation()}><div className="modal-topline"><p className="eyebrow">Insights</p><button onClick={() => setInsightsOpen(false)}><X size={18} /></button></div><BrainInsights /></motion.div></motion.div>}</AnimatePresence>
      <AnimatePresence>{helpOpen && <motion.div className="overlay-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setHelpOpen(false)}><motion.div className="help-modal" initial={{ opacity: 0, y: 18, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 18, scale: .98 }} transition={{ duration: .18 }} onClick={(event) => event.stopPropagation()}><div className="modal-topline"><p className="eyebrow">Help center</p><button onClick={() => setHelpOpen(false)}><X size={18} /></button></div><HelpCenter /></motion.div></motion.div>}</AnimatePresence>
      <AnimatePresence>{selectedCapture && <DetailModal capture={selectedCapture} />}</AnimatePresence>
      <AnimatePresence>{previewImage && <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />}</AnimatePresence>
      <AnimatePresence>{privateUnlockRequest && <PrivateUnlockModal
        capture={privateUnlockRequest.capture}
        value={privateUnlockDraft}
        error={privateUnlockError}
        onChange={(value) => { setPrivateUnlockDraft(value); setPrivateUnlockError(""); }}
        onClose={() => { setPrivateUnlockRequest(null); setPrivateUnlockDraft(""); setPrivateUnlockError(""); }}
        onConfirm={confirmPrivateUnlock}
        onReset={() => { localStorage.setItem("nube-settings-tab", "Data & Privacy"); setPrivateUnlockRequest(null); setPrivateUnlockDraft(""); setPrivateUnlockError(""); setView("Settings"); }}
      />}</AnimatePresence>
    </BrainContext.Provider>
  );
}

function DesktopTopbar({ view, profile, setView, setCollectionFilter, setDateFilter, setHelpOpen }: { view: View; profile: Profile; setView: (view: View) => void; setCollectionFilter: (filter: CollectionFilter) => void; setDateFilter: (filter: DateFilter) => void; setHelpOpen: (open: boolean) => void }) {
  const goInbox = () => {
    setCollectionFilter(null);
    setDateFilter(null);
    setView("Inbox");
  };
  return (
    <header className="topbar">
      <nav className="topbar-left">
        <button className={`topbar-icon-pill ${view === "Inbox" ? "active" : ""}`} onClick={goInbox} title="Inbox"><Cloud size={18} /><span>Inbox</span></button>
        <button className={`topbar-icon-pill ${view === "Collections" ? "active" : ""}`} onClick={() => setView("Collections")} title="Collections"><Archive size={18} /><span>Collections</span></button>
      </nav>
      <button className="topbar-brand" onClick={goInbox}><span>Nube</span></button>
      <nav className="topbar-right">
        <button className={`topbar-icon-pill ${view === "Upgrade" ? "active" : ""}`} onClick={() => setView("Upgrade")} title="Upgrade"><Star size={18} /><span>Upgrade</span></button>
        <button className="topbar-icon-pill" onClick={() => setHelpOpen(true)} title="Help"><BookOpen size={18} /><span>Help</span></button>
        <button className={`topbar-icon-pill ${view === "Settings" ? "active" : ""}`} onClick={() => setView("Settings")} title="Settings"><Settings size={18} /><span>Settings</span></button>
        <button className="avatar-shell" onClick={() => setView("Settings")} title="Profile"><Avatar profile={profile} size="button" /></button>
      </nav>
    </header>
  );
}

function MobileBottomDock({ view, profile, setView, setCollectionFilter, setDateFilter, setHelpOpen }: { view: View; profile: Profile; setView: (view: View) => void; setCollectionFilter: (filter: CollectionFilter) => void; setDateFilter: (filter: DateFilter) => void; setHelpOpen: (open: boolean) => void }) {
  const goInbox = () => {
    setCollectionFilter(null);
    setDateFilter(null);
    setView("Inbox");
  };
  return (
    <nav className="mobile-bottom-dock" aria-label="Mobile navigation">
      <button className={`topbar-icon-pill ${view === "Inbox" ? "active" : ""}`} onClick={goInbox} title="Inbox"><Inbox size={18} /><span>Inbox</span></button>
      <button className={`topbar-icon-pill ${view === "Collections" ? "active" : ""}`} onClick={() => setView("Collections")} title="Collections"><Archive size={18} /><span>Collections</span></button>
      <button className="topbar-icon-pill" onClick={() => setHelpOpen(true)} title="Help"><BookOpen size={18} /><span>Help</span></button>
      <button className="avatar-shell" onClick={() => setView("Settings")} title="Profile"><Avatar profile={profile} size="button" /></button>
    </nav>
  );
}

const BrainContext = React.createContext<{
  captures: Capture[];
  setCaptures: React.Dispatch<React.SetStateAction<Capture[]>>;
  updateCapture: (id: number, patch: Partial<Capture>) => void;
  trashCapture: (capture: Capture) => void;
  restoreCapture: (capture: Capture) => void;
  deleteCaptureForever: (capture: Capture) => void;
  addCapture: (text: string, source?: string, overrides?: Partial<Capture>) => Promise<number>;
  setSelectedCapture: (capture: Capture | null) => void;
  setPreviewImage: (image: { src: string; alt: string } | null) => void;
  setView: (view: View) => void;
  setInsightsOpen: (open: boolean) => void;
  collectionFilter: CollectionFilter;
  setCollectionFilter: (filter: CollectionFilter) => void;
  dateFilter: DateFilter;
  setDateFilter: (filter: DateFilter) => void;
  profile: Profile;
  setProfile: React.Dispatch<React.SetStateAction<Profile>>;
  authUser: AuthUser | null;
  setAuthUser: React.Dispatch<React.SetStateAction<AuthUser | null>>;
  googleConfigured: boolean;
  tagColors: Record<string, string>;
  setTagColors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  aiReview: AiReview;
  pluginSettings: PluginSettings;
  setPluginSettings: React.Dispatch<React.SetStateAction<PluginSettings>>;
  syncStatus: SyncQueueSnapshot;
  privatePinHash: string;
  setPrivatePinHash: React.Dispatch<React.SetStateAction<string>>;
  setPrivateSessionPin: React.Dispatch<React.SetStateAction<string>>;
  setPrivatePin: (pin: string) => boolean;
  isCaptureUnlocked: (capture: Capture) => boolean;
  unlockCapture: (capture: Capture, onSuccess?: () => void) => boolean;
  lockCapture: (capture: Capture, forceEncrypt?: boolean) => Promise<void>;
} | null>(null);
const useBrain = () => {
  const value = React.useContext(BrainContext);
  if (!value) throw new Error("Brain context missing");
  return value;
};

const priorityLabel = (priority?: Priority | "No priority") => priority === "Medium" ? "Med" : priority ?? "";

function OptionPicker<T extends string>({ value, options, onChange, label, formatLabel = (option) => option }: { value: T; options: T[]; onChange: (value: T) => void; label: string; formatLabel?: (value: T) => string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="option-picker">
      {label && <span className="option-picker-label">{label}</span>}
      <button className={open ? "open" : ""} onClick={() => setOpen((current) => !current)}>{formatLabel(value)}<ChevronDown size={15} /></button>
      {open && <div className="option-menu">{options.map((option) => <button key={option} className={option === value ? "selected" : ""} onClick={() => { onChange(option); setOpen(false); }}>{formatLabel(option)}</button>)}</div>}
    </div>
  );
}

function NubeDatePicker({ label, value, onChange }: { label: string; value?: string; onChange: (value: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const selected = value ? parseDueDate(value) : null;
  const selectedTime = selected && !Number.isNaN(selected.getTime()) ? selected.getTime() : 0;
  const [visibleMonth, setVisibleMonth] = React.useState(() => selected && !Number.isNaN(selected.getTime()) ? selected : new Date());
  React.useEffect(() => {
    if (selectedTime) setVisibleMonth(new Date(selectedTime));
  }, [selectedTime]);
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(year, month, index - startOffset + 1);
    return day.getMonth() === month ? day : null;
  });
  const selectedKey = selectedTime ? dateKey(new Date(selectedTime)) : "";
  const today = dateKey(new Date());
  return (
    <div className="nube-date-picker">
      <span>{label}</span>
      <button className={open ? "open" : ""} onClick={() => setOpen((current) => !current)}>
        {selectedKey ? selected?.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "No date"}
        <CalendarCheck size={15} />
      </button>
      {open && (
        <div className="nube-date-menu">
          <div className="nube-date-head">
            <strong>{visibleMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong>
            <div>
              <button onClick={() => setVisibleMonth(new Date(year, month - 1, 1))}><ArrowUp size={15} /></button>
              <button onClick={() => setVisibleMonth(new Date(year, month + 1, 1))}><ArrowUp size={15} /></button>
            </div>
          </div>
          <div className="nube-date-weekdays">{["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
          <div className="nube-date-grid">
            {days.map((day, index) => {
              const key = day ? dateKey(day) : `empty-${index}`;
              return day ? (
                <button className={`${key === today ? "today" : ""} ${key === selectedKey ? "active" : ""}`} key={key} onClick={() => { onChange(key); setOpen(false); }}>
                  {day.getDate()}
                </button>
              ) : <span key={key} />;
            })}
          </div>
          <div className="nube-date-actions">
            <button onClick={() => { onChange(today); setOpen(false); }}>Today</button>
            <button onClick={() => { onChange(""); setOpen(false); }}>Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NubeTimePicker({ label, value, onChange }: { label: string; value?: string; onChange: (value: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [hour, minute] = (value || "09:00").split(":").map((part) => Number(part));
  const hours = Array.from({ length: 24 }, (_, index) => index);
  const minutes = Array.from({ length: 12 }, (_, index) => index * 5);
  const formatPart = (part: number) => String(part).padStart(2, "0");
  const setTime = (nextHour: number, nextMinute: number) => onChange(`${formatPart(nextHour)}:${formatPart(nextMinute)}`);
  return (
    <div className="nube-time-picker">
      <span className="time-picker-label">{label}</span>
      <button className={open ? "open" : ""} onClick={() => setOpen((current) => !current)} type="button">
        {value || "--:--"}
        <Clock3 size={15} />
      </button>
      {open && <div className="nube-time-menu">
        <div className="nube-time-columns">
          <div>
            <small>Hour</small>
            <div className="nube-time-scroll">
              {hours.map((item) => <button className={item === hour ? "active" : ""} key={item} onClick={() => setTime(item, Number.isFinite(minute) ? minute : 0)} type="button">{formatPart(item)}</button>)}
            </div>
          </div>
          <div>
            <small>Minute</small>
            <div className="nube-time-scroll">
              {minutes.map((item) => <button className={item === minute ? "active" : ""} key={item} onClick={() => setTime(Number.isFinite(hour) ? hour : 9, item)} type="button">{formatPart(item)}</button>)}
            </div>
          </div>
        </div>
        <div className="nube-time-actions">
          <button onClick={() => { onChange(""); setOpen(false); }} type="button">Clear</button>
          <button onClick={() => setOpen(false)} type="button">Done</button>
        </div>
      </div>}
    </div>
  );
}

function InboxView() {
  const { captures, setCaptures, updateCapture, addCapture, setSelectedCapture, setInsightsOpen, collectionFilter, setCollectionFilter, dateFilter, setDateFilter, tagColors, profile, aiReview, pluginSettings, isCaptureUnlocked } = useBrain();
  const [draft, setDraft] = React.useState("");
  const [mode, setMode] = React.useState<"capture" | "search">("capture");
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [listMode, setListMode] = React.useState<"captures" | "tasks">("captures");
  const [typeFilter, setTypeFilter] = React.useState<CaptureType | "All">("All");
  const [priorityFilter, setPriorityFilter] = React.useState<Priority | "All">("All");
  const [starFilter, setStarFilter] = React.useState<"All" | "Starred">("All");
  const [assetFilter, setAssetFilter] = React.useState<"All" | "Images" | "Files" | "Audio" | "Places" | "Links">("All");
  const [moneyFilter, setMoneyFilter] = React.useState<"All" | "Income" | "Expenses">("All");
  const [statusFilter, setStatusFilter] = React.useState<"All" | "Open" | "Done" | "Archived" | "Trash">("All");
  const [uploadStatus, setUploadStatus] = React.useState<string | null>(null);
  const [moneyExpanded, setMoneyExpanded] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [askAnswer, setAskAnswer] = React.useState<AskNubeResponse | null>(null);
  const [askLoading, setAskLoading] = React.useState(false);
  const [calendarImporting, setCalendarImporting] = React.useState(false);
  const [captureStatus, setCaptureStatus] = React.useState<string | null>(null);
  const [, setClockTick] = React.useState(0);
  const [isListening, setIsListening] = React.useState(false);
  const [activeVoiceMode, setActiveVoiceMode] = React.useState<"smart" | "audio-only" | null>(null);
  const [voiceLevels, setVoiceLevels] = React.useState<number[]>(() => Array.from({ length: 28 }, () => 8));
  const [pendingVoiceAttachment, setPendingVoiceAttachment] = React.useState<Attachment | null>(() => {
    try {
      const saved = localStorage.getItem(PENDING_VOICE_KEY);
      return saved ? JSON.parse(saved) as Attachment : null;
    } catch {
      return null;
    }
  });
  const [voiceMenuOpen, setVoiceMenuOpen] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const inboxCalendarInput = React.useRef<HTMLInputElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const voiceRecognition = React.useRef<{ start: () => void; stop: () => void } | null>(null);
  const voiceRecorder = React.useRef<MediaRecorder | null>(null);
  const voiceStream = React.useRef<MediaStream | null>(null);
  const voiceChunks = React.useRef<Blob[]>([]);
  const voiceAudioContext = React.useRef<AudioContext | null>(null);
  const voiceAnalyserFrame = React.useRef<number | null>(null);
  const stopVoiceRequested = React.useRef(false);
  const voiceDraftActive = React.useRef(false);
  const uploadQueueActive = React.useRef(false);
  React.useEffect(() => {
    if (pendingVoiceAttachment) localStorage.setItem(PENDING_VOICE_KEY, JSON.stringify(pendingVoiceAttachment));
    else localStorage.removeItem(PENDING_VOICE_KEY);
  }, [pendingVoiceAttachment]);
  React.useEffect(() => {
    const clock = window.setInterval(() => {
      setClockTick((tick) => tick + 1);
    }, 60_000);
    return () => window.clearInterval(clock);
  }, []);
  React.useEffect(() => {
    if (!isListening || !input.current) return;
    const field = input.current;
    window.requestAnimationFrame(() => {
      const end = field.value.length;
      field.focus();
      field.setSelectionRange(end, end);
      field.scrollLeft = field.scrollWidth;
    });
  }, [draft, isListening]);
  const readFileDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const readBlobDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const stopVoiceAnalyser = () => {
    if (voiceAnalyserFrame.current !== null) {
      window.cancelAnimationFrame(voiceAnalyserFrame.current);
      voiceAnalyserFrame.current = null;
    }
    const context = voiceAudioContext.current;
    voiceAudioContext.current = null;
    if (context && context.state !== "closed") void context.close();
    setVoiceLevels(Array.from({ length: 28 }, () => 8));
  };
  const startVoiceAnalyser = (stream: MediaStream) => {
    stopVoiceAnalyser();
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = new AudioContextCtor();
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.72;
    context.createMediaStreamSource(stream).connect(analyser);
    voiceAudioContext.current = context;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const sampleBars = () => {
      analyser.getByteFrequencyData(data);
      const bars = 28;
      const bucket = Math.max(1, Math.floor(data.length / bars));
      const globalAverage = data.reduce((sum, value) => sum + value, 0) / Math.max(1, data.length);
      const next = Array.from({ length: bars }, (_, index) => {
        const start = index * bucket;
        const slice = data.slice(start, start + bucket);
        const localAverage = slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
        const blended = localAverage * 0.35 + globalAverage * 0.65;
        return Math.round(5 + Math.min(0.68, Math.sqrt(blended / 190)) * 24);
      });
      setVoiceLevels(next);
      voiceAnalyserFrame.current = window.requestAnimationFrame(sampleBars);
    };
    sampleBars();
  };
  const processUploadQueue = React.useCallback(async () => {
    if (uploadQueueActive.current || (typeof navigator !== "undefined" && !navigator.onLine)) return;
    let queue = readUploadQueue();
    const ready = queue.find((item) => !item.nextAttemptAt || item.nextAttemptAt <= Date.now());
    if (!ready) return;
    uploadQueueActive.current = true;
    setUploadStatus(`Retrying ${ready.name}...`);
    try {
      const blob = await dataUrlToBlob(ready.dataUrl);
      const data = new FormData();
      data.append("file", new File([blob], ready.name, { type: ready.mimeType }));
      const response = await fetch("/api/ingest", { method: "POST", body: data });
      if (!response.ok) throw new Error("Upload retry failed");
      const result = await response.json() as IngestResult;
      updateCapture(ready.captureId, {
        type: result.classification.type,
        metadata: visibleCaptureTags(result.classification.metadata),
        imageUrl: result.fileUrl ?? ready.dataUrl,
        attachmentName: result.filename,
        attachmentSize: result.size,
        provider: result.classification.provider ?? "local-fallback",
      });
      queue = readUploadQueue().filter((item) => item.id !== ready.id);
      writeUploadQueue(queue);
      setUploadStatus(`${ready.name} uploaded and indexed.`);
    } catch {
      queue = readUploadQueue().map((item) => {
        if (item.id !== ready.id) return item;
        const retries = item.retries + 1;
        return { ...item, retries, nextAttemptAt: Date.now() + Math.min(60_000, 2000 * 2 ** retries) };
      }).filter((item) => item.retries < 6);
      writeUploadQueue(queue);
      setUploadStatus(queue.some((item) => item.id === ready.id) ? `${ready.name} is queued for retry.` : `${ready.name} could not be uploaded after multiple retries.`);
    } finally {
      uploadQueueActive.current = false;
      window.setTimeout(() => setUploadStatus(null), 3500);
    }
  }, [updateCapture]);
  React.useEffect(() => {
    const timer = window.setInterval(() => void processUploadQueue(), 5000);
    const online = () => void processUploadQueue();
    window.addEventListener("online", online);
    void processUploadQueue();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", online);
    };
  }, [processUploadQueue]);
  const allTags = Array.from(new Set([...presetTags, ...captures.flatMap((capture) => visibleCaptureTags(capture.metadata))])).sort((a, b) => a.localeCompare(b));
  const visibleSignalCaptures = captures.filter(isCaptureUnlocked);
  const moneySignals = pluginSettings.receiptScanner && pluginSettings.receiptMoneySignals ? moneySignalsFor(visibleSignalCaptures) : [];
  const moneyTotals = {
    income: moneySignals.filter((signal) => signal.direction === "income").reduce((sum, signal) => sum + signal.amount, 0),
    expense: moneySignals.filter((signal) => signal.direction === "expense").reduce((sum, signal) => sum + signal.amount, 0),
    review: moneySignals.filter((signal) => signal.direction === "review").reduce((sum, signal) => sum + signal.amount, 0),
  };
  const displayedMoneySignals = moneyExpanded ? moneySignals : moneySignals.slice(0, 3);
  const storageUsedBytes = estimateStorageBytes(captures);
  const storageLimitBytes = fallbackPlanCatalog.free.storageGb * 1024 * 1024 * 1024;
  const trashCount = captures.filter((capture) => capture.deletedAt).length;
  const emptyTrash = () => {
    if (!trashCount) return;
    if (!window.confirm(`Delete ${trashCount} trashed capture${trashCount === 1 ? "" : "s"} forever?`)) return;
    setCaptures((current) => current.filter((capture) => !capture.deletedAt));
    setCaptureStatus("Trash emptied.");
  };
  const storagePercent = Math.min(100, Math.round(storageUsedBytes / storageLimitBytes * 100));
  const storageBarPercent = storageUsedBytes > 0 ? Math.max(1, storagePercent) : 0;

  const starterPrompts = [
    { icon: ReceiptText, label: "Spent 38 EUR on fuel", text: "Spent 38 EUR on fuel this morning" },
    { icon: CheckCircle2, label: "Call Luca tomorrow", text: "Call Luca tomorrow morning about the gym contract" },
    { icon: MapPin, label: "Restaurant to try", text: "Osteria della Valle in Milan, place to try" },
    { icon: BookOpen, label: "Study note", text: "Save this PDF for my course notes" },
  ];
  const submit = async () => {
    if ((!draft.trim() && !pendingVoiceAttachment) || mode === "search") return;
    const text = draft.trim() || "Voice note";
    const source = voiceDraftActive.current || pendingVoiceAttachment ? "voice note" : "universal input";
    const voiceAttachment = pendingVoiceAttachment;
    const taskModeOverride = listMode === "tasks" && !voiceAttachment ? { type: "Actionable" as CaptureType, metadata: ["Task"] } : {};
    setDraft("");
    setPendingVoiceAttachment(null);
    voiceDraftActive.current = false;
    setIsCreating(true);
    setCaptureStatus("Captured. Nube is organizing it...");
    const audioOnly = Boolean(voiceAttachment) && !draft.trim();
    await addCapture(text, source, voiceAttachment ? {
      ...(audioOnly ? { title: pendingVoiceAttachment?.title ?? "Voice note", text: "", type: "Audio" as CaptureType, provider: "browser-fallback" as const } : { type: "Audio" as CaptureType }),
      metadata: ["Voice note"],
      attachments: [voiceAttachment],
      attachmentName: voiceAttachment.name,
      attachmentSize: voiceAttachment.size,
    } : taskModeOverride);
    setIsCreating(false);
    setCaptureStatus("Ready.");
    window.setTimeout(() => setCaptureStatus(null), 1800);
  };
  const runAskSearch = async () => {
    const question = draft.trim();
    if (!question || askLoading) return;
    setAskLoading(true);
    setAskAnswer(null);
    try {
      setAskAnswer(await askNube(question, captures));
    } catch {
      const fallback = orderedFiltered.slice(0, 3);
      setAskAnswer({
        answer: fallback.length ? `I searched locally and found ${fallback.length} relevant capture${fallback.length === 1 ? "" : "s"}.` : "I could not reach AI and local search found no matching captures.",
        related: fallback.map((capture) => ({ id: capture.id, title: capture.title, type: capture.type })),
        provider: "local-fallback",
      });
    } finally {
      setAskLoading(false);
    }
  };
  const uploadFiles = (files: FileList | null) => Array.from(files ?? []).forEach(async (file) => {
    setUploadStatus(`Uploading ${file.name}...`);
    const isImage = file.type.startsWith("image/");
    const fileDataUrl = await readFileDataUrl(file).catch(() => undefined);
    const imageUrl = isImage ? fileDataUrl : undefined;
    const data = new FormData();
    data.append("file", file);
    try {
      const response = await fetch("/api/ingest", { method: "POST", body: data });
      if (!response.ok) throw new Error("Upload failed");
      const result = await response.json() as IngestResult;
      await addCapture(`Indexed file: ${result.filename}\n\n${result.extractedText}`, `${result.kind} upload`, {
        type: result.classification.type,
        metadata: visibleCaptureTags(result.classification.metadata),
        imageUrl: result.fileUrl ?? imageUrl,
        attachmentName: file.name,
        attachmentSize: result.size,
      });
      setUploadStatus(result.storage === "cloudflare-r2" ? `${file.name} indexed and saved to cloud storage.` : `${file.name} indexed.`);
    } catch {
      const captureId = await addCapture(`Indexed file: ${file.name} (${Math.round(file.size / 1024)} KB)`, isImage ? "image upload" : "file upload", {
        type: isImage ? "Document" : undefined,
        metadata: isImage ? ["Document"] : undefined,
        imageUrl,
        attachmentName: file.name,
        attachmentSize: file.size,
      });
      if (fileDataUrl && file.size <= MAX_QUEUED_UPLOAD_BYTES) {
        enqueueUploadRetry({
          id: `${captureId}-${file.name}-${file.size}`,
          captureId,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          dataUrl: fileDataUrl,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
        void processUploadQueue();
        setUploadStatus(`${file.name} added locally and queued for upload.`);
      } else {
        setUploadStatus(`${file.name} added locally. File is too large for browser retry queue.`);
      }
    }
    window.setTimeout(() => setUploadStatus(null), 4000);
  });
  const startVoiceInput = async (voiceMode: "smart" | "audio-only" = "smart") => {
    type BrowserSpeechRecognition = {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onstart: (() => void) | null;
      onerror: ((event: { error?: string }) => void) | null;
      onend: (() => void) | null;
      onresult: ((event: { resultIndex?: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null;
      start: () => void;
      stop: () => void;
    };
    if (isListening) {
      stopVoiceRequested.current = true;
      voiceRecognition.current?.stop();
      if (voiceRecorder.current?.state === "recording") voiceRecorder.current.stop();
      stopVoiceAnalyser();
      setIsListening(false);
      setActiveVoiceMode(null);
      setCaptureStatus("Voice capture stopped.");
      window.setTimeout(() => setCaptureStatus(null), 1600);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setCaptureStatus("Audio recording is not supported in this browser.");
      window.setTimeout(() => setCaptureStatus(null), 2600);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStream.current = stream;
      voiceChunks.current = [];
      startVoiceAnalyser(stream);
      const recorder = new MediaRecorder(stream);
      voiceRecorder.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) voiceChunks.current.push(event.data);
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(voiceChunks.current, { type: mimeType });
        const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
        void readBlobDataUrl(blob).then((dataUrl) => {
          setPendingVoiceAttachment({
            id: `${Date.now()}-voice-note`,
            name: `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
            title: "Voice note",
            mimeType,
            size: blob.size,
            dataUrl,
          });
          setCaptureStatus(voiceMode === "audio-only" ? "Audio saved. Press send to capture it." : "Voice audio saved. Press send to capture it.");
          window.setTimeout(() => setCaptureStatus(null), 2600);
        });
        stream.getTracks().forEach((track) => track.stop());
        stopVoiceAnalyser();
        voiceRecorder.current = null;
        voiceStream.current = null;
        voiceChunks.current = [];
      };
      recorder.start();
    } catch {
      setCaptureStatus("Microphone permission is blocked.");
      window.setTimeout(() => setCaptureStatus(null), 2600);
      return;
    }
    setActiveVoiceMode(voiceMode);
    if (voiceMode === "audio-only") {
      setIsListening(true);
      setCaptureStatus("Recording audio only...");
      return;
    }
    const SpeechRecognition = (window as unknown as { SpeechRecognition?: new () => BrowserSpeechRecognition; webkitSpeechRecognition?: new () => BrowserSpeechRecognition }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => BrowserSpeechRecognition }).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setIsListening(true);
      setCaptureStatus("Recording audio...");
      return;
    }
    const recognition = new SpeechRecognition();
    voiceRecognition.current = recognition;
    stopVoiceRequested.current = false;
    const baseDraft = draft.trim();
    const committedSegments = new Map<number, string>();
    let heardWords = false;
    recognition.lang = "it-IT";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onstart = () => {
      setIsListening(true);
      setCaptureStatus("Listening...");
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" && !stopVoiceRequested.current) {
        setCaptureStatus("Still listening...");
        return;
      }
      stopVoiceRequested.current = true;
      setIsListening(false);
      setActiveVoiceMode(null);
      if (voiceRecorder.current?.state === "recording") voiceRecorder.current.stop();
      stopVoiceAnalyser();
      setCaptureStatus(event.error === "not-allowed" ? "Microphone permission is blocked." : "No voice captured. Check microphone permission and try again.");
      window.setTimeout(() => setCaptureStatus(null), 2600);
    };
    recognition.onend = () => {
      if (!stopVoiceRequested.current) {
        window.setTimeout(() => {
          try {
            recognition.start();
          } catch {
            setIsListening(false);
          }
        }, 250);
        return;
      }
      voiceRecognition.current = null;
      setIsListening(false);
      setActiveVoiceMode(null);
      setCaptureStatus((current) => current === "Listening..." ? (heardWords ? "Voice capture added." : "No words detected.") : current);
      window.setTimeout(() => setCaptureStatus(null), 1800);
    };
    recognition.onresult = (event) => {
      let interimTranscript = "";
      for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript.trim() ?? "";
        if (!transcript) continue;
        if (result.isFinal) committedSegments.set(index, transcript);
        else interimTranscript = `${interimTranscript} ${transcript}`.trim();
      }
      const committedTranscript = Array.from(committedSegments.entries()).sort(([a], [b]) => a - b).map(([, transcript]) => transcript).join(" ");
      const voiceText = collapseRepeatedTranscript(`${committedTranscript} ${interimTranscript}`.trim());
      if (!voiceText) return;
      heardWords = true;
      voiceDraftActive.current = true;
      setDraft([baseDraft, voiceText].filter(Boolean).join(" "));
      setCaptureStatus(mode === "search" ? "Voice search listening..." : "Voice capture listening...");
    };
    recognition.start();
  };
  const clearFilters = () => {
    setTagFilter(null);
    setTypeFilter("All");
    setPriorityFilter("All");
    setStarFilter("All");
    setAssetFilter("All");
    setMoneyFilter("All");
    setStatusFilter("All");
    setCollectionFilter(null);
    setDateFilter(null);
  };
  const filtered = captures.filter((capture) => {
    const matchesCollection = !collectionFilter || collectionFilter.types.includes(capture.type);
    const matchesDate = !dateFilter || captureMatchesDate(capture, dateFilter.day);
    const matchesType = typeFilter === "All" || capture.type === typeFilter;
    const matchesPriority = priorityFilter === "All" || capture.priority === priorityFilter;
    const matchesStar = starFilter === "All" || Boolean(capture.starred);
    const matchesAsset = assetFilter === "All" || (assetFilter === "Images" && Boolean(capture.imageUrl)) || (assetFilter === "Files" && Boolean(capture.attachmentName)) || (assetFilter === "Audio" && audioAttachmentsFor(capture).length > 0) || (assetFilter === "Places" && capture.type === "Place") || (assetFilter === "Links" && capture.type === "Link");
    const signal = moneySignals.find((item) => item.id === capture.id);
    const matchesMoney = moneyFilter === "All" || (moneyFilter === "Income" && signal?.direction === "income") || (moneyFilter === "Expenses" && signal?.direction === "expense");
    const matchesDeleted = statusFilter === "Trash" ? Boolean(capture.deletedAt) : !capture.deletedAt;
    const matchesArchive = statusFilter === "Archived" ? Boolean(capture.archived) : !capture.archived;
    const matchesStatus = statusFilter === "All" || (statusFilter === "Open" && capture.type === "Actionable" && !capture.completed) || (statusFilter === "Done" && Boolean(capture.completed)) || statusFilter === "Archived" || statusFilter === "Trash";
    return matchesDeleted && matchesArchive && matchesCollection && matchesDate && matchesType && matchesPriority && matchesStar && matchesAsset && matchesMoney && matchesStatus && (!tagFilter || visibleCaptureTags(capture.metadata).includes(tagFilter)) && (mode === "capture" || searchMatchesCapture(capture, draft));
  });
  const orderedFiltered = rankCaptures(filtered);
  const taskCaptures = orderedFiltered
    .filter((capture) => capture.type === "Actionable" || Boolean(capture.due))
    .sort((a, b) => {
      const aPinned = isPinnedCapture(a);
      const bPinned = isPinnedCapture(b);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      const aDue = a.due ? parseDueDate(a.due).getTime() : Number.POSITIVE_INFINITY;
      const bDue = b.due ? parseDueDate(b.due).getTime() : Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;
      return priorityScore(b.priority) - priorityScore(a.priority);
    });
  const activeFilterCount = [tagFilter, typeFilter !== "All", priorityFilter !== "All", starFilter !== "All", assetFilter !== "All", moneyFilter !== "All", statusFilter !== "All", collectionFilter, dateFilter].filter(Boolean).length;
  const todayKey = dateKey(new Date());
  const captureSectionTitle = statusFilter === "Trash" ? "Trash" : mode === "search" ? "Search results" : dateFilter?.day === todayKey ? "Today" : dateFilter ? "Scheduled captures" : "Recent captures";
  const isTrashView = statusFilter === "Trash";
  const visibleList = isTrashView ? orderedFiltered : listMode === "tasks" ? taskCaptures : orderedFiltered;
  const visibleSectionTitle = isTrashView ? "Trash" : listMode === "tasks" ? "Tasks" : captureSectionTitle;
  const recordingBars = activeVoiceMode === "audio-only" ? voiceLevels : voiceLevels.slice(0, 7);
  const seedDraft = (text: string) => {
    setMode("capture");
    setAskAnswer(null);
    setDraft(text);
    window.setTimeout(() => input.current?.focus(), 0);
  };
  const emptyState = (() => {
    if (statusFilter === "Trash") {
      return {
        title: "Trash is empty",
        text: "Deleted captures and tasks will stay here until you restore them or delete them forever.",
      };
    }
    if (dateFilter) {
      return {
        title: dateFilter.day === todayKey ? "Nothing scheduled for today" : "Nothing scheduled here",
        text: "Pick another day, clear the date filter, or create a dated capture from the inbox.",
      };
    }
    if (mode === "search") {
      return {
        title: "No matching captures",
        text: "Try fewer words, clear the search, or ask Nube a broader question from the same input.",
      };
    }
    if (activeFilterCount > 0) {
      return {
        title: "No captures match these filters",
        text: "Loosen one filter or clear them all to return to your full inbox.",
      };
    }
    return {
      title: captures.length ? "Nothing to show here" : "Start with one capture",
      text: "Add a note, file, place, reminder, receipt, or voice note. Nube will sort it quietly.",
    };
  })();
  const statusTone = (message: string | null) => {
    const text = (message ?? "").toLowerCase();
    if (text.includes("failed") || text.includes("blocked") || text.includes("could not") || text.includes("disabled") || text.includes("error")) return "error";
    if (text.includes("ready") || text.includes("saved") || text.includes("uploaded") || text.includes("indexed") || text.includes("imported")) return "success";
    if (text.includes("queued") || text.includes("retry") || text.includes("too large") || text.includes("no events") || text.includes("no words")) return "warning";
    return "loading";
  };
  const markMoneySignal = (signal: MoneySignal, direction: MoneySignal["direction"]) => {
    const capture = captures.find((item) => item.id === signal.id);
    if (!capture) return;
    updateCapture(capture.id, {
      type: direction === "expense" ? "Expense" : capture.type,
      metadata: [...capture.metadata.filter((tag) => !tag.startsWith("Money ")), direction === "income" ? "Money income" : direction === "expense" ? "Money expense" : "Money review"],
    });
  };
  const importCalendarFileQuick = async (file: File | undefined) => {
    if (!file) return;
    const imported = parseIcsCaptures(await file.text());
    const nextCaptures: Capture[] = imported.map((item, index) => sanitizeLocalCapture({
      id: Date.now() + index,
      title: item.title ?? "Imported calendar event",
      text: item.text ?? "",
      type: "Actionable",
      source: item.source ?? "calendar import",
      time: "Now",
      metadata: item.metadata ?? ["Calendar import"],
      createdAt: new Date().toISOString(),
      due: item.due,
      priority: item.priority,
    }));
    setCaptures((current) => [...nextCaptures, ...current]);
    setCaptureStatus(nextCaptures.length ? `${nextCaptures.length} .ics event${nextCaptures.length === 1 ? "" : "s"} imported.` : "No events found in that .ics file.");
  };
  const importGoogleCalendarQuick = async () => {
    setCalendarImporting(true);
    setCaptureStatus("Importing Google Calendar events...");
    try {
      const response = await fetch("/api/calendar/import", { method: "POST" });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(error?.error || "Calendar import failed.");
      }
      const result = await response.json() as { imported: number; skipped?: number; ignored?: number; captures: Capture[] };
      const importedCaptures = (result.captures ?? []).map(sanitizeLocalCapture);
      setCaptures((current) => {
        const existingIds = new Set(current.map((capture) => capture.id));
        return [...importedCaptures.filter((capture) => !existingIds.has(capture.id)), ...current];
      });
      const ignored = result.ignored ? `, ${result.ignored} birthday/cancelled ignored` : "";
      setCaptureStatus(result.imported ? `${result.imported} Google Calendar event${result.imported === 1 ? "" : "s"} imported${result.skipped ? `, ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped` : ""}${ignored}.` : result.skipped ? `${result.skipped} duplicate event${result.skipped === 1 ? "" : "s"} skipped${ignored}.` : `No upcoming events found${ignored}.`);
      window.setTimeout(() => setCaptureStatus(null), 3500);
    } catch (error) {
      setCaptureStatus(friendlyError(error, "Calendar import failed."));
    } finally {
      setCalendarImporting(false);
    }
  };

  return (
    <>
      <div className="hero-copy"><p className="eyebrow">Hi, {profile.name}</p><h2>Drop it in. Find it later.</h2><p>Notes, files, reminders, places, money, and voice in one calm inbox.</p></div>
      <div className="starter-prompts">
        {starterPrompts.map(({ icon: Icon, label, text }) => <button key={label} onClick={() => { setMode("capture"); setDraft(text); window.setTimeout(() => input.current?.focus(), 0); }}><Icon size={16} />{label}</button>)}
      </div>
      <div className={`universal-input ${voiceMenuOpen ? "menu-open" : ""} ${isListening ? "is-recording" : ""} ${activeVoiceMode === "audio-only" ? "audio-only-recording" : ""}`}>
        {mode === "search" ? <Search size={21} /> : <Sparkles size={21} />}
        {isListening && <div className="recording-wave" aria-hidden="true">{recordingBars.map((height, index) => <span key={index} style={{ "--bar-height": `${height}px` } as React.CSSProperties} />)}</div>}
        {!(activeVoiceMode === "audio-only" && isListening) && <input ref={input} value={draft} onChange={(e) => { setDraft(e.target.value); if (mode === "search") setAskAnswer(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (mode === "search") void runAskSearch(); else void submit(); } }} placeholder={mode === "search" ? "Search live, press Enter to ask Nube..." : listMode === "tasks" ? "Add a task, deadline, or reminder..." : "What's on your mind? Try: Spent 38 EUR on fuel..."} />}
        {draft && !isListening && <button className="clear-input-button" onClick={() => { setDraft(""); setAskAnswer(null); window.setTimeout(() => input.current?.focus(), 0); }} title="Clear text"><X size={18} /></button>}
        <button className={mode === "search" ? "active" : ""} onClick={() => { setMode(mode === "search" ? "capture" : "search"); setAskAnswer(null); window.setTimeout(() => input.current?.focus(), 0); }}><Search size={19} /></button>
        <div className="voice-menu-anchor">
          <button className={isListening ? "recording" : ""} onClick={() => isListening ? void startVoiceInput() : setVoiceMenuOpen((current) => !current)} title={isListening ? "Stop recording" : "Voice capture"}><Mic size={19} /></button>
          {voiceMenuOpen && !isListening && <div className="voice-mode-menu">
            <button onClick={() => { setVoiceMenuOpen(false); void startVoiceInput("smart"); }}><Sparkles size={15} /><span><b>Smart voice</b><small>Audio, transcript, and AI</small></span></button>
            <button onClick={() => { setVoiceMenuOpen(false); void startVoiceInput("audio-only"); }}><Mic size={15} /><span><b>Audio only</b><small>Save the recording only</small></span></button>
          </div>}
        </div>
        <button onClick={() => fileInput.current?.click()} title="Upload file"><Image size={19} /></button>
        <input ref={fileInput} className="hidden-file" type="file" multiple accept="image/*,.pdf,.txt,.md,.json,.csv,.log" onChange={(event) => { uploadFiles(event.target.files); event.currentTarget.value = ""; }} />
        <button className="send" onClick={() => mode === "search" ? void runAskSearch() : void submit()} disabled={isCreating || askLoading || (!draft.trim() && !pendingVoiceAttachment)} title={mode === "search" ? "Ask Nube" : isCreating ? "Creating capture" : "Capture"}>
          {mode === "search" ? askLoading ? <Sparkles size={20} /> : <Brain size={20} /> : isCreating ? <Sparkles size={20} /> : <ArrowUp size={20} />}
        </button>
      </div>
      {pendingVoiceAttachment && <div className="pending-voice-preview"><VoiceNotePlayer attachment={pendingVoiceAttachment} compact minimal onRename={(title) => setPendingVoiceAttachment((current) => current ? { ...current, title } : current)} onRemove={() => setPendingVoiceAttachment(null)} /></div>}
      {captureStatus && <div className={`status-notice ${statusTone(captureStatus)}`} role="status" aria-live="polite"><Sparkles size={15} /><span>{captureStatus}</span></div>}
      {mode === "search" && askAnswer && <div className="inline-ask-card">
        <div><span>{askAnswer.provider === "google" ? "Ask Nube" : "Local search"}</span><button onClick={() => setAskAnswer(null)}><X size={14} /></button></div>
        <p>{askAnswer.answer}</p>
        {askAnswer.related.length > 0 && <div className="inline-ask-related">{askAnswer.related.map((item) => {
          const capture = captures.find((candidate) => candidate.id === item.id);
          return <button key={`${item.id}-${item.title}`} onClick={() => capture && setSelectedCapture(capture)}>{item.title}<small>{item.type}</small></button>;
        })}</div>}
      </div>}
      <div className="filter-bar">
        <div className="filter-bar-left">
          <button className={dateFilter?.day === todayKey ? "active" : ""} onClick={() => setDateFilter(dateFilter?.day === todayKey ? null : { day: todayKey, label: "Today" })}><CalendarCheck size={16} />Today</button>
          <button className={starFilter === "Starred" ? "active" : ""} onClick={() => setStarFilter(starFilter === "Starred" ? "All" : "Starred")}><Star size={16} />Starred</button>
          <button className={filterOpen ? "active" : ""} onClick={() => setFilterOpen((current) => !current)}><Search size={16} />Filters{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button>
          {activeFilterCount > 0 && <button onClick={clearFilters}>Clear all</button>}
        </div>
        <div className="filter-bar-right">
          <button className={statusFilter === "Trash" ? "active trash-shortcut icon-only" : "trash-shortcut icon-only"} onClick={() => setStatusFilter(statusFilter === "Trash" ? "All" : "Trash")} title={statusFilter === "Trash" ? "Close trash" : "Open trash"} aria-label={statusFilter === "Trash" ? "Close trash" : "Open trash"}><Trash2 size={16} />{trashCount > 0 && <b>{trashCount}</b>}</button>
          <button className="icon-only" onClick={() => void importGoogleCalendarQuick()} disabled={calendarImporting} title={calendarImporting ? "Importing Google Calendar" : "Import Google Calendar"} aria-label={calendarImporting ? "Importing Google Calendar" : "Import Google Calendar"}><CalendarCheck size={16} /></button>
          <button className="icon-only" onClick={() => inboxCalendarInput.current?.click()} title="Import .ics file" aria-label="Import .ics file"><Upload size={16} /></button>
          <input ref={inboxCalendarInput} className="hidden-file" type="file" accept=".ics,text/calendar" onChange={(event) => { void importCalendarFileQuick(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        </div>
      </div>
      {filterOpen && <div className="filter-panel">
        <OptionPicker label="Category" value={typeFilter} options={["All", ...collectionOrder]} onChange={setTypeFilter} />
        <OptionPicker label="Priority" value={priorityFilter} options={["All", "Low", "Medium", "High"]} onChange={setPriorityFilter} formatLabel={(value) => value === "Medium" ? "Med" : value} />
        <OptionPicker label="Assets" value={assetFilter} options={["All", "Images", "Files", "Audio", "Places", "Links"]} onChange={setAssetFilter} />
        <OptionPicker label="Money" value={moneyFilter} options={["All", "Income", "Expenses"]} onChange={setMoneyFilter} />
        <OptionPicker label="Status" value={statusFilter === "Trash" ? "All" : statusFilter} options={["All", "Open", "Done", "Archived"]} onChange={setStatusFilter} />
        <NubeDatePicker label="Date" value={dateFilter?.day ?? ""} onChange={(value) => setDateFilter(value ? { day: value, label: new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) } : null)} />
        <div className="filter-tags"><span>Tags</span><button className={!tagFilter ? "active" : ""} onClick={() => setTagFilter(null)}>All</button>{allTags.map((tag, index) => <button key={`${tag}-${index}`} className={tagFilter === tag ? "active" : ""} style={tagChipStyle(tag, tagColors)} onClick={() => setTagFilter(tagFilter === tag ? null : tag)}>{tag}</button>)}</div>
      </div>}
      {collectionFilter && <div className="date-filter-banner"><span>{collectionFilter.title} collection</span><button onClick={() => setCollectionFilter(null)}>Clear collection</button></div>}
      {dateFilter && dateFilter.day !== todayKey && <div className="date-filter-banner"><span>{dateFilter.label}</span><button onClick={() => setDateFilter(null)}>Clear date</button></div>}
      {uploadStatus && <div className={`status-notice ${statusTone(uploadStatus)}`} role="status" aria-live="polite"><Upload size={15} /><span>{uploadStatus}</span></div>}
      <div className="content-grid inbox-list-grid">
        <section>
          <div className="section-title inbox-mode-title">
            <span>{visibleSectionTitle}{isTrashView && <small>Items stay here for {TRASH_RETENTION_DAYS} days from the moment they are moved to trash.</small>}</span>
            {isTrashView && trashCount > 0 && <button className="section-empty-trash" onClick={emptyTrash} title="Delete every trashed item forever">Empty trash</button>}
            {!isTrashView && <div className="inbox-mode-toggle" aria-label="Inbox list mode">
              <button className={listMode === "captures" ? "active" : ""} onClick={() => setListMode("captures")} title="Captures" aria-label="Captures"><Inbox size={15} /><b>{orderedFiltered.length}</b></button>
              <button className={listMode === "tasks" ? "active" : ""} onClick={() => setListMode("tasks")} title="Tasks" aria-label="Tasks"><CheckCircle2 size={15} /><b>{taskCaptures.filter((capture) => !capture.completed).length}</b></button>
            </div>}
          </div>
          <div className={!isTrashView && listMode === "tasks" ? "task-list" : "cards"}>{visibleList.length ? visibleList.map((capture) => !isTrashView && listMode === "tasks" ? <TaskCard key={capture.id} capture={capture} onOpen={() => setSelectedCapture(capture)} /> : <SmartCard key={capture.id} capture={capture} onOpen={() => setSelectedCapture(capture)} />) : <div className="empty-state empty-state-large"><Sparkles size={24} /><h3>{!isTrashView && listMode === "tasks" ? "No tasks here" : emptyState.title}</h3><p>{!isTrashView && listMode === "tasks" ? "Tasks appear when a capture has an action, date, reminder, or calendar event." : emptyState.text}</p><div className="empty-actions">
          {mode === "search" && <button onClick={() => { setDraft(""); setAskAnswer(null); setMode("capture"); window.setTimeout(() => input.current?.focus(), 0); }}>Clear search</button>}
          {dateFilter && <button onClick={() => setDateFilter(null)}>Clear date</button>}
          {activeFilterCount > 0 && <button onClick={clearFilters}>Clear filters</button>}
          {mode !== "search" && !dateFilter && activeFilterCount === 0 && <>
            <button onClick={() => seedDraft("Call Luca tomorrow morning about the gym contract")}>Try a task</button>
            <button onClick={() => seedDraft("Spent 38 EUR on fuel this morning")}>Try an expense</button>
            <button onClick={() => fileInput.current?.click()}>Upload a file</button>
          </>}
          {dateFilter && <button onClick={() => seedDraft(`Add a reminder for ${dateFilter.label}`)}>Create dated capture</button>}
        </div></div>}</div>
        </section>
        <aside className="left-rail">
          <section className="insight-panel">
          <div className="insight-panel-head"><h3><Sparkles size={20} /> AI Insights</h3><button onClick={() => setInsightsOpen(true)} title="Open insights"><Brain size={16} /></button></div>
          <div className="insight-line"><b>{aiReview.headline}</b><p>{aiReview.focus}</p></div>
          <div className="insight-line"><b>{aiReview.provider === "google" ? "Google Gemini review" : "Local review"}</b><p>{aiReview.patterns.slice(0, 2).join(" · ") || `${allTags.length} active tags`}</p></div>
          {aiReview.nextActions.length > 0 && <div className="mini-ai-list">{aiReview.nextActions.map((action) => <span key={action}>{action}</span>)}</div>}
          </section>
          {pluginSettings.receiptScanner && <section className="money-insights">
            <div className="money-head">
              <p className="eyebrow">Money</p>
              <span>{moneySignals.length} signals</span>
            </div>
            <div className="money-summary">
              <div className="money-total income"><span>Income</span><b>+{formatMoney(moneyTotals.income, profile.currency)}</b></div>
              <div className="money-total expense"><span>Expenses</span><b>-{formatMoney(moneyTotals.expense, profile.currency)}</b></div>
            </div>
            <div className="money-list">
              {(displayedMoneySignals.length ? displayedMoneySignals : [{ id: 0, key: "empty-money", title: pluginSettings.receiptScanner ? "No money captures yet" : "Receipt Scanner is off", amount: 0, currency: "EUR", direction: "review" as const, reason: "Waiting" }]).map((signal) => <div className={`money-row ${signal.direction}`} key={signal.key}><span title={signal.reason}>{signal.title}</span><b>{signal.amount ? formatSignedMoney(signal.amount, signal.currency, signal.direction) : "Waiting"}</b>{signal.amount > 0 && <div className="money-actions"><button className="income-action" onClick={() => markMoneySignal(signal, "income")} title="Mark as income">+</button><button className="expense-action" onClick={() => markMoneySignal(signal, "expense")} title="Mark as expense">-</button></div>}</div>)}
            </div>
            {moneySignals.length > 3 && <button className="money-toggle" onClick={() => setMoneyExpanded((current) => !current)}>{moneyExpanded ? "Show less" : `Show ${moneySignals.length - 3} more`}</button>}
          </section>}
          <section className="storage-card">
            <p className="eyebrow">Storage usage</p>
            <div className="storage-meter"><span style={{ width: `${storageBarPercent}%` }} /></div>
            <div><span>{formatStorageUsage(storageUsedBytes)} of {fallbackPlanCatalog.free.storageGb} GB</span><b>{storagePercent}%</b></div>
          </section>
        </aside>
      </div>
    </>
  );
}

function ChecklistBlock({ capture, compact = false, onChange }: { capture: Capture; compact?: boolean; onChange?: (items: ChecklistItem[]) => void }) {
  const { updateCapture } = useBrain();
  const items = checklistForCapture(capture);
  if (!items.length) return null;
  const visibleItems = compact ? items.slice(0, 5) : items;
  const toggleItem = (id: string) => {
    const next = items.map((item) => item.id === id ? { ...item, done: !item.done } : item);
    if (onChange) onChange(next);
    else updateCapture(capture.id, { checklistItems: next, text: checklistTextFor(next) });
  };
  return (
    <div className={`checklist-block ${compact ? "compact" : ""}`}>
      {visibleItems.map((item) => (
        <button key={item.id} className={item.done ? "done" : ""} onClick={(event) => { event.stopPropagation(); toggleItem(item.id); }} type="button">
          <span><CheckCircle2 size={15} /></span>
          <b>{item.text}</b>
        </button>
      ))}
      {compact && items.length > visibleItems.length && <small>+{items.length - visibleItems.length} more</small>}
    </div>
  );
}

function SmartCard({ capture, onOpen }: { capture: Capture; onOpen: () => void }) {
  const { updateCapture, trashCapture, restoreCapture, deleteCaptureForever, setPreviewImage, isCaptureUnlocked, unlockCapture, lockCapture } = useBrain();
  const Icon = iconForType(capture.type);
  const locked = !isCaptureUnlocked(capture);
  const image = capture.place?.photoUrl ?? placeImageFor(capture);
  const audioAttachments = audioAttachmentsFor(capture);
  const isVoiceCapture = audioAttachments.length > 0 && capture.source.toLowerCase() === "voice note";
  const typeClass = capture.type.toLowerCase();
  const snooze = (days: number) => {
    const base = parseDueDate(capture.due);
    base.setDate(base.getDate() + days);
    updateCapture(capture.id, { due: base.toISOString(), completed: false });
  };
  if (locked) return (
    <motion.article className="smart-card private-card" onClick={(event) => { event.stopPropagation(); if (unlockCapture(capture)) onOpen(); }} whileHover={{ y: -4, scale: 1.01 }}>
      <div className="private-card-lock"><Lock size={20} /></div>
      <h3>Private capture</h3>
      <p>This capture is hidden. Unlock it with your Private PIN to view its content.</p>
      <div className="card-actions">
        <button className="icon-action lock-action" onClick={(event) => { event.stopPropagation(); if (unlockCapture(capture)) onOpen(); }} title="Unlock" aria-label="Unlock"><Lock size={16} /></button>
        <button className="icon-action danger-action" onClick={(event) => { event.stopPropagation(); unlockCapture(capture, () => trashCapture(capture)); }} title="Move to trash" aria-label="Move to trash"><Trash2 size={16} /></button>
      </div>
    </motion.article>
  );
  return (
    <motion.article className={`smart-card type-${typeClass} ${capture.type === "Place" ? "place-card" : ""} ${isVoiceCapture ? "voice-capture-card" : ""} ${capture.completed && !isVoiceCapture ? "completed" : ""} ${capture.starred ? "starred" : ""}`} onClick={onOpen} whileHover={{ y: -4, scale: 1.01 }}>
      {isVoiceCapture ? <>
        {audioAttachments.map((attachment) => <VoiceNotePlayer attachment={attachment} compact minimal allowCardOpen metaLabel={cardTimeLabel(capture)} key={attachment.id} onRename={(title) => updateCapture(capture.id, { attachments: capture.attachments?.map((item) => item.id === attachment.id ? { ...item, title } : item) })} />)}
      </> : capture.type === "Place" ? <>
        <div className="place-card-head"><div><span className="type-icon place"><Icon size={20} /></span><strong>Place to try</strong></div><small>{cardTimeLabel(capture)}</small></div>
        <h3>{capture.title}</h3>
        <div className="place-media">
          <img
            src={image}
            alt={capture.title}
            loading="lazy"
            onClick={(e) => {
              e.stopPropagation();
              window.open(capture.place?.mapsUrl ?? image, "_blank", "noopener,noreferrer");
            }}
          />
          <span><MapPin size={14} />{placeLocationFor(capture)}</span>
          <button className="place-expand" onClick={(e) => { e.stopPropagation(); setPreviewImage({ src: image, alt: capture.title }); }}><Maximize2 size={16} /></button>
        </div>
        {capture.place && <div className="place-details">{capture.place.rating && <span className="place-rating"><Star size={14} fill="currentColor" />{capture.place.rating.toFixed(1)} rating</span>}{capture.place.mapsUrl && <a className="place-map-link" href={capture.place.mapsUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={14} />Open in Maps</a>}</div>}
      </> : <>
        <div className="card-head"><div><span className={`type-icon ${capture.type.toLowerCase()}`}><Icon size={20} /></span><strong>{capture.type}</strong></div><small>{cardTimeLabel(capture)}</small></div>
        <h3>{capture.title}</h3>{captureBodyText(capture) && !checklistForCapture(capture).length && <p>{captureBodyText(capture)}</p>}
        <ChecklistBlock capture={capture} compact />
        {audioAttachments.map((attachment) => <VoiceNotePlayer attachment={attachment} compact minimal key={attachment.id} onRename={(title) => updateCapture(capture.id, { attachments: capture.attachments?.map((item) => item.id === attachment.id ? { ...item, title } : item) })} />)}
        {capture.external?.url && <div className="link-preview-strip">
          <Link2 size={16} />
          <span>{capture.external.url.replace(/^https?:\/\//, "")}</span>
          <a href={capture.external.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}><ExternalLink size={14} />Open page</a>
        </div>}
        {capture.imageUrl && (() => {
          const preview = { src: capture.imageUrl, alt: capture.attachmentName ?? capture.title };
          return (
            <div className="attachment-media">
              <img
                src={preview.src}
                alt={preview.alt}
                loading="lazy"
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewImage(preview);
                }}
              />
              <button onClick={(e) => { e.stopPropagation(); setPreviewImage(preview); }}><Maximize2 size={16} />Expand</button>
            </div>
          );
        })()}
        {capture.attachmentName && !audioAttachments.length && <div className="file-strip"><Archive size={16} /><span>{capture.attachmentName}{fileSizeLabelFor(capture) ? <small>{fileSizeLabelFor(capture)}</small> : null}</span>{capture.imageUrl && <button onClick={(event) => { event.stopPropagation(); downloadUrl(capture.attachmentName ?? "nube-image", capture.imageUrl ?? ""); }}>Download</button>}</div>}
        {capture.attachments?.filter((attachment) => !attachment.mimeType.startsWith("audio/")).length ? <div className="file-strip"><Archive size={16} /><span>{capture.attachments.filter((attachment) => !attachment.mimeType.startsWith("audio/")).length} attachments</span><b>Saved inside</b></div> : null}
      </>}
      <div className="card-meta compact-card-meta">
        <TagRow tags={visibleCaptureTags(capture.metadata)} />
        {capture.priority && <span className="priority-pill readonly-priority" style={{ "--priority-color": priorityColor(capture.priority) } as React.CSSProperties}>{priorityLabel(capture.priority)} priority</span>}
      </div>
      <div className={`card-actions ${capture.deletedAt ? "trash-actions" : ""}`}>
        {capture.deletedAt ? <>
          <span className="trash-expiry">{trashExpiryLabel(capture)}</span>
          <button className="icon-action archive-action active" onClick={(e) => { e.stopPropagation(); restoreCapture(capture); }} title="Restore" aria-label="Restore"><RotateCcw size={16} /></button>
          <button className="icon-action danger-action" onClick={(e) => { e.stopPropagation(); deleteCaptureForever(capture); }} title="Delete forever" aria-label="Delete forever"><Trash2 size={16} /></button>
        </> : <>
          <button className={`icon-action star-action ${capture.starred ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); updateCapture(capture.id, { starred: !capture.starred }); }} title={capture.starred ? "Remove star" : "Star"} aria-label={capture.starred ? "Remove star" : "Star"}><Star size={16} fill={capture.starred ? "currentColor" : "none"} /></button>
          <button className="icon-action lock-action" onClick={(e) => { e.stopPropagation(); void lockCapture(capture); }} title="Lock" aria-label="Lock"><Lock size={16} /></button>
          <button className={`icon-action archive-action ${capture.archived ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); updateCapture(capture.id, { archived: !capture.archived }); }} title={capture.archived ? "Restore from archive" : "Archive"} aria-label={capture.archived ? "Restore from archive" : "Archive"}><Archive size={16} /></button>
          {capture.type === "Actionable" && !isVoiceCapture && <button className="icon-action done-action" onClick={(e) => { e.stopPropagation(); updateCapture(capture.id, { completed: !capture.completed }); }} title={capture.completed ? "Reopen" : "Mark done"} aria-label={capture.completed ? "Reopen" : "Mark done"}><CheckCircle2 size={16} /></button>}
          {capture.type === "Actionable" && !isVoiceCapture && <button className="icon-action calendar-action" onClick={(e) => { e.stopPropagation(); snooze(1); }} title="Move to tomorrow" aria-label="Move to tomorrow"><CalendarCheck size={16} /></button>}
          {capture.type === "Actionable" && !isVoiceCapture && <button className="icon-action export-action" onClick={(e) => { e.stopPropagation(); exportCaptureIcs(capture); }} title="Export .ics" aria-label="Export .ics"><ExternalLink size={16} /></button>}
          <button className="icon-action danger-action" onClick={(e) => { e.stopPropagation(); trashCapture(capture); }} title="Move to trash" aria-label="Move to trash"><Trash2 size={16} /></button>
        </>}
      </div>
    </motion.article>
  );
}

function TaskCard({ capture, onOpen }: { capture: Capture; onOpen: () => void }) {
  const { updateCapture, trashCapture, restoreCapture, deleteCaptureForever, tagColors, isCaptureUnlocked, unlockCapture, lockCapture } = useBrain();
  const tags = visibleCaptureTags(capture.metadata).slice(0, 2);
  const taskAudio = audioAttachmentsFor(capture);
  const taskChecklist = checklistForCapture(capture);
  const taskBody = captureBodyText(capture);
  const sourceLabel = capture.source ? capture.source.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "";
  const showSourceLabel = Boolean(sourceLabel && !tags.some((tag) => tag.toLowerCase() === sourceLabel.toLowerCase()));
  const isAudioTask = taskAudio.length > 0;
  const TaskIcon = iconForType(capture.type);
  const pinned = isPinnedCapture(capture);
  const locked = !isCaptureUnlocked(capture);
  const due = capture.due ? parseDueDate(capture.due) : null;
  const dueLabel = due ? due.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
  const hasTimeWindow = Boolean(capture.taskStartTime && capture.taskEndTime);
  const timeLabel = hasTimeWindow ? `${capture.taskStartTime}-${capture.taskEndTime}` : due ? due.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "";
  const isOverdue = Boolean(due && due.getTime() < Date.now() && !capture.completed);
  const moveToTomorrow = () => {
    const base = capture.due ? parseDueDate(capture.due) : new Date();
    const next = new Date(base);
    next.setDate(next.getDate() + 1);
    updateCapture(capture.id, { due: next.toISOString(), completed: false });
  };
  const missing = [
    !due ? "date" : null,
    !hasTimeWindow ? "time" : null,
    !capture.priority ? "priority" : null,
  ].filter(Boolean);
  if (locked) return (
    <motion.article className="task-card private-task-card" onClick={(event) => { event.stopPropagation(); if (unlockCapture(capture)) onOpen(); }} whileHover={{ y: -2 }}>
      <button className="task-check private-check" onClick={(event) => { event.stopPropagation(); unlockCapture(capture); }} title="Unlock task"><Lock size={18} /></button>
      <div className="task-main">
        <div className="task-title-row"><h3>Private task</h3></div>
        <p>Hidden until you enter your Private PIN.</p>
      </div>
      <div className="task-schedule">
        <strong>Locked</strong>
        <div>
          <button className="icon-action lock-action" onClick={(event) => { event.stopPropagation(); unlockCapture(capture); }} title="Unlock task" aria-label="Unlock task"><Lock size={15} /></button>
          <button className="icon-action danger-action" onClick={(event) => { event.stopPropagation(); unlockCapture(capture, () => trashCapture(capture)); }} title="Move task to trash" aria-label="Move task to trash"><Trash2 size={15} /></button>
        </div>
      </div>
    </motion.article>
  );
  return (
    <motion.article className={`task-card ${isAudioTask ? "task-audio-card" : ""} ${capture.completed ? "completed" : ""} ${pinned ? "starred" : ""}`} onClick={onOpen} whileHover={{ y: -2 }}>
      {!isAudioTask && <button className={`task-check ${capture.type.toLowerCase()}`} onClick={(event) => { event.stopPropagation(); onOpen(); }} title="Open task" aria-label="Open task">
        <TaskIcon size={20} />
      </button>}
      <div className="task-main">
        {!isAudioTask && <div className="task-title-row">
          <h3>{capture.title}</h3>
          {capture.priority && <span className="priority-pill" style={{ "--priority-color": priorityColor(capture.priority) } as React.CSSProperties}>{priorityLabel(capture.priority)}</span>}
        </div>}
        {!isAudioTask && taskBody && !taskChecklist.length && <p>{taskBody}</p>}
        {!isAudioTask && taskChecklist.length > 0 && <ChecklistBlock capture={capture} compact onChange={(items) => updateCapture(capture.id, { checklistItems: items, text: checklistTextFor(items) })} />}
        {taskAudio.length > 0 && <div className="task-audio-list">
          {taskAudio.map((attachment) => (
            <VoiceNotePlayer
              attachment={attachment}
              compact
              minimal
              key={attachment.id}
              onRename={(title) => updateCapture(capture.id, { attachments: capture.attachments?.map((item) => item.id === attachment.id ? { ...item, title } : item) })}
            />
          ))}
        </div>}
        <div className="task-meta">
          {tags.map((tag) => <span key={tag} style={tagChipStyle(tag, tagColors)}>{tag}</span>)}
          {showSourceLabel && <small>{sourceLabel}</small>}
        </div>
      </div>
      <div className="task-schedule">
        {dueLabel && <strong className={isOverdue ? "overdue" : ""}>{dueLabel}</strong>}
        {timeLabel && <span>{timeLabel}</span>}
      </div>
      <div className={`task-actions ${capture.deletedAt ? "trash-actions" : ""}`}>
        {capture.deletedAt ? <>
          <span className="trash-expiry">{trashExpiryLabel(capture)}</span>
          <button className="icon-action archive-action active" onClick={(event) => { event.stopPropagation(); restoreCapture(capture); }} title="Restore task" aria-label="Restore task"><RotateCcw size={15} /></button>
          <button className="icon-action danger-action" onClick={(event) => { event.stopPropagation(); deleteCaptureForever(capture); }} title="Delete task forever" aria-label="Delete task forever"><Trash2 size={15} /></button>
        </> : <>
          <button className={`icon-action star-action ${pinned ? "active" : ""}`} onClick={(event) => { event.stopPropagation(); updateCapture(capture.id, { starred: !pinned }); }} title={pinned ? "Remove star" : "Star task"} aria-label={pinned ? "Remove star" : "Star task"}><Star size={15} fill={pinned ? "currentColor" : "none"} /></button>
          <button className="icon-action lock-action" onClick={(event) => { event.stopPropagation(); void lockCapture(capture); }} title="Lock task" aria-label="Lock task"><Lock size={15} /></button>
          <button className={`icon-action archive-action ${capture.archived ? "active" : ""}`} onClick={(event) => { event.stopPropagation(); updateCapture(capture.id, { archived: !capture.archived }); }} title={capture.archived ? "Restore from archive" : "Archive task"} aria-label={capture.archived ? "Restore from archive" : "Archive task"}><Archive size={15} /></button>
          <button className="icon-action done-action" onClick={(event) => { event.stopPropagation(); updateCapture(capture.id, { completed: !capture.completed }); }} title={capture.completed ? "Reopen task" : "Mark done"} aria-label={capture.completed ? "Reopen task" : "Mark done"}><CheckCircle2 size={15} /></button>
          <button className="icon-action calendar-action" onClick={(event) => { event.stopPropagation(); moveToTomorrow(); }} title="Move to tomorrow" aria-label="Move to tomorrow"><CalendarCheck size={15} /></button>
          <button className="icon-action export-action" onClick={(event) => { event.stopPropagation(); exportCaptureIcs(capture); }} title="Export .ics" aria-label="Export .ics"><ExternalLink size={15} /></button>
          {missing.length > 0 && <button className="task-missing-chip" onClick={(event) => { event.stopPropagation(); onOpen(); }} title="Optional details can make this task easier to manage" aria-label={`Missing ${missing.join(", ")}`}><AlertTriangle size={13} />Missing {missing.join(" · ")}</button>}
          <button className="icon-action danger-action" onClick={(event) => { event.stopPropagation(); trashCapture(capture); }} title="Move task to trash" aria-label="Move task to trash"><Trash2 size={15} /></button>
        </>}
      </div>
    </motion.article>
  );
}

function TagRow({ tags }: { tags: string[] }) {
  const { tagColors } = useBrain();
  const [expanded, setExpanded] = React.useState(false);
  const uniqueTags = Array.from(new Set(tags));
  const visibleTags = expanded ? uniqueTags : uniqueTags.slice(0, 4);
  const hiddenCount = Math.max(uniqueTags.length - visibleTags.length, 0);
  return (
    <div className={`chips tag-row ${expanded ? "expanded" : ""}`}>
      {visibleTags.map((tag, index) => <span key={`${tag}-${index}`} style={tagChipStyle(tag, tagColors)}>{tag}</span>)}
      {uniqueTags.length > 4 && (
        <button className="tag-expand" onClick={(event) => { event.stopPropagation(); setExpanded((current) => !current); }} title={expanded ? "Show fewer tags" : "Show all tags"}>
          {expanded ? "Less" : `+${hiddenCount}`} <ChevronDown size={13} />
        </button>
      )}
    </div>
  );
}

const taskWeekDays = [
  { index: 1, label: "M" },
  { index: 2, label: "T" },
  { index: 3, label: "W" },
  { index: 4, label: "T" },
  { index: 5, label: "F" },
  { index: 6, label: "S" },
  { index: 0, label: "S" },
];

function DetailModal({ capture }: { capture: Capture }) {
  const { updateCapture, setCaptures, setSelectedCapture, setPreviewImage, tagColors, setTagColors, pluginSettings, privatePinHash, setView, lockCapture } = useBrain();
  const [draft, setDraft] = React.useState({ ...capture, due: toDateTimeLocal(capture.due) });
  const [tags, setTags] = React.useState<string[]>(visibleCaptureTags(capture.metadata));
  const [repeatDays, setRepeatDays] = React.useState<number[]>(capture.repeatDays ?? []);
  const [newTag, setNewTag] = React.useState("");
  const [savingDetail, setSavingDetail] = React.useState(false);
  const showMoneyDirection = pluginSettings.receiptScanner && pluginSettings.receiptMoneySignals && hasMoneySignal({ ...draft, metadata: tags });
  const detailMoneySignals = showMoneyDirection ? moneySignalsFor([{ ...draft, metadata: tags }]) : [];
  const attachmentInput = React.useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = React.useState<Attachment[]>(capture.attachments ?? []);
  const detailMissingHints = draft.type === "Actionable" ? [
    !draft.due ? "Add a date so it appears in Today and Upcoming." : null,
    !draft.taskStartTime || !draft.taskEndTime ? "Add a time window if you want to plan when it happens." : null,
    !draft.priority ? "Add a priority only if this needs attention before other tasks." : null,
  ].filter(Boolean) as string[] : [];
  const readAttachment = (file: File) => new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ id: `${Date.now()}-${file.name}`, name: file.name, mimeType: file.type, size: file.size, dataUrl: String(reader.result) });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const addAttachments = async (files: FileList | null) => {
    const next = await Promise.all(Array.from(files ?? []).map((file) => readAttachment(file)));
    if (!next.length) return;
    setAttachments((current) => [...current, ...next]);
    const firstImage = next.find((item) => item.mimeType.startsWith("image/") && item.dataUrl);
    if (firstImage && !draft.imageUrl) setDraft((current) => ({ ...current, imageUrl: firstImage.dataUrl, attachmentName: firstImage.name }));
  };
  const updateTag = (index: number, value: string) => setTags((current) => current.map((tag, itemIndex) => itemIndex === index ? value : tag));
  const removeTag = (index: number) => setTags((current) => current.filter((_, itemIndex) => itemIndex !== index));
  const addTag = () => {
    const tag = newTag.trim();
    if (!tag) return;
    setTags((current) => Array.from(new Set([...current, tag])));
    setNewTag("");
  };
  const setMoneyDirection = (direction: MoneySignal["direction"]) => {
    const clean = tags.filter((tag) => !tag.startsWith("Money "));
    const nextTag = direction === "income" ? "Money income" : direction === "expense" ? "Money expense" : "Money review";
    setTags([...clean, nextTag]);
    setDraft({ ...draft, type: direction === "expense" ? "Expense" : draft.type });
  };
  const toggleRepeatDay = (day: number) => setRepeatDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day]);
  const detailCaptureFromDraft = () => {
    const normalizedDue = normalizeDue(draft.due);
    const cleanTags = visibleCaptureTags(Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))));
    return { ...capture, ...draft, due: normalizedDue, repeatDays, metadata: cleanTags, attachments } as Capture;
  };
  const lockDetailNow = async () => {
    if (!privatePinHash) {
      localStorage.setItem("nube-settings-tab", "Data & Privacy");
      setSelectedCapture(null);
      setView("Settings");
      return;
    }
    setSavingDetail(true);
    await lockCapture({ ...detailCaptureFromDraft(), private: true }, true);
    setSavingDetail(false);
    setSelectedCapture(null);
  };
  const saveDetail = async () => {
    setSavingDetail(true);
    const normalizedDue = normalizeDue(draft.due);
    const cleanTags = visibleCaptureTags(Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))));
    const patch: Partial<Capture> = { ...draft, due: normalizedDue, repeatDays, metadata: cleanTags, attachments };
    const nextCapture = { ...capture, ...patch } as Capture;
    if (!draft.private) updateCapture(capture.id, { ...patch, private: false, privateEncryptedData: undefined, privateEncryptedAt: undefined });
    if (draft.type === "Actionable" && normalizedDue && repeatDays.length) {
      const base = parseDueDate(normalizedDue);
      const currentDay = base.getDay();
      const copies = repeatDays
        .filter((day) => day !== currentDay)
        .map((day) => {
          const dueDate = new Date(base);
          dueDate.setDate(base.getDate() + ((day - currentDay + 7) % 7));
          return {
            ...capture,
            ...patch,
            id: Date.now() + day + Math.floor(Math.random() * 1000),
            due: dueDate.toISOString(),
            createdAt: new Date().toISOString(),
            completed: false,
            metadata: cleanTags,
          } as Capture;
        });
      if (copies.length) setCaptures((current) => [...copies, ...current]);
    }
    if (draft.private) await lockCapture(nextCapture, true);
    setSelectedCapture(null);
    setSavingDetail(false);
  };
  return (
    <div className="modal-backdrop" onClick={() => setSelectedCapture(null)}>
      <motion.section className="detail-modal" onClick={(e) => e.stopPropagation()} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 18 }}>
        <header className="detail-header"><div><p className="eyebrow">{capture.type} capture</p><input className="detail-title-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div><div className="detail-header-actions"><button className={draft.starred ? "active" : ""} onClick={() => { const nextStarred = !draft.starred; setDraft({ ...draft, starred: nextStarred }); updateCapture(capture.id, { starred: nextStarred }); }}><Star size={18} fill={draft.starred ? "currentColor" : "none"} /></button><button className={draft.private ? "active private-active" : ""} disabled={savingDetail} onClick={() => { if (draft.private) setDraft({ ...draft, private: false }); else void lockDetailNow(); }} title={draft.private ? "Make visible" : "Lock capture"}><Lock size={18} /></button><button onClick={() => setSelectedCapture(null)}><X size={20} /></button></div></header>
        <div className="detail-edit-grid">
          <OptionPicker label="Type" value={draft.type} options={collectionOrder} onChange={(type) => setDraft({ ...draft, type })} />
          <div className="date-priority-row">
            <div className={`missing-field ${draft.type === "Actionable" && !draft.due ? "is-missing" : ""}`}>
              <NubeDatePicker label="Date" value={draft.due ?? ""} onChange={(value) => setDraft({ ...draft, due: value })} />
              {draft.type === "Actionable" && !draft.due && <small><AlertTriangle size={12} />Optional date</small>}
            </div>
            <div className={`missing-field ${draft.type === "Actionable" && !draft.priority ? "is-missing" : ""}`}>
              <OptionPicker label="Priority" value={draft.priority ?? "No priority"} options={["No priority", "Low", "Medium", "High"]} onChange={(priority) => setDraft({ ...draft, priority: priority === "No priority" ? undefined : priority as Priority })} formatLabel={priorityLabel} />
              {draft.type === "Actionable" && !draft.priority && <small><AlertTriangle size={12} />Optional priority</small>}
            </div>
          </div>
        </div>
        <div className="detail-body">
          {draft.type === "Actionable" && <section className="task-planner-card">
            <div>
              <h3>Task time</h3>
              <p>Set a work window or duplicate this task across the selected week.</p>
            </div>
            <div className="task-time-row">
              <div className={`missing-field ${!draft.taskStartTime ? "is-missing" : ""}`}>
                <NubeTimePicker label="Start" value={draft.taskStartTime ?? ""} onChange={(value) => setDraft({ ...draft, taskStartTime: value })} />
                {!draft.taskStartTime && <small><AlertTriangle size={12} />Optional start</small>}
              </div>
              <div className={`missing-field ${!draft.taskEndTime ? "is-missing" : ""}`}>
                <NubeTimePicker label="End" value={draft.taskEndTime ?? ""} onChange={(value) => setDraft({ ...draft, taskEndTime: value })} />
                {!draft.taskEndTime && <small><AlertTriangle size={12} />Optional end</small>}
              </div>
            </div>
            <div className="task-repeat-row" aria-label="Duplicate task on weekdays">
              {taskWeekDays.map((day) => <button key={day.index} className={repeatDays.includes(day.index) ? "active" : ""} onClick={() => toggleRepeatDay(day.index)} type="button">{day.label}</button>)}
            </div>
            {detailMissingHints.length > 0 && <div className="task-detail-hints">
              <AlertTriangle size={15} />
              <div>{detailMissingHints.map((hint) => <span key={hint}>{hint}</span>)}</div>
            </div>}
          </section>}
          {checklistForCapture(draft as Capture).length > 0 && <>
            <h3>Checklist</h3>
            <ChecklistBlock capture={draft as Capture} onChange={(items) => setDraft({ ...draft, checklistItems: items, text: checklistTextFor(items) })} />
          </>}
          <h3>Content</h3>
          <textarea value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          {showMoneyDirection && <>
            <h3>Money</h3>
            <div className="detail-money-card">
              <div>{detailMoneySignals.map((signal) => <span className={`money-pill ${signal.direction}`} key={signal.key}>{formatSignedMoney(signal.amount, signal.currency, signal.direction)}</span>)}</div>
              <div className="segmented-actions">
                <button onClick={() => setMoneyDirection("income")}>Income</button>
                <button onClick={() => setMoneyDirection("expense")}>Expense</button>
                <button onClick={() => setMoneyDirection("review")}>Needs review</button>
              </div>
            </div>
          </>}
          <h3>Tags</h3>
          <div className="tag-color-editor">
            {tags.map((tag, index) => (
              <div className="tag-color-row" key={`${tag}-${index}`}>
                <input value={tag} style={tagChipStyle(tag, tagColors)} onChange={(event) => updateTag(index, event.target.value)} />
                <div>{tagPalette.map((color) => <button key={color} className={tagColorFor(tag, tagColors) === color ? "selected" : ""} style={{ "--swatch": color } as React.CSSProperties} onClick={() => setTagColors((current) => ({ ...current, [tag]: color }))} title={color} />)}</div>
                <button className="tag-remove-button" onClick={() => removeTag(index)}><X size={14} /></button>
              </div>
            ))}
            <div className="tag-add-row"><input value={newTag} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTag(); }} placeholder="Add tag..." /><button onClick={addTag}>Add tag</button></div>
          </div>
          <h3>Attachments</h3>
          <div className="attachment-manager">
            <button onClick={() => attachmentInput.current?.click()}><Image size={16} />Add files</button>
            <input ref={attachmentInput} className="hidden-file" type="file" multiple accept="image/*,.pdf,.txt,.md,.json,.csv,.log" onChange={(event) => { void addAttachments(event.target.files); event.currentTarget.value = ""; }} />
            {attachments.map((attachment) => attachment.mimeType.startsWith("audio/") && attachment.dataUrl ? <VoiceNotePlayer attachment={attachment} minimal key={attachment.id} onRename={(title) => setAttachments((current) => current.map((item) => item.id === attachment.id ? { ...item, title } : item))} onRemove={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} /> : <div className="attachment-row" key={attachment.id}><Archive size={16} /><span>{attachment.name}</span><b>{Math.max(1, Math.round(attachment.size / 1024))} KB</b>{attachment.dataUrl && attachment.mimeType.startsWith("image/") && <button onClick={() => setPreviewImage({ src: attachment.dataUrl ?? "", alt: attachment.name })}>View</button>}{attachment.dataUrl && <button onClick={() => downloadUrl(attachment.name, attachment.dataUrl ?? "")}>Download</button>}<button onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={13} /></button></div>)}
          </div>
          {draft.imageUrl && <div className="attachment-media detail-preview"><img src={draft.imageUrl} alt={draft.attachmentName ?? draft.title} onClick={() => setPreviewImage({ src: draft.imageUrl ?? "", alt: draft.attachmentName ?? draft.title })} /><button onClick={() => setPreviewImage({ src: draft.imageUrl ?? "", alt: draft.attachmentName ?? draft.title })}><Maximize2 size={16} />Expand</button></div>}
        </div>
        <footer className="detail-actions"><button disabled={savingDetail} onClick={() => void saveDetail()}><CheckCircle2 size={16} />{savingDetail ? "Saving..." : "Save edits"}</button><button onClick={() => setSelectedCapture(null)}><X size={16} />Cancel</button></footer>
      </motion.section>
    </div>
  );
}

function ImagePreview({ image, onClose }: { image: { src: string; alt: string }; onClose: () => void }) {
  return (
    <div className="image-preview-backdrop" onClick={onClose}>
      <motion.div className="image-preview" onClick={(event) => event.stopPropagation()} initial={{ opacity: 0, scale: .98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .98 }}>
        <div className="image-preview-actions"><button onClick={() => downloadUrl(image.alt || "nube-image", image.src)}>Download</button><button onClick={onClose}><X size={18} /></button></div>
        <img src={image.src} alt={image.alt} />
      </motion.div>
    </div>
  );
}

function PrivateUnlockModal({ capture, value, error, onChange, onClose, onConfirm, onReset }: { capture: Capture; value: string; error: string; onChange: (value: string) => void; onClose: () => void; onConfirm: () => void; onReset: () => void }) {
  return (
    <motion.div className="overlay-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.section className="private-unlock-modal" initial={{ opacity: 0, y: 18, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 18, scale: .98 }} transition={{ duration: .18 }} onClick={(event) => event.stopPropagation()}>
        <button className="private-unlock-close" onClick={onClose}><X size={18} /></button>
        <div className="private-unlock-icon"><Lock size={22} /></div>
        <p className="eyebrow">Private capture</p>
        <h2>Unlock to continue.</h2>
        <p className="private-unlock-copy">This {capture.type.toLowerCase()} is hidden. Enter your Private PIN to view, edit, or delete it.</p>
        <label>
          <span>Private PIN</span>
          <input autoFocus type="password" inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onConfirm(); }} placeholder="Enter PIN" />
        </label>
        {error && <div className="private-pin-message error">{error}</div>}
        <div className="private-unlock-actions">
          <button onClick={onConfirm}><Lock size={16} />Unlock</button>
          <button onClick={onReset}><RefreshCw size={16} />Reset PIN</button>
        </div>
      </motion.section>
    </motion.div>
  );
}

type CollectionConfig = {
  id: string;
  title: string;
  types: CaptureType[];
  icon: string;
  tone: string;
  size: "single" | "wide" | "tall";
  customColor?: string;
  imageUrl?: string;
};

const collectionIconOptions = [
  ["check", CheckCircle2], ["idea", Lightbulb], ["receipt", ReceiptText], ["person", User], ["pin", MapPin], ["book", BookOpen],
  ["heart", HeartPulse], ["briefcase", Briefcase], ["archive", Archive], ["cloud", Cloud], ["sparkles", Sparkles], ["calendar", CalendarCheck],
  ["bell", Bell], ["plane", Plane], ["home", Home], ["link", Link2], ["notebook", NotebookText], ["brain", Brain], ["message", MessageCircle], ["image", Image],
] as const;

const collectionIconFor = (name: string) => collectionIconOptions.find(([id]) => id === name)?.[1] ?? Archive;

const collectionToneMap: Record<string, string> = {
  blue: "#4f46e5",
  sky: "#0284c7",
  cyan: "#0891b2",
  teal: "#0f766e",
  emerald: "#059669",
  lime: "#65a30d",
  amber: "#d97706",
  gold: "#ca8a04",
  orange: "#ea580c",
  red: "#dc2626",
  rose: "#e11d48",
  pink: "#db2777",
  fuchsia: "#c026d3",
  violet: "#7c3aed",
  indigo: "#6366f1",
  slate: "#475569",
};

const collectionToneOptions = ["blue", "sky", "cyan", "teal", "emerald", "lime", "amber", "gold", "orange", "red", "rose", "pink", "fuchsia", "violet", "indigo", "slate"] as const;

const collectionColorFor = (collection: CollectionConfig) => collection.customColor ?? collectionToneMap[collection.tone] ?? collectionToneMap.indigo;
const collectionActionLabel = (title: string) => {
  const trimmed = title.trim();
  if (!trimmed) return "item";
  if (/ies$/i.test(trimmed)) return trimmed.replace(/ies$/i, "y").toLowerCase();
  if (/s$/i.test(trimmed) && !/(ss|us)$/i.test(trimmed)) return trimmed.slice(0, -1).toLowerCase();
  return trimmed.toLowerCase();
};

const defaultCollectionConfigs: CollectionConfig[] = [
  { id: "tasks", title: "Tasks", types: ["Actionable"], icon: "check", tone: "blue", size: "single" },
  { id: "ideas", title: "Ideas", types: ["Idea"], icon: "idea", tone: "amber", size: "single" },
  { id: "expenses", title: "Expenses", types: ["Expense"], icon: "receipt", tone: "red", size: "single" },
  { id: "people", title: "People", types: ["Person"], icon: "person", tone: "violet", size: "single" },
  { id: "places", title: "Places", types: ["Place"], icon: "pin", tone: "cyan", size: "tall" },
  { id: "study", title: "Study", types: ["Study"], icon: "book", tone: "emerald", size: "single" },
  { id: "health", title: "Health", types: ["Health", "Journal"], icon: "heart", tone: "rose", size: "single" },
  { id: "work", title: "Work", types: ["Work", "Document"], icon: "briefcase", tone: "indigo", size: "wide" },
];

function CollectionsView() {
  const { captures, addCapture, setView, setCollectionFilter, setSelectedCapture } = useBrain();
  const [activeCollection, setActiveCollection] = React.useState<{ title: string; types: CaptureType[] } | null>(null);
  const [editingCollection, setEditingCollection] = React.useState<CollectionConfig | null>(null);
  const [draggingCollectionId, setDraggingCollectionId] = React.useState<string | null>(null);
  const [collectionConfigs, setCollectionConfigs] = React.useState<CollectionConfig[]>(() => {
    const saved = localStorage.getItem("nube-collections");
    return saved ? JSON.parse(saved) as CollectionConfig[] : defaultCollectionConfigs;
  });
  React.useEffect(() => localStorage.setItem("nube-collections", JSON.stringify(collectionConfigs)), [collectionConfigs]);
  const count = (types: readonly CaptureType[]) => captures.filter((capture) => types.includes(capture.type)).length;
  const placeItems = captures.filter((capture) => capture.type === "Place");
  const featuredPlace = placeItems.find((capture) => capture.place?.photoUrl) ?? placeItems[0];
  const featuredPlaceImage = featuredPlace ? featuredPlace.place?.photoUrl ?? placeImageFor(featuredPlace) : "https://staticmap.openstreetmap.de/staticmap.php?center=Milan,Italy&zoom=11&size=360x180&maptype=mapnik";
  const featuredPlaceArea = featuredPlace ? placeLocationFor(featuredPlace) : "No places yet";
  const openFeaturedPlace = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (featuredPlace?.place?.mapsUrl) window.open(featuredPlace.place.mapsUrl, "_blank", "noopener,noreferrer");
    else {
      setCollectionFilter({ title: "Places", types: ["Place"] });
      setView("Inbox");
    }
  };
  const openCollection = (title: string, types: readonly CaptureType[]) => {
    setActiveCollection({ title, types: [...types] });
  };
  const addToCollection = async () => {
    if (!activeCollection) return;
    const primary = activeCollection.types[0];
    const examples: Partial<Record<CaptureType, string>> = {
      Actionable: "New task for today",
      Expense: "Spent 0 EUR on ...",
      Place: "Place to try: ",
      Idea: "Idea: ",
      Study: "Study note: ",
      Work: "Work note: ",
      Health: "Health log: ",
      Document: "Document to review: ",
    };
    await addCapture(examples[primary] ?? `New ${primary.toLowerCase()} capture`, "collection quick add", { type: primary, metadata: [activeCollection.title] });
  };
  const cards = collectionConfigs;
  const selectedItems = activeCollection ? rankCaptures(captures.filter((capture) => activeCollection.types.includes(capture.type))) : [];
  const ideaCount = captures.filter((capture) => capture.type === "Idea").length;
  const moneyReviewCount = moneySignalsFor(captures).filter((signal) => signal.direction === "review").length;
  const suggestions = [
    ideaCount > 1 ? { title: `${ideaCount} ideas to connect`, text: "Open saved ideas and turn the useful ones into projects.", icon: Lightbulb, action: () => openCollection("Ideas", ["Idea"]) } : null,
    moneyReviewCount > 0 ? { title: `${moneyReviewCount} money items to review`, text: "Classify unclear amounts as income or expense.", icon: ReceiptText, action: () => openCollection("Expenses", ["Expense"]) } : null,
  ].filter(Boolean) as Array<{ title: string; text: string; icon: React.ElementType; action: () => void }>;
  const totalCollections = cards.filter((card) => count(card.types) > 0).length;
  const totalSaved = captures.length;
  const saveCollection = (next: CollectionConfig) => {
    setCollectionConfigs((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [...current, next]);
    setEditingCollection(null);
  };
  const resetCollections = () => {
    setCollectionConfigs(defaultCollectionConfigs);
    localStorage.removeItem("nube-collections");
  };
  const moveCollection = (targetId: string) => {
    if (!draggingCollectionId || draggingCollectionId === targetId) return;
    setCollectionConfigs((current) => {
      const from = current.findIndex((item) => item.id === draggingCollectionId);
      const to = current.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };
  return (
    <div className="collections-page">
      <section className="collections-hero">
        <div>
          <p className="eyebrow">Library</p>
          <h2>Everything Nube has sorted for you.</h2>
          <p>Collections keep your captures easy to scan: tasks, places, expenses, files, people, and the things you want to revisit.</p>
        </div>
        <div className="collections-hero-tools">
          <div className="collections-hero-stats">
            <span><b>{totalSaved}</b> captures</span>
            <span><b>{totalCollections}</b> active areas</span>
            <span><b>{placeItems.length}</b> places</span>
          </div>
          <div className="library-actions">
            <span><Sparkles size={14} /> Drag to reorder</span>
            <button onClick={resetCollections}>Reset layout</button>
          </div>
        </div>
      </section>
      <div className="collections-grid">
        {cards.map((card, cardIndex) => {
          const { title, types, tone } = card;
          const Icon = collectionIconFor(card.icon);
          const itemCount = count(types);
          return (
          <article
            className={`collection-card ${card.size !== "single" ? card.size : ""} ${itemCount === 0 ? "empty" : ""} ${draggingCollectionId === card.id ? "dragging" : ""}`}
            draggable
            key={`${card.id}-${cardIndex}`}
            style={{ "--collection-color": collectionColorFor(card) } as React.CSSProperties}
            role="button"
            tabIndex={0}
            onClick={() => openCollection(title, types)}
            onKeyDown={(event) => { if (event.key === "Enter") openCollection(title, types); }}
            onDragStart={(event) => { setDraggingCollectionId(card.id); event.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => setDraggingCollectionId(null)}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
            onDrop={(event) => { event.preventDefault(); moveCollection(card.id); setDraggingCollectionId(null); }}
          >
            <div className="collection-topline">
            <div className={`collection-icon ${tone}`} style={{ "--collection-color": collectionColorFor(card) } as React.CSSProperties}>{card.imageUrl ? <img src={card.imageUrl} alt="" /> : <Icon size={23} />}</div>
              <b>{itemCount}</b>
            </div>
            <button className="collection-edit-button" onClick={(event) => { event.stopPropagation(); setEditingCollection(card); }} title="Edit collection"><Settings size={14} /></button>
            <div>
              <h3>{title}</h3>
              <p>{itemCount === 1 ? "1 item" : `${itemCount} items`}</p>
              {title === "Places" && <span>{featuredPlace ? featuredPlace.title : featuredPlaceArea}</span>}
              {title === "Places" && featuredPlace && <span>{featuredPlaceArea}</span>}
            </div>
            {title === "Places" && featuredPlace && (
              <div className="collection-map" role="button" tabIndex={0} onClick={openFeaturedPlace} onKeyDown={(event) => event.key === "Enter" && openFeaturedPlace(event as unknown as React.MouseEvent)}>
                <img src={featuredPlaceImage} alt={featuredPlace ? featuredPlace.title : "Places map"} loading="lazy" />
                {featuredPlace?.place?.mapsUrl && <b>Open in Maps</b>}
              </div>
            )}
          </article>
        );})}
        <button className="collection-card collection-create-card" style={{ "--collection-color": collectionToneMap.indigo } as React.CSSProperties} onClick={() => setEditingCollection({ id: `custom-${Date.now()}`, title: "New collection", types: ["Idea"], icon: "sparkles", tone: "indigo", size: "single" })}>
          <div className="collection-icon indigo"><Plus size={24} /></div>
          <div><h3>Create collection</h3><p>Choose name, icon, image, and size</p></div>
        </button>
      </div>
      {activeCollection && <section className="collection-detail-panel">
        <div className="collection-detail-head">
          <div><p className="eyebrow">{activeCollection.title}</p><h2>{selectedItems.length} saved items</h2><p>Review, open, or jump to this collection inside Inbox with filters already applied.</p></div>
          <div><button onClick={() => void addToCollection()}>Add {collectionActionLabel(activeCollection.title)}</button><button onClick={() => { setCollectionFilter(activeCollection); setView("Inbox"); }}>Open in Inbox</button><button onClick={() => setActiveCollection(null)}>Close</button></div>
        </div>
        <div className="collection-detail-list">
          {selectedItems.length ? selectedItems.map((capture) => <button key={capture.id} onClick={() => setSelectedCapture(capture)}><span className={`type-icon ${capture.type.toLowerCase()}`}>{React.createElement(iconForType(capture.type), { size: 18 })}</span><div><strong>{capture.title}</strong><p>{capture.text}</p></div><b>{priorityLabel(capture.priority) || "No priority"}</b></button>) : <div className="empty-state"><Sparkles size={22} /><h3>No items yet</h3><p>Capture something that belongs in {activeCollection.title.toLowerCase()} and it will appear here.</p></div>}
        </div>
      </section>}
      {suggestions.length > 0 && <section className="suggestions-section">
        <h3><Sparkles size={18} /> Intelligent Suggestions</h3>
        <div className="suggestion-grid">
          {suggestions.map(({ title, text, icon: Icon, action }) => <button key={title} onClick={action}><span><Icon size={20} /></span><div><strong>{title}</strong><p>{text}</p></div><ArrowUp size={16} /></button>)}
        </div>
      </section>}
      {editingCollection && <CollectionEditor collection={editingCollection} onClose={() => setEditingCollection(null)} onSave={saveCollection} />}
    </div>
  );
}

function CollectionEditor({ collection, onClose, onSave }: { collection: CollectionConfig; onClose: () => void; onSave: (collection: CollectionConfig) => void }) {
  const [draft, setDraft] = React.useState(collection);
  const imageInput = React.useRef<HTMLInputElement>(null);
  const readImage = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setDraft((current) => ({ ...current, imageUrl: String(reader.result) }));
    reader.readAsDataURL(file);
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.section className="collection-editor" onClick={(event) => event.stopPropagation()} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}>
        <header><div><p className="eyebrow">Collection</p><h3>Customize collection</h3></div><button onClick={onClose}><X size={18} /></button></header>
        <label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <div className="collection-editor-grid">
          <OptionPicker label="Category source" value={draft.types[0]} options={collectionOrder} onChange={(type) => setDraft({ ...draft, types: [type] })} />
          <OptionPicker label="Size" value={draft.size} options={["single", "wide", "tall"]} onChange={(size) => setDraft({ ...draft, size })} />
        </div>
        <div className="collection-icon-picker">
          <span>Icon</span>
          <div>{collectionIconOptions.map(([id, Icon]) => <button className={draft.icon === id ? "active" : ""} key={id} onClick={() => setDraft({ ...draft, icon: id, imageUrl: undefined })}><Icon size={17} /></button>)}</div>
        </div>
        <div className="collection-tone-picker">
          <span>Color</span>
          <div>
            {collectionToneOptions.map((tone) => <button className={!draft.customColor && draft.tone === tone ? "active" : ""} key={tone} onClick={() => setDraft({ ...draft, tone, customColor: undefined })}><i className={`tone-dot ${tone}`} style={{ "--tone-color": collectionToneMap[tone] } as React.CSSProperties} /></button>)}
            <label className={`collection-custom-color ${draft.customColor ? "active" : ""}`} title="Custom color">
              <input type="color" value={collectionColorFor(draft)} onChange={(event) => setDraft({ ...draft, customColor: event.target.value })} />
              <b>Custom</b>
            </label>
          </div>
        </div>
        <div className="collection-editor-actions">
          <button onClick={() => imageInput.current?.click()}><Upload size={16} />Upload image</button>
          {draft.imageUrl && <button onClick={() => setDraft({ ...draft, imageUrl: undefined })}>Remove image</button>}
          <input ref={imageInput} className="hidden-file" type="file" accept="image/*" onChange={(event) => { readImage(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        </div>
        <footer><button onClick={() => onSave({ ...draft, title: draft.title.trim() || "Untitled collection" })}>Save collection</button></footer>
      </motion.section>
    </div>
  );
}

function BrainInsights() {
  const { captures, profile, aiReview, pluginSettings, isCaptureUnlocked } = useBrain();
  const visibleCaptures = captures.filter(isCaptureUnlocked);
  const money = pluginSettings.receiptScanner && pluginSettings.receiptMoneySignals ? moneySignalsFor(visibleCaptures) : [];
  const income = money.filter((signal) => signal.direction === "income").reduce((sum, signal) => sum + signal.amount, 0);
  const expense = money.filter((signal) => signal.direction === "expense").reduce((sum, signal) => sum + signal.amount, 0);
  const actions = visibleCaptures.filter((capture) => capture.type === "Actionable" && !capture.completed);
  const starred = visibleCaptures.filter((capture) => capture.starred);
  const today = visibleCaptures.filter((capture) => dateKey(new Date(capture.createdAt)) === dateKey(new Date()));

  const activeTags = Array.from(new Set(visibleCaptures.flatMap((capture) => visibleCaptureTags(capture.metadata)))).slice(0, 10);
  const categoryDistribution = collectionOrder.map((type) => ({ type, count: visibleCaptures.filter((capture) => capture.type === type).length })).filter((item) => item.count > 0).sort((a, b) => b.count - a.count).slice(0, 5);
  const totalCategoryCount = Math.max(1, categoryDistribution.reduce((sum, item) => sum + item.count, 0));
  const data = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, index) => {
    const dayCaptures = visibleCaptures.filter((_, captureIndex) => captureIndex % 7 === index).length;
    const load = Math.min(88, Math.max(18, 24 + dayCaptures * 8 + actions.length * 4 + (index % 2 ? 6 : 0)));
    return { day, captures: dayCaptures, load };
  });
  const currentLoad = Math.round(data.reduce((sum, item) => sum + item.load, 0) / data.length);
  return <div className="insights-page">
    <section className="insights-header"><div><h2>Insights</h2><p>A simple read on what Nube has organized for you.</p></div><div className="insights-search"><Search size={16} /><span>Search insights...</span></div></section>
    <section className="insight-hero-card">
      <div className="load-summary"><p className="eyebrow">Live overview</p><h3>Inbox Load</h3><p>Nube is tracking <b>{visibleCaptures.length} active captures</b>, with {actions.length} open tasks and {starred.length} starred priorities.</p><div className="load-meter"><span style={{ width: `${currentLoad}%` }} /></div></div>
      <div className="load-number"><b>{currentLoad}%</b><span>{currentLoad > 70 ? "High focus" : currentLoad > 42 ? "Optimal zone" : "Quiet zone"}</span></div>
      <div className="insight-stat"><Sparkles size={28} /><b>{visibleCaptures.length}</b><span>New Captures</span><small>{today.length} today</small></div>
    </section>
    <section className="insights-two">
      <div className="chart-card insight-frequency"><div className="card-title-row"><h3>Capture Frequency</h3><span>7D</span></div><ResponsiveContainer height={230}><BarChart data={data}><CartesianGrid stroke="#e0e7ff" vertical={false} /><XAxis dataKey="day" /><Tooltip /><Bar dataKey="captures" fill="#6366f1" radius={[8, 8, 0, 0]} /></BarChart></ResponsiveContainer></div>
      <div className="chart-card distribution-card"><h3>Category Distribution</h3>{categoryDistribution.length ? categoryDistribution.map((item) => <div className="distribution-row" key={item.type}><span className={`type-icon ${item.type.toLowerCase()}`}>{React.createElement(iconForType(item.type), { size: 18 })}</span><p>{item.type}</p><div><span style={{ width: `${Math.max(8, item.count / totalCategoryCount * 100)}%` }} /></div><b>{Math.round(item.count / totalCategoryCount * 100)}%</b></div>) : <p className="muted-line">No categories yet.</p>}</div>
    </section>
    <section className="chart-card topics-card"><div className="card-title-row"><h3>Trending Topics</h3><span>{activeTags.length} active</span></div><div className="topic-cloud">{activeTags.length ? activeTags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>) : <span>No tags yet</span>}</div></section>
    <section className="insights-bottom">
      <div className="chart-card ai-review-card"><div className="card-title-row"><h3>{aiReview.provider === "google" ? "Gemini Review" : "Local Review"}</h3><span>{aiReview.nextActions.length} actions</span></div><h4>{aiReview.headline}</h4><p>{aiReview.focus}</p><div className="mini-ai-list">{[...aiReview.nextActions, ...aiReview.risks].slice(0, 3).map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}</div></div>
      {pluginSettings.receiptScanner && <div className="chart-card money-card compact-money-card"><div className="card-title-row"><h3>Money Signals</h3><span>{money.length} items</span></div><div className="money-total-grid"><div className="money-total income"><span>Income</span><b>+{formatMoney(income, profile.currency)}</b></div><div className="money-total expense"><span>Expenses</span><b>-{formatMoney(expense, profile.currency)}</b></div></div><div className="money-signal-list">{money.slice(0, 4).map((signal) => <div className={`money-row ${signal.direction}`} key={signal.key}><span title={signal.reason}>{signal.title}</span><b>{formatSignedMoney(signal.amount, signal.currency, signal.direction)}</b></div>)}{!money.length && <p className="muted-line">No money captures yet.</p>}</div></div>}
    </section>
  </div>;
}

function TagManager() {
  const { captures, setCaptures, tagColors, setTagColors } = useBrain();
  const [newTag, setNewTag] = React.useState("");
  const [tagDrafts, setTagDrafts] = React.useState<Record<string, string>>({});
  const tagStats = Array.from(new Set([...presetTags, ...captures.flatMap((capture) => visibleCaptureTags(capture.metadata))])).sort((a, b) => a.localeCompare(b)).map((tag) => ({ tag, count: captures.filter((capture) => visibleCaptureTags(capture.metadata).includes(tag)).length }));
  const addTag = () => {
    const tag = newTag.trim();
    if (!tag) return;
    setCaptures((current) => current.length ? current.map((capture, index) => index === 0 ? { ...capture, metadata: Array.from(new Set([...capture.metadata, tag])) } : capture) : current);
    setNewTag("");
  };
  const renameTag = (oldTag: string) => {
    const nextTag = (tagDrafts[oldTag] ?? oldTag).trim();
    if (!nextTag || nextTag === oldTag) return;
    setCaptures((current) => current.map((capture) => ({ ...capture, metadata: capture.metadata.map((tag) => tag === oldTag ? nextTag : tag) })));
    setTagColors((current) => {
      const next = { ...current };
      if (next[oldTag] && !next[nextTag]) next[nextTag] = next[oldTag];
      delete next[oldTag];
      return next;
    });
    setTagDrafts((current) => ({ ...current, [oldTag]: nextTag, [nextTag]: nextTag }));
  };
  const removeTag = (tag: string) => setCaptures((current) => current.map((capture) => ({ ...capture, metadata: capture.metadata.filter((item) => item !== tag) })));
  return (
    <section className="settings-card tag-manager">
      <div className="tag-manager-head"><div><h3>Tags</h3><p>Edit names directly, choose a color, or remove tags from every capture.</p></div></div>
      <div className="tag-create-row"><input value={newTag} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTag(); }} placeholder="Create a new tag..." /><button onClick={addTag}>Add tag</button></div>
      <div className="tag-manager-list">
        {tagStats.map(({ tag, count }) => <div className="tag-manager-row" key={tag} style={tagChipStyle(tag, tagColors)}>
          <div className="tag-edit-cell">
            <span />
            <input value={tagDrafts[tag] ?? tag} onChange={(event) => setTagDrafts((current) => ({ ...current, [tag]: event.target.value }))} onBlur={() => renameTag(tag)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          </div>
          <b>{count} uses</b>
          <div className="tag-color-dots">{tagPalette.slice(0, 6).map((color) => <button key={color} className={tagColorFor(tag, tagColors) === color ? "active" : ""} style={{ "--swatch": color } as React.CSSProperties} onClick={() => setTagColors((current) => ({ ...current, [tag]: color }))} title={color} />)}</div>
          <button className="remove-tag" onClick={() => removeTag(tag)}><Trash2 size={14} /></button>
        </div>)}
      </div>
    </section>
  );
}

function SettingsView() {
  const { captures, setCaptures, profile, setProfile, authUser, setAuthUser, googleConfigured, pluginSettings, setPluginSettings, syncStatus, setView, privatePinHash, setPrivatePinHash, setPrivateSessionPin } = useBrain();
  const [settingsTab, setSettingsTab] = React.useState<"Profile" | "Connections" | "Plugins" | "Data & Privacy" | "Billing" | "Tags">(() => {
    const saved = localStorage.getItem("nube-settings-tab");
    localStorage.removeItem("nube-settings-tab");
    return saved === "Data & Privacy" ? "Data & Privacy" : "Profile";
  });
  const avatarInput = React.useRef<HTMLInputElement>(null);
  const calendarInput = React.useRef<HTMLInputElement>(null);
  const locationRequested = React.useRef(false);
  const calendarSyncRef = React.useRef<((options?: { silent?: boolean }) => Promise<void>) | null>(null);
  const [authStatus, setAuthStatus] = React.useState<string | null>(null);
  const [locationStatus, setLocationStatus] = React.useState<string | null>(null);
  const [calendarStatus, setCalendarStatus] = React.useState<{ configured: boolean; connected: boolean; scope: string | null } | null>(null);
  const [calendarSyncing, setCalendarSyncing] = React.useState(false);
  const [calendarAutoSync, setCalendarAutoSync] = React.useState(() => localStorage.getItem("nube-calendar-auto-sync") === "true");
  const [calendarRange, setCalendarRange] = React.useState(() => localStorage.getItem("nube-calendar-range") || "6m");
  const [gmailStatus, setGmailStatus] = React.useState<{ configured: boolean; connected: boolean; enabled: boolean; scope: string | null } | null>(null);
  const [gmailSyncing, setGmailSyncing] = React.useState(false);
  const [gmailFilters, setGmailFilters] = React.useState({ range: "all", receipts: false, bookings: false, attachments: false, unreadOnly: false, importantOnly: true, specialOnly: false });
  const [gmailPreviews, setGmailPreviews] = React.useState<Array<{ id: string; subject: string; from: string; snippet: string; bodyPreview: string; attachments: Array<{ filename: string; mimeType: string; size: number | null }> }>>([]);
  const [selectedGmailIds, setSelectedGmailIds] = React.useState<Set<string>>(() => new Set());
  const [gmailPreviewed, setGmailPreviewed] = React.useState(false);
  const [gmailFiltersOpen, setGmailFiltersOpen] = React.useState(false);
  const [gmailShowAll, setGmailShowAll] = React.useState(false);
  const [integrationStatus, setIntegrationStatus] = React.useState<{ token: string; emailForwarding: { endpoint: string; enabled: boolean; address?: string; signed?: boolean }; webhooks: { endpoint: string; enabled: boolean } } | null>(null);
  const [integrationMessage, setIntegrationMessage] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<ActivityEvent[]>([]);
  const [importBatches, setImportBatches] = React.useState<ImportBatch[]>([]);
  const [systemHealth, setSystemHealth] = React.useState<{ objectStorage?: string; cloudDatabase?: string; cloudDatabaseStatus?: { configured?: boolean; provider?: string | null; mode?: string; schema?: string }; limits?: { maxUploadBytes?: number; allowedFileTypes?: string[] }; releaseReadiness?: { ready: number; total: number; productionReady: boolean; checks: Array<{ id: string; label: string; ok: boolean; detail: string }> } } | null>(null);
  const [cloudSyncInfo, setCloudSyncInfo] = React.useState<CloudSyncInfo | null>(null);
  const [cloudSyncing, setCloudSyncing] = React.useState(false);
  const [selectedPluginId, setSelectedPluginId] = React.useState("smart-reminders");
  const [editingProfileName, setEditingProfileName] = React.useState(false);
  const [privatePinDraft, setPrivatePinDraft] = React.useState("");
  const [privatePinCurrent, setPrivatePinCurrent] = React.useState("");
  const [privatePinMessage, setPrivatePinMessage] = React.useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [notificationPermission, setNotificationPermission] = React.useState<NotificationPermission>(() => typeof window !== "undefined" && "Notification" in window ? Notification.permission : "denied");
  const scheduledCount = captures.filter((capture) => capture.due && !capture.completed).length;
  const highPriorityCount = captures.filter((capture) => capture.priority === "High" && !capture.completed).length;
  const receiptSignals = moneySignalsFor(captures);
  const privacySignals = privacySignalsFor(captures);
  const plugins = [
    { id: "smart-reminders", icon: Bell, title: "Smart Reminders", status: pluginSettings.smartReminders ? "Enabled" : "Off", enabled: pluginSettings.smartReminders, text: "Surface due dates, priority captures, and review prompts inside Today.", detail: "Smart Reminders watches captures for dates, priorities, and review moments, then puts the useful ones into Calendar, Upcoming, Today filters, and Daily Review." },
    { id: "receipt-scanner", icon: ReceiptText, title: "Receipt Scanner", status: pluginSettings.receiptScanner ? "Enabled" : "Off", enabled: pluginSettings.receiptScanner, text: "Extract merchants, totals, dates, and categories from receipts.", detail: "Receipt Scanner reads receipt-style captures, image uploads, and money text, then surfaces totals inside Money Signals." },
    { id: "privacy-guard", icon: Lock, title: "Privacy Guard", status: pluginSettings.privacyGuard ? "Enabled" : "Off", enabled: pluginSettings.privacyGuard, text: "Flag sensitive text, file names, emails, IDs, and secrets before they get buried.", detail: "Privacy Guard scans local capture text and file names for sensitive-looking content and surfaces lightweight warnings." },
  ];
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? plugins[0];
  const enabledPluginCount = [pluginSettings.smartReminders, pluginSettings.receiptScanner, pluginSettings.privacyGuard].filter(Boolean).length;
  const setPluginEnabled = (id: string, enabled: boolean) => {
    setPluginSettings((current) => {
      if (id === "smart-reminders") return { ...current, smartReminders: enabled };
      if (id === "receipt-scanner") return { ...current, receiptScanner: enabled };
      if (id === "privacy-guard") return { ...current, privacyGuard: enabled };
      return current;
    });
  };
  const requestReminderNotifications = async () => {
    if (!("Notification" in window)) {
      setAuthStatus("Browser notifications are not supported here.");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    setAuthStatus(permission === "granted" ? "Browser reminders are enabled." : "Browser reminders are blocked. Enable them from browser settings.");
  };
  const savePrivatePin = async () => {
    const nextPin = privatePinDraft.trim();
    const currentPin = privatePinCurrent.trim();
    if (privatePinHash && hashPrivatePin(currentPin) !== privatePinHash) {
      setPrivatePinMessage({ type: "error", text: "Current PIN does not match." });
      return;
    }
    if (nextPin.length < 4) {
      setPrivatePinMessage({ type: "error", text: "Use at least 4 digits or characters." });
      return;
    }
    if (privatePinHash) {
      try {
        const nextCaptures = await Promise.all(captures.map(async (capture) => {
          if (!capture.privateEncryptedData) return capture;
          const payload = await decryptPrivatePayload(capture.privateEncryptedData, currentPin);
          const privateEncryptedData = await encryptPrivatePayload({ ...capture, ...payload } as Capture, nextPin);
          return { ...maskPrivateCaptureForStorage({ ...capture, ...payload } as Capture), private: true, privateEncryptedData, privateEncryptedAt: new Date().toISOString() };
        }));
        setCaptures(nextCaptures);
      } catch {
        setPrivatePinMessage({ type: "error", text: "Current PIN could not decrypt every private capture." });
        return;
      }
    }
    setPrivatePinHash(hashPrivatePin(nextPin));
    setPrivateSessionPin(nextPin);
    setPrivatePinDraft("");
    setPrivatePinCurrent("");
    setPrivatePinMessage({ type: "ok", text: privatePinHash ? "Private PIN changed." : "Private PIN set." });
  };
  const removePrivatePin = async () => {
    if (!privatePinHash) return;
    const currentPin = privatePinCurrent.trim();
    if (hashPrivatePin(currentPin) !== privatePinHash) {
      setPrivatePinMessage({ type: "error", text: "Enter the current PIN before removing it." });
      return;
    }
    try {
      const nextCaptures = await Promise.all(captures.map(async (capture) => {
        if (!capture.privateEncryptedData) return { ...capture, private: false, privateEncryptedData: undefined, privateEncryptedAt: undefined };
        const payload = await decryptPrivatePayload(capture.privateEncryptedData, currentPin);
        return { ...capture, ...payload, private: false, privateEncryptedData: undefined, privateEncryptedAt: undefined };
      }));
      setCaptures(nextCaptures);
    } catch {
      setPrivatePinMessage({ type: "error", text: "Current PIN could not decrypt every private capture." });
      return;
    }
    setPrivatePinHash("");
    setPrivateSessionPin("");
    setPrivatePinDraft("");
    setPrivatePinCurrent("");
    setPrivatePinMessage({ type: "ok", text: "Private PIN removed and private captures are visible again." });
  };
  const clearLocalVault = () => {
    const confirmed = window.confirm("Delete the local browser copy of your captures on this device? Export your vault first if you need a backup.");
    if (!confirmed) return;
    setCaptures([]);
    localStorage.removeItem("nube-second-brain-rebuilt");
    localStorage.removeItem(UPLOAD_QUEUE_KEY);
    localStorage.removeItem(PENDING_VOICE_KEY);
    localStorage.removeItem("nube-notified-reminders");
    setAuthStatus("Local browser vault cleared on this device.");
  };
  const tabs = [
    { id: "Profile", icon: User },
    { id: "Connections", icon: Cloud },
    { id: "Plugins", icon: Puzzle },
    { id: "Data & Privacy", icon: Lock },
    { id: "Billing", icon: Star },
    { id: "Tags", icon: Sparkles },
  ] as const;
  const settingsSubtitle = settingsTab === "Profile"
    ? "Identity, avatar, location, and currency."
    : settingsTab === "Connections"
      ? "Google, browser, email, and external sources."
      : settingsTab === "Plugins"
        ? "Optional background capabilities."
        : settingsTab === "Data & Privacy"
          ? "Vault, imports, exports, and privacy controls."
          : settingsTab === "Billing"
            ? "Plan, limits, and upgrade path."
            : "Rename, color, and clean your tags.";
  const storageUsedBytes = estimateStorageBytes(captures);
  const storageLimitBytes = fallbackPlanCatalog.free.storageGb * 1024 * 1024 * 1024;
  const storagePercent = Math.min(100, Math.round(storageUsedBytes / storageLimitBytes * 100));
  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    const localPreview = URL.createObjectURL(file);
    setProfile((current) => ({ ...current, avatarUrl: localPreview }));
    if (!authUser) {
      setAuthStatus("Login with Google to save this avatar across sessions.");
      return;
    }
    const data = new FormData();
    data.append("file", file);
    const response = await fetch("/api/profile/avatar", { method: "POST", body: data });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { error?: string } | null;
      setAuthStatus(friendlyError(new Error(error?.error || "Avatar upload failed."), "Avatar upload failed."));
      return;
    }
    const result = await response.json() as { user: AuthUser };
    setAuthUser(result.user);
    setProfile((current) => ({ ...current, avatarUrl: result.user.avatarUrl || current.avatarUrl }));
    setAuthStatus("Avatar updated.");
  };
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthUser(null);
    setProfile((current) => ({ ...current, authProvider: "local", email: undefined }));
  };
  const importCalendarFile = async (file: File | undefined) => {
    if (!file) return;
    const imported = parseIcsCaptures(await file.text());
    const createdAt = new Date().toISOString();
    const nextCaptures: Capture[] = imported.map((item, index) => sanitizeLocalCapture({
      id: Date.now() + index,
      title: item.title ?? "Imported calendar event",
      text: item.text ?? "",
      type: item.type ?? "Actionable",
      source: item.source ?? "calendar import",
      time: "Now",
      metadata: item.metadata ?? ["Calendar import"],
      createdAt,
      due: item.due,
      priority: item.priority,
      provider: "browser-fallback",
      confidence: 0.74,
    }));
    setCaptures((current) => [...nextCaptures, ...current]);
    setAuthStatus(nextCaptures.length ? `${nextCaptures.length} calendar event${nextCaptures.length === 1 ? "" : "s"} imported.` : "No events found in that calendar file.");
  };
  const syncGoogleCalendar = async (options: { silent?: boolean } = {}) => {
    if (!authUser) {
      if (!options.silent) setAuthStatus("Sign in with Google first.");
      return;
    }
    setCalendarSyncing(true);
    if (!options.silent) setAuthStatus("Importing Google Calendar events...");
    try {
      const response = await fetch("/api/calendar/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ range: calendarRange, max: calendarRange === "1y" ? 100 : 50 }) });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(error?.error || "Calendar import failed.");
      }
      const result = await response.json() as { imported: number; skipped?: number; ignored?: number; captures: Capture[]; batch?: ImportBatch | null };
      const importedCaptures = (result.captures ?? []).map(sanitizeLocalCapture);
      setCaptures((current) => {
        const existingIds = new Set(current.map((capture) => capture.id));
        const fresh = importedCaptures.filter((capture) => !existingIds.has(capture.id));
        return [...fresh, ...current];
      });
      const ignored = result.ignored ? `, ${result.ignored} birthday/cancelled event${result.ignored === 1 ? "" : "s"} ignored` : "";
      if (!options.silent || result.imported) setAuthStatus(result.imported ? `${result.imported} Google Calendar event${result.imported === 1 ? "" : "s"} imported${result.skipped ? `, ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped` : ""}${ignored}.` : result.skipped ? `${result.skipped} duplicate event${result.skipped === 1 ? "" : "s"} skipped${ignored}.` : `No upcoming events found${ignored}.`);
      if (result.batch) setImportBatches((current) => [result.batch!, ...current.filter((batch) => batch.id !== result.batch!.id)]);
      if (!options.silent) window.setTimeout(() => setAuthStatus(null), 3500);
      refreshActivity();
    } catch (error) {
      if (!options.silent) setAuthStatus(friendlyError(error, "Calendar import failed."));
    } finally {
      setCalendarSyncing(false);
    }
  };
  calendarSyncRef.current = syncGoogleCalendar;
  const disconnectGoogleCalendar = async () => {
    setCalendarSyncing(true);
    setAuthStatus("Disconnecting Google Calendar...");
    try {
      const response = await fetch("/api/calendar/disconnect", { method: "POST" });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(error?.error || "Calendar disconnect failed.");
      }
      setCalendarStatus((current) => current ? { ...current, connected: false, scope: null } : { configured: googleConfigured, connected: false, scope: null });
      setCalendarAutoSync(false);
      localStorage.setItem("nube-calendar-auto-sync", "false");
      setAuthStatus("Google Calendar disconnected.");
      refreshActivity();
    } catch (error) {
      setAuthStatus(friendlyError(error, "Calendar disconnect failed."));
    } finally {
      setCalendarSyncing(false);
    }
  };
  const toggleCalendarAutoSync = (enabled: boolean) => {
    if (!calendarStatus?.connected) {
      window.location.href = "/api/auth/google";
      return;
    }
    setCalendarAutoSync(enabled);
    localStorage.setItem("nube-calendar-auto-sync", String(enabled));
    setAuthStatus(enabled ? "Calendar auto-sync is on. Nube will check every 30 minutes while open." : "Calendar auto-sync is off.");
    if (enabled) void syncGoogleCalendar({ silent: true });
  };
  const updateCalendarRange = (range: string) => {
    setCalendarRange(range);
    localStorage.setItem("nube-calendar-range", range);
  };
  const previewGmail = async () => {
    if (!authUser) {
      setAuthStatus("Sign in with Google first.");
      return;
    }
    if (!gmailStatus?.connected) {
      window.location.href = "/api/auth/google";
      return;
    }
    if (!gmailStatus.enabled) {
      setAuthStatus("Turn Gmail Import on before scanning.");
      return;
    }
    setGmailSyncing(true);
    setAuthStatus("Scanning Gmail with Nube filters...");
    try {
      const response = await fetch("/api/gmail/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...gmailFilters, max: 100 }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(error?.error || "Gmail preview failed.");
      }
      const result = await response.json() as { previews: typeof gmailPreviews };
      setGmailPreviews(result.previews ?? []);
      setSelectedGmailIds(new Set((result.previews ?? []).map((preview) => preview.id)));
      setGmailShowAll(false);
      setGmailPreviewed(true);
      setAuthStatus(result.previews?.length ? `${result.previews.length} useful Gmail message${result.previews.length === 1 ? "" : "s"} found. Review before importing.` : "No useful Gmail messages found with these filters.");
    } catch (error) {
      setAuthStatus(friendlyError(error, "Gmail preview failed."));
    } finally {
      setGmailSyncing(false);
    }
  };
  const importGmail = async () => {
    setGmailSyncing(true);
    setAuthStatus("Importing selected Gmail messages...");
    try {
      const response = await fetch("/api/gmail/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: { ...gmailFilters, max: 100 }, ids: Array.from(selectedGmailIds) }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(error?.error || "Gmail import failed.");
      }
      const result = await response.json() as { imported: number; skipped: number; captures: Capture[]; batch?: ImportBatch | null };
      const importedCaptures = (result.captures ?? []).map(sanitizeLocalCapture);
      setCaptures((current) => {
        const existingIds = new Set(current.map((capture) => capture.id));
        return [...importedCaptures.filter((capture) => !existingIds.has(capture.id)), ...current];
      });
      if (result.batch) setImportBatches((current) => [result.batch!, ...current.filter((batch) => batch.id !== result.batch!.id)]);
      setAuthStatus(result.imported ? `${result.imported} Gmail message${result.imported === 1 ? "" : "s"} imported${result.skipped ? `, ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped` : ""}.` : result.skipped ? `${result.skipped} duplicate Gmail message${result.skipped === 1 ? "" : "s"} skipped.` : "No Gmail messages imported.");
      setGmailPreviews([]);
      setSelectedGmailIds(new Set());
      setGmailPreviewed(false);
      setGmailShowAll(false);
      window.setTimeout(() => setAuthStatus(null), 3500);
      refreshActivity();
    } catch (error) {
      setAuthStatus(friendlyError(error, "Gmail import failed."));
    } finally {
      setGmailSyncing(false);
    }
  };
  const toggleGmail = async (enabled: boolean) => {
    if (enabled) {
      window.location.href = "/api/auth/google";
      return;
    }
    setGmailSyncing(true);
    try {
      const response = await fetch("/api/gmail/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error("Could not update Gmail status.");
      setGmailStatus((current) => current ? { ...current, enabled } : current);
      if (!enabled) {
        setGmailPreviews([]);
        setSelectedGmailIds(new Set());
        setGmailPreviewed(false);
        setGmailShowAll(false);
      }
      setAuthStatus(enabled ? "Gmail Import is on." : "Gmail Import paused.");
      refreshActivity();
    } catch (error) {
      setAuthStatus(friendlyError(error, "Could not update Gmail status."));
    } finally {
      setGmailSyncing(false);
    }
  };
  const refreshIntegrationStatus = React.useCallback(() => {
    void fetch("/api/integrations/status")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("integrations unavailable")))
      .then(setIntegrationStatus)
      .catch(() => setIntegrationStatus(null));
  }, []);
  const refreshActivity = React.useCallback(() => {
    void fetch("/api/activity")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("activity unavailable")))
      .then((data: { activity: ActivityEvent[] }) => setActivity(data.activity ?? []))
      .catch(() => setActivity([]));
  }, []);
  const refreshImports = React.useCallback(() => {
    void fetch("/api/imports")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("imports unavailable")))
      .then((data: { imports: ImportBatch[] }) => setImportBatches(data.imports ?? []))
      .catch(() => setImportBatches([]));
  }, []);
  const refreshCloudSync = React.useCallback(() => {
    void fetch("/api/sync/status")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("sync unavailable")))
      .then((data: CloudSyncInfo) => setCloudSyncInfo(data))
      .catch(() => setCloudSyncInfo(null));
  }, []);
  const pushLocalVaultToCloud = async () => {
    setCloudSyncing(true);
    setAuthStatus("Preparing local vault for cloud sync...");
    try {
      const response = await fetch("/api/sync/push-local", { method: "POST" });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(error?.error || "Cloud sync is not ready.");
      }
      const result = await response.json() as { pushed: number; cloudCaptures: number };
      setAuthStatus(`${result.pushed} capture${result.pushed === 1 ? "" : "s"} pushed to cloud sync.`);
      setCloudSyncInfo((current) => current ? { ...current, cloudReady: true, cloudCaptures: result.cloudCaptures, storage: "cloud-postgres" } : current);
      refreshActivity();
      refreshCloudSync();
    } catch (error) {
      setAuthStatus(friendlyError(error, "Cloud sync failed."));
    } finally {
      setCloudSyncing(false);
    }
  };
  const deleteImportBatch = async (batch: ImportBatch) => {
    if (!window.confirm(`Move ${batch.count} capture${batch.count === 1 ? "" : "s"} from ${batch.title} to Trash?`)) return;
    const ids = new Set(batch.captureIds.map(Number));
    const deletedAt = new Date().toISOString();
    setCaptures((current) => current.map((capture) => ids.has(Number(capture.id)) ? { ...capture, deletedAt, archived: false } : capture));
    setImportBatches((current) => current.filter((item) => item.id !== batch.id));
    setAuthStatus(`${batch.count} imported capture${batch.count === 1 ? "" : "s"} moved to Trash.`);
    refreshActivity();
  };
  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setIntegrationMessage(`${label} copied.`);
    } catch {
      setIntegrationMessage(`Could not copy ${label.toLowerCase()}.`);
    }
    window.setTimeout(() => setIntegrationMessage(null), 2200);
  };
  const rotateToken = async () => {
    const response = await fetch("/api/integrations/token/rotate", { method: "POST" });
    if (!response.ok) {
      setIntegrationMessage("Sign in with Google before rotating the token.");
      return;
    }
    const data = await response.json() as { token: string };
    setIntegrationStatus((current) => current ? { ...current, token: data.token } : current);
    setIntegrationMessage("Private token regenerated.");
  };
  const sendTestWebhook = async () => {
    if (!integrationStatus?.token) return;
    setIntegrationMessage("Sending test capture...");
    const response = await fetch("/api/integrations/webhook/capture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${integrationStatus.token}`,
      },
      body: JSON.stringify({
        title: "Webhook test capture",
        text: "This capture was created from the Nube Webhooks & API connection.",
        source: "webhook test",
        tags: ["API", "Test"],
      }),
    });
    if (!response.ok) {
      setIntegrationMessage("Test webhook failed.");
      return;
    }
    const result = await response.json() as { capture: Capture; duplicate?: boolean };
    if (!result.duplicate) setCaptures((current) => [result.capture, ...current]);
    setIntegrationMessage(result.duplicate ? "Duplicate test capture skipped." : "Test capture created.");
    refreshActivity();
  };
  const detectLocation = React.useCallback(() => {
    if (!navigator.geolocation) {
      setLocationStatus("Location is not supported in this browser.");
      return;
    }
    setLocationStatus("Detecting your location...");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          const response = await fetch(`/api/location/reverse?lat=${latitude}&lng=${longitude}`);
          if (!response.ok) throw new Error("Reverse geocoding failed.");
          const location = await response.json() as { city: string; label: string; latitude: number; longitude: number };
          setProfile((current) => ({
            ...current,
            city: location.city,
            locationLabel: location.label,
            latitude: location.latitude,
            longitude: location.longitude,
          }));
          setLocationStatus(`Location detected: ${location.label}`);
        } catch {
          setProfile((current) => ({
            ...current,
            city: "Current location",
            locationLabel: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
            latitude,
            longitude,
          }));
          setLocationStatus("Location detected. Maps lookup is unavailable right now.");
        }
      },
      () => setLocationStatus("Location permission was denied."),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 30 * 60 * 1000 },
    );
  }, [setProfile]);
  React.useEffect(() => {
    if (settingsTab !== "Profile" || profile.latitude || locationRequested.current) return;
    locationRequested.current = true;
    detectLocation();
  }, [detectLocation, profile.latitude, settingsTab]);
  React.useEffect(() => {
    if (!calendarAutoSync || !calendarStatus?.connected || !authUser) return;
    const timer = window.setInterval(() => void calendarSyncRef.current?.({ silent: true }), 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [authUser, calendarAutoSync, calendarStatus?.connected]);
  React.useEffect(() => {
    void fetch("/api/calendar/status")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("calendar unavailable")))
      .then(setCalendarStatus)
      .catch(() => setCalendarStatus(null));
    void fetch("/api/gmail/status")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("gmail unavailable")))
      .then(setGmailStatus)
      .catch(() => setGmailStatus(null));
    refreshIntegrationStatus();
    refreshActivity();
    refreshImports();
    refreshCloudSync();
    void fetch("/api/health")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("health unavailable")))
      .then(setSystemHealth)
      .catch(() => setSystemHealth(null));
  }, [authUser, refreshIntegrationStatus, refreshActivity, refreshImports, refreshCloudSync]);
  return <div className="settings-grid">
    <section className="settings-card wide settings-hero">
      <div>
        <p className="eyebrow">Settings</p>
        <h2>{settingsTab}</h2>
        <p>{settingsSubtitle}</p>
      </div>
      <Avatar profile={profile} />
    </section>

    <aside className="settings-card settings-nav-card">
      <div className="settings-profile-mini">
        <Avatar profile={profile} size="mini" />
        <div><b>{profile.name}</b><span>{authUser ? "Google account" : `${profile.city} · ${profile.currency}`}</span></div>
      </div>
      <div className="settings-nav">
        {tabs.map(({ id, icon: Icon }) => <button key={id} className={settingsTab === id ? "active" : ""} onClick={() => setSettingsTab(id)}><Icon size={17} /><span>{id}</span></button>)}
      </div>
      <div className="settings-storage-mini">
        <p className="eyebrow">Storage</p>
        <div><span style={{ width: `${storageUsedBytes > 0 ? Math.max(1, storagePercent) : 0}%` }} /></div>
        <b>{formatStorageUsage(storageUsedBytes)} of {fallbackPlanCatalog.free.storageGb} GB</b>
      </div>
      <div className={`settings-sync-mini ${syncStatus.status}`}>
        <p className="eyebrow">Sync</p>
        <b>{syncStatus.status === "saved" ? "Synced" : syncStatus.status === "saving" ? "Syncing" : syncStatus.status === "offline" ? "Offline" : syncStatus.status === "error" ? "Needs attention" : "Ready"}</b>
        <span>{syncStatus.pending ? `${syncStatus.pending} pending` : syncStatus.lastSyncedAt ? `Last ${new Date(syncStatus.lastSyncedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "Local vault ready"}</span>
      </div>
    </aside>

    <main className="settings-content">
      {settingsTab === "Profile" && <section className="settings-card profile-card">
        <div className="profile-hero-row">
          <button className="profile-avatar-upload" onClick={() => avatarInput.current?.click()} title="Upload avatar"><Avatar profile={profile} size="large" /><Image size={18} /></button>
          <input ref={avatarInput} className="hidden-file" type="file" accept="image/*" onChange={(event) => { void uploadAvatar(event.target.files?.[0]); event.currentTarget.value = ""; }} />
          <div className="profile-name-block">
            <div className="profile-name-row">
              {editingProfileName ? <input autoFocus value={profile.name} onBlur={() => setEditingProfileName(false)} onChange={(event) => setProfile((current) => ({ ...current, name: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") setEditingProfileName(false); }} /> : <h3>{profile.name}</h3>}
              <button className="profile-name-edit" onClick={() => setEditingProfileName((current) => !current)} title="Edit name" type="button"><Pencil size={15} /></button>
            </div>
            <p>{authUser ? profile.email : "Personal context used for greetings, weather, money formatting, and future account features."}</p>
          </div>
        </div>
        <div className="auth-panel">
          <div><b>{authUser ? "Signed in with Google" : "Google sign-in required"}</b><span>{authUser ? authUser.email : googleConfigured ? "Sign in to use Nube with a synced identity and cloud avatar." : "Google OAuth needs client credentials in .env before sign-in can work."}</span></div>
          {authUser ? <button onClick={() => void logout()}>Logout</button> : <button disabled={!googleConfigured} onClick={() => { window.location.href = "/api/auth/google"; }}>Sign in with Google</button>}
        </div>
        {authStatus && <p className="auth-status">{authStatus}</p>}
        <div className="profile-form-grid">
          <div className="location-card">
            <div>
              <span>Detected location</span>
              <b>{profile.locationLabel || profile.city || "Waiting for browser permission"}</b>
              <small>{locationStatus || "Used for weather, place context, and future location reminders."}</small>
            </div>
            <button onClick={detectLocation}>Refresh</button>
          </div>
          <div className="currency-picker">
            <span>Currency</span>
            <div className="currency-options">
              {(["EUR", "USD", "GBP"] as const).map((currency) => <button key={currency} className={profile.currency === currency ? "active" : ""} onClick={() => setProfile((current) => ({ ...current, currency }))}><b>{currencySymbol(currency)}</b><span>{currency}</span></button>)}
            </div>
          </div>
        </div>
      </section>}

      {settingsTab === "Tags" && <TagManager />}

      {settingsTab === "Data & Privacy" && <section className="settings-card integrations-section compact-settings-section">
        <div className="private-pin-card">
          <div>
            <p className="eyebrow">Private captures</p>
            <h3>{privatePinHash ? "Private PIN is active." : "Set a Private PIN."}</h3>
            <p>Lock sensitive captures so their title, content, tags, and money signals stay hidden until you unlock them on this device.</p>
            <small>{privatePinHash ? "Unlocked private captures auto-lock after 10 minutes of inactivity." : "Use at least 4 digits or characters. This is a local privacy lock, not a password manager."}</small>
          </div>
          <div className="private-pin-actions">
            {privatePinHash && <input type="password" inputMode="numeric" value={privatePinCurrent} onChange={(event) => { setPrivatePinCurrent(event.target.value); setPrivatePinMessage(null); }} placeholder="Current PIN" />}
            <input type="password" inputMode="numeric" value={privatePinDraft} onChange={(event) => { setPrivatePinDraft(event.target.value); setPrivatePinMessage(null); }} onKeyDown={(event) => { if (event.key === "Enter") void savePrivatePin(); }} placeholder={privatePinHash ? "New PIN" : "Create PIN"} />
            <button onClick={() => void savePrivatePin()}><Lock size={16} />{privatePinHash ? "Change PIN" : "Set PIN"}</button>
            {privatePinHash && <button onClick={() => void removePrivatePin()}><X size={16} />Remove</button>}
            {privatePinMessage && <div className={`private-pin-message ${privatePinMessage.type}`}>{privatePinMessage.text}</div>}
          </div>
        </div>
        <div className={`sync-health-card ${syncStatus.status}`}>
          <div>
            <p className="eyebrow">Vault sync</p>
            <h3>{syncStatus.status === "saved" ? "Everything is synced." : syncStatus.status === "saving" ? "Saving changes in the background." : syncStatus.status === "offline" ? "Offline queue is active." : syncStatus.status === "error" ? "Sync needs attention." : "Ready to sync changes."}</h3>
            <p>{syncStatus.message}</p>
          </div>
          <span>{syncStatus.pending ? `${syncStatus.pending} queued` : "0 queued"}</span>
        </div>
        <div className="cloud-sync-card">
          <div>
            <p className="eyebrow">Sync</p>
            <h3>{cloudSyncInfo?.cloudReady ? "Your vault is ready across devices." : cloudSyncInfo?.cloudConfigured ? "Cloud sync is ready." : "This device is storing Nube locally."}</h3>
            <p>{cloudSyncInfo?.cloudConfigured ? `${cloudSyncInfo.cloudCaptures} saved online · ${cloudSyncInfo.localCaptures} saved on this device.` : "Cloud sync will appear here when your production account storage is connected."}</p>
          </div>
          <div className="cloud-sync-actions">
            <button onClick={refreshCloudSync}><RefreshCw size={16} />Refresh</button>
            <button disabled={!cloudSyncInfo?.signedIn || !cloudSyncInfo?.cloudConfigured || cloudSyncing} onClick={() => void pushLocalVaultToCloud()}><Cloud size={16} />{cloudSyncing ? "Syncing..." : "Push local vault"}</button>
          </div>
        </div>
        <div className="activity-log-card">
          <div className="settings-section-head">
            <div><p className="eyebrow">Activity</p><h2>Recent system events</h2></div>
            <button onClick={refreshActivity}><RefreshCw size={16} />Refresh</button>
          </div>
          <div className="activity-list">
            {activity.length ? activity.slice(0, 8).map((event) => <article className={`activity-item ${event.level}`} key={event.id}>
              <span>{event.level === "success" ? <CheckCircle2 size={16} /> : event.level === "warning" ? <Bell size={16} /> : event.level === "error" ? <X size={16} /> : <Sparkles size={16} />}</span>
              <div><b>{event.title}</b><p>{event.detail}</p></div>
              <small>{event.source}<br />{new Date(event.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</small>
            </article>) : <p className="empty-state">No activity yet. Imports and external captures will appear here.</p>}
          </div>
        </div>
        <div className="import-batches-card">
          <div className="settings-section-head">
            <div><p className="eyebrow">Import history</p><h2>Undo imported batches</h2></div>
            <button onClick={refreshImports}><RefreshCw size={16} />Refresh</button>
          </div>
          <div className="import-batch-list">
            {importBatches.length ? importBatches.map((batch) => <article key={batch.id}>
              <span>{batch.provider === "gmail" ? <Mail size={16} /> : <CalendarCheck size={16} />}</span>
              <div><b>{batch.title}</b><p>{batch.detail || `${batch.count} capture${batch.count === 1 ? "" : "s"} imported.`}</p><small>{new Date(batch.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{batch.skipped ? ` · ${batch.skipped} skipped` : ""}</small></div>
              <button onClick={() => void deleteImportBatch(batch)}><Trash2 size={15} />Delete all</button>
            </article>) : <p className="empty-state">No import batches yet. Gmail and Calendar imports will appear here.</p>}
          </div>
        </div>
        <div className="vault-export-card">
          <div>
            <p className="eyebrow">Vault export</p>
            <h3>Keep a copy of your Nube data.</h3>
            <p>Export captures for backup, spreadsheets, calendars, or readable notes.</p>
          </div>
          <div className="vault-export-actions">
            <button onClick={() => exportVaultJson(captures, profile)}><Archive size={16} />JSON</button>
            <button onClick={() => exportVaultMarkdown(captures)}><NotebookText size={16} />Markdown</button>
            <button onClick={() => exportVaultCsv(captures)}><ReceiptText size={16} />CSV</button>
            <button onClick={() => exportVaultIcs(captures)}><CalendarCheck size={16} />ICS</button>
          </div>
        </div>
        <div className="privacy-control-grid">
          <article>
            <div><p className="eyebrow">Local data</p><h3>Clear this device.</h3><p>Deletes the browser copy, upload retry queue, pending voice draft, and reminder notification cache on this device only.</p></div>
            <button className="danger-action" onClick={clearLocalVault}><Trash2 size={16} />Clear local vault</button>
          </article>
          <article>
            <div><p className="eyebrow">Account deletion</p><h3>Full account deletion is coming with cloud sync.</h3><p>Once production sync is enabled, this control will delete cloud captures, files, profile data, and connected tokens from every device.</p></div>
            <button disabled><Lock size={16} />Requires cloud account</button>
          </article>
        </div>
        <div className="data-privacy-grid">
          <article>
            <Lock size={19} />
            <div><b>Privacy Guard</b><p>{pluginSettings.privacyGuard ? `${privacySignals.length} privacy signal${privacySignals.length === 1 ? "" : "s"} detected.` : "Privacy Guard is off. Turn it on from Plugins."}</p></div>
          </article>
          <article>
            <Archive size={19} />
            <div><b>This device</b><p>Nube keeps a local copy here so the app stays fast and resilient.</p></div>
          </article>
          <article>
            <Cloud size={19} />
            <div><b>Files</b><p>{systemHealth?.objectStorage === "cloudflare-r2" ? "Uploads are ready for cloud storage." : "Files are currently stored only on this device."}</p></div>
          </article>
          <article>
            <Code2 size={19} />
            <div><b>Account sync</b><p>{systemHealth?.cloudDatabaseStatus?.configured ? "Captures can sync across signed-in devices." : "Multi-device sync is not connected yet."}</p></div>
          </article>
          <article>
            <Upload size={19} />
            <div><b>Upload safety</b><p>{systemHealth?.limits?.maxUploadBytes ? `Uploads are limited to ${formatStorageUsage(systemHealth.limits.maxUploadBytes)} per file.` : "Nube checks uploads before saving them."}</p></div>
          </article>
        </div>
        <div className="release-readiness-card">
          <div className="settings-section-head">
            <div><p className="eyebrow">Release readiness</p><h2>{systemHealth?.releaseReadiness ? `${systemHealth.releaseReadiness.ready}/${systemHealth.releaseReadiness.total} checks ready` : "Checking launch status"}</h2></div>
            <button onClick={() => void fetch("/api/health").then((response) => response.json()).then(setSystemHealth)}><RefreshCw size={16} />Refresh</button>
          </div>
          <div className="release-readiness-list">
            {systemHealth?.releaseReadiness?.checks?.map((check) => <article className={check.ok ? "ready" : "missing"} key={check.id}>
              <span>{check.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}</span>
              <div><b>{check.label}</b><p>{check.detail}</p></div>
            </article>) ?? <p className="empty-state">Open this section with the API server running to see release checks.</p>}
          </div>
        </div>
      </section>}

      {settingsTab === "Connections" && <section className="settings-card integrations-section compact-settings-section">
        <div className="connection-feature-grid">
          <article className={`connection-feature-card calendar-connection-card ${calendarStatus?.connected ? "is-live" : ""}`}>
            <div>
              <span><CalendarCheck size={21} /></span>
              <button className={`plugin-power-switch ${calendarStatus?.connected ? "on" : "off"}`} disabled={!googleConfigured || calendarSyncing} onClick={() => calendarStatus?.connected ? void disconnectGoogleCalendar() : window.location.href = "/api/auth/google"} type="button">
                <i />
                <b>{calendarStatus?.connected ? "On" : "Off"}</b>
              </button>
            </div>
            <h3>Google Calendar</h3>
            <p>{calendarSyncing ? "Calendar is syncing. Duplicates are skipped automatically." : calendarStatus?.connected ? "Import upcoming events and turn them into dated captures." : "Sign in with Google to grant Calendar readonly access."}</p>
            <div className="connection-action-bar">
              {calendarStatus?.connected && <button className="link-action" disabled={!googleConfigured || calendarSyncing} onClick={() => void syncGoogleCalendar()}>
                <CalendarCheck size={16} />{calendarSyncing ? "Syncing..." : "Import events"}
              </button>}
              <button className="link-action secondary" onClick={() => calendarInput.current?.click()}><Upload size={16} />.ics</button>
              <span>{calendarSyncing ? "Working..." : calendarAutoSync ? "Auto-sync on" : calendarStatus?.connected ? "Manual sync" : "Not linked"}</span>
            </div>
            {calendarStatus?.connected && <div className="calendar-sync-mode compact">
              <label><span><b>Import range</b><small>Choose how far ahead Calendar should scan.</small></span><select value={calendarRange} onChange={(event) => updateCalendarRange(event.target.value)} disabled={calendarSyncing}><option value="30d">30 days</option><option value="6m">6 months</option><option value="1y">1 year</option></select></label>
              <label><span><b>Auto-sync</b><small>Checks every 30 minutes while Nube is open.</small></span><button className={`plugin-power-switch ${calendarAutoSync ? "on" : "off"}`} disabled={calendarSyncing} onClick={() => toggleCalendarAutoSync(!calendarAutoSync)} type="button"><i /><b>{calendarAutoSync ? "On" : "Off"}</b></button></label>
            </div>}
            <input ref={calendarInput} className="hidden-file" type="file" accept=".ics,text/calendar" onChange={(event) => { void importCalendarFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
          </article>
          <article className={`connection-feature-card gmail-connection-card ${gmailStatus?.connected && gmailStatus.enabled ? "is-live" : "is-disabled"}`}>
            <div>
              <span><Mail size={21} /></span>
              <button className={`plugin-power-switch ${gmailStatus?.connected && gmailStatus.enabled ? "on" : "off"}`} disabled={!googleConfigured || gmailSyncing} onClick={() => gmailStatus?.connected ? void toggleGmail(!gmailStatus.enabled) : window.location.href = "/api/auth/google"} type="button">
                <i />
                <b>{gmailStatus?.connected && gmailStatus.enabled ? "On" : "Off"}</b>
              </button>
            </div>
            <h3>Gmail</h3>
            <p>{gmailSyncing ? "Gmail is scanning a safe preview. Nothing enters Nube until you select it." : "Review useful receipts, bookings, files, and important messages before they enter Nube."}</p>
            {!gmailStatus?.connected && <small className="gmail-permission-note">{authUser ? "Google is connected, but Gmail readonly access still needs to be granted." : "Sign in with Google to grant Gmail readonly access."}</small>}
            {gmailStatus?.connected && !gmailStatus.enabled && <small className="gmail-permission-note">Gmail Import is paused. Turn it on to scan previews.</small>}
            <div className="connection-action-bar">
              <button className="link-action" disabled={!googleConfigured || gmailSyncing || !gmailStatus?.connected || !gmailStatus.enabled} onClick={() => setGmailFiltersOpen((current) => !current)} type="button"><Mail size={16} />Manage filters</button>
              <span>{gmailSyncing ? "Working..." : gmailPreviews.length ? `${gmailPreviews.length} emails previewed` : gmailStatus?.connected && gmailStatus.enabled ? "Ready to scan" : "Not active"}</span>
            </div>
            {gmailStatus?.connected && gmailStatus.enabled && gmailFiltersOpen && <>
              <div className="gmail-filter-grid">
                <label>Range<select value={gmailFilters.range} onChange={(event) => setGmailFilters((current) => ({ ...current, range: event.target.value }))}><option value="all">All time</option><option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></label>
                {[
                  ["receipts", "Receipts"],
                  ["bookings", "Bookings"],
                  ["attachments", "Attachments"],
                  ["unreadOnly", "Unread"],
                  ["importantOnly", "Important"],
                  ["specialOnly", "Special"],
                ].map(([key, label]) => <button key={key} className={gmailFilters[key as keyof typeof gmailFilters] ? "active" : ""} onClick={() => setGmailFilters((current) => ({ ...current, [key]: !current[key as keyof typeof current] }))} type="button">{label}</button>)}
              </div>
              <div className="connection-actions">
                <button disabled={!googleConfigured || gmailSyncing} onClick={() => void previewGmail()}><Mail size={16} />{gmailSyncing ? "Scanning..." : "Preview emails"}</button>
                <button disabled={!gmailPreviews.length || !selectedGmailIds.size || gmailSyncing} onClick={() => void importGmail()}><Sparkles size={16} />{gmailPreviews.length ? `Import ${selectedGmailIds.size || 0} selected` : "Import after preview"}</button>
                {gmailPreviews.length > 0 && <button onClick={() => { setGmailPreviews([]); setSelectedGmailIds(new Set()); setGmailPreviewed(false); setGmailShowAll(false); }} type="button"><X size={16} />Cancel preview</button>}
              </div>
              {!gmailPreviewed && <small className="gmail-flow-note">First scan a preview. Nube will only enable import when useful messages are found.</small>}
              {gmailPreviewed && !gmailPreviews.length && <small className="gmail-empty-note">No matching emails found. Try All time with Important or Special enabled.</small>}
            </>}
            {gmailStatus?.connected && gmailStatus.enabled && gmailPreviews.length > 0 && <div className="gmail-preview-list">
              <div className="gmail-preview-toolbar"><button onClick={() => setSelectedGmailIds(new Set(gmailPreviews.map((preview) => preview.id)))} type="button">Select all</button><button onClick={() => setSelectedGmailIds(new Set())} type="button">Select none</button>{gmailPreviews.length > 8 && <button onClick={() => setGmailShowAll((current) => !current)} type="button">{gmailShowAll ? "Show less" : `Show all ${gmailPreviews.length}`}</button>}<span>{selectedGmailIds.size} of {gmailPreviews.length} selected</span></div>
              {(gmailShowAll ? gmailPreviews : gmailPreviews.slice(0, 8)).map((preview) => <label key={preview.id}>
                <input type="checkbox" checked={selectedGmailIds.has(preview.id)} onChange={(event) => setSelectedGmailIds((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(preview.id);
                  else next.delete(preview.id);
                  return next;
                })} />
                <span><b>{preview.subject}</b><small>{preview.from}</small></span>
                {preview.attachments.length > 0 && <em>{preview.attachments.length} file{preview.attachments.length === 1 ? "" : "s"}</em>}
              </label>)}
            </div>}
          </article>
          <article className="connection-feature-card browser-connection-card is-live">
            <div>
              <span><Puzzle size={21} /></span>
              <b>Installed locally</b>
            </div>
            <h3>Browser Extension</h3>
            <p>Capture notes, pages, selections, screenshots, images, and files from the browser.</p>
            <div className="connection-action-bar">
              <button className="link-action" onClick={() => void copyText("C:\\Users\\manue\\Documents\\Codex\\2026-07-06\\technical-handover-nube-ai-native-personal\\outputs\\nube\\browser-extension", "Extension folder")}><Puzzle size={16} />Install folder</button>
              <span>Local extension</span>
            </div>
          </article>
          <article className={`connection-feature-card email-forwarding-card ${integrationStatus?.emailForwarding.enabled ? "is-live" : "is-disabled is-coming-soon"}`}>
            <div>
              <span><Mail size={21} /></span>
              <b>{integrationStatus?.emailForwarding.enabled ? "Ready" : "Needs domain"}</b>
            </div>
            <h3>Email Forwarding</h3>
            <p>{integrationStatus?.emailForwarding.enabled ? "Forward useful messages from any mailbox into your Nube inbox." : "Coming later, after the production email domain is connected."}</p>
            <div className="connection-action-bar">
              <button className="link-action" disabled={!integrationStatus?.emailForwarding.address} onClick={() => integrationStatus?.emailForwarding.address && void copyText(integrationStatus.emailForwarding.address, "Forwarding address")}><Mail size={16} />Address</button>
              <button className="link-action secondary" onClick={() => void copyText(`${window.location.origin}${integrationStatus?.emailForwarding.endpoint ?? "/api/integrations/email/inbound"}`, "Inbound endpoint")}><Link2 size={16} />Copy setup link</button>
              <span>{integrationStatus?.emailForwarding.signed ? "Secure inbound" : "Not active yet"}</span>
            </div>
          </article>
        </div>
        <details className="developer-connection-panel">
          <summary><span><Code2 size={17} />Developer API</span><small>Advanced</small></summary>
          <article className="connection-feature-card is-disabled">
            <div>
              <span><Code2 size={21} /></span>
              <b>Developer only</b>
            </div>
            <h3>Webhooks & API</h3>
            <p>Let external automations send captures into Nube from Zapier, Make, scripts, bots, or future integrations.</p>
            <code>{integrationStatus?.webhooks.endpoint ?? "/api/integrations/webhook/capture"}</code>
            <div className="connection-actions">
              <button onClick={() => void copyText(`${window.location.origin}${integrationStatus?.webhooks.endpoint ?? "/api/integrations/webhook/capture"}`, "Webhook endpoint")}><Link2 size={16} />Copy endpoint</button>
              <button onClick={() => void sendTestWebhook()} disabled={!integrationStatus?.token}><Sparkles size={16} />Send test</button>
            </div>
          </article>
          <div className="integration-token-card">
            <div>
              <p className="eyebrow">Private token</p>
              <h3>Use this for trusted automations.</h3>
              <p>External services must send <b>Authorization: Bearer token</b>. Keep it private.</p>
            </div>
            <code>{integrationStatus?.token ? `${integrationStatus.token.slice(0, 18)}...${integrationStatus.token.slice(-8)}` : "Loading token..."}</code>
            <div className="connection-actions">
              <button disabled={!integrationStatus?.token} onClick={() => integrationStatus?.token && void copyText(integrationStatus.token, "Token")}><Lock size={16} />Copy token</button>
              <button onClick={() => void rotateToken()}><RefreshCw size={16} />Regenerate</button>
            </div>
          </div>
        </details>
        {integrationMessage && <p className="auth-status">{integrationMessage}</p>}
      </section>}

      {settingsTab === "Plugins" && <section className="settings-card integrations-section compact-settings-section">
        <div className="core-capability-strip">
          {[
            ["Task Extractor", "Dates, actions, and priorities are detected by default."],
            ["Duplicate Finder", "Repeated Calendar, Gmail, and browser captures are skipped."],
            ["Document Reader", "PDFs, images, and text files are indexed during upload."],
            ["Place Enhancer", "Restaurants and places can receive maps, rating, and photos."],
          ].map(([title, text]) => <span key={title}><CheckCircle2 size={15} /><b>{title}</b><small>{text}</small></span>)}
        </div>
        <div className="connection-status-grid">
          <span><b>{enabledPluginCount}</b>Enabled</span>
          <span><b>{scheduledCount}</b>Scheduled</span>
          <span><b>{highPriorityCount}</b>High priority</span>
        </div>
        <div className="integration-grid plugin-grid">{plugins.map(({ id, icon: Icon, title, status, enabled, text }) => <article className={`integration-card ${enabled ? "is-enabled" : "is-disabled"} ${selectedPluginId === id ? "selected" : ""}`} key={title} onClick={() => setSelectedPluginId(id)}>
          <div className="integration-card-head">
            <span><Icon size={21} /></span>
            <button className={`plugin-power-switch ${enabled ? "on" : "off"}`} onClick={(event) => { event.stopPropagation(); setPluginEnabled(id, !enabled); }} title={enabled ? "Turn plugin off" : "Turn plugin on"} type="button">
              <i />
              <b>{status}</b>
            </button>
          </div>
          <h3>{title}</h3><p>{text}</p><button className="plugin-config-button" onClick={(event) => { event.stopPropagation(); setSelectedPluginId(id); }}>{enabled ? "Manage" : "Configure"}</button>
        </article>)}</div>
        <div className="plugin-detail-card">
          <div><p className="eyebrow">{selectedPlugin.enabled ? "Enabled plugin" : "Plugin preview"}</p><h3>{selectedPlugin.title}</h3><p>{selectedPlugin.detail}</p></div>
          {selectedPlugin.id === "smart-reminders" ? <>
            <div className="plugin-stats"><span><b>{scheduledCount}</b> scheduled</span><span><b>{highPriorityCount}</b> high priority</span></div>
            <div className="plugin-notification-row">
              <div><b>Browser notifications</b><span>{notificationPermission === "granted" ? "Enabled for due reminders." : notificationPermission === "denied" ? "Blocked by browser settings." : "Permission needed for pop-up reminders."}</span></div>
              <button disabled={!pluginSettings.smartReminders || notificationPermission === "granted"} onClick={() => void requestReminderNotifications()}>{notificationPermission === "granted" ? "Enabled" : "Enable"}</button>
            </div>
            <div className="plugin-toggle-list">
              <label><span>Due date reminders</span><span className="nube-switch"><input type="checkbox" checked={pluginSettings.dueDates} disabled={!pluginSettings.smartReminders} onChange={(event) => setPluginSettings((current) => ({ ...current, dueDates: event.target.checked }))} /><i /></span></label>
              <label><span>High priority surfacing</span><span className="nube-switch"><input type="checkbox" checked={pluginSettings.highPriority} disabled={!pluginSettings.smartReminders} onChange={(event) => setPluginSettings((current) => ({ ...current, highPriority: event.target.checked }))} /><i /></span></label>
              <label><span>Daily review prompts</span><span className="nube-switch"><input type="checkbox" checked={pluginSettings.dailyReview} disabled={!pluginSettings.smartReminders} onChange={(event) => setPluginSettings((current) => ({ ...current, dailyReview: event.target.checked }))} /><i /></span></label>
            </div>
          </> : selectedPlugin.id === "receipt-scanner" ? <>
            <div className="plugin-stats"><span><b>{receiptSignals.length}</b> money signals</span><span><b>{captures.filter((capture) => capture.imageUrl && capture.type === "Expense").length}</b> receipt images</span></div>
            <div className="plugin-toggle-list">
              <label><span>Money signal detection</span><span className="nube-switch"><input type="checkbox" checked={pluginSettings.receiptMoneySignals} disabled={!pluginSettings.receiptScanner} onChange={(event) => setPluginSettings((current) => ({ ...current, receiptMoneySignals: event.target.checked }))} /><i /></span></label>
              <label><span>Image receipt review</span><span className="nube-switch"><input type="checkbox" checked={pluginSettings.receiptImageReview} disabled={!pluginSettings.receiptScanner} onChange={(event) => setPluginSettings((current) => ({ ...current, receiptImageReview: event.target.checked }))} /><i /></span></label>
            </div>
          </> : <>
            <div className="plugin-stats"><span><b>{privacySignals.length}</b> flags</span><span><b>{captures.filter((capture) => capture.attachmentName).length}</b> files</span></div>
            <div className="plugin-toggle-list">
              <label><span>Sensitive text scan</span><span className="nube-switch"><input type="checkbox" checked={pluginSettings.privacySensitiveText} disabled={!pluginSettings.privacyGuard} onChange={(event) => setPluginSettings((current) => ({ ...current, privacySensitiveText: event.target.checked }))} /><i /></span></label>
              <label><span>File name warnings</span><span className="nube-switch"><input type="checkbox" checked={pluginSettings.privacyFileWarnings} disabled={!pluginSettings.privacyGuard} onChange={(event) => setPluginSettings((current) => ({ ...current, privacyFileWarnings: event.target.checked }))} /><i /></span></label>
            </div>
          </>}
        </div>
      </section>}

      {settingsTab === "Billing" && <section className="settings-card integrations-section compact-settings-section">
        <div className="billing-plan-card">
          <div>
            <p className="eyebrow">Current plan</p>
            <h3>Free</h3>
            <p>Good for trying Nube with local capture, Calendar import, the browser extension, and manual exports.</p>
          </div>
          <span>Active</span>
        </div>
        <div className="billing-usage-grid">
          <article><b>{captures.length}</b><span>captures</span></article>
          <article><b>{formatStorageUsage(storageUsedBytes)}</b><span>used storage</span></article>
          <article><b>{enabledPluginCount}</b><span>enabled plugins</span></article>
          <article><b>{fallbackPlanCatalog.free.storageGb} GB</b><span>free storage</span></article>
        </div>
        <div className="integration-grid billing-tiers">
          <article className="integration-card is-enabled">
            <div><span><Cloud size={21} /></span><b>Free</b></div>
            <h3>Free plan</h3>
            <p>100 captures/month, 1 GB storage, 5 MB uploads, limited AI, Calendar import, and browser extension.</p>
            <button className="plugin-config-button">Current plan</button>
          </article>
          <article className="integration-card">
            <div><span><Sparkles size={21} /></span><b>Next</b></div>
            <h3>Personal plan</h3>
            <p>Unlimited captures, 20 GB storage, OCR, voice notes, Gmail import, Ask Nube, and device sync when cloud storage is connected.</p>
            <button className="plugin-config-button" onClick={() => setView("Upgrade")}>Compare plans</button>
          </article>
        </div>
      </section>}

    </main>
  </div>;
}

function UpgradeView() {
  const [annual, setAnnual] = React.useState(false);
  const [openFaq, setOpenFaq] = React.useState("Can I cancel anytime?");
  const [billingStatus, setBillingStatus] = React.useState<BillingStatus | null>(null);
  const [billingMessage, setBillingMessage] = React.useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = React.useState<string | null>(null);
  const planCatalog = billingStatus?.plans ?? fallbackPlanCatalog;
  const price = (plan: PlanLimit) => annual ? plan.annualPrice : plan.monthlyPrice;
  const suffix = annual ? "/year" : "/month";
  const planFeatures = (plan: PlanLimit) => [
    plan.capturesPerMonth ? `${plan.capturesPerMonth} captures/month` : "Unlimited captures in this plan",
    `${plan.storageGb} GB storage`,
    `${plan.maxUploadMb} MB max file upload`,
    plan.aiClassificationsPerMonth ? `${plan.aiClassificationsPerMonth} AI classifications/month` : "Custom AI usage",
    plan.askNubePerMonth ? `${plan.askNubePerMonth} Ask Nube questions/month` : "Custom Ask Nube usage",
    `${plan.voiceMinutesPerMonth ?? "Custom"} voice minutes/month`,
    plan.ocr ? "OCR for images and documents" : "Basic file indexing",
    plan.cloudSync ? "Multi-device sync when cloud storage is connected" : "Local-first storage",
    plan.gmailImport ? "Gmail import" : "Calendar and browser captures",
    plan.developerApi ? "Developer API and automations" : plan.browserExtension ? "Browser extension" : "Manual capture",
  ];
  React.useEffect(() => {
    void fetch("/api/billing/status")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("billing unavailable")))
      .then((data: BillingStatus) => setBillingStatus(data))
      .catch(() => setBillingStatus(null));
  }, []);
  const startCheckout = async (plan: "personal" | "pro") => {
    setCheckoutLoading(plan);
    setBillingMessage("Preparing checkout...");
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, interval: annual ? "annual" : "monthly" }),
      });
      const result = await response.json().catch(() => null) as { checkoutUrl?: string | null; message?: string; error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Checkout is not available.");
      if (result?.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }
      setBillingMessage(result?.message || "Billing is not connected yet.");
    } catch (error) {
      setBillingMessage(error instanceof Error ? error.message : "Checkout failed.");
    } finally {
      setCheckoutLoading(null);
    }
  };
  const plans = [
    {
      id: "free",
      icon: Cloud,
      title: "Free",
      subtitle: "For light capture and testing.",
      price: "€0",
      suffix: "forever",
      features: planFeatures(planCatalog.free),
      action: "Current plan",
      current: billingStatus?.currentPlan === "free",
    },
    {
      id: "personal",
      icon: Sparkles,
      title: "Personal",
      subtitle: "The main plan for daily life.",
      price: `€${price(planCatalog.personal)}`,
      suffix,
      features: planFeatures(planCatalog.personal),
      action: billingStatus?.currentPlan === "personal" ? "Current plan" : checkoutLoading === "personal" ? "Preparing..." : "Go Premium",
      popular: true,
      checkoutPlan: "personal" as const,
      current: billingStatus?.currentPlan === "personal",
    },
    {
      id: "pro",
      icon: Briefcase,
      title: "Pro",
      subtitle: "For freelancers and power users.",
      price: `€${price(planCatalog.pro)}`,
      suffix,
      features: planFeatures(planCatalog.pro),
      action: billingStatus?.currentPlan === "pro" ? "Current plan" : checkoutLoading === "pro" ? "Preparing..." : "Start trial",
      checkoutPlan: "pro" as const,
      current: billingStatus?.currentPlan === "pro",
    },
  ];
  const faqs = [
    ["Can I cancel anytime?", "Yes. When billing is connected, cancellation will stop the next renewal and your existing captures will remain exportable."],
    ["What happens if I downgrade to Free?", "You keep your data. New uploads, AI usage, and sync features may pause if they exceed the Free limits."],
    ["Why not make everything free?", "AI classification, OCR, storage, email imports, and file hosting have real running costs. Free is for trying Nube; Personal is for daily use."],
    ["Will there be student pricing?", "Yes, it makes sense for Nube. A student discount can come after the billing flow is connected."],
  ];
  return (
    <section className="upgrade-page">
      <div className="upgrade-hero">
        <p className="upgrade-kicker"><Sparkles size={15} />More room for everything</p>
        <h2>Choose how much Nube can hold.</h2>
        <p>Upgrade for more captures, smarter search, larger uploads, voice notes, OCR, and connected workflows.</p>
        <p className="plan-reality-note">These limits are wired into Nube's billing model. Stripe activation and final production enforcement come next.</p>
        <label className="billing-toggle">
          <span className={!annual ? "active" : ""}>Monthly</span>
          <button className={annual ? "on" : ""} onClick={() => setAnnual((current) => !current)} type="button"><i /></button>
          <span className={annual ? "active" : ""}>Annual</span>
          <b>Annual deal</b>
        </label>
        {billingMessage && <p className="billing-message">{billingMessage}</p>}
      </div>
      <div className="pricing-grid">
        {plans.map(({ id, icon: Icon, title, subtitle, price: planPrice, suffix: planSuffix, features, action, current, popular, checkoutPlan }) => (
          <article className={`pricing-card ${popular ? "popular" : ""}`} key={id}>
            {popular && <em>Most popular</em>}
            <div className="pricing-icon"><Icon size={22} /></div>
            <h3>{title}</h3>
            <p>{subtitle}</p>
            <div className="plan-price"><b>{planPrice}</b><span>{planSuffix}</span></div>
            <ul>{features.map((feature) => <li key={feature}><CheckCircle2 size={16} />{feature}</li>)}</ul>
            <button disabled={current || Boolean(checkoutLoading)} onClick={() => checkoutPlan && void startCheckout(checkoutPlan)} className={current ? "current" : popular ? "primary" : "dark"}>{action}</button>
          </article>
        ))}
      </div>
      <div className="upgrade-note">
        <Sparkles size={18} />
        <p><b>{billingStatus?.configured ? "Checkout ready:" : "Checkout not connected:"}</b> {billingStatus?.configured ? "Stripe is configured and paid plans can open Checkout." : "Add Stripe price IDs and secret key to enable paid upgrades."}</p>
      </div>
      <div className="upgrade-faq">
        <h3>Frequently Asked Questions</h3>
        <div>{faqs.map(([question, answer]) => <button className={openFaq === question ? "open" : ""} key={question} onClick={() => setOpenFaq(openFaq === question ? "" : question)}><span>{question}{openFaq === question && <small>{answer}</small>}</span><ChevronDown size={18} /></button>)}</div>
      </div>
    </section>
  );
}

function HelpCenter() {
  const [query, setQuery] = React.useState("");
  const [activeTopic, setActiveTopic] = React.useState<string | null>(null);
  const [showAllFaqs, setShowAllFaqs] = React.useState(false);
  const [openFaq, setOpenFaq] = React.useState<string | null>("How does Nube categorize my captures?");
  const categories = [
    { icon: Sparkles, title: "Getting Started", text: "Learn how to capture notes, files, voice, and reminders without organizing first." },
    { icon: Brain, title: "AI Features", text: "Understand classification, insights, tags, and smart suggestions." },
    { icon: Cloud, title: "Privacy & Storage", text: "See how your data, uploads, and local vault are handled." },
  ];
  const faqs = [
    { topic: "AI Features", question: "How does Nube categorize my captures?", answer: "Nube looks at the content, source, file context, and wording of each capture. It then suggests a capture type, priority, editable tags, possible dates, people, places, and money signals. You can always override the result from the capture detail view." },
    { topic: "Getting Started", question: "What should I put into the inbox?", answer: "Anything you do not want to mentally organize right now: tasks, receipts, screenshots, restaurant names, links, PDFs, study notes, diary thoughts, reminders, and voice notes. The point is to capture first and decide later only when needed." },
    { topic: "Getting Started", question: "How do tags and collections work?", answer: "Tags are flexible labels attached to individual captures. Collections are broader library views, such as Tasks, Places, Expenses, Documents, Ideas, and Work. You can use tags for personal nuance and collections for fast navigation." },
    { topic: "Getting Started", question: "How do I create a reminder for today?", answer: "Write naturally, for example: \"Call Luca tomorrow morning\" or \"Pay gym contract Friday\". Nube detects date language when possible. You can also use the Today filter or edit the date inside the capture." },
    { topic: "AI Features", question: "Why does AI sometimes choose the wrong category?", answer: "Short captures can be ambiguous. A word like \"gatto\" could be an idea, note, pet reminder, image label, or something else. Nube makes a best guess, then lets you correct type, priority, tags, date, and money direction manually." },
    { topic: "AI Features", question: "What are AI Insights for?", answer: "Insights summarize the shape of your inbox: what is piling up, what needs attention, money signals, repeated themes, and useful next actions. They are meant to reduce scanning, not replace your judgment." },
    { topic: "Privacy & Storage", question: "Can I use Nube offline?", answer: "The current app keeps a browser-local copy, so existing captures can remain visible locally. AI classification, place enrichment, cloud file storage, and future account sync require the backend connection." },
    { topic: "Privacy & Storage", question: "What happens when I upload images or PDFs?", answer: "Nube keeps the file attached to the capture, stores file metadata such as name and size, and extracts readable text when possible. File size is treated as attachment metadata, not as a tag." },
    { topic: "Privacy & Storage", question: "How much storage do I have?", answer: "Free includes 1 GB. Personal includes 20 GB and Pro includes 100 GB. The usage card estimates stored text and known attachment sizes until production billing is connected." },
    { topic: "Privacy & Storage", question: "Can I delete or edit my data?", answer: "Yes. Captures can be edited, retagged, reprioritized, starred, completed, or deleted. The next production step is account-level data controls for export, deletion, and sync across devices." },
  ];
  const term = query.trim().toLowerCase();
  const visibleCategories = categories.filter((item) => !term || `${item.title} ${item.text}`.toLowerCase().includes(term));
  const filteredFaqs = faqs.filter((item) => (!activeTopic || item.topic === activeTopic) && (!term || `${item.topic} ${item.question} ${item.answer}`.toLowerCase().includes(term)));
  const visibleFaqs = showAllFaqs || term || activeTopic ? filteredFaqs : filteredFaqs.slice(0, 5);
  return (
    <section className="help-center">
      <div className="help-hero">
        <h2>How can we help?</h2>
        <label className="help-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search for features, tutorials, or FAQs..." /></label>
      </div>
      <div className="help-categories">{visibleCategories.map(({ icon: Icon, title, text }) => <button className={activeTopic === title ? "active" : ""} key={title} onClick={() => { setActiveTopic(activeTopic === title ? null : title); setShowAllFaqs(false); }}><span><Icon size={22} /></span><b>{title}</b><p>{text}</p></button>)}</div>
      <div className="help-section-title"><div><h3>{activeTopic ?? "Top FAQ"}</h3><p>{activeTopic ? `Questions about ${activeTopic.toLowerCase()}.` : "Quick answers to the most important questions."}</p></div><button onClick={() => setShowAllFaqs((current) => !current)}>{showAllFaqs ? "Show top questions" : "View all questions"}</button></div>
      <div className="faq-list">{visibleFaqs.map((item) => <button className={openFaq === item.question ? "open" : ""} key={item.question} onClick={() => setOpenFaq(openFaq === item.question ? null : item.question)}><span>{item.question}{openFaq === item.question && <small>{item.answer}</small>}</span><ChevronDown size={18} /></button>)}</div>
    </section>
  );
}

function ContextRail({ captures }: { captures: Capture[] }) {
  const { profile, setView, setDateFilter, dateFilter, setSelectedCapture, pluginSettings } = useBrain();
  const [now, setNow] = React.useState(new Date());
  const [visibleMonth, setVisibleMonth] = React.useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDay, setSelectedDay] = React.useState(() => dateFilter?.day ?? dateKey(new Date()));
  const [upcomingExpanded, setUpcomingExpanded] = React.useState(false);
  const [weather, setWeather] = React.useState<WeatherSnapshot>(() => fallbackWeatherFor(profile));
  const weatherCity = profile.locationLabel || profile.city || "Current location";
  const weatherLatitude = profile.latitude;
  const weatherLongitude = profile.longitude;
  React.useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  React.useEffect(() => setUpcomingExpanded(false), [selectedDay]);
  React.useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (Number.isFinite(weatherLatitude) && Number.isFinite(weatherLongitude)) {
      params.set("lat", String(weatherLatitude));
      params.set("lng", String(weatherLongitude));
    }
    setWeather((current) => ({ ...current, city: weatherCity || current.city, condition: "Updating" }));
    void fetch(`/api/weather?${params.toString()}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("weather unavailable")))
      .then((data: { temperature: number | null; temperatureUnit?: string; condition?: string }) => {
        if (cancelled) return;
        setWeather({
          city: weatherCity,
          temperature: data.temperature === null ? "--°C" : `${data.temperature}${data.temperatureUnit || "°C"}`,
          condition: data.condition || "Weather",
          icon: Sun,
        });
      })
      .catch(() => {
        if (!cancelled) setWeather({ city: weatherCity, temperature: "--°C", condition: "Updating", icon: Sun });
      });
    return () => {
      cancelled = true;
    };
  }, [weatherLatitude, weatherLongitude, weatherCity]);
  const today = dateKey(new Date());
  const selectedCaptures = captures.filter((capture) => captureMatchesDate(capture, selectedDay));
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const WeatherIcon = weather.icon;
  const cells = [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => new Date(year, month, index + 1)),
  ];
  while (cells.length % 7) cells.push(null);
  const remindersEnabled = pluginSettings.smartReminders && pluginSettings.dueDates;
  const countsByDay = remindersEnabled ? captures.reduce<Record<string, number>>((acc, capture) => {
    if (!capture.due) return acc;
    const key = dateKey(parseDueDate(capture.due));
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}) : {};
  const dayUpcoming = remindersEnabled ? rankCaptures(selectedCaptures.filter((capture) => !capture.completed)) : [];
  const visibleUpcoming = upcomingExpanded ? dayUpcoming : dayUpcoming.slice(0, 3);
  const selectedDayLabel = new Date(`${selectedDay}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <aside className="context-rail">
      <div className="now-weather-card">
        <div className="time-tile"><p className="eyebrow">Now</p><strong>{now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</strong><span>{now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</span></div>
        <div className="weather-tile"><p className="eyebrow">Weather</p><strong><WeatherIcon size={22} />{weather.temperature}</strong><span>{weather.city}: {weather.condition.toLowerCase()}</span></div>
      </div>
      <aside className="calendar-panel">
        <div className="calendar-head">
          <div><p className="eyebrow">Calendar</p><h3>{visibleMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</h3></div>
          <div>
            <button onClick={() => setVisibleMonth(new Date(year, month - 1, 1))} title="Previous month"><ArrowUp size={16} /></button>
            <button onClick={() => setVisibleMonth(new Date(year, month + 1, 1))} title="Next month"><ArrowUp size={16} /></button>
          </div>
        </div>
        <div className="calendar-grid weekdays">{["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
        <div className="calendar-grid">
          {cells.map((day, index) => {
            const key = day ? dateKey(day) : `empty-${index}`;
            const isToday = day ? key === today : false;
            const isSelected = day ? key === selectedDay : false;
            const isPast = day ? key < today : false;
            const count = day ? countsByDay[key] ?? 0 : 0;
            return day ? <button className={`${isPast ? "past" : ""} ${isToday ? "today" : ""} ${isSelected ? "active" : ""} ${count > 0 ? "has-items" : ""}`} key={key} onClick={() => { setSelectedDay(key); setDateFilter({ day: key, label: day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) }); setView("Inbox"); }}>{day.getDate()}{count > 0 && <i aria-label={`${count} scheduled`} />}</button> : <span key={key} />;
          })}
        </div>
      </aside>
      {pluginSettings.smartReminders && <aside className="calendar-panel next-up-panel">
        <div className="calendar-head">
          <div><p className="eyebrow">Upcoming</p><h3>{selectedDay === today ? "Today" : selectedDayLabel}</h3></div>
          <Bell size={18} />
        </div>
        <div className="calendar-list">
          {!pluginSettings.dueDates ? <p className="muted-line">Due date reminders are off.</p> : visibleUpcoming.length ? visibleUpcoming.map((capture) => <button key={capture.id} onClick={() => setSelectedCapture(capture)}><span style={{ "--priority-color": capture.starred ? "#d97706" : priorityColor(capture.priority) } as React.CSSProperties} /><p>{capture.title}<small>{formatDue(capture.due)}</small></p></button>) : <p className="muted-line">Nothing scheduled for this day.</p>}
          {dayUpcoming.length > 3 && <button className="calendar-expand-button" onClick={() => setUpcomingExpanded((current) => !current)}>{upcomingExpanded ? "Show less" : `Show ${dayUpcoming.length - 3} more`}<ChevronDown size={14} /></button>}
        </div>
      </aside>}
    </aside>
  );
}

export default App;



