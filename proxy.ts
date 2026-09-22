import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { security } from "./lib/security";
export function proxy(request: NextRequest) {
  // External consumers authenticate with the /api/v1 Bearer key. The handler
  // performs that check; applying the dashboard Basic Auth here would make
  // the documented external contract unreachable.
  if (!request.nextUrl.pathname.startsWith('/api/v1')) {
    const denied = security(request);
    if (denied) return denied;
  }
  const nonce = randomBytes(18).toString("base64");
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self'${process.env.NODE_ENV === "development" ? " ws:" : ""}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|static/|favicon.ico).*)"],
};
