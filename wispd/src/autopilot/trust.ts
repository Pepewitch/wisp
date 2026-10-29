/**
 * Whose words on a PR may instruct its author agent: the owner's account, a
 * bot other than github-actions, or someone who can push to the repository.
 * Who can push is asked of GitHub once an hour per login. Beside runtime.ts
 * because that file is at its size limit.
 */
import { unlessPaused } from "../github-budget"
import type { Task } from "../types"
import type { AutopilotGitHub, PrSnapshot } from "./github"

export type Trusts = (author: { author: string | null; bot: boolean }) => boolean

export class PushTrust {
  private readonly pushers = new Map<string, { ok: boolean; until: number }>()

  constructor(private readonly github: AutopilotGitHub, private readonly now: () => Date) {}

  async trustsFor(pr: PrSnapshot, repository: string, task: Task, signal: AbortSignal): Promise<Trusts> {
    const people = new Set<string>()
    for (const words of [...pr.reviews, ...pr.comments, ...pr.threads.flatMap((thread) => thread.comments)]) {
      if (words.author && !words.bot && words.author !== pr.viewer) people.add(words.author)
    }
    const pushers = new Set<string>()
    await Promise.all([...people].map(async (login) => {
      if (await this.canPush(repository, login, task.repo_path, signal)) pushers.add(login)
    }))
    return ({ author, bot }) => author !== null && (author === pr.viewer || (bot && author !== "github-actions") || pushers.has(author))
  }

  /** Whether a login may instruct the agent: cached an hour, and a failed read counts as no for five minutes. */
  private async canPush(repository: string, login: string, cwd: string, signal: AbortSignal): Promise<boolean> {
    const key = `${repository}#${login}`
    const hit = this.pushers.get(key)
    const now = this.now().getTime()
    if (hit && now < hit.until) return hit.ok
    const ok = await this.github.canPush(repository, login, cwd, signal).then((value) => ({ value, known: true }), unlessPaused({ value: false, known: false }))
    this.pushers.set(key, { ok: ok.value, until: now + (ok.known ? 60 * 60_000 : 5 * 60_000) })
    return ok.value
  }
}
