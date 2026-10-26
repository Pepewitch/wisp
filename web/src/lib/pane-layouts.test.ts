import { describe, expect, it } from "vitest"

import { migrateSavedLayouts } from "./pane-layouts"

function storage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

const key = (id: string) => `react-resizable-panels:${id}`

describe("moving the always-open right column's saved layouts", () => {
  it("gives the old right column's share back to the centre and keeps it as the panel's width", () => {
    const store = storage({
      [key("wisp-ui-main")]: JSON.stringify({ sidebar: 18, centre: 54, right: 28 }),
      [key("wisp-ui-right")]: JSON.stringify({ changes: 62, terminal: 38 }),
    })
    migrateSavedLayouts(store, 1500)
    expect(JSON.parse(store.map.get(key("wisp-ui-main-v2"))!)).toEqual({ sidebar: 18, centre: 82, tool: 0 })
    expect(store.map.get("wisp_tool_panel_width")).toBe("420")
    expect(JSON.parse(store.map.get(key("wisp-ui-dock"))!)).toEqual({ tool: 62, terminal: 38 })
    // the old ids are gone, so this runs once
    expect(store.map.has(key("wisp-ui-main"))).toBe(false)
    expect(store.map.has(key("wisp-ui-right"))).toBe(false)
  })

  it("drops an unreadable old layout rather than guessing, so the defaults apply", () => {
    const store = storage({
      [key("wisp-ui-main")]: "{not json",
      [key("wisp-ui-right")]: JSON.stringify({ changes: "a lot" }),
    })
    migrateSavedLayouts(store, 1500)
    expect([...store.map.keys()]).toEqual([])
  })

  it("never overwrites a layout the new ids already saved", () => {
    const saved = JSON.stringify({ sidebar: 20, centre: 55, tool: 25 })
    const store = storage({
      [key("wisp-ui-main")]: JSON.stringify({ sidebar: 18, centre: 54, right: 28 }),
      [key("wisp-ui-main-v2")]: saved,
    })
    migrateSavedLayouts(store, 1500)
    expect(store.map.get(key("wisp-ui-main-v2"))).toBe(saved)
    expect(store.map.has("wisp_tool_panel_width")).toBe(false)
  })

  it("keeps a narrow old column at the panel's minimum", () => {
    const store = storage({ [key("wisp-ui-main")]: JSON.stringify({ sidebar: 20, centre: 70, right: 10 }) })
    migrateSavedLayouts(store, 1200)
    expect(store.map.get("wisp_tool_panel_width")).toBe("320")
  })
})
