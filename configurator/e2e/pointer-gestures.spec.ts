import { test, expect } from "./fixtures";

/**
 * The gestures the viewport answers to, driven with a real mouse.
 *
 * These are the one part of the app that cannot be checked by reading the scene
 * afterwards: a chord that never arrived and a chord that was ignored leave the same
 * assembly behind. Playwright's mouse presses buttons the way a hand does, chords
 * included, which is the only way to hold these down.
 */

/** Where a world point lands on screen, for aiming the mouse */
async function screenPoint(page: any, world: [number, number, number]) {
  return page.evaluate((w: [number, number, number]) => {
    const camera = (window as any).__camera;
    const canvas = document.querySelector(".viewport canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const Vector3 = camera.position.constructor;
    const projected = new Vector3(w[0], w[1], w[2]).project(camera);
    return {
      x: rect.x + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.y + (-projected.y * 0.5 + 0.5) * rect.height,
    };
  }, world);
}

const selectionCount = (page: any) =>
  page.evaluate(() => document.querySelector(".selection-panel h3")?.textContent ?? "none");

/**
 * Where each bar's middle lands on screen, taken from the assembly as it stands.
 *
 * The app is free to shift what it is given — a build is kept centred on the grid —
 * so the coordinates handed to addPart are not the ones to aim at.
 */
async function barPoints(page: any) {
  const parts = await page.evaluate(() =>
    (window as any).__assembly.getAllParts().map((part: any) => part.position as [number, number, number]),
  );
  const points = [];
  for (const [x, , z] of parts) points.push(await screenPoint(page, [x * 15, 30, z * 15]));
  return points;
}

async function twoBars(page: any) {
  await page.evaluate(() => {
    const a = (window as any).__assembly;
    a.clear();
    a.addPart("support-4u", [0, 0, 0], [0, 0, 0], "y");
    a.addPart("support-4u", [4, 0, 0], [0, 0, 0], "y");
  });
  // Centre the view on them, so both are in front of the camera and clickable
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Center");
    (button as HTMLElement)?.click();
  });
  await cameraStill(page);
}

/**
 * Wait for the camera to come to rest.
 *
 * Every aim below is a world point projected through the camera, so a reading taken
 * while the view is still gliding into place lands the mouse somewhere the part no
 * longer is — the sort of miss that reads as a broken gesture.
 */
async function cameraStill(page: any) {
  const reading = () => page.evaluate(() => (window as any).__camera.position.toArray().join(","));
  // A beat first: the glide only begins on the frame after the button was pressed, and
  // two readings taken before it starts look exactly like two taken after it ends
  await page.waitForTimeout(400);
  let previous = await reading();
  let still = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(120);
    const next = await reading();
    still = next === previous ? still + 1 : 0;
    if (still >= 2) return;
    previous = next;
  }
}

test.describe("Mouse gestures", () => {
  test("both buttons held still add a part to the selection, as Shift+click does", async ({ appPage: page }) => {
    await twoBars(page);
    const [first, second] = await barPoints(page);

    await page.mouse.click(first.x, first.y);
    await page.waitForTimeout(300);
    expect(await selectionCount(page)).toBe("Selected (1)");

    // Both buttons, held still: the chord stands for Shift
    await page.mouse.move(second.x, second.y);
    await page.mouse.down({ button: "left" });
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await page.mouse.up({ button: "left" });
    await page.waitForTimeout(400);
    expect(await selectionCount(page)).toBe("Selected (2)");
  });

  test("the corner names the group key once two parts are selected", async ({ appPage: page }) => {
    await twoBars(page);
    const [first, second] = await barPoints(page);
    await page.mouse.click(first.x, first.y);
    await page.keyboard.down("Shift");
    await page.mouse.click(second.x, second.y);
    await page.keyboard.up("Shift");
    await page.waitForTimeout(400);

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".viewport-hint-row")].map((r) => r.textContent?.trim() ?? ""),
    );
    expect(await selectionCount(page)).toBe("Selected (2)");
    expect(rows.join(" · ")).toContain("group as one body");
  });

  test("the middle button copies a part, then turns the copy", async ({ appPage: page }) => {
    await twoBars(page);
    const [first] = await barPoints(page);

    await page.mouse.move(first.x, first.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.up({ button: "middle" });
    await page.waitForTimeout(500);

    // A copy is on the cursor, as it was drawn
    expect(await page.evaluate(() => (window as any).__pasteTurn)).toEqual([0, 0, 0]);

    const turns: number[][] = [];
    for (let i = 0; i < 3; i++) {
      await page.mouse.down({ button: "middle" });
      await page.mouse.up({ button: "middle" });
      await page.waitForTimeout(300);
      turns.push(await page.evaluate(() => (window as any).__pasteTurn));
    }

    // Flat, upright, and back to where it started
    expect(turns).toEqual([
      [0, 90, 0],
      [90, 0, 0],
      [0, 0, 0],
    ]);
  });
});
