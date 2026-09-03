/**
 * Every action a key can call for. Its own file so the keybinding registry and the
 * handlers that answer to it can both name these without importing each other.
 */
export type ActionId =
  | "undo"
  | "redo"
  | "copy"
  | "paste"
  | "group"
  | "ungroup"
  | "delete"
  | "cancel"
  | "nudge-left"
  | "nudge-right"
  | "nudge-forward"
  | "nudge-back"
  | "raise"
  | "lower"
  | "turn-x"
  | "turn-y"
  | "turn-z"
  | "orient"
  | "shortcuts";
