# homeracker-community — configurator fork

A fork of [kellerlabs/homeracker-community](https://github.com/kellerlabs/homeracker-community) where
the 3D configurator is being worked on. Everything else — the community models, the core, the
contribution rules — is the upstream project's, and [its README](../README.md) is the one to read for
those.

### **[Launch this fork's configurator](https://infocris.github.io/homeracker-community/configurator/)**

## How this fork differs

Every difference is in `configurator/`, apart from the deployment note at the end. Upstream's
configurator places parts on a grid and lists them; this one tries to know what a rack is made of, so
that a wrong assembly is harder to build than a right one.

**Placing and building**

- Gravity: a part rests on what is under it instead of floating, and can be dropped onto a face.
- Two draw modes — drag along the ground to lay a bar, drag upward to stand one — with the span,
  the part chosen for it and its resting place all decided by the same rule the preview shows.
- Bars drawn straight out of a connector's free sides, in the direction that side faces.
- Supports resized by dragging the handles on their ends, and re-aimed by dragging one across.
- A pick on the assembly places the next part at that spot, and the catalog narrows to the parts
  that fit there.
- A working level to build above the ground, and a workspace whose size is yours to set.

**Junctions**

- A bar goes into a connector end-on, along an arm, or not at all: the ghost turns red, the drop is
  refused, and a bar aimed at a free side turns itself to match.
- Connectors adapt to what arrives — an arm grows for a bar dropped into them, and the connector
  falls back to the tightest fit when a bar leaves. There is a toggle for it.
- A placed connector can be traded for another that reaches further, from the list or from the
  handles on its own free sides.
- Connectors are held in place unless deliberately unlocked: a joint is what the parts around it
  were aimed at, and dragging one loose by accident undoes more than it looks like it does.

**Selecting and editing**

- Parts grouped and handled as one body: selecting, moving, turning, colouring, deleting.
- A selection turns as one about a pivot that stays put, in the plane the rings draw, and a turn
  that would leave the buildable area is refused rather than half-made.
- Arrow keys nudge the way they point on screen, whichever side the camera is on.
- Middle-click duplicates; a box is drawn with Shift+drag or with both buttons held.
- Undo finds its parts by what they are rather than by an id captured when the command was built,
  which is what stops a second undo duplicating a part.

**Reading what you have built**

- Guides under a raised part: its footprint on the ground, posts down to it, a rung per level, and
  its edges carried out across the assembly in every plane it shares with a flat part.
- Lengths and heights written out — a bar's length in cells and centimetres, a raised part's
  underside and top.
- The part under the cursor shown large beside it, lit from the inside so its sockets can be counted.
- A part inspector for the selected connector, a mirror minimap, and a toggle that hides the
  connectors to read the run of the bars alone.

**Keyboard and mouse**

- Every shortcut listed in one panel, and every one of them rebindable, kept between sessions.
- The mouse gestures written down beside a mouse that fills in the button you are holding.
- A log, behind a switch, of every press and what the viewport made of it.

**Underneath**

- 112 end-to-end tests over 19 files, run against every change.
- The Pages workflow publishes the site in the name of whichever repository builds it, so this
  fork's site points at this fork. `README.md` itself is untouched and stays mergeable with upstream.

## Upstream

Fixes and models belong upstream: [kellerlabs/homeracker-community](https://github.com/kellerlabs/homeracker-community)
for community creations, [kellerlabs/homeracker](https://github.com/kellerlabs/homeracker) for the core.
Upstream's own demo is at <https://kellerlabs.github.io/homeracker-community/configurator/>.

Licensed as upstream: MIT for code, CC BY-SA 4.0 for models.
