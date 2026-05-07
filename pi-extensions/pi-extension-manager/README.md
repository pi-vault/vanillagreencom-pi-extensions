# pi-extension-manager

![Extension manager popup](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-extension-manager/assets/extension-manager-popup.png)

Pi extension inventory and settings manager for vstack-installed packages.

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
| `/extensions` | Open the package/resource browser. |
| `/extensions:settings` | Open the quick settings editor for packages that expose vstack settings. |
| `/extensions:enable` | Recovery command available only when the manager is disabled; re-enable it, then run `/reload`. |

## UI notes

- `/extensions` opens on the `All` tab. Selecting a package shows its overview, resources, and settings in the inspector.
- Package tabs show one package plus its child resources.
- `Alt+R` toggles the raw resource list; `Alt+A` opens diagnostics/audit; `Tab` and `Shift+Tab` cycle tabs.
- `Delete` resets the selected setting; `Ctrl+X` resets settings for the selected extension/package.
- `/extensions:settings` starts with `All`, then one tab per package with settings. Type to filter, `Enter` to toggle/edit, `Esc` to cancel.
- Inline setting editors support cursor movement: `←`/`→`, `Home`/`End`, `Alt+←`/`Alt+→` word movement, `Backspace`/`Delete`, and `Ctrl+U` clear.

Settings are stored under `vstack.extensionManager` in Pi `settings.json` files so they do not collide with Pi's top-level `extensions` array.

## Runtime limits

Pi does not currently expose APIs to add a native tab to its built-in settings UI or unload an already-loaded extension module. Package/provider enable-disable therefore takes effect after `/reload` or restart when live unloading is not possible. Tool enable-disable is applied live with `pi.setActiveTools()`.
