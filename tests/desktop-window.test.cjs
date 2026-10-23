'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');

test('actual C# window placement survives changed monitors, DPI, malformed preferences and atomic replacement',t=>{
  if(process.platform!=='win32'){t.skip('Windows desktop host contract');return;}
  const compiler=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  const sdk=path.join(root,'dist','desktop');
  const references=['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll'].map(file=>path.join(sdk,file));
  if(!fs.existsSync(compiler)||references.some(file=>!fs.existsSync(file))){t.skip('Build desktop SDK dependencies before running the native placement harness');return;}
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-window-contract-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));assert.match(path.basename(temporary),/^agentroom-window-contract-/);fs.rmSync(temporary,{recursive:true,force:true});});
  const harness=path.join(temporary,'WindowTests.cs'),executable=path.join(temporary,'WindowTests.exe');
  fs.writeFileSync(harness,String.raw`
using System;
using System.Drawing;
using System.IO;
using AgentRoomDesktop;
internal static class WindowTests
{
    private static int checks;
    private static void Check(bool condition, string name) { if (!condition) throw new Exception(name); checks++; }
    private static void Contained(Rectangle bounds, Rectangle area, string name) { Check(bounds.Width > 0 && bounds.Height > 0 && area.Contains(bounds), name); }
    public static int Main(string[] args)
    {
        string opened = null;
        Action<string> browser = url => opened = url;
        Check(ExternalLink.TryOpen("https://accounts.example.com/authorize?code=fixture", true, true, browser), "user authorization opens in system browser");
        Check(opened == "https://accounts.example.com/authorize?code=fixture", "full authorization URL retained");
        foreach (string invalid in new string[] { "javascript:alert(1)", "file:///C:/private", "http://example.com/", "https://user:pass@example.com/", "https://localhost/", "https://127.0.0.1/", "https://agentroom.local/", "https://example.com/\r\nrun", "not a URL" })
            Check(!ExternalLink.TryOpen(invalid, true, true, browser), "reject unsafe URL");
        Check(!ExternalLink.TryOpen("https://example.com/", false, true, browser), "reject automatic popup");
        Check(!ExternalLink.TryOpen("https://example.com/", true, false, browser), "reject foreign page");
        Check(opened == "https://accounts.example.com/authorize?code=fixture", "rejected navigation never launches");
        Rectangle standard = new Rectangle(0, 0, 1920, 1040), small = new Rectangle(0, 0, 640, 400), left = new Rectangle(-1920, 0, 1920, 1040), dense = new Rectangle(0, 0, 3840, 2080);
        Rectangle normal = WindowPlacement.Preferred(standard, 96);
        Contained(normal, standard, "standard bounds"); Check(normal.Width == 1240 && normal.Height == 820, "natural desktop cap");
        Check(normal.Left == (standard.Width-normal.Width)/2 && normal.Top == (standard.Height-normal.Height)/2, "natural centering");
        Contained(WindowPlacement.Preferred(small, 192), small, "high-DPI small display");
        Rectangle high = WindowPlacement.Preferred(dense, 192); Contained(high,dense,"dense display bounds"); Check(high.Width==2480 && high.Height==1640,"logical size respects DPI");
        Contained(WindowPlacement.Preferred(left,96),left,"negative monitor");
        Rectangle oversized = new Rectangle(10000,-10000,100000,100000), clamped = WindowPlacement.Constrain(oversized,small);
        Check(clamped==small,"tiny screen recovers all four edges");
        Rectangle moved = WindowPlacement.Constrain(new Rectangle(-2500,-300,1000,700),left);Contained(moved,left,"partially offscreen recovery");Check(moved.Width==1000&&moved.Height==700,"recover position without losing user size");
        Check(WindowPlacement.ChooseArea(new Rectangle(-1600,100,1200,700),new Rectangle[]{left,standard},standard)==left,"retain existing secondary monitor");
        Check(WindowPlacement.ChooseArea(new Rectangle(-1600,100,1200,700),new Rectangle[]{standard},standard)==standard,"removed monitor returns to active monitor");
        Check(WindowPlacement.ChooseArea(new Rectangle(-300,100,1200,700),new Rectangle[]{left,standard},left)==standard,"greatest surviving overlap");
        string directory=Path.Combine(args[0],"not-created"),file=Path.Combine(directory,"desktop-window.json");Rectangle restored;bool maximized;
        Check(!WindowPlacement.Read(file,out restored,out maximized)&&!Directory.Exists(directory),"read-only first open");
        WindowPlacement.Save(file,new Rectangle(-1500,40,1100,760),true);
        Check(WindowPlacement.Read(file,out restored,out maximized)&&restored==new Rectangle(-1500,40,1100,760)&&maximized,"maximized restore retains normal bounds");
        var fields=Json.Parse(File.ReadAllText(file));Check(fields.Count==6&&!fields.ContainsKey("room_id"),"only window preferences persisted");
        WindowPlacement.Save(file,new Rectangle(30,80,980,680),false);
        Check(WindowPlacement.Read(file,out restored,out maximized)&&restored==new Rectangle(30,80,980,680)&&!maximized,"atomic overwrite and normal state");
        Check(Directory.GetFiles(directory).Length==1,"no temporary preference files");
        File.WriteAllText(file,"{broken");Check(!WindowPlacement.Read(file,out restored,out maximized),"corrupt preferences ignored");
        File.WriteAllText(file,"{\"version\":2,\"x\":0,\"y\":0,\"width\":980,\"height\":680,\"state\":\"normal\"}");Check(!WindowPlacement.Read(file,out restored,out maximized),"unknown schema ignored");
        File.WriteAllText(file,"{\"version\":1,\"x\":0,\"y\":0,\"width\":-2,\"height\":680,\"state\":\"normal\"}");Check(!WindowPlacement.Read(file,out restored,out maximized),"invalid sizes ignored");
        File.WriteAllText(file,"{\"version\":1,\"x\":0,\"y\":0,\"width\":980,\"height\":680,\"state\":\"minimized\"}");Check(!WindowPlacement.Read(file,out restored,out maximized),"never restore hidden minimized window");
        File.WriteAllText(file,new string('x',5000));Check(!WindowPlacement.Read(file,out restored,out maximized),"bounded preference reads");
        Console.WriteLine(Json.Encode(new { checks = checks, ok = true })); return 0;
    }
}`,'utf8');
  const result=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/langversion:5','/main:WindowTests',`/out:${executable}`,'/r:System.dll','/r:System.Core.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',...references.map(file=>`/r:${file}`),path.join(root,'desktop','Program.cs'),harness],{cwd:temporary,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,(result.stdout||'')+(result.stderr||''));
  const run=spawnSync(executable,[temporary],{cwd:temporary,encoding:'utf8',windowsHide:true});
  assert.equal(run.status,0,(run.stdout||'')+(run.stderr||''));
  const proof=JSON.parse(run.stdout.trim());assert.equal(proof.ok,true);assert.ok(proof.checks>=22);
});
