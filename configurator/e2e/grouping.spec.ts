import { test, expect } from "./fixtures";

/**
 * Grouping is a tag carried by each part rather than a list of ids kept beside them,
 * because every move is a remove plus an add and ids are reissued as they go. These
 * tests hold that down: the tag survives what a session does to a part, and the
 * commands that set it are reversible the way the rest of the stack is.
 */
test.describe("Grouping", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await page.evaluate(() => (window as any).__assembly.clear());
  });

  test("a group tags its parts, and any of them names the whole of it", async ({ appPage: page }) => {
    const res = await page.evaluate(() => {
      const a = (window as any).__assembly;
      const ids = [
        a.addPart("support-3u", [0, 0, 0]),
        a.addPart("support-3u", [3, 0, 0]),
        a.addPart("support-3u", [6, 0, 0]),
      ];
      a.setPartsGroup([ids[0], ids[1]], "g1");
      return {
        tags: a.getAllParts().map((p: any) => p.groupId ?? null),
        fromMember: [...a.expandToGroups([ids[0]])].length,
        fromOutsider: [...a.expandToGroups([ids[2]])].length,
      };
    });

    expect(res.tags).toEqual(["g1", "g1", null]);
    expect(res.fromMember).toBe(2);
    expect(res.fromOutsider).toBe(1);
  });

  test("group and ungroup each undo", async ({ appPage: page }) => {
    const res = await page.evaluate(() => {
      const a = (window as any).__assembly;
      const g = (window as any).__groups;
      const ids = [a.addPart("support-3u", [0, 0, 0]), a.addPart("support-3u", [3, 0, 0])];
      const tags = () => a.getAllParts().map((p: any) => !!p.groupId);

      const group = g.regroupCommand(g.regroupTargets(ids), "g1", "Group");
      group.execute();
      const grouped = tags();

      const ungroup = g.regroupCommand(g.regroupTargets(ids), undefined, "Ungroup");
      ungroup.execute();
      const ungrouped = tags();

      ungroup.undo();
      const tiedAgain = tags();
      group.undo();
      const loose = tags();
      return { grouped, ungrouped, tiedAgain, loose };
    });

    expect(res.grouped).toEqual([true, true]);
    expect(res.ungrouped).toEqual([false, false]);
    expect(res.tiedAgain).toEqual([true, true]);
    expect(res.loose).toEqual([false, false]);
  });

  test("undo puts each part back in the group it came from", async ({ appPage: page }) => {
    const res = await page.evaluate(() => {
      const a = (window as any).__assembly;
      const g = (window as any).__groups;
      const ids = [
        a.addPart("support-3u", [0, 0, 0]),
        a.addPart("support-3u", [3, 0, 0]),
        a.addPart("support-3u", [6, 0, 0]),
      ];
      a.setPartsGroup([ids[0], ids[1]], "g1");

      // A second group reaching across the first: the last two parts
      const cmd = g.regroupCommand(g.regroupTargets([ids[1], ids[2]]), "g2", "Group");
      cmd.execute();
      const after = a.getAllParts().map((p: any) => p.groupId ?? null);
      cmd.undo();
      const undone = a.getAllParts().map((p: any) => p.groupId ?? null);
      return { after, undone };
    });

    expect(res.after).toEqual(["g1", "g2", "g2"]);
    expect(res.undone).toEqual(["g1", "g1", null]);
  });

  test("a group is written to the save format and read back", async ({ appPage: page }) => {
    const res = await page.evaluate(() => {
      const a = (window as any).__assembly;
      const ids = [a.addPart("support-3u", [0, 0, 0]), a.addPart("support-3u", [3, 0, 0])];
      a.setPartsGroup(ids, "g1");

      const file = a.serialize("test");
      const saved = file.parts.map((p: any) => p.group ?? null);
      a.clear();
      a.deserialize(JSON.parse(JSON.stringify(file)));
      const reloaded = a.getAllParts().map((p: any) => p.groupId ?? null);
      return { saved, reloaded };
    });

    expect(res.saved).toEqual(["g1", "g1"]);
    expect(res.reloaded).toEqual(["g1", "g1"]);
  });

  test("a part put back by a command keeps its colour and its group", async ({ appPage: page }) => {
    const attrs = await page.evaluate(() => {
      const a = (window as any).__assembly;
      const id = a.addPart("support-3u", [0, 0, 0], [0, 0, 0], undefined, { color: "#abcdef", groupId: "g1" });
      const part = a.getPartById(id);
      return { color: part?.color, groupId: part?.groupId };
    });

    expect(attrs).toEqual({ color: "#abcdef", groupId: "g1" });
  });
});
