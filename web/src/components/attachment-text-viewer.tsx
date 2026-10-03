import { useState } from "react"

import { DataTable } from "@/components/attachment-table"
import { ViewerContent, ViewerFooter } from "@/components/file-viewer"
import { Download } from "@/components/icons"
import { PREVIEW_FOOTER_ACTION, PreviewPopup } from "@/components/preview-popup"
import { Tab } from "@/components/primitives"
import { useAssetSrc } from "@/lib/asset-src"
import { useAttachmentText, useDelimitedTable, type AttachmentText } from "@/lib/attachment-text"
import { columnCount, delimiterFor, rowCount, type DelimitedTable } from "@/lib/delimited"
import type { TurnAttachment } from "@/lib/types"

/**
 * A sent text attachment, read in the same popup the Changes tab opens a file
 * in. Markdown renders, a known language is highlighted, anything else is
 * plain mono — `ViewerContent` decides, so an attachment and a worktree file
 * can never read differently.
 *
 * A csv or tsv adds Table and Raw tabs where a worktree file has File and
 * Diff. The table draws at most twelve columns and a thousand rows; Raw shows
 * every byte the preview read.
 *
 * Pure, so the gallery renders the production popup from a fixture.
 */
export function TextPreviewPopup({
  attachment,
  data,
  pending,
  error,
  downloadHref,
  onClose,
}: {
  /** the file showing; null = closed */
  attachment: Pick<TurnAttachment, "name" | "size"> | null
  data: AttachmentText | undefined
  pending: boolean
  error: unknown
  /** a blob or proxy URL to save from; absent while it resolves */
  downloadHref: string | null
  onClose: () => void
}) {
  const [mode, setMode] = useState<"table" | "raw">("table")
  const [seen, setSeen] = useState(attachment?.name)
  if (seen !== attachment?.name) {
    setSeen(attachment?.name)
    setMode("table")
  }
  const delimiter = attachment ? delimiterFor(attachment.name) : null
  const table = useDelimitedTable(data, delimiter)
  const effective = table && table.header.length > 0 ? mode : "raw"
  const file =
    attachment && data
      ? { kind: "text" as const, path: attachment.name, text: data.text, bytes: attachment.size, truncated: data.truncated }
      : undefined

  return (
    <PreviewPopup
      open={attachment !== null}
      onClose={onClose}
      testId="attachment-text-viewer"
      title={attachment?.name ?? "Attachment"}
      flush={effective === "table"}
      tabs={
        delimiter && (
          <div role="tablist" aria-label="Attachment view" className="flex shrink-0 items-center gap-0.5">
            <Tab role="tab" aria-selected={effective === "table"} active={effective === "table"} onClick={() => setMode("table")}>
              Table
            </Tab>
            <Tab role="tab" aria-selected={effective === "raw"} active={effective === "raw"} onClick={() => setMode("raw")}>
              Raw
            </Tab>
          </div>
        )
      }
      footer={
        <ViewerFooter
          path={attachment?.name ?? null}
          file={file}
          mode="file"
          diffTruncated={false}
          action={
            attachment &&
            downloadHref && (
              <a href={downloadHref} download={attachment.name} className={PREVIEW_FOOTER_ACTION}>
                <Download />
                Download
              </a>
            )
          }
        >
          {table && effective === "table" && <TableFacts table={table} truncated={data?.truncated ?? false} />}
        </ViewerFooter>
      }
    >
      {effective === "table" && table ? (
        <FullTable table={table} />
      ) : (
        <ViewerContent pending={pending} error={error} file={file} mode="file" diffTruncated={false} />
      )}
    </PreviewPopup>
  )
}

function TableFacts({ table, truncated }: { table: DelimitedTable; truncated: boolean }) {
  const cutColumns = table.totalColumns > table.header.length
  return (
    <>
      <span className="shrink-0 text-faint">·</span>
      <span className="shrink-0">
        {rowCount(table, truncated)} × {columnCount(table)}
      </span>
      {cutColumns && (
        <span className="shrink-0 text-faint">
          · first {table.header.length} cols shown
        </span>
      )}
    </>
  )
}

function FullTable({ table }: { table: DelimitedTable }) {
  return (
    <>
      <DataTable table={table} numbered sticky />
      {table.totalRows > table.rows.length && (
        <p className="px-2.5 py-2 font-mono text-[11px] text-faint">
          Table stopped at {table.rows.length.toLocaleString()} rows for performance. Raw shows the rest of the preview.
        </p>
      )}
    </>
  )
}

/**
 * The popup for one sent attachment, reading its bytes only while it is open.
 * The inline table's read shares the cache key, so opening one is instant.
 */
export function AttachmentTextViewer({
  attachment,
  pathFor,
  onClose,
}: {
  attachment: TurnAttachment | null
  pathFor: (name: string) => string
  onClose: () => void
}) {
  const path = attachment ? pathFor(attachment.name) : null
  const query = useAttachmentText(path)
  const downloadHref = useAssetSrc(path)
  return (
    <TextPreviewPopup
      attachment={attachment}
      data={query.data}
      pending={query.isPending}
      error={query.isError ? query.error : null}
      downloadHref={downloadHref}
      onClose={onClose}
    />
  )
}
