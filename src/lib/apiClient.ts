export const ADMIN_TOKEN_STORAGE_KEY = "parkpass_admin_token";

let inMemoryConfigPromise: Promise<{
  supabaseUrl?: string;
  supabaseAnonKey?: string;
} | null> | null = null;

function getSafeStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Ignore storage access errors in restricted contexts
  }
  return null;
}

export function getStoredAdminToken(): string | null {
  try {
    const storage = getSafeStorage();
    const val = storage?.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim();
    return val ? val : null;
  } catch {
    return null;
  }
}

export function enrollAdminTokenFromHash(): string | null {
  try {
    if (typeof window === "undefined" || !window.location) {
      return null;
    }
    const rawHash = window.location.hash || "";
    if (!rawHash || !rawHash.includes("admin_token=")) {
      return null;
    }

    const hashBody = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
    const params = new URLSearchParams(hashBody);
    const token = params.get("admin_token")?.trim() || "";

    if (token) {
      const storage = getSafeStorage();
      storage?.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    }

    if (params.has("admin_token")) {
      params.delete("admin_token");
      const remaining = params.toString();
      const nextUrl = `${window.location.pathname || "/"}${window.location.search || ""}${remaining ? `#${remaining}` : ""}`;
      if (window.history && typeof window.history.replaceState === "function") {
        window.history.replaceState(window.history.state ?? null, "", nextUrl);
      }
    }

    return token || null;
  } catch {
    return null;
  }
}

function isSameOriginApiRequest(input: string): boolean {
  if (input.startsWith("/api/") || input === "/api") {
    return true;
  }
  if (input.startsWith("/") && !input.startsWith("//")) {
    return true;
  }
  try {
    if (typeof window !== "undefined" && window.location?.origin) {
      const parsed = new URL(input, window.location.origin);
      return parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/");
    }
  } catch {
    // Fallback for non-standard/relative URLs
  }
  return false;
}

// Automatically enroll trusted device token if launched via bookmark/link with #admin_token=...
enrollAdminTokenFromHash();

export async function loadRuntimeConfig(forceRefresh: boolean = false): Promise<{
  supabaseUrl?: string;
  supabaseAnonKey?: string;
} | null> {
  if (!forceRefresh && inMemoryConfigPromise) {
    return inMemoryConfigPromise;
  }

  const run = async () => {
    try {
      if (typeof fetch === "undefined") return null;
      const res = await fetch("/api/config", {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      if (!res || !res.ok) return null;
      const data = await res.json().catch(() => null);
      if (data && typeof data === "object") {
        return {
          supabaseUrl: typeof data.supabaseUrl === "string" ? data.supabaseUrl : undefined,
          supabaseAnonKey: typeof data.supabaseAnonKey === "string" ? data.supabaseAnonKey : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  };

  inMemoryConfigPromise = run();
  return inMemoryConfigPromise;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  enrollAdminTokenFromHash();

  const headers = new Headers(init.headers || undefined);
  if (!headers.has("X-Requested-With")) {
    headers.set("X-Requested-With", "XMLHttpRequest");
  }

  if (!headers.has("X-Admin-Token") && isSameOriginApiRequest(input)) {
    const token = getStoredAdminToken();
    if (token) {
      headers.set("X-Admin-Token", token);
    }
  }

  return fetch(input, {
    ...init,
    headers,
  });
}
