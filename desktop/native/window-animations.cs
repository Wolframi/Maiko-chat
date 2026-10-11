using System;
using System.Runtime.InteropServices;

// Keep native transitions, but do not paint a native frame under the transparent
// client corners. WS_CAPTION alone otherwise creates a white DWM backing surface.
class WindowAnimations {
    const int GWL_STYLE = -16;
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;
    const int DWMWA_NCRENDERING_ENABLED = 1;
    const int DWMWA_NCRENDERING_POLICY = 2;
    const int DWMNCRP_DISABLED = 1;
    [DllImport("user32.dll", SetLastError = true)] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", SetLastError = true)] static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

    static int Main(string[] args) {
        try {
            long handle;
            uint expectedProcess, owner;
            if (args.Length != 3 || !long.TryParse(args[0], out handle) || handle <= 0
                || !uint.TryParse(args[1], out expectedProcess) || expectedProcess == 0
                || (args[2] != "enable" && args[2] != "inspect")) return 1;
            var window = new IntPtr(handle);
            if (GetWindowThreadProcessId(window, out owner) == 0 || owner != expectedProcess) return 1;
            var style = GetWindowLong(window, GWL_STYLE);
            if (args[2] == "enable" && (style & WS_CAPTION) != WS_CAPTION) {
                // Apply before the first show. No frame recalculation is needed:
                // Electron continues to draw the entire client area and its own titlebar.
                if (SetWindowLong(window, GWL_STYLE, style | WS_CAPTION) == 0) return 1;
                style = GetWindowLong(window, GWL_STYLE);
            }
            if (args[2] == "enable") {
                int policy = DWMNCRP_DISABLED;
                if (DwmSetWindowAttribute(window, DWMWA_NCRENDERING_POLICY, ref policy, 4) < 0) return 1;
            }
            int nativeFrame;
            if (DwmGetWindowAttribute(window, DWMWA_NCRENDERING_ENABLED, out nativeFrame, 4) < 0) return 1;
            Console.WriteLine("{\"caption\":" + ((style & WS_CAPTION) == WS_CAPTION ? "true" : "false")
                + ",\"thickFrame\":" + ((style & WS_THICKFRAME) != 0 ? "true" : "false")
                + ",\"nativeFrame\":" + (nativeFrame != 0 ? "true" : "false") + "}");
            return args[2] == "enable" && ((style & WS_CAPTION) != WS_CAPTION || nativeFrame != 0) ? 1 : 0;
        } catch { return 1; }
    }
}
