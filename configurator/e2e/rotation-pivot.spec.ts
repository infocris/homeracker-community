import { test, expect } from "./fixtures";

/**
 * Where the rotation rings sit, which is where the turn holds still.
 *
 * The rings are the turn's own account of itself: a hoop drawn round the wrong point
 * promises a sweep the part will not make. Reading their centre out of the scene is
 * the only way to check the two agree.
 */

const project = (page: any, world: [number, number, number]) =>
  page.evaluate((w: [number, number, number]) => {
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

/** The centre the rotation rings share, back in grid cells */
const ringCell = (page: any) =>
  page.evaluate(() => {
    const camera = (window as any).__camera;
    const Vector3 = camera.position.constructor;
    let found: number[] | null = null;
    (window as any).__scene.traverse((o: any) => {
      if (found || !o.isMesh || !o.visible || o.geometry?.type !== "TorusGeometry") return;
      const world = new Vector3();
      o.getWorldPosition(world);
      found = [world.x / 15, (world.y - 7.5) / 15, world.z / 15].map((n) => Math.round(n));
    });
    return found;
  });

const pickedSpot = (page: any) =>
  page.evaluate(() => document.querySelector(".sidebar")?.textContent?.toLowerCase().includes("picked spot") ?? false);

/** Lay out a scene, centre the view on it, and report where the parts ended up */
async function scene(page: any, build: string) {
  await page.evaluate((script: string) => {
    const assembly = (window as any).__assembly;
    assembly.clear();
    // biome-ignore lint: the build script is this file's own, handed over as text
    new Function("assembly", script)(assembly);
    const centre = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Center");
    (centre as HTMLElement)?.click();
  }, build);
  await page.waitForTimeout(1200);
  return page.evaluate(() => (window as any).__assembly.getAllParts().map((p: any) => p.position));
}

const cellWorld = (cell: number[]): [number, number, number] => [cell[0] * 15, cell[1] * 15 + 7.5, cell[2] * 15];

test.describe("Rotation pivot", () => {
  test("a lone bar turns about its own anchor", async ({ appPage: page }) => {
    const [bar] = await scene(page, `assembly.addPart("support-4u", [0, 0, 0], [0, 0, 0], "y");`);
    const middle = await project(page, cellWorld([bar[0], bar[1] + 1.5, bar[2]]));
    await page.mouse.click(middle.x, middle.y);
    await page.waitForTimeout(400);

    expect(await pickedSpot(page)).toBe(false);
    // The anchor is the min corner of the part's cells — the foot of a standing bar
    expect(await ringCell(page)).toEqual(bar);
  });

  test("a spot picked on one end turns the bar about that end", async ({ appPage: page }) => {
    const [bar] = await scene(page, `assembly.addPart("support-4u", [0, 0, 0], [0, 0, 0], "y");`);
    const middle = await project(page, cellWorld([bar[0], bar[1] + 1.5, bar[2]]));
    await page.mouse.click(middle.x, middle.y);
    await page.waitForTimeout(400);

    // Clicking the bar that is already the selection picks the spot nearest the click
    const top = await project(page, cellWorld([bar[0], bar[1] + 3, bar[2]]));
    await page.mouse.click(top.x, top.y);
    await page.waitForTimeout(400);

    expect(await pickedSpot(page)).toBe(true);
    // A picked spot is the pivot, whichever end of the bar it sits on
    expect(await ringCell(page)).toEqual([bar[0], bar[1] + 3, bar[2]]);
  });

  test("a spot picked mid-bar is the pivot too", async ({ appPage: page }) => {
    const [bar] = await scene(page, `assembly.addPart("support-4u", [0, 0, 0], [0, 0, 0], "y");`);
    const middle = await project(page, cellWorld([bar[0], bar[1] + 1.5, bar[2]]));
    await page.mouse.click(middle.x, middle.y);
    await page.waitForTimeout(400);

    const mid = await project(page, cellWorld([bar[0], bar[1] + 1, bar[2]]));
    await page.mouse.click(mid.x, mid.y);
    await page.waitForTimeout(400);

    expect(await pickedSpot(page)).toBe(true);
    const ring = (await ringCell(page)) as number[];
    // Taken at its word: the pivot is the picked cell, which is neither end of the bar
    expect([ring[0], ring[2]]).toEqual([bar[0], bar[2]]);
    expect(ring[1]).toBeGreaterThan(bar[1]);
    expect(ring[1]).toBeLessThan(bar[1] + 3);
  });

  test("two bars turn about the middle of the box around both", async ({ appPage: page }) => {
    const [first, second] = await scene(
      page,
      `assembly.addPart("support-4u", [0, 0, 0], [0, 0, 0], "y");
       assembly.addPart("support-4u", [4, 0, 0], [0, 0, 0], "y");`,
    );
    const one = await project(page, cellWorld([first[0], first[1] + 1.5, first[2]]));
    const two = await project(page, cellWorld([second[0], second[1] + 1.5, second[2]]));
    await page.mouse.click(one.x, one.y);
    await page.keyboard.down("Shift");
    await page.mouse.click(two.x, two.y);
    await page.keyboard.up("Shift");
    await page.waitForTimeout(400);

    const middleX = Math.round((first[0] + second[0]) / 2);
    expect(await ringCell(page)).toEqual([middleX, first[1] + 2, first[2]]);
  });
});
