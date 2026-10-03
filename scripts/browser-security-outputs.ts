import { waitInPage, type Evaluates } from "./browser-security-wait";

/** Real-browser output preview under the generated bundle's CSP and bearer transport. */
export async function checkOutputImages(page: Evaluates, check: (name: string, condition: boolean, detail: string) => void, screenshot: (name: string) => Promise<void>): Promise<void> {
  const unauthenticated = await page.evaluate(`(async () => {
    const detail = await fetch('/api/tasks/tspike/conversation', { headers: { Authorization: 'Bearer ' + localStorage.getItem('wisp_token') } }).then(r => r.json());
    const image = detail.turns[0].outputs[0];
    const path = '/api/tasks/tspike/outputs/1/' + image.id;
    const refusal = await fetch(path).then(r => r.status);
    const response = await fetch(path, { headers: { Authorization: 'Bearer ' + localStorage.getItem('wisp_token') } });
    return { refusal, status: response.status, cache: response.headers.get('cache-control') };
  })()`) as { refusal: number; status: number; cache: string };
  check("output image bytes require a bearer and refuse HTTP caching", unauthenticated.refusal === 401 && unauthenticated.status === 200 && unauthenticated.cache === "private, no-store", JSON.stringify(unauthenticated));
  await page.evaluate(`document.querySelector('[data-testid="output-image"]')?.scrollIntoView({ block: 'center' })`);
  await waitInPage(page, `document.querySelector('[data-testid="output-image"] img')?.naturalWidth === 240`, "inline output image");
  const src = await page.evaluate(`document.querySelector('[data-testid="output-image"] img').src`) as string;
  check("output previews render from authenticated blobs", src.startsWith("blob:"), src);
  await screenshot("output-image");
  await page.evaluate(`document.querySelector('button[aria-label="Expand sample.png"]').click()`);
  await waitInPage(page, `document.querySelector('[data-testid="attachment-viewer"] img')?.naturalWidth === 240`, "expanded output image");
  await screenshot("output-image-expanded");
  await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitInPage(page, `!document.querySelector('[data-testid="attachment-viewer"]')`, "output viewer dismissal");
}
