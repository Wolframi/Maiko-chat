using System;
using System.Text;
using System.Runtime.InteropServices;

// Resolve only the HWNDs enumerated by Electron. No capture, hooks, driver,
// microphone access or user-supplied commands; stdout contains numeric JSON.
class WindowProcesses {
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window, WindowCallback callback, IntPtr parameter);
    static uint Owner(long handle) {
        var window = new IntPtr(handle);
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        var name = new StringBuilder(256);
        GetClassName(window, name, name.Capacity);
        // UWP's visible frame belongs to ApplicationFrameHost, not the app.
        if (name.ToString() == "ApplicationFrameWindow") {
            EnumChildWindows(window, (child, unused) => {
                var childName = new StringBuilder(256);
                GetClassName(child, childName, childName.Capacity);
                if (childName.ToString() == "Windows.UI.Core.CoreWindow") {
                    GetWindowThreadProcessId(child, out owner);
                    return false;
                }
                return true;
            }, IntPtr.Zero);
        }
        return owner;
    }
    static int Main(string[] args) {
        try {
            if (args.Length != 1) return 1;
            var result = new StringBuilder("{");
            foreach (var text in args[0].Split(',')) {
                long handle;
                if (text.Length == 0 || !long.TryParse(text, out handle) || handle < 0) return 1;
                if (result.Length > 1) result.Append(',');
                result.Append('"').Append(handle).Append("\":").Append(Owner(handle));
            }
            Console.WriteLine(result.Append('}').ToString());
            return 0;
        } catch { return 1; }
    }
}
