import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";
import pg from "pg";

const app = express();
const port = process.env.PORT || 3000;
const { Pool } = pg;
const databaseURL = String(process.env.DATABASE_URL || "").trim();
const feedbackSequenceStart = Math.max(1, Number(process.env.FEEDBACK_SEQUENCE_START || 1) || 1);
const db = databaseURL
  ? new Pool({
      connectionString: databaseURL,
      ssl: String(process.env.DATABASE_SSL || "true").toLowerCase() === "false"
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, "../GuestWeb");
const storePath = path.resolve(__dirname, "requests.json");
const eventStatePath = path.resolve(__dirname, "events.json");
const feedbackStatePath = String(process.env.FEEDBACK_STATE_PATH || path.resolve(__dirname, "feedback-state.json"));
const newsletterStatePath = String(process.env.NEWSLETTER_STATE_PATH || path.resolve(__dirname, "newsletter-subscribers.json"));
const requestRateBuckets = new Map();
const feedbackRateBuckets = new Map();
const newsletterRateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 12;
const FEEDBACK_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FEEDBACK_PER_WINDOW = 5;
const NEWSLETTER_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_NEWSLETTER_SIGNUPS_PER_WINDOW = 5;

const catalogSearchCache = new Map();
const catalogGenreCache = new Map();
const djMetadataCache = new Map();
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const DJ_METADATA_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(webDir));


function ensureParentDir(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {}
}

function readJSONFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSONFile(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function initDatabase() {
  if (!db) {
    console.warn("DATABASE_URL not set: newsletter + feedback numbering use local JSON fallback.");
    return;
  }

  const sequenceStart = Number.isFinite(feedbackSequenceStart) ? feedbackSequenceStart : 1;

  await db.query(`
    CREATE SEQUENCE IF NOT EXISTS feedback_reference_seq
    START WITH ${sequenceStart}
    INCREMENT BY 1
    MINVALUE 1
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      interests JSONB NOT NULL DEFAULT '["release","beta","updates"]'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      confirm_token_hash TEXT,
      unsubscribe_token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      unsubscribed_at TIMESTAMPTZ,
      consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL DEFAULT 'dj-toolkit.com'
    )
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_newsletter_status ON newsletter_subscribers(status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_newsletter_confirm_hash ON newsletter_subscribers(confirm_token_hash)`);

  console.log("DJ Toolkit Postgres persistence ready.");
}

async function nextFeedbackReference() {
  if (db) {
    const result = await db.query(`SELECT nextval('feedback_reference_seq') AS number`);
    const current = Number(result.rows?.[0]?.number || 1);
    return `DJT-FB-${String(current).padStart(6, "0")}`;
  }

  const state = readJSONFile(feedbackStatePath, { next: 1 });
  const current = Math.max(1, Number(state?.next) || 1);
  writeJSONFile(feedbackStatePath, { next: current + 1, updatedAt: new Date().toISOString() });
  return `DJT-FB-${String(current).padStart(6, "0")}`;
}

function publicBaseURL() {
  return String(process.env.PUBLIC_BASE_URL || "https://dj-toolkit.com").trim().replace(/\/+$/, "");
}

function newsletterRateAllowed(req) {
  const address = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
    || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const current = (newsletterRateBuckets.get(address) || [])
    .filter(ts => now - ts < NEWSLETTER_RATE_WINDOW_MS);

  if (current.length >= MAX_NEWSLETTER_SIGNUPS_PER_WINDOW) {
    newsletterRateBuckets.set(address, current);
    return false;
  }

  current.push(now);
  newsletterRateBuckets.set(address, current);
  return true;
}

function rowToNewsletterSubscriber(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    interests: newsletterInterests(row.interests),
    status: row.status,
    confirmTokenHash: row.confirm_token_hash,
    unsubscribeToken: row.unsubscribe_token,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
    unsubscribedAt: row.unsubscribed_at ? new Date(row.unsubscribed_at).toISOString() : null,
    consentAt: row.consent_at ? new Date(row.consent_at).toISOString() : null,
    source: row.source || "dj-toolkit.com"
  };
}

function newsletterStore() {
  const value = readJSONFile(newsletterStatePath, { subscribers: [] });
  return {
    subscribers: Array.isArray(value?.subscribers) ? value.subscribers : []
  };
}

function saveNewsletterStore(value) {
  writeJSONFile(newsletterStatePath, {
    subscribers: Array.isArray(value?.subscribers) ? value.subscribers : [],
    updatedAt: new Date().toISOString()
  });
}

async function findNewsletterSubscriberByEmail(email) {
  if (!db) {
    return newsletterStore().subscribers.find(
      item => String(item?.email || "").toLowerCase() === String(email || "").toLowerCase()
    ) || null;
  }

  const result = await db.query(
    `SELECT * FROM newsletter_subscribers WHERE LOWER(email)=LOWER($1) LIMIT 1`,
    [email]
  );
  return rowToNewsletterSubscriber(result.rows?.[0]);
}

async function upsertNewsletterSubscriber(subscriber) {
  if (!db) {
    const store = newsletterStore();
    const existing = store.subscribers.find(
      item => String(item?.email || "").toLowerCase() === String(subscriber.email || "").toLowerCase()
    );
    if (existing) Object.assign(existing, subscriber);
    else store.subscribers.push(subscriber);
    saveNewsletterStore(store);
    return subscriber;
  }

  const result = await db.query(`
    INSERT INTO newsletter_subscribers (
      id,email,name,interests,status,confirm_token_hash,unsubscribe_token,
      created_at,updated_at,confirmed_at,unsubscribed_at,consent_at,source
    )
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (email) DO UPDATE SET
      name=EXCLUDED.name,
      interests=EXCLUDED.interests,
      status=EXCLUDED.status,
      confirm_token_hash=EXCLUDED.confirm_token_hash,
      unsubscribe_token=EXCLUDED.unsubscribe_token,
      updated_at=EXCLUDED.updated_at,
      confirmed_at=EXCLUDED.confirmed_at,
      unsubscribed_at=EXCLUDED.unsubscribed_at,
      consent_at=EXCLUDED.consent_at,
      source=EXCLUDED.source
    RETURNING *
  `, [
    subscriber.id,
    subscriber.email,
    subscriber.name,
    JSON.stringify(newsletterInterests(subscriber.interests)),
    subscriber.status,
    subscriber.confirmTokenHash,
    subscriber.unsubscribeToken,
    subscriber.createdAt,
    subscriber.updatedAt,
    subscriber.confirmedAt,
    subscriber.unsubscribedAt,
    subscriber.consentAt,
    subscriber.source || "dj-toolkit.com"
  ]);

  return rowToNewsletterSubscriber(result.rows?.[0]);
}

async function findNewsletterSubscriberByConfirmHash(hash) {
  if (!db) {
    return newsletterStore().subscribers.find(
      item => item?.status === "pending" && item?.confirmTokenHash === hash
    ) || null;
  }
  const result = await db.query(
    `SELECT * FROM newsletter_subscribers WHERE status='pending' AND confirm_token_hash=$1 LIMIT 1`,
    [hash]
  );
  return rowToNewsletterSubscriber(result.rows?.[0]);
}

async function confirmNewsletterSubscriber(id) {
  if (!db) {
    const store = newsletterStore();
    const subscriber = store.subscribers.find(item => item?.id === id);
    if (!subscriber) return null;
    const now = new Date().toISOString();
    subscriber.status = "confirmed";
    subscriber.confirmTokenHash = null;
    subscriber.confirmedAt = now;
    subscriber.updatedAt = now;
    saveNewsletterStore(store);
    return subscriber;
  }

  const result = await db.query(`
    UPDATE newsletter_subscribers
    SET status='confirmed',
        confirm_token_hash=NULL,
        confirmed_at=NOW(),
        updated_at=NOW(),
        unsubscribed_at=NULL
    WHERE id=$1
    RETURNING *
  `, [id]);

  return rowToNewsletterSubscriber(result.rows?.[0]);
}

async function findNewsletterSubscriberByUnsubscribeToken(token) {
  if (!db) {
    return newsletterStore().subscribers.find(item => item?.unsubscribeToken === token) || null;
  }
  const result = await db.query(
    `SELECT * FROM newsletter_subscribers WHERE unsubscribe_token=$1 LIMIT 1`,
    [token]
  );
  return rowToNewsletterSubscriber(result.rows?.[0]);
}

async function unsubscribeNewsletterSubscriber(id) {
  if (!db) {
    const store = newsletterStore();
    const subscriber = store.subscribers.find(item => item?.id === id);
    if (!subscriber) return null;
    const now = new Date().toISOString();
    subscriber.status = "unsubscribed";
    subscriber.unsubscribedAt = now;
    subscriber.updatedAt = now;
    saveNewsletterStore(store);
    return subscriber;
  }

  const result = await db.query(`
    UPDATE newsletter_subscribers
    SET status='unsubscribed',
        unsubscribed_at=NOW(),
        updated_at=NOW()
    WHERE id=$1
    RETURNING *
  `, [id]);

  return rowToNewsletterSubscriber(result.rows?.[0]);
}

async function confirmedNewsletterSubscribers() {
  if (!db) {
    return newsletterStore().subscribers.filter(item => item?.status === "confirmed");
  }
  const result = await db.query(
    `SELECT * FROM newsletter_subscribers WHERE status='confirmed' ORDER BY confirmed_at ASC NULLS LAST`
  );
  return result.rows.map(rowToNewsletterSubscriber);
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function newsletterInterests(value) {
  const allowed = new Set(["release", "beta", "updates"]);
  const input = Array.isArray(value) ? value : [];
  const result = [...new Set(input.map(item => String(item || "").trim()).filter(item => allowed.has(item)))];
  return result.length ? result : ["release", "beta", "updates"];
}

function newsletterInterestLabel(value) {
  const labels = {
    release: "App Release",
    beta: "Beta & Testphase",
    updates: "Wichtige Updates"
  };
  return newsletterInterests(value).map(item => labels[item]).join(" · ");
}

function renderSimplePage({ eyebrow, title, text, actionLabel = "Zur Startseite", actionURL = "/" }) {
  const safeEyebrow = escapeHTML(eyebrow);
  const safeTitle = escapeHTML(title);
  const safeText = escapeHTML(text);
  const safeAction = escapeHTML(actionLabel);
  const safeURL = escapeHTML(actionURL);

  return `<!doctype html>
  <html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="theme-color" content="#05070d">
    <title>${safeTitle} · DJ Toolkit</title>
  </head>
  <body style="margin:0;background:#05070d;color:#f7f9ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="min-height:100vh;display:grid;place-items:center;padding:24px;background:
      radial-gradient(circle at 15% 5%,rgba(33,215,255,.13),transparent 28rem),
      radial-gradient(circle at 90% 10%,rgba(221,77,255,.12),transparent 30rem);">
      <div style="width:min(620px,100%);background:#0b111d;border:1px solid #243049;border-radius:26px;padding:34px;box-sizing:border-box;">
        <div style="font-size:10px;letter-spacing:.16em;color:#69dfff;font-weight:900">${safeEyebrow}</div>
        <h1 style="font-size:34px;line-height:1.1;margin:10px 0 14px">${safeTitle}</h1>
        <p style="font-size:15px;line-height:1.7;color:#aebbd0;margin:0 0 24px">${safeText}</p>
        <a href="${safeURL}" style="display:inline-block;padding:13px 18px;border-radius:13px;background:linear-gradient(105deg,#168fff,#785bff 68%,#b952ff);color:#fff;text-decoration:none;font-weight:900;font-size:13px">${safeAction} →</a>
      </div>
    </div>
  </body>
  </html>`;
}

function readStore() {
  try {
    if (!fs.existsSync(storePath)) return [];
    return JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return [];
  }
}

function writeStore(rows) {
  fs.writeFileSync(storePath, JSON.stringify(rows, null, 2));
}

function readEventState() {
  try {
    if (!fs.existsSync(eventStatePath)) return {};
    const value = JSON.parse(fs.readFileSync(eventStatePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeEventState(value) {
  fs.writeFileSync(eventStatePath, JSON.stringify(value, null, 2));
}

function defaultEventState(eventID) {
  return {
    eventID,
    eventName: null,
    mustPlay: [],
    doNotPlay: [],
    preferredGenres: [],
    musicDirection: "openFormat",
    timeline: [],
    genreVotes: {},
    genreVoterHashes: {},
    clientPortalTokenHash: null,
    handover: null,
    playedTracks: [],
    remoteSnapshot: null,
    announcements: [],
    branding: { displayName: "DJ TOOLKIT", accentHex: "22D3EE", footerText: "Powered by DJ Toolkit", customDomain: "" },
    team: [],
    updatedAt: new Date().toISOString()
  };
}

function getEventState(eventID) {
  const all = readEventState();
  return all[eventID] || defaultEventState(eventID);
}

function saveEventState(eventID, next) {
  const all = readEventState();
  all[eventID] = { ...defaultEventState(eventID), ...next, eventID, updatedAt: new Date().toISOString() };
  writeEventState(all);
  return all[eventID];
}

function arrayOfStrings(value, maxItems = 80, maxLength = 180) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map(item => String(item || "").trim().slice(0, maxLength))
    .filter(Boolean);
}


const OPEN_FORMAT_GENRES = ["House", "Tech House", "EDM", "Techno", "90s", "2000s", "Pop", "Hip-Hop"];
const EVENT_MUSIC_DIRECTIONS = new Set(["openFormat", "house", "techHouse", "techno"]);

function cleanMusicDirection(value) {
  const raw = String(value || "").trim();
  return EVENT_MUSIC_DIRECTIONS.has(raw) ? raw : "openFormat";
}

function musicDirectionLabel(value) {
  switch (cleanMusicDirection(value)) {
    case "house": return "House";
    case "techHouse": return "Tech House";
    case "techno": return "Techno";
    default: return "Open Format";
  }
}

function allowedGenreOptionsForState(state) {
  const direction = cleanMusicDirection(state?.musicDirection);
  if (direction === "house") return ["House"];
  if (direction === "techHouse") return ["Tech House"];
  if (direction === "techno") return ["Techno"];

  const preferred = arrayOfStrings(state?.preferredGenres, 20, 80);
  return [...new Set([...preferred, ...OPEN_FORMAT_GENRES])].slice(0, 20);
}

function normalizeGenreLabel(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function classifyGenreForDirection(directionValue, catalogGenreValue) {
  const direction = cleanMusicDirection(directionValue);
  if (direction === "openFormat") return "matching";

  const genre = normalizeGenreLabel(catalogGenreValue);
  if (!genre) return "unknown";

  const isTechHouse = genre.includes("tech house") || genre.includes("techhouse");
  const isTechno = genre.includes("techno");
  const isHouse = genre.includes("house") && !isTechHouse;

  if (direction === "house") {
    if (isHouse) return "matching";
    if (isTechHouse || isTechno) return "outside";
  }
  if (direction === "techHouse") {
    if (isTechHouse) return "matching";
    if (isHouse || isTechno) return "outside";
  }
  if (direction === "techno") {
    if (isTechno) return "matching";
    if (isHouse || isTechHouse) return "outside";
  }

  // If the catalog clearly identifies another mainstream style, mark it as
  // outside the configured event format. Unknown/very broad metadata remains
  // allowed because catalog genre tags are not reliable enough for hard blocks.
  const clearlyOther = [
    "pop", "hip hop", "hiphop", "rap", "rock", "metal", "country", "r b",
    "rnb", "schlager", "jazz", "reggae", "latin", "classical", "folk",
    "indie", "alternative", "disco", "funk", "soul", "drum and bass",
    "drum bass", "dnb", "hardstyle", "trance"
  ].some(token => genre.includes(token));

  return clearlyOther ? "outside" : "unknown";
}

function requestFormatMeta(state, catalogGenre) {
  const musicDirection = cleanMusicDirection(state?.musicDirection);
  const formatCompatibility = classifyGenreForDirection(musicDirection, catalogGenre);
  const formatLabel = musicDirectionLabel(musicDirection);
  const formatWarning = formatCompatibility === "outside"
    ? `Dieser Track liegt außerhalb des Eventformats ${formatLabel}. Der DJ entscheidet.`
    : null;

  return { musicDirection, formatCompatibility, formatLabel, formatWarning };
}

function cleanTimeline(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).map(item => ({
    id: String(item?.id || crypto.randomUUID()).slice(0, 80),
    title: String(item?.title || "").trim().slice(0, 140),
    time: String(item?.time || "").slice(0, 64),
    note: String(item?.note || "").trim().slice(0, 300) || null,
    isDone: Boolean(item?.isDone)
  })).filter(item => item.title && item.time);
}

function requestRateAllowed(req, eventID) {
  const address = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
    || req.socket?.remoteAddress || "unknown";
  const key = `${eventID}:${address}`;
  const now = Date.now();
  const current = (requestRateBuckets.get(key) || []).filter(ts => now - ts < RATE_WINDOW_MS);
  if (current.length >= MAX_REQUESTS_PER_MINUTE) {
    requestRateBuckets.set(key, current);
    return false;
  }
  current.push(now);
  requestRateBuckets.set(key, current);
  return true;
}


function feedbackRateAllowed(req) {
  const address = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
    || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const current = (feedbackRateBuckets.get(address) || [])
    .filter(ts => now - ts < FEEDBACK_RATE_WINDOW_MS);

  if (current.length >= MAX_FEEDBACK_PER_WINDOW) {
    feedbackRateBuckets.set(address, current);
    return false;
  }

  current.push(now);
  feedbackRateBuckets.set(address, current);
  return true;
}

function validEmail(value) {
  const email = String(value || "").trim();
  return email.length >= 5
    && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanPhone(value) {
  const raw = String(value || "").trim().slice(0, 40);
  if (!raw) return null;
  return /^[+()\d\s./-]{5,40}$/.test(raw) ? raw : null;
}

function escapeHTML(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function feedbackAPIKey() {
  // Backward compatible: if you already stored your Resend key as SMTP_PASS
  // in Render, V10.4 will use it automatically. RESEND_API_KEY is preferred.
  return String(process.env.RESEND_API_KEY || process.env.SMTP_PASS || "").trim();
}

async function sendFeedbackEmail(payload) {
  const apiKey = feedbackAPIKey();
  if (!apiKey) {
    const error = new Error("Resend API key is not configured.");
    error.code = "RESEND_NOT_CONFIGURED";
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body?.message || body?.error || `Resend API status ${response.status}`;
      const error = new Error(String(message));
      error.status = response.status;
      error.details = body;
      throw error;
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupCatalogGenre(artist, title, country = "DE") {
  const cacheKey = `${country}:${normalizeLookupText(artist)}::${normalizeLookupText(title)}`;
  const cached = catalogGenreCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CATALOG_CACHE_TTL_MS) {
    return cached.genre || null;
  }

  try {
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", `${artist} ${title}`);
    url.searchParams.set("country", country);
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("limit", "8");
    url.searchParams.set("explicit", "Yes");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3200);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" }
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) throw new Error(`catalog genre status ${response.status}`);
    const body = await response.json();

    let best = null;
    for (const item of Array.isArray(body.results) ? body.results : []) {
      if (!item?.trackName || !item?.artistName || !item?.primaryGenreName) continue;
      const score = djMatchScore(title, artist, item.trackName, item.artistName);
      if (score >= 0.68 && (!best || score > best.score)) {
        best = {
          score,
          genre: String(item.primaryGenreName).trim().slice(0, 100)
        };
      }
    }

    const genre = best?.genre || null;
    catalogGenreCache.set(cacheKey, { createdAt: Date.now(), genre });
    return genre;
  } catch (error) {
    console.warn("catalog genre lookup unavailable", error?.message || error);
    catalogGenreCache.set(cacheKey, { createdAt: Date.now(), genre: null });
    return null;
  }
}

function looksLikeSpam(...values) {
  const text = values.map(value => String(value || "")).join(" ").trim();
  if (!text) return false;
  const urls = (text.match(/https?:\/\//gi) || []).length;
  const repeated = /(.)\1{14,}/i.test(text);
  const excessiveCaps = text.length > 35 && (text.match(/[A-ZÄÖÜ]/g) || []).length / text.length > 0.72;
  return urls > 1 || repeated || excessiveCaps;
}

function cleanPortalState(state) {
  return {
    eventID: state.eventID,
    eventName: state.eventName || null,
    mustPlay: arrayOfStrings(state.mustPlay),
    doNotPlay: arrayOfStrings(state.doNotPlay),
    preferredGenres: arrayOfStrings(state.preferredGenres, 30, 80),
    timeline: cleanTimeline(state.timeline),
    updatedAt: state.updatedAt
  };
}

function portalTokenMatches(state, rawToken) {
  const token = String(rawToken || "").trim();
  if (!token || !state.clientPortalTokenHash) return false;
  return crypto.timingSafeEqual(
    Buffer.from(hashVoterToken(token)),
    Buffer.from(state.clientPortalTokenHash)
  );
}

function normalizeRequestKey(artist, title) {
  return `${normalizeLookupText(artist)}::${normalizeLookupText(title)}`;
}

function sanitizeRowForClient(row) {
  const { voterHashes, supporters, ...safe } = row;
  return safe;
}

function hashVoterToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalWaveform(value) {
  if (!Array.isArray(value)) return null;
  return value
    .slice(0, 256)
    .map(Number)
    .filter(Number.isFinite)
    .map(value => Math.max(0, Math.min(1, value)));
}

function cleanURL(value, maxLength = 1200) {
  const raw = String(value || "").trim().slice(0, maxLength);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function enhancedArtworkURL(value) {
  const raw = cleanURL(value);
  if (!raw) return null;
  return raw.replace(/100x100(?=[-\.])/i, "300x300");
}


function decodeHTMLEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(oz\)/gi, " ")
    .replace(/\bfeat\.?\b|\bfeaturing\b/gi, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function textSimilarity(lhs, rhs) {
  const left = normalizeLookupText(lhs);
  const right = normalizeLookupText(rhs);
  if (!left || !right) return 0;
  if (left === right) return 1;

  if (left.includes(right) || right.includes(left)) {
    return 0.84 + 0.16 * (Math.min(left.length, right.length) / Math.max(left.length, right.length));
  }

  const a = new Set(left.split(/\s+/).filter(Boolean));
  const b = new Set(right.split(/\s+/).filter(Boolean));
  const intersection = [...a].filter(token => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function djMatchScore(requestedTitle, requestedArtist, candidateTitle, candidateArtist) {
  return textSimilarity(requestedTitle, candidateTitle) * 0.72
    + textSimilarity(requestedArtist, candidateArtist) * 0.28;
}

function normalizeDJKeyLabel(value) {
  let raw = decodeHTMLEntities(value).trim();
  if (!raw) return null;

  raw = raw
    .replace(/♯/g, "#")
    .replace(/♭/g, "b")
    .replace(/\s+/g, " ");

  const compact = raw.replace(/\s+/g, "");
  const match = compact.match(/^([A-Ga-g])([#b]?)(maj(?:or)?|min(?:or)?|m)?$/i);
  if (!match) {
    const verbose = raw.match(/^([A-Ga-g])([#b]?)\s+(Major|Minor)$/i);
    if (!verbose) return raw.slice(0, 40);
    return `${verbose[1].toUpperCase()}${verbose[2]} ${verbose[3][0].toUpperCase()}${verbose[3].slice(1).toLowerCase()}`;
  }

  const root = `${match[1].toUpperCase()}${match[2] || ""}`;
  const modeRaw = (match[3] || "").toLowerCase();
  const mode = modeRaw.startsWith("min") || modeRaw === "m" ? "Minor" : "Major";
  return `${root} ${mode}`;
}

async function fetchTextWithTimeout(url, timeoutMs = 6500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (compatible; DJToolkit/7.8; +https://dj-toolkit.com)"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractMetaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHTMLEntities(match[1]);
  }
  return null;
}

function parseBeatportTrackPage(html, url) {
  const ogTitle = extractMetaContent(html, "og:title")
    || decodeHTMLEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");

  let artist = "";
  let title = "";
  const cleanedTitle = ogTitle
    .replace(/\s*\|\s*Music.*$/i, "")
    .replace(/\s*\[[^\]]+\]\s*$/i, "")
    .trim();

  const splitIndex = cleanedTitle.indexOf(" - ");
  if (splitIndex > 0) {
    artist = cleanedTitle.slice(0, splitIndex).trim();
    title = cleanedTitle.slice(splitIndex + 3).trim();
  } else {
    title = cleanedTitle;
  }

  const bpmPatterns = [
    /"bpm"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/i,
    /\bBPM\s*:?\s*([0-9]+(?:\.[0-9]+)?)/i
  ];
  let bpm = null;
  for (const pattern of bpmPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed >= 40 && parsed <= 260) {
        bpm = parsed;
        break;
      }
    }
  }

  const keyPatterns = [
    /"key_name"\s*:\s*"([^"]+)"/i,
    /"key"\s*:\s*\{[^{}]{0,600}?"name"\s*:\s*"([^"]+)"/i,
    /\bKey\s*:?\s*([A-G](?:#|b|♯|♭)?\s+(?:Major|Minor))/i
  ];
  let key = null;
  for (const pattern of keyPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      key = normalizeDJKeyLabel(match[1]);
      if (key) break;
    }
  }

  if (!bpm || !key || !title) return null;
  return { source: "Beatport", title, artist, bpm, key, url };
}

async function lookupBeatportMetadata(artist, title) {
  const searchURL = new URL("https://www.beatport.com/search/tracks");
  searchURL.searchParams.set("q", `${artist} ${title}`);

  // Beatport is best-effort only. It must never hold the request pipeline for
  // tens of seconds because the iPhone can independently analyze preview audio.
  const searchHTML = await fetchTextWithTimeout(searchURL, 3200);
  const links = [];
  const seen = new Set();
  const regex = /href=["'](\/track\/[^"'?#]+\/\d+)["']/gi;
  let match;

  while ((match = regex.exec(searchHTML)) && links.length < 3) {
    const relative = decodeHTMLEntities(match[1]);
    if (!seen.has(relative)) {
      seen.add(relative);
      links.push(`https://www.beatport.com${relative}`);
    }
  }

  if (!links.length) return null;

  const settled = await Promise.allSettled(
    links.map(async trackURL => {
      const html = await fetchTextWithTimeout(trackURL, 2800);
      const candidate = parseBeatportTrackPage(html, trackURL);
      if (!candidate) return null;
      const score = djMatchScore(title, artist, candidate.title, candidate.artist);
      return score >= 0.68 ? { ...candidate, matchScore: score } : null;
    })
  );

  return settled
    .filter(item => item.status === "fulfilled" && item.value)
    .map(item => item.value)
    .sort((a, b) => b.matchScore - a.matchScore)[0] || null;
}

async function lookupGetSongBPMMetadata(artist, title) {
  const apiKey = String(process.env.GETSONGBPM_API_KEY || "").trim();
  if (!apiKey) return null;

  const url = new URL("https://api.getsong.co/search/");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("type", "both");
  url.searchParams.set("lookup", `song:${title} artist:${artist}`);
  url.searchParams.set("limit", "10");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) return null;
    const body = await response.json();

    const candidates = Array.isArray(body)
      ? body
      : Array.isArray(body?.search)
        ? body.search
        : Array.isArray(body?.results)
          ? body.results
          : [];

    let best = null;
    for (const item of candidates) {
      const candidateTitle = String(item?.title || "");
      const candidateArtist = String(item?.artist?.name || item?.artist || "");
      const bpm = Number(item?.tempo);
      const key = normalizeDJKeyLabel(item?.key_of);
      if (!candidateTitle || !candidateArtist || !Number.isFinite(bpm) || !key) continue;

      const score = djMatchScore(title, artist, candidateTitle, candidateArtist);
      if (score >= 0.74 && (!best || score > best.matchScore)) {
        best = {
          source: "GetSongBPM",
          title: candidateTitle,
          artist: candidateArtist,
          bpm,
          key,
          url: cleanURL(item?.uri),
          matchScore: score
        };
      }
    }
    return best;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveDJMetadata(artist, title) {
  const cacheKey = `${normalizeLookupText(artist)}::${normalizeLookupText(title)}`;
  const cached = djMetadataCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < DJ_METADATA_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  let value = null;

  // Prefer the documented API when the owner configured a key.
  if (process.env.GETSONGBPM_API_KEY) {
    try {
      value = await lookupGetSongBPMMetadata(artist, title);
    } catch (error) {
      console.warn("GetSongBPM metadata lookup unavailable", error?.message || error);
    }
  }

  if (!value) {
    try {
      value = await lookupBeatportMetadata(artist, title);
    } catch (error) {
      console.warn("Beatport metadata lookup unavailable", error?.message || error);
    }
  }

  const result = value || { found: false };
  if (value) result.found = true;
  djMetadataCache.set(cacheKey, { createdAt: Date.now(), value: result });
  return result;
}

app.get("/api/catalog-search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 120);
  const country = /^[A-Za-z]{2}$/.test(String(req.query.country || ""))
    ? String(req.query.country).toUpperCase()
    : "DE";

  if (query.length < 2) {
    return res.json({ results: [] });
  }

  const cacheKey = `${country}:${query.toLocaleLowerCase()}`;
  const cached = catalogSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CATALOG_CACHE_TTL_MS) {
    return res.json({ results: cached.results, cached: true });
  }

  try {
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", query);
    url.searchParams.set("country", country);
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("limit", "10");
    url.searchParams.set("explicit", "Yes");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" }
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      throw new Error(`catalog status ${response.status}`);
    }

    const body = await response.json();
    const seen = new Set();
    const results = (Array.isArray(body.results) ? body.results : [])
      .filter(item => item && item.kind === "song" && item.trackName && item.artistName)
      .map(item => ({
        id: String(item.trackId || ""),
        title: String(item.trackName).slice(0, 160),
        artist: String(item.artistName).slice(0, 160),
        album: item.collectionName ? String(item.collectionName).slice(0, 180) : null,
        genre: item.primaryGenreName ? String(item.primaryGenreName).slice(0, 100) : null,
        artworkURL: enhancedArtworkURL(item.artworkUrl100),
        storeURL: cleanURL(item.trackViewUrl),
        previewURL: cleanURL(item.previewUrl),
        explicit: item.trackExplicitness === "explicit",
        durationMillis: Number.isFinite(Number(item.trackTimeMillis)) ? Number(item.trackTimeMillis) : null
      }))
      .filter(item => {
        const key = `${item.title.toLocaleLowerCase()}::${item.artist.toLocaleLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);

    catalogSearchCache.set(cacheKey, { createdAt: Date.now(), results });
    res.json({ results, source: "itunes-search" });
  } catch (error) {
    console.error("catalog search failed", error?.message || error);
    res.status(502).json({ error: "catalog search unavailable", results: [] });
  }
});


app.get("/api/dj-metadata", async (req, res) => {
  const artist = String(req.query.artist || "").trim().slice(0, 160);
  const title = String(req.query.title || "").trim().slice(0, 160);

  if (!artist || !title) {
    return res.status(400).json({ found: false, error: "artist and title are required" });
  }

  try {
    const result = await resolveDJMetadata(artist, title);
    res.set("Cache-Control", "public, max-age=1800");
    return res.json(result);
  } catch (error) {
    console.error("DJ metadata lookup failed", error?.message || error);
    return res.status(502).json({ found: false, error: "DJ metadata unavailable" });
  }
});


app.post("/api/feedback", async (req, res) => {
  const website = String(req.body?.website || "").trim();
  if (website) return res.status(201).json({ ok: true });

  if (!feedbackRateAllowed(req)) {
    return res.status(429).json({
      error: "Zu viele Feedback-Nachrichten in kurzer Zeit. Bitte später erneut versuchen."
    });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const phoneRaw = String(req.body?.phone || "").trim();
  const phone = cleanPhone(phoneRaw);
  const name = String(req.body?.name || "").trim().slice(0, 100) || null;
  const category = String(req.body?.category || "Allgemeines Feedback").trim().slice(0, 80);
  const ratingValue = Number(req.body?.rating);
  const rating = Number.isFinite(ratingValue) && ratingValue >= 1 && ratingValue <= 5
    ? Math.round(ratingValue)
    : null;
  const message = String(req.body?.message || "").trim().slice(0, 5000);

  if (!validEmail(email)) {
    return res.status(400).json({ error: "Bitte gib eine gültige E-Mail-Adresse ein." });
  }
  if (phoneRaw && !phone) {
    return res.status(400).json({ error: "Bitte prüfe die Mobilnummer." });
  }
  if (message.length < 5) {
    return res.status(400).json({ error: "Bitte schreibe uns etwas mehr zu deinem Feedback." });
  }
  if (looksLikeSpam(name, email, category, message)) {
    return res.status(400).json({ error: "Das Feedback wurde vom Spam-Schutz blockiert." });
  }

  if (!feedbackAPIKey()) {
    return res.status(503).json({
      error: "Der Feedback-Mailversand ist noch nicht konfiguriert.",
      code: "RESEND_NOT_CONFIGURED"
    });
  }

  const feedbackTo = String(process.env.FEEDBACK_TO || "info@dj-toolkit.com").trim();
  const fromAddress = String(process.env.FEEDBACK_FROM || "info@dj-toolkit.com").trim();
  const fromName = String(process.env.FEEDBACK_FROM_NAME || "DJ Toolkit").trim().slice(0, 80);
  const from = `${fromName} <${fromAddress}>`;
  const submittedAt = new Date().toISOString();
  const feedbackReference = await nextFeedbackReference();
  const safeFeedbackReference = escapeHTML(feedbackReference);

  const ratingText = rating ? `${rating}/5` : "nicht angegeben";
  const safeName = escapeHTML(name || "Nicht angegeben");
  const safeEmail = escapeHTML(email);
  const safePhone = escapeHTML(phone || "Nicht angegeben");
  const safeCategory = escapeHTML(category);
  const safeMessage = escapeHTML(message).replace(/\n/g, "<br>");
  const safeRating = escapeHTML(ratingText);

  const internalText = [
    "Neues Feedback über dj-toolkit.com",
    "",
    `Feedback-Nr.: ${feedbackReference}`,
    `Name: ${name || "Nicht angegeben"}`,
    `E-Mail: ${email}`,
    `Mobil: ${phone || "Nicht angegeben"}`,
    `Kategorie: ${category}`,
    `Bewertung: ${ratingText}`,
    `Zeit: ${submittedAt}`,
    "",
    "Feedback:",
    message
  ].join("\n");

  const internalHTML = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#070b13;color:#f7f9ff;padding:28px">
      <div style="max-width:680px;margin:auto;background:#0d1422;border:1px solid #26324a;border-radius:20px;padding:26px">
        <div style="font-size:12px;letter-spacing:.14em;color:#5fddff;font-weight:800">DJ TOOLKIT · WEBSITE FEEDBACK</div>
        <h2 style="margin:8px 0 8px;font-size:26px">Neues Feedback</h2>
        <div style="margin-bottom:18px;display:inline-block;padding:7px 10px;border-radius:999px;background:#0b2630;border:1px solid #1f5060;color:#8beaff;font-size:11px;font-weight:900;letter-spacing:.08em">${safeFeedbackReference}</div>
        <table style="width:100%;border-collapse:collapse;color:#dbe5f7;font-size:14px">
          <tr><td style="padding:7px 0;color:#8492aa">Feedback-Nr.</td><td>${safeFeedbackReference}</td></tr>
          <tr><td style="padding:7px 0;color:#8492aa">Name</td><td>${safeName}</td></tr>
          <tr><td style="padding:7px 0;color:#8492aa">E-Mail</td><td>${safeEmail}</td></tr>
          <tr><td style="padding:7px 0;color:#8492aa">Mobil</td><td>${safePhone}</td></tr>
          <tr><td style="padding:7px 0;color:#8492aa">Kategorie</td><td>${safeCategory}</td></tr>
          <tr><td style="padding:7px 0;color:#8492aa">Bewertung</td><td>${safeRating}</td></tr>
        </table>
        <div style="margin-top:22px;padding:18px;border-radius:14px;background:#080d17;line-height:1.65">${safeMessage}</div>
      </div>
    </div>`;

  const feedbackExcerpt = message.length > 700
    ? `${message.slice(0, 700).trim()}…`
    : message;
  const safeFeedbackExcerpt = escapeHTML(feedbackExcerpt).replace(/\n/g, "<br>");

  const thanksText = [
    name ? `Hallo ${name},` : "Hallo,",
    "",
    "vielen Dank, dass du dir die Zeit genommen hast, uns dein Feedback zu DJ Toolkit zu schicken.",
    "Deine Nachricht ist sicher bei unserem Team angekommen.",
    "",
    `Bezug / Feedback-Nr.: ${feedbackReference}`,
    `Kategorie: ${category}`,
    rating ? `Bewertung: ${rating}/5` : null,
    "",
    "Dein Feedback:",
    feedbackExcerpt,
    "",
    "Was passiert jetzt?",
    "• Unser Team prüft deine Rückmeldung.",
    "• Besonders hilfreiche Vorschläge berücksichtigen wir beim nächsten Update.",
    "• Falls wir Rückfragen haben, können wir dir direkt auf diese E-Mail antworten.",
    "",
    "Danke, dass du DJ Toolkit gemeinsam mit uns besser machst.",
    "",
    "Mehr Musik. Bessere Nächte.",
    "",
    "Dein DJ-Toolkit Team",
    "info@dj-toolkit.com",
    "https://dj-toolkit.com"
  ].filter(Boolean).join("\n");

  const thanksHTML = `
  <!doctype html>
  <html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Danke für dein Feedback · DJ Toolkit</title>
  </head>
  <body style="margin:0;padding:0;background:#05070d;color:#f7f9ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">
      Deine Nachricht ist bei unserem DJ-Toolkit Team angekommen.
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#05070d;margin:0;padding:0;">
      <tr>
        <td align="center" style="padding:36px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#0b111d;border:1px solid #243049;border-radius:24px;overflow:hidden;">
            <tr>
              <td style="padding:0;background:#09101a;">
                <div style="height:5px;background:linear-gradient(90deg,#16cfff 0%,#5b7cff 45%,#9b5dff 72%,#e14dff 100%);font-size:0;line-height:0;">&nbsp;</div>
              </td>
            </tr>

            <tr>
              <td style="padding:30px 32px 10px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td valign="middle">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td style="padding-right:12px;">
                            <img src="https://dj-toolkit.com/djtoolkit-icon.png" width="48" height="48" alt="DJ Toolkit" style="display:block;border:0;border-radius:12px;width:48px;height:48px;">
                          </td>
                          <td valign="middle">
                            <div style="font-size:17px;line-height:1.2;font-weight:900;letter-spacing:.04em;color:#ffffff;">DJ TOOLKIT</div>
                            <div style="font-size:10px;line-height:1.4;font-weight:800;letter-spacing:.16em;color:#6edfff;margin-top:3px;">ANALYZE · MIX · PERFORM · TOGETHER</div>
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td align="right" valign="middle">
                      <span style="display:inline-block;padding:8px 11px;border-radius:999px;background:#0b2b24;border:1px solid #1f5b49;color:#73e9b5;font-size:10px;font-weight:900;letter-spacing:.08em;">
                        ✓ FEEDBACK ERHALTEN
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 32px 0;">
                <div style="font-size:12px;line-height:1.4;color:#7a8ba7;font-weight:800;letter-spacing:.12em;">DANKE FÜR DEINE RÜCKMELDUNG</div>
                <h1 style="margin:8px 0 14px;font-size:34px;line-height:1.08;letter-spacing:-.035em;color:#ffffff;">Du hilfst uns, DJ Toolkit besser zu machen.</h1>
                <p style="margin:0 0 15px;font-size:16px;line-height:1.7;color:#c0cada;">
                  ${name ? `Hallo ${escapeHTML(name)},` : "Hallo,"}
                </p>
                <p style="margin:0;font-size:15px;line-height:1.75;color:#aebbd0;">
                  vielen Dank, dass du dir die Zeit genommen hast, uns deine Ideen, Anregungen oder Verbesserungsvorschläge mitzuteilen.
                  Deine Nachricht ist <strong style="color:#ffffff;">sicher bei unserem DJ-Toolkit Team angekommen</strong>.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 32px 0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#080d16;border:1px solid #202d43;border-radius:18px;">
                  <tr>
                    <td style="padding:20px;">
                      <div style="font-size:10px;line-height:1.4;color:#6edfff;font-weight:900;letter-spacing:.13em;margin-bottom:13px;">DEIN FEEDBACK</div>

                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td style="font-size:12px;color:#74839c;padding:0 12px 8px 0;">Feedback-Nr.</td>
                          <td align="right" style="font-size:12px;font-weight:900;color:#7fe5ff;padding:0 0 8px;">${safeFeedbackReference}</td>
                        </tr>
                        <tr>
                          <td style="font-size:12px;color:#74839c;padding:0 12px 8px 0;">Kategorie</td>
                          <td align="right" style="font-size:12px;font-weight:800;color:#eef3ff;padding:0 0 8px;">${safeCategory}</td>
                        </tr>
                        ${rating ? `
                        <tr>
                          <td style="font-size:12px;color:#74839c;padding:0 12px 12px 0;">Bewertung</td>
                          <td align="right" style="font-size:12px;font-weight:800;color:#ffd76d;padding:0 0 12px;">${safeRating}</td>
                        </tr>` : ""}
                      </table>

                      <div style="margin-top:10px;padding:15px 16px;border-radius:14px;background:#0d1522;border-left:3px solid #8c63ff;color:#c7d1e2;font-size:13px;line-height:1.65;">
                        ${safeFeedbackExcerpt}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 32px 0;">
                <div style="font-size:10px;line-height:1.4;color:#8d9bb2;font-weight:900;letter-spacing:.13em;margin-bottom:12px;">WAS PASSIERT JETZT?</div>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td width="34" valign="top" style="padding:0 10px 14px 0;">
                      <div style="width:30px;height:30px;line-height:30px;text-align:center;border-radius:10px;background:#0b2630;color:#62ddff;font-weight:900;">1</div>
                    </td>
                    <td valign="top" style="padding:3px 0 14px;color:#aebbd0;font-size:13px;line-height:1.55;">
                      <strong style="color:#ffffff;">Wir lesen dein Feedback.</strong><br>
                      Unser Team prüft jede Rückmeldung und ordnet sie dem passenden Produktbereich zu.
                    </td>
                  </tr>
                  <tr>
                    <td width="34" valign="top" style="padding:0 10px 14px 0;">
                      <div style="width:30px;height:30px;line-height:30px;text-align:center;border-radius:10px;background:#211633;color:#cf8cff;font-weight:900;">2</div>
                    </td>
                    <td valign="top" style="padding:3px 0 14px;color:#aebbd0;font-size:13px;line-height:1.55;">
                      <strong style="color:#ffffff;">Hilfreiche Vorschläge fürs nächste Update.</strong><br>
                      Besonders hilfreiche Vorschläge berücksichtigen wir beim nächsten Update.
                    </td>
                  </tr>
                  <tr>
                    <td width="34" valign="top" style="padding:0 10px 0 0;">
                      <div style="width:30px;height:30px;line-height:30px;text-align:center;border-radius:10px;background:#13261f;color:#7ae5b4;font-weight:900;">3</div>
                    </td>
                    <td valign="top" style="padding:3px 0 0;color:#aebbd0;font-size:13px;line-height:1.55;">
                      <strong style="color:#ffffff;">Wir melden uns bei Bedarf.</strong><br>
                      Falls wir eine Rückfrage haben, können wir dich über deine angegebene E-Mail-Adresse erreichen.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:28px 32px 4px;">
                <a href="https://dj-toolkit.com" style="display:inline-block;text-decoration:none;background:#347fff;color:#ffffff;border-radius:14px;padding:14px 22px;font-size:13px;font-weight:900;">
                  Zurück zu DJ Toolkit →
                </a>
              </td>
            </tr>

            <tr>
              <td style="padding:25px 32px 30px;">
                <div style="border-top:1px solid #202a3d;padding-top:21px;text-align:center;">
                  <div style="font-size:15px;line-height:1.5;font-weight:900;color:#72ddff;">Mehr Musik. Bessere Nächte.</div>
                  <div style="margin-top:8px;font-size:11px;line-height:1.65;color:#74839b;">
                    Dein DJ-Toolkit Team<br>
                    <a href="mailto:info@dj-toolkit.com" style="color:#9ba9bf;text-decoration:none;">info@dj-toolkit.com</a>
                    &nbsp;·&nbsp;
                    <a href="https://dj-toolkit.com" style="color:#9ba9bf;text-decoration:none;">dj-toolkit.com</a>
                  </div>
                  <div style="margin-top:14px;font-size:9px;line-height:1.5;color:#536077;">
                    Diese Nachricht wurde automatisch versendet, da dein Feedback mit dieser E-Mail-Adresse eingereicht wurde.
                  </div>
                </div>
              </td>
            </tr>
          </table>

          <div style="max-width:640px;margin:14px auto 0;text-align:center;color:#465168;font-size:9px;line-height:1.5;">
            DJ Toolkit · For DJs. By DJs.
          </div>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

  try {
    const results = await Promise.allSettled([
      sendFeedbackEmail({
        from,
        to: [feedbackTo],
        reply_to: email,
        subject: `DJ Toolkit Feedback · ${feedbackReference} · ${category}${rating ? ` · ${rating}/5` : ""}`,
        text: internalText,
        html: internalHTML
      }),
      sendFeedbackEmail({
        from,
        to: [email],
        reply_to: feedbackTo,
        subject: `Danke, dass du DJ Toolkit besser machst · ${feedbackReference}`,
        text: thanksText,
        html: thanksHTML
      })
    ]);

    const feedbackDelivered = results[0].status === "fulfilled";
    const confirmationDelivered = results[1].status === "fulfilled";

    if (!feedbackDelivered) {
      console.error("feedback delivery failed", results[0].reason?.message || results[0].reason);
      return res.status(502).json({ error: "Das Feedback konnte gerade nicht per E-Mail zugestellt werden." });
    }

    if (!confirmationDelivered) {
      console.warn("feedback confirmation failed", results[1].reason?.message || results[1].reason);
    }

    return res.status(201).json({
      ok: true,
      deliveredTo: feedbackTo,
      confirmationSent: confirmationDelivered,
      feedbackReference
    });
  } catch (error) {
    console.error("feedback email failed", error?.message || error);
    return res.status(502).json({ error: "Der Mailversand ist gerade nicht verfügbar." });
  }
});


app.post("/api/newsletter/subscribe", async (req, res) => {
  const website = String(req.body?.website || "").trim();
  if (website) return res.status(201).json({ ok: true });

  if (!newsletterRateAllowed(req)) {
    return res.status(429).json({ error: "Zu viele Anmeldeversuche in kurzer Zeit. Bitte später erneut versuchen." });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim().slice(0, 100) || null;
  const consent = req.body?.consent === true;
  const interests = newsletterInterests(req.body?.interests);

  if (!validEmail(email)) {
    return res.status(400).json({ error: "Bitte gib eine gültige E-Mail-Adresse ein." });
  }
  if (!consent) {
    return res.status(400).json({ error: "Bitte bestätige, dass du den DJ-Toolkit Newsletter erhalten möchtest." });
  }
  if (!feedbackAPIKey()) {
    return res.status(503).json({ error: "Der Newsletter-Mailversand ist noch nicht konfiguriert." });
  }

  const existing = await findNewsletterSubscriberByEmail(email);

  if (existing?.status === "confirmed") {
    await upsertNewsletterSubscriber({
      ...existing,
      name: name || existing.name || null,
      interests,
      updatedAt: new Date().toISOString()
    });
    return res.status(200).json({ ok: true, alreadySubscribed: true });
  }

  const confirmToken = crypto.randomBytes(32).toString("hex");
  const unsubscribeToken = existing?.unsubscribeToken || crypto.randomBytes(32).toString("hex");
  const now = new Date().toISOString();

  const subscriber = {
    id: existing?.id || `DJT-NL-${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
    email,
    name,
    interests,
    status: "pending",
    confirmTokenHash: tokenHash(confirmToken),
    unsubscribeToken,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    confirmedAt: null,
    unsubscribedAt: null,
    consentAt: now,
    source: "dj-toolkit.com"
  };

  await upsertNewsletterSubscriber(subscriber);

  const baseURL = publicBaseURL();
  const confirmURL = `${baseURL}/api/newsletter/confirm?token=${encodeURIComponent(confirmToken)}`;
  const fromAddress = String(process.env.FEEDBACK_FROM || "info@dj-toolkit.com").trim();
  const fromName = String(process.env.FEEDBACK_FROM_NAME || "DJ Toolkit").trim().slice(0, 80);
  const from = `${fromName} <${fromAddress}>`;
  const safeName = escapeHTML(name || "");
  const interestText = newsletterInterestLabel(interests);

  const text = [
    name ? `Hallo ${name},` : "Hallo,",
    "",
    "du möchtest Updates von DJ Toolkit erhalten.",
    `Themen: ${interestText}`,
    "",
    "Bitte bestätige deine Anmeldung über diesen Link:",
    confirmURL,
    "",
    "Erst nach der Bestätigung erhältst du Newsletter von uns.",
    "",
    "DJ Toolkit · Mehr Musik. Bessere Nächte."
  ].join("\n");

  const html = `<!doctype html>
  <html lang="de"><body style="margin:0;background:#05070d;color:#f7f9ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#05070d"><tr><td align="center" style="padding:36px 16px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#0b111d;border:1px solid #243049;border-radius:24px;overflow:hidden">
        <tr><td><div style="height:5px;background:linear-gradient(90deg,#16cfff,#5b7cff,#9b5dff,#e14dff)">&nbsp;</div></td></tr>
        <tr><td style="padding:30px 32px">
          <div style="font-size:10px;letter-spacing:.15em;color:#6edfff;font-weight:900">DJ TOOLKIT · NEWSLETTER</div>
          <h1 style="font-size:31px;line-height:1.1;margin:9px 0 15px">Bestätige deine Anmeldung.</h1>
          <p style="color:#aebbd0;line-height:1.7">${safeName ? `Hallo ${safeName},` : "Hallo,"}</p>
          <p style="color:#aebbd0;line-height:1.7">du möchtest Neuigkeiten zu <strong style="color:#fff">${escapeHTML(interestText)}</strong> erhalten. Bitte bestätige deine Anmeldung mit einem Klick.</p>
          <div style="padding:18px 0 8px"><a href="${escapeHTML(confirmURL)}" style="display:inline-block;padding:14px 20px;border-radius:14px;background:linear-gradient(105deg,#168fff,#785bff 68%,#b952ff);color:#fff;text-decoration:none;font-weight:900">Newsletter bestätigen →</a></div>
          <p style="margin-top:22px;color:#64728a;font-size:10px;line-height:1.6">Ohne Bestätigung wird deine Adresse nicht für Newsletter aktiviert.</p>
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  try {
    await sendFeedbackEmail({
      from,
      to: [email],
      reply_to: String(process.env.FEEDBACK_TO || "info@dj-toolkit.com").trim(),
      subject: "Newsletter-Anmeldung bestätigen · DJ Toolkit",
      text,
      html
    });
    return res.status(201).json({ ok: true, confirmationRequired: true });
  } catch (error) {
    console.error("newsletter confirmation send failed", error?.message || error);
    return res.status(502).json({ error: "Die Bestätigungs-E-Mail konnte gerade nicht gesendet werden." });
  }
});

app.get("/api/newsletter/confirm", async (req, res) => {
  const token = String(req.query?.token || "").trim();
  if (!token) {
    return res.status(400).send(renderSimplePage({
      eyebrow: "DJ TOOLKIT · NEWSLETTER",
      title: "Bestätigungslink ungültig",
      text: "Der Bestätigungslink ist unvollständig."
    }));
  }

  const hash = tokenHash(token);
  let subscriber = await findNewsletterSubscriberByConfirmHash(hash);

  if (!subscriber) {
    return res.status(400).send(renderSimplePage({
      eyebrow: "DJ TOOLKIT · NEWSLETTER",
      title: "Link nicht mehr gültig",
      text: "Die Anmeldung wurde bereits bestätigt oder der Link ist nicht mehr gültig."
    }));
  }

  subscriber = await confirmNewsletterSubscriber(subscriber.id);
  if (!subscriber) {
    return res.status(500).send(renderSimplePage({
      eyebrow: "DJ TOOLKIT · NEWSLETTER",
      title: "Bestätigung fehlgeschlagen",
      text: "Die Newsletter-Anmeldung konnte gerade nicht gespeichert werden. Bitte versuche es später erneut."
    }));
  }

  const baseURL = publicBaseURL();
  const unsubscribeURL = `${baseURL}/api/newsletter/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`;
  const fromAddress = String(process.env.FEEDBACK_FROM || "info@dj-toolkit.com").trim();
  const fromName = String(process.env.FEEDBACK_FROM_NAME || "DJ Toolkit").trim().slice(0, 80);
  const from = `${fromName} <${fromAddress}>`;

  const welcomeText = [
    subscriber.name ? `Hallo ${subscriber.name},` : "Hallo,",
    "",
    "deine Anmeldung zum DJ-Toolkit Newsletter ist bestätigt.",
    "Wir informieren dich künftig über App-Releases, Beta- und Testphasen sowie wichtige Produkt-Updates entsprechend deiner Auswahl.",
    "",
    "Du kannst dich jederzeit abmelden:",
    unsubscribeURL,
    "",
    "Mehr Musik. Bessere Nächte."
  ].join("\n");

  const welcomeHTML = `<!doctype html><html lang="de"><body style="margin:0;background:#05070d;color:#f7f9ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="padding:36px 16px"><div style="max-width:640px;margin:auto;background:#0b111d;border:1px solid #243049;border-radius:24px;padding:30px;box-sizing:border-box">
      <div style="font-size:10px;letter-spacing:.15em;color:#6edfff;font-weight:900">DJ TOOLKIT · NEWSLETTER</div>
      <h1 style="font-size:31px;margin:9px 0 14px">Du bist dabei.</h1>
      <p style="color:#aebbd0;line-height:1.7">Deine Anmeldung ist bestätigt. Wir halten dich über Releases, Beta-/Testphasen und wichtige DJ-Toolkit Updates auf dem Laufenden.</p>
      <p style="margin-top:24px;color:#607089;font-size:10px;line-height:1.6">Du möchtest keine Newsletter mehr? <a href="${escapeHTML(unsubscribeURL)}" style="color:#8edfff">Hier abmelden</a>.</p>
    </div></div>
  </body></html>`;

  sendFeedbackEmail({
    from,
    to: [subscriber.email],
    reply_to: String(process.env.FEEDBACK_TO || "info@dj-toolkit.com").trim(),
    subject: "Du bist beim DJ-Toolkit Newsletter dabei",
    text: welcomeText,
    html: welcomeHTML
  }).catch(error => console.warn("newsletter welcome send failed", error?.message || error));

  return res.status(200).send(renderSimplePage({
    eyebrow: "DJ TOOLKIT · NEWSLETTER",
    title: "Anmeldung bestätigt",
    text: "Du bist jetzt im DJ-Toolkit Newsletter. Wir informieren dich über Releases, Testphasen und wichtige Updates.",
    actionLabel: "DJ Toolkit öffnen",
    actionURL: "/"
  }));
});

app.get("/api/newsletter/unsubscribe", async (req, res) => {
  const token = String(req.query?.token || "").trim();
  const subscriber = await findNewsletterSubscriberByUnsubscribeToken(token);

  if (!subscriber) {
    return res.status(400).send(renderSimplePage({
      eyebrow: "DJ TOOLKIT · NEWSLETTER",
      title: "Abmeldelink ungültig",
      text: "Wir konnten diese Newsletter-Anmeldung nicht finden."
    }));
  }

  await unsubscribeNewsletterSubscriber(subscriber.id);

  return res.status(200).send(renderSimplePage({
    eyebrow: "DJ TOOLKIT · NEWSLETTER",
    title: "Du bist abgemeldet",
    text: "Du erhältst ab jetzt keine DJ-Toolkit Newsletter mehr. Eine erneute Anmeldung ist jederzeit möglich."
  }));
});

app.post("/api/admin/newsletter/send", async (req, res) => {
  const configuredToken = String(process.env.NEWSLETTER_ADMIN_TOKEN || "").trim();
  const auth = String(req.headers.authorization || "");
  const providedToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!configuredToken || !providedToken || !crypto.timingSafeEqual(
    Buffer.from(configuredToken),
    Buffer.from(providedToken.padEnd(configuredToken.length).slice(0, configuredToken.length))
  )) {
    return res.status(401).json({ error: "Nicht autorisiert." });
  }

  const subject = String(req.body?.subject || "").trim().slice(0, 180);
  const title = String(req.body?.title || "").trim().slice(0, 180);
  const intro = String(req.body?.intro || "").trim().slice(0, 1200);
  const bodyText = String(req.body?.body || "").trim().slice(0, 6000);
  const ctaLabel = String(req.body?.ctaLabel || "DJ Toolkit öffnen").trim().slice(0, 80);
  const ctaURL = String(req.body?.ctaURL || publicBaseURL()).trim().slice(0, 500);
  const audience = String(req.body?.audience || "all").trim();

  if (!subject || !title || !bodyText) {
    return res.status(400).json({ error: "subject, title und body sind erforderlich." });
  }

  const allowedAudiences = new Set(["all", "release", "beta", "updates"]);
  if (!allowedAudiences.has(audience)) {
    return res.status(400).json({ error: "Ungültige Zielgruppe." });
  }

  const confirmed = await confirmedNewsletterSubscribers();
  const recipients = confirmed.filter(item =>
    validEmail(item?.email)
    && (audience === "all" || newsletterInterests(item?.interests).includes(audience))
  );

  const fromAddress = String(process.env.FEEDBACK_FROM || "info@dj-toolkit.com").trim();
  const fromName = String(process.env.FEEDBACK_FROM_NAME || "DJ Toolkit").trim().slice(0, 80);
  const from = `${fromName} <${fromAddress}>`;
  const baseURL = publicBaseURL();

  const sendOne = async subscriber => {
    const unsubscribeURL = `${baseURL}/api/newsletter/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`;
    const safeTitle = escapeHTML(title);
    const safeIntro = escapeHTML(intro).replace(/\n/g, "<br>");
    const safeBody = escapeHTML(bodyText).replace(/\n/g, "<br>");
    const safeCTA = escapeHTML(ctaLabel);
    const safeCTAURL = escapeHTML(ctaURL);

    const text = [
      subscriber.name ? `Hallo ${subscriber.name},` : "Hallo,",
      "",
      title,
      intro,
      "",
      bodyText,
      "",
      `${ctaLabel}: ${ctaURL}`,
      "",
      "Newsletter abbestellen:",
      unsubscribeURL
    ].filter(Boolean).join("\n");

    const html = `<!doctype html><html lang="de"><body style="margin:0;background:#05070d;color:#f7f9ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#05070d"><tr><td align="center" style="padding:36px 16px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:660px;background:#0b111d;border:1px solid #243049;border-radius:24px;overflow:hidden">
          <tr><td><div style="height:5px;background:linear-gradient(90deg,#16cfff,#5b7cff,#9b5dff,#e14dff)">&nbsp;</div></td></tr>
          <tr><td style="padding:32px">
            <div style="font-size:10px;letter-spacing:.15em;color:#6edfff;font-weight:900">DJ TOOLKIT · UPDATE</div>
            <h1 style="font-size:32px;line-height:1.1;margin:9px 0 15px">${safeTitle}</h1>
            ${safeIntro ? `<p style="font-size:16px;color:#d0d9e8;line-height:1.7">${safeIntro}</p>` : ""}
            <div style="font-size:14px;color:#aebbd0;line-height:1.75">${safeBody}</div>
            <div style="padding:24px 0 10px"><a href="${safeCTAURL}" style="display:inline-block;padding:14px 20px;border-radius:14px;background:linear-gradient(105deg,#168fff,#785bff 68%,#b952ff);color:#fff;text-decoration:none;font-weight:900">${safeCTA} →</a></div>
            <div style="margin-top:24px;padding-top:18px;border-top:1px solid #202a3d;color:#607089;font-size:9px;line-height:1.6">
              Du erhältst diese Nachricht, weil du den DJ-Toolkit Newsletter bestätigt hast.
              <a href="${escapeHTML(unsubscribeURL)}" style="color:#8edfff">Newsletter abbestellen</a>
            </div>
          </td></tr>
        </table>
      </td></tr></table>
    </body></html>`;

    return sendFeedbackEmail({
      from,
      to: [subscriber.email],
      reply_to: String(process.env.FEEDBACK_TO || "info@dj-toolkit.com").trim(),
      subject,
      text,
      html
    });
  };

  let sent = 0;
  let failed = 0;
  const batchSize = 5;

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(sendOne));
    for (const result of results) {
      if (result.status === "fulfilled") sent += 1;
      else failed += 1;
    }
  }

  return res.json({
    ok: failed === 0,
    audience,
    recipients: recipients.length,
    sent,
    failed
  });
});

app.get("/health", (_, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    version: "10.7.0",
    onlineAnalysis: true,
    catalogPreviewAudio: true,
    djMetadata: true,
    requestVoting: true,
    duplicateConsolidation: true,
    guestGenreVoting: true,
    eventMusicDirection: true,
    eventFormatRequestScoring: true,
    requestGenreDisplay: true,
    catalogGenreEnrichment: true,
    websiteFeedback: true,
    feedbackConfirmationEmail: true,
    feedbackReferenceNumbers: true,
    newsletterDoubleOptIn: true,
    newsletterCampaignAPI: true,
    newsletterUnsubscribe: true,
    postgresPersistence: Boolean(db),
    persistentFeedbackSequence: Boolean(db),
    persistentNewsletterSubscribers: Boolean(db),
    resendHTTPSAPI: true,
    clientPortal: true,
    requestETA: true,
    multiDJHandover: true,
      sharedPlayedTrackLog: true,
    workflowOS: true,
    multiDeviceSync: true,
    announcements: true,
    whiteLabelGuestWeb: true,
    teamAccounts: true,
    remoteManager: true,
    requestModeration: true,
    djMetadataProviders: process.env.GETSONGBPM_API_KEY ? ["Beatport", "GetSongBPM"] : ["Beatport"]
  });
});

app.get("/api/events/recent", (req, res) => {
  const rows = readStore();
  const grouped = new Map();

  for (const row of rows) {
    if (!row.eventID) continue;
    const createdAt = row.createdAt || new Date(0).toISOString();
    const current = grouped.get(row.eventID);
    if (!current) {
      grouped.set(row.eventID, {
        id: row.eventID,
        name: row.eventName || null,
        lastRequestAt: createdAt,
        requestCount: 1
      });
      continue;
    }

    current.requestCount += 1;
    if (!current.name && row.eventName) current.name = row.eventName;
    if (new Date(createdAt) > new Date(current.lastRequestAt)) {
      current.lastRequestAt = createdAt;
    }
  }

  res.json(
    [...grouped.values()]
      .sort((a, b) => new Date(b.lastRequestAt) - new Date(a.lastRequestAt))
      .slice(0, 20)
  );
});

app.get("/api/events/:eventID/requests", async (req, res) => {
  const allRows = readStore();
  const eventRows = allRows
    .filter(row => row.eventID === req.params.eventID)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // V10.3 progressively fills missing genres for old/manual requests.
  // Limit each pass so a large old event never blocks the Requests screen.
  const missing = eventRows.filter(row => !String(row.requestGenre || "").trim()).slice(0, 12);

  if (missing.length) {
    const genres = await Promise.all(
      missing.map(row => lookupCatalogGenre(row.artist, row.title).catch(() => null))
    );
    let changed = false;

    missing.forEach((row, index) => {
      const genre = genres[index];
      if (!genre) return;
      const stored = allRows.find(item => item.id === row.id);
      if (!stored) return;

      stored.requestGenre = genre;
      const state = getEventState(stored.eventID);
      const formatMeta = requestFormatMeta(state, genre);
      stored.eventMusicDirection = formatMeta.musicDirection;
      stored.formatCompatibility = formatMeta.formatCompatibility;
      stored.formatWarning = formatMeta.formatWarning;
      changed = true;
    });

    if (changed) writeStore(allRows);
  }

  const refreshed = allRows
    .filter(row => row.eventID === req.params.eventID)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(refreshed.map(sanitizeRowForClient));
});

app.get("/api/events/:eventID/public-summary", (req, res) => {
  const rows = readStore().filter(row =>
    row.eventID === req.params.eventID && row.status !== "declined"
  );

  const counts = new Map();
  for (const row of rows) {
    const key = normalizeRequestKey(row.artist, row.title);
    const current = counts.get(key) || {
      representativeRequestID: row.id,
      artist: row.artist,
      title: row.title,
      count: 0,
      votes: 0
    };
    const rowVotes = Math.max(1, Number(row.voteCount || 1));
    current.count += Math.max(1, Number(row.duplicateCount || 1));
    if (!current.maxSingleVotes || rowVotes > current.maxSingleVotes) {
      current.representativeRequestID = row.id;
      current.maxSingleVotes = rowVotes;
    }
    current.votes += rowVotes;
    counts.set(key, current);
  }

  const topRequests = [...counts.values()]
    .map(({ maxSingleVotes, ...item }) => item)
    .sort((a, b) => b.votes - a.votes || b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 8);

  const totalRequests = rows.reduce((sum, row) => sum + Math.max(1, Number(row.duplicateCount || 1)), 0);
  res.json({ requestCount: totalRequests, topRequests });
});

app.get("/api/requests/:requestID/public", (req, res) => {
  const row = readStore().find(item => item.id === req.params.requestID);
  if (!row) return res.status(404).json({ error: "not found" });

  res.json({
    id: row.id,
    artist: row.artist,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt,
    voteCount: Math.max(1, Number(row.voteCount || 1)),
    duplicateCount: Math.max(1, Number(row.duplicateCount || 1)),
    estimatedMinutes: Number.isFinite(Number(row.estimatedMinutes)) ? Number(row.estimatedMinutes) : null,
    publicStatusMessage: row.publicStatusMessage || null,
    eventMusicDirection: row.eventMusicDirection || null,
    formatCompatibility: row.formatCompatibility || null,
    formatWarning: row.formatWarning || null
  });
});

app.post("/api/events/:eventID/requests", async (req, res) => {
  const artist = String(req.body.artist || "").trim();
  const title = String(req.body.title || "").trim();
  const honeypot = String(req.body.website || "").trim();

  if (honeypot) {
    return res.status(201).json({
      id: crypto.randomUUID(), eventID: req.params.eventID, artist, title,
      status: "new", createdAt: new Date().toISOString(), voteCount: 1, duplicateCount: 1
    });
  }

  if (!artist || !title) return res.status(400).json({ error: "artist and title are required" });
  if (!requestRateAllowed(req, req.params.eventID)) {
    return res.status(429).json({ error: "Zu viele Wünsche in kurzer Zeit. Bitte kurz warten." });
  }
  if (looksLikeSpam(artist, title, req.body.guestName, req.body.message)) {
    return res.status(400).json({ error: "Der Wunsch wurde vom Spam-Schutz blockiert." });
  }

  const eventState = getEventState(req.params.eventID);
  let requestGenre = String(req.body.catalogGenre || "").trim().slice(0, 100) || null;

  if (!requestGenre) {
    requestGenre = await lookupCatalogGenre(artist, title).catch(() => null);
  }

  const formatMeta = requestFormatMeta(eventState, requestGenre);

  const rows = readStore();
  const requestKey = normalizeRequestKey(artist, title);
  const existingIndex = rows.findIndex(row =>
    row.eventID === req.params.eventID &&
    row.status !== "declined" && row.status !== "played" &&
    normalizeRequestKey(row.artist, row.title) === requestKey
  );

  // Submitting the same track again acts as crowd support instead of creating
  // 15 visually identical cards in the DJ inbox.
  if (existingIndex >= 0) {
    const existing = rows[existingIndex];
    existing.duplicateCount = Math.max(1, Number(existing.duplicateCount || 1)) + 1;
    existing.voteCount = Math.max(1, Number(existing.voteCount || 1)) + 1;
    existing.lastRequestAt = new Date().toISOString();
    if (!String(existing.requestGenre || "").trim() && requestGenre) {
      existing.requestGenre = requestGenre;
    }
    existing.eventMusicDirection = formatMeta.musicDirection;
    existing.formatCompatibility = formatMeta.formatCompatibility;
    existing.formatWarning = formatMeta.formatWarning;
    if (formatMeta.formatCompatibility === "outside") {
      existing.publicStatusMessage = `Außerhalb ${formatMeta.formatLabel} · DJ entscheidet`;
    }
    existing.supporters = Array.isArray(existing.supporters) ? existing.supporters.slice(-49) : [];
    existing.supporters.push({
      guestName: String(req.body.guestName || "").trim().slice(0, 80) || null,
      message: String(req.body.message || "").trim().slice(0, 300) || null,
      createdAt: new Date().toISOString()
    });
    rows[existingIndex] = existing;
    writeStore(rows);
    return res.status(200).json({ ...sanitizeRowForClient(existing), mergedDuplicate: true });
  }

  const row = {
    id: crypto.randomUUID(),
    eventID: req.params.eventID,
    eventName: String(req.body.eventName || "").trim().slice(0, 120) || null,
    artist: artist.slice(0, 120), title: title.slice(0, 120),
    guestName: String(req.body.guestName || "").trim().slice(0, 80) || null,
    message: String(req.body.message || "").trim().slice(0, 300) || null,
    createdAt: new Date().toISOString(), status: "new",
    voteCount: 1, duplicateCount: 1, voterHashes: [],
    supporters: [{
      guestName: String(req.body.guestName || "").trim().slice(0, 80) || null,
      message: String(req.body.message || "").trim().slice(0, 300) || null,
      createdAt: new Date().toISOString()
    }],
    bpm: null, musicalKey: null, bpmConfidence: null, keyConfidence: null,
    energyLevel: null, vocalProbability: null, trackHealthScore: null, loudnessDB: null,
    firstDropSeconds: null, suggestedMixOutSeconds: null,
    waveformSamples: null, analysisUpdatedAt: null,
    catalogMatchTitle: null, catalogMatchArtist: null, catalogMatchURL: null, catalogMatchScore: null,
    libraryMatchTitle: null, libraryMatchArtist: null, libraryMatchScore: null, libraryPersistentID: null,
    autoAnalysisState: null, autoAnalysisAttemptedAt: null, autoAnalysisError: null,
    analysisSource: null, onlineAnalysisAttemptedAt: null,
    djMetadataSource: null, djMetadataURL: null, djMetadataTitle: null,
    djMetadataArtist: null, djMetadataMatchScore: null,
    requestCatalogID: String(req.body.catalogID || "").trim().slice(0, 80) || null,
    requestArtworkURL: cleanURL(req.body.catalogArtworkURL),
    requestStoreURL: cleanURL(req.body.catalogStoreURL),
    requestPreviewURL: cleanURL(req.body.catalogPreviewURL),
    requestAlbum: String(req.body.catalogAlbum || "").trim().slice(0, 180) || null,
    requestGenre,
    eventMusicDirection: formatMeta.musicDirection,
    formatCompatibility: formatMeta.formatCompatibility,
    formatWarning: formatMeta.formatWarning,
    estimatedMinutes: null,
    publicStatusMessage: formatMeta.formatCompatibility === "outside"
      ? `Außerhalb ${formatMeta.formatLabel} · DJ entscheidet`
      : "In der DJ Queue"
  };

  rows.push(row); writeStore(rows);
  res.status(201).json(sanitizeRowForClient(row));
});

app.post("/api/requests/:requestID/vote", (req, res) => {
  const token = String(req.body.voterToken || "").trim();
  if (token.length < 8 || token.length > 160) return res.status(400).json({ error: "voterToken required" });

  const rows = readStore();
  const index = rows.findIndex(row => row.id === req.params.requestID);
  if (index < 0) return res.status(404).json({ error: "not found" });

  const row = rows[index];
  const hash = hashVoterToken(token);
  const voters = Array.isArray(row.voterHashes) ? row.voterHashes : [];
  if (voters.includes(hash)) {
    return res.json({ ok: true, alreadyVoted: true, voteCount: Math.max(1, Number(row.voteCount || 1)) });
  }

  voters.push(hash);
  row.voterHashes = voters.slice(-5000);
  row.voteCount = Math.max(1, Number(row.voteCount || 1)) + 1;
  row.voteUpdatedAt = new Date().toISOString();
  rows[index] = row;
  writeStore(rows);
  res.json({ ok: true, alreadyVoted: false, voteCount: row.voteCount });
});

app.patch("/api/requests/:requestID", (req, res) => {
  const rows = readStore();
  const index = rows.findIndex(row => row.id === req.params.requestID);

  if (index < 0) {
    return res.status(404).json({ error: "not found" });
  }

  const allowedStatuses = new Set(["new", "accepted", "played", "declined"]);
  const current = rows[index];

  const next = {
    ...current,
    status: allowedStatuses.has(req.body.status) ? req.body.status : current.status
  };

  // DJ analysis is written by the iOS app after the DJ selects the matching
  // local audio file. Guests never need to submit these values themselves.
  if (Object.prototype.hasOwnProperty.call(req.body, "bpm")) {
    next.bpm = optionalFiniteNumber(req.body.bpm);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "musicalKey")) {
    next.musicalKey = req.body.musicalKey ? String(req.body.musicalKey).slice(0, 40) : null;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "bpmConfidence")) {
    next.bpmConfidence = optionalFiniteNumber(req.body.bpmConfidence);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "keyConfidence")) {
    next.keyConfidence = optionalFiniteNumber(req.body.keyConfidence);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "energyLevel")) {
    next.energyLevel = optionalFiniteNumber(req.body.energyLevel);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "vocalProbability")) {
    next.vocalProbability = optionalFiniteNumber(req.body.vocalProbability);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "trackHealthScore")) {
    next.trackHealthScore = optionalFiniteNumber(req.body.trackHealthScore);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "loudnessDB")) {
    next.loudnessDB = optionalFiniteNumber(req.body.loudnessDB);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "firstDropSeconds")) {
    next.firstDropSeconds = optionalFiniteNumber(req.body.firstDropSeconds);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "suggestedMixOutSeconds")) {
    next.suggestedMixOutSeconds = optionalFiniteNumber(req.body.suggestedMixOutSeconds);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "waveformSamples")) {
    next.waveformSamples = optionalWaveform(req.body.waveformSamples);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "analysisUpdatedAt")) {
    next.analysisUpdatedAt = req.body.analysisUpdatedAt || null;
  }

  const optionalStrings = [
    "catalogMatchTitle", "catalogMatchArtist", "catalogMatchURL",
    "libraryMatchTitle", "libraryMatchArtist", "libraryPersistentID",
    "autoAnalysisError", "analysisSource", "requestCatalogID", "requestArtworkURL",
    "requestStoreURL", "requestPreviewURL", "requestAlbum", "requestGenre",
    "publicStatusMessage", "djMetadataSource", "djMetadataURL", "djMetadataTitle", "djMetadataArtist"
  ];

  for (const key of optionalStrings) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      next[key] = req.body[key] == null ? null : String(req.body[key]).slice(0, 500);
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "estimatedMinutes")) {
    const value = optionalFiniteNumber(req.body.estimatedMinutes);
    next.estimatedMinutes = value == null ? null : Math.max(0, Math.min(360, Math.round(value)));
  }

  for (const key of ["catalogMatchScore", "libraryMatchScore", "djMetadataMatchScore"]) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      next[key] = optionalFiniteNumber(req.body[key]);
    }
  }

  const allowedAutoStates = new Set([
    "djMetadataSearching", "djMetadataMatched", "onlineSearching", "onlineAnalyzing", "onlineAnalyzed", "onlineUnavailable",
    "searching", "catalogMatched", "catalogOnly", "analyzing", "analyzed",
    "audioUnavailable", "noMatch", "permissionRequired", "failed"
  ]);

  if (Object.prototype.hasOwnProperty.call(req.body, "autoAnalysisState")) {
    next.autoAnalysisState = allowedAutoStates.has(req.body.autoAnalysisState)
      ? req.body.autoAnalysisState
      : null;
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "autoAnalysisAttemptedAt")) {
    next.autoAnalysisAttemptedAt = req.body.autoAnalysisAttemptedAt || null;
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "onlineAnalysisAttemptedAt")) {
    next.onlineAnalysisAttemptedAt = req.body.onlineAnalysisAttemptedAt || null;
  }

  rows[index] = next;
  writeStore(rows);
  res.json(sanitizeRowForClient(next));
});


// PRO SUITE: public event DNA / guest genre voting.
app.get("/api/events/:eventID/guest-state", (req, res) => {
  const state = getEventState(req.params.eventID);
  const musicDirection = cleanMusicDirection(state.musicDirection);
  const genreOptions = allowedGenreOptionsForState(state);
  const allowed = new Set(genreOptions.map(normalizeGenreLabel));
  const genreVotes = Object.entries(state.genreVotes || {})
    .filter(([genre]) => musicDirection === "openFormat" || allowed.has(normalizeGenreLabel(genre)))
    .map(([genre, votes]) => ({ genre, votes: Math.max(0, Number(votes || 0)) }))
    .sort((a, b) => b.votes - a.votes);

  const now = Date.now();
  const upcoming = cleanTimeline(state.timeline)
    .filter(item => !item.isDone && Number.isFinite(Date.parse(item.time)) && Date.parse(item.time) >= now - 15 * 60 * 1000)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .slice(0, 3);

  res.json({
    eventName: state.eventName || null,
    preferredGenres: arrayOfStrings(state.preferredGenres, 20, 80),
    musicDirection,
    musicDirectionLabel: musicDirectionLabel(musicDirection),
    genreOptions,
    genreVotes,
    upcoming
  });
});

app.get("/api/events/:eventID/music-direction", (req, res) => {
  const state = getEventState(req.params.eventID);
  const musicDirection = cleanMusicDirection(state.musicDirection);
  res.json({
    eventID: req.params.eventID,
    eventName: state.eventName || null,
    musicDirection,
    musicDirectionLabel: musicDirectionLabel(musicDirection),
    genreOptions: allowedGenreOptionsForState(state)
  });
});

app.put("/api/events/:eventID/music-direction", (req, res) => {
  const state = getEventState(req.params.eventID);
  const musicDirection = cleanMusicDirection(req.body.musicDirection);
  const genreOptions = musicDirection === "openFormat"
    ? allowedGenreOptionsForState({ ...state, musicDirection })
    : allowedGenreOptionsForState({ ...state, musicDirection });
  const allowed = new Set(genreOptions.map(normalizeGenreLabel));

  // When a DJ changes a formerly open event to a fixed format, obsolete crowd
  // votes are removed so the app/GuestWeb never shows contradictory results.
  const genreVotes = {};
  for (const [genre, votes] of Object.entries(state.genreVotes || {})) {
    if (musicDirection === "openFormat" || allowed.has(normalizeGenreLabel(genre))) {
      genreVotes[genre] = Math.max(0, Number(votes || 0));
    }
  }

  const genreVoterHashes = {};
  for (const [hash, genre] of Object.entries(state.genreVoterHashes || {})) {
    if (musicDirection === "openFormat" || allowed.has(normalizeGenreLabel(genre))) {
      genreVoterHashes[hash] = genre;
    }
  }

  const next = saveEventState(req.params.eventID, {
    ...state,
    eventName: String(req.body.eventName || state.eventName || "").trim().slice(0, 120) || null,
    musicDirection,
    genreVotes,
    genreVoterHashes
  });

  res.json({
    ok: true,
    eventID: req.params.eventID,
    eventName: next.eventName || null,
    musicDirection,
    musicDirectionLabel: musicDirectionLabel(musicDirection),
    genreOptions
  });
});

app.post("/api/events/:eventID/genre-vote", (req, res) => {
  const genre = String(req.body.genre || "").trim().slice(0, 80);
  const token = String(req.body.voterToken || "").trim();
  if (!genre || token.length < 8 || token.length > 160) {
    return res.status(400).json({ error: "genre and voterToken are required" });
  }

  const state = getEventState(req.params.eventID);
  const musicDirection = cleanMusicDirection(state.musicDirection);
  const allowedGenres = allowedGenreOptionsForState(state);
  const allowedGenre = allowedGenres.find(item =>
    normalizeGenreLabel(item) === normalizeGenreLabel(genre)
  );
  if (!allowedGenre) {
    return res.status(400).json({
      error: `Dieses Genre ist für das Eventformat ${musicDirectionLabel(musicDirection)} nicht freigegeben.`,
      musicDirection,
      genreOptions: allowedGenres
    });
  }

  const normalizedGenre = allowedGenre;
  const hash = hashVoterToken(token);
  const voterMap = state.genreVoterHashes && typeof state.genreVoterHashes === "object"
    ? state.genreVoterHashes : {};
  const genreVotes = state.genreVotes && typeof state.genreVotes === "object"
    ? state.genreVotes : {};

  const previous = voterMap[hash];
  if (previous === normalizedGenre) {
    return res.json({ ok: true, alreadyVoted: true, genre: normalizedGenre, votes: Math.max(0, Number(genreVotes[normalizedGenre] || 0)) });
  }
  if (previous && genreVotes[previous]) {
    genreVotes[previous] = Math.max(0, Number(genreVotes[previous]) - 1);
  }
  genreVotes[normalizedGenre] = Math.max(0, Number(genreVotes[normalizedGenre] || 0)) + 1;
  voterMap[hash] = normalizedGenre;

  saveEventState(req.params.eventID, {
    ...state,
    genreVotes,
    genreVoterHashes: voterMap
  });
  res.json({ ok: true, alreadyVoted: false, genre: normalizedGenre, votes: genreVotes[normalizedGenre] });
});

// Create/recover a capability URL that an event client can use to configure
// must-play, no-go and timeline information. The raw token is never stored.
app.post("/api/events/:eventID/client-portal", (req, res) => {
  const state = getEventState(req.params.eventID);
  const token = crypto.randomBytes(18).toString("base64url");
  const next = saveEventState(req.params.eventID, {
    ...state,
    eventName: String(req.body.eventName || state.eventName || "").trim().slice(0, 120) || null,
    clientPortalTokenHash: hashVoterToken(token)
  });
  res.status(201).json({
    ok: true,
    token,
    eventID: req.params.eventID,
    eventName: next.eventName
  });
});

app.get("/api/events/:eventID/client-plan", (req, res) => {
  const state = getEventState(req.params.eventID);
  if (!portalTokenMatches(state, req.query.token)) return res.status(403).json({ error: "invalid portal token" });
  res.json(cleanPortalState(state));
});

app.put("/api/events/:eventID/client-plan", (req, res) => {
  const state = getEventState(req.params.eventID);
  if (!portalTokenMatches(state, req.query.token)) return res.status(403).json({ error: "invalid portal token" });

  const next = saveEventState(req.params.eventID, {
    ...state,
    eventName: String(req.body.eventName || state.eventName || "").trim().slice(0, 120) || null,
    mustPlay: arrayOfStrings(req.body.mustPlay),
    doNotPlay: arrayOfStrings(req.body.doNotPlay),
    preferredGenres: arrayOfStrings(req.body.preferredGenres, 30, 80),
    timeline: cleanTimeline(req.body.timeline)
  });
  res.json(cleanPortalState(next));
});

// Shared played-track log for Multi-DJ / B2B handovers.
app.get("/api/events/:eventID/played", (req, res) => {
  const state = getEventState(req.params.eventID);
  res.json(Array.isArray(state.playedTracks) ? state.playedTracks.slice(0, 250) : []);
});

app.post("/api/events/:eventID/played", (req, res) => {
  const state = getEventState(req.params.eventID);
  const row = {
    id: String(req.body?.id || crypto.randomUUID()).slice(0, 80),
    title: String(req.body?.title || "").trim().slice(0, 160),
    artist: String(req.body?.artist || "").trim().slice(0, 160),
    startedAt: String(req.body?.startedAt || new Date().toISOString()).slice(0, 64),
    lastSeenAt: String(req.body?.lastSeenAt || new Date().toISOString()).slice(0, 64),
    bpm: optionalFiniteNumber(req.body?.bpm),
    musicalKey: req.body?.musicalKey ?? null,
    energyLevel: optionalFiniteNumber(req.body?.energyLevel),
    recognitionConfidence: optionalFiniteNumber(req.body?.recognitionConfidence)
  };
  if (!row.title) return res.status(400).json({ error: "title_required" });

  const list = Array.isArray(state.playedTracks) ? state.playedTracks.slice() : [];
  const key = normalizeRequestKey(row.artist, row.title);
  const existing = list.findIndex(item => normalizeRequestKey(item.artist, item.title) === key &&
    Math.abs(Date.parse(row.lastSeenAt) - Date.parse(item.lastSeenAt || item.startedAt || 0)) < 120000);
  if (existing >= 0) list[existing] = { ...list[existing], ...row, id: list[existing].id || row.id };
  else list.unshift(row);

  const next = saveEventState(req.params.eventID, { ...state, playedTracks: list.slice(0, 250) });
  res.json((next.playedTracks || [])[0] || row);
});

// Multi-DJ handover state. Event UUID is already a high-entropy capability ID
// and this endpoint intentionally contains no private guest details.
app.get("/api/events/:eventID/handover", (req, res) => {
  const state = getEventState(req.params.eventID);
  res.json(state.handover || null);
});

app.put("/api/events/:eventID/handover", (req, res) => {
  const state = getEventState(req.params.eventID);
  const handover = {
    djName: String(req.body.djName || "DJ").trim().slice(0, 80),
    currentTitle: String(req.body.currentTitle || "").trim().slice(0, 160) || null,
    currentArtist: String(req.body.currentArtist || "").trim().slice(0, 160) || null,
    bpm: optionalFiniteNumber(req.body.bpm),
    musicalKey: String(req.body.musicalKey || "").trim().slice(0, 40) || null,
    energy: optionalFiniteNumber(req.body.energy),
    note: String(req.body.note || "").trim().slice(0, 500),
    updatedAt: new Date().toISOString()
  };
  saveEventState(req.params.eventID, { ...state, handover });
  res.json(handover);
});


// V10 COMPLETE DJ OS ---------------------------------------------------------
function cleanAnnouncements(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).map(item => ({
    id: String(item?.id || crypto.randomUUID()).slice(0, 80),
    title: String(item?.title || "").trim().slice(0, 180),
    time: String(item?.time || new Date().toISOString()).slice(0, 64),
    note: String(item?.note || "").trim().slice(0, 400),
    completed: Boolean(item?.completed)
  })).filter(item => item.title);
}

function cleanBranding(value) {
  const hex = String(value?.accentHex || "22D3EE").replace(/[^0-9a-f]/gi, "").slice(0, 6) || "22D3EE";
  return {
    displayName: String(value?.displayName || "DJ TOOLKIT").trim().slice(0, 80) || "DJ TOOLKIT",
    accentHex: hex,
    footerText: String(value?.footerText || "Powered by DJ Toolkit").trim().slice(0, 140),
    customDomain: String(value?.customDomain || "").trim().slice(0, 180)
  };
}

function cleanTeam(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map(item => ({
    id: String(item?.id || crypto.randomUUID()).slice(0, 80),
    name: String(item?.name || "").trim().slice(0, 100),
    role: String(item?.role || "DJ").trim().slice(0, 60),
    email: String(item?.email || "").trim().slice(0, 160)
  })).filter(item => item.name);
}

app.get("/api/events/:eventID/remote-state", (req, res) => {
  const state = getEventState(req.params.eventID);
  res.set("Cache-Control", "no-store");
  res.json(state.remoteSnapshot || null);
});

app.put("/api/events/:eventID/remote-state", (req, res) => {
  const state = getEventState(req.params.eventID);
  const row = {
    eventID: req.params.eventID,
    deviceName: String(req.body?.deviceName || "Device").trim().slice(0, 100),
    bpm: optionalFiniteNumber(req.body?.bpm),
    musicalKey: String(req.body?.musicalKey || "").trim().slice(0, 50) || null,
    energy: optionalFiniteNumber(req.body?.energy),
    currentTrack: String(req.body?.currentTrack || "").trim().slice(0, 240) || null,
    requestCount: Math.max(0, Math.min(10000, Number(req.body?.requestCount || 0))),
    announcement: String(req.body?.announcement || "").trim().slice(0, 180) || null,
    updatedAt: new Date().toISOString()
  };
  saveEventState(req.params.eventID, { ...state, remoteSnapshot: row });
  res.json(row);
});

app.get("/api/events/:eventID/announcements", (req, res) => {
  const state = getEventState(req.params.eventID);
  res.json(cleanAnnouncements(state.announcements));
});

app.put("/api/events/:eventID/announcements", (req, res) => {
  const state = getEventState(req.params.eventID);
  const rows = cleanAnnouncements(req.body);
  saveEventState(req.params.eventID, { ...state, announcements: rows });
  res.json(rows);
});

app.get("/api/events/:eventID/branding", (req, res) => {
  const state = getEventState(req.params.eventID);
  res.json(cleanBranding(state.branding));
});

app.put("/api/events/:eventID/branding", (req, res) => {
  const state = getEventState(req.params.eventID);
  const branding = cleanBranding(req.body);
  saveEventState(req.params.eventID, { ...state, branding });
  res.json(branding);
});

app.get("/api/events/:eventID/team", (req, res) => {
  const state = getEventState(req.params.eventID);
  res.json(cleanTeam(state.team));
});

app.put("/api/events/:eventID/team", (req, res) => {
  const state = getEventState(req.params.eventID);
  const team = cleanTeam(req.body);
  saveEventState(req.params.eventID, { ...state, team });
  res.json(team);
});


initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`DJToolkit request server running on http://localhost:${port}`);
      console.log(`Persistent database: ${db ? "Postgres" : "local JSON fallback"}`);
    });
  })
  .catch(error => {
    console.error("Database initialization failed", error);
    process.exit(1);
  });
