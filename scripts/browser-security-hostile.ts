/**
 * The hostile-content half of `browser-security-check.ts`: fixtures seeded
 * into the scratch task's transcript, and the checks that run against them.
 * Kept apart only so each file stays readable; the main script owns the
 * browser, the daemon, and the order checks run in.
 */

/** What the checks need from the main script's DevTools page. */
export interface HostilePage {
  client: { events: { method: string; params: Record<string, unknown> }[] };
  evaluate(expression: string): Promise<unknown>;
}

export interface HostileCheckTools {
  check(name: string, condition: boolean, detail: string): void;
  waitInPage(page: HostilePage, predicate: string, what: string, ms?: number): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Agent output that tries to reach the network or leave the app through the
 * two renderers that need no click: Mermaid, and raw HTML in prose. Every
 * remote reference names `BEACON`, so one filter over the network log finds
 * any request that got out. `.invalid` never resolves, but the attempt is
 * still recorded.
 */
const BEACON = "https://example.invalid/wisp-mermaid-beacon";
export const HOSTILE_PROSE = [
  // an HTML-label image, a form in a label, and a `click` link on a node
  "```mermaid\nflowchart TD\n" +
    `  L["<img src='${BEACON}/label.png'>"] --> F["<form action='${BEACON}/form'><input name=q><button>go</button></form>"]\n` +
    `  F --> C["Session expired - reconnect"]\n  click C "${BEACON}/click"\n` +
    "```",
  // an image shape, which mermaid loads during layout: it must stay source
  "```mermaid\nflowchart TD\n" + `  S@{ img: "${BEACON}/shape.png", label: "image shape fixture" }\n` + "```",
  // class and state diagrams apply style/classDef CSS during layout, outside any
  // sanitizer, and themeVariables accept a relative url(): all must stay source
  "```mermaid\nclassDiagram\n  class K1\n" +
    `  style K1 fill:url(${BEACON}/classstyle),background-image:url(${BEACON}/classstyle2)\n` + "```",
  "```mermaid\nstateDiagram-v2\n  [*] --> S1\n" +
    `  classDef bad background-image:url(${BEACON}/stateclassdef.png)\n  class S1 bad\n` + "```",
  '```mermaid\n%%{init:{"themeVariables":{"nodeBorder":"url(wisp-mermaid-beacon-theme)"}}}%%\nflowchart TD\n  T1 --> T2\n```',
  // and diagrams that must still render as they always have
  "```mermaid\nflowchart LR\n  N1[\"first line<br>second line\"] --> N2\n  subgraph G [Grouped fixture]\n    N3 --> N4\n  end\n```",
  "```mermaid\nsequenceDiagram\n  Alice->>Bob: Sequence fixture\n  Bob-->>Alice: Reply\n```",
  "```mermaid\nclassDiagram\n  class ClassFixture {\n    +String name\n    +run()\n  }\n  ClassFixture <|-- Child\n```",
  // DOM clobbering: an agent id that shadows the app's own runtime check
  '<div id="isTauri">clobber fixture</div>\n\n[External link fixture](https://example.invalid/wisp-link-fixture)',
];
/** Diagrams in HOSTILE_PROSE that render (not the image shape or url() styles), plus `A --> B`. */
const RENDERED_DIAGRAMS = 5;

/**
 * Hostile agent output renders without a click, so it must neither fetch nor
 * navigate: no request to the beacon, no form or link left in a diagram, a
 * click on the "link" node goes nowhere, and an agent `id` cannot shadow the
 * app's runtime check (which would cancel every link in a browser tab).
 * Ordinary diagrams must still render. Runs on the page `checkMermaidRecovery`
 * reloaded, whose network log starts at that reload.
 */
export async function checkHostileContent(page: HostilePage, { check, waitInPage }: HostileCheckTools): Promise<void> {
  // the diagram itself, not the zoom buttons' icons beside it
  const diagrams = `Array.from(document.querySelectorAll('[role="application"][aria-label="Mermaid diagram"] > div > svg'))`;
  await waitInPage(page, `${diagrams}.length >= ${RENDERED_DIAGRAMS}`, "the fixture diagrams", 30_000);
  // the image-shape fence settles as source; give it the time a render takes
  await sleep(1_500);
  const text = String(await page.evaluate(`${diagrams}.map(svg => svg.textContent).join(" | ")`));
  check("ordinary Mermaid diagrams still render (labels, <br>, subgraph, sequence, class)",
    ["first line", "second line", "Grouped fixture", "Sequence fixture", "ClassFixture", "Session expired"].every(part => text.includes(part)),
    text.slice(0, 500));
  const count = Number(await page.evaluate(`${diagrams}.length`));
  const shapeSource = await page.evaluate(`['image shape fixture', 'classstyle2', 'stateclassdef', 'beacon-theme'].every(part =>
    Array.from(document.querySelectorAll('pre')).some(pre => pre.textContent.includes(part)))`);
  check("diagrams with a remote image shape or url() styles stay source", count === RENDERED_DIAGRAMS && shapeSource === true,
    `${count} diagrams rendered; every refused fence visible as source: ${String(shapeSource)}`);
  const surviving = await page.evaluate(`${diagrams}.flatMap(svg => Array.from(svg.querySelectorAll('a, form, input, button, select, textarea, img'))).map(e => e.outerHTML.slice(0, 160))`) as string[];
  check("no link, form, or image element survives in a diagram", surviving.length === 0, surviving.join("; "));
  check("no diagram references the remote origin", await page.evaluate(`${diagrams}.every(svg => !svg.outerHTML.includes('wisp-mermaid-beacon'))`) === true, "a beacon URL is in the rendered SVG");

  const clobbered = await page.evaluate("document.getElementById('isTauri') !== null || 'isTauri' in window");
  check("agent HTML cannot shadow a window global by id", clobbered === false, "an element with id=isTauri reached the page");
  const link = await page.evaluate(`(() => {
    const anchor = Array.from(document.querySelectorAll('a')).find(a => a.textContent === 'External link fixture');
    if (!anchor) return { found: false };
    let prevented = null;
    // last in line, after React's own handler: record, then stop the real navigation
    const spy = event => { prevented = event.defaultPrevented; event.preventDefault(); };
    window.addEventListener('click', spy);
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    window.removeEventListener('click', spy);
    return { found: true, prevented, target: anchor.target };
  })()`) as { found: boolean; prevented?: boolean | null; target?: string };
  check("prose links still open in the browser next to agent HTML", link.found && link.prevented === false && link.target === "_blank", JSON.stringify(link));

  // last: on a regression this navigates the page away
  const before = String(await page.evaluate("location.href"));
  await page.evaluate(`(() => {
    const node = ${diagrams}.flatMap(svg => Array.from(svg.querySelectorAll('*')))
      .find(element => element.childElementCount === 0 && element.textContent.trim() === 'Session expired - reconnect');
    node?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  })()`);
  await sleep(1_000);
  const after = String(await page.evaluate("location.href"));
  check("a Mermaid click link does not navigate the window", after === before, `navigated from ${before} to ${after}`);

  const beacons = page.client.events
    .filter(event => event.method === "Network.requestWillBeSent")
    .map(event => String((event.params.request as { url?: string }).url ?? ""))
    .filter(url => url.includes("wisp-mermaid-beacon"));
  check("hostile diagrams make no request to the remote origin", beacons.length === 0, beacons.join("; "));
}

