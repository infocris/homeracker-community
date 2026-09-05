import { test, expect } from "./fixtures";

/**
 * Boxes and cylinders drawn to measure. They are registered as custom parts through the
 * very path an imported STL takes, so what these tests hold down is that a shape asked
 * for in millimetres comes out with the cells it should take, and comes back after a
 * reload like any other custom part.
 */
test.describe("Drawn shapes", () => {
  test("a box takes the cells its centimetres come to", async ({ appPage: page }) => {
    const def = await page.evaluate(async () => {
      const created = await (window as any).__createShape({ kind: "box", box: { width: 90, height: 30, depth: 45 } });
      const cells = created.gridCells as [number, number, number][];
      const span = (i: number) => Math.max(...cells.map((c) => c[i])) - Math.min(...cells.map((c) => c[i])) + 1;
      return { name: created.name, category: created.category, span: [span(0), span(1), span(2)] };
    });

    // 90 mm across is 6 cells of 15 mm, 30 mm is 2 of them, 45 mm is 3
    expect(def.span).toEqual([6, 2, 3]);
    expect(def.category).toBe("custom");
    expect(def.name).toBe("Box 90×30×45 mm");
  });

  test("a cylinder takes the box its diameter needs", async ({ appPage: page }) => {
    const def = await page.evaluate(async () => {
      const created = await (window as any).__createShape({ kind: "cylinder", cylinder: { diameter: 40, height: 60 } });
      const cells = created.gridCells as [number, number, number][];
      const span = (i: number) => Math.max(...cells.map((c) => c[i])) - Math.min(...cells.map((c) => c[i])) + 1;
      return { name: created.name, span: [span(0), span(1), span(2)] };
    });

    // 40 mm across reaches into 3 cells, 60 mm tall is 4 of them
    expect(def.span).toEqual([3, 4, 3]);
    expect(def.name).toBe("Cylinder ⌀40×60 mm");
  });

  test("a name given by hand is the name it keeps", async ({ appPage: page }) => {
    const name = await page.evaluate(async () => {
      const created = await (window as any).__createShape(
        { kind: "box", box: { width: 30, height: 30, depth: 30 } },
        "  Riser  ",
      );
      return created.name;
    });

    expect(name).toBe("Riser");
  });

  test("a drawn shape can be placed like any other part", async ({ appPage: page }) => {
    const placed = await page.evaluate(async () => {
      const a = (window as any).__assembly;
      a.clear();
      const created = await (window as any).__createShape({ kind: "box", box: { width: 30, height: 15, depth: 30 } });
      const id = a.addPart(created.id, [0, 0, 0]);
      const bounds = (window as any).__placedPartBounds(a.getPartById(id));
      return { id: !!id, size: bounds?.size };
    });

    expect(placed.id).toBe(true);
    expect(placed.size).toEqual([2, 1, 2]);
  });
});
