import { describe, expect, it } from "vitest";

import { markdownFromHtmlLinks, safeHttpUrl } from "./paste-links";

describe("safeHttpUrl", () => {
  it("keeps absolute http(s) hrefs", () => {
    expect(safeHttpUrl("https://example.com/issues/APP-101")).toBe(
      "https://example.com/issues/APP-101",
    );
    expect(safeHttpUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  it("drops javascript, data, and anything that is not an absolute http(s) URL", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("/relative/path")).toBeNull();
    expect(safeHttpUrl("example.com/issue")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("markdownFromHtmlLinks", () => {
  it("returns null when there is no HTML, or HTML with no http(s) anchors", () => {
    expect(markdownFromHtmlLinks("")).toBeNull();
    expect(markdownFromHtmlLinks("   ")).toBeNull();
    expect(markdownFromHtmlLinks("<p>just a sentence</p>")).toBeNull();
    expect(markdownFromHtmlLinks('<a href="javascript:void(0)">x</a>')).toBeNull();
    expect(markdownFromHtmlLinks('<b>bold</b> and <em>italic</em>')).toBeNull();
  });

  it("rewrites a titled hyperlink to [label](url)", () => {
    expect(markdownFromHtmlLinks('<a href="https://example.com/pr/1">the fix</a>')).toBe(
      "[the fix](https://example.com/pr/1)",
    );
  });

  it("emits a bare URL when the label is empty or already the href", () => {
    expect(markdownFromHtmlLinks('<a href="https://example.com/pr/1"></a>')).toBe("https://example.com/pr/1");
    expect(markdownFromHtmlLinks('<a href="https://example.com/pr/1">https://example.com/pr/1</a>')).toBe(
      "https://example.com/pr/1",
    );
  });

  it("keeps surrounding text and ignores bold/italic wrappers", () => {
    const html = `<p><b>Could you review these PRs?</b> See <a href="https://example.com/a"><em>SUPER-1</em></a>.</p>`;
    expect(markdownFromHtmlLinks(html)).toBe("Could you review these PRs? See [SUPER-1](https://example.com/a).");
  });

  it("turns a Slack-style numbered list of links into markdown, without copying each one", () => {
    const html = `
      <html><body>
      <!--StartFragment-->
      Could you review these PRs?<br>
      <ol>
        <li><a href="https://example.com/issues/APP-101">APP-101: improve retry handling</a></li>
        <li><a href="https://example.com/issues/APP-102">APP-102: clarify the empty state</a></li>
        <li><a href="https://example.com/issues/APP-103">APP-103: update the cache policy</a></li>
      </ol>
      <!--EndFragment-->
      </body></html>
    `;
    expect(markdownFromHtmlLinks(html)).toBe(
      [
        "Could you review these PRs?",
        "1. [APP-101: improve retry handling](https://example.com/issues/APP-101)",
        "2. [APP-102: clarify the empty state](https://example.com/issues/APP-102)",
        "3. [APP-103: update the cache policy](https://example.com/issues/APP-103)",
      ].join("\n"),
    );
  });

  it("angle-brackets a URL that would break markdown parens", () => {
    expect(markdownFromHtmlLinks('<a href="https://example.com/a(b)">note</a>')).toBe(
      "[note](<https://example.com/a(b)>)",
    );
  });

  it("does not resolve a relative href against this origin", () => {
    expect(markdownFromHtmlLinks('<a href="/api/tasks/x">task</a>')).toBeNull();
  });
});
