import { test, expect } from "@playwright/test";
import { waitForApp } from "./fixtures";

/**
 * The GL viewport, on a screen whose pixels are not CSS pixels.
 *
 * three.js multiplies whatever `setViewport` is handed by the renderer's pixel ratio,
 * so passing device pixels squares the ratio and the whole scene is drawn at 2× on a
 * retina display — and stays that way, since nothing else sets the viewport back.
 * Every other test here runs at a ratio of 1, where the mistake is invisible: this one
 * asks for 2 on purpose.
 */
test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });

const viewportState = (page: any) =>
  page.evaluate(() => {
    const canvas = document.querySelector(".viewport canvas") as HTMLCanvasElement;
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
    return {
      viewport: Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array),
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      ratio: window.devicePixelRatio,
    };
  });

test("the close-ups leave the view at its own size", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);

  await page.evaluate(() => {
    const assembly = (window as any).__assembly;
    assembly.clear();
    assembly.addPart("support-4u", [0, 0, 0], [0, 0, 0], "y");
    const centre = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Center");
    (centre as HTMLElement)?.click();
  });
  await page.waitForTimeout(1200);

  const before = await viewportState(page);
  expect(before.ratio).toBe(2);
  expect(before.viewport.slice(2)).toEqual(before.buffer);

  // Picking a spot brings up the junction close-ups, which draw insets of their own
  const pos = await page.evaluate(() => (window as any).__assembly.getAllParts()[0].position);
  const at = (dy: number) =>
    page.evaluate(
      (w: number[]) => {
        const camera = (window as any).__camera;
        const canvas = document.querySelector(".viewport canvas") as HTMLCanvasElement;
        const rect = canvas.getBoundingClientRect();
        const V = camera.position.constructor;
        const q = new V(w[0], w[1], w[2]).project(camera);
        return { x: rect.x + (q.x * 0.5 + 0.5) * rect.width, y: rect.y + (-q.y * 0.5 + 0.5) * rect.height };
      },
      [pos[0] * 15, (pos[1] + dy) * 15 + 7.5, pos[2] * 15],
    );

  const middle = await at(1.5);
  await page.mouse.click(middle.x, middle.y);
  await page.waitForTimeout(400);
  const top = await at(3);
  await page.mouse.click(top.x, top.y);
  await page.waitForTimeout(800);

  expect(await page.evaluate(() => document.querySelectorAll(".viewport-inset").length)).toBe(3);
  const during = await viewportState(page);
  expect(during.viewport.slice(2)).toEqual(during.buffer);

  // And once they are gone the view is still its own size
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const after = await viewportState(page);
  expect(after.viewport.slice(2)).toEqual(after.buffer);
});
