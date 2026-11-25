import express from "express";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

dotenv.config({ override: true });

const _dirname = typeof __dirname !== "undefined" ? __dirname : process.cwd();

// In-memory store for generated permit images to allow public access via Twilio or sharing links
const permitCache = new Map<string, { base64: string; name: string; createdAt: number }>();

// In-memory store for email dispatch and open tracking
export interface EmailTrackingRecord {
  trackingId: string;
  recordKey: string;
  vrm: string;
  email: string;
  voucherCode: string;
  status: "PREPARED" | "SENT" | "OPENED";
  preparedAt?: string;
  sentAt?: string;
  openedAt?: string;
  openCount: number;
  ip?: string;
  userAgent?: string;
  subject?: string;
}

const emailTrackingStore = new Map<string, EmailTrackingRecord>();

// 1x1 transparent RGBA PNG buffer
const TRANSPARENT_1X1_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

const DEFAULT_SEED_BLOCKLIST = [
  {
    id: "blk_seed_1",
    formId: "1311",
    hospitalSite: "Whipps Cross Hospital",
    wardDept: "Emergency Care",
    dateRequired: "2025-05-10",
    vrm: "AU67 HCZ",
    driverName: "Sarah Connor",
    phone: "07700900123",
    email: "s.connor@example.com",
    voucherCode: "BLOCKED",
    reason: "Duplicate permit abuse / multiple simultaneous active vehicles",
    addedAt: "2025-05-10T08:00:00.000Z"
  }
];

function normalizeVrmValue(vrm?: string | null): string {
  return String(vrm || "").replace(/\s+/g, "").toUpperCase();
}

function isPlainObject(val: unknown): val is Record<string, any> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function isNonEmptyString(val: unknown, maxLen = 500): val is string {
  return typeof val === "string" && val.trim().length > 0 && val.length <= maxLen;
}

function sanitizeOptionalString(val: unknown, maxLen = 500): string | null {
  if (val === undefined || val === null) return null;
  if (typeof val !== "string" && typeof val !== "number") return null;
  const s = String(val).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

const PERMIT_ALLOWED_COLUMNS = new Set([
  "id",
  "hospital",
  "ward",
  "date_required",
  "date_expiry",
  "vrm",
  "driver_name",
  "phone",
  "email",
  "voucher_code",
  "replacement_code",
  "original_voucher_code",
  "pre_cancel_voucher_code",
  "start_time",
  "completion_time",
  "cancellation_reason"
]);

function sanitizePermitPayload(raw: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
  for (const key of Object.keys(raw)) {
    if (PERMIT_ALLOWED_COLUMNS.has(key)) {
      clean[key] = raw[key] === undefined ? null : raw[key];
    }
  }
  return clean;
}

function timingSafeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeIp(raw?: string | null): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  // Strip IPv6 brackets if present
  if (s.startsWith("[") && s.endsWith("]")) {
    s = s.slice(1, -1);
  }
  // Strip zone identifier (e.g. %eth0)
  const zoneIdx = s.indexOf("%");
  if (zoneIdx !== -1) {
    s = s.slice(0, zoneIdx);
  }
  // Unwrap IPv4-mapped IPv6 addresses (::ffff:127.0.0.1)
  if (s.toLowerCase().startsWith("::ffff:")) {
    s = s.slice(7);
  }
  return s.toLowerCase();
}

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const oct = Number(part);
    if (oct < 0 || oct > 255) return null;
    num = ((num << 8) | oct) >>> 0;
  }
  return num >>> 0;
}

function matchIpv4Cidr(ip: string, cidr: string): boolean {
  const ipNum = ipv4ToUint32(ip);
  if (ipNum === null) return false;
  const [netStr, prefixStr] = cidr.split("/");
  const netNum = ipv4ToUint32(netStr);
  if (netNum === null) return false;
  const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((netNum & mask) >>> 0);
}

function isLoopbackOrPrivateIp(ip: string): boolean {
  if (!ip) return false;
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  // IPv6 Unique Local Addresses fc00::/7 (fc.. or fd..)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return (
    matchIpv4Cidr(ip, "127.0.0.0/8") ||
    matchIpv4Cidr(ip, "10.0.0.0/8") ||
    matchIpv4Cidr(ip, "172.16.0.0/12") ||
    matchIpv4Cidr(ip, "192.168.0.0/16")
  );
}

function isIpInCidrList(ip: string, cidrs: string[]): boolean {
  if (!ip || cidrs.length === 0) return false;
  for (const rawCidr of cidrs) {
    const entry = normalizeIp(rawCidr);
    if (!entry) continue;
    if (entry.includes(":")) {
      // Exact IPv6 match or ::1/128
      const base = entry.split("/")[0];
      if (ip === base) return true;
    } else if (matchIpv4Cidr(ip, entry)) {
      return true;
    }
  }
  return false;
}

function verifyTrustedGatewayHeader(req: express.Request, configuredSpec: string): boolean {
  if (!configuredSpec) return false;
  const eqIdx = configuredSpec.indexOf("=");
  const colonIdx = configuredSpec.indexOf(":");
  const sepIdx = eqIdx !== -1 ? eqIdx : colonIdx;

  if (sepIdx > 0) {
    const headerName = configuredSpec.slice(0, sepIdx).trim().toLowerCase();
    const expectedValue = configuredSpec.slice(sepIdx + 1).trim();
    const actualValue = req.get(headerName);
    if (!actualValue || !expectedValue) return false;
    return timingSafeMatch(actualValue.trim(), expectedValue);
  }

  const headerName = configuredSpec.trim().toLowerCase();
  const actualValue = req.get(headerName);
  return Boolean(actualValue && actualValue.trim().length > 0);
}

export interface CreateAppOptions {
  adminSecret?: string;
  supabaseClient?: SupabaseClient | any;
  nodeEnv?: string;
  supabaseServiceRoleKey?: string;
  trustedProxyCidrs?: string;
  trustedGatewayHeader?: string;
  vercelRuntime?: boolean;
  resolveRemoteAddress?: (req: express.Request) => string | undefined;
}

export function createApiApp(options: CreateAppOptions = {}) {
  const app = express();

  // Increase payload limit for base64 images and large spreadsheets
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  const effectiveNodeEnv = (options.nodeEnv ?? process.env.NODE_ENV ?? "development").trim();
  const configuredServiceRoleKey = (options.supabaseServiceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  if (effectiveNodeEnv === "production" && !options.supabaseClient && !configuredServiceRoleKey) {
    throw new Error("FATAL: SUPABASE_SERVICE_ROLE_KEY must be configured when NODE_ENV=production.");
  }

  const configuredSecret = (options.adminSecret ?? process.env.ADMIN_API_SECRET ?? "").trim();
  const trustedProxyCidrs = String(options.trustedProxyCidrs ?? process.env.TRUSTED_PROXY_CIDRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const trustedGatewayHeader = String(options.trustedGatewayHeader ?? process.env.TRUSTED_GATEWAY_HEADER ?? "").trim();
  const isVercelRuntime = options.vercelRuntime ?? (process.env.VERCEL === "1");

  let warnedMissingServiceRole = false;
  const getAdminSupabaseClient = (): any => {
    if (options.supabaseClient) {
      return options.supabaseClient;
    }
    if (effectiveNodeEnv === "production" && !configuredServiceRoleKey) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required in production.");
    }
    const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://ihhkitfpjmhudyzdhlpg.supabase.co";
    if (!configuredServiceRoleKey && !warnedMissingServiceRole) {
      warnedMissingServiceRole = true;
      console.warn("⚠️ SUPABASE_SERVICE_ROLE_KEY is not set; using anon key fallback in non-production mode.");
    }
    const anonKey =
      process.env.SUPABASE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      "sb_publishable_-7OtzoSb8zYjAXHR_Gk6dg_jAqiUyHQ";
    const apiKey = configuredServiceRoleKey || anonKey;
    return createClient(rawUrl, apiKey);
  };

  // Zero-login trusted access boundary for administrative /api/* endpoints:
  // Requires either:
  // 1. A valid X-Admin-Token matching ADMIN_API_SECRET (constant-time),
  // 2. A verified TRUSTED_GATEWAY_HEADER (and matching TRUSTED_PROXY_CIDRS if configured), OR
  // 3. Direct non-proxied local/private network interface traffic outside Vercel
  //    (in production without TRUSTED_GATEWAY_HEADER, proxied X-Forwarded-For requests are rejected).
  // VERCEL === "1" never grants an unauthenticated bypass.
  const requireAdminAuth: express.RequestHandler = (req, res, next) => {
    const tokenHeader = req.get("x-admin-token");
    if (tokenHeader !== undefined) {
      if (configuredSecret && tokenHeader.trim() && timingSafeMatch(tokenHeader.trim(), configuredSecret)) {
        return next();
      }
      return res.status(401).json({ error: "Unauthorized: invalid X-Admin-Token" });
    }

    const rawPeer = options.resolveRemoteAddress
      ? options.resolveRemoteAddress(req)
      : (req.socket?.remoteAddress || req.ip || "");
    const peerIp = normalizeIp(rawPeer);
    const peerIsTrusted =
      Boolean(peerIp) && (isLoopbackOrPrivateIp(peerIp) || isIpInCidrList(peerIp, trustedProxyCidrs));

    if (isVercelRuntime) {
      if (
        trustedGatewayHeader &&
        verifyTrustedGatewayHeader(req, trustedGatewayHeader) &&
        (trustedProxyCidrs.length === 0 || (Boolean(peerIp) && isIpInCidrList(peerIp, trustedProxyCidrs)))
      ) {
        return next();
      }
      return res.status(401).json({ error: "Unauthorized: valid X-Admin-Token or trusted gateway header required" });
    }

    if (!peerIsTrusted) {
      return res.status(401).json({ error: "Unauthorized: untrusted network source" });
    }

    if (trustedGatewayHeader) {
      if (!verifyTrustedGatewayHeader(req, trustedGatewayHeader)) {
        return res.status(401).json({ error: "Unauthorized: missing or invalid trusted gateway header" });
      }
      return next();
    }

    if (effectiveNodeEnv === "production" && req.get("x-forwarded-for")) {
      return res.status(401).json({ error: "Unauthorized: proxied production request requires X-Admin-Token or TRUSTED_GATEWAY_HEADER" });
    }

    return next();
  };

  // Apply trusted access boundary middleware to all protected API namespaces
  app.use(["/api/permits", "/api/dispatched", "/api/admin", "/api/blocklist", "/api/vouchers", "/api/emails"], requireAdminAuth);

  // API Route: Upload permit base64 image
  app.post("/api/permits/upload", (req, res) => {
    try {
      const { base64, name } = req.body || {};
      if (!isNonEmptyString(base64, 25_000_000)) {
        return res.status(400).json({ error: "Missing or invalid base64 image data" });
      }

      const id = "pmt_" + Math.random().toString(36).substring(2, 15);
      permitCache.set(id, {
        base64,
        name: sanitizeOptionalString(name, 120) || "permit",
        createdAt: Date.now()
      });

      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      for (const [key, val] of permitCache.entries()) {
        if (Date.now() - val.createdAt > TWENTY_FOUR_HOURS) {
          permitCache.delete(key);
        }
      }

      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.get("host");
      const imageUrl = `${protocol}://${host}/api/permit-image/${id}.png`;
      const viewUrl = `${protocol}://${host}/permit/${id}`;

      return res.json({ id, imageUrl, viewUrl });
    } catch (error: any) {
      console.error("Upload error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  // API Route: Serve the public permit PNG image directly
  app.get("/api/permit-image/:id.png", (req, res) => {
    const { id } = req.params;
    const permit = permitCache.get(id);

    if (!permit) {
      return res.status(404).send("Permit image not found or expired.");
    }

    try {
      const cleanBase64 = permit.base64.replace(/^data:image\/\w+;base64,/, "");
      const imageBuffer = Buffer.from(cleanBase64, "base64");

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `inline; filename="${permit.name}.png"`);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(imageBuffer);
    } catch (error) {
      console.error("Error serving image:", error);
      return res.status(500).send("Error rendering image.");
    }
  });

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Administrative Database Health check
  app.get("/api/admin/health-db", async (_req, res) => {
    try {
      const client = getAdminSupabaseClient();
      const { error } = await client.from("permits").select("id").limit(1);
      if (error) {
        return res.status(500).json({ connected: false, error: error.message });
      }
      return res.json({ connected: true });
    } catch (err: any) {
      return res.status(500).json({ connected: false, error: err?.message || String(err) });
    }
  });

  // API Route: Prepare replacement resend tracking record & pixel (status = PREPARED until dispatch completes)
  app.post("/api/emails/resend", (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json({ error: "Request body must be a JSON object" });
      }

      const { recordKey, vrm, email, requestedCode } = req.body;

      if (!isNonEmptyString(recordKey, 256) && !isNonEmptyString(vrm, 64)) {
        return res.status(400).json({ error: "Missing recordKey or vrm parameter" });
      }

      if (email !== undefined && email !== null && typeof email !== "string") {
        return res.status(400).json({ error: "Invalid email parameter" });
      }
      if (typeof requestedCode !== "string") {
        return res.status(400).json({ error: "A valid voucher code string is required" });
      }

      const voucherCode = requestedCode.trim().toUpperCase();
      if (
        !voucherCode ||
        voucherCode === "-" ||
        voucherCode === "CANCELLED" ||
        voucherCode === "PENDING" ||
        voucherCode === "UNDEFINED" ||
        voucherCode === "NULL"
      ) {
        return res.status(400).json({ error: "Empty or placeholder voucher code is not permitted" });
      }

      const trackingId = `trk_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.get("host") || "localhost:3000";
      const trackingPixelUrl = `${protocol}://${host}/api/email-track/${trackingId}.png`;

      const preparedAt = new Date().toISOString();
      const normVrm = normalizeVrmValue(typeof vrm === "string" ? vrm : "");
      const safeRecordKey = sanitizeOptionalString(recordKey, 256) || normVrm;

      const trackingRecord: EmailTrackingRecord = {
        trackingId,
        recordKey: safeRecordKey,
        vrm: normVrm,
        email: String(email || "").toLowerCase().trim(),
        voucherCode,
        status: "PREPARED",
        preparedAt,
        openCount: 0,
        subject: `Replacement Parking Concession – ${normVrm || "Vehicle"}`
      };

      emailTrackingStore.set(trackingId, trackingRecord);

      console.log(`📧 [Email Resend Prepared] Voucher ${voucherCode} for VRM ${normVrm} with tracking ${trackingId}`);

      return res.json({
        success: true,
        trackingId,
        voucherCode,
        status: "PREPARED",
        preparedAt,
        trackingPixelUrl
      });
    } catch (error: any) {
      console.error("Resend API error:", error);
      return res.status(500).json({ error: error.message || "Failed to process email resend" });
    }
  });

  // API Route: Confirm a prepared email tracking record as SENT after dispatch succeeds
  app.post("/api/emails/confirm", (req, res) => {
    const trackingId = isPlainObject(req.body) ? req.body.trackingId : undefined;
    if (!isNonEmptyString(trackingId, 256)) {
      return res.status(400).json({ error: "Missing trackingId parameter" });
    }
    const cleanId = trackingId.trim();
    const record = emailTrackingStore.get(cleanId);
    if (!record) {
      return res.status(404).json({ error: "Tracking record not found" });
    }
    record.status = "SENT";
    record.sentAt = record.sentAt || new Date().toISOString();
    if (record.recordKey) emailTrackingStore.set(record.recordKey, record);
    if (record.vrm) emailTrackingStore.set(record.vrm, record);
    return res.json({ success: true, record });
  });

  // API Route: Revert/delete a prepared email tracking record when dispatch rolls back
  app.post("/api/emails/revert", (req, res) => {
    const trackingId = isPlainObject(req.body) ? req.body.trackingId : undefined;
    if (!isNonEmptyString(trackingId, 256)) {
      return res.status(400).json({ error: "Missing trackingId parameter" });
    }
    const cleanId = trackingId.trim();
    const existing = emailTrackingStore.get(cleanId);
    if (existing) {
      emailTrackingStore.delete(cleanId);
      if (existing.recordKey && emailTrackingStore.get(existing.recordKey)?.trackingId === cleanId) {
        emailTrackingStore.delete(existing.recordKey);
      }
      if (existing.vrm && emailTrackingStore.get(existing.vrm)?.trackingId === cleanId) {
        emailTrackingStore.delete(existing.vrm);
      }
    }
    return res.json({ success: true });
  });

  // API Route: Email open tracking pixel (1x1 transparent image - public for email clients)
  app.get("/api/email-track/:trackingId.png", (req, res) => {
    const { trackingId } = req.params;
    const cleanId = String(trackingId || "").trim();

    const record = emailTrackingStore.get(cleanId);
    if (record) {
      record.status = "OPENED";
      if (!record.openedAt) {
        record.openedAt = new Date().toISOString();
      }
      record.openCount = (record.openCount || 0) + 1;
      record.ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress;
      record.userAgent = req.headers["user-agent"];
      if (record.recordKey) emailTrackingStore.set(record.recordKey, record);
      if (record.vrm) emailTrackingStore.set(record.vrm, record);
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", TRANSPARENT_1X1_PNG.length);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.send(TRANSPARENT_1X1_PNG);
  });

  // API Route: Retrieve all active email statuses
  app.get("/api/emails/statuses", (_req, res) => {
    const statuses: Record<string, EmailTrackingRecord> = {};
    for (const [key, val] of emailTrackingStore.entries()) {
      statuses[key] = val;
      if (val.status !== "PREPARED") {
        if (val.recordKey) statuses[val.recordKey] = val;
        if (val.vrm) statuses[val.vrm] = val;
      }
    }
    return res.json({ statuses });
  });

  // API Route: Simulate email open event (for testing / demo environments)
  app.post("/api/emails/simulate-open/:id", (req, res) => {
    const { id } = req.params;
    if (!isNonEmptyString(id, 256)) {
      return res.status(400).json({ error: "Invalid id parameter" });
    }
    const cleanId = String(id).trim().toUpperCase().replace(/\s+/g, "");

    let target: EmailTrackingRecord | undefined;
    for (const [k, v] of emailTrackingStore.entries()) {
      if (k === id || k.toUpperCase() === cleanId || v.trackingId === id || v.recordKey === id || v.vrm.toUpperCase() === cleanId) {
        target = v;
        break;
      }
    }

    if (!target) {
      target = {
        trackingId: `trk_${id}`,
        recordKey: id,
        vrm: id,
        email: "recipient@example.com",
        voucherCode: "SIMULATED",
        status: "OPENED",
        sentAt: new Date(Date.now() - 60000).toISOString(),
        openedAt: new Date().toISOString(),
        openCount: 1
      };
      emailTrackingStore.set(id, target);
      emailTrackingStore.set(cleanId, target);
    } else {
      target.status = "OPENED";
      if (!target.openedAt) target.openedAt = new Date().toISOString();
      target.openCount = (target.openCount || 0) + 1;
    }

    return res.json({ success: true, record: target });
  });

  // ============================================================
  // PERMITS ROUTES (Service-Role Mediated)
  // ============================================================
  app.get("/api/permits", async (req, res) => {
    try {
      const client = getAdminSupabaseClient();
      const daysLimitRaw = req.query.daysLimit ? Number(req.query.daysLimit) : null;
      let cutoffISO = "";
      if (daysLimitRaw && Number.isFinite(daysLimitRaw) && daysLimitRaw > 0) {
        const cutoffObj = new Date(Date.now() - daysLimitRaw * 86400000);
        cutoffISO = `${cutoffObj.getFullYear()}-${String(cutoffObj.getMonth() + 1).padStart(2, "0")}-${String(cutoffObj.getDate()).padStart(2, "0")}`;
      }

      let allData: any[] = [];
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        let query = client
          .from("permits")
          .select("*")
          .range(from, to)
          .order("created_at", { ascending: false });

        if (cutoffISO) {
          query = query.gte("created_at", cutoffISO);
        }

        const { data, error } = await query;
        if (error) {
          return res.status(500).json({ error: error.message });
        }

        if (data && data.length > 0) {
          allData = allData.concat(data);
          if (data.length < pageSize) {
            hasMore = false;
          } else {
            page++;
          }
        } else {
          hasMore = false;
        }
      }

      let exactTotalCount = allData.length;
      try {
        const { count } = await client.from("permits").select("*", { count: "exact", head: true });
        if (typeof count === "number" && count > 0) {
          exactTotalCount = count;
        }
      } catch {}

      return res.json({ permits: allData, totalCount: exactTotalCount });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to fetch permits" });
    }
  });

  app.post("/api/permits/update", async (req, res) => {
    try {
      if (!isPlainObject(req.body) || !isNonEmptyString(req.body.id, 256)) {
        return res.status(400).json({ error: "Missing or invalid permit id parameter" });
      }

      const payload = sanitizePermitPayload(req.body);
      const adminClient = getAdminSupabaseClient();

      let { error } = await adminClient.from("permits").upsert(payload, { onConflict: "id" });
      if (error && (String(error.message || "").toLowerCase().includes("cancellation_reason") || String(error.message || "").toLowerCase().includes("replacement_code"))) {
        const fallbackPayload = { ...payload };
        if (String(error.message || "").toLowerCase().includes("cancellation_reason")) {
          delete fallbackPayload.cancellation_reason;
        }
        if (String(error.message || "").toLowerCase().includes("replacement_code") || String(error.message || "").toLowerCase().includes("original_voucher_code") || String(error.message || "").toLowerCase().includes("pre_cancel_voucher_code")) {
          delete fallbackPayload.replacement_code;
          delete fallbackPayload.original_voucher_code;
          delete fallbackPayload.pre_cancel_voucher_code;
        }
        const retryRes = await adminClient.from("permits").upsert(fallbackPayload, { onConflict: "id" });
        error = retryRes.error;
      }

      if (error) {
        console.warn(`Admin permit update error for id ${payload.id}:`, error.message);
        return res.status(error.code === "42501" ? 403 : 500).json({ error: error.message, code: error.code });
      }

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Admin permit update exception:", error);
      return res.status(500).json({ error: error.message || "Unknown error" });
    }
  });

  app.post("/api/permits/sync", async (req, res) => {
    try {
      if (!isPlainObject(req.body) || !Array.isArray(req.body.records)) {
        return res.status(400).json({ error: "Invalid request: records array required" });
      }

      const { records, replaceAll } = req.body;
      const client = getAdminSupabaseClient();

      if (replaceAll === true) {
        const existing = await client.from("permits").select("id");
        if (existing.error) {
          return res.status(500).json({ error: existing.error.message });
        }
        if (existing.data && existing.data.length > 0) {
          const idsToDelete = existing.data.map((d: any) => d.id).filter(Boolean);
          for (let i = 0; i < idsToDelete.length; i += 200) {
            const chunk = idsToDelete.slice(i, i + 200);
            const { error: delErr } = await client.from("permits").delete().in("id", chunk);
            if (delErr) {
              return res.status(500).json({ error: delErr.message });
            }
          }
        }
      }

      const sanitized = records
        .filter((r: any) => isPlainObject(r) && isNonEmptyString(r.id, 256))
        .map((r: any) => sanitizePermitPayload(r));

      if (sanitized.length === 0) {
        return res.json({ success: true, count: 0 });
      }

      const BATCH_SIZE = 400;
      let skipCancellation = false;
      let skipReplacement = false;

      for (let i = 0; i < sanitized.length; i += BATCH_SIZE) {
        const prepareChunk = () =>
          sanitized.slice(i, i + BATCH_SIZE).map((item) => {
            const copy = { ...item };
            if (skipCancellation) delete copy.cancellation_reason;
            if (skipReplacement) {
              delete copy.replacement_code;
              delete copy.original_voucher_code;
              delete copy.pre_cancel_voucher_code;
            }
            return copy;
          });

        let { error } = await client.from("permits").upsert(prepareChunk(), { onConflict: "id" });
        if (error) {
          const msg = String(error.message || "").toLowerCase();
          if (msg.includes("cancellation_reason") || msg.includes("replacement_code") || msg.includes("original_voucher_code") || msg.includes("pre_cancel_voucher_code")) {
            if (msg.includes("cancellation_reason")) skipCancellation = true;
            if (msg.includes("replacement_code") || msg.includes("original_voucher_code") || msg.includes("pre_cancel_voucher_code")) skipReplacement = true;
            const retryRes = await client.from("permits").upsert(prepareChunk(), { onConflict: "id" });
            error = retryRes.error;
          }
        }
        if (error) {
          return res.status(500).json({ error: error.message });
        }
      }

      return res.json({ success: true, count: sanitized.length });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Failed to sync permits" });
    }
  });

  app.post("/api/permits/clear-invalid-vouchers", async (req, res) => {
    try {
      const badCodes = Array.isArray(req.body?.codes)
        ? req.body.codes.filter((c: unknown) => isNonEmptyString(c, 100))
        : [];
      if (badCodes.length === 0) {
        return res.json({ cleared: 0 });
      }
      const client = getAdminSupabaseClient();
      const { error, count } = await client
        .from("permits")
        .update({ voucher_code: null }, { count: "exact" })
        .in("voucher_code", badCodes);
      if (error) {
        return res.status(500).json({ error: error.message, cleared: 0 });
      }
      return res.json({ cleared: count || 0 });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Failed to clear invalid voucher codes", cleared: 0 });
    }
  });

  // ============================================================
  // VOUCHERS ROUTES (Service-Role Mediated)
  // ============================================================
  app.get("/api/vouchers", async (_req, res) => {
    try {
      const client = getAdminSupabaseClient();
      let allData: any[] = [];
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;
      let missingColumns = false;

      while (hasMore) {
        const from = page * pageSize;
        const to = from + pageSize - 1;

        let result: any = await client
          .from("vouchers")
          .select("code, vrm, valid_from, valid_to, status, is_used, not_in_latest_export")
          .range(from, to);

        if (result.error && result.error.message && (result.error.message.includes("not_in_latest_export") || result.error.message.includes("status") || result.error.message.includes("is_used") || result.error.message.includes("column"))) {
          missingColumns = true;
          result = await client
            .from("vouchers")
            .select("code, vrm, valid_from, valid_to, status, is_used")
            .range(from, to);

          if (result.error && result.error.message && (result.error.message.includes("status") || result.error.message.includes("is_used") || result.error.message.includes("column"))) {
            result = await client
              .from("vouchers")
              .select("code, vrm, valid_from, valid_to")
              .range(from, to);
          }
        }

        if (result.error) {
          return res.status(500).json({ error: result.error.message });
        }

        if (result.data && result.data.length > 0) {
          allData = allData.concat(result.data);
          if (result.data.length < pageSize) {
            hasMore = false;
          } else {
            page++;
          }
        } else {
          hasMore = false;
        }
      }

      return res.json({ vouchers: allData, missingColumns });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Failed to fetch vouchers" });
    }
  });

  app.post("/api/vouchers/sync", async (req, res) => {
    try {
      if (!isPlainObject(req.body) || !Array.isArray(req.body.vouchers)) {
        return res.status(400).json({ error: "Invalid request: vouchers array required" });
      }

      const { vouchers, replaceAll } = req.body;
      const client = getAdminSupabaseClient();

      if (replaceAll === true) {
        const existing = await client.from("vouchers").select("code");
        if (existing.error) {
          return res.status(500).json({ error: existing.error.message });
        }
        if (existing.data && existing.data.length > 0) {
          const codesToDelete = existing.data.map((d: any) => d.code).filter(Boolean);
          for (let i = 0; i < codesToDelete.length; i += 200) {
            const chunk = codesToDelete.slice(i, i + 200);
            const { error: delErr } = await client.from("vouchers").delete().in("code", chunk);
            if (delErr) {
              return res.status(500).json({ error: delErr.message });
            }
          }
        }
      }

      const payload = vouchers
        .filter((v: any) => isPlainObject(v) && isNonEmptyString(v.code, 100))
        .map((v: any) => ({
          code: String(v.code).trim(),
          vrm: sanitizeOptionalString(v.vrm, 64),
          valid_from: sanitizeOptionalString(v.valid_from, 64),
          valid_to: sanitizeOptionalString(v.valid_to, 64),
          status: sanitizeOptionalString(v.status, 32) || "active",
          is_used: Boolean(v.is_used),
          not_in_latest_export: Boolean(v.not_in_latest_export)
        }));

      if (payload.length === 0) {
        return res.json({ success: true, count: 0 });
      }

      const BATCH_SIZE = 400;
      let includeAllCols = 2;
      let missingColumns = false;

      for (let i = 0; i < payload.length; i += BATCH_SIZE) {
        const chunk = payload.slice(i, i + BATCH_SIZE);
        const mapChunk = (level: number) =>
          level === 2
            ? chunk
            : level === 1
              ? chunk.map((c) => ({ code: c.code, vrm: c.vrm, valid_from: c.valid_from, valid_to: c.valid_to, status: c.status, is_used: c.is_used }))
              : chunk.map((c) => ({ code: c.code, vrm: c.vrm, valid_from: c.valid_from, valid_to: c.valid_to }));

        let { error } = await client.from("vouchers").upsert(mapChunk(includeAllCols), { onConflict: "code" });
        if (error && error.message && (error.message.includes("not_in_latest_export") || error.message.includes("status") || error.message.includes("is_used") || error.message.includes("column"))) {
          missingColumns = true;
          includeAllCols = includeAllCols === 2 ? 1 : 0;
          const retryRes = await client.from("vouchers").upsert(mapChunk(includeAllCols), { onConflict: "code" });
          error = retryRes.error;
          if (error && includeAllCols === 1) {
            includeAllCols = 0;
            const baseRes = await client.from("vouchers").upsert(mapChunk(0), { onConflict: "code" });
            error = baseRes.error;
          }
        }
        if (error) {
          return res.status(500).json({ error: error.message });
        }
      }

      return res.json({ success: true, count: payload.length, missingColumns });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Failed to sync vouchers" });
    }
  });

  app.post("/api/vouchers/reset", async (_req, res) => {
    try {
      const client = getAdminSupabaseClient();
      const { error, count } = await client
        .from("vouchers")
        .delete({ count: "exact" })
        .neq("code", "___non_existent_code___");

      if (error) {
        return res.status(500).json({ cleared: 0, error: error.message });
      }
      return res.json({ cleared: count ?? 0, error: null });
    } catch (err: any) {
      return res.status(500).json({ cleared: 0, error: err?.message || "Unknown error" });
    }
  });

  // ============================================================
  // DISPATCHED HISTORY ROUTES (Service-Role Mediated)
  // ============================================================
  app.get("/api/dispatched", async (_req, res) => {
    try {
      const client = getAdminSupabaseClient();
      let allData: any[] = [];
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        const { data, error } = await client
          .from("dispatched_history")
          .select("key, dispatch_date, dispatch_by, vrm, email")
          .range(from, to);

        if (error) {
          return res.status(500).json({ error: error.message });
        }
        if (data && data.length > 0) {
          allData = allData.concat(data);
          if (data.length < pageSize) {
            hasMore = false;
          } else {
            page++;
          }
        } else {
          hasMore = false;
        }
      }

      return res.json({ dispatched: allData });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to fetch dispatched history" });
    }
  });

  app.post("/api/dispatched/check", async (req, res) => {
    try {
      if (!isPlainObject(req.body) || !Array.isArray(req.body.keys)) {
        return res.status(400).json({ error: "Invalid request: keys array required" });
      }
      const keys = req.body.keys
        .filter((k: unknown) => isNonEmptyString(k, 256))
        .map((k: string) => k.trim());
      if (keys.length === 0) {
        return res.json({ records: [] });
      }

      const client = getAdminSupabaseClient();
      const selectCols = req.body.includeHistory ? "key, dispatch_date, dispatch_by, vrm, email" : "key";
      const { data, error } = await client
        .from("dispatched_history")
        .select(selectCols)
        .in("key", keys);

      if (error) {
        return res.status(500).json({ error: error.message });
      }
      return res.json({ records: data || [] });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Failed to check dispatch history" });
    }
  });

  // Administrative API Route: Record dispatch log with server privileges
  app.post("/api/admin/dispatch", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json({ error: "Request body must be a JSON object" });
      }

      const { key, date, by, vrm, email } = req.body;
      if (!isNonEmptyString(key, 256)) {
        return res.status(400).json({ error: "Missing or invalid key parameter" });
      }
      if (date !== undefined && date !== null && typeof date !== "string") {
        return res.status(400).json({ error: "Invalid date parameter" });
      }
      if (by !== undefined && by !== null && typeof by !== "string") {
        return res.status(400).json({ error: "Invalid by parameter" });
      }
      if (vrm !== undefined && vrm !== null && typeof vrm !== "string") {
        return res.status(400).json({ error: "Invalid vrm parameter" });
      }
      if (email !== undefined && email !== null && typeof email !== "string") {
        return res.status(400).json({ error: "Invalid email parameter" });
      }

      const adminClient = getAdminSupabaseClient();
      const cleanKey = key.trim();
      const dispatchDate = sanitizeOptionalString(date, 64) || new Date().toISOString().split("T")[0];
      const dispatchBy = sanitizeOptionalString(by, 128) || "System User";
      const cleanVrm = sanitizeOptionalString(vrm, 64);
      const cleanEmail = sanitizeOptionalString(email, 320);

      let written = false;
      try {
        const { error: rpcErr } = await adminClient.rpc("log_dispatch", {
          p_key: cleanKey,
          p_dispatch_date: dispatchDate,
          p_dispatch_by: dispatchBy,
          p_vrm: cleanVrm,
          p_email: cleanEmail
        });
        if (!rpcErr) {
          written = true;
        }
      } catch {}

      if (!written) {
        const payload = {
          key: cleanKey,
          dispatch_date: dispatchDate,
          dispatch_by: dispatchBy,
          vrm: cleanVrm,
          email: cleanEmail
        };

        let { error } = await adminClient.from("dispatched_history").upsert(payload, { onConflict: "key" });
        if (error) {
          const basicPayload = { key: cleanKey, dispatch_date: dispatchDate, dispatch_by: dispatchBy };
          const retry = await adminClient.from("dispatched_history").upsert(basicPayload, { onConflict: "key" });
          error = retry.error;
        }
        if (error) {
          return res.status(error.code === "42501" ? 403 : 500).json({ error: error.message, code: error.code });
        }
      }

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Admin dispatch error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/dispatch/bulk", async (req, res) => {
    try {
      if (!isPlainObject(req.body) || !Array.isArray(req.body.items)) {
        return res.status(400).json({ error: "Invalid request: items array required" });
      }

      const today = new Date().toISOString().split("T")[0];
      const payload = req.body.items
        .filter((item: any) => isPlainObject(item) && isNonEmptyString(item.key, 256))
        .map((item: any) => ({
          key: item.key.trim(),
          dispatch_date: sanitizeOptionalString(item.date, 64) || today,
          dispatch_by: sanitizeOptionalString(item.by, 128) || "System User",
          vrm: sanitizeOptionalString(item.vrm, 64),
          email: sanitizeOptionalString(item.email, 320)
        }));

      if (payload.length === 0) {
        return res.json({ success: true, count: 0 });
      }

      const client = getAdminSupabaseClient();
      const BATCH_SIZE = 400;
      for (let i = 0; i < payload.length; i += BATCH_SIZE) {
        const chunk = payload.slice(i, i + BATCH_SIZE);
        const { error } = await client.from("dispatched_history").upsert(chunk, { onConflict: "key" });
        if (error) {
          const basicChunk = chunk.map((c: any) => ({
            key: c.key,
            dispatch_date: c.dispatch_date,
            dispatch_by: c.dispatch_by
          }));
          const { error: basicErr } = await client.from("dispatched_history").upsert(basicChunk, { onConflict: "key" });
          if (basicErr) {
            return res.status(500).json({ error: basicErr.message });
          }
        }
      }

      return res.json({ success: true, count: payload.length });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Failed to bulk sync dispatched history" });
    }
  });

  app.post("/api/admin/dispatch/delete", async (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json({ error: "Request body must be a JSON object" });
      }
      const { key, keys } = req.body;
      const rawKeys = Array.isArray(keys) ? keys : (key ? [key] : []);
      const keysToDelete = Array.from(
        new Set(rawKeys.filter((k: unknown) => isNonEmptyString(k, 256)).map((k: string) => k.trim()))
      );
      if (keysToDelete.length === 0) {
        return res.status(400).json({ error: "Missing or invalid key/keys parameter" });
      }
      const client = getAdminSupabaseClient();
      const { error } = await client.from("dispatched_history").delete().in("key", keysToDelete);
      if (error) {
        return res.status(500).json({ error: error.message });
      }
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to delete dispatch history" });
    }
  });

  app.post("/api/admin/dispatch/clear", async (_req, res) => {
    try {
      const client = getAdminSupabaseClient();
      const { error } = await client.from("dispatched_history").delete().neq("key", "___non_existent___");
      if (error) {
        return res.status(500).json({ error: error.message });
      }
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to clear dispatch history" });
    }
  });

  app.post("/api/admin/dispatch/cleanup", async (_req, res) => {
    try {
      const client = getAdminSupabaseClient();
      const { data, error } = await client.from("dispatched_history").select("key");
      if (error) {
        return res.status(500).json({ error: error.message, count: 0, deletedKeys: [] });
      }
      const invalidKeys = (data || [])
        .filter((item: any) => {
          const k = String(item?.key || "").trim();
          if (!k) return true;
          if (/^\d{8}$/.test(k)) return true;
          if (/^\d{4}-\d{2}-\d{2}$/.test(k)) return true;
          if (k.toUpperCase() === "UNDEFINED" || k.toUpperCase() === "NULL") return true;
          return false;
        })
        .map((item: any) => item.key);

      if (invalidKeys.length > 0) {
        const { error: delErr } = await client.from("dispatched_history").delete().in("key", invalidKeys);
        if (delErr) {
          return res.status(500).json({ error: delErr.message, count: 0, deletedKeys: [] });
        }
      }

      return res.json({ count: invalidKeys.length, deletedKeys: invalidKeys });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Cleanup failed", count: 0, deletedKeys: [] });
    }
  });

  app.post("/api/admin/dispatch/probe", async (_req, res) => {
    try {
      const client = getAdminSupabaseClient();
      const probeKey = "___rls_probe_ping___";
      const { error: insErr } = await client.from("dispatched_history").upsert(
        {
          key: probeKey,
          dispatch_date: new Date().toISOString().split("T")[0],
          dispatch_by: "Probe Ping"
        },
        { onConflict: "key" }
      );
      if (insErr) {
        const isRls =
          insErr.code === "42501" ||
          String(insErr.message || "").toLowerCase().includes("row-level security") ||
          String(insErr.message || "").toLowerCase().includes("violates");
        return res.json({ writable: false, isRlsError: isRls, error: insErr.message });
      }
      await client.from("dispatched_history").delete().eq("key", probeKey);
      return res.json({ writable: true });
    } catch (err: any) {
      return res.status(500).json({ writable: false, error: err?.message || "Probe failed" });
    }
  });

  // ============================================================
  // BLOCKLIST ROUTES (Authoritative Central Sync)
  // ============================================================
  let serverBlocklist: any[] = [...DEFAULT_SEED_BLOCKLIST];

  const isMissingBlocklistSchemaError = (err: any): boolean => {
    if (!err) return false;
    const code = String(err.code || "").trim().toUpperCase();
    const msg = String(err.message || err.details || err.hint || "").toLowerCase();
    if (code === "PGRST205" || code === "PGRST202" || code === "42P01" || code === "42883") {
      return true;
    }
    return (
      msg.includes("could not find the table") ||
      msg.includes("could not find the function") ||
      msg.includes("in the schema cache") ||
      (msg.includes("relation") && msg.includes("does not exist")) ||
      (msg.includes("function") && msg.includes("does not exist"))
    );
  };

  app.get("/api/blocklist", async (_req, res) => {
    try {
      const client = getAdminSupabaseClient();
      const { data, error } = await client.from("blocklist").select("*");
      if (error) {
        if (isMissingBlocklistSchemaError(error)) {
          return res.status(503).json({
            error: `Central Supabase blocklist table 'public.blocklist' is unavailable (${error.message || "missing from schema cache"})`
          });
        }
        return res.status(500).json({ error: error.message });
      }

      if (Array.isArray(data) && data.length > 0) {
        const mapped: any[] = data.map((d: any) => ({
          id: d.id,
          formId: d.form_id || undefined,
          hospitalSite: d.hospital_site || undefined,
          wardDept: d.ward_dept || undefined,
          dateRequired: d.date_required || undefined,
          expiryDate: d.expiry_date || undefined,
          vrm: d.vrm,
          driverName: d.driver_name || undefined,
          phone: d.phone || undefined,
          email: d.email || undefined,
          voucherCode: d.voucher_code || undefined,
          reason: d.reason || "",
          addedAt: d.added_at || undefined
        }));
        if (!mapped.some((i: any) => normalizeVrmValue(i.vrm) === "AU67HCZ")) {
          mapped.unshift(DEFAULT_SEED_BLOCKLIST[0]);
        }
        serverBlocklist = mapped;
        return res.json({ blocklist: mapped });
      }

      return res.json({ blocklist: serverBlocklist });
    } catch (err: any) {
      if (isMissingBlocklistSchemaError(err)) {
        return res.status(503).json({
          error: `Central Supabase blocklist table 'public.blocklist' is unavailable (${err?.message || "missing from schema cache"})`
        });
      }
      return res.status(500).json({ error: err?.message || "Failed to fetch blocklist" });
    }
  });

  app.post("/api/blocklist", async (req, res) => {
    try {
      if (!isPlainObject(req.body) || !Array.isArray(req.body.items)) {
        return res.status(400).json({ error: "Invalid items array" });
      }

      const rawItems = req.body.items;
      for (const item of rawItems) {
        if (!isPlainObject(item) || !isNonEmptyString(item.vrm, 64)) {
          return res.status(400).json({ error: "Each blocklist item must include a valid vrm" });
        }
      }

      const normalizedItems = rawItems.map((item: any) => ({
        ...item,
        id: sanitizeOptionalString(item.id, 128) || `blk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        vrm: String(item.vrm).trim().toUpperCase(),
        reason: sanitizeOptionalString(item.reason, 500) || "Administrative block",
        addedAt: sanitizeOptionalString(item.addedAt, 64) || new Date().toISOString()
      }));

      // Always preserve AU67 HCZ as a valid blocked vehicle
      if (!normalizedItems.some((i: any) => normalizeVrmValue(i.vrm) === "AU67HCZ")) {
        normalizedItems.unshift(DEFAULT_SEED_BLOCKLIST[0]);
      }

      const client = getAdminSupabaseClient();

      const rowsToPersist = normalizedItems.map((item: any) => ({
        id: item.id,
        form_id: sanitizeOptionalString(item.formId, 64),
        hospital_site: sanitizeOptionalString(item.hospitalSite, 200),
        ward_dept: sanitizeOptionalString(item.wardDept, 200),
        date_required: sanitizeOptionalString(item.dateRequired, 64),
        expiry_date: sanitizeOptionalString(item.expiryDate, 64),
        vrm: item.vrm,
        driver_name: sanitizeOptionalString(item.driverName, 200),
        phone: sanitizeOptionalString(item.phone, 64),
        email: sanitizeOptionalString(item.email, 320),
        voucher_code: sanitizeOptionalString(item.voucherCode, 64) || "BLOCKED",
        reason: item.reason,
        added_at: item.addedAt
      }));

      // Atomic server-side replacement inside one PostgreSQL transaction via replace_blocklist RPC
      const { data: rpcData, error: rpcErr } = await client.rpc("replace_blocklist", { entries: rowsToPersist });
      if (rpcErr) {
        if (isMissingBlocklistSchemaError(rpcErr)) {
          return res.status(503).json({
            error: `Central Supabase blocklist RPC 'replace_blocklist' is unavailable (${rpcErr.message || "missing from schema cache"})`
          });
        }
        return res.status(500).json({ error: rpcErr.message || "Failed to replace blocklist" });
      }

      const authoritativeList = Array.isArray(rpcData) && rpcData.length > 0
        ? rpcData.map((d: any) => ({
            id: d.id,
            formId: d.form_id || undefined,
            hospitalSite: d.hospital_site || undefined,
            wardDept: d.ward_dept || undefined,
            dateRequired: d.date_required || undefined,
            expiryDate: d.expiry_date || undefined,
            vrm: d.vrm,
            driverName: d.driver_name || undefined,
            phone: d.phone || undefined,
            email: d.email || undefined,
            voucherCode: d.voucher_code || undefined,
            reason: d.reason || "",
            addedAt: d.added_at || undefined
          }))
        : normalizedItems;

      serverBlocklist = authoritativeList;
      return res.json({ success: true, blocklist: authoritativeList });
    } catch (err: any) {
      if (isMissingBlocklistSchemaError(err)) {
        return res.status(503).json({
          error: `Central Supabase blocklist RPC 'replace_blocklist' is unavailable (${err?.message || "missing from schema cache"})`
        });
      }
      return res.status(500).json({ error: err?.message || "Failed to save blocklist" });
    }
  });

  // Serve public Supabase browser config ONLY (no admin secrets or tokens)
  app.get("/api/config", (_req, res) => {
    const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
    const rawKey =
      process.env.SUPABASE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      "";

    const defaultUrl = "https://ihhkitfpjmhudyzdhlpg.supabase.co";
    const defaultKey = "sb_publishable_-7OtzoSb8zYjAXHR_Gk6dg_jAqiUyHQ";

    const supabaseUrl = rawUrl.startsWith("http") ? rawUrl : rawKey.startsWith("http") ? rawKey : defaultUrl;
    const supabaseAnonKey =
      !rawKey.startsWith("http") && rawKey.length > 0
        ? rawKey
        : !rawUrl.startsWith("http") && rawUrl.length > 0
          ? rawUrl
          : defaultKey;

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      supabaseUrl,
      supabaseAnonKey
    });
  });

  return app;
}

export const app = createApiApp();
export default app;

async function startServer() {
  const PORT = 3000;

  // Vite integration middleware
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL && process.env.SKIP_SERVER_LISTEN !== "1") {
  startServer();
}
