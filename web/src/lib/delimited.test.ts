import { describe, expect, it } from "vitest"

import { delimiterFor, numericColumns, parseDelimited } from "./delimited"

describe("delimiterFor", () => {
  it("reads the extension, in any case, and nothing else", () => {
    expect(delimiterFor("orders.csv")).toBe(",")
    expect(delimiterFor("pasted-2.TSV")).toBe("\t")
    expect(delimiterFor("notes.txt")).toBeNull()
    expect(delimiterFor("csv")).toBeNull()
    expect(delimiterFor("orders.csv.txt")).toBeNull()
  })
})

describe("parseDelimited", () => {
  it("splits a header from its records and counts both dimensions", () => {
    const table = parseDelimited("sku,qty\nA-1,3\nB-2,5\n", ",")
    expect(table.header).toEqual(["sku", "qty"])
    expect(table.rows).toEqual([["A-1", "3"], ["B-2", "5"]])
    expect(table.totalRows).toBe(2)
    expect(table.totalColumns).toBe(2)
  })

  it("honours quoted fields: delimiters, doubled quotes and line breaks are data", () => {
    const table = parseDelimited('name,note\n"Lee, Sam","said ""hi""\nthen left"\n', ",")
    expect(table.rows).toEqual([["Lee, Sam", 'said "hi"\nthen left']])
  })

  it("reads tsv with CRLF endings, a BOM, and skips blank lines", () => {
    const table = parseDelimited("\ufeffa\tb\r\n1\t2\r\n\r\n3\t4", "\t")
    expect(table.header).toEqual(["a", "b"])
    expect(table.rows).toEqual([["1", "2"], ["3", "4"]])
  })

  it("keeps at most maxColumns cells but reports the true width", () => {
    const wide = Array.from({ length: 30 }, (_, i) => `c${i}`).join(",")
    const table = parseDelimited(`${wide}\n${wide}\n`, ",", { maxColumns: 12 })
    expect(table.header).toHaveLength(12)
    expect(table.rows[0]).toHaveLength(12)
    expect(table.totalColumns).toBe(30)
  })

  it("keeps at most maxRows records but counts every one", () => {
    const body = Array.from({ length: 50 }, (_, i) => String(i)).join("\n")
    const table = parseDelimited(`n\n${body}\n`, ",", { maxRows: 5 })
    expect(table.rows).toHaveLength(5)
    expect(table.totalRows).toBe(50)
  })

  it("drops the cut-off last record of a prefix, and keeps it for a whole file", () => {
    expect(parseDelimited("a,b\n1,2\n3,", ",", { complete: false }).rows).toEqual([["1", "2"]])
    expect(parseDelimited("a,b\n1,2\n3,", ",").rows).toEqual([["1", "2"], ["3", ""]])
  })
})

describe("numericColumns", () => {
  it("right-aligns a column only when every filled cell is a number", () => {
    const table = parseDelimited("id,price,share,label,blank\n7,1200.50,12%,x,\n8,,3.1e2,y,\n", ",")
    expect(numericColumns(table)).toEqual([true, true, true, false, false])
  })
})
