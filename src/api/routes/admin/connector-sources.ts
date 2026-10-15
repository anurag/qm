import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { PROVIDERS } from "../../../connectors/oauth.ts";
import { isComposioServiceCredential } from "../composio.ts";
import { configuredOAuthProviders } from "../connectors.ts";

function origin(url: string | undefined): string | undefined {
  return url ? url.replace(/\/+$/, "") : undefined;
}

export async function getConnectorSources(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(ctx.deps, {
    principalId: actor.id,
    action: "connector-sources.read",
    resource: "connector-sources",
    scopeLabel: scope,
  });
  const [credentials, oauth] = await Promise.all([
    ctx.deps.serviceCreds?.listServiceCredentials(scope) ?? [],
    configuredOAuthProviders(ctx.deps),
  ]);
  const web = origin(ctx.deps.portalUrl);
  const admin = web ?? origin(ctx.deps.publicUrl);
  const api = origin(ctx.deps.publicUrl);
  return sendJson(ctx.res, 200, {
    composio: { configured: credentials.some(isComposioServiceCredential) },
    oauth: { configured: oauth },
    setup: {
      ...(admin
        ? { composioCredentialUrl: `${admin}/admin/credentials`, oauthAppsUrl: `${admin}/admin/connectors` }
        : {}),
      ...(web ? { composioVerifierUrl: `${web}/api/composio/callback` } : {}),
      ...(api
        ? {
            oauthCallbackUrls: Object.fromEntries(
              Object.keys(PROVIDERS).map((provider) => [
                provider,
                `${api}/v1/connectors/oauth/${encodeURIComponent(provider)}/callback`,
              ]),
            ),
          }
        : {}),
    },
  });
}
