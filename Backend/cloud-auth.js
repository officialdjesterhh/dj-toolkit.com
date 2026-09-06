import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
const scryptAsync = promisify(crypto.scrypt);
let appleJWKSCache = { fetchedAt: 0, keys: [] };

function decodeJWTPart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function verifyAppleIdentityToken(rawToken, audience) {
  const parts = String(rawToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed Apple token");
  const header = decodeJWTPart(parts[0]);
  const payload = decodeJWTPart(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported Apple token algorithm");

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== "https://appleid.apple.com") throw new Error("invalid Apple issuer");
  if (!audiences.includes(audience)) throw new Error("invalid Apple audience");
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= now) throw new Error("expired Apple token");
  if (Number.isFinite(Number(payload.iat)) && Number(payload.iat) > now + 300) throw new Error("invalid Apple issued-at time");

  if (!appleJWKSCache.keys.length || Date.now() - appleJWKSCache.fetchedAt > 6 * 60 * 60 * 1000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("https://appleid.apple.com/auth/keys", { signal: controller.signal });
      if (!response.ok) throw new Error(`Apple JWKS status ${response.status}`);
      const body = await response.json();
      appleJWKSCache = { fetchedAt: Date.now(), keys: Array.isArray(body.keys) ? body.keys : [] };
    } finally { clearTimeout(timeout); }
  }

  const jwk = appleJWKSCache.keys.find(item => item.kid === header.kid && item.kty === "RSA");
  if (!jwk) throw new Error("Apple signing key not found");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");
  if (!crypto.verify("RSA-SHA256", signed, key, signature)) throw new Error("invalid Apple token signature");
  return payload;
}

export function installCloudAuth({ app, db, storageDir, publicBaseURL, sendEmail }) {
  const localPath = path.resolve(storageDir, "cloud-auth.json");
  const sessionDays = Math.max(1, Math.min(180, Number(process.env.CLOUD_SESSION_DAYS || 30)));
  const resetMinutes = Math.max(10, Math.min(180, Number(process.env.PASSWORD_RESET_MINUTES || 30)));

  function emptyStore() { return { accounts: [], sessions: [], resets: [], snapshots: {} }; }
  function readLocal() {
    try {
      if (!fs.existsSync(localPath)) return emptyStore();
      const value = JSON.parse(fs.readFileSync(localPath, "utf8"));
      return { ...emptyStore(), ...(value && typeof value === "object" ? value : {}) };
    } catch { return emptyStore(); }
  }
  function writeLocal(value) { fs.writeFileSync(localPath, JSON.stringify(value, null, 2)); }
  function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
  function normalizeEmail(value) { return String(value || "").trim().toLowerCase().slice(0, 320); }
  function safeName(value) { return String(value || "").trim().slice(0, 120) || null; }
  function nowISO() { return new Date().toISOString(); }
  function expiresISO(ms) { return new Date(Date.now() + ms).toISOString(); }
  function accountPublic(account) {
    return account ? { id: account.id, email: account.email || null, name: account.name || null, provider: account.appleSub ? "apple" : "email" } : null;
  }

  async function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
    const derived = await scryptAsync(password, salt, 64);
    return { salt, digest: Buffer.from(derived).toString("hex") };
  }
  async function passwordMatches(password, salt, expectedHex) {
    if (!salt || !expectedHex) return false;
    const { digest } = await passwordHash(password, salt);
    const a = Buffer.from(digest, "hex"), b = Buffer.from(expectedHex, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function rowToAccount(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.password_hash,
      passwordSalt: row.password_salt,
      appleSub: row.apple_sub,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    };
  }

  async function findAccountByEmail(email) {
    if (!db) return readLocal().accounts.find(item => item.email === email) || null;
    const result = await db.query("SELECT * FROM dj_accounts WHERE email=$1 LIMIT 1", [email]);
    return rowToAccount(result.rows?.[0]);
  }
  async function findAccountByAppleSub(sub) {
    if (!db) return readLocal().accounts.find(item => item.appleSub === sub) || null;
    const result = await db.query("SELECT * FROM dj_accounts WHERE apple_sub=$1 LIMIT 1", [sub]);
    return rowToAccount(result.rows?.[0]);
  }
  async function findAccountByID(id) {
    if (!db) return readLocal().accounts.find(item => item.id === id) || null;
    const result = await db.query("SELECT * FROM dj_accounts WHERE id=$1 LIMIT 1", [id]);
    return rowToAccount(result.rows?.[0]);
  }
  async function createEmailAccount({ email, name, password }) {
    const pwd = await passwordHash(password);
    const account = { id: crypto.randomUUID(), email, name: safeName(name), passwordHash: pwd.digest, passwordSalt: pwd.salt, appleSub: null, createdAt: nowISO(), updatedAt: nowISO() };
    if (!db) {
      const store = readLocal(); store.accounts.push(account); writeLocal(store); return account;
    }
    const result = await db.query(`INSERT INTO dj_accounts (id,email,name,password_hash,password_salt,apple_sub,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,NULL,NOW(),NOW()) RETURNING *`, [account.id, account.email, account.name, account.passwordHash, account.passwordSalt]);
    return rowToAccount(result.rows[0]);
  }
  async function createAppleAccount({ email, name, sub }) {
    const account = { id: crypto.randomUUID(), email: email || null, name: safeName(name), passwordHash: null, passwordSalt: null, appleSub: sub, createdAt: nowISO(), updatedAt: nowISO() };
    if (!db) { const store=readLocal(); store.accounts.push(account); writeLocal(store); return account; }
    const result = await db.query(`INSERT INTO dj_accounts (id,email,name,password_hash,password_salt,apple_sub,created_at,updated_at) VALUES ($1,$2,$3,NULL,NULL,$4,NOW(),NOW()) RETURNING *`, [account.id, account.email, account.name, account.appleSub]);
    return rowToAccount(result.rows[0]);
  }
  async function linkApple(account, sub, email, name) {
    if (!db) {
      const store=readLocal(); const row=store.accounts.find(item=>item.id===account.id); if (!row) return account;
      row.appleSub=sub; if (!row.email && email) row.email=email; if (!row.name && name) row.name=safeName(name); row.updatedAt=nowISO(); writeLocal(store); return row;
    }
    const result = await db.query(`UPDATE dj_accounts SET apple_sub=$2,email=COALESCE(email,$3),name=COALESCE(name,$4),updated_at=NOW() WHERE id=$1 RETURNING *`, [account.id, sub, email || null, safeName(name)]);
    return rowToAccount(result.rows[0]);
  }
  async function updatePassword(accountID, password) {
    const pwd=await passwordHash(password);
    if (!db) { const store=readLocal(); const a=store.accounts.find(x=>x.id===accountID); if(!a)return; a.passwordHash=pwd.digest;a.passwordSalt=pwd.salt;a.updatedAt=nowISO();writeLocal(store);return; }
    await db.query("UPDATE dj_accounts SET password_hash=$2,password_salt=$3,updated_at=NOW() WHERE id=$1", [accountID,pwd.digest,pwd.salt]);
  }

  async function issueSession(accountID) {
    const token=crypto.randomBytes(36).toString("base64url"), tokenHash=hash(token), expiresAt=expiresISO(sessionDays*86400000);
    if (!db) { const store=readLocal(); store.sessions=store.sessions.filter(x=>new Date(x.expiresAt)>new Date()); store.sessions.push({tokenHash,accountID,expiresAt,createdAt:nowISO()}); writeLocal(store); }
    else await db.query("INSERT INTO dj_sessions (token_hash,account_id,expires_at,created_at) VALUES ($1,$2,$3,NOW())", [tokenHash,accountID,expiresAt]);
    return token;
  }
  async function sessionAccount(rawToken) {
    const tokenHash=hash(rawToken);
    if (!db) {
      const store=readLocal(); const session=store.sessions.find(x=>x.tokenHash===tokenHash && new Date(x.expiresAt)>new Date()); if(!session)return null;
      return store.accounts.find(x=>x.id===session.accountID) || null;
    }
    const result=await db.query(`SELECT a.* FROM dj_sessions s JOIN dj_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>NOW() LIMIT 1`,[tokenHash]);
    return rowToAccount(result.rows?.[0]);
  }
  async function deleteSession(rawToken) {
    const tokenHash=hash(rawToken);
    if(!db){const store=readLocal();store.sessions=store.sessions.filter(x=>x.tokenHash!==tokenHash);writeLocal(store);return;}
    await db.query("DELETE FROM dj_sessions WHERE token_hash=$1",[tokenHash]);
  }

  async function requireAccount(req,res) {
    const auth=String(req.headers.authorization||"");
    const token=auth.startsWith("Bearer ")?auth.slice(7).trim():"";
    if(!token){res.status(401).json({error:"authentication required"});return null;}
    const account=await sessionAccount(token);
    if(!account){res.status(401).json({error:"session expired"});return null;}
    return {account,token};
  }

  async function createReset(accountID) {
    const token=crypto.randomBytes(32).toString("base64url"), tokenHash=hash(token), expiresAt=expiresISO(resetMinutes*60000);
    if(!db){const store=readLocal();store.resets=store.resets.filter(x=>new Date(x.expiresAt)>new Date()&&!x.usedAt);store.resets.push({tokenHash,accountID,expiresAt,usedAt:null,createdAt:nowISO()});writeLocal(store);}
    else await db.query("INSERT INTO dj_password_resets (token_hash,account_id,expires_at,created_at) VALUES ($1,$2,$3,NOW())",[tokenHash,accountID,expiresAt]);
    return token;
  }
  async function consumeReset(rawToken) {
    const tokenHash=hash(rawToken);
    if(!db){const store=readLocal();const row=store.resets.find(x=>x.tokenHash===tokenHash&&!x.usedAt&&new Date(x.expiresAt)>new Date());if(!row)return null;row.usedAt=nowISO();writeLocal(store);return row.accountID;}
    const result=await db.query(`UPDATE dj_password_resets SET used_at=NOW() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() RETURNING account_id`,[tokenHash]);
    return result.rows?.[0]?.account_id || null;
  }

  async function getSnapshot(accountID) {
    if(!db){const row=readLocal().snapshots?.[accountID];return row||{version:0,snapshot:null,updatedAt:null};}
    const result=await db.query("SELECT version,snapshot,updated_at FROM dj_cloud_snapshots WHERE account_id=$1 LIMIT 1",[accountID]);
    const row=result.rows?.[0];return row?{version:Number(row.version)||0,snapshot:row.snapshot,updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():row.updated_at}:{version:0,snapshot:null,updatedAt:null};
  }
  async function putSnapshot(accountID,snapshot,expectedVersion) {
    if(!db){const store=readLocal();const current=store.snapshots?.[accountID]||{version:0};if(expectedVersion!=null&&Number(expectedVersion)!==Number(current.version||0))return null;const next={version:Number(current.version||0)+1,snapshot,updatedAt:nowISO()};store.snapshots=store.snapshots||{};store.snapshots[accountID]=next;writeLocal(store);return next;}
    const client=await db.connect();
    try{await client.query("BEGIN");const current=await client.query("SELECT version FROM dj_cloud_snapshots WHERE account_id=$1 FOR UPDATE",[accountID]);const version=Number(current.rows?.[0]?.version||0);if(expectedVersion!=null&&Number(expectedVersion)!==version){await client.query("ROLLBACK");return null;}const nextVersion=version+1;const result=await client.query(`INSERT INTO dj_cloud_snapshots (account_id,version,snapshot,updated_at) VALUES ($1,$2,$3::jsonb,NOW()) ON CONFLICT (account_id) DO UPDATE SET version=EXCLUDED.version,snapshot=EXCLUDED.snapshot,updated_at=NOW() RETURNING version,updated_at`,[accountID,nextVersion,JSON.stringify(snapshot)]);await client.query("COMMIT");return{version:Number(result.rows[0].version),snapshot,updatedAt:result.rows[0].updated_at instanceof Date?result.rows[0].updated_at.toISOString():result.rows[0].updated_at};}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }

  app.post("/api/auth/register", async (req,res)=>{
    try{
      const email=normalizeEmail(req.body.email), password=String(req.body.password||"");
      if(!email.includes("@"))return res.status(400).json({error:"valid email required"});
      if(password.length<10||password.length>128)return res.status(400).json({error:"password must be 10-128 characters"});
      if(await findAccountByEmail(email))return res.status(409).json({error:"account already exists"});
      const account=await createEmailAccount({email,name:req.body.name,password});const token=await issueSession(account.id);res.status(201).json({token,account:accountPublic(account)});
    }catch(error){console.error("register failed",error);res.status(500).json({error:"account creation failed"});}
  });

  app.post("/api/auth/login", async (req,res)=>{
    try{const email=normalizeEmail(req.body.email),password=String(req.body.password||"");const account=await findAccountByEmail(email);if(!account||!await passwordMatches(password,account.passwordSalt,account.passwordHash))return res.status(401).json({error:"invalid email or password"});const token=await issueSession(account.id);res.json({token,account:accountPublic(account)});}catch(error){console.error("login failed",error);res.status(500).json({error:"login failed"});}
  });

  app.post("/api/auth/apple", async (req,res)=>{
    try{
      const audience=String(process.env.APPLE_CLIENT_ID||"").trim();if(!audience)return res.status(503).json({error:"APPLE_CLIENT_ID is not configured"});
      const raw=String(req.body.identityToken||"");if(!raw)return res.status(400).json({error:"identityToken required"});
      const payload=await verifyAppleIdentityToken(raw,audience);
      const sub=String(payload.sub||"");if(!sub)return res.status(401).json({error:"invalid Apple identity"});
      const email=normalizeEmail(payload.email||req.body.email)||null;const name=safeName(req.body.fullName);
      let account=await findAccountByAppleSub(sub);
      if(!account&&email)account=await findAccountByEmail(email);
      if(account&&!account.appleSub)account=await linkApple(account,sub,email,name);
      if(!account)account=await createAppleAccount({email,name,sub});
      const token=await issueSession(account.id);res.json({token,account:accountPublic(account)});
    }catch(error){console.warn("apple auth failed",error?.message||error);res.status(401).json({error:"Apple sign-in verification failed"});}
  });

  app.get("/api/auth/me", async (req,res)=>{try{const auth=await requireAccount(req,res);if(!auth)return;res.json(accountPublic(auth.account));}catch(error){res.status(500).json({error:"account lookup failed"});}});
  app.post("/api/auth/logout", async (req,res)=>{try{const auth=String(req.headers.authorization||"");const token=auth.startsWith("Bearer ")?auth.slice(7).trim():"";if(token)await deleteSession(token);res.json({ok:true});}catch{res.json({ok:true});}});

  app.post("/api/auth/password-reset/request", async (req,res)=>{
    try{
      const email=normalizeEmail(req.body.email);const account=email?await findAccountByEmail(email):null;
      if(account&&account.email){const token=await createReset(account.id);const base=String(publicBaseURL||process.env.PUBLIC_BASE_URL||"https://dj-toolkit.com").replace(/\/$/,"");const link=`${base}/reset-password.html?token=${encodeURIComponent(token)}`;const fromAddress=String(process.env.FEEDBACK_FROM||"info@dj-toolkit.com").trim();const fromName=String(process.env.FEEDBACK_FROM_NAME||"DJ Toolkit").trim();try{await sendEmail({from:`${fromName} <${fromAddress}>`,to:[account.email],subject:"DJ Toolkit · Passwort zurücksetzen",html:`<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#060912;color:#fff;padding:32px"><h1>Passwort zurücksetzen</h1><p style="color:#b9c4d8">Der Link ist ${resetMinutes} Minuten gültig.</p><p><a style="color:#68dcff" href="${link}">Neues Passwort festlegen</a></p><p style="color:#728098;font-size:12px">Falls du das nicht angefordert hast, ignoriere diese E-Mail.</p></div>`});}catch(error){console.warn("password reset email failed",error?.message||error);}}
      res.json({ok:true});
    }catch(error){console.error("password reset request failed",error);res.json({ok:true});}
  });

  app.post("/api/auth/password-reset/complete", async (req,res)=>{
    try{const password=String(req.body.password||""),token=String(req.body.token||"");if(password.length<10||password.length>128)return res.status(400).json({error:"password must be 10-128 characters"});const accountID=await consumeReset(token);if(!accountID)return res.status(400).json({error:"reset link is invalid or expired"});await updatePassword(accountID,password);res.json({ok:true});}catch(error){console.error("password reset complete failed",error);res.status(500).json({error:"password reset failed"});}
  });

  app.get("/api/cloud/snapshot", async (req,res)=>{try{const auth=await requireAccount(req,res);if(!auth)return;res.set("Cache-Control","no-store");res.json(await getSnapshot(auth.account.id));}catch(error){console.error("cloud get failed",error);res.status(500).json({error:"cloud read failed"});}});
  app.put("/api/cloud/snapshot", async (req,res)=>{try{const auth=await requireAccount(req,res);if(!auth)return;const snapshot=req.body?.snapshot;if(!snapshot||typeof snapshot!=="object")return res.status(400).json({error:"snapshot required"});const serialized=JSON.stringify(snapshot);if(Buffer.byteLength(serialized)>1_500_000)return res.status(413).json({error:"snapshot too large"});const result=await putSnapshot(auth.account.id,snapshot,req.body?.expectedVersion);if(!result)return res.status(409).json({error:"cloud version conflict"});res.json({version:result.version,updatedAt:result.updatedAt});}catch(error){console.error("cloud put failed",error);res.status(500).json({error:"cloud write failed"});}});

  return {
    async init() {
      if(!db)return;
      await db.query(`
        CREATE TABLE IF NOT EXISTS dj_accounts (
          id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, password_hash TEXT, password_salt TEXT,
          apple_sub TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS dj_sessions (
          token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES dj_accounts(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS dj_sessions_account_idx ON dj_sessions(account_id);
        CREATE TABLE IF NOT EXISTS dj_password_resets (
          token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES dj_accounts(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS dj_cloud_snapshots (
          account_id TEXT PRIMARY KEY REFERENCES dj_accounts(id) ON DELETE CASCADE,
          version INTEGER NOT NULL DEFAULT 0, snapshot JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await db.query("DELETE FROM dj_sessions WHERE expires_at < NOW()");
      await db.query("DELETE FROM dj_password_resets WHERE expires_at < NOW() OR used_at IS NOT NULL");
    }
  };
}
