import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";

const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, "../GuestWeb");
const storePath = path.resolve(__dirname, "requests.json");
const eventStatePath = path.resolve(__dirname, "events.json");
const requestRateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 12;

const catalogSearchCache = new Map();
const djMetadataCache = new Map();
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const DJ_METADATA_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(webDir));

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

app.get("/health", (_, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    version: "10.0",
    onlineAnalysis: true,
    catalogPreviewAudio: true,
    djMetadata: true,
    requestVoting: true,
    duplicateConsolidation: true,
    guestGenreVoting: true,
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

app.get("/api/events/:eventID/requests", (req, res) => {
  const rows = readStore()
    .filter(row => row.eventID === req.params.eventID)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(rows.map(sanitizeRowForClient));
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
    publicStatusMessage: row.publicStatusMessage || null
  });
});

app.post("/api/events/:eventID/requests", (req, res) => {
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
    requestGenre: String(req.body.catalogGenre || "").trim().slice(0, 100) || null,
    estimatedMinutes: null,
    publicStatusMessage: "In der DJ Queue"
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
  const genreVotes = Object.entries(state.genreVotes || {})
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
    genreVotes,
    upcoming
  });
});

app.post("/api/events/:eventID/genre-vote", (req, res) => {
  const genre = String(req.body.genre || "").trim().slice(0, 80);
  const token = String(req.body.voterToken || "").trim();
  if (!genre || token.length < 8 || token.length > 160) {
    return res.status(400).json({ error: "genre and voterToken are required" });
  }

  const state = getEventState(req.params.eventID);
  const hash = hashVoterToken(token);
  const voterMap = state.genreVoterHashes && typeof state.genreVoterHashes === "object"
    ? state.genreVoterHashes : {};
  const genreVotes = state.genreVotes && typeof state.genreVotes === "object"
    ? state.genreVotes : {};

  const previous = voterMap[hash];
  if (previous === genre) {
    return res.json({ ok: true, alreadyVoted: true, genre, votes: Math.max(0, Number(genreVotes[genre] || 0)) });
  }
  if (previous && genreVotes[previous]) {
    genreVotes[previous] = Math.max(0, Number(genreVotes[previous]) - 1);
  }
  genreVotes[genre] = Math.max(0, Number(genreVotes[genre] || 0)) + 1;
  voterMap[hash] = genre;

  saveEventState(req.params.eventID, {
    ...state,
    genreVotes,
    genreVoterHashes: voterMap
  });
  res.json({ ok: true, alreadyVoted: false, genre, votes: genreVotes[genre] });
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


app.listen(port, () => {
  console.log(`DJToolkit request server running on http://localhost:${port}`);
});
