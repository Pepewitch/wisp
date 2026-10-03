/**
 * A csv or tsv attachment, read as a table for its preview.
 *
 * The extension decides, not the bytes: the daemon stores every text file as
 * `text/plain`, and a paste the composer turned into a file already took its
 * `.csv` / `.tsv` from the same sniff the reader would repeat here.
 */

/** Columns a preview draws. Past this, the table says how many it left out. */
export const MAX_PREVIEW_COLUMNS = 12

/** Rows the full table draws. Raw still shows every byte the preview read. */
export const MAX_TABLE_ROWS = 1000

export type Delimiter = "," | "\t"

export function delimiterFor(name: string): Delimiter | null {
  const match = /\.(csv|tsv)$/i.exec(name)
  if (!match) return null
  return match[1]!.toLowerCase() === "csv" ? "," : "\t"
}

export interface DelimitedTable {
  /** at most `maxColumns` names */
  header: string[]
  /** at most `maxRows` records, each cut to `maxColumns` cells */
  rows: string[][]
  /** every record after the header, whether or not it was kept */
  totalRows: number
  /** the widest record seen, header included */
  totalColumns: number
}

/**
 * RFC 4180 records: a field that opens with `"` runs to its closing quote, a
 * doubled quote inside is one quote, and a delimiter or line break inside the
 * quotes is data. The same rule reads a tsv, because a spreadsheet's
 * clipboard quotes a cell that holds a tab or a newline.
 *
 * Bounded on purpose: cells past `maxColumns` and records past `maxRows` are
 * scanned for the counts but never stored, so a 500-column export costs the
 * memory of twelve.
 *
 * `complete: false` means the text is a prefix of the file. Its last record is
 * very likely cut mid-line, so it is dropped rather than shown wrong.
 */
export function parseDelimited(
  text: string,
  delimiter: Delimiter,
  {
    maxRows = MAX_TABLE_ROWS,
    maxColumns = MAX_PREVIEW_COLUMNS,
    complete = true,
  }: { maxRows?: number; maxColumns?: number; complete?: boolean } = {},
): DelimitedTable {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delim = delimiter.charCodeAt(0)
  let header: string[] | null = null
  const rows: string[][] = []
  let totalRows = 0
  let totalColumns = 0

  let record: string[] = []
  let width = 0
  let field = ""
  let quoted = false
  let i = 0

  const endField = () => {
    if (width < maxColumns) record.push(field)
    width += 1
    field = ""
  }
  const endRecord = () => {
    endField()
    // a blank line is not a record of one empty cell
    if (width === 1 && record[0] === "") {
      record = []
      width = 0
      return
    }
    totalColumns = Math.max(totalColumns, width)
    if (header === null) header = record
    else {
      totalRows += 1
      if (rows.length < maxRows) rows.push(record)
    }
    record = []
    width = 0
  }

  while (i < source.length) {
    const c = source.charCodeAt(i)
    if (quoted) {
      if (c === 0x22) {
        if (source.charCodeAt(i + 1) === 0x22) {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      const next = source.indexOf('"', i)
      const end = next === -1 ? source.length : next
      field += source.slice(i, end)
      i = end
      continue
    }
    if (c === 0x22 && field === "") {
      quoted = true
      i += 1
    } else if (c === delim) {
      endField()
      i += 1
    } else if (c === 0x0a || c === 0x0d) {
      endRecord()
      i += c === 0x0d && source.charCodeAt(i + 1) === 0x0a ? 2 : 1
    } else {
      let end = i + 1
      while (end < source.length) {
        const n = source.charCodeAt(end)
        if (n === delim || n === 0x0a || n === 0x0d) break
        end += 1
      }
      field += source.slice(i, end)
      i = end
    }
  }
  if (complete && (field !== "" || width > 0 || quoted)) endRecord()

  return { header: header ?? [], rows, totalRows, totalColumns }
}

const NUMERIC = /^[-+]?(?:\d[\d,]*)?(?:\.\d+)?(?:e[-+]?\d+)?%?$/i

/**
 * A column reads as numbers when every non-empty cell is one, so it can be
 * right-aligned. An all-empty column is not numeric: there is nothing to line up.
 */
export function numericColumns(table: Pick<DelimitedTable, "header" | "rows">): boolean[] {
  return table.header.map((_, c) => {
    let seen = false
    for (const row of table.rows) {
      const cell = (row[c] ?? "").trim()
      if (cell === "") continue
      if (!/\d/.test(cell) || !NUMERIC.test(cell)) return false
      seen = true
    }
    return seen
  })
}

/** "15 rows", or "1,204+ rows" when the preview stopped reading before the file ended. */
export function rowCount(table: DelimitedTable, truncated: boolean): string {
  const n = table.totalRows
  return `${n.toLocaleString()}${truncated ? "+" : ""} ${n === 1 && !truncated ? "row" : "rows"}`
}

export function columnCount(table: DelimitedTable): string {
  return `${table.totalColumns.toLocaleString()} ${table.totalColumns === 1 ? "col" : "cols"}`
}
