using System;
using System.Runtime.InteropServices;
using System.Threading;

class NativeDrag {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool GetClipCursor(out Rect rect);
    static int Main(string[] args) {
        bool pressed = false;
        Point original = new Point();
        try {
            bool snap = args.Length == 7 && args[6] == "snap";
            if (args.Length != 6 && !snap) return 1;
            var window = new IntPtr(long.Parse(args[0]));
            uint owner;
            if (GetWindowThreadProcessId(window, out owner) == 0 || owner != uint.Parse(args[1])) return 1;
            if (snap) { SetForegroundWindow(window); Thread.Sleep(200); }
            SetProcessDPIAware();
            Rect rect;
            if (!GetWindowRect(window, out rect) || !GetCursorPos(out original)) return 1;
            int x = args[2] == "w" ? rect.left + 3 : args[2] == "e" ? rect.right - 4 : args[2] == "c" ? (rect.left + rect.right) / 2 : rect.left + int.Parse(args[2]);
            int y = args[3] == "n" ? rect.top + 3 : args[3] == "s" ? rect.bottom - 4 : args[3] == "c" ? (rect.top + rect.bottom) / 2 : rect.top + int.Parse(args[3]);
            int dx = int.Parse(args[4]), dy = int.Parse(args[5]);
            // Electron's client bounds exclude the invisible DWM resize frame.
            // Snap targets are absolute screen pixels so both edges are exact.
            if (snap) { dx -= x; dy -= y; }
            var hit = SendMessage(window, 0x0084, IntPtr.Zero, new IntPtr((y << 16) | (x & 0xffff))).ToInt32();
            SetCursorPos(x, y); Thread.Sleep(80);
            mouse_event(2, 0, 0, 0, UIntPtr.Zero); pressed = true;
            Thread.Sleep(200);
            for (int i = 1; i <= 12; i++) { SetCursorPos(x + dx * i / 12, y + dy * i / 12); Thread.Sleep(snap ? 60 : 25); }
            if (snap) Thread.Sleep(400);
            Point end; GetCursorPos(out end);
            Rect clip; GetClipCursor(out clip);
            mouse_event(4, 0, 0, 0, UIntPtr.Zero); pressed = false;
            Thread.Sleep(snap ? 600 : 100);
            if (snap) { keybd_event(0x1B, 0, 0, UIntPtr.Zero); keybd_event(0x1B, 0, 2, UIntPtr.Zero); }
            Console.WriteLine("{\"hit\":" + hit + ",\"width\":" + (rect.right - rect.left) + ",\"height\":" + (rect.bottom - rect.top) + ",\"cursor\":[" + end.x + "," + end.y + "],\"target\":[" + (x+dx) + "," + (y+dy) + "],\"clip\":[" + clip.left + "," + clip.top + "," + clip.right + "," + clip.bottom + "]}");
            return 0;
        } catch { return 1; }
        finally {
            if (pressed) mouse_event(4, 0, 0, 0, UIntPtr.Zero);
            SetCursorPos(original.x, original.y);
        }
    }
}
