import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config({ override: true });

const _dirname = typeof __dirname !== "undefined" ? __dirname : process.cwd();

// In-memory store for generated permit images to allow public access via Twilio or sharing links
const permitCache = new Map<string, { base64: string; name: string; createdAt: number }>();

// In-memory store for email dispatch and open tracking
interface EmailTrackingRecord {
  trackingId: string;
  recordKey: string;
  vrm: string;
  email: string;
  voucherCode: string;
  status: "SENT" | "OPENED";
  sentAt: string;
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

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase payload limit for base64 images and large spreadsheets
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // API Route: Upload permit base64 image
  app.post("/api/permits/upload", (req, res) => {
    try {
      const { base64, name } = req.body;
      if (!base64) {
        return res.status(400).json({ error: "Missing base64 image data" });
      }

      // Generate a unique ID for the permit
      const id = "pmt_" + Math.random().toString(36).substring(2, 15);
      
      // Store in memory
      permitCache.set(id, {
        base64,
        name: name || "permit",
        createdAt: Date.now()
      });

      // Automatically clean up old images after 24 hours to prevent memory leaks
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

      res.json({ id, imageUrl, viewUrl });
    } catch (error: any) {
      console.error("Upload error:", error);
      res.status(500).json({ error: error.message });
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
      // Decode the base64 back to binary data
      const cleanBase64 = permit.base64.replace(/^data:image\/\w+;base64,/, "");
      const imageBuffer = Buffer.from(cleanBase64, "base64");

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `inline; filename="${permit.name}.png"`);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(imageBuffer);
    } catch (error) {
      console.error("Error serving image:", error);
      res.status(500).send("Error rendering image.");
    }
  });

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // API Route: Send / Resend email with generated voucher code and tracking pixel
  app.post("/api/emails/resend", (req, res) => {
    try {
      const {
        recordKey,
        vrm,
        email,
        driverName,
        requestedCode,
        validFrom,
        validTo,
        todayDate
      } = req.body;

      // 1. Generate or validate voucher code
      let voucherCode = (requestedCode || "").trim().toUpperCase();
      if (!voucherCode || voucherCode === "-" || voucherCode === "CANCELLED") {
        const chars = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
        let rand = "";
        for (let i = 0; i < 10; i++) {
          rand += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        voucherCode = `NHS${rand}`;
      }

      // 2. Generate unique tracking identifier
      const trackingId = `trk_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;

      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.get("host") || "localhost:3000";
      const trackingPixelUrl = `${protocol}://${host}/api/email-track/${trackingId}.png`;

      const sentAt = new Date().toISOString();
      const normVrm = (vrm || "").toUpperCase().replace(/\s+/g, "");

      const trackingRecord: EmailTrackingRecord = {
        trackingId,
        recordKey: String(recordKey || normVrm),
        vrm: normVrm,
        email: (email || "").toLowerCase().trim(),
        voucherCode,
        status: "SENT",
        sentAt,
        openCount: 0,
        subject: `Replacement Parking Concession – ${normVrm || "Vehicle"}`
      };

      emailTrackingStore.set(trackingId, trackingRecord);
      if (trackingRecord.recordKey) {
        emailTrackingStore.set(trackingRecord.recordKey, trackingRecord);
      }
      if (normVrm) {
        emailTrackingStore.set(normVrm, trackingRecord);
      }

      console.log(`📧 [Email Resend] Generated code ${voucherCode} for VRM ${normVrm} with tracking ${trackingId}`);

      res.json({
        success: true,
        trackingId,
        voucherCode,
        status: "SENT",
        sentAt,
        trackingPixelUrl
      });
    } catch (error: any) {
      console.error("Resend API error:", error);
      res.status(500).json({ error: error.message || "Failed to process email resend" });
    }
  });

  // API Route: Email open tracking pixel (1x1 transparent image)
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

      console.log(`👁️ [Email Track] Email opened for VRM ${record.vrm} (trackingId: ${cleanId}, count: ${record.openCount})`);
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", TRANSPARENT_1X1_PNG.length);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.send(TRANSPARENT_1X1_PNG);
  });

  // API Route: Retrieve all active email statuses
  app.get("/api/emails/statuses", (req, res) => {
    const statuses: Record<string, EmailTrackingRecord> = {};
    for (const [key, val] of emailTrackingStore.entries()) {
      statuses[key] = val;
      if (val.recordKey) statuses[val.recordKey] = val;
      if (val.vrm) statuses[val.vrm] = val;
    }
    res.json({ statuses });
  });

  // API Route: Simulate email open event (for testing / demo environments)
  app.post("/api/emails/simulate-open/:id", (req, res) => {
    const { id } = req.params;
    const cleanId = String(id || "").trim().toUpperCase().replace(/\s+/g, "");

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

    res.json({ success: true, record: target });
  });

  // Administrative API Route: Record dispatch log with server privileges (supports SUPABASE_SERVICE_ROLE_KEY)
  app.post("/api/admin/dispatch", async (req, res) => {
    try {
      const { key, date, by, vrm, email } = req.body;
      if (!key) {
        return res.status(400).json({ error: "Missing key parameter" });
      }

      const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://ihhkitfpjmhudyzdhlpg.supabase.co";
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const anonKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_-7OtzoSb8zYjAXHR_Gk6dg_jAqiUyHQ";

      const apiKey = serviceKey || anonKey;
      if (!apiKey || !rawUrl) {
        return res.status(500).json({ error: "Supabase credentials not configured on server" });
      }

      const { createClient } = await import("@supabase/supabase-js");
      const adminClient = createClient(rawUrl, apiKey);

      // Try service_role RPC first
      let written = false;
      try {
        const { error: rpcErr } = await adminClient.rpc("log_dispatch", {
          p_key: String(key).trim(),
          p_dispatch_date: date || new Date().toISOString().split("T")[0],
          p_dispatch_by: by || "System User",
          p_vrm: vrm ? String(vrm).trim() : null,
          p_email: email ? String(email).trim() : null
        });
        if (!rpcErr) {
          written = true;
        }
      } catch (e) {
        // Fallback to direct upsert below
      }

      if (!written) {
        const payload = {
          key: String(key).trim(),
          dispatch_date: date || new Date().toISOString().split("T")[0],
          dispatch_by: by || "System User",
          vrm: vrm ? String(vrm).trim() : null,
          email: email ? String(email).trim() : null
        };

        const { error } = await adminClient.from("dispatched_history").upsert(payload, { onConflict: "key" });
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

  // Administrative API Route: Update / Upsert permit record with server privileges (supports SUPABASE_SERVICE_ROLE_KEY)
  app.post("/api/permits/update", async (req, res) => {
    try {
      const payload = req.body;
      if (!payload || !payload.id) {
        return res.status(400).json({ error: "Missing permit id parameter" });
      }

      const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://ihhkitfpjmhudyzdhlpg.supabase.co";
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const anonKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_-7OtzoSb8zYjAXHR_Gk6dg_jAqiUyHQ";

      const apiKey = serviceKey || anonKey;
      if (!apiKey || !rawUrl) {
        return res.status(500).json({ error: "Supabase credentials not configured on server" });
      }

      const { createClient } = await import("@supabase/supabase-js");
      const adminClient = createClient(rawUrl, apiKey);

      const { error } = await adminClient.from("permits").upsert(payload, { onConflict: "id" });
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

  // Serve client config (e.g. Supabase credentials)
  app.get("/api/config", (req, res) => {
    const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
    const rawKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";

    const defaultUrl = "https://ihhkitfpjmhudyzdhlpg.supabase.co";
    const defaultKey = "sb_publishable_-7OtzoSb8zYjAXHR_Gk6dg_jAqiUyHQ";

    const supabaseUrl = rawUrl.startsWith("http") ? rawUrl : (rawKey.startsWith("http") ? rawKey : defaultUrl);
    const supabaseAnonKey = !rawKey.startsWith("http") && rawKey.length > 0 ? rawKey : (!rawUrl.startsWith("http") && rawUrl.length > 0 ? rawUrl : defaultKey);

    res.json({
      supabaseUrl,
      supabaseAnonKey
    });
  });

  // Vite integration middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
