import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (!key || process.env[key]) continue;
    process.env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
  }
}

const productionMode = process.argv.includes("--production") || process.env.NUBE_PREFLIGHT_STRICT === "true" || process.env.NODE_ENV === "production";
const baseUrl = process.env.NUBE_PREFLIGHT_URL || "http://127.0.0.1:8787";

const requiredEnv = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

const optionalLaunchEnv = [
  "NUBE_CLOUD_DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "NUBE_INBOUND_EMAIL_SECRET",
  "NUBE_PUBLIC_DOMAIN",
];

const productionRequiredEnv = [
  "APP_URL",
  "NUBE_ALLOWED_ORIGINS",
  "NUBE_SECURE_COOKIES",
  "NUBE_CLOUD_DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "NUBE_INBOUND_EMAIL_SECRET",
  "NUBE_PUBLIC_DOMAIN",
  "GOOGLE_MAPS_API_KEY",
];

const aiKeyConfigured = Boolean(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY);
const appUrl = process.env.APP_URL || "";
const allowedOrigins = process.env.NUBE_ALLOWED_ORIGINS || "";
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || (appUrl ? `${appUrl.replace(/\/$/, "")}/api/auth/google/callback` : "");

const missingRequired = requiredEnv.filter((key) => !process.env[key]);
const missingOptional = optionalLaunchEnv.filter((key) => !process.env[key]);

if (missingRequired.length) {
  console.error(`Missing required environment variables: ${missingRequired.join(", ")}`);
  process.exitCode = 1;
}

if (missingOptional.length) {
  console.warn(`Optional production environment variables not set: ${missingOptional.join(", ")}`);
}

if (productionMode) {
  const productionMissing = productionRequiredEnv.filter((key) => !process.env[key]);
  const productionProblems = [];
  if (productionMissing.length) productionProblems.push(`Missing production variables: ${productionMissing.join(", ")}`);
  if (!aiKeyConfigured) productionProblems.push("Missing AI provider key: set GEMINI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY.");
  if (!/^https:\/\//i.test(appUrl)) productionProblems.push("APP_URL must be HTTPS in production.");
  if (process.env.NUBE_SECURE_COOKIES !== "true") productionProblems.push("NUBE_SECURE_COOKIES must be true in production.");
  if (/localhost|127\.0\.0\.1/i.test(allowedOrigins)) productionProblems.push("NUBE_ALLOWED_ORIGINS should not include localhost/127.0.0.1 in production.");
  if (googleRedirectUri && appUrl && !googleRedirectUri.startsWith(appUrl.replace(/\/$/, ""))) productionProblems.push("GOOGLE_REDIRECT_URI must use the same production domain as APP_URL.");
  if (!process.env.NUBE_PUBLIC_DOMAIN?.includes(".")) productionProblems.push("NUBE_PUBLIC_DOMAIN should be a real domain, for example nube.app.");
  if (productionProblems.length) {
    console.error(["Production preflight failed:", ...productionProblems.map((problem) => `- ${problem}`)].join("\n"));
    process.exitCode = 1;
  }
}

async function checkEndpoint(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

try {
  const health = await checkEndpoint("/api/health");
  const integrations = await checkEndpoint("/api/integrations/status");
  console.log(`Health OK: storage=${health.objectStorage ?? "unknown"} database=${health.cloudDatabase ?? "unknown"}`);
  console.log(`Integrations OK: emailForwarding=${integrations.emailForwarding?.enabled ? "ready" : "off"} webhooks=${integrations.webhooks?.enabled ? "ready" : "off"}`);
  if (health.releaseReadiness) {
    console.log(`Release readiness: ${health.releaseReadiness.ready}/${health.releaseReadiness.total}`);
    if (productionMode && !health.releaseReadiness.productionReady) {
      console.error("Production preflight failed: /api/health reports incomplete release readiness.");
      for (const check of health.releaseReadiness.checks.filter((item) => !item.ok)) console.error(`- ${check.label}: ${check.detail}`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.warn(`Server health check skipped or failed at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  console.warn("Start the API server with npm run dev:api or npm start, then rerun npm run preflight for endpoint checks.");
}

if (process.exitCode) process.exit(process.exitCode);
