import { useState, type ReactNode } from "react"

import { TablePreviewCard, TextAttachmentRow } from "@/components/attachment-table"
import { TextPreviewPopup } from "@/components/attachment-text-viewer"
import { Section } from "@/components/gallery-chrome"
import { PersonBubble } from "@/components/person-bubble"
import { Eyebrow } from "@/components/primitives"
import type { AttachmentText } from "@/lib/attachment-text"
import { delimiterFor, parseDelimited } from "@/lib/delimited"

/**
 * The gallery's text-attachment specimens: the production row, inline table
 * and reading popup, fed fixtures because the gallery has no daemon to read
 * bytes from.
 */

const ORDERS_CSV = [
  "order_id,region,sku,qty,unit_price,total",
  "A-1001,north,LAMP-02,3,24.00,72.00",
  "A-1002,south,MUG-11,12,6.50,78.00",
  "A-1003,east,DESK-07,1,189.00,189.00",
  "A-1004,west,LAMP-02,2,24.00,48.00",
  "A-1005,north,CHAIR-4,4,72.25,289.00",
  "A-1006,east,MUG-11,6,6.50,39.00",
  "A-1007,south,SHELF-3,1,95.00,95.00",
  "A-1008,west,DESK-07,2,189.00,378.00",
  "A-1009,north,MUG-11,24,6.50,156.00",
  "A-1010,east,CHAIR-4,1,72.25,72.25",
  "A-1011,south,LAMP-02,5,24.00,120.00",
  "A-1012,west,SHELF-3,2,95.00,190.00",
].join("\n")

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const SENSORS_TSV = [
  ["sensor", "site", ...MONTHS.map((m) => `${m}_avg`), "min", "max", "unit", "status"].join("\t"),
  ...Array.from({ length: 9 }, (_, i) =>
    [
      `s-${String(i + 1).padStart(2, "0")}`,
      ["roof", "lab", "yard"][i % 3],
      ...MONTHS.map((_, m) => (18 + ((i * 7 + m * 3) % 11) + 0.5).toFixed(1)),
      "12.0",
      "31.5",
      "°C",
      i % 4 === 0 ? "check" : "ok",
    ].join("\t"),
  ),
].join("\n")

const NOTES_MD = `# Release checklist

- [x] bump the version
- [ ] write the notes
- [ ] tag and push

\`\`\`sh
bun run release:check
\`\`\`
`

type Fixture = { name: string; text: string }

const ORDERS: Fixture = { name: "orders.csv", text: ORDERS_CSV }
const SENSORS: Fixture = { name: "sensors.tsv", text: SENSORS_TSV }
const NOTES: Fixture = { name: "checklist.md", text: NOTES_MD }

const bytes = (text: string) => new TextEncoder().encode(text).length
const read = (f: Fixture): AttachmentText => ({ text: f.text, truncated: false })

function TableSpecimen({ file, onOpen }: { file: Fixture; onOpen: () => void }) {
  return (
    <TablePreviewCard
      name={file.name}
      size={bytes(file.text)}
      table={parseDelimited(file.text, delimiterFor(file.name)!)}
      truncated={false}
      onOpen={onOpen}
    />
  )
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="mt-2.5 rounded-lg border border-border bg-surface p-3">{children}</div>
}

export function AttachmentPreviewSpecimens() {
  const [open, setOpen] = useState<Fixture | null>(null)
  return (
    <Section title="Text attachments — read them where they were sent">
      <div className="grid grid-cols-2 gap-10">
        <div>
          <Eyebrow>Text file — the row opens the reader</Eyebrow>
          <Frame>
            <PersonBubble>here is where the release stands</PersonBubble>
            <div className="mt-1.5 flex flex-col items-end">
              <TextAttachmentRow attachment={{ name: NOTES.name, size: bytes(NOTES.text) }} onOpen={() => setOpen(NOTES)} />
            </div>
          </Frame>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            The row stays one muted line. Clicking it opens the popup the Changes tab opens a file in, and the file
            reads exactly as a worktree file would: Markdown rendered, a known language highlighted, anything else
            plain mono. Download lives in the popup&apos;s footer. The preview reads at most 512 KB and says so when it
            stopped early.
          </p>

          <Eyebrow className="mt-8 block">Wider than twelve columns</Eyebrow>
          <Frame>
            <PersonBubble>monthly averages per sensor</PersonBubble>
            <div className="mt-1.5 flex flex-col items-end">
              <TableSpecimen file={SENSORS} onOpen={() => setOpen(SENSORS)} />
            </div>
          </Frame>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            A table draws twelve columns at most, inline and in the popup; the parser never stores the rest. One faint
            trailing column says how many were left out, so a cut table cannot pass for the whole file. Raw still
            shows every column.
          </p>
        </div>
        <div>
          <Eyebrow>csv / tsv — the first rows inline</Eyebrow>
          <Frame>
            <PersonBubble>which regions are behind this week?</PersonBubble>
            <div className="mt-1.5 flex flex-col items-end">
              <TableSpecimen file={ORDERS} onOpen={() => setOpen(ORDERS)} />
            </div>
          </Frame>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            Five rows on the code surface, numbers right-aligned, a wide table scrolls sideways inside its card. One
            footer line gives the shape and size, and <span className="text-foreground/80">View all</span> opens the
            popup with Table and Raw tabs. The full table stops at a thousand rows; quoted fields, CRLF and a BOM all
            parse. Until the bytes land the card is the plain text row, never an empty box.
          </p>
        </div>
      </div>
      <TextPreviewPopup
        attachment={open && { name: open.name, size: bytes(open.text) }}
        data={open ? read(open) : undefined}
        pending={false}
        error={null}
        downloadHref={null}
        onClose={() => setOpen(null)}
      />
    </Section>
  )
}
