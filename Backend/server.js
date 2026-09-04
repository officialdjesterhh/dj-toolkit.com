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
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

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

app.get("/health", (_, res) => {
  res.json({ ok: true });
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
    requestCatalogID: String(req.body.catalogID || "").trim().slice(0, 80) || null,
    requestArtworkURL: cleanURL(req.body.catalogArtworkURL),
    requestStoreURL: cleanURL(req.body.catalogStoreURL),
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
    "autoAnalysisError", "requestCatalogID", "requestArtworkURL",
    "requestStoreURL", "requestAlbum"
  ];

  for (const key of optionalStrings) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      next[key] = req.body[key] == null ? null : String(req.body[key]).slice(0, 500);
    }
  }

  for (const key of ["catalogMatchScore", "libraryMatchScore"]) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      next[key] = optionalFiniteNumber(req.body[key]);
    }
  }

  const allowedAutoStates = new Set([
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

  rows[index] = next;
  writeStore(rows);
  res.json(next);
});

app.listen(port, () => {
  console.log(`DJToolkit request server running on http://localhost:${port}`);
});
