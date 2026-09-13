import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"

import { completeAuth, requireAuth } from "@/lib/api"
import { AuthDialog } from "./auth-dialog"

beforeEach(() => {
  completeAuth("test-reset")
  localStorage.clear()
  vi.restoreAllMocks()
})

it("masks the credential and never restores it when reauthentication opens", async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  const firstGate = requireAuth()
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 204 }),
  )

  render(
    <QueryClientProvider client={client}>
      <AuthDialog />
    </QueryClientProvider>,
  )

  const input = await screen.findByPlaceholderText("Paste the token")
  expect(input).toHaveAttribute("type", "password")
  expect(input).toHaveAttribute("autocomplete", "off")
  expect(input).toHaveAttribute("spellcheck", "false")

  fireEvent.change(input, { target: { value: "  full-control-token  " } })
  fireEvent.click(screen.getByRole("button", { name: "Connect" }))
  await firstGate
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Daemon token" })).not.toBeInTheDocument(),
  )

  const secondGate = requireAuth()
  expect(await screen.findByPlaceholderText("Paste the token")).toHaveValue("")
  completeAuth("test-cleanup")
  await secondGate
})
