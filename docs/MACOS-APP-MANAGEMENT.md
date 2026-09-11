# The `wisp` rows in macOS App Management

Anyone who has run Wisp on a Mac for a while collects a column of identical,
unlabelled `wisp` entries in **System Settings ▸ Privacy & Security ▸ App
Management**. They are harmless, almost all of them are dead, and they can be
removed. This page explains where they come from, which ones still refer to a
real file, and how to make the ones you keep tell you apart from each other.

## Why the list fills up

macOS identifies an App Management client by its code signature, not by its
path. Wisp's daemon binary is ad-hoc signed — the macOS release script signs
with `codesign --sign -` and its manifest records `signing.kind: "ad-hoc"`,
`developerId: false`:

```console
$ codesign -dv /opt/homebrew/Cellar/wisp/0.5.5/bin/wisp
Identifier=wisp-55554944c7e7a979f99b34669ad6e56a63373a35
Signature=adhoc
TeamIdentifier=not set
```

An ad-hoc signature carries no stable identity for macOS to match against. Its
designated requirement pins the exact code directory hash of that one build, so
**every release, and every local `bun run build`, is a different client to
macOS**. Each one that ever touched an installed application earns its own row,
and the row survives the binary it was created for.

Two consequences follow, and both are visible in the list:

- the rows have no icon, because the client is a bare Mach-O rather than an
  application bundle, and a bare Mach-O has no icon of its own; and
- the rows are all named `wisp`, because that is the file name — the version,
  the install method, and the directory are nowhere in the list.

Wisp Desktop is not affected. It is a real signed, notarized `Wisp.app`, so it
appears once, by name, with its icon, however many times it updates.

## Telling a dead row from a live one

The placeholder icon already answers this, and it is the only signal the list
gives you:

| Icon in the row | What it means |
| --- | --- |
| blank white page | the recorded path no longer exists — an upgraded-away Homebrew version, a deleted `dist/wisp`, a removed worktree |
| dark `exec` tile | the file is still on disk |

Those are the two icons macOS substitutes when it is asked for the icon of a
missing file and of an existing Unix executable. **Every blank-page row is a
row for a binary that is gone**; it can never be used again, whatever its
toggle says, and deleting it costs nothing.

The `exec` rows are the live ones. Find out what they are with:

```sh
command -v wisp                 # the installed daemon, via its Homebrew symlink
ls -l "$(brew --prefix wisp)/bin/wisp"
```

Development is not among them. `wisp-dev` runs the daemon from source under
Bun and never compiles a binary, so a development session appears in this list
as `bun`, if at all. A `wisp` row can only come from a release or from your own
`bun run build`.

## Removing the rows you do not need

Select a row and click **−** under the list. macOS forgets that client
entirely. There is nothing to lose: a binary that still exists and later needs
the permission simply asks for it again, and a binary that no longer exists
cannot ask for anything.

To clear every App Management decision on the machine at once:

```sh
tccutil reset SystemPolicyAppBundles
```

That resets the service for *all* applications, not just Wisp, so every app in
the list has to ask again. Rows installed by a configuration profile — they say
*This setting has been configured by a profile* — are managed by your
organization and come straight back.

## Giving the rows you keep an icon

A custom Finder icon is the one label macOS will take for an unbundled
executable, and the repository generates two, so a stamped production binary
and a stamped local build are distinguishable at a glance:

```sh
bun run brand                                     # brand/cli-icon*.png
bash scripts/macos/stamp-icon.sh                  # the wisp on PATH
bash scripts/macos/stamp-icon.sh --dev dist/wisp  # a local build
```

Production takes the mark on the void, the same plate Wisp Desktop's icon
uses. Development takes it inverted onto light violet. Reopen System Settings
afterwards; the list reads the icon when it draws.

The icon belongs to the file, so an upgrade replaces it along with the binary:
run `stamp-icon.sh` again after `wisp update` or `brew upgrade wisp`. The new
version is a new App Management client regardless — the stamp is what makes the
new row recognizable, not something that carries over.

To take an icon back off:

```sh
bash scripts/macos/stamp-icon.sh --clear /path/to/wisp
```

### What stamping changes, and what it does not

A custom file icon is stored in the file's resource fork, beside the file
rather than inside the Mach-O. The code directory is untouched, so the cdhash,
the ad-hoc signature, the binary's identity to macOS, and any permission
already granted to it all survive, and `codesign --verify` still passes.

`codesign --verify --strict` does not: it rejects a resource fork on a Mach-O
as *detritus*. That check is exactly what the macOS release script runs against
every artifact it builds and re-extracts, which is why `stamp-icon.sh` refuses
to touch anything under `dist/release/` and why nothing in the release pipeline
stamps an icon. Stamp installed binaries, never artifacts you are about to
publish.

## The permanent fix

Stamping labels the rows; it does not stop new ones appearing, because each new
build is still a new client. Only a stable code identity does that. If the
daemon binary were signed with the same Developer ID Application certificate
the Desktop app already uses in the release workflow, every version would
satisfy one designated requirement, and Wisp would hold a single App Management
row across upgrades — named, with a team behind it, granted once.

That is a change to how `wisp` itself is released, not something a local script
can do. Until then, the rows accumulate, and the two icons above are what keeps
the list readable.

## See also

- [Install on macOS](INSTALL-MACOS.md) for the install, upgrade, and removal paths.
- [Desktop updates](DESKTOP-UPDATES.md) for the Developer ID, notarization, and
  stapling pipeline the Desktop app already goes through.
