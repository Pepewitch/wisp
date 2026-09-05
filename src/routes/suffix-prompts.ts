import {
  createSuffixPrompt,
  deleteSuffixPrompt,
  DuplicateSuffixPromptNameError,
  listSuffixPrompts,
  updateSuffixPrompt,
} from "../suffix-prompts";
import { typeName } from "../validate";
import { err, json } from "./http";

/** GET /api/suffix-prompts */
export function listSuffixPromptsRoute(): Response {
  return json({ suffixPrompts: listSuffixPrompts() });
}

/** POST /api/suffix-prompts */
export function createSuffixPromptRoute(req: Request): Promise<Response> {
  return (async () => {
    const body = (await req.json().catch(() => ({}))) as { name?: unknown; prompt?: unknown };
    const fields = readSuffixPromptFields(body);
    if (fields instanceof Response) return fields;
    try {
      return json(createSuffixPrompt(fields.name, fields.prompt), 201);
    } catch (error) {
      if (error instanceof DuplicateSuffixPromptNameError) return err(error.message, 409);
      throw error;
    }
  })();
}

/**
 * Validate the editable fields of a suffix prompt body. Returns the cleaned
 * values, or a Response when the body is invalid — the create and update
 * routes share these rules so a rename can never smuggle in a shape the
 * create route would reject.
 */
function readSuffixPromptFields(
  body: { name?: unknown; prompt?: unknown },
): { name: string; prompt: string } | Response {
  if (body.name === undefined || body.prompt === undefined) {
    return err("name and prompt are required", 400);
  }
  if (typeof body.name !== "string") return err(`name must be a string, got ${typeName(body.name)}`, 400);
  if (body.name.trim() === "") return err("name must not be empty", 400);
  if (typeof body.prompt !== "string") {
    return err(`prompt must be a string, got ${typeName(body.prompt)}`, 400);
  }
  if (body.prompt.trim() === "") return err("prompt must not be empty", 400);
  return { name: body.name, prompt: body.prompt };
}

/** PATCH /api/suffix-prompts/:id — full replace of the editable fields. */
export function updateSuffixPromptRoute(req: Request, id: string): Promise<Response> {
  return (async () => {
    const body = (await req.json().catch(() => ({}))) as { name?: unknown; prompt?: unknown };
    const fields = readSuffixPromptFields(body);
    if (fields instanceof Response) return fields;
    try {
      const saved = updateSuffixPrompt(id, fields.name, fields.prompt);
      if (!saved) return err(`no such suffix prompt: ${id}`, 404);
      return json(saved);
    } catch (error) {
      if (error instanceof DuplicateSuffixPromptNameError) return err(error.message, 409);
      throw error;
    }
  })();
}

/** DELETE /api/suffix-prompts/:id */
export function deleteSuffixPromptRoute(id: string): Response {
  if (!deleteSuffixPrompt(id)) return err(`no such suffix prompt: ${id}`, 404);
  return json({ ok: true });
}
