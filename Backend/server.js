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

  const searchHTML = await fetchTextWithTimeout(searchURL, 7000);
  const links = [];
  const seen = new Set();
  const regex = /href=["'](\/track\/[^"'?#]+\/\d+)["']/gi;
  let match;

  while ((match = regex.exec(searchHTML)) && links.length < 6) {
    const relative = decodeHTMLEntities(match[1]);
    if (!seen.has(relative)) {
      seen.add(relative);
      links.push(`https://www.beatport.com${relative}`);
    }
  }

  if (!links.length) return null;

  let best = null;
  for (const trackURL of links.slice(0, 5)) {
    try {
      const html = await fetchTextWithTimeout(trackURL, 6000);
      const candidate = parseBeatportTrackPage(html, trackURL);
      if (!candidate) continue;

      const score = djMatchScore(title, artist, candidate.title, candidate.artist);
      if (score >= 0.68 && (!best || score > best.matchScore)) {
        best = { ...candidate, matchScore: score };
      }
    } catch (error) {
      console.warn("Beatport candidate lookup failed", error?.message || error);
    }
  }
  return best;
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
  try {
    value = await lookupBeatportMetadata(artist, title);
  } catch (error) {
    console.warn("Beatport metadata lookup unavailable", error?.message || error);
  }

  if (!value) {
    try {
      value = await lookupGetSongBPMMetadata(artist, title);
    } catch (error) {
      console.warn("GetSongBPM metadata lookup unavailable", error?.message || error);
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
    version: "7.8",
    onlineAnalysis: true,
    catalogPreviewAudio: true,
    djMetadata: true,
    djMetadataProviders: process.env.GETSONGBPM_API_KEY ? ["Beatport", "GetSongBPM"] : ["Beatport"]
  });
});

app.get("/api/events/:eventID/requests", (req, res) => {
  const rows = readStore()
    .filter(row => row.eventID === req.params.eventID)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(rows);
});

app.get("/api/events/:eventID/public-summary", (req, res) => {
  const rows = readStore().filter(row =>
    row.eventID === req.params.eventID && row.status !== "declined"
  );

  const counts = new Map();
  for (const row of rows) {
    const key = `${String(row.artist).trim().toLowerCase()}::${String(row.title).trim().toLowerCase()}`;
    const current = counts.get(key) || {
      artist: row.artist,
      title: row.title,
      count: 0
    };
    current.count += 1;
    counts.set(key, current);
  }

  const topRequests = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 8);

  res.json({ requestCount: rows.length, topRequests });
});

app.get("/api/requests/:requestID/public", (req, res) => {
  const row = readStore().find(item => item.id === req.params.requestID);
  if (!row) return res.status(404).json({ error: "not found" });

  res.json({
    id: row.id,
    artist: row.artist,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt
  });
});

app.post("/api/events/:eventID/requests", (req, res) => {
  const artist = String(req.body.artist || "").trim();
  const title = String(req.body.title || "").trim();
  const honeypot = String(req.body.website || "").trim();

  if (honeypot) {
    return res.status(201).json({
      id: crypto.randomUUID(),
      eventID: req.params.eventID,
      artist,
      title,
      status: "new",
      createdAt: new Date().toISOString()
    });
  }

  if (!artist || !title) {
    return res.status(400).json({ error: "artist and title are required" });
  }

  const row = {
    id: crypto.randomUUID(),
    eventID: req.params.eventID,
    artist: artist.slice(0, 120),
    title: title.slice(0, 120),
    guestName: String(req.body.guestName || "").trim().slice(0, 80) || null,
    message: String(req.body.message || "").trim().slice(0, 300) || null,
    createdAt: new Date().toISOString(),
    status: "new",
    bpm: null,
    musicalKey: null,
    bpmConfidence: null,
    keyConfidence: null,
    energyLevel: null,
    waveformSamples: null,
    analysisUpdatedAt: null,
    catalogMatchTitle: null,
    catalogMatchArtist: null,
    catalogMatchURL: null,
    catalogMatchScore: null,
    libraryMatchTitle: null,
    libraryMatchArtist: null,
    libraryMatchScore: null,
    libraryPersistentID: null,
    autoAnalysisState: null,
    autoAnalysisAttemptedAt: null,
    autoAnalysisError: null,
    analysisSource: null,
    onlineAnalysisAttemptedAt: null,
    djMetadataSource: null,
    djMetadataURL: null,
    djMetadataTitle: null,
    djMetadataArtist: null,
    djMetadataMatchScore: null,
    requestCatalogID: String(req.body.catalogID || "").trim().slice(0, 80) || null,
    requestArtworkURL: cleanURL(req.body.catalogArtworkURL),
    requestStoreURL: cleanURL(req.body.catalogStoreURL),
    requestPreviewURL: cleanURL(req.body.catalogPreviewURL),
    requestAlbum: String(req.body.catalogAlbum || "").trim().slice(0, 180) || null
  };

  const rows = readStore();
  rows.push(row);
  writeStore(rows);

  res.status(201).json(row);
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
    "requestStoreURL", "requestPreviewURL", "requestAlbum", "djMetadataSource",
    "djMetadataURL", "djMetadataTitle", "djMetadataArtist"
  ];

  for (const key of optionalStrings) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      next[key] = req.body[key] == null ? null : String(req.body[key]).slice(0, 500);
    }
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
  res.json(next);
});

app.listen(port, () => {
  console.log(`DJToolkit request server running on http://localhost:${port}`);
});
