import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import { Gallery } from "@/components/gallery"

describe("Gallery", () => {
  test("renders the retained route with its dialog specimens", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <Gallery />
      </QueryClientProvider>,
    )

    expect(screen.getByRole("heading", { name: "Graphite & violet", level: 1 })).toBeInTheDocument()
    expect(screen.getByText("A configured project")).toBeInTheDocument()
    expect(screen.getAllByLabelText("Setup script")).toHaveLength(2)
    expect(screen.getAllByLabelText("Archive script")).toHaveLength(2)
    expect(screen.getAllByLabelText("Files to copy")).toHaveLength(2)
    // only the configured specimen can unregister; the history-only one cannot
    expect(screen.getAllByRole("button", { name: "Remove from Wisp" })).toHaveLength(1)
  })
})
