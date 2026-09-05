import { UpdateManager } from "../update";
import { err, json } from "./http";

export function updateRoute(
  req: Request,
  path: string,
  method: string,
  updates: UpdateManager,
): Response | Promise<Response> | null {
  if (path !== "/api/update") return null;
  if (method === "GET") return updates.getStatus().then((status) => json(status));
  if (method !== "POST") return err("not found", 404);
  return req
    .json()
    .catch(() => ({}))
    .then((body) => updates.start((body as { version?: unknown }).version))
    .then((status) => json(status, 202))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      return err(message, message === "an update is already in progress" ? 409 : 400);
    });
}
