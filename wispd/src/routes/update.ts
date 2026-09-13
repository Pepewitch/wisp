import { UpdateManager } from "../update";
import { err, json, jsonObjectBody } from "./http";

export function updateRoute(
  req: Request,
  path: string,
  method: string,
  updates: UpdateManager,
): Response | Promise<Response> | null {
  if (path !== "/api/update") return null;
  if (method === "GET") {
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    return (refresh ? updates.refreshStatus() : updates.getStatus()).then((status) => json(status));
  }
  if (method !== "POST") return err("not found", 404);
  return (async () => {
    const body = await jsonObjectBody(req);
    if (body instanceof Response) return body;
    try {
      return json(await updates.start(body.version), 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(message, message === "an update is already in progress" ? 409 : 400);
    }
  })();
}
