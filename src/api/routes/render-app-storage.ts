import { RenderAppStorageError } from "../../deploy/render-app-storage.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

export const renderAppStorageRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/deployments/:id/storage",
    auth: "public",
    async handle({ req, res, deps, params, body }) {
      res.setHeader("cache-control", "no-store");
      if (!deps.renderAppStorage) return sendJson(res, 404, { error: "not_found" });
      const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "")?.[1];
      if (!token) return sendJson(res, 401, { error: "unauthorized" });
      if (!isObj(body) || Object.keys(body).some((key) => key !== "method" && key !== "key"))
        return sendJson(res, 400, { error: "bad_request", message: "Expected method and key" });
      try {
        const signed = await deps.renderAppStorage.sign(params.id!, token, { method: body.method, key: body.key });
        sendJson(res, 200, signed);
      } catch (error) {
        if (error instanceof RenderAppStorageError)
          return sendJson(res, error.status, { error: "app_storage_error", message: error.message });
        throw error;
      }
    },
  },
];
