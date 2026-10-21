'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');

test('actual C# command bridge bounds process pipes and queues while retaining startup failure details', t => {
  if (process.platform !== 'win32') { t.skip('Windows desktop command contract'); return; }
  const root = path.resolve(__dirname, '..');
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const references = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll'].map(file => path.join(root, 'dist', 'desktop', file));
  if (!fs.existsSync(compiler) || references.some(file => !fs.existsSync(file))) { t.skip('Build desktop SDK dependencies before running this isolated console harness'); return; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentroom-command-contract-'));
  t.after(() => {
    const absolute = path.resolve(temporary);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.match(path.basename(absolute), /^agentroom-command-contract-/);
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const fixtureSource = path.join(temporary, 'FixtureCli.cs'), fixtureExe = path.join(temporary, 'AgentRoom.exe');
  fs.writeFileSync(fixtureSource, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
internal static class FixtureCli
{
    public static int Main(string[] args)
    {
        if (args.Length == 1 && (args[0] == "hold-pipe" || args[0] == "sentinel")) { Thread.Sleep(3000); return 0; }
        string directory = args[2], mode = File.ReadAllText(Path.Combine(directory, "mode.txt"));
        File.WriteAllText(Path.Combine(directory, "wrapper-pid.txt"), Process.GetCurrentProcess().Id.ToString());
        if (mode == "slow") { Thread.Sleep(10000); return 0; }
        if (mode == "failure") { Console.Error.WriteLine("(node:fixture) SQLite experimental warning"); Console.Error.WriteLine("{\"error\":\"fixture specific startup failure\",\"code\":\"fixture_start_failed\"}"); return 1; }
        if (mode == "pipe-parent")
        {
            ProcessStartInfo info = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "hold-pipe");
            info.UseShellExecute = false; info.CreateNoWindow = true;
            Process holder = Process.Start(info);
            File.WriteAllText(Path.Combine(directory, "holder-pid.txt"), holder.Id.ToString());
            holder.Dispose();
        }
        Console.WriteLine("{\"running\":true}"); return 0;
    }
}
`, 'utf8');
  const harnessSource = path.join(temporary, 'CommandTests.cs'), executable = path.join(temporary, 'CommandTests.exe');
  fs.writeFileSync(harnessSource, String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AgentRoomDesktop;
internal static class CommandTests
{
    private static int checks;
    private static void Check(bool condition, string name) { if (!condition) throw new Exception(name); checks++; }
    private static void Mode(string directory, string mode) { File.WriteAllText(Path.Combine(directory, "mode.txt"), mode); string pid = Path.Combine(directory, "wrapper-pid.txt"); if (File.Exists(pid)) File.Delete(pid); }
    private static bool Alive(int pid) { try { using (Process process = Process.GetProcessById(pid)) return !process.HasExited; } catch (ArgumentException) { return false; } }
    private static async Task WaitForFile(string file)
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        while (!File.Exists(file) && elapsed.ElapsedMilliseconds < 3000) await Task.Delay(10);
        Check(File.Exists(file), "owned fixture wrapper actually started");
    }
    private static async Task Run(string directory)
    {
        string fixture = Path.Combine(directory, "AgentRoom.exe");
        DesktopCli cli = new DesktopCli(directory, fixture);
        Check(DesktopCli.TimeoutMilliseconds == 35000, "CLI lifetime fits bridge budget");
        Check(DesktopCommandQueue.QueueTimeoutMilliseconds + DesktopCli.TimeoutMilliseconds <= DesktopCommandQueue.OperationTimeoutMilliseconds, "queue plus execution fits operation deadline");
        Check(DesktopCommandQueue.OperationTimeoutMilliseconds < 45000, "operation expires before browser request");
        Mode(directory, "normal");
        Check(Json.Flag(await cli.Invoke("desktop-state", null, CancellationToken.None, 5000), "running"), "successful fixture result parsed");
        Mode(directory, "failure");
        bool specific = false;
        try { await cli.Invoke("desktop-start", null, CancellationToken.None, 5000); }
        catch (DesktopOperationException error) { specific = error.Message == "fixture specific startup failure" && error.Code == "fixture_start_failed"; }
        Check(specific, "structured CLI failure and code survive preceding warning");

        Mode(directory, "pipe-parent");
        Stopwatch pipeWait = Stopwatch.StartNew(); bool pipeTimeout = false;
        try { await cli.Invoke("desktop-state", null, CancellationToken.None, 1200); }
        catch (TimeoutException) { pipeTimeout = true; }
        Check(pipeTimeout && pipeWait.ElapsedMilliseconds < 2800, "exited wrapper with inherited open stdout cannot exceed lifetime deadline");
        int holder = Int32.Parse(File.ReadAllText(Path.Combine(directory, "holder-pid.txt")));
        Check(Alive(holder), "pipe-holder child is not killed as part of wrapper timeout");

        ProcessStartInfo sentinelInfo = new ProcessStartInfo(fixture, "sentinel"); sentinelInfo.UseShellExecute = false; sentinelInfo.CreateNoWindow = true;
        using (Process sentinel = Process.Start(sentinelInfo))
        using (CancellationTokenSource cancel = new CancellationTokenSource())
        {
            Mode(directory, "slow");
            Task<Dictionary<string, object>> running = cli.Invoke("desktop-start", null, cancel.Token, 5000);
            await WaitForFile(Path.Combine(directory, "wrapper-pid.txt"));
            int wrapper = Int32.Parse(File.ReadAllText(Path.Combine(directory, "wrapper-pid.txt")));
            cancel.Cancel(); bool cancelled = false;
            try { await running; } catch (OperationCanceledException) { cancelled = true; }
            await Task.Delay(80);
            Check(cancelled && !Alive(wrapper), "cancellation stops only the created wrapper");
            Check(!sentinel.HasExited, "independent fixture process survives command cancellation");
            Check(sentinel.WaitForExit(4000), "independent fixture exits on its own");
        }
        Stopwatch holderWait = Stopwatch.StartNew();
        while (Alive(holder) && holderWait.ElapsedMilliseconds < 4000) await Task.Delay(20);
        Check(!Alive(holder), "pipe holder exits naturally before fixture cleanup");

        DesktopCommandQueue queue = new DesktopCommandQueue();
        TaskCompletionSource<int> release = new TaskCompletionSource<int>();
        Task<int> first = queue.Run(token => release.Task, CancellationToken.None, 500, 2000);
        int queuedExecutions = 0; bool queueTimeout = false;
        try { await queue.Run(token => { queuedExecutions++; return Task.FromResult(2); }, CancellationToken.None, 30, 500); }
        catch (TimeoutException) { queueTimeout = true; }
        Check(queueTimeout && queuedExecutions == 0, "timed-out queued operation is never started");
        release.SetResult(1); Check(await first == 1, "active operation is preserved when another queue request expires");
        await Task.Delay(60); Check(queuedExecutions == 0, "expired queue entry cannot execute later");
        Check(await queue.Run(token => Task.FromResult(3), CancellationToken.None, 100, 500) == 3, "queue remains usable after timeout");
        bool operationTimeout = false;
        try { await queue.Run(async token => { await Task.Delay(3000, token); return 4; }, CancellationToken.None, 100, 40); }
        catch (TimeoutException) { operationTimeout = true; }
        Check(operationTimeout, "whole operation cancellation reaches execution");
        Check(await queue.Run(token => Task.FromResult(5), CancellationToken.None, 100, 500) == 5, "cancelled active operation releases queue");

        object savedHistory = new object();
        Dictionary<string, object> initial = new Dictionary<string, object> { { "can_update", true }, { "running", true }, { "url", "http://127.0.0.1:fixture" }, { "history", savedHistory } };
        int calls = 0;
        var failedUpdate = await DesktopServiceState.UpdateIfAvailable(initial, "fixture-room", (command, room) => {
            Check(room == "fixture-room", "startup update preserves selected room"); calls++;
            if (command == "desktop-start") throw new DesktopOperationException("fixture update failure", "fixture_update_failed");
            return Task.FromResult(new Dictionary<string, object> { { "running", false }, { "history", savedHistory } });
        });
        Check(calls == 2 && !Json.Flag(failedUpdate, "running") && Object.ReferenceEquals(failedUpdate["history"], savedHistory), "failed auto-update preserves refreshed offline history");
        Check(Json.Text(failedUpdate, "service_error") == "fixture update failure" && Json.Text(failedUpdate, "service_error_code") == "fixture_update_failed", "auto-update failure is visible with its actual code");
        var failedRefresh = await DesktopServiceState.UpdateIfAvailable(initial, "fixture-room", (command, room) => {
            if (command == "desktop-start") throw new DesktopOperationException("fixture original failure", "fixture_original_failed");
            throw new Exception("fixture refresh failure");
        });
        Check(!Json.Flag(failedRefresh, "running") && failedRefresh["url"] == null && Object.ReferenceEquals(failedRefresh["history"], savedHistory), "failed refresh retains saved history without stale running state");
        Check(Json.Text(failedRefresh, "service_error").Contains("fixture original failure") && Json.Text(failedRefresh, "service_error").Contains("fixture refresh failure"), "both startup and status failures remain visible");
        Check(Json.Flag(initial, "running"), "fallback does not mutate the previous observation");
        int unexpectedStarts = 0;
        var unchanged = new Dictionary<string, object> { { "can_update", false }, { "running", false } };
        Check(Object.ReferenceEquals(await DesktopServiceState.UpdateIfAvailable(unchanged, null, (command, room) => { unexpectedStarts++; return Task.FromResult(initial); }), unchanged) && unexpectedStarts == 0, "existing non-update activation behavior is preserved");
        Console.WriteLine(Json.Encode(new { ok = true, checks = checks }));
    }
    public static int Main(string[] args)
    {
        try { Run(args[0]).GetAwaiter().GetResult(); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
    }
}
`, 'utf8');
  const compile = (source, output, extra = []) => {
    const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/langversion:5', `/out:${output}`, '/r:System.dll', '/r:System.Core.dll', ...extra, source], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || '') + (result.error || ''));
  };
  compile(fixtureSource, fixtureExe);
  for (const reference of references) fs.copyFileSync(reference, path.join(temporary, path.basename(reference)));
  compile(harnessSource, executable, ['/main:CommandTests', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', ...references.map(file => `/r:${file}`), path.join(root, 'desktop', 'Program.cs')]);
  const result = spawnSync(executable, [temporary], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || '') + (result.error || ''));
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.ok, true); assert.ok(proof.checks >= 25);
  t.diagnostic(`${proof.checks} isolated C# command lifecycle assertions passed; no window or service was opened`);
});
