import type { StagedAttachmentPayload } from "./attachments";
import { wispCommand } from "./command";
import { loadConfig, type WispConfig } from "./config";

class CliApiError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly unreachable = false,
  ) {
    super(message);
  }
}

let daemonConfig: WispConfig | undefined;

export async function daemonRequest(
  path: string,
  method = "GET",
  body?: BodyInit,
  contentType = "application/json",
): Promise<any> {
  const cfg = daemonConfig ??= loadConfig();
  const url = `http://${cfg.host}:${cfg.port}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": contentType },
      body,
    });
  } catch {
    throw new CliApiError("daemon is unreachable", url, true);
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new CliApiError(
      typeof data.error === "string" ? data.error : response.statusText,
      url,
    );
  }
  return data;
}

export async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  try {
    return await daemonRequest(
      path,
      method,
      body === undefined ? undefined : JSON.stringify(body),
    );
  } catch (error) {
    exitApi(error);
  }
}

/** Stream one file body to the daemon; no base64 or whole-file JS buffer. */
export async function uploadAttachment(
  path: string,
  name: string,
): Promise<StagedAttachmentPayload> {
  const data = await daemonRequest(
    `/api/attachments?name=${encodeURIComponent(name)}`,
    "POST",
    Bun.file(path),
    "application/octet-stream",
  ) as Record<string, unknown>;
  if (typeof data.uploadId !== "string") {
    throw new Error("daemon returned an invalid attachment upload response");
  }
  return { name, uploadId: data.uploadId };
}

export async function discardAttachment(uploadId: string): Promise<void> {
  await daemonRequest(`/api/attachments/${encodeURIComponent(uploadId)}`, "DELETE");
}

export function exitApi(error: unknown): never {
  if (error instanceof CliApiError && error.unreachable) {
    console.error(
      `cannot reach wispd at ${error.url} — is it running? start it with: ${wispCommand()} serve`,
    );
  } else {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}
