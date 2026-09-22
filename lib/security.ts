import { createHash, timingSafeEqual } from "node:crypto";
export function security(request: Request): Response | null {
  const url = new URL(request.url),
    host = request.headers.get("host") || url.host;
  const allowed = (process.env.ALLOWED_HOSTS || "localhost,127.0.0.1,[::1]")
    .split(",")
    .map((v) => v.trim());
  let hostname: string;
  try {
    hostname = new URL("http://" + host).hostname;
  } catch {
    return Response.json({ detail: "Invalid host" }, { status: 400 });
  }
  if (!allowed.includes(hostname))
    return Response.json({ detail: "Host not allowed" }, { status: 400 });
  const username = process.env.APP_USERNAME || "",
    password = process.env.APP_PASSWORD || "";
  if (Boolean(username) !== Boolean(password))
    return Response.json(
      { detail: "Configure both APP_USERNAME and APP_PASSWORD" },
      { status: 503 },
    );
  if (!password && process.env.NODE_ENV === "production")
    return Response.json(
      {
        detail:
          "Configure APP_USERNAME and APP_PASSWORD before running production",
      },
      { status: 503 },
    );
  if (password) {
    const auth = request.headers.get("authorization") || "",
      m = auth.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i),
      supplied = m ? Buffer.from(m[1], "base64").toString("utf8") : "";
    const hash = (v: string) => createHash("sha256").update(v).digest();
    if (!m || !timingSafeEqual(hash(supplied), hash(`${username}:${password}`)))
      return Response.json(
        { detail: "Sign in required" },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Permit Atlas"',
            "Cache-Control": "no-store",
          },
        },
      );
  }
  if (["POST", "PATCH", "DELETE", "PUT"].includes(request.method)) {
    const origin = request.headers.get("origin");
    let same = true;
    try {
      if (origin) same = new URL(origin).host === host;
    } catch {
      same = false;
    }
    if (!same || request.headers.get("sec-fetch-site") === "cross-site")
      return Response.json(
        { detail: "Cross-origin writes are not allowed" },
        { status: 403 },
      );
    if (
      request.headers.get("content-type")?.split(";")[0].trim() !==
      "application/json"
    )
      return Response.json({ detail: "Use application/json" }, { status: 415 });
  }
  return null;
}
