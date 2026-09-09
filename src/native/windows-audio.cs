// WASAPI process loopback. No driver or SDK installation required: build with
// the .NET Framework compiler included in Windows. PCM is stereo float32/48kHz.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

public static class Native {
    public static void Check(int hr) { Marshal.ThrowExceptionForHR(hr); }
    public static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode)]
    public static extern int ActivateAudioInterfaceAsync(string device, ref Guid iid, ref PropVariant parameters, ICompletion completion, out IOperation operation);
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PropVariant {
        [FieldOffset(0)] public ushort type;
        [FieldOffset(8)] public uint size;
        [FieldOffset(16)] public IntPtr data;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public struct WaveFormat {
        public ushort tag, channels;
        public uint rate, bytes;
        public ushort align, bits, extra;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessEntry {
        public uint size, usage, pid;
        public UIntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe;
    }
    [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    public static Dictionary<uint, uint> Parents() {
        var parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new Exception("Cannot enumerate audio process trees.");
        try {
            var entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32FirstW(snapshot, ref entry)) do { parents[entry.pid] = entry.parent; } while (Process32NextW(snapshot, ref entry));
        } finally { CloseHandle(snapshot); }
        return parents;
    }
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDevices {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint state, out ICollection devices);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISessionManager {
    void GetAudioSessionControl(); void GetSimpleAudioVolume();
    [PreserveSig] int GetSessionEnumerator(out ISessions sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISessions {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out ISession session);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISession {
    [PreserveSig] int GetState(out int state);
    void GetDisplayName(); void SetDisplayName(); void GetIconPath(); void SetIconPath();
    void GetGroupingParam(); void SetGroupingParam(); void RegisterAudioSessionNotification(); void UnregisterAudioSessionNotification();
    void GetSessionIdentifier(); void GetSessionInstanceIdentifier();
    [PreserveSig] int GetProcessId(out uint pid);
}
[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOperation {
    [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
}
[ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICompletion {
    [PreserveSig] int ActivateCompleted(IOperation operation);
}
[ComVisible(true), Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgileObject {}
[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
    [PreserveSig] int Initialize(int mode, uint flags, long duration, long period, ref Native.WaveFormat format, IntPtr session);
    void GetBufferSize(); void GetStreamLatency(); void GetCurrentPadding(); void IsFormatSupported(); void GetMixFormat(); void GetDevicePeriod();
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    void Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, out ICaptureClient capture);
}
[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong qpc);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public class Completion : ICompletion, IAgileObject {
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public IAudioClient Client;
    public Exception Error;
    public int ActivateCompleted(IOperation operation) {
        try {
            int result; object activated;
            Native.Check(operation.GetActivateResult(out result, out activated));
            Native.Check(result);
            Client = (IAudioClient)activated;
        } catch (Exception error) { Error = error; }
        finally { Done.Set(); }
        return 0;
    }
}

sealed class Capture : IDisposable {
    IAudioClient client;
    ICaptureClient capture;
    readonly AutoResetEvent available = new AutoResetEvent(false);
    public Capture(uint pid, bool include) {
        IntPtr parameters = Marshal.AllocHGlobal(12);
        IOperation operation = null;
        var completion = new Completion();
        try {
            Marshal.WriteInt32(parameters, 0, 1); // PROCESS_LOOPBACK
            Marshal.WriteInt32(parameters, 4, (int)pid);
            Marshal.WriteInt32(parameters, 8, include ? 0 : 1);
            var variant = new Native.PropVariant { type = 65, size = 12, data = parameters };
            Guid iid = typeof(IAudioClient).GUID;
            Native.Check(Native.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, ref variant, completion, out operation));
            if (!completion.Done.WaitOne(10000)) throw new Exception("Windows audio activation timed out.");
            if (completion.Error != null) throw completion.Error;
            client = completion.Client;
            var format = new Native.WaveFormat { tag = 3, channels = 2, rate = 48000, bytes = 384000, align = 8, bits = 32 };
            Native.Check(client.Initialize(0, 0x80060000, 0, 0, ref format, IntPtr.Zero));
            iid = typeof(ICaptureClient).GUID;
            Native.Check(client.GetService(ref iid, out capture));
            Native.Check(client.SetEventHandle(available.SafeWaitHandle.DangerousGetHandle()));
            Native.Check(client.Start());
        } catch { Dispose(); throw; }
        finally { Native.Release(operation); Marshal.FreeHGlobal(parameters); GC.KeepAlive(completion); }
    }
    // Position packets against WASAPI's common QPC clock, so independently
    // captured applications are mixed on the same timeline, without drift.
    public void Drain(Action<float[], ulong> packet) {
        uint frames;
        while (true) {
            Native.Check(capture.GetNextPacketSize(out frames));
            if (frames == 0) return;
            IntPtr data; uint flags; ulong position, qpc;
            Native.Check(capture.GetBuffer(out data, out frames, out flags, out position, out qpc));
            try {
                var samples = new float[frames * 2];
                if ((flags & 2) == 0) Marshal.Copy(data, samples, 0, samples.Length);
                packet(samples, qpc);
            } finally { Native.Check(capture.ReleaseBuffer(frames)); }
        }
    }
    public void Dispose() {
        if (client != null) client.Stop();
        Native.Release(capture); capture = null;
        Native.Release(client); client = null;
        available.Dispose();
    }
}

class AudioApp { public uint Pid; public string Name; }
class Selection { public string mode { get; set; } public string[] apps { get; set; } }
static class Program {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static volatile bool stopped;
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); }
    static bool Descendant(uint pid, uint ancestor, Dictionary<uint, uint> parents) {
        var seen = new HashSet<uint>();
        while (parents.TryGetValue(pid, out pid) && seen.Add(pid)) if (pid == ancestor) return true;
        return false;
    }
    static uint[] CaptureRoots(List<AudioApp> apps, Selection selection, HashSet<string> selected) {
        var parents = Native.Parents();
        var allowed = apps.Where(a => selection.mode == "include" ? selected.Contains(a.Name) : !selected.Contains(a.Name)).ToArray();
        var blocked = apps.Except(allowed).ToArray();
        // Windows captures process trees. Never double-mix a parent's child, or
        // silently include an explicitly excluded descendant's audio.
        foreach (var app in allowed) {
            if (blocked.Any(other => Descendant(other.Pid, app.Pid, parents)))
                throw new Exception("Windows groups " + app.Name + " with an excluded child application. Select matching audio settings for these applications.");
        }
        return allowed.Where(a => !allowed.Any(parent => parent.Pid != a.Pid && Descendant(a.Pid, parent.Pid, parents))).Select(a => a.Pid).ToArray();
    }
    static List<AudioApp> ListApps() {
        var result = new Dictionary<uint, AudioApp>();
        IDevices enumerator = (IDevices)new Enumerator();
        ICollection devices = null;
        try {
            Native.Check(enumerator.EnumAudioEndpoints(0, 1, out devices));
            uint count; Native.Check(devices.GetCount(out count));
            for (uint d = 0; d < count; d++) {
                IDevice device = null; object manager = null; ISessions sessions = null;
                try {
                    Native.Check(devices.Item(d, out device));
                    Guid iid = typeof(ISessionManager).GUID;
                    Native.Check(device.Activate(ref iid, 23, IntPtr.Zero, out manager));
                    Native.Check(((ISessionManager)manager).GetSessionEnumerator(out sessions));
                    int total; Native.Check(sessions.GetCount(out total));
                    for (int i = 0; i < total; i++) {
                        ISession session = null;
                        try {
                            Native.Check(sessions.GetSession(i, out session));
                            uint pid; int state;
                            Native.Check(session.GetProcessId(out pid)); Native.Check(session.GetState(out state));
                            if (pid == 0 || state == 2 || result.ContainsKey(pid)) continue;
                            using (var process = Process.GetProcessById((int)pid)) {
                                result[pid] = new AudioApp { Pid = pid, Name = process.ProcessName.ToLowerInvariant() + ".exe" };
                            }
                        } catch (ArgumentException) { /* process exited */ }
                        finally { Native.Release(session); }
                    }
                } finally { Native.Release(sessions); Native.Release(manager); Native.Release(device); }
            }
        } finally { Native.Release(devices); Native.Release(enumerator); }
        return result.Values.ToList();
    }
    [DllImport("kernel32.dll")] static extern bool QueryPerformanceCounter(out long count);
    [DllImport("kernel32.dll")] static extern bool QueryPerformanceFrequency(out long frequency);
    static long ClockFrame() { long count, frequency; QueryPerformanceCounter(out count); QueryPerformanceFrequency(out frequency); return (long)(count * (48000.0 / frequency)); }
    [MTAThread]
    static int Main(string[] args) {
        try {
            if (args.Length > 0 && args[0] == "list") {
                Emit(new { sources = ListApps().Select(a => a.Name).Distinct().OrderBy(n => n).Select(n => new { id = "app:" + n, label = n, monitor = false, running = true }).ToArray() });
                return 0;
            }
            var selection = Json.Deserialize<Selection>(args.Length > 0 ? args[0] : "{}");
            var selected = new HashSet<string>(selection.apps ?? new string[0], StringComparer.OrdinalIgnoreCase);
            new Thread(() => { while (Console.In.Read() != -1) {} stopped = true; }) { IsBackground = true }.Start();
            var captures = new Dictionary<uint, Capture>();
            var mix = new float[48000 * 2];
            long cursor = ClockFrame();
            long refresh = 0;
            bool ready = false;
            try {
                while (!stopped) {
                    long now = ClockFrame();
                    if (now >= refresh) {
                        // Whole-system capture is a single native mix. With a
                        // filter, capture only allowed audio sessions, including
                        // newly started apps, on every active output device.
                        var wanted = selection.mode != "include" && selected.Count == 0
                            ? new uint[] { (uint)Process.GetCurrentProcess().Id }
                            : CaptureRoots(ListApps(), selection, selected);
                        foreach (uint pid in captures.Keys.Except(wanted).ToArray()) { captures[pid].Dispose(); captures.Remove(pid); }
                        foreach (uint pid in wanted.Except(captures.Keys)) captures[pid] = new Capture(pid, !(selection.mode != "include" && selected.Count == 0));
                        refresh = ClockFrame() + 48000;
                        if (!ready) { cursor = ClockFrame(); Emit(new { ready = true }); ready = true; }
                    }
                    foreach (var capture in captures.Values) capture.Drain((samples, qpc) => {
                        long first = (long)(qpc * (48000.0 / 10000000));
                        for (int i = 0; i < samples.Length / 2; i++) {
                            long frame = first + i;
                            if (frame < cursor || frame >= cursor + 48000) continue;
                            int index = (int)(frame % 48000) * 2;
                            mix[index] += samples[i * 2]; mix[index + 1] += samples[i * 2 + 1];
                        }
                    });
                    now = ClockFrame();
                    // 40ms accommodates delivery skew between WASAPI streams.
                    if (now - cursor > 48000) { Array.Clear(mix, 0, mix.Length); cursor = now - 1920; }
                    while (cursor + 480 <= now - 1920) {
                        var samples = new float[960];
                        for (int i = 0; i < 480; i++, cursor++) {
                            int index = (int)(cursor % 48000) * 2;
                            samples[i * 2] = Math.Max(-1, Math.Min(1, mix[index]));
                            samples[i * 2 + 1] = Math.Max(-1, Math.Min(1, mix[index + 1]));
                            mix[index] = mix[index + 1] = 0;
                        }
                        var bytes = new byte[3840]; Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
                        Emit(new { pcm = Convert.ToBase64String(bytes) });
                    }
                    Thread.Sleep(4);
                }
            } finally { foreach (var capture in captures.Values) capture.Dispose(); }
            return 0;
        } catch (Exception error) {
            Emit(new { error = "Windows audio: " + error.Message + " (0x" + error.HResult.ToString("X8") + "). If application capture is unavailable, install Windows updates or select Entire system." });
            return 1;
        }
    }
}
