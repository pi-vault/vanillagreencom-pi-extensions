# pi-extension-manager

![Extension Manager browser and settings editor](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-extension-manager/assets/extension-manager.gif)

Pi package manager and separate settings editor for vstack-installed Pi packages.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-extension-manager):

```bash
pi install npm:@vanillagreen/pi-extension-manager
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-extension-manager --harness pi -y
```

Restart Pi after installation.

## Commands

| Command | Action |
| --- | --- |
| `/extensions` | Open the package manager: browse packages, enable/disable, inspect install source, uninstall, and run available updates. |
| `/extensions:settings` | Open the settings editor for packages that expose vstack settings. |
| `/extensions:enable` | Recovery command available only when the manager is disabled; re-enable it, then run `/reload`. |

## UI notes

- `/extensions` shows installed packages only. Selecting a package shows status, source path, install source (`NPM`, `Vstack`, or `Unknown`), versions, update state, and declared extension entrypoints.
- Active/inactive/broken status is shown with `●`/`○`/`×`; packages with a newer version show `Update Needed`.
- `alt+x` enables/disables the selected package, `alt+u` updates a package when an update is available, `alt+d` uninstalls, and `alt+a` opens diagnostics/audit. In diagnostics, `backspace` returns to the package list.
- `alt+shift+e` and `F11` open the extension manager popup; `alt+shift+s` and `F12` open the settings popup.
- `/extensions:settings` starts with `All`, then one tab per package with settings. Type to filter, `Enter` to toggle/edit, and `Esc` to cancel. The popup keeps a fixed height and pads blank space under short filtered lists.
- Inline setting editors support cursor movement: `←`/`→`, `Home`/`End`, `alt+←`/`alt+→` word movement, `Backspace`/`Delete`, and `Ctrl+U` clear.
- For packages declaring `pi.appendSystem` in `package.json`, enabling/disabling and uninstalling syncs the corresponding block in the scope's `APPEND_SYSTEM.md` (added on enable/install, removed on disable/uninstall).

Settings are stored under `vstack.extensionManager` in Pi `settings.json` files so they do not collide with Pi's top-level `extensions` array.

## Runtime limits

Pi does not currently expose APIs to add a native tab to its built-in settings UI or unload an already-loaded extension module. Package enable/disable and package updates therefore take effect after `/reload` or restart when live unloading is not possible.
