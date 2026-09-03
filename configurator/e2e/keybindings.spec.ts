import { test, expect } from "./fixtures";

/**
 * The shortcuts are read out of a registry rather than written into each handler, so
 * that they can be listed and changed. These tests hold the registry's two promises:
 * a real keystroke resolves to the action it is bound to, and what the panel changes
 * is what the handlers then answer to.
 */
test.describe("Shortcuts", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await page.evaluate(() => {
      (window as any).__keys.resetKeys();
      (window as any).__seen = [];
      // A modifier held on its own names no combo at all, and Playwright presses one
      // before every chord — those are not keystrokes to resolve
      (window as any).__probe = (e: KeyboardEvent) => {
        const keys = (window as any).__keys;
        if (keys.comboOf(e)) (window as any).__seen.push(keys.actionOf(e));
      };
      window.addEventListener("keydown", (window as any).__probe);
    });
  });

  test.afterEach(async ({ appPage: page }) => {
    await page.evaluate(() => {
      window.removeEventListener("keydown", (window as any).__probe);
      (window as any).__keys.resetKeys();
    });
  });

  test("a keystroke resolves to the action it is bound to", async ({ appPage: page }) => {
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+Shift+z");
    await page.keyboard.press("Control+g");
    await page.keyboard.press("Control+Shift+g");
    await page.keyboard.press("x");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Escape");
    await page.keyboard.press("q");

    const seen = await page.evaluate(() => (window as any).__seen);
    expect(seen).toEqual(["undo", "redo", "group", "ungroup", "turn-x", "delete", "cancel", null]);
  });

  test("shift is a variant of the same action, not a different one", async ({ appPage: page }) => {
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Shift+x");

    const seen = await page.evaluate(() => (window as any).__seen);
    expect(seen).toEqual(["nudge-forward", "nudge-forward", "turn-x"]);
  });

  test("a rebound key takes over from the one it replaces", async ({ appPage: page }) => {
    await page.evaluate(() => (window as any).__keys.setKeys("raise", ["r"]));

    await page.keyboard.press("r");
    await page.keyboard.press("w");
    const rebound = await page.evaluate(() => (window as any).__seen);
    expect(rebound).toEqual(["raise", null]);

    const stored = await page.evaluate(() => localStorage.getItem("homeracker-keybindings"));
    expect(stored).toBe('{"raise":["r"]}');

    await page.evaluate(() => {
      (window as any).__seen = [];
      (window as any).__keys.resetKeys("raise");
    });
    await page.keyboard.press("w");
    expect(await page.evaluate(() => (window as any).__seen)).toEqual(["raise"]);
  });

  test("a key already spoken for is reported as a conflict", async ({ appPage: page }) => {
    const conflicts = await page.evaluate(() => {
      const keys = (window as any).__keys;
      return {
        taken: keys.conflictOf("mod+z", "raise"),
        itself: keys.conflictOf("mod+z", "undo"),
        free: keys.conflictOf("k", "raise"),
        reserved: keys.isReserved("mod+w"),
        notReserved: keys.isReserved("mod+k"),
      };
    });

    expect(conflicts).toEqual({ taken: "undo", itself: null, free: null, reserved: true, notReserved: false });
  });

  test("the panel lists every action, and Escape closes it", async ({ appPage: page }) => {
    await page.evaluate(() => {
      const button = [...document.querySelectorAll(".viewport-toolbelt button")].find(
        (b) => b.textContent?.trim() === "Keys",
      );
      (button as HTMLElement).click();
    });
    await page.waitForSelector(".keybindings");

    const rows = await page.evaluate(() => ({
      // One key chip per action; the rows below them are mouse gestures, which have
      // no keys to show
      shown: document.querySelectorAll(".keybindings-key").length,
      actions: (window as any).__keys.ACTIONS.length,
      gestures:
        document.querySelectorAll(".keybindings-row").length - document.querySelectorAll(".keybindings-key").length,
      undo: [...document.querySelectorAll(".keybindings-row")]
        .find((r) => r.querySelector(".keybindings-label")?.textContent === "Undo")
        ?.querySelector(".keybindings-key")?.textContent,
    }));
    expect(rows.shown).toBe(rows.actions);
    expect(rows.undo).toMatch(/Z$/);
    // The mouse gestures are listed here too — they have nowhere else to be announced
    expect(rows.gestures).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".keybindings"));
  });

  test("recording a key writes it into the bindings", async ({ appPage: page }) => {
    await page.evaluate(() => {
      const button = [...document.querySelectorAll(".viewport-toolbelt button")].find(
        (b) => b.textContent?.trim() === "Keys",
      );
      (button as HTMLElement).click();
    });
    await page.waitForSelector(".keybindings");

    await page.evaluate(() => {
      const row = [...document.querySelectorAll(".keybindings-row")].find(
        (r) => r.querySelector(".keybindings-label")?.textContent === "Lower",
      );
      (row?.querySelector(".keybindings-key") as HTMLElement).click();
    });
    await page.waitForSelector(".keybindings-key--recording");

    await page.keyboard.press("j");
    await page.waitForFunction(() => !document.querySelector(".keybindings-key--recording"));

    expect(await page.evaluate(() => (window as any).__keys.keysOf("lower"))).toEqual(["j"]);
  });
});
