using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

// Read-only ownership and render-session metadata. No audio/device capture.
class CaptureProcesses {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Entry {
        public uint size, usage, pid;
        public UIntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Devices { [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out Collection devices); }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Collection {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out Device device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Device { [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result); }
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Manager {
        [PreserveSig] int GetAudioSessionControl(IntPtr guid, uint flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, uint flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out Sessions sessions);
    }
    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Sessions {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out Control control);
    }
    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Control { [PreserveSig] int GetState(out int state); }
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Control2 {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
        [PreserveSig] int GetGroupingParam(out Guid group);
        [PreserveSig] int SetGroupingParam(IntPtr group, IntPtr context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int GetSessionIdentifier(out IntPtr name);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr name);
        [PreserveSig] int GetProcessId(out uint pid);
    }
    static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    static HashSet<uint> ActiveAudio() {
        var result = new HashSet<uint>();
        Devices devices = null; Collection collection = null;
        try {
            devices = (Devices)new Enumerator();
            if (devices.EnumAudioEndpoints(0, 1, out collection) != 0) return result;
            uint count; collection.GetCount(out count);
            for (uint i = 0; i < count; i++) {
                Device device = null; object managerObject = null; Sessions sessions = null;
                try {
                    collection.Item(i, out device);
                    var iid = typeof(Manager).GUID;
                    if (device.Activate(ref iid, 23, IntPtr.Zero, out managerObject) != 0) continue;
                    var manager = (Manager)managerObject;
                    if (manager.GetSessionEnumerator(out sessions) != 0) continue;
                    int number; sessions.GetCount(out number);
                    for (int j = 0; j < number; j++) {
                        Control control = null;
                        try {
                            if (sessions.GetSession(j, out control) != 0) continue;
                            int state; uint pid;
                            if (control.GetState(out state) == 0 && state == 1 && ((Control2)control).GetProcessId(out pid) == 0 && pid != 0) result.Add(pid);
                        } finally { Release(control); }
                    }
                } catch (COMException) { } finally { Release(sessions); Release(managerObject); Release(device); }
            }
        } catch (COMException) { } finally { Release(collection); Release(devices); }
        return result;
    }
    [MTAThread]
    static int Main() {
        var json = new StringBuilder("{\"parents\":{");
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot != new IntPtr(-1)) {
            try {
                var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
                if (Process32FirstW(snapshot, ref entry)) do {
                    if (json[json.Length - 1] != '{') json.Append(',');
                    json.Append('"').Append(entry.pid).Append("\":").Append(entry.parent);
                } while (Process32NextW(snapshot, ref entry));
            } finally { CloseHandle(snapshot); }
        }
        json.Append("},\"nativeAudio\":[");
        bool first = true;
        foreach (var pid in ActiveAudio()) { if (!first) json.Append(','); first = false; json.Append(pid); }
        Console.WriteLine(json.Append("]}").ToString());
        return 0;
    }
}
