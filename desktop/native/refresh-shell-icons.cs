using System;
using System.IO;
using System.Runtime.InteropServices;

// Notify Explorer about the specific rebuilt executable. No global icon-cache
// deletion, registry changes or Explorer restart is needed.
class RefreshShellIcons {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern void SHChangeNotify(
        int change, uint flags, [MarshalAs(UnmanagedType.LPWStr)] string first, IntPtr second);
    static int Main(string[] args) {
        try {
            if (args.Length == 0) return 1;
            foreach (var file in args) {
                if (!Path.IsPathRooted(file) || !File.Exists(file) || !file.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return 1;
                // SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSH.
                SHChangeNotify(0x2000, 0x1005, file, IntPtr.Zero);
            }
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
