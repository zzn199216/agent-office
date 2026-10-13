// The desktop host owns its window, offline assets and a narrow local CLI bridge.
// It never automates, reads or sends input to another application's window.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AgentRoomDesktop
{
    internal sealed class Options
    {
        public string DataDirectory;
        public string AgentRoomExecutable;
        public string DiagnosticsDirectory;
        public bool Smoke;
        public bool Check;
        public static Options Parse(string[] args)
        {
            Options result = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--data-dir" && i + 1 < args.Length) result.DataDirectory = Path.GetFullPath(args[++i]);
                else if (args[i] == "--agentroom" && i + 1 < args.Length) result.AgentRoomExecutable = Path.GetFullPath(args[++i]);
                else if (args[i] == "--diagnostics" && i + 1 < args.Length) result.DiagnosticsDirectory = Path.GetFullPath(args[++i]);
                else if (args[i] == "--smoke") result.Smoke = true;
                else if (args[i] == "--check") result.Check = true;
                else throw new ArgumentException("不支持的窗口参数：" + args[i]);
            }
            if (result.DataDirectory == null) result.DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agentroom");
            if (result.Smoke && (result.DiagnosticsDirectory == null || !IsTemporaryDataDirectory(result.DataDirectory)))
                throw new ArgumentException("桌面 smoke test 必须显式指定临时 data-dir 和 diagnostics；不会在用户数据中测试启停。");
            return result;
        }
        private static bool IsTemporaryDataDirectory(string directory)
        {
            string root = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return directory.StartsWith(root, StringComparison.OrdinalIgnoreCase) && directory.IndexOf("agentroom-desktop-test-", StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Options options;
            try { options = Options.Parse(args); }
            catch (Exception ex) { MessageBox.Show(ex.Message, "Agent 办公室", MessageBoxButtons.OK, MessageBoxIcon.Warning); return 1; }
            string instance;
            using (SHA256 hash = SHA256.Create()) instance = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(options.DataDirectory.ToLowerInvariant()))).Replace("-", "");
            using (Mutex mutex = new Mutex(false, "Local\\AgentRoom.Desktop." + instance))
            using (EventWaitHandle activate = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AgentRoom.Desktop.Activate." + instance))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) { activate.Set(); return 0; }
                try
                {
                    using (RoomWindow form = new RoomWindow(options, activate)) Application.Run(form);
                    return 0;
                }
                catch (Exception ex)
                {
                    if (options.DiagnosticsDirectory != null) Diagnostic.Write(options.DiagnosticsDirectory, "fatal.json", new Dictionary<string, object> { { "error", ex.Message } });
                    else MessageBox.Show(ex.Message, "Agent 办公室", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
    }

    internal static class Json
    {
        public static JavaScriptSerializer Serializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 32 * 1024 * 1024; serializer.RecursionLimit = 120; return serializer;
        }
        public static string Encode(object value) { return Serializer().Serialize(value); }
        public static Dictionary<string, object> Parse(string value) { return Serializer().Deserialize<Dictionary<string, object>>(value); }
        public static Dictionary<string, object> ParseCliError(string value)
        {
            // Node may write its SQLite experimental warning before the final
            // structured error. Accept only a complete trailing JSON object;
            // warning text is never displayed as a command or instruction.
            try { return Parse(value.Trim()); } catch { }
            string[] lines = value.Replace("\r\n", "\n").Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                if (!lines[i].TrimStart().StartsWith("{", StringComparison.Ordinal)) continue;
                try { return Parse(String.Join("\n", lines, i, lines.Length - i).Trim()); } catch { }
            }
            return null;
        }
        public static string Text(Dictionary<string, object> data, string field) { object value; return data != null && data.TryGetValue(field, out value) && value is string ? (string)value : null; }
        public static bool Flag(Dictionary<string, object> data, string field) { object value; return data != null && data.TryGetValue(field, out value) && value is bool && (bool)value; }
    }

    internal static class Diagnostic
    {
        public static void Write(string directory, string filename, object value)
        {
            Directory.CreateDirectory(directory); File.WriteAllText(Path.Combine(directory, filename), Json.Encode(value), new UTF8Encoding(false));
        }
    }

    // Window preferences are independent of room state. Reading them never
    // creates a data directory or changes the offline application's data.
    internal static class WindowPlacement
    {
        public static Rectangle Preferred(Rectangle workArea, float dpi)
        {
            double factor = Math.Max(1, Math.Min(4, dpi / 96.0));
            int width = Math.Min(workArea.Width, Math.Min((int)(workArea.Width * .82), (int)(1240 * factor)));
            int height = Math.Min(workArea.Height, Math.Min((int)(workArea.Height * .82), (int)(820 * factor)));
            return new Rectangle(workArea.Left + (workArea.Width - width) / 2, workArea.Top + (workArea.Height - height) / 2, width, height);
        }
        public static Rectangle Constrain(Rectangle requested, Rectangle workArea)
        {
            int width = Math.Max(1, Math.Min(requested.Width, workArea.Width));
            int height = Math.Max(1, Math.Min(requested.Height, workArea.Height));
            int x = Math.Max(workArea.Left, Math.Min(requested.Left, workArea.Right - width));
            int y = Math.Max(workArea.Top, Math.Min(requested.Top, workArea.Bottom - height));
            return new Rectangle(x, y, width, height);
        }
        public static Rectangle ChooseArea(Rectangle requested, Rectangle[] available, Rectangle fallback)
        {
            // A disconnected monitor can leave a saved window at any coordinate.
            // Prefer the screen with the greatest surviving intersection.
            long best = 0; Rectangle result = fallback;
            foreach (Rectangle area in available)
            {
                Rectangle overlap = Rectangle.Intersect(requested, area);
                long size = (long)Math.Max(0, overlap.Width) * Math.Max(0, overlap.Height);
                if (size > best) { best = size; result = area; }
            }
            return result;
        }
        private static bool Integer(Dictionary<string, object> value, string key, out int result)
        {
            result = 0; object number;
            return value != null && value.TryGetValue(key, out number) && number is int && (result = (int)number) >= -100000 && result <= 100000;
        }
        public static bool Read(string file, out Rectangle bounds, out bool maximized)
        {
            bounds = Rectangle.Empty; maximized = false;
            try
            {
                if (!File.Exists(file) || new FileInfo(file).Length > 4096) return false;
                Dictionary<string, object> value = Json.Parse(File.ReadAllText(file, Encoding.UTF8));
                int version, x, y, width, height;
                if (!Integer(value, "version", out version) || version != 1 || !Integer(value, "x", out x) || !Integer(value, "y", out y) || !Integer(value, "width", out width) || !Integer(value, "height", out height) || width < 320 || height < 240) return false;
                string state = Json.Text(value, "state"); if (state != "normal" && state != "maximized") return false;
                bounds = new Rectangle(x, y, width, height); maximized = state == "maximized"; return true;
            }
            catch { return false; }
        }
        public static void Save(string file, Rectangle bounds, bool maximized)
        {
            string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                Dictionary<string, object> value = new Dictionary<string, object> { { "version", 1 }, { "x", bounds.X }, { "y", bounds.Y }, { "width", bounds.Width }, { "height", bounds.Height }, { "state", maximized ? "maximized" : "normal" } };
                File.WriteAllText(temporary, Json.Encode(value), new UTF8Encoding(false));
                if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
            }
            catch { /* A window preference cannot prevent opening or closing. */ }
            finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch { } }
        }
    }

    internal sealed class DesktopCli
    {
        private readonly string executable;
        private readonly string dataDirectory;
        public DesktopCli(string dataDirectory, string selectedExecutable)
        {
            this.dataDirectory = dataDirectory;
            string[] trusted = new string[] {
                Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "AgentOffice.exe")),
                Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "AgentRoom.exe")),
                Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "AgentOffice.exe")),
                Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "AgentRoom.exe"))
            };
            executable = selectedExecutable;
            if (executable == null) foreach (string candidate in trusted) if (File.Exists(candidate)) { executable = candidate; break; }
            bool permitted = false;
            foreach (string candidate in trusted) if (String.Equals(executable, candidate, StringComparison.OrdinalIgnoreCase)) permitted = true;
            if (!permitted) throw new ArgumentException("桌面窗口只能使用完整安装包中的固定 AgentOffice.exe 或兼容 AgentRoom.exe。");
            if (!File.Exists(executable)) throw new FileNotFoundException("AgentOffice.exe 必须与 desktop 文件夹一起保留；请完整解压安装包。", executable);
        }
        private static string Quote(string value)
        {
            // CommandLineToArgvW quoting; values never pass through a shell.
            StringBuilder result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
                result.Append('\\', slashes); result.Append(c); slashes = 0;
            }
            result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
        }
        public async Task<Dictionary<string, object>> Invoke(string command, string roomId)
        {
            if (command != "desktop-state" && command != "desktop-start" && command != "desktop-stop") throw new ArgumentException("不支持的桌面操作。");
            Guid room;
            if (roomId != null && !Guid.TryParseExact(roomId, "D", out room)) throw new ArgumentException("聊天室 ID 无效。");
            ProcessStartInfo info = new ProcessStartInfo(executable);
            info.Arguments = command + " --data-dir " + Quote(dataDirectory) + (roomId == null ? "" : " --room " + Quote(roomId));
            info.WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory;
            info.UseShellExecute = false; info.CreateNoWindow = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
            using (Process process = Process.Start(info))
            {
                Task<string> stdout = process.StandardOutput.ReadToEndAsync(), stderr = process.StandardError.ReadToEndAsync();
                Task exited = Task.Run(delegate { process.WaitForExit(); });
                if (await Task.WhenAny(exited, Task.Delay(command == "desktop-start" ? 45000 : 20000)) != exited)
                {
                    try { process.Kill(); } catch { }
                    throw new TimeoutException("本机服务操作超时；请刷新状态后再试。");
                }
                string output = await stdout, error = await stderr;
                if (process.ExitCode != 0)
                {
                    Dictionary<string, object> failure = Json.ParseCliError(error) ?? Json.ParseCliError(output);
                    string message = Json.Text(failure, "error");
                    throw new InvalidOperationException(message ?? "本机服务未完成操作，请检查安装目录或稍后重试。");
                }
                if (output.Length > 32 * 1024 * 1024) throw new InvalidOperationException("本机服务返回的数据过大。");
                return Json.Parse(output.Trim());
            }
        }
    }

    internal sealed class RoomWindow : Form
    {
        private readonly Options options;
        private readonly EventWaitHandle activate;
        private readonly DesktopCli cli;
        private readonly WebView2 view = new WebView2();
        private readonly System.Windows.Forms.Timer activationTimer = new System.Windows.Forms.Timer();
        private readonly SemaphoreSlim commandLock = new SemaphoreSlim(1, 1);
        private readonly HashSet<string> pending = new HashSet<string>();
        private readonly Dictionary<string, Dictionary<string, object>> smokeReplies = new Dictionary<string, Dictionary<string, object>>();
        private Uri onlineOrigin;
        private string selectedRoom;
        private Dictionary<string, object> latest;
        private int rejectedNavigations;
        private int rejectedMessages;
        private int bridgeCommands;
        private bool completedDiagnostics;
        private bool restoringWindow;
        private bool restoredWindow;
        private bool lastMaximized;
        private readonly string windowPreferences;
        private const string OfflineUrl = "https://agentroom.local/index.html";
        public RoomWindow(Options options, EventWaitHandle activate)
        {
            this.options = options; this.activate = activate; cli = new DesktopCli(options.DataDirectory, options.AgentRoomExecutable);
            Text = "Agent 办公室 · Agent Office"; StartPosition = FormStartPosition.Manual; AutoScaleMode = AutoScaleMode.None;
            windowPreferences = Path.Combine(options.DataDirectory, "desktop-window.json");
            ConfigureWindow();
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Font = new Font("Microsoft YaHei UI", 9F); BackColor = Color.FromArgb(246, 248, 251);
            view.Dock = DockStyle.Fill; Controls.Add(view);
            activationTimer.Interval = 300; activationTimer.Tick += delegate { if (activate.WaitOne(0)) { if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Show(); Activate(); } }; activationTimer.Start();
            Shown += async delegate { await Initialize(); };
            ResizeEnd += delegate { SaveWindow(); };
            Resize += delegate { if (WindowState != FormWindowState.Minimized) lastMaximized = WindowState == FormWindowState.Maximized; };
            FormClosing += delegate { SaveWindow(); };
            FormClosed += delegate { activationTimer.Stop(); view.Dispose(); };
        }
        private float WindowDpi()
        {
            try { using (Graphics graphics = CreateGraphics()) return graphics.DpiX; } catch { return 96; }
        }
        private void ConfigureWindow()
        {
            restoringWindow = true;
            try
            {
                Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
                Rectangle saved; bool maximized;
                restoredWindow = WindowPlacement.Read(windowPreferences, out saved, out maximized);
                if (restoredWindow)
                {
                    Screen[] screens = Screen.AllScreens; Rectangle[] available = new Rectangle[screens.Length];
                    for (int i = 0; i < screens.Length; i++) available[i] = screens[i].WorkingArea;
                    area = WindowPlacement.ChooseArea(saved, available, area);
                }
                // Place the handle on the destination screen before measuring
                // DPI, rather than inheriting the primary monitor's density.
                Bounds = WindowPlacement.Constrain(restoredWindow ? saved : WindowPlacement.Preferred(area, 96), area);
                float dpi = WindowDpi(); double factor = Math.Max(1, Math.Min(4, dpi / 96.0));
                // Small displays still allow the complete window to be visible.
                MinimumSize = new Size(Math.Max(1, Math.Min((int)(area.Width * .8), (int)(680 * factor))), Math.Max(1, Math.Min((int)(area.Height * .8), (int)(480 * factor))));
                Bounds = WindowPlacement.Constrain(restoredWindow ? saved : WindowPlacement.Preferred(area, dpi), area);
                lastMaximized = restoredWindow && maximized;
                if (lastMaximized) WindowState = FormWindowState.Maximized;
            }
            finally { restoringWindow = false; }
        }
        private void SaveWindow()
        {
            if (restoringWindow || options.Check || options.Smoke) return;
            Rectangle normal = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            Rectangle area = Screen.FromRectangle(normal).WorkingArea;
            WindowPlacement.Save(windowPreferences, WindowPlacement.Constrain(normal, area), WindowState == FormWindowState.Maximized || WindowState == FormWindowState.Minimized && lastMaximized);
        }
        private Dictionary<string, object> WindowMetrics()
        {
            Rectangle area = Screen.FromRectangle(Bounds).WorkingArea;
            Func<Rectangle, object> rectangle = r => new Dictionary<string, object> { { "x", r.X }, { "y", r.Y }, { "width", r.Width }, { "height", r.Height } };
            return new Dictionary<string, object> { { "bounds", rectangle(Bounds) }, { "restore_bounds", rectangle(RestoreBounds) }, { "working_area", rectangle(area) }, { "client_width", ClientSize.Width }, { "client_height", ClientSize.Height }, { "minimum_width", MinimumSize.Width }, { "minimum_height", MinimumSize.Height }, { "dpi", WindowDpi() }, { "state", WindowState.ToString().ToLowerInvariant() }, { "restored", restoredWindow } };
        }
        private async Task Initialize()
        {
            try
            {
                string assets = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "desktop-web");
                if (!File.Exists(Path.Combine(assets, "index.html"))) throw new FileNotFoundException("桌面界面资源不完整；请完整解压安装包。");
                string runtimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString();
                string profile = Path.Combine(options.DataDirectory, "desktop-webview");
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile, null);
                await view.EnsureCoreWebView2Async(environment);
                CoreWebView2 core = view.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false; core.Settings.AreDevToolsEnabled = false; core.Settings.AreHostObjectsAllowed = false;
                core.Settings.IsGeneralAutofillEnabled = false; core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false; core.Settings.IsWebMessageEnabled = true;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.SetVirtualHostNameToFolderMapping("agentroom.local", assets, CoreWebView2HostResourceAccessKind.DenyCors);
                core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { if (!AllowedOrigin(e.Uri)) { e.Cancel = true; rejectedNavigations++; } };
                core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { if (!AllowedOrigin(e.Uri)) { e.Cancel = true; rejectedNavigations++; } };
                core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; rejectedNavigations++; };
                core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
                core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; };
                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs e)
                {
                    if (!AllowedOrigin(e.Request.Uri) && !AllowedAppearanceImage(e.Request.Uri, e.ResourceContext)) e.Response = environment.CreateWebResourceResponse(new MemoryStream(new byte[0]), 403, "Forbidden", "Content-Type: text/plain");
                };
                core.WebMessageReceived += async delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e) { await Receive(e); };
                latest = await cli.Invoke("desktop-state", null); selectedRoom = Json.Text(latest, "selected_room_id"); NavigateForState(latest);
                if (options.DiagnosticsDirectory != null)
                {
                    Diagnostic.Write(options.DiagnosticsDirectory, "runtime.json", new Dictionary<string, object> { { "webview_runtime", runtimeVersion }, { "process_id", Process.GetCurrentProcess().Id }, { "initial_running", Json.Flag(latest, "running") } });
                    await Task.Delay(1800);
                    if (options.Smoke) await Smoke();
                    else await Capture("window.png");
                    if (!completedDiagnostics) FinishDiagnostics(null);
                }
            }
            catch (Exception ex)
            {
                if (options.DiagnosticsDirectory != null) { FinishDiagnostics(ex.Message); Close(); }
                else ShowFailure(ex);
            }
        }
        private bool AllowedOrigin(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || !String.IsNullOrEmpty(uri.UserInfo)) return false;
            if (uri.Scheme == "https" && uri.Host.Equals("agentroom.local", StringComparison.OrdinalIgnoreCase) && uri.Port == 443) return true;
            return onlineOrigin != null && uri.Scheme == onlineOrigin.Scheme && uri.Host == onlineOrigin.Host && uri.Port == onlineOrigin.Port;
        }
        private static bool AllowedAppearanceImage(string value, CoreWebView2WebResourceContext context)
        {
            // Replacement artwork is a checked local raster payload. It must
            // never enable data navigation, script, frame or remote resources.
            return context == CoreWebView2WebResourceContext.Image && value != null && value.Length <= 192 * 1024 &&
                Regex.IsMatch(value, "^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$", RegexOptions.CultureInvariant);
        }
        private static Uri ValidServiceUrl(Dictionary<string, object> state)
        {
            Uri uri;
            string value = Json.Text(state, "url");
            if (!Json.Flag(state, "running")) return null;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || !String.IsNullOrEmpty(uri.UserInfo) || uri.Port < 1 || uri.AbsolutePath != "/" || !String.IsNullOrEmpty(uri.Query) || !String.IsNullOrEmpty(uri.Fragment))
                throw new InvalidOperationException("本机服务返回了无效地址；未导航到其他站点。");
            return uri;
        }
        private void NavigateForState(Dictionary<string, object> state)
        {
            Uri target = ValidServiceUrl(state); onlineOrigin = target;
            // Online room selection and confirmation dialogs belong to the UI.
            // A same-origin state refresh must not reload that active page.
            if (target != null && view.Source != null && view.Source.Scheme == target.Scheme && view.Source.Host == target.Host && view.Source.Port == target.Port) return;
            string destination = target == null ? OfflineUrl : target.AbsoluteUri;
            Guid selected;
            if (target != null && selectedRoom != null && Guid.TryParseExact(selectedRoom, "D", out selected))
            {
                UriBuilder selectedTarget = new UriBuilder(target); selectedTarget.Query = "room=" + Uri.EscapeDataString(selectedRoom); destination = selectedTarget.Uri.AbsoluteUri;
            }
            if (view.Source == null || view.Source.AbsoluteUri != destination) view.CoreWebView2.Navigate(destination);
        }
        private async Task Receive(CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> request;
            string id = null;
            try
            {
                if (!AllowedOrigin(e.Source) || view.Source == null || new Uri(e.Source).GetLeftPart(UriPartial.Authority) != view.Source.GetLeftPart(UriPartial.Authority)) { rejectedMessages++; return; }
                if (e.WebMessageAsJson.Length > 4096) { rejectedMessages++; return; }
                request = Json.Parse(e.WebMessageAsJson);
                id = Json.Text(request, "id");
                string operation = Json.Text(request, "operation"), roomId = Json.Text(request, "room_id");
                if (Json.Text(request, "source") != "agentroom-ui" || Json.Text(request, "type") != "desktop-command" || id == null || !Regex.IsMatch(id, "^[A-Za-z0-9_.:-]{1,100}$") || (operation != "state" && operation != "start_service" && operation != "stop_service" && operation != "select_room")) { rejectedMessages++; return; }
                foreach (string key in request.Keys) if (key != "source" && key != "type" && key != "id" && key != "operation" && key != "room_id") { rejectedMessages++; return; }
                Guid room;
                if (roomId != null && !Guid.TryParseExact(roomId, "D", out room)) { rejectedMessages++; return; }
                if (operation == "select_room" && roomId == null) { rejectedMessages++; return; }
                if (!pending.Add(id)) { rejectedMessages++; return; }
                bridgeCommands++;
                Dictionary<string, object> result = await Perform(operation, roomId);
                if (options.Smoke && id.StartsWith("smoke-", StringComparison.Ordinal)) smokeReplies[id] = result;
                Reply(id, result, null);
                // Another agent may explicitly restore the same room service while
                // this window shows its offline history. A read-only state poll
                // changes the view only; it never starts the service itself.
                if (operation == "start_service" || operation == "stop_service" || operation == "state") NavigateForState(result);
            }
            catch (Exception ex)
            {
                if (options.Smoke && id != null && id.StartsWith("smoke-", StringComparison.Ordinal)) smokeReplies[id] = new Dictionary<string, object> { { "error", ex.Message } };
                if (id != null) Reply(id, null, ex.Message);
            }
            finally { if (id != null) pending.Remove(id); }
        }
        private async Task<Dictionary<string, object>> Perform(string operation, string roomId)
        {
            await commandLock.WaitAsync();
            try
            {
                string selected = roomId ?? selectedRoom;
                string command = operation == "start_service" ? "desktop-start" : operation == "stop_service" ? "desktop-stop" : "desktop-state";
                Dictionary<string, object> result = await cli.Invoke(command, selected);
                selectedRoom = Json.Text(result, "selected_room_id"); latest = result; return result;
            }
            finally { commandLock.Release(); }
        }
        private void Reply(string id, Dictionary<string, object> result, string error)
        {
            if (view.IsDisposed || view.CoreWebView2 == null) return;
            Dictionary<string, object> response = new Dictionary<string, object> { { "source", "agentroom-desktop" }, { "type", "desktop-result" }, { "id", id } };
            if (error == null) response.Add("result", result); else response.Add("error", error);
            view.CoreWebView2.PostWebMessageAsJson(Json.Encode(response));
        }
        private async Task Capture(string filename)
        {
            using (FileStream stream = File.Create(Path.Combine(options.DiagnosticsDirectory, filename))) await view.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        }
        private async Task Smoke()
        {
            List<object> steps = new List<object>();
            await Capture("offline-before.png");
            await view.CoreWebView2.ExecuteScriptAsync("window.chrome.webview.postMessage({source:'agentroom-ui',type:'desktop-command',id:'invalid-operation',operation:'exec',path:'cmd.exe'})");
            await view.CoreWebView2.ExecuteScriptAsync("location.href='https://example.com/'"); await Task.Delay(350);
            if (rejectedMessages < 1 || rejectedNavigations < 1) throw new InvalidOperationException("桌面消息或导航拒绝检查未通过。");
            Dictionary<string, object> start = await SmokeBridge("start_service", "smoke-start"); steps.Add(new Dictionary<string, object> { { "operation", "start_service" }, { "running", Json.Flag(start, "running") }, { "room", Json.Text(start, "selected_room_id") } });
            if (!Json.Flag(start, "running")) throw new InvalidOperationException("桌面启动服务验证失败。");
            NavigateForState(start); await Task.Delay(1800); await Capture("online.png");
            await CaptureOffice("office-online");
            Dictionary<string, object> stop = await SmokeBridge("stop_service", "smoke-stop"); steps.Add(new Dictionary<string, object> { { "operation", "stop_service" }, { "running", Json.Flag(stop, "running") }, { "room", Json.Text(stop, "selected_room_id") } });
            if (Json.Flag(stop, "running")) throw new InvalidOperationException("桌面停止服务验证失败。");
            NavigateForState(stop); await Task.Delay(1200); await Capture("offline-after.png");
            await CaptureOffice("office-offline");
            string ui = await view.CoreWebView2.ExecuteScriptAsync("JSON.stringify({title:document.title,hostname:location.hostname,body:document.body.innerText.slice(0,800)})");
            Diagnostic.Write(options.DiagnosticsDirectory, "smoke.json", new Dictionary<string, object> { { "steps", steps }, { "rejected_navigation", rejectedNavigations }, { "rejected_messages", rejectedMessages }, { "bridge_commands", bridgeCommands }, { "ui", ui }, { "closed_window_stops_service", false } });
            FinishDiagnostics(null); Close();
        }
        private async Task CaptureOffice(string name)
        {
            // Diagnostics operate only this newly-created temporary window.
            // The real application never switches views on the user's behalf.
            await view.CoreWebView2.ExecuteScriptAsync("document.getElementById('office-view-button').click()");
            await Task.Delay(1000);
            string observation = await view.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.getElementById('officeScene'),all=s?Array.from(s.querySelectorAll('img')):[],images=all.filter(i=>{if(!i.hasAttribute('src')||i.hidden)return false;for(let p=i;p&&p!==s.parentElement;p=p.parentElement){const st=getComputedStyle(p);if(p.hidden||st.display==='none'||st.visibility==='hidden')return false;}return true;}),failed=images.filter(i=>!i.complete||!i.naturalWidth),summary=src=>!src?'':src.startsWith('data:')?src.slice(0,src.indexOf(',')+1)+' ['+src.length+' chars]':new URL(src,location.href).pathname.slice(0,160);return{visible:!!s&&!s.classList.contains('hidden'),phase:s?.querySelector('.ao-scene')?.dataset.phase,clock:s?.querySelector('.ao-clock-time')?.textContent,timeZone:s?.querySelector('.ao-clock-zone')?.textContent,beanbags:s?s.querySelectorAll('.ao-seat[data-furniture=beanbag]').length:0,seats:s?s.querySelectorAll('.ao-seat').length:0,occupied:s?s.querySelectorAll('.ao-seat[data-occupied=true]').length:0,vacant:s?s.querySelectorAll('.ao-vacant').length:0,images:images.length,skipped:all.length-images.length,unloaded:failed.length,customLoaded:images.filter(i=>i.getAttribute('src').startsWith('data:image/')&&i.complete&&i.naturalWidth).length,failed_sources:failed.map(i=>({class:i.className,source:summary(i.getAttribute('src')),current_source:summary(i.currentSrc)}))}})()");
            Dictionary<string, object> result = Json.Parse(observation);
            Diagnostic.Write(options.DiagnosticsDirectory, name + ".json", result);
            await Capture(name + ".png");
            object seats;
            if (!Json.Flag(result, "visible") || !result.TryGetValue("seats", out seats) || Convert.ToInt32(seats) < 1)
                throw new InvalidOperationException("自己的临时窗口没有显示已保存的办公室成员。");
            object unloaded;
            if (result.TryGetValue("unloaded", out unloaded) && Convert.ToInt32(unloaded) > 0)
                throw new InvalidOperationException("办公室的本机图像资源未能加载。");
        }
        private async Task<Dictionary<string, object>> SmokeBridge(string operation, string id)
        {
            string request = Json.Encode(new Dictionary<string, object> { { "source", "agentroom-ui" }, { "type", "desktop-command" }, { "id", id }, { "operation", operation } });
            await view.CoreWebView2.ExecuteScriptAsync("window.chrome.webview.postMessage(" + request + ")");
            for (int i = 0; i < 300 && !smokeReplies.ContainsKey(id); i++) await Task.Delay(150);
            Dictionary<string, object> result;
            if (!smokeReplies.TryGetValue(id, out result)) throw new TimeoutException("自己的窗口未收到服务操作结果。");
            string error = Json.Text(result, "error"); if (error != null) throw new InvalidOperationException(error);
            return result;
        }
        private void FinishDiagnostics(string error)
        {
            if (completedDiagnostics) return; completedDiagnostics = true;
            Diagnostic.Write(options.DiagnosticsDirectory, "result.json", new Dictionary<string, object> { { "ok", error == null }, { "error", error }, { "source", view.Source == null ? null : view.Source.AbsoluteUri }, { "bridge_commands", bridgeCommands }, { "rejected_navigation", rejectedNavigations }, { "rejected_messages", rejectedMessages }, { "window", WindowMetrics() } });
            if (options.Check && !options.Smoke) Close();
        }
        private void ShowFailure(Exception error)
        {
            view.Visible = false;
            FlowLayoutPanel panel = new FlowLayoutPanel(); panel.Dock = DockStyle.Fill; panel.FlowDirection = FlowDirection.TopDown; panel.Padding = new Padding(36); panel.WrapContents = false;
            Label title = new Label(); title.Text = "Agent 办公室窗口暂时无法打开"; title.Font = new Font(Font.FontFamily, 18F, FontStyle.Bold); title.AutoSize = true;
            Label detail = new Label(); detail.Text = "请确认已完整解压，并安装 Microsoft Edge WebView2 Runtime。\n" + error.Message; detail.MaximumSize = new Size(680, 0); detail.AutoSize = true;
            Button download = new Button(); download.Text = "打开 WebView2 官方下载页"; download.AutoSize = true; download.Padding = new Padding(12, 5, 12, 5);
            download.Click += delegate { Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/#download") { UseShellExecute = true }); };
            Label fallback = new Label(); fallback.Text = "也可使用 AgentOffice.exe start --open，通过浏览器继续使用办公室。关闭这个窗口不会停止后台服务。"; fallback.MaximumSize = new Size(680, 0); fallback.AutoSize = true;
            panel.Controls.Add(title); panel.Controls.Add(detail); panel.Controls.Add(download); panel.Controls.Add(fallback); Controls.Add(panel); panel.BringToFront();
        }
    }
}
