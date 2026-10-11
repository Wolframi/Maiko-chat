using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

// Inspect only the test application's own HWND or a supplied built executable.
class NativeIcons {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct FileInfo {
        public IntPtr icon;
        public int index;
        public uint attributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string display;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string type;
    }
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
        IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern uint ExtractIconEx(string file, int index,
        out IntPtr large, out IntPtr small, uint count);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "PrivateExtractIconsW")] static extern uint PrivateExtractIcons(
        string file, int index, int width, int height, out IntPtr icon, out uint id, uint count, uint flags);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SHGetFileInfo(
        string file, uint attributes, ref FileInfo info, uint size, uint flags);
    static void Save(IntPtr handle, string file) {
        if (handle == IntPtr.Zero) throw new Exception("Missing native icon: " + file);
        using (var icon = Icon.FromHandle(handle))
        using (var bitmap = icon.ToBitmap()) bitmap.Save(file, ImageFormat.Png);
    }
    static int Main(string[] args) {
        try {
            IntPtr large, small;
            if (args.Length == 4 && args[0] == "extract") {
                int size;
                uint id;
                if (!int.TryParse(args[3], out size) || size < 16 || size > 256
                    || PrivateExtractIcons(args[1], 0, size, size, out large, out id, 1, 0) != 1) return 1;
                try { Save(large, args[2]); } finally { DestroyIcon(large); }
            } else if (args.Length == 3 && args[0] == "shell") {
                foreach (var flag in new uint[] { 0, 1 }) {
                    var info = new FileInfo();
                    if (SHGetFileInfo(args[1], 0, ref info, (uint)Marshal.SizeOf(info), 0x100 | flag) == IntPtr.Zero) return 1;
                    try { Save(info.icon, args[2] + (flag == 0 ? "-large.png" : "-small.png")); }
                    finally { DestroyIcon(info.icon); }
                }
            } else if (args.Length == 3 && args[0] == "exe") {
                if (ExtractIconEx(args[1], 0, out large, out small, 1) == 0) return 1;
                try { Save(large, args[2] + "-large.png"); Save(small, args[2] + "-small.png"); }
                finally { DestroyIcon(large); DestroyIcon(small); }
            } else if (args.Length == 3) {
                long handle;
                uint expected, owner;
                if (!long.TryParse(args[0], out handle) || !uint.TryParse(args[1], out expected) || expected == 0) return 1;
                var window = new IntPtr(handle);
                if (GetWindowThreadProcessId(window, out owner) == 0 || owner != expected) return 1;
                if (SendMessageTimeout(window, 0x7F, new IntPtr(1), IntPtr.Zero, 2, 2000, out large) == IntPtr.Zero
                    || SendMessageTimeout(window, 0x7F, IntPtr.Zero, IntPtr.Zero, 2, 2000, out small) == IntPtr.Zero) return 1;
                Save(large, args[2] + "-large.png"); Save(small, args[2] + "-small.png");
            } else return 1;
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
