import { useMemo } from "react"

import { formatBytes } from "@/lib/attachments"
import { useAttachmentText, useDelimitedTable } from "@/lib/attachment-text"
import { columnCount, numericColumns, rowCount, type Delimiter, type DelimitedTable } from "@/lib/delimited"
import type { TurnAttachment } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Rows a csv or tsv shows under its prompt bubble before "View all". */
const INLINE_TABLE_ROWS = 5

/**
 * A parsed table as mono rows on the code surface.
 *
 * Only `header.length` columns ever reach the DOM (the parser already cut each
 * record there). When the file is wider, one trailing faint column says how
 * many were left out, so a cut table never reads as the whole file. A cell
 * longer than its column truncates with an ellipsis and keeps the full value
 * in its title.
 */
export function DataTable({
  table,
  rows = table.rows,
  numbered = false,
  sticky = false,
}: {
  table: DelimitedTable
  /** the records to draw, when fewer than `table.rows` */
  rows?: string[][]
  /** a gutter of row numbers, for the full view */
  numbered?: boolean
  /** keep the header in view while the popup scrolls */
  sticky?: boolean
}) {
  const numeric = useMemo(() => numericColumns(table), [table])
  const hidden = table.totalColumns - table.header.length
  const th = cn(
    "border-b border-border px-2.5 py-1 text-left font-medium whitespace-nowrap text-muted-foreground",
    sticky && "sticky top-0 bg-code",
  )
  const td = "max-w-[32ch] truncate px-2.5 py-0.5 whitespace-nowrap"
  return (
    <table className="w-full border-collapse font-mono text-[11px] leading-[1.6]">
      <thead>
        <tr>
          {numbered && <th className={cn(th, "w-0 pr-1 text-right text-faint")} aria-label="Row" />}
          {table.header.map((name, c) => (
            <th key={c} title={name} className={cn(th, "max-w-[32ch] truncate", numeric[c] && "text-right")}>
              {name}
            </th>
          ))}
          {hidden > 0 && (
            <th
              data-testid="table-hidden-columns"
              className={cn(th, "font-normal text-faint")}
              title={`${hidden.toLocaleString()} more ${hidden === 1 ? "column" : "columns"} not shown; Raw has them`}
            >
              +{hidden.toLocaleString()} {hidden === 1 ? "col" : "cols"}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r} className="hover:bg-accent/40">
            {numbered && <td className="w-0 px-2.5 py-0.5 pr-1 text-right text-faint select-none">{r + 1}</td>}
            {table.header.map((_, c) => {
              const cell = row[c] ?? ""
              return (
                <td
                  key={c}
                  title={cell.length > 32 ? cell : undefined}
                  className={cn(td, "text-foreground/85", numeric[c] && "text-right tabular-nums")}
                >
                  {cell}
                </td>
              )
            })}
            {hidden > 0 && (
              <td aria-hidden className={cn(td, "text-faint")}>
                …
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * A csv or tsv under its prompt bubble: the first rows, the file's shape on
 * one footer line, and the way into the rest. Pure, so the gallery renders
 * the production card from a fixture.
 */
export function TablePreviewCard({
  name,
  size,
  table,
  truncated,
  onOpen,
}: {
  name: string
  size: number
  table: DelimitedTable
  truncated: boolean
  onOpen: () => void
}) {
  const more = truncated || table.totalRows > INLINE_TABLE_ROWS
  return (
    <div
      data-testid="attachment-table"
      className="flex max-w-[76%] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-code"
    >
      <div className="scroll-slim max-w-full overflow-x-auto">
        <DataTable table={table} rows={table.rows.slice(0, INLINE_TABLE_ROWS)} />
      </div>
      <div className="flex items-center gap-2 border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate font-mono">{name}</span>
        <span className="shrink-0 text-faint">·</span>
        <span className="shrink-0">
          {rowCount(table, truncated)} × {columnCount(table)}
        </span>
        {/* the trailing "+N cols" column may be scrolled out of view, so the cap is said here too */}
        {table.totalColumns > table.header.length && (
          <span data-testid="table-columns-shown" className="shrink-0 text-faint">
            ({table.header.length} shown)
          </span>
        )}
        <span className="shrink-0 text-faint">·</span>
        <span className="shrink-0">{formatBytes(size)}</span>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Preview ${name}`}
          className="ml-auto shrink-0 rounded-sm px-1 whitespace-nowrap text-foreground/80 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {more ? `View all ${rowCount(table, truncated)}` : "Open"}
        </button>
      </div>
    </div>
  )
}

/** The muted one-line row a text attachment is, opening its preview on click. */
export function TextAttachmentRow({
  attachment,
  onOpen,
}: {
  attachment: Pick<TurnAttachment, "name" | "size">
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Preview ${attachment.name}`}
      title={`Preview ${attachment.name}`}
      className="max-w-[76%] cursor-pointer truncate text-[11.5px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {attachment.name} · text · {formatBytes(attachment.size)}
    </button>
  )
}

/**
 * A sent csv or tsv, read and drawn inline. Until the bytes land — or if they
 * never do — it is the same one-line row any text file is, so the transcript
 * never shows an empty card.
 */
export function AttachmentTablePreview({
  path,
  attachment,
  delimiter,
  onOpen,
}: {
  path: string
  attachment: TurnAttachment
  delimiter: Delimiter
  onOpen: () => void
}) {
  const query = useAttachmentText(path)
  const table = useDelimitedTable(query.data, delimiter)
  if (!table || !query.data || table.header.length === 0) {
    return <TextAttachmentRow attachment={attachment} onOpen={onOpen} />
  }
  return (
    <TablePreviewCard
      name={attachment.name}
      size={attachment.size}
      table={table}
      truncated={query.data.truncated}
      onOpen={onOpen}
    />
  )
}
