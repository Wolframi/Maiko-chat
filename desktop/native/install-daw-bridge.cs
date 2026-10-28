using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;

// Elevation can write only this plug-in to the standard x64 VST3 location.
class InstallDawBridge {
    const string Name = "Maiko DAW Bridge.vst3";
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileEx(string source, string target, int flags);

    static string Checksum(string file) {
        using (var stream = File.OpenRead(file))
        using (var sha = SHA256.Create()) {
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
    }

    static int Main(string[] args) {
        try {
            if (args.Length != 2 || !Path.IsPathRooted(args[0]) ||
                Path.GetFileName(args[0]) != Name || args[1].Length != 64 || Checksum(args[0]) != args[1]) return 1;
            using (var identity = WindowsIdentity.GetCurrent()) {
                if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) {
                    var start = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName) {
                        UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden,
                        Arguments = "\"" + args[0] + "\" " + args[1]
                    };
                    using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
                }
            }
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles),
                "VST3", Name, "Contents", "x86_64-win");
            Directory.CreateDirectory(directory);
            var target = Path.Combine(directory, Name);
            var temporary = Path.Combine(directory, ".maiko-" + Guid.NewGuid().ToString("N") + ".tmp");
            try {
                File.Copy(args[0], temporary);
                if (Checksum(temporary) != args[1]) throw new IOException("VST3 checksum mismatch");
                // Atomic replacement preserves a loaded/locked previous module.
                if (!MoveFileEx(temporary, target, 0x1 | 0x8)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (Checksum(target) != args[1]) throw new IOException("Installed VST3 checksum mismatch");
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
