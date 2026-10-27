// Render only the isolated test host's own VST editor, never the desktop.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
class EditorSnapshot {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    static void Main(string[] args) {
        var window = new IntPtr(long.Parse(args[0]));
        uint process; GetWindowThreadProcessId(window, out process);
        var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
        if (process != uint.Parse(args[1]) || name.ToString() != "MaikoDawBridgeEditor02") throw new Exception("Not the isolated VST editor");
        Rect rect; if (!GetClientRect(window, out rect)) throw new Exception("No editor");
        using (var bitmap = new Bitmap(rect.Right, rect.Bottom, PixelFormat.Format24bppRgb)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                var dc = graphics.GetHdc();
                try { if (!PrintWindow(window, dc, 3)) throw new Exception("Editor render failed"); }
                finally { graphics.ReleaseHdc(dc); }
            }
            var center = bitmap.GetPixel(rect.Right / 2, 194);
            if (center.B < 50 || center.B <= center.R) throw new Exception("VST editor has no filled signal indicator");
            bitmap.Save(args[2], ImageFormat.Png);
        }
    }
}
