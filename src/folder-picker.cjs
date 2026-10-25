'use strict';
const {spawn} = require('node:child_process');
const {RoomError} = require('./util.cjs');

// The browser fallback owns one picker. Disconnecting its request or stopping
// the service must also close that process, rather than leave an orphan dialog.
function createFolderPicker({launch=spawn,platform=process.platform,timeout=120000}={}) {
  let active=null;
  const pick=({signal}={})=>{
    if(platform!=='win32')return Promise.reject(new RoomError('请直接填写项目文件夹的完整路径。'));
    if(active)return Promise.reject(new RoomError('文件夹选择器已打开，请先完成或取消选择。',409,'folder_picker_busy'));
    return new Promise((resolve,reject)=>{
      let child,timer,settled=false;
      const finish=(error,value,kill=false)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);active=null;
        if(kill)try{child?.kill();}catch{}
        error?reject(error):resolve(value);
      };
      const abort=()=>finish(new RoomError('已取消选择文件夹。',499,'folder_picker_cancelled'),null,true);
      if(signal?.aborted){abort();return;}
      active=abort;signal?.addEventListener('abort',abort,{once:true});
      // Give the dialog a foreground owner; a daemon has no visible window.
      const script="[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Windows.Forms;$owner=New-Object System.Windows.Forms.Form;$owner.TopMost=$true;$owner.ShowInTaskbar=$false;$owner.Opacity=0;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='选择 Agent Office 项目文件夹';$d.ShowNewFolderButton=$false;try{$owner.Show();$owner.Activate();if($d.ShowDialog($owner) -eq 'OK'){[Console]::Write($d.SelectedPath)}}finally{$d.Dispose();$owner.Dispose()}";
      try{child=launch('powershell.exe',['-STA','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','ignore']});}
      catch{finish(new RoomError('无法打开文件夹选择器，请直接填写文件夹路径。'));return;}
      let text='';child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{text+=data;});
      child.once('error',()=>finish(new RoomError('无法打开文件夹选择器，请直接填写文件夹路径。'),null,true));
      child.once('close',code=>code===0?finish(null,{path:text.trim()}):finish(new RoomError('文件夹选择未完成，请重试或直接填写路径。')));
      timer=setTimeout(()=>finish(new RoomError('文件夹选择超时。请重试，或直接填写文件夹路径。',408,'folder_picker_timeout'),null,true),timeout);
    });
  };
  return {pick,close:()=>active?.()};
}
module.exports={createFolderPicker};
