using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

[ComImport, Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A")]
class VirtualDesktopManager {}
[ComImport, Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVirtualDesktopManager {
    [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr window, [MarshalAs(UnmanagedType.Bool)] out bool current);
    [PreserveSig] int GetWindowDesktopId(IntPtr window, out Guid desktop);
    [PreserveSig] int MoveWindowToDesktop(IntPtr window, ref Guid desktop);
}

static class Program {
    delegate bool EnumWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int length);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    const string DesktopKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops";

    // Windows has a documented window-to-desktop API but no public ordered
    // desktop enumeration API. Explorer's IDs/names are best effort; discovered
    // window desktop IDs remain usable if this registry layout changes.
    static List<Guid> ReadDesktopOrder() {
        var ids = new List<Guid>();
        using (var key = Registry.CurrentUser.OpenSubKey(DesktopKey)) {
            var data = key == null ? null : key.GetValue("VirtualDesktopIDs") as byte[];
            if (data != null) for (int i = 0; i + 16 <= data.Length; i += 16) {
                var bytes = new byte[16]; Array.Copy(data, i, bytes, 0, 16);
                ids.Add(new Guid(bytes));
            }
        }
        return ids;
    }
    static string DesktopName(Guid id, int index) {
        using (var key = Registry.CurrentUser.OpenSubKey(DesktopKey + @"\Desktops\{" + id + "}")) {
            var name = key == null ? null : key.GetValue("Name") as string;
            return string.IsNullOrWhiteSpace(name) ? "Desktop " + (index + 1) : name;
        }
    }
    [STAThread]
    static int Main() {
        var json = new JavaScriptSerializer();
        IVirtualDesktopManager manager = null;
        try {
            manager = (IVirtualDesktopManager)new VirtualDesktopManager();
            var desktops = ReadDesktopOrder();
            var sources = new List<object>();
            var currentDesktops = new HashSet<Guid>();
            EnumWindows((window, unused) => {
                if (!IsWindowVisible(window)) return true;
                long style = GetWindowLongPtr(window, -20).ToInt64();
                if ((style & 0x80) != 0 || (GetWindow(window, 4) != IntPtr.Zero && (style & 0x40000) == 0)) return true;
                var title = new StringBuilder(1024);
                GetWindowText(window, title, title.Capacity);
                if (title.Length == 0) return true;
                Guid id;
                if (manager.GetWindowDesktopId(window, out id) < 0) return true;
                int cloaked;
                // Shell cloaking (2) is how another virtual desktop hides a
                // normal window. App-cloaked surfaces (1) are not user windows.
                if (DwmGetWindowAttribute(window, 14, out cloaked, 4) >= 0 && (cloaked & 1) != 0) return true;
                bool current;
                if (manager.IsWindowOnCurrentVirtualDesktop(window, out current) < 0) current = false;
                if (id != Guid.Empty) {
                    if (!desktops.Contains(id)) desktops.Add(id);
                    if (current && cloaked == 0) currentDesktops.Add(id);
                }
                sources.Add(new { id = "window:" + window.ToInt64() + ":0", name = title.ToString(),
                    kind = "window", desktopId = id == Guid.Empty ? null : id.ToString(), onCurrentDesktop = current });
                return true;
            }, IntPtr.Zero);
            Console.WriteLine(json.Serialize(new {
                desktops = desktops.Select((id, i) => new { id = id.ToString(), name = DesktopName(id, i), current = currentDesktops.Contains(id) }).ToArray(),
                sources = sources.ToArray()
            }));
            return 0;
        } catch (Exception error) {
            Console.WriteLine(json.Serialize(new { error = "Windows desktops: " + error.Message }));
            return 1;
        } finally { if (manager != null) Marshal.ReleaseComObject(manager); }
    }
}
