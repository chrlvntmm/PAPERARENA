import * as cookie from "cookie";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONFIG } from "../config.js";

export function getSessionTokenFromCookie(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  return cookie.parseCookie(header)[CONFIG.AUTH.COOKIE_NAME];
}

export function setSessionCookie(res: ServerResponse, token: string) {
  res.setHeader(
    "Set-Cookie",
    cookie.stringifySetCookie({
      name: CONFIG.AUTH.COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: CONFIG.AUTH.COOKIE_SECURE,
      sameSite: CONFIG.AUTH.COOKIE_SAME_SITE,
      path: "/",
      maxAge: CONFIG.AUTH.SESSION_TTL_SECONDS,
    }),
  );
}

export function clearSessionCookie(res: ServerResponse) {
  res.setHeader(
    "Set-Cookie",
    cookie.stringifySetCookie({
      name: CONFIG.AUTH.COOKIE_NAME,
      value: "",
      httpOnly: true,
      secure: CONFIG.AUTH.COOKIE_SECURE,
      sameSite: CONFIG.AUTH.COOKIE_SAME_SITE,
      path: "/",
      maxAge: 0,
    }),
  );
}
