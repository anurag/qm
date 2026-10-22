import { createHmac } from "node:crypto";

export function renderGatewayToken(secret: string, expiresAtMs: number): string {
  return `${expiresAtMs}.${createHmac("sha256", secret).update(String(expiresAtMs)).digest("base64url")}`;
}
