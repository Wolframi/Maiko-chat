using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Generic;

// Sample two pixels inside our topmost test window during live resizing.
// No screenshot of the user's desktop is saved.
class NativeResize {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetFrameBounds(IntPtr window, int attribute, out Rect value, int size);
    static int Main(string[] args) {
        try {
            long handle;
            uint expected, owner;
            if (args.Length != 2 || !long.TryParse(args[0], out handle) || !uint.TryParse(args[1], out expected) || expected == 0) return 1;
            var window = new IntPtr(handle);
            if (GetWindowThreadProcessId(window, out owner) == 0 || owner != expected) return 1;
            SetProcessDPIAware();
            int black = 0, other = 0, samples = 0;
            var colors = new List<string>();
            Console.WriteLine("READY"); Console.Out.Flush();
            using (var bitmap = new Bitmap(1, 1))
            using (var graphics = Graphics.FromImage(bitmap)) {
                for (int i = 0; i < 200; i++) {
                    // GetWindowRect can advance before DWM presents the new
                    // bounds. Synchronize before sampling the displayed window.
                    DwmFlush();
                    Rect rect;
                    if (DwmGetFrameBounds(window, 9, out rect, Marshal.SizeOf(typeof(Rect))) < 0 && !GetWindowRect(window, out rect)) return 1;
                    foreach (var point in new [] { new Point(rect.right - 24, rect.top + 200), new Point(rect.left + 400, rect.bottom - 24) }) {
                        graphics.CopyFromScreen(point.X, point.Y, 0, 0, bitmap.Size);
                        var c = bitmap.GetPixel(0, 0); samples++;
                        if (c.R < 4 && c.G < 4 && c.B < 4) black++;
                        // Fixture color or the dark shell fallback while Chromium
                        // draws. DWM can blend the shell's translucent decoration.
                        else if (!((c.R == 41 && c.G == 61 && c.B == 81)
                            || (c.R < 32 && c.G < 32 && c.B < 32 && Math.Max(c.R, Math.Max(c.G, c.B)) - Math.Min(c.R, Math.Min(c.G, c.B)) < 5))) {
                            other++;
                            if (colors.Count < 8) colors.Add("\"" + c.R + "," + c.G + "," + c.B + "@" + (rect.right-rect.left) + "x" + (rect.bottom-rect.top) + "\"");
                        }
                    }
                    Thread.Sleep(5);
                }
            }
            Console.WriteLine("{\"samples\":" + samples + ",\"black\":" + black + ",\"other\":" + other + ",\"colors\":[" + String.Join(",", colors) + "]}");
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
