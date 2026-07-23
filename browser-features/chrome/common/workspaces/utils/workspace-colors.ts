/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The workspace colour palette — the SAME set the tab-group/stack editor
 * offers: Firefox's nine builtin group colours followed by bork's extra
 * row (tab-stacks/styles.css). Values are literals rather than var()
 * references because two consumers have no access to the chrome
 * document's variables: the modal-child page (React, its own document)
 * and inline light-dark() styles on rail/chooser icons.
 *
 * light = the -50 base token (what light-mode group chips wear),
 * dark = the -20 "invert" token (bright enough on dark surfaces).
 * Sampled live from the FF152 runtime's design tokens.
 */
export type WorkspaceColorDef = {
  name: string;
  light: string;
  dark: string;
};

export const WORKSPACE_COLORS: readonly WorkspaceColorDef[] = [
  { name: "blue", light: "oklch(62% 0.24 260)", dark: "oklch(83% 0.17 260)" },
  { name: "red", light: "oklch(62% 0.21 15)", dark: "#ff453a" },
  { name: "yellow", light: "oklch(65% 0.24 90)", dark: "oklch(86% 0.14 90)" },
  { name: "green", light: "oklch(62% 0.21 145)", dark: "oklch(83% 0.14 145)" },
  { name: "pink", light: "oklch(62% 0.21 360)", dark: "oklch(83% 0.14 360)" },
  {
    name: "purple",
    light: "oklch(62% 0.21 315)",
    dark: "oklch(83% 0.14 315)",
  },
  { name: "orange", light: "oklch(65% 0.21 50)", dark: "oklch(86% 0.14 50)" },
  { name: "cyan", light: "oklch(62% 0.21 205)", dark: "oklch(83% 0.11 205)" },
  { name: "gray", light: "#bfbfc9", dark: "#f0f0f4" },
  { name: "crimson", light: "#881337", dark: "#e11d48" },
  { name: "amber", light: "#b45309", dark: "#fbbf24" },
  { name: "lime", light: "#4d7c0f", dark: "#a3e635" },
  { name: "teal", light: "#0f766e", dark: "#2dd4bf" },
  { name: "indigo", light: "#4338ca", dark: "#818cf8" },
  { name: "magenta", light: "#a21caf", dark: "#e879f9" },
  { name: "brown", light: "#6b4423", dark: "#c9915f" },
  { name: "slate", light: "#475569", dark: "#94a3b8" },
];

const byName = new Map(WORKSPACE_COLORS.map((c) => [c.name, c]));

export const isWorkspaceColor = (name: string | null | undefined): boolean =>
  !!name && byName.has(name);

/**
 * CSS colour for a stored workspace colour name, scheme-aware via
 * light-dark(). Null for unknown/unset names — callers leave the icon on
 * currentColor.
 */
export const workspaceColorCss = (
  name: string | null | undefined,
): string | null => {
  const def = name ? byName.get(name) : undefined;
  return def ? `light-dark(${def.light}, ${def.dark})` : null;
};
