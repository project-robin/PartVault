const API_BASE = import.meta.env.VITE_API_URL as string | undefined;

export function getApiBase(): string {
  return API_BASE ?? "http://localhost:3000";
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // In production, Amplify provides JWT; in dev, localStorage token is used
  const token = localStorage.getItem("partvault_token");
  const role = localStorage.getItem("partvault_role") ?? "admin";
  const email = localStorage.getItem("partvault_email") ?? "admin@demo.local";
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
    headers["x-user-sub"] = token;
    headers["x-user-roles"] = role;
    headers["x-user-email"] = email;
  }
  return headers;
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = getApiBase();
  const headers = await getAuthHeaders();
  const res = await fetch(`${base}${path}`, { ...options, headers: { ...headers, ...(options.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    const body = await res.text();
    let msg = body;
    try { msg = (JSON.parse(body) as { message?: string }).message ?? body; } catch { /* keep raw */ }
    throw new Error(`API ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

export async function sha256Of(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
