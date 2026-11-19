// Windows toast notifications for the human (gates, questions, stuck mail). No dependencies:
// PowerShell 5.1 + WinRT, shown under PowerShell's app id. Disabled with BRIDGE_NOTIFY=0 or off-Windows.
import { spawn } from "node:child_process";

const AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
const recent = new Map<string, number>();

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

export function toast(title: string, body: string, url?: string) {
  if (process.platform !== "win32" || process.env.BRIDGE_NOTIFY === "0") return;
  const key = title + "\n" + body;
  const last = recent.get(key);
  if (last && Date.now() - last < 60_000) return; // don't repeat the same toast within a minute
  recent.set(key, Date.now());

  const launch = url ? ` activationType="protocol" launch="${xmlEsc(url)}"` : "";
  const xml = `<toast${launch}><visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(body)}</text></binding></visual></toast>`;
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$x.LoadXml('${xml.replace(/'/g, "''")}')`,
    "$t = [Windows.UI.Notifications.ToastNotification]::new($x)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show($t)`,
  ].join("\n");
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // notifications are best effort
  }
}
