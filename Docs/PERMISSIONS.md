# Chrome Permissions (Justification)

| Permission     | Why it’s needed | How we limit scope |
|----------------|------------------|--------------------|
| `tabCapture`   | Capture **tab audio** for transcription (primary mode). | Only when user clicks **Start**; stops immediately on **Stop**; no video frames are captured. |
| `scripting`    | Inject a minimal script to **seek** the active tab when the user clicks a timestamp. | Runs only on the active tab (via `activeTab` grant), single function, no DOM scraping. |
| `activeTab`    | Grants temporary access to the current tab after a user gesture (Start/Seek). | No blanket host permissions; keeps review time low and scope narrow. |
| `sidePanel`    | The UI lives in Chrome’s **side panel**. | UI only. |
| `storage`      | Save user settings (segment length, overlap, theme) and local transcript cache. | Stored locally; never synced or sent elsewhere by the extension. |

**No broad host permissions** are requested; the extension does *not* inject global content scripts.
