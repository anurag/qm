import { createHmac } from "node:crypto";

export function renderGatewayToken(secret: string, expiresAtMs: number): string {
  return `${expiresAtMs}.${createHmac("sha256", secret).update(String(expiresAtMs)).digest("base64url")}`;
}

interface RenderPending {
  version: number;
  runnerCommit: string;
  readinessNonce: string;
  previousDeployId?: string;
  deployId?: string;
}

export interface StoredRenderDeploy {
  deploymentId: string;
  appRegion: string;
  serviceId?: string;
  environmentId?: string;
  host?: string;
  token: string;
  liveVersion?: number;
  suspended: boolean;
  pending?: RenderPending;
}
