import { test, expect } from "./fixtures";

/**
 * The end handles of a selected bar, driven with a real mouse.
 *
 * A press on a handle disables the orbit controls and captures the pointer, and both
 * have to be handed back on the release. When they are not, the viewport looks alive
 * but answers nothing — the sort of thing only a reload cures, and the sort of thing
 * no assembly-level assertion would catch.
 */

/** Where the two end handles of the selected bar sit on screen */
const handleScreenPoints = (page: any) =>
  page.evaluate(() => {
    const camera = (window as any).__camera;
    const canvas = document.querySelector(".viewport canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const Vector3 = camera.position.constructor;
    const out: { x: number; y: number }[] = [];
    (window as any).__scene.traverse((o: any) => {
      if (o.isMesh && o.geometry?.type === "SphereGeometry" && Math.abs(o.geometry.parameters.radius - 4.2) < 0.1) {
        const world = new Vector3();
        o.getWorldPosition(world);
        const projected = world.project(camera);
        out.push({
          x: rect.x + (projected.x * 0.5 + 0.5) * rect.width,
          y: rect.y + (-projected.y * 0.5 + 0.5) * rect.height,
        });
      }
    });
    return out.sort((a, b) => a.y - b.y);
  });

const partList = (page: any) =>
  page.evaluate(() =>
    (window as any).__assembly
      .getAllParts()
      .map((p: any) => `${p.definitionId}@${p.position}`)
      .sort(),
  );

const viewportState = (page: any) =>
  page.evaluate(() => ({
    controls: (window as any).__controls?.enabled,
    captured: (document.querySelector(".viewport canvas") as any)?.hasPointerCapture?.(1) ?? false,
    hints: [...document.querySelectorAll(".viewport-mouse-hint")].map((r: any) => r.textContent?.trim()),
  }));

async function oneSelectedBar(page: any) {
  await page.evaluate(() => {
    const assembly = (window as any).__assembly;
    assembly.clear();
    assembly.addPart("support-4u", [0, 0, 0], [0, 0, 0], "y");
    const centre = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Center");
    (centre as HTMLElement)?.click();
  });
  await page.waitForTimeout(700);
  // Click the middle of the bar to select it, which is what brings the handles out
  const bar = await page.evaluate(() => {
    const camera = (window as any).__camera;
    const canvas = document.querySelector(".viewport canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const Vector3 = camera.position.constructor;
    const projected = new Vector3(0, 30, 0).project(camera);
    return {
      x: rect.x + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.y + (-projected.y * 0.5 + 0.5) * rect.height,
    };
  });
  await page.mouse.click(bar.x, bar.y);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.querySelector(".selection-panel h3")?.textContent)).toBe("Selected (1)");
}

test.describe("End handles", () => {
  test("a drag on the top handle lengthens the bar", async ({ appPage: page }) => {
    await oneSelectedBar(page);
    const [top] = await handleScreenPoints(page);

    await page.mouse.move(top.x, top.y);
    await page.waitForTimeout(200);
    expect((await viewportState(page)).hints.join(" ")).toContain("Drag to set the length");

    await page.mouse.down();
    await page.waitForTimeout(120);
    const held = await viewportState(page);
    // Held: the camera stands still and the corner says what the release will do
    expect(held.controls).toBe(false);
    expect(held.hints.join(" ")).toContain("Release to set the length");

    for (let step = 1; step <= 6; step++) {
      await page.mouse.move(top.x, top.y - step * 12);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);

    expect(await partList(page)).toEqual(["support-5u@0,0,0"]);
    const after = await viewportState(page);
    expect(after.controls).toBe(true);
    expect(after.captured).toBe(false);
  });

  test("a click on a handle leaves the viewport answering", async ({ appPage: page }) => {
    await oneSelectedBar(page);
    const [top] = await handleScreenPoints(page);

    await page.mouse.move(top.x, top.y);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(400);

    const after = await viewportState(page);
    expect(after.controls).toBe(true);
    expect(after.captured).toBe(false);
    expect(await partList(page)).toEqual(["support-4u@0,0,0"]);

    // And the keys still reach the app: Escape drops the selection
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.querySelector(".selection-panel h3")?.textContent ?? "none")).toBe(
      "none",
    );
  });
});
