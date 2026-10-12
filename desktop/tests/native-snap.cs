using System;
using System.Runtime.InteropServices;
using System.Threading;

class NativeSnap {
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    static void Key(byte key, bool up) { keybd_event(key, 0, up ? 2u : 0u, UIntPtr.Zero); }
    static int Main(string[] args) {
        IntPtr previous = GetForegroundWindow();
        try {
            if (args.Length != 3) return 1;
            var window = new IntPtr(long.Parse(args[0]));
            uint owner;
            if (GetWindowThreadProcessId(window, out owner) == 0 || owner != uint.Parse(args[1])) return 1;
            if (args[2] != "left" && args[2] != "right" && args[2] != "down") return 1;
            SetForegroundWindow(window); Thread.Sleep(150);
            if (GetForegroundWindow() != window) return 1;
            byte arrow = args[2] == "left" ? (byte)0x25 : args[2] == "right" ? (byte)0x27 : (byte)0x28;
            Key(0x5B, false); Key(arrow, false); Thread.Sleep(50);
            Key(arrow, true); Key(0x5B, true); Thread.Sleep(600);
            // Dismiss Snap Assist without choosing or rearranging another app.
            Key(0x1B, false); Key(0x1B, true);
            return 0;
        } catch { return 1; }
        finally { Key(0x5B, true); if (previous != IntPtr.Zero) SetForegroundWindow(previous); }
    }
}
