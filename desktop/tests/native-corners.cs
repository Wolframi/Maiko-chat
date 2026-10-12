using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

// Test helper: capture only our owned test window, over a solid test backdrop.
class NativeCorners {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetFrameBounds(IntPtr window, int attribute, out Rect value, int size);
    static int Main(string[] args) {
        try {
            long handle;
            uint expected, owner;
            if (args.Length != 3 || !long.TryParse(args[0], out handle)
                || !uint.TryParse(args[1], out expected) || expected == 0) return 1;
            var window = new IntPtr(handle);
            if (GetWindowThreadProcessId(window, out owner) == 0 || owner != expected) return 1;
            SetProcessDPIAware();
            int enabled;
            DwmGetWindowAttribute(window, 1, out enabled, 4);
            Rect rect;
            // Native resizing uses an invisible border outside the visible
            // frame. Capture the actual displayed window, excluding that border.
            if (DwmGetFrameBounds(window, 9, out rect, Marshal.SizeOf(typeof(Rect))) < 0 && !GetWindowRect(window, out rect)) return 1;
            using (var bitmap = new Bitmap(rect.right - rect.left, rect.bottom - rect.top)) {
                using (var graphics = Graphics.FromImage(bitmap))
                    graphics.CopyFromScreen(rect.left, rect.top, 0, 0, bitmap.Size);
                bitmap.Save(args[2], ImageFormat.Png);
            }
            Console.WriteLine("{\"nonClientRendering\":" + enabled + "}");
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
