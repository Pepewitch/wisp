/**
 * One import surface for every glyph in the app.
 *
 * Fluent Regular everywhere (the wisp-dev frontend reference) — `lucide-react` is not a
 * dependency and must never become one. Icons are passed as components, never
 * as string keys, and carry no size classes: their container sizes them.
 *
 * The brand mark is not here: it is generated from the real geometry into
 * ./wisp-mark.tsx by scripts/brand/build.ts, and re-exported below so callers
 * still have one import surface.
 */
export {
  AddRegular as Plus,
  ArchiveRegular as Archive,
  ArrowEnterLeftRegular as Enter,
  BranchRegular as Branch,
  BranchRequestRegular as BranchRequest,
  BotRegular as Bot,
  CheckmarkRegular as Check,
  CopyRegular as Copy,
  DataBarVerticalRegular as Effort,
  DeleteRegular as Trash,
  PromptRegular as Prompt,
  FolderRegular as Folder,
  SparkleRegular as Sparkle,
  StarFilled,
  StarRegular as Star,
  ArrowClockwiseRegular as Refresh,
  ArrowUpRegular as ArrowUp,
  AttachRegular as Attach,
  ChevronDownRegular as ChevronDown,
  ChevronRightRegular as ChevronRight,
  DismissRegular as Dismiss,
  EditRegular as Pencil,
  FolderAddRegular as FolderAdd,
  LineHorizontal3Regular as Hamburger,
  SettingsRegular as Gear,
  DesktopRegular as Local,
  MoreHorizontalRegular as More,
  StopRegular as Stop,
} from "@fluentui/react-icons"

export { WispMark } from "./wisp-mark"
