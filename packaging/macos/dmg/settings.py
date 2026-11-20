# dmgbuild settings for Crewreview's macOS disk image. Used by apps/desktop/scripts/make-dmg.sh:
#   dmgbuild -s settings.py -D app=…/Crewreview.app -D background=…/background.png -D icon=…/icon.icns Crewreview out.dmg
# The layout is written straight into the image (.DS_Store), so it doesn't need Finder, and works in CI.
# Icon positions must match scripts/dmg-background.ts (APP and APPS), which draws the picture behind them.
import os.path

# dmgbuild runs this file with the -D values in `defines`: the app, the background and the volume icon.
app = defines["app"]  # noqa: F821
name = os.path.basename(app)

format = "ULFO"  # lzfse: smaller and fast to open, macOS 10.11+
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
icon = defines.get("icon")  # noqa: F821
badge_icon = None

background = defines["background"]  # noqa: F821 (background@2x.png next to it makes it sharp on Retina)
window_rect = ((200, 140), (660, 420))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 112
text_size = 13
arrange_by = None
label_pos = "bottom"
icon_locations = {
    name: (165, 200),
    "Applications": (495, 200),
    # Hidden files show when someone has Finder show them: keep them out of the window.
    ".background.tiff": (900, 900),
    ".background.png": (900, 900),
    ".VolumeIcon.icns": (1000, 900),
    ".fseventsd": (1100, 900),
    ".Trashes": (1200, 900),
}
hide_extensions = [name]
