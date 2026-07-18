#!/usr/bin/env python3
"""Generate derp's help pages.

Static HTML with no build step, so it can be served straight from source at
chrome://noraneko-help/content/. The pages have to read well in the panel
sidebar (roughly 350-450px wide) as well as full width, so the navigation
collapses rather than sitting in a fixed column.

Run from the repo root: python3 tools/release/gen-help.py
"""
import os
import pathlib

OUT = pathlib.Path("browser-features/help")

# name -> inline SVG path data, stroked with currentColor (lucide-ish, ours).
ICONS = {
    "layers": '<path d="M12.8 2.2a2 2 0 0 0-1.6 0L2.6 6.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8Z"/><path d="m22 17.6-9.2 4.2a2 2 0 0 1-1.6 0L2 17.6"/><path d="m22 12.6-9.2 4.2a2 2 0 0 1-1.6 0L2 12.6"/>',
    "grid": '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    "columns": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
    "maximize": '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    "sidebar": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    "pointer": '<path d="M12.6 12.6 19 21l-2 1-6.4-8.4"/><path d="M4 4l6 16 2.4-6.6L19 11Z"/>',
    "download": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    "app": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><circle cx="6" cy="6" r=".5" fill="currentColor"/>',
    "keyboard": '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h8"/>',
    "puzzle": '<path d="M15.5 3a2.5 2.5 0 0 1 0 5H14v2h2.5a2.5 2.5 0 0 1 0 5H14v3a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2v-8a1 1 0 0 1 1-1h3V6.5a2.5 2.5 0 0 1 5 0V8h1V6a3 3 0 0 1 2.5-3Z"/>',
    "home": '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>',
}

# (section, [(slug, title, icon, summary, [(heading, [paragraphs])])])
SECTIONS = [
    ("Getting started", [
        ("importing", "Importing from another browser", "download",
         "Bring your passwords, bookmarks, history and cookies across — and, from Vivaldi, your workspaces and the tabs inside them.",
         [("What derp can import",
           ["derp reads the browsers already installed on your computer and offers whatever each one holds. Vivaldi, Chrome, Edge, Opera and Safari are all supported.",
            "Passwords, bookmarks, browsing history and cookies come across in one pass. Importing passwords asks your operating system for permission to unlock the other browser's password store — that prompt comes from macOS or Windows, not from derp."]),
          ("Vivaldi workspaces",
           ["derp recreates your Vivaldi workspaces here, reading Vivaldi's own session data, so a workspace holding twenty tabs arrives as a workspace holding twenty tabs, with their titles.",
            "Tabs are restored without loading, so importing a large profile does not start a hundred page loads at once. Workspaces whose name you already use are skipped, which means running the import twice tops up rather than duplicating."]),
          ("Where to find it",
           ["The import step appears during first-run setup, as one of the pages you walk through the first time derp opens.",
            "Afterwards it lives in the Hub, under Workspaces: an Import from Vivaldi card appears there whenever a Vivaldi profile is present on the computer. Open the Hub from the menu, or go to about:hub."])]),
    ]),
    ("Tabs", [
        ("tab-stacks", "Tab stacks", "layers",
         "Two levels of tabs: a stack is one chip in the tab strip, and its tabs appear in a second bar underneath.",
         [("How a stack behaves",
           ["A stack shows in the tab strip as a single chip carrying a layers glyph and the number of tabs inside it. Selecting the chip makes the stack active and its tabs appear in a second bar directly under the strip.",
            "This keeps the top row short no matter how many tabs a stack holds — the strip shows your stacks, the second bar shows the tabs of whichever one you are in."]),
          ("Stacks and plain groups",
           ["Every native tab group is presented as a stack by default. Right-click a group's label and choose Change to Tab Group to get Firefox's ordinary inline presentation back, or Change to Tab Stack to return.",
            "The choice is remembered per group and survives restarts."])]),
        ("workspaces", "Workspaces", "grid",
         "Separate sets of tabs you switch between, each remembering its own tabs.",
         [("Switching workspaces",
           ["The workspace chooser sits at the far left of the tab strip and shows the current workspace's icon and name. Selecting it lists your workspaces; choosing one swaps the tab strip over to that workspace's tabs.",
            "A tab belongs to exactly one workspace. Tabs in other workspaces stay open and loaded, they are simply not shown."]),
          ("Containers",
           ["A workspace can be tied to a container, so everything opened inside it is isolated from your other browsing. The chooser shows a coloured edge when the current workspace has one."])]),
        ("split-view", "Split view", "columns",
         "Two or more pages side by side inside a single tab.",
         [("Using split view",
           ["Split view divides one tab between several pages, so you can read and work at the same time without switching back and forth. Open it from the tab context menu.",
            "Layout and pane sizes are remembered."])]),
    ]),
    ("Interface", [
        ("zen-mode", "Zen mode", "maximize",
         "Retracts the toolbars and the status bar so only the page is left.",
         [("What it hides",
           ["Zen mode pulls the toolbox and status bar out of the way, leaving the page occupying the whole window. Move the pointer to the edge to bring the chrome back temporarily.",
            "It is meant for reading and for presenting, where browser furniture is a distraction."])]),
        ("panel-sidebar", "Panel sidebar", "sidebar",
         "A sidebar for web panels, notes and extensions, kept beside the page rather than over it.",
         [("Web panels",
           ["Any site can be pinned to the sidebar as a web panel, so it sits alongside whatever you are reading instead of taking a tab. Panels keep their own zoom level and user agent, and can run in a container.",
            "This help lives in a panel, which is why it is designed to read comfortably at sidebar width."])]),
    ]),
    ("Input", [
        ("mouse-gestures", "Mouse gestures", "pointer",
         "Hold the right mouse button and draw to run a command.",
         [("Drawing a gesture",
           ["Hold the right mouse button and draw a shape, then release. derp matches the shape against your configured gestures and runs the matching command.",
            "Sensitivity and the shape-to-command mapping are configurable."]),
          ("Wheel gestures",
           ["With the right button held, the scroll wheel moves between tabs."])]),
        ("keyboard-shortcuts", "Keyboard shortcuts", "keyboard",
         "The shortcuts derp adds on top of Firefox's, and how to change them.",
         [("Changing shortcuts",
           ["derp's shortcuts are listed and editable in the Hub, alongside Firefox's own. Conflicts are flagged as you assign them."])]),
    ]),
    ("Extras", [
        ("web-apps", "Web apps", "app",
         "Installs a site as a standalone desktop application.",
         [("Installing a site",
           ["A site installed as a web app opens in its own window with no tab strip or address bar, and can be pinned to the taskbar or dock like any other application. Firefox extensions still apply inside it."])]),
        ("extensions", "Extensions and Manifest V2", "puzzle",
         "derp runs Manifest V2 extensions, so the full uBlock Origin works rather than the reduced Lite version.",
         [("Why this matters",
           ["Chrome's move to Manifest V3 removed the blocking request API that content blockers rely on, capping filter lists and weakening what a blocker can do. Chrome-based browsers inherit that limit.",
            "derp is built on Firefox, which still supports Manifest V2. The complete uBlock Origin runs here with its full filtering, not the declawed Lite build."]),
          ("Installing extensions",
           ["Extensions install from addons.mozilla.org as they would in Firefox. derp ships uBlock Origin, Ghostery, Privacy Badger and Dark Reader by default."])]),
    ]),
]

FLAT = [(sec, p) for sec, pages in SECTIONS for p in pages]


def icon(name, cls="icon"):
    return (f'<svg class="{cls}" viewBox="0 0 24 24" fill="none" '
            f'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" '
            f'stroke-linejoin="round" aria-hidden="true">{ICONS[name]}</svg>')


def nav_html(current):
    out = ['<nav class="nav" id="nav" aria-label="Help topics">']
    for section, pages in SECTIONS:
        out.append(f'<div class="nav-section">{section}</div><ul class="nav-list">')
        for slug, title, ic, _s, _b in pages:
            active = ' class="active"' if slug == current else ""
            out.append(f'<li><a href="{slug}.html"{active}>{icon(ic, "icon sm")}'
                       f'<span>{title}</span></a></li>')
        out.append("</ul>")
    out.append("</nav>")
    return "\n".join(out)


def shell(title, current, breadcrumb, body, toc=None):
    toc_html = ""
    if toc:
        links = "".join(f'<li><a href="#{i}">{h}</a></li>' for i, h in toc)
        toc_html = (f'<details class="toc" open><summary>On this page</summary>'
                    f'<ul>{links}</ul></details>')
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — derp help</title>
<link rel="stylesheet" href="help.css">
</head>
<body>
<header class="topbar">
  <button class="menu-toggle" id="menuToggle" aria-label="Topics" aria-expanded="false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
  </button>
  <a class="brand" href="index.html">{icon("layers", "icon brand-mark")}<span>derp help</span></a>
</header>
<div class="layout">
  {nav_html(current)}
  <main class="content">
    <nav class="crumbs" aria-label="Breadcrumb">{breadcrumb}</nav>
    {toc_html}
    {body}
  </main>
</div>
<script src="help.js"></script>
</body>
</html>
"""


def crumb(*parts):
    sep = ('<svg class="crumb-sep" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
           ' stroke-width="2" stroke-linecap="round" aria-hidden="true">'
           '<path d="m9 18 6-6-6-6"/></svg>')
    out = []
    for i, (label, href) in enumerate(parts):
        if i:
            out.append(sep)
        if href:
            out.append(f'<a href="{href}">{label}</a>')
        else:
            out.append(f'<span aria-current="page">{label}</span>')
    return "".join(out)


def build():
    OUT.mkdir(parents=True, exist_ok=True)

    # Home
    cards = []
    for section, pages in SECTIONS:
        cards.append(f'<h2 class="sec-head">{section}</h2><div class="cards">')
        for slug, title, ic, summary, _b in pages:
            cards.append(
                f'<a class="card" href="{slug}.html">{icon(ic)}'
                f'<div><div class="card-title">{title}</div>'
                f'<div class="card-sum">{summary}</div></div></a>')
        cards.append("</div>")
    home_body = ('<h1>derp help</h1>'
                 '<p class="lede">Documentation for the features derp adds on top '
                 'of Firefox.</p>' + "".join(cards))
    (OUT / "index.html").write_text(
        shell("Help", "index", crumb(("Help", None)), home_body), encoding="utf-8")

    # Topic pages
    for idx, (section, page) in enumerate(FLAT):
        slug, title, ic, summary, blocks = page
        toc = [(f"s{i}", h) for i, (h, _p) in enumerate(blocks)]
        body = [f'<h1>{icon(ic, "icon h1-icon")}{title}</h1>',
                f'<p class="lede">{summary}</p>']
        for i, (heading, paras) in enumerate(blocks):
            body.append(f'<h2 id="s{i}">{heading}</h2>')
            body.extend(f"<p>{p}</p>" for p in paras)
        prev_p = FLAT[idx - 1][1] if idx else None
        next_p = FLAT[idx + 1][1] if idx + 1 < len(FLAT) else None
        pager = ['<nav class="pager">']
        pager.append(f'<a class="prev" href="{prev_p[0]}.html"><span>Previous</span>'
                     f'{prev_p[1]}</a>' if prev_p else "<span></span>")
        pager.append(f'<a class="next" href="{next_p[0]}.html"><span>Next</span>'
                     f'{next_p[1]}</a>' if next_p else "<span></span>")
        pager.append("</nav>")
        body.append("".join(pager))
        (OUT / f"{slug}.html").write_text(
            shell(title, slug,
                  crumb(("Help", "index.html"), (section, None), (title, None)),
                  "".join(body), toc),
            encoding="utf-8")

    print(f"wrote index + {len(FLAT)} topic pages to {OUT}")


if __name__ == "__main__":
    build()
