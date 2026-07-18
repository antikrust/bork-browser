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
    "command": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m8 9 3 3-3 3"/><path d="M13 15h3"/>',
    "urlbar": '<rect width="18" height="7" x="3" y="8.5" rx="3.5"/><path d="M7 12h.01"/>',
    "start": '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>',
    "hub": '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M19.1 4.9l-2.9 2.9M7.8 16.2l-2.9 2.9"/>',
    "eye-off": '<path d="M10.7 5.1A11 11 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3 7 10 7a11 11 0 0 0 5.4-1.4"/><path d="m2 2 20 20"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    "shield": '<path d="M12 2 4 6v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6Z"/>',
    "note": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/>',
    "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/>',
    "qr": '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1"/>',
    "rows": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18"/>',
    "palette": '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a6 6 0 0 0 6-6c0-5-4.5-9-10-9Z"/>',
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
    ("Finding things", [
        ("command-palette", "Command palette", "command",
         "Press F2 and start typing to run almost anything without hunting through menus.",
         [("Using it",
           ["F2 opens the palette. Type and it filters as you go; Enter runs the highlighted entry, Escape closes it. Typing something that looks like an address offers to navigate there.",
            "Entries are grouped by what they act on: navigation, tabs, open tabs, zoom, bookmarks, history, downloads, search, scrolling, sidebar, window, workspaces, media and tools, with the things you have used recently floating to the top."]),
          ("Why it is here",
           ["derp hides a lot of chrome by default. The palette is the fallback for anything whose button is not on screen, which makes running with the address bar and toolbars hidden practical rather than awkward."])]),
        ("address-bar", "Working without the address bar", "urlbar",
         "The address bar can be hidden entirely; double-clicking a tab is how you navigate instead.",
         [("Hiding it",
           ["Alt+Cmd+A hides or shows the address bar. Hidden, the browser is page and tabs and nothing else.",
            "It is not gone, only out of the way — it peeks back when focused, and Escape dismisses it again."]),
          ("Navigating instead",
           ["Double-click any tab and it opens into a text field over itself: type a URL, Enter goes, Escape backs out. Tabs in a stack's second row do the same.",
            "Back and forward remain Cmd+Left and Cmd+Right, and the command palette on F2 reaches anything else."])]),
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
        ("start-page", "Start page", "start",
         "The page new tabs open on: your sites, a clock, a search box and a wallpaper.",
         [("Your sites",
           ["The tiles are the sites you added and nothing else — derp does not fill the page from your browsing history. Add site puts one there; right-click a tile to pin, dismiss or block it.",
            "Dismiss simply takes a tile off. Block also remembers the address so it is not offered again, and blocked sites can be brought back from the settings panel."]),
          ("Wallpapers",
           ["The page ships a set of derp wallpapers and picks one per session; you can supply your own image instead. The same wallpapers sit behind first-run setup."])]),
        ("hub", "The Hub", "hub",
         "derp's own settings, separate from Firefox's preferences.",
         [("What lives there",
           ["Anything derp adds is configured in the Hub: workspaces, tab stacks, the panel sidebar, mouse gestures, keyboard shortcuts, web apps, the start page and the design settings. Importing from another browser is there too.",
            "Open it from the menu or by going to about:hub. Firefox's own preferences stay where they were, at about:preferences, and the Hub is reachable from that page's sidebar."])]),
        ("share-mode", "Share mode", "eye-off",
         "Blanks the parts of the window that would give away more than you meant to share.",
         [("When to use it",
           ["Screen sharing exposes your tab titles, bookmarks and whatever else is on the chrome. Share mode covers that, leaving the page itself visible.",
            "Toggle it from the menu. Zen mode is the related tool when the aim is concentration rather than privacy — it retracts the chrome instead of masking it."])]),
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
         [("derp's own keys",
           ["The chrome controls sit on Alt+Cmd (Ctrl+Alt on Windows and Linux) rather than bare keys, so they cannot fire while you are typing into a page.",
            "Alt+Cmd+A hides or shows the address bar. Alt+Cmd+S hides or shows the panel sidebar. Alt+Cmd+Z toggles zen mode. Holding Alt+Cmd and dragging moves the window from anywhere on it, with no title bar needed."]),
          ("Navigating without an address bar",
           ["Double-click a tab and it opens into a text field: type a URL, press Enter to go, Escape to back out. Tabs in a stack's second row behave the same way. With the address bar hidden this is how you navigate.",
            "Back and forward stay on Cmd+Left and Cmd+Right, as in Firefox; Cmd+[ and Cmd+] work too."]),
          ("Changing shortcuts",
           ["derp's shortcuts are listed and editable in the Hub, alongside Firefox's own. Conflicts are flagged as you assign them."])]),
    ]),
    ("Extras", [
        ("containers", "Containers", "shield",
         "Keeps sites in separate compartments so their cookies and logins cannot see each other.",
         [("How containers work",
           ["A container is an isolated slice of storage. A site opened in one cannot read the cookies or logins of the same site in another, so you can be signed into several accounts at once without them colliding.",
            "Right-click a link or tab to open or reopen it in a container. A workspace can be tied to one, so everything opened inside it is compartmented automatically."]),
          ("Private containers",
           ["Open in Private Container makes a throwaway compartment: it behaves like a container while it is open and takes its storage with it when it closes. Useful for one-off logins you do not want kept."])]),
        ("notes", "Notes", "note",
         "A notepad that lives in the sidebar, so it is beside the page rather than in another window.",
         [("Taking notes",
           ["Notes open as a panel in the sidebar and stay there while you browse. They are stored in your profile and can sync."])]),
        ("profiles", "Profiles", "users",
         "Separate browsers on one machine, each with its own tabs, extensions and history.",
         [("Managing profiles",
           ["The profile manager creates, switches between and deletes profiles. Where workspaces separate tabs inside one browser, profiles separate everything — settings, extensions, history and logins.",
            "Note that derp shares the profile location with Floorp, so if both are installed they see the same profiles."])]),
        ("qr-codes", "QR codes", "qr",
         "Turns the page you are on into a QR code to pick up on a phone.",
         [("Generating one",
           ["Generate QR Code from the address bar's page actions renders the current URL as a code you can scan, copy as an image, or download."])]),
        ("tab-bar", "Tab bar layout", "rows",
         "Where the tabs go and how much room they take.",
         [("Layouts",
           ["The tab bar can run horizontally, vertically down the side, or across multiple rows when there are more tabs than fit, and it can sit above or below the address bar.",
            "derp adds a second row of its own for tab stacks — that is the stack's tabs, not a layout setting, and it appears only while a stack is active."])]),
        ("themes", "Themes and appearance", "palette",
         "Light, dark and the compact look derp ships with.",
         [("Changing the look",
           ["Theme and interface density are in the Hub's design settings, alongside Firefox's own theme handling. derp's compact skin is the default and tightens the toolbar and tab strip against stock Firefox.",
            "Firefox themes from addons.mozilla.org install and work as they normally would."])]),
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
