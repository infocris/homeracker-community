import { test, expect } from "./fixtures";

/**
 * A draw begun on a free side of a connector runs the way that side faces. The span
 * used to be read from the drag alone — whichever of x and z the pointer had gone
 * further along — so a bar drawn from an arm reaching one way could be laid across it,
 * which is the one hookup the assembly turns away.
 */
test.describe("Drawing from a connector's free side", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await page.evaluate(() => (window as any).__assembly.clear());
  });

  test("the side the draw began on fixes which way the bar runs", async ({ appPage: page }) => {
    const spans = await page.evaluate(() => {
      const span = (window as any).__computeDrawSpan;
      return {
        // Dragged further along x than z, but begun on a side facing +z
        alongZ: span([0, 0, 1], [3, 0, 3], "horizontal", "+z"),
        // The same drag with nothing to fix it follows the pointer, as it always has
        free: span([0, 0, 1], [3, 0, 3], "horizontal"),
        // Backwards along its own side: the single cell it started in, not a bar the
        // other way
        backwards: span([0, 0, 1], [0, 0, -4], "horizontal", "+z"),
        // A side facing down grows downwards, anchored at the far end
        down: span([0, 5, 0], [0, 0, 0], "vertical", "-y"),
      };
    });

    expect(spans.alongZ).toEqual({ position: [0, 0, 1], size: [1, 1, 3] });
    expect(spans.free).toEqual({ position: [0, 0, 1], size: [4, 1, 1] });
    expect(spans.backwards).toEqual({ position: [0, 0, 1], size: [1, 1, 1] });
    expect(spans.down).toEqual({ position: [0, 0, 0], size: [1, 6, 1] });
  });

  test("a single cell drawn at an arm lies along it", async ({ appPage: page }) => {
    const drawn = await page.evaluate(() => {
      const a = (window as any).__assembly;
      // Arms along z
      a.addPart("connector-1d2w", [0, 0, 0]);
      return {
        atArm: (window as any).__resolveDraw(a, [0, 0, 1], [1, 1, 1], false),
        inTheOpen: (window as any).__resolveDraw(a, [5, 0, 5], [1, 1, 1], false),
      };
    });

    expect(drawn.atArm.orientation).toBe("z");
    // Nothing asking for an axis: a lone cell still stands up, as before
    expect(drawn.inTheOpen.orientation).toBe("y");
  });

  test("a bar drawn along an arm is a hookup the rules accept", async ({ appPage: page }) => {
    const sound = await page.evaluate(() => {
      const a = (window as any).__assembly;
      a.addPart("connector-1d2w", [0, 0, 0]);
      const compat = (window as any).__compat;
      return {
        alongTheArm: compat.supportHookupIsSound(a, "support-3u", [0, 0, 1], [0, 0, 0], "z"),
        acrossIt: compat.supportHookupIsSound(a, "support-3u", [1, 0, 0], [0, 0, 0], "x"),
      };
    });

    expect(sound).toEqual({ alongTheArm: true, acrossIt: false });
  });
});
