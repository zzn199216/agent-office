'use strict';
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = value => value ? new Date(value).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
const labels = {queued:'已排队',creating:'创建工作会话',running:'处理中',waiting_input:'需要确认',waiting_grok:'等待回报',completed:'已完成',failed:'处理失败',cancelled:'已停止',outcome_uncertain:'需要核对',pending:'待处理',sending:'发送中',accepted:'已受理',consumed:'已读取',continued:'已继续',answered:'已回复',uncertain:'需要核对',posted:'已保存',delivered:'已送达',processing:'处理中',staged:'已暂存',waiting:'等待结果'};
const pill = (status, label) => `<span class="status-pill ${escape(status)}">${escape(label || labels[status] || status)}</span>`;
let state = null, projectId = localStorage.getItem('agentroom-project'), roomId = localStorage.getItem('agentroom-chat-room'), legacyId = null, history = null, candidates = [], selectedCandidate = null, selectedSetupMember = null, setupData = null, replyTo = null, refreshTimer = null, refreshing = false, refreshAgain = false, submitting = false, pendingSubmission = null, editingGrok = false, lastApprovalSignature = '', lastSetupSignature = '', lastTimeline = '', toastTimer;
let bridgeMemberId = null, bridgeRoomId = null, bridgeSetup = null, bridgeEntries = [], bridgeLoading = false, bridgeRefreshAgain = false, bridgeCopying = false, bridgeTesting = false, bridgeTest = null, bridgeTimer = null;
const bridgePrompts = new Map();
const bridgeConfirmDrafts = new Map();
let bridgeEntriesSignature = '';
let runtime = null, webConnected = false, entryBusy = false, authRenewal = null, events = null;
let professionalView = true, launchSession = null, launchBusy = false, launchFetching = false, launchAgain = false, launchTimer = null, launchError = '';
let launchCandidates = null, launchScanning = false, launchScannedAt = null, lastLaunchCandidates = '', lastLaunchHandshakes = '';
const launchSelection = new Set();
const onboardingJobs = new Map(), onboardingStarting = new Set();
let onboardingTimer = null, onboardingFetching = false, onboardingSignature = '';
const desktop = window.AgentRoomDesktop || null;
let desktopState = null, desktopBusy = false, desktopReady = false, desktopProbe = null;
let inspectorOpen = false, inspectorTab = 'members', inspectorMemberId = null, officeView = (()=>{try{return localStorage.getItem('agentoffice-room-view') !== 'chat';}catch{return true;}})(), officeScene = null, appearanceDraft = null, appearanceDirty = false, appearanceBusy = false, appearanceUploading = false, appearanceUploadVersion = 0;
let officeComposerOpen = false;
let connectionDoctor = null, connectionDoctorBusy = false, connectionDoctorError = '', connectionDoctorRoom = null, connectionDoctorSequence = 0;
let deleteRoomId = null, deletingRoom = false, deletePreview = null;
let managedRoomId=null,managingRoom=false;
let secretaryOpenRoom = null, secretaryPickingRoom = null, secretaryBusy = false, secretaryStartBusy = false, secretaryError = '', secretaryConnectRoom = null, secretaryConnectJob = null, secretaryGoalVersion = 0;
let secretaryFinishing=false;
const admittedMembers=members=>(members||[]).filter(member=>!!member.verified_at&&!['connection_failed','failed','disabled','revoked','unavailable'].includes(member.status));
// Everyone a person would recognise as a colleague: connected members and
// ones still connecting or failed. Hidden Grok group proxies stay out of view.
const visibleMembers=members=>(members||[]).filter(member=>member.verified_at||member.adapter!=='grok-proxy');
const staleMembers=()=>(state?.chat?.members||[]).filter(member=>!member.verified_at&&member.adapter!=='grok-proxy'&&['connection_failed','awaiting_handshake','offline'].includes(member.status)&&Date.now()-Date.parse(member.created)>10*60000);
const imageDrafts=new Map();
const draftImages=()=>imageDrafts.get(roomId)||[];
function renderImageDrafts(){
  $('image-drafts').innerHTML=draftImages().map(item=>`<div class="image-draft"><img src="${item.data_url}" alt="${escape(item.name)}"><span>${escape(item.name)}</span><button type="button" data-remove-image="${item.id}" aria-label="移除 ${escape(item.name)}">×</button></div>`).join('');
  $('image-drafts').classList.toggle('hidden',!draftImages().length);
}
async function addChatImages(files){
  const capturedRoom=roomId;if(!capturedRoom||legacyId||!webConnected)return;
  const selected=Array.from(files);if(!selected.length)return;
  if(selected.length>4||selected.reduce((sum,file)=>sum+file.size,0)>8*1024*1024)throw Error('每条消息最多附带 4 张图片，总大小不超过 8 MB。');
  if(selected.some(file=>!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||!file.size||file.size>4*1024*1024))throw Error('请选择 PNG、JPEG、WebP 或 GIF 图片，每张不超过 4 MB。');
  const images=await Promise.all(selected.map(async file=>({id:crypto.randomUUID(),name:file.name||'粘贴的图片',size:file.size,data_url:await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('无法读取这张图片，请重新选择。'));reader.readAsDataURL(file);})})));
  const existing=imageDrafts.get(capturedRoom)||[];
  if(existing.length+images.length>4||[...existing,...images].reduce((sum,image)=>sum+image.size,0)>8*1024*1024)throw Error('每条消息最多附带 4 张图片，总大小不超过 8 MB。');
  imageDrafts.set(capturedRoom,[...existing,...images]);if(roomId===capturedRoom){renderImageDrafts();updateOfficeComposerPresentation();}
}
function messageImages(message){
  return (message.attachments||[]).filter(item=>/^[a-f0-9-]{36}$/i.test(item.id)).map(item=>desktop?.offline?`<div class="saved-image">📷 ${escape(item.name)} · 开启服务后查看图片</div>`:`<a class="message-image" href="/api/chat/images/${item.id}" data-show-image="${item.id}" aria-label="查看图片 ${escape(item.name)}"><img src="/api/chat/images/${item.id}" alt="${escape(item.name)}" loading="lazy"><span>${escape(item.name)}</span></a>`).join('');
}
const teamRooms = new Map(), teamRequests = new Map();
let teamSignature = '', teamBusy = false, teamDialog = null, teamLoadError = '';
const secretaryDrafts = new Map(), secretaryDismissed = new Set();
const refreshWaiters = [];
try { for (const id of JSON.parse(localStorage.getItem('agentoffice-secretary-dismissed') || '[]')) secretaryDismissed.add(id); } catch {}
const secretaryDefaultGoal = '帮我梳理办公室目标与 AI 分工，先告诉我你需要了解什么。';
const textScroll = new Map(), appearanceDrafts = new Map();
const roomRecipients = new Map();
let recipientRoom = null, mentionIndex = 0;
const sceneDrafts = new Map(), sceneAssets = [['background_data','背景'],['desk_data','办公桌'],['beanbag_data','懒人沙发'],['plant_data','绿植'],['door_data','入口']];
const sceneDefaults = Object.freeze({time_zone:'auto',time_mode:'auto',auto_layout:true,columns:3,spacing:1,wall_color:'#f8f7f3',floor_color:'#faf7ef',show_window:true,show_clock:true,show_plant:true,motion:true});
if (desktop) {
  professionalView = true;
  const selected=new URLSearchParams(location.search).get('room');
  if (/^[a-f0-9-]{36}$/i.test(selected || '')) roomId=selected;
}
const entryCacheKey = 'agentroom-resume-entries-v1';
let resumeEntries = {};
try { resumeEntries = JSON.parse(localStorage.getItem(entryCacheKey) || '{}'); } catch {}
const presenceLabels = {online:'在线',stale:'心跳已过期',offline:'离线',unknown:'在线性未知',worker_online:'后台在线'};
function runtimeMember(id) { return (runtime?.members || runtime?.presence || []).find?.(item => (item.id || item.member_id) === id); }
function memberPresence(member = {}) {
  const observed = {...runtimeMember(member.id),...member.runtime_state}, value = member.presence || observed.presence || 'unknown';
  if(['connection_failed','failed','disabled','revoked','unavailable'].includes(member.status))return {status:'unavailable',label:'连接不可用 · 需重新接入',lastSeen:member.last_seen||observed.last_seen||null,canWake:false};
  let status = typeof value === 'string' ? value : value.state || value.status || 'unknown';
  if (observed.worker_online && status !== 'online') status = 'worker_online';
  if (status === 'unknown' && observed.worker_state === 'stale') status = 'stale';
  if (status === 'online' && observed.lease_expires && new Date(observed.lease_expires).getTime() <= Date.now()) status = 'stale';
  if (!webConnected && ['online','worker_online'].includes(status)) status = 'stale';
  return {status,label:presenceLabels[status] || '在线性未知',lastSeen:member.last_seen || value.last_seen || observed.last_seen || observed.worker_last_seen || null,canWake:Boolean(member.can_wake ?? value.can_wake ?? observed.can_wake)};
}
function entryKey(memberId, selectedRoom = roomId) { return `${runtime?.instance_id || state?.instance_id || 'local'}:${selectedRoom}:${memberId}`; }
function cachedEntry(memberId, selectedRoom = roomId) {
  const exact = resumeEntries[entryKey(memberId,selectedRoom)];
  return exact || Object.values(resumeEntries).find(entry => entry.room_id === selectedRoom && entry.member_id === memberId && (!runtime?.instance_id || entry.instance_id === runtime.instance_id));
}
function saveEntry(entry, memberId, selectedRoom) {
  resumeEntries[`${entry.instance_id || runtime?.instance_id || 'local'}:${selectedRoom}:${memberId}`] = {...entry,member_id:memberId,room_id:selectedRoom};
  localStorage.setItem(entryCacheKey,JSON.stringify(resumeEntries));
}
function saveBridgeEntry(setup, memberId = bridgeMemberId, selectedRoom = bridgeRoomId) { const entry = setup?.resume_entry; if (entry?.prompt && entry?.file) saveEntry(entry,memberId,selectedRoom); }
function setWebConnected(connected) { webConnected = connected; renderRuntime(); renderLaunch(); renderService(); renderInspector(); renderSecretary(); updateOfficeScene(); if ($('resume-dialog').open) renderResume(); }
function setProfessionalView(value) {
  professionalView = !!value; localStorage.setItem('agentroom-professional-view',String(professionalView));
  $('professional-workspace').classList.toggle('hidden',!professionalView); $('launch-home').classList.toggle('hidden',professionalView);
  $('professional-toggle').textContent = professionalView ? '接入成员 ＋' : '回到办公室 ↖'; $('professional-toggle').setAttribute('aria-pressed',String(professionalView));
  document.body.classList.toggle('simple-mode',!professionalView);
  applyRoomView(); applyInspector();
  renderLaunch();
}
function launchView(value) {
  if (!value) return null; if (value.id && value.room_id) return value;
  return value.latest || value.session || value.launch || value.sessions?.[0] || null;
}
function launchProvider(candidate) { return candidate.provider || candidate.id; }
function launchSelectable(candidate) { return candidate.installed === true && candidate.support !== 'unsupported' && (candidate.capabilities?.automatic_launch === true || candidate.capabilities?.mcp_prepare === true || candidate.capabilities?.manual_connect === true); }
function onboardingMode(candidate) { return candidate.capabilities?.manual_connect === true ? 'bridge' : candidate.capabilities?.automatic_launch === true ? 'managed' : 'desktop'; }
const providerDocs = Object.freeze({'gemini-cli':'https://geminicli.com/docs/get-started/installation/','doubao':'https://open.doubao.com/','opencode':'https://opencode.ai/docs/mcp-servers/','cline':'https://docs.cline.bot/mcp/mcp-overview','roo-code':'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/','cherry-studio':'https://docs.cherryai.com.cn/advanced-basic/extensions/mcp.md'});
function clientImportKind(value = {}) { return value.import_kind || value.installation?.import_kind || (value.provider === 'doubao' ? 'form' : 'json'); }
function clientConfigLabel(value) { return clientImportKind(value) === 'form' ? '复制连接器字段' : '复制 MCP 导入配置'; }
function safeDocsUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
let connectorFields = null;
async function copyClientConfiguration(sessionId, provider) {
  const result = await api('/api/launch/client-config',{session_id:sessionId,provider});
  if (result.manual_fields && typeof result.manual_fields === 'object') {
    const fields = result.manual_fields;
    if (typeof fields.name !== 'string' || typeof fields.transport !== 'string' || typeof fields.url !== 'string' || !/^https?:\/\//i.test(fields.url) || !fields.headers || typeof fields.headers !== 'object' || Array.isArray(fields.headers)) throw new Error('连接器字段尚未准备完成。');
    // Private configuration lives only in this authenticated, explicitly opened
    // dialog. It is never merged into public onboarding jobs or localStorage.
    connectorFields = {name:fields.name,transport:fields.transport,url:fields.url,headers:{...fields.headers}};
    $('connector-name').value = fields.name; $('connector-transport').value = fields.transport; $('connector-url').value = fields.url;
    $('connector-headers').value = Object.keys(fields.headers).length ? JSON.stringify(fields.headers,null,2) : '无需填写';
    $('connector-instructions').textContent = result.instructions || '分别填写这些字段，启用连接器后，在这个 AI 本人的窗口调用通信工具完成握手。';
    const source = safeDocsUrl(result.source || providerDocs[provider]); $('connector-docs').href = source || '#'; $('connector-docs').classList.toggle('hidden',!source);
    if (!$('connector-fields-dialog').open) $('connector-fields-dialog').showModal();
    return;
  }
  if (!result.config || typeof result.config !== 'object') throw new Error('尚未返回这个客户端的导入配置。');
  await navigator.clipboard.writeText(JSON.stringify(result.config,null,2)); toast('配置已复制。只粘贴到对应客户端的 MCP 设置，启用后再完成本人握手。');
}
function showOnboardingRequirements(candidate) {
  const provider = launchProvider(candidate), docs = safeDocsUrl(candidate.documentation_url || candidate.docs_url || providerDocs[provider]);
  $('onboarding-requirements-title').textContent = `${candidate.name || provider} 接入要求`;
  $('onboarding-requirements-detail').textContent = candidate.reason || candidate.setup_note || (candidate.capabilities?.automatic_launch ? '请先安装官方 CLI，并在这个 CLI 中完成账号或 API 配置。网页或桌面登录不会自动代替这个独立后台入口。' : '已发现这个客户端。还需要对应的正式通信接口，实际工具握手后才会显示接通。');
  $('onboarding-requirements-docs').href = docs || '#'; $('onboarding-requirements-docs').classList.toggle('hidden',!docs); $('onboarding-requirements-dialog').showModal();
}
function onboardingCanInstall(candidate) { return candidate.capabilities?.runtime_install === true || candidate.capabilities?.runtime_installable === true || candidate.installable === true || candidate.runtime_installable === true; }
function onboardingSelectable(candidate) { return launchSelectable(candidate) || (candidate.support !== 'unsupported' && onboardingCanInstall(candidate)); }
function onboardingRunning(job) { return job && ['running','queued','pending','detecting','installing','configuring','starting','handshaking','waiting'].includes(job.status); }
function onboardingReady(job) { return ['ready_automatic','ready_mailbox'].includes(job?.status) ? job.status : job?.status === 'ready' && ['ready_automatic','ready_mailbox'].includes(job.stage) ? job.stage : null; }
function onboardingForProvider(provider) { return [...onboardingJobs.values()].filter(job => job.provider === provider && (!job.room_id || job.room_id === roomId)).sort((a,b) => String(b.updated_at || b.updated || b.created_at || b.created || '').localeCompare(String(a.updated_at || a.updated || a.created_at || a.created || '')))[0]; }
function currentOnboardingJobs() { const providers = new Map(); for (const job of [...onboardingJobs.values()].filter(job => (!job.room_id || job.room_id === roomId) && (!job.project_id || job.project_id === projectId)).sort((a,b) => String(b.created_at || b.created || b.updated_at || b.updated || '').localeCompare(String(a.created_at || a.created || a.updated_at || a.updated || '')))) if (!providers.has(job.provider)) providers.set(job.provider,job); return [...providers.values()]; }
function renderLaunchCandidates() {
  const signature = JSON.stringify([launchScanning,launchBusy,launchCandidates,webConnected,projectId,[...onboardingStarting],[...onboardingJobs.values()].map(job => [job.id,job.status,job.updated_at])]);
  if (signature === lastLaunchCandidates) { $('launch-candidates').querySelectorAll('[data-launch-provider]').forEach(input => { input.checked = launchSelection.has(input.dataset.launchProvider); }); return; }
  lastLaunchCandidates = signature;
  if (launchScanning) { $('launch-candidates').innerHTML = '<div class="launch-scan-note"><span class="pulse-dot"></span> 正在查看本机安装和运行情况…</div>'; return; }
  if (!launchCandidates) { $('launch-candidates').innerHTML = '<div class="launch-scan-note">点击扫描，找到想接入的成员，再点“一键接入”。</div>'; return; }
  const visible = launchCandidates.filter(candidate => candidate.id !== 'mailbox' && (candidate.installed || candidate.running || onboardingCanInstall(candidate) || candidate.capabilities?.automatic_launch || candidate.capabilities?.mcp_prepare));
  $('launch-candidates').innerHTML = visible.length ? visible.map(candidate => {
    const provider = launchProvider(candidate), selectable = launchSelectable(candidate), canJoin = onboardingSelectable(candidate), mode = onboardingMode(candidate), job = onboardingForProvider(provider), pending = onboardingStarting.has(provider) || onboardingRunning(job);
    const availability = !canJoin ? candidate.support === 'unsupported' ? '已发现，接口待适配' : !candidate.installed ? mode === 'managed' ? '需安装官方 CLI · 查看说明' : '尚未安装 · 查看官方接入说明' : '已发现 · 待适配' : !candidate.installed ? '尚未安装 · 可安装接入' : candidate.running ? '正在运行 · 接入后验证通信' : '已安装 · 可接入';
    const label = pending ? '正在接入…' : onboardingReady(job) ? '重新检查' : job?.status === 'needs_action' ? '继续接入' : !candidate.installed && canJoin ? '安装并接入' : '一键接入';
    const accountNote = mode === 'bridge' ? '复用桥接 Bot 的本人窗口；复制接入说明后完成实际握手' : provider === 'qwen-code' ? '首次配置 API 或 Token 计划凭据' : provider === 'gemini-cli' ? '使用 Gemini CLI 自己的账号或 API；网页登录不会自动代替' : provider === 'doubao' ? '本人设置中添加自定义连接器，启用后验证工具握手' : '';
    return `<article class="launch-candidate ${canJoin ? '' : 'unavailable'}"><label class="launch-candidate-select"><input type="checkbox" data-launch-provider="${escape(provider)}" aria-label="批量选择 ${escape(candidate.name || provider)}" ${launchSelection.has(provider) ? 'checked' : ''} ${selectable && !launchBusy ? '' : 'disabled'}></label>${avatar(candidate.name,provider)}<div class="launch-candidate-info"><strong>${escape(candidate.name || provider)}</strong><span class="launch-mode ${mode === 'managed' && canJoin ? 'automatic' : ''}">${escape(mode === 'bridge' ? '本人窗口 · 桥接' : mode === 'managed' ? '后台 CLI · 独立会话' : candidate.capabilities?.mcp_prepare ? '本人 MCP · 信箱' : '接口待适配')}</span><small>${escape(availability)}</small>${accountNote ? `<small>${escape(accountNote)}</small>` : ''}</div><button type="button" class="${canJoin ? 'primary' : 'secondary'} onboarding-start" ${canJoin ? 'data-onboarding-provider' : 'data-onboarding-requirements'}="${escape(provider)}" aria-label="${escape(candidate.name || provider)} ${escape(canJoin ? label : '查看接入要求')}" ${!pending && !launchBusy && !launchScanning && (webConnected || !canJoin) ? '' : 'disabled'}>${escape(canJoin ? label : '查看接入要求')}</button></article>`;
  }).join('') : '<div class="launch-scan-note">本次未发现可用成员。可以在专业视图接入通用 MCP 客户端。</div>';
}
function renderLaunch() {
  const projects = state?.projects || [], selectedProject = projects.find(project => project.id === projectId);
  const options = projects.length ? projects.map(project => `<option value="${escape(project.id)}">${escape(project.name)}</option>`).join('') : '<option value="">先添加项目</option>';
  if ($('launch-project-select').innerHTML !== options) $('launch-project-select').innerHTML = options;
  $('launch-project-select').value = projectId || ''; $('launch-project-select').disabled = launchBusy;
  $('launch-no-project').classList.toggle('hidden',!!projects.length);
  $('launch-prepare').classList.toggle('hidden',!projects.length);
  $('launch-prepare').parentElement.classList.toggle('hidden',!projects.length);
  const session = launchSession?.room_id === roomId ? launchSession : null, preparing = launchBusy || session?.status === 'preparing';
  $('professional-launch-details').classList.toggle('hidden',!session);
  $('professional-launch-record').textContent = professionalView && session ? `准备记录：${session.id}` : '';
  $('professional-handoff-file').textContent = professionalView && session ? session.handoff_file || '本机交接文件尚未准备完成。' : '';
  $('professional-launch-status').textContent = professionalView && session ? JSON.stringify({status:session.status,selected_providers:session.selected_providers||[],grok_verified:session.grok_verified===true,watch:session.watch||null,native_sync:session.native_sync||{status:'pending',verified:false},installation:session.installation||null,selected_handshakes:(session.selected_handshakes||[]).map(item=>({provider:item.provider,name:item.name,entry_file:item.entry_file,configuration_file:item.configuration_file||item.mcp_file||null,status:item.status,needs_import:item.needs_import===true,can_wake:item.can_wake===true})),proxies:(session.proxies||[]).map(proxy=>({name:proxy.name,provider:proxy.provider,backend_member_id:proxy.backend_member_id,status:proxy.status,local_verified:proxy.local_verified,native_group_status:proxy.native_group_status,installation:proxy.installation||null}))},null,2) : '';
  $('launch-watch-status').textContent = '';
  $('launch-watch-status').title = launchScannedAt ? `你最近一次扫描 ${time(launchScannedAt)}` : '点击扫描或在 Grok 中提出扫描请求后，才读取本机安装和进程。';
  const syncStatus = session?.native_sync?.status, routinePending = ['pause_requested','host_reported'].includes(syncStatus);
  $('launch-native-sync-status').textContent = routinePending ? '原同步例程：等待停用确认' : ['host_reported_paused','paused','pause_reported','disabled','stopped'].includes(syncStatus) ? '' : '';
  $('launch-native-sync-status').title = routinePending ? '原生例程由 Grok 管理；等待 Grok 实际停用并回报。' : '每次只接入你指定的成员。';
  $('launch-scan').disabled = launchScanning || preparing || !webConnected;
  $('launch-scan').innerHTML = launchScanning ? '<span class="pulse-dot"></span> 正在扫描…' : '扫描本机 agents <span>↻</span>';
  $('launch-prepare').disabled = preparing || launchScanning || !launchSelection.size || !selectedProject || !webConnected;
  $('launch-prepare').innerHTML = preparing ? '<span class="pulse-dot"></span> 正在接入成员…' : '接入选中的成员 <span>↗</span>';
  $('launch-selection-note').textContent = launchSelection.size ? `已选 ${launchSelection.size} 位成员。接入后由 Grok 完成本次加群。` : '尚未选择成员。勾选后，点击接入。';
  renderLaunchCandidates();
  renderOnboarding();
  renderSecretary();
  $('launch-error').textContent = launchError; $('launch-error').classList.toggle('hidden',!launchError);
  const handoffReady = !!session?.handoff_file && !!session?.grok_prompt && !preparing;
  const singleMemberFlow = !!session && currentOnboardingJobs().some(job => job.launch_session_id === session.id);
  $('launch-progress').classList.toggle('hidden',singleMemberFlow || !session && !launchBusy); $('launch-handoff').classList.toggle('hidden',singleMemberFlow || !handoffReady);
  $('launch-copy').disabled = !handoffReady || launchBusy;
  if (!session) { $('launch-status-title').textContent = launchBusy ? '正在接入选中的成员' : '尚无接入记录'; $('launch-status-detail').textContent = launchBusy ? '只处理你本次选择的成员，进度会自动更新。' : '扫描后勾选成员，再点击接入。'; $('launch-agent-list').innerHTML = launchBusy ? '<div class="launch-scan-note"><span class="pulse-dot"></span> 正在准备本次选择…</div>' : ''; $('launch-self-handshakes').classList.add('hidden'); $('launch-self-handshakes').innerHTML = ''; lastLaunchHandshakes = ''; return; }
  const proxies = session.proxies || [], detected = session.candidates || [], backends = session.members || [], handshakes = session.selected_handshakes || [];
  $('launch-status-title').textContent = session.status === 'preparing' ? '正在接入本次选择的成员' : handshakes.length ? '等待桌面客户端加载并握手' : ['partial','needs_setup'].includes(session.status) ? '部分成员需要完成连接' : session.status === 'host_reported' ? 'Grok 已回报，进群状态待核实' : '本机已准备，继续交给 Grok';
  $('launch-status-detail').textContent = session.status === 'preparing' ? '只处理你选择的成员；本机通信与 Grok 加群分别记录。' : '已有成员与状态保留在这里。接入说明只包含本次指定的成员。';
  const nativeLabels = {host_reported:'Grok 报告已加入',independently_verified:'原群已独立核验',joined:'Grok 报告已加入',grok_verified:'Grok 报告已加入',awaiting_grok:'Grok 中待加入',pending:'Grok 中待加入',prepared:'Grok 中待加入',ready:'Grok 中待加入',ready_local:'Grok 中待加入',backend_ready:'Grok 中待加入',connecting:'Grok 中待加入',needs_setup:'Grok 中待加入',unsupported:'接口待接入',preparing:'Grok 中待加入',failed:'Grok 中待加入'};
  $('launch-agent-list').innerHTML = proxies.map(proxy => {
    const backend = backends.find(member => member.id === proxy.backend_member_id) || memberById(proxy.backend_member_id) || {}, candidate = detected.find(item => item.provider === proxy.provider || item.id === proxy.provider) || {};
    const verified = proxy.local_verified === true || !!backend.verified_at && ['ready','connected','online','verified'].includes(backend.status), unsupported = proxy.status === 'unsupported' || candidate.support === 'unsupported', nativeState = proxy.native_group_status || proxy.status;
    const manualMcp = candidate.capabilities?.mcp_prepare && !candidate.capabilities?.automatic_launch;
    const localLabel = unsupported ? '已发现，接口待适配' : verified ? '本机通信已验证' : backend.status === 'connecting' || proxy.status === 'connecting' ? '本机正在连接' : ['failed','connection_failed'].includes(backend.status) ? '本机连接需核对' : proxy.installation?.needs_import ? '等待导入 MCP 配置并完成本人握手' : manualMcp ? proxy.installation?.installed ? 'MCP 已配置，等待客户端加载并握手' : 'MCP 配置待完成' : proxy.backend_status === 'ready' || proxy.status === 'ready_local' ? '本机已准备' : candidate.capabilities?.automatic_launch ? '本机入口准备中' : '等待客户端加载配置';
    return `<article class="launch-agent-row ${unsupported ? 'unsupported' : ''}">${avatar(proxy.name || candidate.name,proxy.provider)}<div><strong>${escape(proxy.name || candidate.name || proxy.provider)}</strong><span>${escape(localLabel)}</span>${proxy.response_mode === 'manual_mailbox' ? '<small>消息需由本人窗口处理</small>' : ''}${proxy.reason ? `<small>${escape(proxy.reason)}</small>` : ''}</div><span class="launch-agent-native ${nativeState === 'independently_verified' && session.grok_verified === true ? 'verified' : ''}">${escape(unsupported ? '暂未加入' : nativeLabels[nativeState] || 'Grok 中待加入')}</span></article>`;
  }).join('');
  if (!$('launch-agent-list').innerHTML) $('launch-agent-list').innerHTML = '<div class="launch-scan-note">本次指定的成员尚未接通。可在专业视图查看详情。</div>';
  $('launch-self-handshakes').classList.toggle('hidden',!handshakes.length);
  const handshakeHtml = handshakes.map(item => {
    const installed = proxies.find(proxy => proxy.provider === item.provider)?.installation?.installed === true;
    const note = item.needs_import ? clientImportKind(item) === 'form' ? '在本人设置中添加自定义连接器，按名称、HTTP、URL 分别填写，再把握手说明交给本人窗口。' : '在这个客户端的 MCP 设置中导入配置，再把握手说明交给本人窗口。' : `${installed ? '重新加载' : '完成配置并重新加载'}这个客户端的 AgentRoom MCP，再把握手说明交给本人窗口。`;
    return `<article class="launch-self-card"><strong>${escape(item.name || item.provider)} · 本人窗口接入</strong><p>${note}</p><div>${item.needs_import || item.provider === 'qwen-desktop' ? `<button type="button" class="secondary" data-launch-config="${escape(item.provider)}" aria-label="${escape(item.name || item.provider)} ${escape(clientConfigLabel(item))}">${escape(clientConfigLabel(item))}</button>` : ''}<button type="button" class="secondary" data-launch-handshake="${escape(item.provider)}" aria-label="${escape(item.name || item.provider)} 复制本人的握手说明">复制本人的握手说明</button></div>${item.needs_import || item.provider === 'qwen-desktop' ? '<small>配置只贴本人的 MCP 设置，不贴群聊。完成真实握手后，才会显示通信接通。</small>' : '<small>只有本人实际调用通信工具，才会显示接通。</small>'}</article>`;
  }).join('');
  if (handshakeHtml !== lastLaunchHandshakes) { $('launch-self-handshakes').innerHTML = handshakeHtml; lastLaunchHandshakes = handshakeHtml; }
  const actionValue = session.grok_actions || session.actions || [], actions = Array.isArray(actionValue) ? actionValue : [], pendingActions = actions.filter(item => typeof item === 'string' || !['complete','completed','verified','done'].includes(item.status));
  $('launch-pending-actions').classList.toggle('hidden',!pendingActions.length);
  $('launch-pending-actions').innerHTML = pendingActions.map(item => `<div>${escape(typeof item === 'string' ? item : item.label || item.description || item.title || item.reason || '')}</div>`).join('');
  $('launch-skill-command').textContent = session.skill_command || '/AgentRoom'; $('launch-prompt').textContent = session.grok_prompt || '';
  $('launch-handoff-file').textContent = session.handoff_file || '完整说明保存在本机。'; $('launch-session-id').textContent = professionalView ? `准备记录：${session.id}` : '';
}
async function refreshLaunch() {
  clearTimeout(launchTimer); if (!roomId || legacyId || !webConnected) { launchSession = null; renderLaunch(); return; }
  if (launchFetching) { launchAgain = true; return; } launchFetching = true; const selected = roomId;
  try { const response = await api(`/api/launch/state?room_id=${encodeURIComponent(selected)}`); if (selected !== roomId) return; launchSession = launchView(response); renderLaunch();renderInspector(); }
  catch (error) { if (selected === roomId) { launchError = error.message; renderLaunch(); } }
  finally { launchFetching = false; if (launchAgain) { launchAgain = false; launchTimer = setTimeout(() => action(refreshLaunch),200); } else if (launchSession?.status === 'preparing') launchTimer = setTimeout(() => action(refreshLaunch),2000); }
}
async function scanLaunch() {
  if (launchScanning || launchBusy) return;
  launchScanning = true; launchError = ''; renderLaunch();
  try { const result = await api('/api/launch/scan',{}); launchCandidates = result.candidates || []; launchScannedAt = result.scanned_at || result.at || new Date().toISOString(); launchSelection.clear(); toast('扫描完成。点击成员旁的“一键接入”。'); }
  catch (error) { launchError = error.message; }
  finally { launchScanning = false; renderLaunch(); }
}
async function prepareLaunch() {
  if (launchBusy || launchScanning) return;
  const providers = (launchCandidates || []).filter(candidate => launchSelection.has(launchProvider(candidate)) && launchSelectable(candidate)).map(launchProvider);
  if (!providers.length) { toast('先扫描并选择你要接入的成员。'); return; }
  const project = state?.projects?.find(item => item.id === projectId); if (!project) { showProject(); return; }
  launchBusy = true; launchError = ''; renderLaunch();
  try {
    if (!roomId || legacyId) { const room = await api('/api/chat/rooms',{project_id:project.id,title:`${project.name} 协作`}); roomId = room.id; legacyId = null; rememberSelection(); }
    const selected = roomId, session = await api('/api/launch/prepare',{room_id:selected,providers,install_clients:true,...$('launch-goal').value.trim() ? {goal:$('launch-goal').value.trim()} : {}});
    if (selected !== roomId) return; launchSession = launchView(session) || session; launchSelection.clear(); toast('已请求接入选中的成员。完成后把本次说明交给 Grok。'); await refresh();
  } catch (error) { launchError = /^(Failed to fetch|Load failed|NetworkError)/i.test(error.message || '') ? '准备请求的结果尚未确认。先检查进度，避免重复创建成员。' : error.message; }
  finally { launchBusy = false; renderLaunch(); action(refreshLaunch); }
}
function onboardingView(value) { return value?.job || value?.onboarding || value; }
function onboardingActions(job) { const actions = job.next_actions || job.actions; return Array.isArray(actions) && actions.length ? actions : job.action || job.next_action ? [job.action || job.next_action] : []; }
function onboardingAction(job) { return onboardingActions(job)[0] || null; }
function onboardingActionMarkup(job) {
  const values = onboardingActions(job), first = values[0]; if (!first) return '';
  const buttons = values.map(value => {
    const id = escape(job.id), operation = value.operation || value.kind || value.type;
    if (value.url && /^https?:\/\//i.test(value.url)) return `<a class="primary" href="${escape(value.url)}" target="_blank" rel="noopener noreferrer">${escape(value.button_label || value.label || '打开授权页面')} ↗</a>`;
    if (['import_client_config','import_mcp','desktop_import','configure_connector','import_connector'].includes(operation)) return `<button type="button" class="primary" data-onboarding-config="${id}">${escape(clientConfigLabel(job))}</button>`;
    if (operation === 'copy_handshake_prompt' || value.kind === 'self_handshake') return `<button type="button" class="secondary" data-onboarding-copy="${id}" data-onboarding-copy-kind="handshake">复制本人接入说明</button>`;
    if (operation === 'native_group_handoff') return `<button type="button" class="secondary" data-onboarding-copy="${id}" data-onboarding-copy-kind="group">复制 Grok 加群说明</button>`;
    if (value.command || value.instruction || value.prompt) return `<button type="button" class="secondary" data-onboarding-copy="${id}">${escape(value.copy_label || (value.command ? '复制首次配置说明' : '复制本人接入说明'))}</button>`;
    if (operation === 'login_client') return `<button type="button" class="primary" data-onboarding-operation="login_client" data-onboarding-action-job="${id}">${job.configuration?.api_mode?'打开 API 配置':'打开首次配置'} ↗</button>`;
    if (operation === 'retry' || operation === 'install_runtime') return `<button type="button" class="secondary" data-onboarding-operation="${escape(operation)}" data-onboarding-action-job="${id}">${escape(job.provider === 'qwen-code' && job.stage === 'awaiting_auth' && operation === 'retry' ? '配置完成后继续接入' : value.label || '继续接入')}</button>`;
    return '';
  }).filter(Boolean);
  if (job.status === 'needs_action') buttons.push(`<button type="button" class="secondary" data-onboarding-check="${escape(job.id)}">我已完成，检查连接</button>`);
  const fallback = first.kind === 'reload_client' ? '请从客户端菜单退出后重新打开，再将本人接入说明交给它。' : first.kind === 'import_mcp' ? clientImportKind(job) === 'form' ? '在本人设置中新建自定义连接器，分别填写字段；启用后，再完成真实工具握手。' : '配置贴到这个客户端的 MCP 设置；启用后，再完成本人的工具握手。' : first.kind === 'self_handshake' ? '将下面的接入说明交给本人窗口，实际调用工具后会显示接通。' : first.kind === 'login' ? job.configuration?.api_mode ? '此成员使用本机 Claude API 配置。密钥只需保存一次；保存后继续接入，无需重新登录订阅账号。' : job.provider === 'qwen-code' ? '在官方命令窗口通过 /auth 配置 API 或计划凭据；完成后继续接入。此入口不复用 Qwen 桌面登录。' : job.provider === 'gemini-cli' ? '请在 Gemini CLI 中完成 Google 登录或 API 配置。它使用自己的认证，不代替你当前网页中的聊天。' : '首次登录或授权需要你本人完成，后续接入会复用账号。' : '';
  const title = first.kind === 'login' && job.provider === 'qwen-code' ? '配置 Qwen Code 提供商' : first.label || first.title || '需要完成一次操作';
  return `<div class="onboarding-action"><strong>${escape(title)}</strong>${first.detail || first.description || fallback ? `<p>${escape(first.detail || first.description || fallback)}</p>` : ''}<div class="onboarding-action-buttons">${buttons.join('')}</div></div>`;
}
function roomUsesGrok() { return (history?.participants || []).some(member => member.adapter === 'grok-bridge' && member.verified_at); }
// A connection that waits for the user's approval must ask right here, where
// the user is looking, not only in the chat room's approval panel.
function onboardingApprovalMarkup(job) {
  const pending = (state?.approvals || []).filter(approval => job.member_id && approval.request_id === `connect:${job.member_id}`);
  return pending.map(approval => `<div class="onboarding-approval" data-approval="${escape(approval.id)}"><strong>${escape(job.name || '这位成员')}需要你确认一步才能继续</strong><pre>${escape(approval.command || approval.reason || approval.type || '')}</pre><div><button type="button" class="primary" data-onboarding-approve="${escape(approval.id)}" data-decision="accept">允许</button><button type="button" class="secondary" data-onboarding-approve="${escape(approval.id)}" data-decision="decline">拒绝</button></div></div>`).join('');
}
function tickOnboardingElapsed() { for (const span of document.querySelectorAll('.onboarding-elapsed[data-since]')) { const seconds = Math.max(0, Math.round((Date.now() - Date.parse(span.dataset.since)) / 1000)); span.textContent = `已用 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}${seconds > 90 ? ' · 比平时久，可能在等登录或确认' : ''}`; } }
setInterval(tickOnboardingElapsed, 1000);
function onboardingJobMarkup(job) {
    const readyType = onboardingReady(job), ready = !!readyType, pending = onboardingRunning(job), needsAction = job.status === 'needs_action', failed = ['failed','error','interrupted','cancelled'].includes(job.status), actionValue = onboardingAction(job);
    const stage = job.stage || job.phase || '', stageNumber = Number.isInteger(job.stage_index) ? Math.max(0,Math.min(3,job.stage_index)) : /handshake|verify|ready|complete|^connecting$/.test(stage) ? 2 : /config|install|auth|start|launch|import|reload|connection/.test(stage) ? 1 : 0;
    const stageLabels = ['发现','配置','验证通信','完成'];
    const steps = stageLabels.map((label,index) => `<li class="${ready || index < stageNumber ? 'done' : index === stageNumber && !failed ? 'current' : ''}"><span>${ready || index < stageNumber ? '✓' : index + 1}</span>${label}</li>`).join('');
    const title = readyType === 'ready_automatic' ? '已接通 · 发消息就会自动开工' : readyType === 'ready_mailbox' ? '已接通 · 要在它自己的窗口里处理消息' : needsAction ? job.configuration?.api_mode ? '核对已保存的 API 配置' : job.provider === 'qwen-code' && stage === 'awaiting_auth' ? '完成首次 API 或计划配置' : job.provider === 'gemini-cli' && stage === 'awaiting_auth' ? '完成 Gemini CLI 账号配置' : '完成一次授权或启用' : failed ? '接入需要核对' : pending ? '正在接入' : '等待接入确认';
    const detail = job.message || job.detail || (ready ? readyType === 'ready_automatic' ? '可以在房间里直接交给它了。' : '它不会自动开工：给它发消息后，到它自己的窗口里说一句“查看收件箱”。' : stage === 'awaiting_auth' ? '完成首次账号配置后，再继续接入并验证后台通信。' : stage === 'awaiting_runtime_install' ? '还需要安装这个 agent 的后台入口。确认后，只安装你指定的成员。' : stage === 'unsupported' || stage === 'needs_wake_adapter' ? '已发现应用，正式通信或后台任务入口仍待适配。' : needsAction ? '完成下面这一步，接入会自动继续。' : '正在启动它并验证通信，通常不到一分钟。');
    const groupState = job.native_group_status || job.group_status, reported = ['host_reported','joined'].includes(groupState);
    const actionHtml = (needsAction || failed || ready) && actionValue ? onboardingActionMarkup(job) : '';
    return `<article class="onboarding-job ${failed ? 'failed' : ready ? 'ready' : ''}" data-onboarding-job="${escape(job.id)}"><div class="onboarding-job-heading">${avatar(job.name || job.provider,job.provider)}<div><strong>${escape(job.name || job.provider)}</strong><span>${escape(title)}</span></div>${pending ? '<span class="pulse-dot"></span>' : ''}</div><ol class="onboarding-steps">${steps}</ol><p class="onboarding-job-detail">${escape(detail)}${pending && job.created ? ` <span class="onboarding-elapsed" data-since="${escape(job.created)}"></span>` : ''}</p>${pending ? onboardingApprovalMarkup(job) : ''}${actionHtml}${job.error ? `<p class="onboarding-job-error">${escape(typeof job.error === 'string' ? job.error : job.error.message || '请在专业视图核对接入记录。')}</p>` : ''}${ready && roomUsesGrok() ? `<div class="onboarding-group-note">${escape(reported ? 'Grok 已报告加群。' : 'Grok 群：需要时再让 Grok 把它拉进群。')}</div>` : ''}</article>`;
}
function renderOnboarding() {
  const jobs = currentOnboardingJobs();
  $('onboarding-progress').classList.toggle('hidden',!jobs.length);
  const signature = JSON.stringify([jobs,webConnected,(state?.approvals || []).map(approval => approval.id)]); if (signature === onboardingSignature) return; onboardingSignature = signature;
  $('onboarding-jobs').innerHTML = jobs.map(onboardingJobMarkup).join(''); tickOnboardingElapsed();
}
async function refreshOnboarding() {
  clearTimeout(onboardingTimer); if (!webConnected || onboardingFetching) return; onboardingFetching = true;
  try {
    const response = await api(`/api/onboarding/jobs${roomId ? `?room_id=${encodeURIComponent(roomId)}` : projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`);
    for (const value of response.jobs || (Array.isArray(response) ? response : [])) { const job = onboardingView(value); if (job?.id) onboardingJobs.set(job.id,job); }
    renderLaunch(); returnSecretaryAfterOnboarding();
  } catch (error) { if (onboardingJobs.size && !/not.found|不存在/i.test(error.message)) toast(error.message); }
  finally { onboardingFetching = false; if ([...onboardingJobs.values()].some(onboardingRunning)) onboardingTimer = setTimeout(() => action(refreshOnboarding),2000); }
}
async function checkOnboarding(jobId) {
  let job = onboardingView(await api(`/api/onboarding/jobs/${encodeURIComponent(jobId)}`));
  if(job && !onboardingReady(job) && !onboardingRunning(job) && ['codex','claude-code','qwen-code','gemini-cli'].includes(job.provider)) job=onboardingView(await api(`/api/onboarding/jobs/${encodeURIComponent(jobId)}/retry`,{}));
  if (job?.id) onboardingJobs.set(job.id,job);
  renderLaunch(); await refreshLaunch(); returnSecretaryAfterOnboarding(); if (onboardingRunning(job)) onboardingTimer = setTimeout(() => action(refreshOnboarding),2000);
}
function onboardingProgressTarget() { return $('secretary-connect-dialog').open ? $('secretary-connect-progress') : $('onboarding-progress'); }
function returnSecretaryAfterOnboarding() {
  const job = onboardingJobs.get(secretaryConnectJob);
  if(secretaryFinishing || !job || !onboardingReady(job) || secretaryConnectRoom !== roomId || (job.room_id && job.room_id !== roomId)) return;
  const selected=currentSecretary(),assign=!selected.member_id||selected.status!=='ready';
  if(assign && !job.can_wake){$('secretary-connect-status').textContent='这位成员使用本人窗口信箱；请先接通可后台回答的 AI 作为秘书。';return;}
  const targetRoom=roomId;secretaryFinishing=true;
  action(async()=>{if(assign)await api('/api/secretary',{room_id:targetRoom,member_id:job.member_id});await refresh();if(roomId!==targetRoom)return;secretaryConnectJob=null;if($('secretary-connect-dialog').open)$('secretary-connect-dialog').close();secretaryPickingRoom=null;closeSecretaryTutorial();setProfessionalView(true);selectRoomView(true);if(assign){$('recipient').value=job.member_id;updateRecipientNote();}toast(assign?'秘书已真实接通，可以在办公室交代目标。':'成员已真实接通，已进入办公室。');}).finally(()=>{secretaryFinishing=false;});
}
async function startOnboarding(provider) {
  if($('secretary-connect-dialog').open&&currentOnboardingJobs().some(onboardingRunning))return;
  const candidate = (launchCandidates || []).find(item => launchProvider(item) === provider); if (!candidate || !onboardingSelectable(candidate) || onboardingStarting.has(provider)) return;
  const project = state?.projects?.find(item => item.id === projectId); if (!project) { showProject(); return; }
  const secretaryConnecting = $('secretary-connect-dialog').open && secretaryConnectRoom === roomId;
  const current = onboardingForProvider(provider); if (current?.status === 'needs_action' || onboardingReady(current)) { if(secretaryConnecting) secretaryConnectJob = current.id; onboardingProgressTarget().scrollIntoView({behavior:'smooth',block:'start'}); await checkOnboarding(current.id); return; }
  onboardingStarting.add(provider); launchError = ''; renderLaunch();
  try {
    const job = onboardingView(await api('/api/onboarding/start',{provider,...roomId && !legacyId ? {room_id:roomId} : {project_id:project.id},mode:onboardingMode(candidate),install_client:true,...!candidate.installed && onboardingCanInstall(candidate) ? {install_runtime:true} : {},...$('launch-goal').value.trim() ? {goal:$('launch-goal').value.trim()} : {}}));
    if (!job?.id) throw new Error('尚未返回接入记录。请检查进度，避免重复发起。'); onboardingJobs.set(job.id,job); if (job.room_id && !roomId) { roomId = job.room_id; legacyId = null; rememberSelection(); }
    if(secretaryConnecting) secretaryConnectJob = job.id;
    toast(`正在接入 ${candidate.name || provider}。`); renderLaunch(); onboardingProgressTarget().scrollIntoView({behavior:'smooth',block:'nearest'}); returnSecretaryAfterOnboarding(); action(refresh); action(refreshOnboarding);
  } catch (error) { launchError = /^(Failed to fetch|Load failed|NetworkError)/i.test(error.message || '') ? '接入请求的结果尚未确认。先检查进度，避免重复创建成员。' : error.message; }
  finally { onboardingStarting.delete(provider); renderLaunch(); }
}
function renderRuntime() {
  const show = Boolean(roomId && !legacyId); $('room-runtime').classList.toggle('hidden',!show); if (!show) return;
  const roomState = runtime?.rooms?.find(room => room.id === roomId), roomLabels = {idle:'房间待命',waiting:'消息已排队',processing:'正在处理',needs_review:'有结果待核对'};
  $('runtime-storage').textContent = `记录保存在本机 · ${roomLabels[roomState?.state] || '状态已保存'}`;
  $('runtime-processor').textContent = webConnected ? '处理程序可用' : desktop?.offline ? '服务已关闭' : '处理程序未连接';
  $('runtime-processor').className = `runtime-processor ${webConnected ? 'available' : 'disconnected'}`;
  $('runtime-instance').textContent = runtime?.instance_id ? `实例 ${runtime.instance_id.slice(0,8)}` : '磁盘记录保留';
  $('runtime-disconnected').classList.toggle('hidden',webConnected || desktop?.offline);
  const cached = (history?.participants || []).some(member => cachedEntry(member.id));
  $('room-recovery').textContent = webConnected ? '成员恢复入口 ↗' : cached ? '复制已有恢复入口 ↗' : '查看恢复方式 ↗';
  $('send-button').disabled = !webConnected || submitting;
  if (history?.room && !legacyId) renderMemberChips();
}
function renderMemberChips(participants = history?.participants || []) {
  participants=visibleMembers(participants);
  $('room-members').innerHTML = participants.length ? participants.map(member => { const status = memberStatus(member), observed = memberPresence(member); return `<button class="member-chip" data-member="${escape(member.id)}" title="${escape(`${member.name} · ${status.label} · ${observed.label}${observed.lastSeen ? ` · 最近响应 ${time(observed.lastSeen)}` : ''}${observed.canWake ? ' · 可以拉起工作会话' : ''}`)}">${avatar(member.name, member.adapter, member.appearance, member.id)}<span class="member-chip-name">${escape(member.name)}</span>${currentSecretary().member_id === member.id ? '<small class="secretary-inline-badge">秘书</small>' : ''}<i class="member-dot ${member.verified_at ? observed.status : 'pending'}"></i><small class="member-presence-label">${escape(member.verified_at ? observed.label : member.status === 'connection_failed' ? '接入失败' : '未接通')}</small></button>`; }).join('') : '<span class="members-empty">你在这里 · 等待其他成员加入</span>';
}
function renderResume() {
  const memberId = $('resume-member').value, member = memberById(memberId) || {}, entry = cachedEntry(memberId);
  const observed = memberPresence(member);
  $('resume-member-state').innerHTML = `<span class="member-dot ${observed.status}"></span><strong>${escape(observed.label)}</strong><span>${observed.lastSeen ? `最近响应 ${escape(time(observed.lastSeen))}` : '尚无近期响应记录'}</span><small>${member.verified_at ? '身份已验证' : '身份待验证'}</small>`;
  $('resume-copy').disabled = entryBusy || (!webConnected && !entry);
  $('resume-member').disabled = entryBusy;
  $('resume-copy').textContent = entryBusy ? '正在生成…' : entry ? '复制恢复入口' : '生成并复制恢复入口';
  $('resume-code').textContent = entry?.prompt || '先生成这个成员的恢复入口，再交给它在原来的工具窗口中使用。';
  $('resume-file').textContent = entry?.file || '入口文件保存在本机共享目录。';
  $('resume-instance').textContent = entry?.instance_id || runtime?.instance_id || '';
  $('resume-offline-note').classList.toggle('hidden',webConnected);
  $('resume-wake').classList.toggle('hidden',!observed.canWake);
  $('resume-wake').disabled = !webConnected || entryBusy;
  $('resume-revoke').classList.toggle('hidden',!entry);
  $('resume-revoke').disabled = !webConnected || entryBusy;
}
function showResume(memberId = $('recipient').value) {
  const members = history?.participants || []; if (!members.length) { toast('先在房间里添加一个成员。'); return; }
  $('resume-member').innerHTML = members.map(member => `<option value="${escape(member.id)}">${escape(member.name)}</option>`).join('');
  $('resume-member').value = members.some(member => member.id === memberId) ? memberId : (!webConnected && members.find(member => cachedEntry(member.id))?.id) || members[0].id;
  renderResume(); if (!$('resume-dialog').open) $('resume-dialog').showModal();
}
async function copyResume(memberId, selectedRoom = roomId) {
  let entry = cachedEntry(memberId,selectedRoom);
  if (webConnected) { entry = await api('/api/resume/issue',{member_id:memberId,room_id:selectedRoom}); if (!entry.prompt || !entry.file) throw new Error('未返回完整恢复入口，请重试。'); saveEntry(entry,memberId,selectedRoom); }
  else if (!entry) throw new Error('处理程序当前未连接。已接入的 agent 可用原入口执行 room-ensure；新入口需要处理程序恢复后生成。');
  await navigator.clipboard.writeText(entry.prompt); toast('恢复入口已复制。交给这个成员，以后它可自行检查和恢复同一个房间。'); return entry;
}
async function api(path, input, method = input === undefined ? 'GET' : 'POST') {
  if (desktop?.offline) {
    if (input !== undefined || method !== 'GET') throw new Error('服务已关闭。请先开启服务，再发送消息或更改房间。');
    if (path === '/api/state') { desktopState = await desktop.command('state',roomId ? {room_id:roomId} : {}); return desktopState.snapshot || {projects:[],chat:{rooms:[],members:[]},discussions:[],approvals:[]}; }
    if (path.startsWith('/api/runtime')) return desktopState?.snapshot?.runtime || {};
    if (/^\/api\/chat\/rooms\/[^/]+$/.test(path)) {
      const selected = decodeURIComponent(path.split('/').at(-1));
      if (desktopState?.history?.room?.id !== selected) desktopState = await desktop.command('select_room',{room_id:selected});
      return desktopState?.history || {room:(state?.chat?.rooms || []).find(room => room.id === selected) || {id:selected,title:'聊天室'},participants:[],messages:[],approvals:[]};
    }
    if (path.startsWith('/api/team?')) {
      const selected = new URL(path,'http://agentroom.local').searchParams.get('room_id');
      if (desktopState?.team?.room_id !== selected) desktopState = await desktop.command('select_room',{room_id:selected});
      if (desktopState?.team?.room_id !== selected) throw new Error('暂未读取到这个房间的已保存协作记录。开启服务后可重新查看。');
      return desktopState.team;
    }
    if (path.startsWith('/api/onboarding/jobs')) return {jobs:[]};
    if (path.startsWith('/api/launch/state')) return {latest:null};
    throw new Error('关闭服务时仅可查看已保存的聊天室。开启服务后可查看连接细节。');
  }
  if (input !== undefined && !webConnected && desktopReady) throw new Error('本机服务未连接。请先开启或检查服务，再操作。');
  const options = {method, credentials:'same-origin',headers:input === undefined ? {} : {'Content-Type':'application/json'}, ...(input === undefined ? {} : {body:JSON.stringify(input)})};
  let response = await fetch(path,options);
  // Only an explicit 401 proves the request was rejected before processing.
  // A transport failure may have accepted a POST and must never be replayed.
  if (response.status === 401) {
    if (!authRenewal) authRenewal = fetch('/',{credentials:'same-origin',cache:'no-store',redirect:'error'}).then(result => { if (!result.ok) throw new Error('本机连接凭据更新未完成。'); }).finally(() => { authRenewal = null; });
    await authRenewal; response = await fetch(path,options);
    if (response.status === 401) throw new Error('本机连接尚未恢复，请使用成员入口检查原实例。');
  }
  const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || '操作失败'),{status:response.status,code:value.code,details:value.details}); return value;
}
function toast(text) { $('toast').textContent = text; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6000); }
async function action(fn) { try { return await fn(); } catch (error) { const networkFailure = /^(Failed to fetch|Load failed|NetworkError)/i.test(error.message || ''); if (networkFailure) {setWebConnected(false);checkDesktopTransport();} toast(networkFailure ? '本机处理程序未连接。已有成员入口可以恢复同一个房间。' : error.message); } }
function checkDesktopTransport() {
  if (!desktop || desktop.offline || desktopProbe) return;
  // This is an observation, never a retry of the failed message or a service start.
  desktopProbe=desktop.command('state',roomId ? {room_id:roomId} : {}).then(value=>{desktopState=value;desktopReady=true;renderService();}).catch(()=>{}).finally(()=>{desktopProbe=null;});
}
function memberById(id) { return state?.chat?.members?.find(member => member.id === id) || history?.participants?.find(member => member.id === id); }
function senderName(id) { return id === 'user' ? '你' : memberById(id)?.name || (id === 'system' ? '房间' : id || '成员'); }
function memberStatus(member) {
  if (member.status === 'connecting') return {label:'正在连接', tone:'connecting'};
  if (['failed','error','connection_failed'].includes(member.status)) return {label:'连接失败', tone:'error'};
  if (['offline','disconnected','expired'].includes(member.status)) return {label:'离线', tone:'offline'};
  if (['connected','online','verified','ready'].includes(member.status) && member.verified_at) return {label:'成员身份已验证', tone:'verified'};
  if (['busy','running'].includes(member.status) && member.verified_at) return {label:'成员正在处理消息', tone:'verified'};
  return {label:member.verified_at ? '已验证 · 待连接' : '等待成员确认', tone:'pending'};
}
function safeRaster(value) { return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value) && value.length < 180000 ? value : null; }
// Draft appearance as the office reads it: an unset accent stays automatic.
function draftLook(draft) { const look = {...draft}; if (look.accent === 'auto' || look.accent === undefined) delete look.accent; else look.accent = Number(look.accent); return look; }
function avatar(name, adapter = '', appearance, memberId) { const roster = history?.participants || state?.chat?.members || [], member = memberId ? roster.find(item => item.id === memberId) : !appearance && roster.find(item => item.name === name && item.adapter === adapter), look = appearance || member?.appearance; const image = window.AgentOfficeScene?.avatarSource?.({id:member?.id || memberId,name,adapter,appearance:look},undefined,member || memberId ? roster : undefined) || safeRaster(look?.avatar_data); return `<span class="agent-avatar ${adapter === 'codex' || adapter === 'native' ? 'codex-avatar' : /grok/.test(adapter) ? 'grok-avatar' : /claude/.test(adapter) ? 'claude-avatar' : /qwen/.test(adapter) ? 'qwen-avatar' : ''}">${image ? `<img src="${escape(image)}" alt="">` : escape(Array.from(name || '?')[0])}</span>`; }
// The top bar is the office window: its sky follows the same local time as the office scene.
function updatePhase(){try{const config=typeof sceneConfig==='function'?sceneConfig():{};const phase=window.AgentOfficeScene?.clockState?.(config.time_zone,config.time_mode)?.phase;if(phase)document.documentElement.dataset.phase=phase;}catch{}}
setInterval(updatePhase,60000);requestAnimationFrame(updatePhase);
function rememberSelection() { localStorage.setItem('agentroom-project', projectId || ''); localStorage.setItem('agentroom-chat-room', roomId || ''); }
async function refresh() {
  if (refreshing) { refreshAgain = true; return; } refreshing = true;
  try {
    state = await api('/api/state'); state.chat ||= {rooms:[],members:[]}; state.chat.rooms ||= []; state.chat.members ||= []; state.approvals ||= []; state.discussions ||= [];
    if (!state.projects.some(project => project.id === projectId)) projectId = state.projects[0]?.id || null;
    if (legacyId && !state.discussions.some(discussion => discussion.id === legacyId && discussion.project_id === projectId)) legacyId = null;
    if (!state.chat.rooms.some(room => room.id === roomId && room.project_id === projectId)) roomId = state.chat.rooms.find(room => room.project_id === projectId&&!room.archived)?.id || state.chat.rooms.find(room=>room.project_id===projectId)?.id || null;
    runtime = state.runtime || await api(`/api/runtime${roomId ? `?room_id=${encodeURIComponent(roomId)}` : ''}`); setWebConnected(!desktop?.offline);
    rememberSelection(); renderSidebar(); renderSettings();
    const project = state.projects.find(project => project.id === projectId); $('project-heading').textContent = project?.name || '你的协作空间';
    $('welcome').classList.toggle('hidden', Boolean(roomId || legacyId)); $('room').classList.toggle('hidden', !roomId && !legacyId);
    $('footer-status').textContent = desktop?.offline ? '服务已关闭 · 仍可查看本机历史' : state.exportError || (state.activeRequest || state.chat.activeMessages?.length ? '成员正在后台工作 · 可以离开这个页面' : '消息留在本机 · 按需查看');
    if (legacyId) { const selected = legacyId; const data = await api(`/api/discussions/${encodeURIComponent(selected)}`); if (selected === legacyId) { history = data; renderLegacy(project); } }
    else if (roomId) { const selected = roomId; const data = await api(`/api/chat/rooms/${encodeURIComponent(selected)}`); if (selected === roomId && !legacyId) { history = data; renderRoom(project); await refreshTeam(selected); } }
    else { history = null; $('discussion-heading').textContent = '让 agents 来这里碰面'; }
    if ($('member-dialog').open) renderExistingMembers();
    if ($('member-setup-dialog').open && selectedSetupMember) renderSetup();
    if ($('bridge-dialog').open) action(refreshBridge);
    renderRuntime(); renderLaunch(); renderInspector(); renderService(); action(refreshLaunch); action(refreshOnboarding); if ($('resume-dialog').open) renderResume(); if (!desktop?.offline && events?.readyState === EventSource.CLOSED) connectEvents();
  } catch (error) { setWebConnected(false); $('footer-status').textContent = '处理程序未连接 · 房间记录仍保存在磁盘'; throw error; }
  finally { refreshing = false; for(const resolve of refreshWaiters.splice(0))resolve(); if (refreshAgain) { refreshAgain = false; scheduleRefresh(); } }
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => action(refresh), 160); }
function roomListRow(room) {
  const selected=room.id===roomId&&!legacyId,preview=selected&&history?.messages?.length?(history.messages.at(-1).coordination?.title||plainMarkdown(history.messages.at(-1).text)).slice(0,42):room.archived?'已归档 · 历史与协作保留':'消息与成员保存在本机';
  return `<div class="room-list-row ${selected?'active':''}"><button class="room-button ${selected?'active':''}" data-room="${escape(room.id)}" title="${escape(room.title)}"><span class="room-list-icon">#</span><span class="room-list-content"><strong>${escape(room.title)}</strong><small>${escape(preview)}</small></span></button><button type="button" class="room-actions-button" data-room-actions="${escape(room.id)}" aria-label="管理房间 ${escape(room.title)}" title="房间管理">⋯</button></div>`;
}
function showRoomActions(id){const target=state?.chat?.rooms?.find(room=>room.id===id);if(!target||managingRoom)return;managedRoomId=id;$('room-actions-error').textContent='';renderRoomActions();$('room-actions-dialog').showModal();}
function renderRoomActions(){
  const target=state?.chat?.rooms?.find(room=>room.id===managedRoomId);if(!target)return;
  $('room-actions-name').textContent=target.title;$('room-actions-archive').textContent=target.archived?'恢复到常用列表':'归档房间';
  $('room-actions-archive').disabled=managingRoom||!webConnected;$('room-actions-delete').disabled=managingRoom||!webConnected;
  $('room-actions-note').textContent=webConnected?'归档只收起列表，历史、成员入口和已有协作继续保留；删除会使原入口失效。':'本机服务未连接。归档和删除入口仍在这里，开启服务后可操作。';
  $('room-actions-start').classList.toggle('hidden',webConnected||!desktop);$('room-actions-start').disabled=desktopBusy;
}
async function toggleRoomArchive(){
  const id=managedRoomId,target=state?.chat?.rooms?.find(room=>room.id===id);if(!target||managingRoom||!webConnected)return;
  const restore=target.archived===true;managingRoom=true;renderRoomActions();
  try{const result=await api(`/api/chat/rooms/${encodeURIComponent(id)}/${restore?'restore':'archive'}`,{});if(result.archived!==!restore)throw Error('归档结果尚未确认，请刷新列表核对。');$('room-actions-dialog').close();managedRoomId=null;await refresh();toast(restore?'房间已恢复到常用列表。':'房间已归档，历史与已有协作保留。');}
  catch(error){$('room-actions-error').textContent=error.message;}
  finally{managingRoom=false;renderRoomActions();}
}
function renderSidebar() {
  $('projects').innerHTML = state.projects.length ? state.projects.map(project => `<button class="project-button ${project.id === projectId ? 'active' : ''}" data-project="${escape(project.id)}">${escape(project.name)}</button>`).join('') : '<div class="sidebar-empty">添加一个项目开始</div>';
  const rooms = state.chat.rooms.filter(room => room.project_id === projectId);
  const activeRooms=rooms.filter(room=>!room.archived),archivedRooms=rooms.filter(room=>room.archived);$('rooms').innerHTML=activeRooms.length?activeRooms.map(roomListRow).join(''):'<div class="sidebar-empty">暂无常用房间</div>';$('archived-rooms-list').innerHTML=archivedRooms.map(roomListRow).join('');$('archived-rooms-count').textContent=String(archivedRooms.length);$('archived-rooms').classList.toggle('hidden',!archivedRooms.length);if(archivedRooms.some(room=>room.id===roomId))$('archived-rooms').open=true;
  const old = state.discussions.filter(discussion => discussion.project_id === projectId); $('legacy-section').classList.toggle('hidden', !old.length); $('legacy-count').textContent = old.length ? String(old.length) : '';
  $('discussions').innerHTML = old.map(discussion => `<button class="discussion-button ${discussion.id === legacyId ? 'active' : ''}" data-discussion="${escape(discussion.id)}" title="${escape(discussion.title)}">${escape(discussion.title)}</button>`).join('');
  if (desktop?.offline) $('discussions').querySelectorAll('button').forEach(button => {button.disabled=true;button.title='开启服务后可查看旧讨论';});
}
async function loadDeletePreview(id) {
  deletePreview=null;$('delete-room-confirm').disabled=true;$('delete-room-confirm').textContent='读取任务…';
  const preview=await api(`/api/chat/rooms/${encodeURIComponent(id)}/deletion`);
  if(deleteRoomId!==id||!$('delete-room-dialog').open)return;
  deletePreview=preview;
  $('delete-room-blockers').innerHTML=(preview.total?`<p>确认后将停止以下 ${preview.total} 项本房间工作：</p>`:'<p>当前没有未完成任务。</p>')+preview.tasks.map(item=>`<div class="delete-blocker"><span><strong>${escape(item.name)}</strong> · ${escape(labels[item.status]||({connecting:'接入握手中',creating:'正在创建工作记录',waiting:'等待中',active:'进行中',preparing:'准备中',pending:'排队中',creation_uncertain:'创建结果待核对',outcome_uncertain:'执行结果待核对',resume_uncertain:'恢复结果待核对'})[item.status]||item.status)}<br>${escape(item.title||'')}</span></div>`).join('')+(preview.external_warning?`<p class="error-note">${escape(preview.external_warning)}</p>`:'');
  $('delete-room-confirm').textContent=preview.total?'停止任务并删除聊天室':'删除聊天室';$('delete-room-confirm').disabled=false;
}
async function showDeleteRoom(id) {
  const target=state?.chat?.rooms?.find(room=>room.id===id);
  if(!target||!webConnected||deletingRoom)return;
  deleteRoomId=id;$('delete-room-name').textContent=target.title;
  $('delete-room-error').textContent='';$('delete-room-blockers').replaceChildren();
  $('delete-room-dialog').showModal();
  try{await loadDeletePreview(id);}catch(error){if(deleteRoomId===id)$('delete-room-error').textContent=error.message;}
}
async function confirmDeleteRoom() {
  const id=deleteRoomId;if(!id||deletingRoom||deletePreview?.room_id!==id)return;
  deletingRoom=true;$('delete-room-confirm').disabled=true;$('delete-room-confirm').textContent='正在停止并删除…';$('delete-room-error').textContent='';
  try {
    const result=await api(`/api/chat/rooms/${encodeURIComponent(id)}`,{force:true,confirmation_token:deletePreview.confirmation_token},'DELETE');
    if(result.status!=='deleted')throw new Error('删除结果尚未确认，请检查聊天室列表。');
    resumeEntries=Object.fromEntries(Object.entries(resumeEntries).filter(([,entry])=>entry.room_id!==id));
    localStorage.setItem(entryCacheKey,JSON.stringify(resumeEntries));
    sceneDrafts.delete(id);secretaryDrafts.delete(id);textScroll.delete(id);
    for(const [key,job]of onboardingJobs)if(job.room_id===id)onboardingJobs.delete(key);
    if(roomId===id){roomId=null;history=null;setReply(null);$('prompt').value='';lastTimeline='';}
    if(launchSession?.room_id===id)launchSession=null;
    $('delete-room-dialog').close();deleteRoomId=null;
    await refresh();toast('聊天室已删除');
  } catch(error) {
    $('delete-room-error').textContent=/^(Failed to fetch|Load failed|NetworkError)/i.test(error.message||'')?'未确认删除结果，请先检查连接和房间列表。':error.message;
    if(['room_delete_tasks_changed','room_delete_confirmation_expired','room_busy'].includes(error.code)){try{await loadDeletePreview(id);}catch(refreshError){deletePreview=null;$('delete-room-error').textContent=refreshError.message;}}
  } finally {deletingRoom=false;$('delete-room-confirm').disabled=!deletePreview;$('delete-room-confirm').textContent=deletePreview?.total?'停止任务并删除聊天室':'删除聊天室';}
}
function renderSettings() {
  const codex = state.codex || {}, grok = state.grok || {}; $('codex-detail').textContent = codex.error || (codex.connected ? codex.signedIn ? '本机入口已连接' : '入口已连接，请核对登录与模型配置' : '检测本机安装与登录');
  if(codex.sessionMode==='isolated-background'&&codex.signedIn)$('codex-detail').textContent=codex.legacyVisibleCount?'后台会话已隔离 · 部分旧条目归档待核对':'后台会话独立保存 · 按需查看工作记录';
  if(codex.sessionMode==='isolated-background'&&codex.signedIn)$('codex-detail').textContent=codex.legacyVisibleCount?'后台会话已隔离 · 部分旧条目归档待核对':'后台会话独立保存 · 按需查看工作记录';
  $('grok-detail').textContent = grok.configured ? 'Webhook 已保存 · 回报另行验证' : '可选：房间主动通知 Grok'; $('grok-form').classList.toggle('hidden', grok.configured && !editingGrok); $('edit-grok').classList.toggle('hidden', !grok.configured); $('data-directory').textContent = state.dataDirectory || '';
  if (document.activeElement !== $('codex-path') && !$('codex-path').dataset.dirty) $('codex-path').value = codex.executable || '';
}
function renderRoom(project) {
  renderImageDrafts(); const room = history.room, participants = admittedMembers(history.participants), messages = history.messages || []; $('discussion-heading').textContent = room.title+(room.archived?' · 已归档':''); $('room-heading').textContent = room.title; $('room-eyebrow').textContent = 'LOCAL CHAT ROOM';
  $('room-subtitle').textContent = `${project?.name || room.project_name || ''} · ${participants.length} 位成员 · ${project?.access === 'workspace-write' ? '允许项目修改' : '默认仅查询资料'}`;
  $('native-thread').classList.toggle('hidden',!history.participants.some(m=>['codex','native'].includes(m.adapter)&&m.native_thread_id)); $('composer').classList.remove('hidden'); $('legacy-note').classList.add('hidden'); $('room-members-bar').classList.remove('hidden');
  renderMemberChips(participants);
  let selectedRecipient = roomRecipients.get(room.id);
  if (selectedRecipient === undefined || selectedRecipient && !participants.some(member => member.id === selectedRecipient)) selectedRecipient = messages.slice().reverse().find(message => message.sender_id === 'user' && participants.some(member => member.id === message.to_member_id))?.to_member_id || (participants.some(member => member.id === currentSecretary().member_id) ? currentSecretary().member_id : participants.length === 1 ? participants[0].id : '');
  $('recipient').innerHTML = '<option value="">房间公告</option>' + participants.map(member => `<option value="${escape(member.id)}">${escape(member.name)}</option>`).join(''); $('recipient').value = selectedRecipient; recipientRoom = room.id; updateRecipientNote();
  $('empty-room').classList.toggle('hidden', messages.length > 0); $('empty-heading').textContent = participants.length ? '把一个问题带到房间里' : '邀请第一个成员';
  $('empty-description').textContent = participants.length ? '选择一位成员，或在消息里 @它。\n成员的提问与回复会留在同一条时间线上。' : '添加成员，完成握手后，就可以在这里把问题交给它。\n每个成员拥有自己的身份和工作会话。';
  $('empty-add-member').classList.toggle('hidden', participants.length > 0); $('suggestions').classList.toggle('hidden', !participants.length);
  const typing = renderTyping(messages), signature = JSON.stringify([room.id,messages,participants.map(member=>[member.id,member.name,member.appearance]),state.chat?.activeMessages || [],typing]);
  if (signature !== lastTimeline) { const stream = $('chat-stream'), cached = textScroll.get(room.id), nearEnd = officeView ? cached?.atEnd !== false : stream.scrollHeight - stream.scrollTop - stream.clientHeight < 110, changedRoom = !lastTimeline.startsWith(`["${room.id}"`); $('messages').innerHTML = messages.map(message => renderMessage(message, messages)).join('') + typing; lastTimeline = signature; if(!officeView){if(nearEnd||changedRoom)stream.scrollTop=messages.length?stream.scrollHeight:0;rememberTextScroll();}else if(changedRoom)textScroll.set(room.id,{top:0,atEnd:true}); }
  renderApprovals(history.approvals || state.approvals.filter(approval => messages.some(message => message.request_id === approval.request_id)));
  renderService(); renderInspector(); renderSidebar(); applyRoomView(); updateOfficeScene();
}
function renderMessage(message, messages) {
  const name = message.coordination ? '办公室安排' : senderName(message.sender_id), member = memberById(message.sender_id), target = message.to_member_id ? senderName(message.to_member_id) : '', quoted = message.reply_to && messages.find(item => item.id === message.reply_to);
  if (['system','event'].includes(message.kind) || message.sender_id === 'system') return `<div class="system-message"><span>${escape(message.text)}</span><time>${time(message.created || message.created_at)}</time></div>`;
  const running = ['queued','creating','running','processing','waiting_input','pending','delivered'].includes(message.status);
  return `<article class="chat-message ${message.sender_id === 'user' && !message.coordination ? 'own-message' : ''}" id="message-${escape(message.id)}"><div class="message-header">${avatar(name, member?.adapter,member?.appearance)}<button type="button" class="message-sender" ${member ? `data-open-member="${escape(member.id)}"` : 'disabled'}>${escape(name)}</button>${target ? `<span class="message-target">→ ${escape(target)}</span>` : ''}<time>${time(message.created || message.created_at)}</time></div><div class="message-body">${quoted ? `<div class="quoted-message"><strong>${escape(senderName(quoted.sender_id))}</strong><span>${escape(quoted.coordination?.title || plainMarkdown(quoted.text))}</span></div>` : ''}${messageContent(message)}<div class="message-images">${messageImages(message)}</div>${message.progress ? `<div class="progress-note">${escape(message.progress)}</div>` : ''}${message.error ? `<div class="error-note">${escape(message.error)}</div>` : ''}<div class="message-footer">${message.status && !['posted','completed','answered'].includes(message.status) ? pill(message.status) : ''}${desktop?.offline ? '' : `${messageCanReconcile(message) ? `<button class="text-button" data-reconcile-message="${escape(message.id)}">核实结果并结案</button>` : ''}<button class="text-button reply-button" data-reply="${escape(message.id)}">回复</button>${running ? `<button class="text-button danger" data-cancel-message="${escape(message.id)}">停止等待</button>` : ''}`}</div></div></article>`;
}
function renderTyping(messages) {
  const states = {queued:'已排队，等待接手',pending:'等待接手',delivered:'已送达，等待接手',consumed:'已读取，等待回复',creating:'正在打开工作会话',running:'正在思考',processing:'正在思考',waiting_input:'在等你确认'};
  const active = new Set(state.chat?.activeMessages || []), approvals = history.approvals || [], replies = new Map(), owed = new Map();
  for (const message of messages) if (message.reply_to && ['reply','acknowledgment'].includes(message.kind)) { const senders = replies.get(message.reply_to) || new Set(); senders.add(message.sender_id); replies.set(message.reply_to,senders); }
  for (const message of messages) {
    if (!message.to_member_id || !states[message.status] || replies.get(message.id)?.has(message.to_member_id)) continue;
    // A read message nobody answered for half an hour is not "typing"; its own footer still shows the status.
    if (message.status === 'consumed' && Date.now() - Date.parse(message.updated || message.created || 0) > 30 * 60e3) continue;
    const priority = message.status === 'waiting_input' ? 3 : ['processing','running','creating'].includes(message.status) ? 2 : 1;
    if (priority >= (owed.get(message.to_member_id)?.priority || 0)) owed.set(message.to_member_id,{message,priority});
  }
  return [...owed].map(([memberId,{message}]) => {
    const member = memberById(memberId); if (!member || !history.participants.some(person => person.id === memberId)) return '';
    let label = states[message.status], busy = ['creating','running','processing'].includes(message.status), needsYou = message.status === 'waiting_input';
    if (!webConnected) { label = '本机服务未连接'; busy = false; needsYou = true; }
    else if (busy && !active.has(message.id)) { label = '处理状态待核对'; busy = false; needsYou = true; }
    else if (needsYou && !approvals.some(approval => approval.request_id === message.id || message.request_id && approval.request_id === message.request_id)) label = '确认状态待核对';
    // Desktop clients only act when someone types in their own window, so say so instead of implying they will pick it up.
    else if (member.manual_wake && ['queued','pending','delivered'].includes(message.status)) { label = `${label} · 它不会自己接手，请到它的窗口里说「用 AgentOffice 查看我的收件箱」`; needsYou = true; }
    return `<div class="typing-row${busy ? ' busy' : ''}${needsYou ? ' needs-you' : ''}" data-typing-member="${escape(memberId)}" role="status">${avatar(member.name,member.adapter,member.appearance,member.id)}<div class="typing-bubble"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${escape(member.name)} · ${escape(label)}</span></div></div>`;
  }).join('');
}
// One-line previews (sidebar, quotes) show the words, not the markup.
function plainMarkdown(text) {
  return String(text||'').replace(/```[\w+-]*\n?/g,' ').replace(/`([^`]*)`/g,'$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm,'').replace(/(\*\*|__|~~)(.+?)\1/g,'$2').replace(/\s+/g,' ').trim();
}
function inlineMarkdown(text) {
  const escaped=escape(text),code=[];let marker='\u0000';
  while(escaped.includes(marker))marker+='\u0000';
  const protectedText=escaped.replace(/(`+)(.*?)\1(?!`)/g,(_,fence,content)=>{code.push(`<code>${content}</code>`);return marker+(code.length-1)+marker;});
  const formatted=protectedText.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/(^|[\s(（])\*([^*\n]+)\*(?=[\s).,，。!?！？)]|$)/g,'$1<em>$2</em>').replace(/~~([^~\n]+)~~/g,'<del>$1</del>').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,'<span class="md-link" title="$2">$1</span>');
  return formatted.replace(new RegExp(marker+'(\\d+)'+marker,'g'),(_,index)=>code[Number(index)]);
}
// Agents answer in Markdown. Everything is escaped before the small, inert subset below is
// applied: no raw HTML, no images and no navigable links (the desktop shell blocks new windows).
function renderMarkdown(text) {
  const out=[],lines=String(text||'').replace(/\r\n?/g,'\n').split('\n');let list=null,paragraph=[];
  const flush=()=>{if(paragraph.length){out.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);paragraph=[];}if(list){out.push(`</${list}>`);list=null;}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i],fence=line.match(/^\s*```\s*([\w+-]*)/);
    if(fence){flush();const code=[];while(++i<lines.length&&!/^\s*```/.test(lines[i]))code.push(lines[i]);out.push(`<pre class="md-code"${fence[1]?` data-lang="${escape(fence[1])}"`:''}><code>${escape(code.join('\n'))}</code></pre>`);continue;}
    const heading=line.match(/^\s{0,3}(#{1,6})\s+(.*)$/),bullet=line.match(/^\s*[-*+]\s+(.*)$/),ordered=line.match(/^\s*\d+[.)]\s+(.*)$/),quote=line.match(/^\s*>\s?(.*)$/);
    if(!line.trim()){flush();continue;}
    if(heading){flush();out.push(`<h${Math.min(6,heading[1].length+2)} class="md-heading">${inlineMarkdown(heading[2])}</h${Math.min(6,heading[1].length+2)}>`);continue;}
    if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)){flush();out.push('<hr>');continue;}
    if(bullet||ordered){const kind=bullet?'ul':'ol';if(paragraph.length||list!==kind){flush();out.push(`<${kind}>`);list=kind;}const item=(bullet||ordered)[1],task=item.match(/^\[([ xX])\]\s+(.*)$/);out.push(task?`<li class="md-task"><span class="md-check">${task[1]===' '?'☐':'☑'}</span>${inlineMarkdown(task[2])}</li>`:`<li>${inlineMarkdown(item)}</li>`);continue;}
    if(quote){flush();out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);continue;}
    if(list){out.push(`</${list}>`);list=null;}
    paragraph.push(line);
  }
  flush();return out.join('');
}
function messageContent(message) {
  if (!message.coordination) return `<div class="message-content markdown">${renderMarkdown(message.text)}</div>`;
  return `<div class="coordination-summary"><strong>${escape(message.coordination.title || '团队协作安排')}</strong><button type="button" class="text-button" data-open-team>查看协作进度 ↗</button></div><details class="coordination-original"><summary>查看实际委托与诊断信息</summary><pre class="message-content">${escape(message.text)}</pre></details>`;
}
function messageCanReconcile(message) { return ['uncertain','outcome_uncertain','consumed'].includes(message.status) && !(state?.chat?.activeMessages || []).includes(message.id) && !(['reply','acknowledgment'].includes(message.kind) && message.status === 'consumed'); }
function renderLegacy(project) {
  const discussion = history.discussion; $('discussion-heading').textContent = discussion.title; $('room-heading').textContent = discussion.title; $('room-eyebrow').textContent = 'SAVED DISCUSSION'; $('room-subtitle').textContent = `${project?.name || ''} · 之前保存的讨论`;
  $('room-members-bar').classList.add('hidden'); $('composer').classList.add('hidden'); $('legacy-note').classList.remove('hidden'); $('empty-room').classList.toggle('hidden', history.requests.length > 0); $('empty-heading').textContent = '这段讨论还没有消息'; $('empty-description').textContent = '可以创建聊天室，邀请更多成员一起交流。'; $('empty-add-member').classList.add('hidden'); $('suggestions').classList.add('hidden');
  $('native-thread').classList.toggle('hidden', !discussion.thread_id);
  $('messages').innerHTML = history.requests.map(request => `<article class="exchange"><div class="message-header">${avatar(request.sender === 'user' ? '你' : request.sender)}<strong>${escape(request.sender === 'user' ? '你' : request.sender)}</strong><time>${time(request.created)}</time></div><pre class="message-content">${escape(request.prompt)}</pre><div class="message-header">${avatar(request.recipient, request.recipient)}<strong>${escape(request.recipient)}</strong>${pill(request.status)}</div><pre class="message-content">${escape(request.answer || request.progress || '')}</pre>${request.error ? `<div class="error-note">${escape(request.error)}</div>` : ''}${request.delivery ? `<div class="delivery-line">${pill(request.delivery.status)}${request.delivery.answer ? `<pre>${escape(request.delivery.answer)}</pre>` : ''}</div>` : ''}</article>`).join('');
  lastTimeline = ''; renderApprovals(state.approvals.filter(approval => history.requests.some(request => request.id === approval.request_id)));
  applyRoomView();
}
function renderApprovals(approvals) {
  const signature = JSON.stringify([roomId,legacyId,approvals]); if (signature === lastApprovalSignature) return; lastApprovalSignature = signature;
  $('approval-panel').innerHTML = approvals.map(approval => `<div class="approval-card" data-approval="${escape(approval.id)}"><h3>${['input','form'].includes(approval.type) ? '成员需要补充信息' : '成员需要你的确认'}</h3>${approval.reason ? `<p>${escape(approval.reason)}</p>` : ''}${approval.command ? `<pre>${escape(approval.command)}</pre>` : ''}${approval.type === 'url' && approval.url ? `<a class="secondary" href="${escape(approval.url)}" target="_blank" rel="noreferrer">在对应服务完成确认 ↗</a>` : ''}${approval.type === 'input' ? (approval.questions || []).map(question => `<label>${escape(question.question)}<input data-question="${escape(question.id)}" placeholder="填写回答"></label>`).join('') : ''}${approval.type === 'form' ? Object.entries(approval.schema?.properties || {}).map(([key,property]) => `<label>${escape(property.title || property.description || key)}${property.type === 'boolean' ? `<input type="checkbox" data-form-field="${escape(key)}" data-field-type="boolean">` : `<input data-form-field="${escape(key)}" data-field-type="${escape(property.type || 'string')}" ${/password|secret|token|key/i.test(key) ? 'type="password"' : ''} placeholder="${property.enum ? escape(property.enum.join(' / ')) : '填写内容'}">`}</label>`).join('') : ''}<div class="actions">${approval.type === 'input' ? `<button class="primary" data-input-submit="${escape(approval.id)}">提交回答</button>` : approval.type === 'form' ? `<button class="primary" data-form-submit="${escape(approval.id)}">提交表单</button><button class="secondary" data-approve="${escape(approval.id)}" data-decision="decline">取消</button>` : `<button class="primary" data-approve="${escape(approval.id)}" data-decision="accept">${approval.type === 'url' ? '已完成，继续' : '允许这次操作'}</button><button class="secondary" data-approve="${escape(approval.id)}" data-decision="decline">不允许</button>`}</div></div>`).join('');
  updateOfficeApprovalAlert();
}
function showProject() { $('project-dialog').showModal(); }
function showRoom(prefill = '') { if (!projectId) { toast('先添加一个项目，让成员有共同的工作范围。'); showProject(); return; } $('room-project-label').textContent = `项目：${state.projects.find(project => project.id === projectId)?.name || ''}`; $('room-name').value = prefill; $('room-dialog').showModal(); $('room-name').focus(); }
function showSettings() { $('settings-dialog').showModal(); }
async function showMembers() { $('member-room-label').textContent = roomId && !legacyId ? `加入「${history?.room?.title || state.chat.rooms.find(room => room.id === roomId)?.title || '聊天室'}」` : '创建房间后可以邀请成员加入。需要发现本机工具时，点击扫描。'; selectedCandidate = null; $('member-name').value = ''; $('member-adapter').value = 'mailbox'; $('member-dialog').showModal(); renderExistingMembers(); if (candidates.length) renderCandidates(); else $('discovered-agents').innerHTML = '<div class="scan-note">点击扫描本机 agents，或直接添加通用通信成员。</div>'; }
async function scanAgents() {
  $('scan-agents').disabled = true; $('discovered-agents').innerHTML = '<div class="scan-note"><span class="pulse-dot"></span> 正在发现本机安装与运行进程…</div>';
  try { const result = await api('/api/chat/discover'); candidates = result.candidates || []; renderCandidates(); }
  catch (error) { $('discovered-agents').innerHTML = `<div class="setup-note">${escape(error.message)}<br>你仍可添加通用通信成员。</div>`; }
  finally { $('scan-agents').disabled = false; }
}
function renderCandidates() {
  const adapters = new Set(['mailbox', ...candidates.map(candidate => candidate.adapter)]), previous = $('member-adapter').value;
  $('member-adapter').innerHTML = Array.from(adapters).filter(Boolean).map(adapter => `<option value="${escape(adapter)}">${escape(adapter === 'mailbox' ? '通用 MCP / 本机命令' : candidates.find(candidate => candidate.adapter === adapter)?.name || adapter)}</option>`).join(''); if (adapters.has(previous)) $('member-adapter').value = previous;
  $('discovered-agents').innerHTML = candidates.length ? candidates.map(candidate => `<button type="button" class="candidate-card ${candidate.id === selectedCandidate ? 'selected' : ''}" data-candidate="${escape(candidate.id)}" ${candidate.support === 'unsupported' ? 'disabled' : ''}>${avatar(candidate.name,candidate.adapter)}<div><strong>${escape(candidate.name)}</strong><span>${candidate.support === 'unsupported' ? `${candidate.running || candidate.installed ? '已发现' : '未发现本机安装'} · 接口待接入` : candidate.id === 'mailbox' ? '通用接入' : candidate.running ? '进程正在运行 · 通信另行验证' : candidate.installed ? '已安装' : '未发现本机安装'}${candidate.setup_note ? ` · ${escape(candidate.setup_note)}` : ''}</span></div><span class="candidate-check">${candidate.support === 'unsupported' ? '—' : candidate.id === selectedCandidate ? '✓' : '＋'}</span></button>`).join('') : '<div class="setup-note">暂未发现可直接连接的工具。可以添加通用成员，再把接入说明交给你的 agent。</div>';
}
function selectCandidate(id) { const candidate = candidates.find(item => item.id === id); if (!candidate || candidate.support === 'unsupported') return; selectedCandidate = id; $('member-name').value = candidate.name || ''; $('member-adapter').value = candidate.adapter || 'mailbox'; $('candidate-note').textContent = candidate.setup_note || (candidate.adapter === 'codex' || candidate.adapter === 'native' ? '会在后台创建独立工作会话，发送握手并验证回复。' : '会生成这个成员的专属通信说明。需要目标工具加载配置并确认接入。'); renderCandidates(); }
let workRecordSequence=0;
async function loadWorkRecord(){
  const sequence=++workRecordSequence; $('work-record-content').replaceChildren();
  if(desktop?.offline){$('work-record-note').textContent='服务已关闭。开启服务后可在此读取完整记录，也可让助手使用 work-record 命令只读查看。';return;}
  const query=legacyId?`discussion_id=${encodeURIComponent(legacyId)}`:`room_id=${encodeURIComponent(roomId)}&member_id=${encodeURIComponent($('work-record-member').value)}`;
  $('work-record-note').textContent='正在读取已有记录…';
  try{const record=await api('/api/work-record?'+query);if(sequence!==workRecordSequence||!$('work-record-dialog').open)return;
    const labels={agentMessage:'成员回答',userMessage:'收到的任务',commandExecution:'命令与结果',mcpToolCall:'工具调用',fileChange:'文件变更',webSearch:'检索记录'};
    $('work-record-note').textContent=`${record.member_name} · ${record.turns.length} 轮工作 · 只读记录`;
    const statuses={completed:'已完成',failed:'失败',interrupted:'已停止',inProgress:'处理中'};
    $('work-record-content').innerHTML=record.turns.map((turn,index)=>`<section class="work-record-turn"><strong>第 ${index+1} 轮工作 · ${escape(statuses[turn.status]||'状态待核对')}</strong>${turn.items.map(item=>`<details><summary>${escape(labels[item.type]||item.type)}</summary><pre>${escape(item.text??JSON.stringify(item,null,2))}</pre></details>`).join('')}</section>`).join('')||'<p>会话已保存，尚无完成的工作轮次。</p>';
  }catch(error){if(sequence===workRecordSequence)$('work-record-note').textContent=error.message;}
}
function showWorkRecord(){
  const members=(history?.participants||[]).filter(m=>['codex','native'].includes(m.adapter)&&m.native_thread_id);
  $('work-record-member-label').classList.toggle('hidden',!!legacyId);
  $('work-record-member').innerHTML=members.map(m=>`<option value="${escape(m.id)}">${escape(m.name)}</option>`).join('');
  if(!legacyId&&!members.length)return;
  $('work-record-dialog').showModal();loadWorkRecord();
}
$('native-thread').onclick=showWorkRecord;
$('work-record-member').onchange=loadWorkRecord;
function renderExistingMembers() { const joined = new Set(legacyId ? [] : history?.participants?.map(member => member.id) || []), available = state.chat.members.filter(member => !joined.has(member.id)); $('existing-members-section').classList.toggle('hidden', !available.length); $('existing-members').innerHTML = available.map(member => { const status = memberStatus(member); return `<button type="button" class="existing-member" data-join-member="${escape(member.id)}">${avatar(member.name,member.adapter)}<span><strong>${escape(member.name)}</strong><small>${escape(status.label)}</small></span><span>加入 ↗</span></button>`; }).join(''); }
async function connectMember(id, knownMember) { if (!roomId || legacyId) throw new Error('先创建或打开一个聊天室。'); await api(`/api/chat/rooms/${encodeURIComponent(roomId)}/join`, {member_id:id}); await refresh(); $('member-dialog').close(); if ((memberById(id) || knownMember)?.adapter === 'grok-bridge') { await showBridge(id); return; } const result = await api(`/api/chat/members/${encodeURIComponent(id)}/connect`, {room_id:roomId}); await refresh(); selectedSetupMember = id; setupData = result; renderSetup(); if (!$('member-setup-dialog').open) $('member-setup-dialog').showModal(); }
async function showMemberSetup(id) { if (!webConnected) return showResume(id); if (memberById(id)?.adapter === 'grok-bridge') return showBridge(id); selectedSetupMember = id; $('member-grok-key').value = ''; $('member-grok-url').value = ''; setupData = await api(`/api/chat/members/${encodeURIComponent(id)}/setup?room_id=${encodeURIComponent(roomId)}`); renderSetup(); $('member-setup-dialog').showModal(); }
function setupText(value) { if (typeof value === 'string') return value; if (value == null) return ''; return JSON.stringify(value,null,2); }
function instructionsText(data) { const member = memberById(selectedSetupMember) || data.member || {}; return setupText((member.adapter === 'grok-bridge' && data.bridgeInstructions) || data.instructions || data.invite?.instructions || (typeof data.invite === 'string' ? data.invite : '')); }
// One clear way to connect, chosen by what this client can actually do.
function renderConnectGuide(client, member) {
  const box = $('member-connect-guide'); $('member-durable-card').classList.toggle('hidden', !!client);
  if (!client) { box.innerHTML = ''; return; }
  if (client.kind === 'error') { box.innerHTML = `<div class="error-note">${escape(client.error)}</div>`; return; }
  const verified = !!member.verified_at, fields = client.fields ? `<dl class="connect-fields">${Object.entries(client.fields).map(([key,value]) => `<dt>${escape(key)}</dt><dd><code>${escape(value)}</code></dd>`).join('')}</dl>` : '';
  box.innerHTML = `<h3>${escape(client.title)}</h3><ol class="connect-steps">${client.steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol>${fields}${client.copy ? `<div class="connect-actions"><button type="button" class="primary" data-copy-guide>${escape(client.copy_label || '复制')}</button><span class="connect-state">${verified ? '已完成首次接入 · 更换房间无需重配' : '导入后实际调用工具才算接通'}</span></div><details class="setup-block"><summary>查看 MCP 设置配置</summary><pre class="setup-code">${escape(client.copy)}</pre></details>` : ''}${client.bootstrap ? `<div class="connect-actions"><button type="button" class="secondary" data-copy-bootstrap>复制连接人物说明</button><span class="small-note">发到这位同事的 AI 对话，只需一次</span></div><details class="setup-block"><summary>查看连接人物说明</summary><pre class="setup-code">${escape(client.bootstrap)}</pre></details>` : ''}${client.note ? `<p class="small-note">${escape(client.note)}</p>` : ''}`;
}
function renderSetup() {
  const member = memberById(selectedSetupMember) || setupData?.member || {}, status = memberStatus(member), data = setupData || {}, instructions = instructionsText(data), mcp = data.mcp, isBridge = member.adapter === 'grok-bridge';
  const observed = memberPresence(member);
  $('member-runtime-status').innerHTML = `<span class="member-dot ${observed.status}"></span><strong>${escape(observed.label)}</strong><span>${observed.lastSeen ? `最近响应 ${escape(time(observed.lastSeen))}` : '尚无近期响应记录'}</span>${observed.canWake ? '<small>可拉起后台工作会话</small>' : ''}`;
  const signature = JSON.stringify([selectedSetupMember,member.name,member.status,member.error,member.verified_at,data.error,data.invite,instructions,mcp]); if (signature === lastSetupSignature) return; lastSetupSignature = signature;
  const needsInvite = !['codex','native'].includes(member.adapter) && !member.verified_at && !data.invite;
  $('member-setup-heading').textContent = member.name ? `连接 ${member.name}` : '连接成员'; $('member-setup-status').innerHTML = `<span class="member-dot ${status.tone}"></span><strong>${escape(status.label)}</strong>${member.verified_at ? `<span>验证于 ${time(member.verified_at)}</span>` : ''}`;
  $('bridge-webhook-section').classList.toggle('hidden', member.adapter !== 'grok-bridge');
  renderConnectGuide(data.client, member);
  $('member-setup-content').innerHTML = `${member.error || data.error ? `<div class="error-note">${escape(member.error || data.error)}</div>` : ''}${status.tone === 'connecting' ? '<p class="setup-note"><span class="pulse-dot"></span> 正在后台询问成员并验证通信。你可以关闭这个窗口，连接结果会更新到成员列表。</p>' : ''}${instructions && !data.client ? `<details class="setup-block"><summary>兼容接入说明</summary><div class="setup-block-heading"><strong>${isBridge ? '桥接 Bot 协作说明' : '旧邀请 / 原生握手说明'}</strong><button class="secondary" data-copy-setup="instructions">复制说明</button></div><pre class="setup-code">${escape(instructions)}</pre></details>` : ''}${mcp && !data.client ? `<details class="setup-block"><summary>MCP 配置</summary><button class="secondary" data-copy-setup="mcp">复制配置</button><pre class="setup-code">${escape(setupText(mcp))}</pre></details>` : ''}${!instructions && !mcp && status.tone !== 'connecting' ? `<p class="setup-note">${member.verified_at ? '身份已验证。使用上方恢复入口可以继续访问这个房间。' : '长期接入请复制上方恢复入口，由成员在自己的窗口实际进入。'}</p>` : ''}${isBridge ? '<div class="bridge-note"><strong>把房间带进 Grok 群聊</strong><p>在 Grok 中添加一个桥接 Bot，把上面的说明交给它，再邀请它加入你的群聊。它负责把问题带到 AgentRoom，并把成员回复带回群聊。长期入口与原群回传分别验证，发现窗口或保存 Webhook 不代表已经接通群聊。</p></div>' : ''}`;
  if (needsInvite && !data.client) { const note = document.createElement('p'); note.className = 'small-note'; note.textContent = '下方保留兼容邀请方式。长期接入请使用上方“复制恢复入口”，无需每次重新领取邀请。'; $('member-setup-content').prepend(note); const copyButton = $('member-setup-content').querySelector('[data-copy-setup="instructions"]'); if (copyButton) copyButton.textContent = '生成兼容邀请'; }
  $('retry-member-connect').textContent = status.tone === 'connecting' ? '连接中…' : needsInvite ? '生成兼容邀请' : '重新验证连接'; $('retry-member-connect').classList.toggle('hidden', !!data.client && data.client.kind !== 'background'); $('retry-member-connect').disabled = status.tone === 'connecting'; $('leave-member').classList.toggle('hidden', !roomId || legacyId);
}
function updateRecipientNote() { if (recipientRoom === roomId) roomRecipients.set(roomId,$('recipient').value); const target = memberById($('recipient').value), observed = target && memberPresence(target); $('recipient-note').textContent = target ? observed.canWake ? `交给 ${target.name} · 可按需拉起工作会话` : ['online','worker_online'].includes(observed.status) ? `交给 ${target.name} · ${observed.label}` : `消息会保留 · ${target.name} ${observed.label}` : '公告会保存到房间，不自动唤醒成员'; }
function setReply(message) { replyTo = message?.id || null; $('reply-preview').classList.toggle('hidden', !message); if (message) { $('reply-to-name').textContent = `回复 ${senderName(message.sender_id)}`; $('reply-to-text').textContent = plainMarkdown(message.text); if (message.sender_id !== 'user' && history.participants?.some(member => member.id === message.sender_id)) $('recipient').value = message.sender_id; updateRecipientNote(); if(document.body.classList.contains('office-view'))toggleOfficeComposer(true);else $('prompt').focus(); } updateOfficeComposerPresentation(); }
function mentionedMember(text) {
  const named = admittedMembers(history?.participants).filter(member => text.toLocaleLowerCase().startsWith('@' + member.name.toLocaleLowerCase()) && /^(?:\s|[，。,:：!?！？]|$)/u.test(text.slice(member.name.length + 1))).sort((a,b) => b.name.length - a.name.length);
  if (!named.length) return null;
  const matches = named.filter(member => member.name.length === named[0].name.length);
  if (matches.length > 1) { const selected = matches.find(member => member.id === $('recipient').value); if (selected) return selected; throw new Error('房间里有同名成员，请在收件人列表中选定要交给哪一位。'); }
  return matches[0];
}
function moveMention(step) { const buttons = [...$('mention-choices').querySelectorAll('[data-mention]')]; if (!buttons.length) return; mentionIndex = (mentionIndex + step + buttons.length) % buttons.length; buttons.forEach((button,index) => button.classList.toggle('active',index === mentionIndex)); }
function renderMentions() { mentionIndex = 0; const text = $('prompt').value.slice(0,$('prompt').selectionStart), match = text.match(/@([^\s@]*)$/u), members = match ? admittedMembers(history?.participants).filter(member => member.name.toLowerCase().includes(match[1].toLowerCase())) : []; $('mention-choices').classList.toggle('hidden', !members.length); $('mention-choices').innerHTML = members.map((member,index) => `<button type="button" class="${index ? '' : 'active'}" data-mention="${escape(member.id)}">${avatar(member.name,member.adapter,member.appearance,member.id)}<span>@${escape(member.name)}</span></button>`).join(''); }
function installDesktopChrome() {
  if (!desktop) return;
  const card = document.createElement('section'); card.id = 'desktop-service'; card.className = 'desktop-service'; card.setAttribute('aria-label','协作服务');
  card.innerHTML = '<div class="service-status-heading"><span id="service-dot" class="service-dot"></span><strong id="service-label">正在检查服务</strong><span class="service-local-label">本机</span></div><p id="service-detail">房间与消息保存在这台电脑。</p><button id="service-toggle" type="button" class="secondary" disabled>检查状态</button><small>关窗口后，服务继续运行</small>';
  document.querySelector('.sidebar-footer').before(card);
  const alert = document.createElement('div'); alert.id = 'desktop-offline-banner'; alert.className = 'desktop-offline-banner hidden'; alert.setAttribute('role','status');
  alert.innerHTML = '<span>服务已关闭，你仍可查看本机历史。</span><button id="offline-start-service" class="text-button">开启服务，继续交流 ↗</button>';
  document.querySelector('.content').prepend(alert);
  $('service-toggle').onclick = () => action(() => desktopState?.update_available || desktop?.offline || !webConnected ? changeService('start_service') : showServiceStop());
  $('offline-start-service').onclick = () => action(() => changeService('start_service'));
  $('service-stop-confirm').onclick = () => action(() => changeService('stop_service'));
  document.querySelector('.local-indicator').innerHTML = '<i id="top-service-dot"></i><span id="top-service-label">本机服务</span>';
}
function currentServiceBusy() {
  const details = desktopState?.busy || {};
  return details.is_busy === true || !!state?.activeRequest || !!state?.chat?.activeMessages?.length || !!state?.approvals?.length || Object.values(state?.activeSetup || {}).some(Number) || (state?.chat?.members || []).some(member => member.status === 'connecting');
}
function renderService() {
  const readOnly = !webConnected;
  renderRoomActions();
  document.querySelectorAll('[data-delete-room]').forEach(button=>{button.disabled=readOnly;});
  for (const id of ['add-project','add-room','mobile-add-project','mobile-add-room','launch-add-project','welcome-project','welcome-room','welcome-members','room-member-add','empty-add-member','inspector-add-member','send-button','attach-image','image-input','prompt','recipient','scan-agents','onboarding-refresh','launch-refresh']) {
    const control = $(id); if (!control) continue;
    if (readOnly && !control.disabled) {control.dataset.serviceBlocked='true';control.disabled=true;}
    else if (!readOnly && control.dataset.serviceBlocked === 'true') {control.disabled=false;delete control.dataset.serviceBlocked;}
  }
  if (!desktop) return;
  const running = webConnected, busy = currentServiceBusy();
  $('service-label').textContent = desktopBusy ? '正在更新服务…' : running ? busy ? '服务运行中 · 工作进行中' : '服务运行中' : desktopReady ? '服务已关闭' : '正在检查服务';
  $('service-detail').textContent = running ? '消息可处理，成员可按需协作。' : '历史与成员已保留；开启后继续交流。';
  $('service-dot').classList.toggle('online',running); $('service-dot').classList.toggle('busy',running && busy);
  $('service-toggle').disabled = desktopBusy || !desktopReady;
  $('service-toggle').textContent = desktopBusy ? '请稍候…' : running ? '关闭服务' : '开启服务';
  if(desktopState?.update_available){$('service-label').textContent='后台版本待更新';$('service-detail').textContent=`后台 ${desktopState.snapshot?.version||'旧版本'} · 软件 ${desktopState.client_version}。${busy?'当前工作结束后再更新。':'更新后接入修复才会生效。'}`;$('service-toggle').textContent='更新后台';$('service-toggle').disabled=desktopBusy||!desktopReady||busy;}
  $('desktop-service').querySelector('small').textContent=running ? '关窗口后，服务继续运行' : '关窗口不会删除房间';
  $('top-service-label').textContent = running ? busy ? '成员正在工作' : '服务运行中' : '历史浏览';
  $('top-service-dot').classList.toggle('stopped',!running);
  const footer = document.querySelector('.sidebar-footer'); footer.querySelector('.local-dot').classList.toggle('stopped',!running); footer.querySelector('span:not(.local-dot)').textContent='记录保存在这台电脑';
  $('desktop-offline-banner').classList.toggle('hidden',running);
  $('offline-start-service').disabled = desktopBusy || !desktopReady;
  $('composer').classList.toggle('read-only',readOnly);
  $('prompt').placeholder = readOnly ? '开启协作服务后，就可以继续发送消息…' : '说点什么…选择成员，或 @成员 提问';
}
async function showServiceStop() {
  desktopState = await desktop.command('state',roomId ? {room_id:roomId} : {}); desktopReady = true;
  const busy = typeof desktopState?.busy?.is_busy === 'boolean' ? desktopState.busy.is_busy : currentServiceBusy();
  $('service-stop-detail').textContent = busy ? '当前有消息处理、授权或接入任务。请先在聊天室完成或停止这些工作，再关闭服务。' : '关闭窗口会保留服务；只有此按钮会关闭处理服务。';
  $('service-stop-confirm').disabled = busy; $('service-stop-dialog').showModal(); renderService();
}
async function changeService(operation) {
  if (!desktop || desktopBusy) return; desktopBusy = true; renderService();
  try {
    desktopState = await desktop.command(operation,roomId ? {room_id:roomId} : {}); desktopReady = true;
    if ($('service-stop-dialog').open) $('service-stop-dialog').close();
    if (operation === 'stop_service') {events?.close();setWebConnected(false);toast('服务已关闭，房间和消息仍保留。');}
    else toast('正在打开协作服务…');
  } finally {desktopBusy=false;renderService();}
}
function applyInspector() {
  const visible = inspectorOpen && professionalView;
  $('room-inspector').classList.toggle('hidden',!visible); document.body.classList.toggle('inspector-open',visible);
  $('inspector-toggle').setAttribute('aria-expanded',String(visible)); $('inspector-toggle').setAttribute('aria-label',visible ? '关闭房间详情' : '打开房间详情');
  document.querySelectorAll('[data-inspector-tab]').forEach(button => {const active=button.dataset.inspectorTab===inspectorTab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));});
  document.body.classList.toggle('team-inspector-open',visible && inspectorTab === 'team');
  for(const tab of ['team','members','info','connections','appearance','scene']) $('inspector-'+tab+'-page').classList.toggle('hidden',tab!==inspectorTab);
}
function openInspector(tab='members',memberId) {
  inspectorOpen=true;inspectorTab=tab;
  if(memberId && inspectorMemberId!==memberId) {inspectorMemberId=memberId;appearanceDraft=null;appearanceDirty=false;appearanceUploadVersion++;}
  applyInspector();renderInspector();
}
function selectRoomView(office) {
  if(legacyId || !roomId) return;
  if(!officeView)rememberTextScroll();
  officeView=!!office;localStorage.setItem('agentoffice-room-view',officeView?'office':'chat');applyRoomView();updateOfficeScene();
  if(!officeView){const saved=textScroll.get(roomId);if(saved)requestAnimationFrame(()=>{const stream=$('chat-stream');stream.scrollTop=saved.atEnd?stream.scrollHeight:saved.top;});}
}
// Late layout (fonts, images, code blocks, the composer growing) must not strand the reader
// above the newest message: while they were at the end, keep them there.
let stickToEnd=true;
if(typeof ResizeObserver==='function'){const stick=new ResizeObserver(()=>{if(officeView||!stickToEnd)return;const stream=$('chat-stream');stream.scrollTop=stream.scrollHeight;});requestAnimationFrame(()=>{for(const id of ['messages','chat-stream','composer'])if($(id))stick.observe($(id));});}
function rememberTextScroll(){if(!roomId||officeView||$('chat-stream').classList.contains('hidden'))return;const stream=$('chat-stream');const atEnd=stream.scrollHeight-stream.scrollTop-stream.clientHeight<110;stickToEnd=atEnd;textScroll.set(roomId,{top:stream.scrollTop,atEnd});}
function applyRoomView() {
  const available=professionalView && !!history?.room && !legacyId, visual=available && officeView;
  $('view-switch').classList.toggle('hidden',!available);$('chat-stream').classList.toggle('hidden',visual);$('officeScene').classList.toggle('hidden',!visual);
  $('chat-view-button').classList.toggle('active',!visual);$('office-view-button').classList.toggle('active',visual);
  $('chat-view-button').setAttribute('aria-pressed',String(!visual));$('office-view-button').setAttribute('aria-pressed',String(visual));
  $('room').classList.toggle('office-view',visual);document.body.classList.toggle('office-view',visual);
  updateOfficeComposerPresentation();updateOfficeApprovalAlert();renderSecretary();
}
function updateOfficeComposerPresentation() {
  const visual=document.body.classList.contains('office-view'), expanded=visual && officeComposerOpen;
  document.body.classList.toggle('office-composer-open',expanded);$('room').classList.toggle('office-composer-open',expanded);
  $('composer').inert=visual && !expanded;
  if(visual)$('composer').setAttribute('aria-hidden',String(!expanded));else $('composer').removeAttribute('aria-hidden');
  $('office-composer-close').classList.toggle('hidden',!visual);$('office-compose-launch').classList.toggle('hidden',!visual || expanded);
  $('office-compose-launch').setAttribute('aria-expanded',String(expanded));
  const hasDraft=!!$('prompt').value.trim() || !!replyTo || !!pendingSubmission || !!draftImages().length;
  $('office-compose-launch').textContent=hasDraft?'继续消息 ↗':'发消息 ↗';
  updateOfficeKeyboardInset();
}
function updateOfficeKeyboardInset() {
  const viewport=window.visualViewport, writing=document.body.classList.contains('office-composer-open') && $('composer').contains(document.activeElement);
  const inset=viewport && writing?Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop):0;
  document.documentElement.style.setProperty('--office-keyboard-inset',`${inset>100?Math.round(inset):0}px`);
}
function toggleOfficeComposer(open=!officeComposerOpen) {
  officeComposerOpen=!!open;updateOfficeComposerPresentation();
  if(document.body.classList.contains('office-view')) {
    if(officeComposerOpen)requestAnimationFrame(()=>$('prompt').disabled?$('office-composer-close').focus():$('prompt').focus());
    else {$('mention-choices').classList.add('hidden');$('office-compose-launch').focus();}
  }
}
function updateOfficeApprovalAlert() {
  const count=$('approval-panel').querySelectorAll('[data-approval]').length;
  $('office-approval-alert').classList.toggle('hidden',!document.body.classList.contains('office-view') || !count);
  $('office-approval-alert').textContent=`${count} 项需要确认 ↗`;
}
function currentSecretary(selectedRoom = roomId) {
  return state?.secretaries?.[selectedRoom] || {room_id:selectedRoom,member_id:null,status:'unassigned',name:null,can_wake:false};
}
function secretaryMember(selected = currentSecretary()) { return (history?.room?.id === roomId ? history.participants || [] : []).find(member => member.id === selected.member_id); }
function secretaryTutorialVisible() {
  if (!roomId || legacyId || !history?.room || !professionalView) return false;
  return secretaryOpenRoom === roomId || (!admittedMembers(history.participants).length && !secretaryDismissed.has(roomId));
}
function secretaryHasReply(selected) {
  // A processing status or a handshaken member is not a secretary response.
  return Boolean(selected.member_id && selected.request_id && (selected.response_ids || []).some(id => (history?.messages || []).some(message => message.id === id && message.sender_id === selected.member_id)));
}
function secretaryStatusText(selected = currentSecretary()) {
  if (!selected.member_id) return selected.request_id ? '未指定秘书 · 原委托保留在消息中' : '尚未选择秘书';
  if (!webConnected) return '服务已关闭 · 角色与消息已保存';
  if (selected.status === 'awaiting_connection') return '等待真实接通';
  if (selected.status !== 'ready') return '当前不可用 · 可以更换或检查连接';
  if (secretaryHasReply(selected)) return '已回应';
  if (selected.request_id) {
    if (selected.message_status === 'failed') return '委托未完成 · 查看消息详情';
    if (selected.message_status === 'cancelled') return '委托已停止 · 可在消息中交代新的委托';
    if (['uncertain','outcome_uncertain'].includes(selected.message_status)) return '结果待核对 · 请查看原委托';
    if (selected.message_status === 'resolved') return '委托已核对结案';
    return selected.can_wake ? '已交代目标 · 等待回复' : '已投递 · 需在本人窗口领取';
  }
  return selected.can_wake ? '已接通 · 可后台处理' : '已接通 · 本人窗口领取消息';
}
function openSecretaryTutorial() {
  if (!roomId || legacyId) { showRoom(); return; }
  setProfessionalView(true); secretaryOpenRoom = roomId; secretaryError = ''; renderSecretary(); updateOfficeScene();
}
function closeSecretaryTutorial() {
  secretaryOpenRoom = null; secretaryDismissed.add(roomId);
  localStorage.setItem('agentoffice-secretary-dismissed',JSON.stringify([...secretaryDismissed])); renderSecretary(); updateOfficeScene();
}
function renderSecretary() {
  const panel = $('secretary-tutorial'); if (!panel) return;
  const available = !!roomId && !legacyId && history?.room?.id === roomId && professionalView, visible = available && secretaryTutorialVisible();
  panel.classList.toggle('hidden',!visible); $('secretary-room-entry').classList.toggle('hidden',!available || visible || document.body.classList.contains('office-view'));
  $('secretary-role-card').classList.toggle('hidden',!available);
  if (!available) return;
  const selected = currentSecretary(), member = secretaryMember(selected), members = admittedMembers(history.participants), ready = selected.status === 'ready' && !!member, replied = secretaryHasReply(selected), started = !!selected.request_id && !!selected.member_id;
  $('empty-room').classList.toggle('hidden',visible || (history.messages || []).length > 0);
  $('secretary-room-entry').textContent = selected.member_id ? `与 ${selected.name || member?.name || '秘书'} 协作 ↗` : '从 AI 秘书开始 ↗';
  $('secretary-title').textContent = selected.member_id ? `和 ${selected.name || member?.name || '你的秘书'} 一起组织办公室` : '先选一位 AI，当你的秘书';
  $('secretary-intro').textContent = selected.member_id ? '交代目标，秘书会按成员信息安排任务，并跟进交付与验收。' : '让它先了解你的目标，帮你梳理工作，再接入需要的其他 AI。';
  $('secretary-step-list').innerHTML = ['选择秘书','交代目标','一起组织成员'].map((text,index) => `<li class="${index === (replied ? 2 : selected.member_id ? 1 : 0) ? 'current' : index < (replied ? 2 : selected.member_id ? 1 : 0) ? 'done' : ''}"><span>${index + 1}</span>${text}</li>`).join('');
  $('secretary-choose').classList.toggle('hidden',!!selected.member_id && secretaryPickingRoom !== roomId);
  $('secretary-member-options').innerHTML = members.length ? members.map(value => {
    const knownReady = value.status === 'ready' && !!value.verified_at, presence = memberPresence(value);
    return `<button type="button" class="secretary-candidate" data-secretary-select="${escape(value.id)}" ${secretaryBusy || !webConnected ? 'disabled' : ''}>${avatar(value.name,value.adapter,value.appearance)}<span><strong>${escape(value.name)}</strong><small>${escape(knownReady ? presence.canWake ? '已接通 · 可后台处理' : '已接通 · 本人窗口领取' : '待接通 · 可先指定')}</small></span><span class="secretary-candidate-arrow">＋</span></button>`;
  }).join('') : `<p class="secretary-no-members">${visibleMembers(history?.participants).length ? `有 ${visibleMembers(history?.participants).length} 位成员还没接通。接通后就能选它当秘书；点房间顶部的成员头像查看怎么连接。` : '办公室还没有成员。接入一位你常用的 AI，再选择它当秘书。'}</p>`;
  $('secretary-add-ai').textContent = members.length ? '＋ 接入另一位 AI' : '接入一位 AI ↗'; $('secretary-add-ai').disabled = !webConnected || secretaryBusy;
  $('secretary-selected').classList.toggle('hidden',!selected.member_id || secretaryPickingRoom === roomId);
  $('secretary-selected-person').innerHTML = selected.member_id ? `${avatar(selected.name || member?.name || 'AI',member?.adapter || '',member?.appearance)}<div><strong>${escape(selected.name || member?.name || 'AI 秘书')}</strong><span>${escape(secretaryStatusText(selected))}</span></div><button type="button" class="text-button" data-secretary-change ${secretaryBusy || secretaryStartBusy || !webConnected ? 'disabled' : ''}>更换</button>` : '';
  $('secretary-connection-note').textContent = !webConnected ? '开启本机服务后，可以选择秘书和交代目标。当前仅查看已保存的记录。' : selected.member_id && !ready ? '角色已保存，通信尚未接通。目标可以先写好，接通后再点「让秘书开始」。' : ready && !selected.can_wake ? '这位秘书使用信箱模式。你交代目标后，它需要在自己的窗口领取并回答。' : ready ? '点击开始后，会保存协作目标并交给秘书组织。' : '每次只接入你选择的 AI，秘书会和你讨论成员及分工。';
  const stored = secretaryDrafts.get(roomId);
  if ($('secretary-goal').dataset.room !== roomId) { $('secretary-goal').dataset.room = roomId; $('secretary-goal').value = stored?.value ?? selected.goal ?? secretaryDefaultGoal; secretaryGoalVersion++; }
  else if (!stored?.dirty && selected.goal && document.activeElement !== $('secretary-goal')) $('secretary-goal').value = selected.goal;
  const settledGoal = started && ['failed','cancelled','uncertain','outcome_uncertain','resolved'].includes(selected.message_status) && $('secretary-goal').value.trim() === selected.goal;
  $('secretary-goal').disabled = !webConnected || secretaryStartBusy; $('secretary-goal').placeholder = ready ? '告诉秘书你想做什么' : '可以先写下目标；秘书接通后点「让秘书开始」。'; $('secretary-start').disabled = !ready || !webConnected || secretaryBusy || secretaryStartBusy || !$('secretary-goal').value.trim() || settledGoal;
  $('secretary-start').textContent = secretaryStartBusy ? '正在交代…' : settledGoal ? '请先查看原委托' : started ? '交代这个目标' : '让秘书开始 ↗';
  $('secretary-check-connection').classList.toggle('hidden',!selected.member_id || ready); $('secretary-check-connection').disabled = !webConnected || !member;
  $('secretary-reply').classList.toggle('hidden',!started); $('secretary-reply-label').textContent = replied ? '秘书已回应' : secretaryStatusText(selected);
  const response = [...(history.messages || [])].reverse().find(message => (selected.response_ids || []).includes(message.id) && message.sender_id === selected.member_id);
  $('secretary-reply-text').textContent = response?.text || (['uncertain','outcome_uncertain'].includes(selected.message_status) ? '执行结果尚不明确。请查看原委托并核实结果，再记录结案；再次点击同一目标不会重复执行。' : ['failed','cancelled','resolved'].includes(selected.message_status) ? '这条委托已结束。查看原消息了解结果，或与秘书讨论新的委托。' : selected.can_wake ? '回复会留在这个房间。你可以先查看办公室，稍后回来继续。' : '请到秘书自己的窗口领取任务，回答后这里会显示结果。');
  $('secretary-next-actions').classList.toggle('hidden',!selected.member_id);
  $('secretary-discuss').disabled = !ready || !webConnected; $('secretary-add-others').disabled = !webConnected; $('secretary-message-history').disabled = !selected.request_id;
  $('secretary-error').classList.toggle('hidden',!secretaryError); $('secretary-error').textContent = secretaryError;
  $('secretary-role-card').innerHTML = `<div class="secretary-role-heading"><span class="secretary-role-mark">✦</span><div><strong>${escape(selected.name || '办公室秘书')}</strong><small>${escape(secretaryStatusText(selected))}</small></div></div><p>${selected.member_id ? '梳理目标、安排任务并跟进交付。添加其他 AI 仍由你选择。' : '先选一位成员，和它一起组织这间办公室。'}</p><button type="button" class="secondary" data-secretary-open>${selected.member_id ? '管理秘书 / 查看教程' : '选择 AI 秘书'}</button>${selected.member_id ? `<button type="button" class="text-button" data-secretary-reset ${!webConnected || secretaryBusy ? 'disabled' : ''}>清除秘书角色</button>` : ''}`;
  $('secretary-role-card').classList.toggle('hidden',!roomId || !!legacyId);
  $('secretary-connect-status').textContent = !webConnected ? '服务未连接，请先开启本机服务。' : secretaryConnectRoom === roomId ? '先接通一位可后台回答的秘书；成功后自动进入办公室。' : '你已切换房间。关闭此页后，在目标房间重新接入。';
  $('secretary-scan-agents').disabled = !webConnected || launchScanning || secretaryConnectRoom !== roomId;
  $('secretary-connect-candidates').innerHTML = $('launch-candidates').innerHTML;
  $('secretary-connect-candidates').querySelectorAll('.launch-candidate').forEach(card=>{const provider=card.querySelector('[data-launch-provider]')?.dataset.launchProvider;card.classList.toggle('hidden',!['codex','claude-code','qwen-code','gemini-cli'].includes(provider));});
  $('secretary-connect-candidates').querySelectorAll('.launch-candidate-select').forEach(element=>element.remove());
  const attempt=onboardingJobs.get(secretaryConnectJob)||currentOnboardingJobs().find(job=>onboardingRunning(job))||currentOnboardingJobs()[0];
  $('secretary-connect-progress').innerHTML=attempt?onboardingJobMarkup(attempt):'';
  $('secretary-connect-candidates').querySelectorAll('button').forEach(button => { if(secretaryConnectRoom !== roomId||onboardingRunning(attempt)) button.disabled = true; });
  $('secretary-connect-progress').querySelectorAll('button').forEach(button => { if(secretaryConnectRoom !== roomId || !webConnected) button.disabled = true; });
  $('secretary-connect-error').textContent = launchError; $('secretary-connect-error').classList.toggle('hidden',!launchError);
}
function secretaryResponse(value, selectedRoom) {
  const selected = value?.secretary || value; if (!selected || selected.room_id !== selectedRoom) throw new Error('尚未确认秘书角色，请刷新查看。');
  // Mutation responses can arrive after another window changed the role.
  // Only /api/state is allowed to replace the canonical role snapshot.
  return selected;
}
function sameSecretaryAssignment(left,right) {
  return left?.room_id === right?.room_id && left?.member_id === right?.member_id && (left?.assignment_id || null) === (right?.assignment_id || null);
}
async function refreshSecretaryState() {
  // If an older refresh was already in flight before this mutation, wait for
  // it, then request a new authoritative state after the mutation completed.
  while(refreshing) await new Promise(resolve=>refreshWaiters.push(resolve));
  await refresh();
}
async function chooseSecretary(memberId) {
  if (secretaryBusy || secretaryStartBusy || !roomId || legacyId) return;
  const selectedRoom = roomId; secretaryBusy = true; secretaryError = ''; renderSecretary();
  try {
    const accepted = secretaryResponse(await api('/api/secretary',{room_id:selectedRoom,member_id:memberId}),selectedRoom); await refreshSecretaryState();
    if(roomId === selectedRoom && sameSecretaryAssignment(accepted,currentSecretary())){ secretaryOpenRoom = roomId; secretaryPickingRoom = null; toast('秘书角色已保存。准备好目标后，点击“让秘书开始”。'); }
    else if(roomId === selectedRoom) secretaryError = '秘书设置已在其他窗口变更，已显示最新角色。请重新确认。';
  }
  catch(error){ if(roomId === selectedRoom) secretaryError = error.message; throw error; }
  finally {secretaryBusy = false; renderSecretary(); updateOfficeScene();}
}
async function clearSecretary() {
  if(secretaryBusy || secretaryStartBusy || !roomId) return; const selectedRoom = roomId; secretaryBusy = true; renderSecretary();
  try {
    const selected = secretaryResponse(await api('/api/secretary',{room_id:selectedRoom,reset:true}),selectedRoom); await refreshSecretaryState();
    if(roomId === selectedRoom && sameSecretaryAssignment(selected,currentSecretary())){ secretaryOpenRoom = roomId; secretaryError = ''; toast(selected.request_id ? '秘书角色已清除，原委托仍在消息中。' : '秘书角色已清除，可以重新选择。'); }
    else if(roomId === selectedRoom) secretaryError = '秘书设置已在其他窗口变更，已显示最新角色。请重新确认。';
  }
  finally {secretaryBusy = false; renderSecretary(); updateOfficeScene();}
}
async function startSecretary() {
  const selected = currentSecretary(), selectedRoom = roomId, selectedMember = selected.member_id, selectedAssignment = selected.assignment_id, input = $('secretary-goal'), goal = input.value.trim(), version = secretaryGoalVersion;
  if(secretaryBusy || secretaryStartBusy || !selectedMember || selected.status !== 'ready' || !goal || !webConnected || goal.length > 4000) return;
  secretaryStartBusy = true; secretaryError = ''; renderSecretary();
  try {
    const result = await api('/api/secretary/start',{room_id:selectedRoom,goal,expected_member_id:selectedMember,expected_assignment_id:selectedAssignment}); const accepted = secretaryResponse(result,selectedRoom); await refreshSecretaryState();
    // Preserve drafts written after submit or in a different room. Do not clear the shared chat composer.
    const unchanged = roomId === selectedRoom && sameSecretaryAssignment(selected,currentSecretary()) && sameSecretaryAssignment(accepted,currentSecretary());
    if(unchanged && secretaryGoalVersion === version && input.value.trim() === goal) secretaryDrafts.set(selectedRoom,{value:goal,dirty:false});
    if(unchanged) toast('目标已交给秘书。只有真实回复到达后，才会显示“已回应”。');
    else if(roomId === selectedRoom) secretaryError = '秘书角色已在其他窗口变更。原委托保留在消息中，新的秘书尚未收到这个目标，请重新确认。';
  } catch(error) {
    if(error.code === 'secretary_selection_changed') {
      await refreshSecretaryState();
      if(roomId === selectedRoom) secretaryError = '秘书已在其他窗口变更。目标已保留，请确认当前秘书后再点击开始。';
      return;
    }
    if(roomId === selectedRoom) secretaryError = /^(Failed to fetch|Load failed|NetworkError)/i.test(error.message || '') ? '委托结果尚未确认，请先查看消息；同一目标再次开始会复用原委托。' : error.message; throw error;
  }
  finally {secretaryStartBusy = false; renderSecretary();}
}
function discussWithSecretary() {
  const selected = currentSecretary(); if (!webConnected || selected.status !== 'ready' || ![...$('recipient').options].some(option => option.value === selected.member_id)) return;
  closeSecretaryTutorial(); $('recipient').value = selected.member_id; updateRecipientNote(); if(officeView)toggleOfficeComposer(true); else $('prompt').focus();
}
function openSecretaryConnect() {
  if (!roomId || !webConnected) return; secretaryConnectRoom = roomId; secretaryConnectJob = null; secretaryError = ''; renderSecretary(); $('secretary-connect-dialog').showModal();
}
function updateOfficeScene() {
  if(!officeView || !professionalView || !history?.room || legacyId) return;
  if(!officeScene && window.AgentOfficeScene) officeScene=window.AgentOfficeScene.mount($('officeScene'),{onCompose:()=>toggleOfficeComposer(true),onChooseSecretary:openSecretaryTutorial,onSelectMember:member=>{if(!submitting && [...$('recipient').options].some(option=>option.value===member.id)){$('recipient').value=member.id;updateRecipientNote();}toggleOfficeComposer(true);},onCustomize:member=>openInspector('appearance',member.id),onSceneSettings:()=>openInspector('scene'),onSelectMessage:message=>{selectRoomView(false);requestAnimationFrame(()=>$('message-'+message.id)?.scrollIntoView({block:'center',behavior:'smooth'}));}});
  officeScene?.update({roomId:history.room.id,participants:admittedMembers(history.participants),messages:history.messages||[],runtime,online:webConnected,scene:state?.office?.[history.room.id]||{},secretary:currentSecretary(),tutorialVisible:secretaryTutorialVisible()});
}
function detailRows(values) {return values.map(([label,value])=>`<dt>${escape(label)}</dt><dd>${escape(value || '—')}</dd>`).join('');}
function doctorTarget() { return $('connection-doctor-old-member').value.trim() || $('connection-doctor-member').value || null; }
function doctorCurrent() { return connectionDoctor?.room?.requested_id === roomId && connectionDoctor?.target?.requested_member_id === doctorTarget() ? connectionDoctor : null; }
function doctorMember() { const id=doctorTarget(), current=doctorCurrent();return current ? current.target.joined ? (current.current_participants || []).find(member=>member.id===id) : null : (history?.room?.id===roomId?history.participants||[]:[]).find(member=>member.id===id); }
function diagnosticText(value){return String(value||'').replace(/crsr_[A-Za-z0-9_-]+/g,'[密钥已隐藏]').replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [密钥已隐藏]').replace(/https?:\/\/[^\s<>"']+/gi,'[地址已隐藏]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300);}
function doctorSummary(){
  const current=doctorCurrent();if(webConnected&&current)return current.summary;
  const room=history?.room?.id===roomId?history.room:null,members=room?history.participants||[]:[];
  return [`本机服务：${webConnected?'页面已连接，尚未诊断':'离线，查看已保存记录'}。`,room?`房间：${diagnosticText(room.title)}（${room.id}），已保存 ${members.length} 位成员。`:'房间：请先选择一个聊天室。',`Grok Windows 宿主和原生群工具：需要在 Grok 内核对。`,`通知 Webhook：${state?.grok?.configured?'已保存':'未保存或未核实'}，不能证明 Windows 宿主在线。`].join('\n');
}
function doctorLayer(title,status,detail,kind='unknown'){return `<article class="connection-doctor-layer ${kind}"><div><strong>${escape(title)}</strong><span>${escape(status)}</span></div><p>${escape(detail)}</p></article>`;}
function renderConnectionDoctor(){
  const select=$('connection-doctor-member');if(!select)return;
  if(connectionDoctorRoom!==roomId){connectionDoctorRoom=roomId;connectionDoctor=null;connectionDoctorError='';connectionDoctorSequence++;$('connection-doctor-old-member').value='';select.dataset.signature='';}
  const available=!!roomId&&!legacyId, snapshot=history?.room?.id===roomId?history:null;
  const members=connectionDoctor?.room?.requested_id===roomId?connectionDoctor.current_participants||[]:snapshot?.participants||[];
  const signature=JSON.stringify(members.map(member=>[member.id,member.name]));
  if(select.dataset.signature!==signature){const previous=select.dataset.signature?select.value:inspectorMemberId;select.innerHTML='<option value="">整个房间</option>'+members.map(member=>`<option value="${escape(member.id)}">${escape(member.name)}</option>`).join('');select.value=members.some(member=>member.id===previous)?previous:'';select.dataset.signature=signature;}
  $('connection-doctor-run').disabled=connectionDoctorBusy||!available||!webConnected;$('connection-doctor-run').textContent=connectionDoctorBusy?'检查中…':'检查连接';
  $('connection-doctor-member').disabled=!available||connectionDoctorBusy;$('connection-doctor-old-member').disabled=!available||connectionDoctorBusy;
  const current=doctorCurrent(), selected=doctorMember();
  $('connection-doctor-note').textContent=!available?'先选择一个聊天室，再核对它的连接。':!webConnected?'服务已关闭或未连接；这里只显示已保存记录，不会自动启动。':current?`本次只读检查 ${time(current.observed_at)}，不会刷新心跳或重新发问。`:'只查看当前房间的连接证据，不扫描、不重连。';
  let rows=[];
  if(!webConnected){rows=[doctorLayer('本机协作服务','离线','房间记录仍保存在本机。需要服务器的诊断暂不可用。','blocked'),doctorLayer('所选房间',snapshot?'已保存':'尚未选择',snapshot?`${snapshot.room.title} · 已保存 ${snapshot.participants?.length||0} 位成员。`:'请先从左侧选择聊天室。'),doctorLayer('Grok Windows 宿主','需在 Grok 核对','Agent Office 不能读取 Grok 注册电脑的连接状态。')];}
  else if(current){
    const target=current.target,entry=current.entry,credential={pending:'待本人接入',active:'有效',revoked:'已撤销',missing:'不存在',invalid:'无效',not_selected:'未选择'};
    rows=[doctorLayer('本机协作服务',current.local_service.online?'在线':'未核实',`当前实例 ${current.local_service.instance_id}。`,current.local_service.online?'observed':'blocked'),doctorLayer('所选房间',current.room.exists?'存在':'未找到',current.room.exists?`${current.room.title} · ${current.room.member_count} 位实际成员。`:'这个标识不在当前实例中，请核对原房间。',current.room.exists?'observed':'blocked'),doctorLayer('成员与长期入口',target.status==='missing_member'?'当前实例无此成员':target.joined?entry.credential_valid?'入口有效':'入口需核对':target.status==='not_selected'?'未选择':'未在本房间',target.detail+' '+(target.joined?`入口文件${entry.exists?'存在':'缺失'}，凭据${credential[entry.credential_status]||'待核对'}。`:''),target.joined&&entry.credential_valid?'observed':'blocked'),doctorLayer('Grok Windows 宿主','需在 Grok 核对',current.grok_windows_host.detail),doctorLayer('Grok 群与原生工具',current.grok_group.status==='host_reported'?'只有宿主报告':'需在 Grok 核对',current.grok_group.detail+(current.grok_group.reference_saved?' 本机保存过群引用。':' 尚未保存群引用。')),doctorLayer('通知 Webhook',current.grok_notification.status==='unavailable'?'无法读取':current.grok_notification.configured?'已配置':'未配置',current.grok_notification.detail)];
  }else rows=[doctorLayer('等待检查','只读','检查会区分本机服务、成员入口、Grok 宿主、原生群和通知。')];
  const contextOpen=$('connection-doctor-results').querySelector('.connection-doctor-context')?.open;
  $('connection-doctor-results').innerHTML=rows.join('')+(current&&webConnected?`<details class="connection-doctor-context" ${contextOpen?'open':''}><summary>当前本机位置</summary><dl>${detailRows([['实例',current.local_service.instance_id],['数据目录',current.local_service.data_directory],['房间',current.room.requested_id],['成员',current.target.requested_member_id]])}</dl></details>`:'');
  $('connection-doctor-error').textContent=connectionDoctorError;$('connection-doctor-error').classList.toggle('hidden',!connectionDoctorError);
  $('connection-doctor-copy').disabled=!available||connectionDoctorBusy;$('connection-doctor-select').classList.toggle('hidden',!current||current.target.joined||!members.length);
  $('connection-doctor-resume').disabled=!selected||connectionDoctorBusy;$('connection-doctor-setup').disabled=!selected||!webConnected||connectionDoctorBusy;
}
async function runConnectionDoctor(){
  if(connectionDoctorBusy||!roomId||legacyId||!webConnected)return;
  renderConnectionDoctor();
  const selectedRoom=roomId,member=doctorTarget(),sequence=++connectionDoctorSequence;connectionDoctorBusy=true;connectionDoctorError='';renderConnectionDoctor();
  try{const result=await api(`/api/connection/doctor?room_id=${encodeURIComponent(selectedRoom)}${member?'&member_id='+encodeURIComponent(member):''}`);if(sequence===connectionDoctorSequence&&selectedRoom===roomId&&member===doctorTarget())connectionDoctor=result;}
  catch(error){if(sequence===connectionDoctorSequence&&selectedRoom===roomId){connectionDoctorError=error.message;throw error;}}
  finally{connectionDoctorBusy=false;renderConnectionDoctor();}
}
function renderInspector() {
  if (!state) return;
  const room = history?.room || (state.chat?.rooms || []).find(item => item.id === roomId), members = visibleMembers(history?.participants), project = state.projects.find(item => item.id === projectId);
  $('inspector-room-name').textContent = room?.title || '你的协作空间'; $('inspector-project-name').textContent = project?.name || '选择一个项目，开始协作';
  if(!members.some(member=>member.id===inspectorMemberId)){inspectorMemberId=members[0]?.id||null;appearanceDraft=null;appearanceDirty=false;appearanceUploadVersion++;}
  $('inspector-members').innerHTML = members.length ? members.map(member => {const presence=memberPresence(member);return `<button type="button" class="inspector-member" data-inspector-member="${escape(member.id)}">${avatar(member.name,member.adapter,member.appearance)}<div><strong>${escape(member.name)}${currentSecretary().member_id === member.id ? ' <span class="secretary-inline-badge">秘书</span>' : ''}</strong><span><i class="member-dot ${presence.status}"></i>${escape(presence.label)}</span><small>${!member.verified_at ? (member.status === 'connection_failed' ? '接入失败，点开查看原因' : '还没接通，点开看怎么连接') : presence.canWake ? '发消息会自动开工' : '要在它自己的窗口里处理'}</small></div><span class="inspector-member-arrow">›</span></button>`;}).join('') + (staleMembers().length ? `<button type="button" class="text-button danger" id="cleanup-stale-members">清理 ${staleMembers().length} 个没接通的旧成员</button>` : '') : '<p class="inspector-empty">房间成员会显示在这里。<br>只接入你选择的 agent。</p>';
  const bridge = members.find(member => member.adapter === 'grok-bridge'), proxies=launchSession&&room?.id&&launchSession.room_id===room.id?launchSession.proxies||[]:[], linked = proxies.filter(proxy=>proxy.native_group_status==='host_reported').length || members.filter(member=>member.native_group_status==='host_reported').length, groupRef=proxies.find(proxy=>proxy.native_group_ref)?.native_group_ref || (launchSession&&room?.id&&launchSession.room_id===room.id?launchSession.native_sync?.group_ref:null);
  $('inspector-bridge-detail').textContent = bridge ? `已有 ${bridge.name} 桥接入口。群里的问题和成员回复可以回到同一房间。` : linked ? 'Grok 已报告加群。原群状态与本机通信分别记录。' : '给 Grok Bot 接入说明后，可以在你指定的群里与这些成员交流。';
  $('inspector-bridge').disabled = !webConnected;
  $('inspector-project-details').innerHTML=detailRows([['项目',project?.name],['文件夹',project?.path||room?.project_path],['访问权限',project?.access==='workspace-write'?'允许项目修改':'仅查询资料']]);
  $('inspector-room-details').innerHTML=detailRows([['房间',room?.title],['成员',String(members.length)+' 位'],['保存消息',String(history?.messages?.length||0)+' 条'],['房间标识',room?.id],['记录位置',state.dataDirectory],['服务',webConnected?'本机服务运行中':'服务未连接，查看本机记录']]);
  $('inspector-native-detail').textContent=groupRef ? `Grok 已报告群引用：${groupRef}。${linked} 位成员已报告加群，原群状态仍需核对；桥接的请求和回复保存在本机。` : linked ? `${linked} 位成员已报告加群。通过本机桥接投递的消息保留在这里。` : bridge ? `已配置 ${bridge.name}。完整 Grok 群消息暂不自动同步，桥接的请求与回复会留在本机。` : '还未绑定 Grok 群聊。可在连接页查看桥接入口。';
  const member=members.find(item=>item.id===inspectorMemberId), presence=member?memberPresence(member):null;
  $('inspector-selected-member').innerHTML=member?`${avatar(member.name,member.adapter,member.appearance)}<h3>${escape(member.name)}</h3><p>${escape(presence.label)} · ${escape(presence.canWake?'可按需后台处理':'本人窗口领取消息')}</p><p>${escape(memberStatus(member).label)}</p>`:'<p class="inspector-description">先在成员页选择一位成员。</p>';
  $('inspector-member-connect').disabled=!member||!webConnected;$('inspector-member-recovery').disabled=!member;
  renderAppearance(members,member);renderScene();applyInspector();renderSecretary();renderConnectionDoctor();renderTeam();
}
function teamValue(selectedRoom = roomId) { return teamRooms.get(selectedRoom); }
function teamName(id, value = teamValue()) { return (value?.cards || []).find(card => card.member_id === id)?.name || memberById(id)?.name || '未指定成员'; }
function teamReadable(value, data = teamValue()) { let result=String(value || ''); for(const item of [...(data?.tasks||[]),...(data?.goals||[]),...(data?.meetings||[]),...(data?.cards||[])]){const id=item.member_id || item.id;if(id)result=result.split(id).join(item.name || item.title || '相关记录');}return result; }
const teamStatuses = {active:'推进中',queued:'待接手',running:'进行中',blocked:'有阻碍',review:'待验收',completed:'已完成',cancelled:'已停止',uncertain:'结果待核对',failed:'未完成',collecting:'收集报告中',meeting_review:'待整理纪要'};
function teamStatus(value) { return `<span class="team-status ${escape(value)}">${escape(teamStatuses[value] || value || '待开始')}</span>`; }
function teamButton(label, kind, id = '', extra = '') { return `<button type="button" class="text-button" data-team-action="${escape(kind)}" data-team-id="${escape(id)}" ${extra} ${webConnected && !teamBusy ? '' : 'disabled'}>${escape(label)}</button>`; }
function teamText(value, className = 'team-description') { return value ? `<p class="${className}">${escape(value)}</p>` : ''; }
async function refreshTeam(selectedRoom = roomId) {
  if (!selectedRoom || legacyId) { renderTeam(); return; }
  if (teamRequests.has(selectedRoom)) return teamRequests.get(selectedRoom);
  const request = (async () => {
    try { const value = await api(`/api/team?room_id=${encodeURIComponent(selectedRoom)}`); if (value.room_id !== selectedRoom) throw new Error('协作记录的房间不匹配，请刷新。'); teamRooms.set(selectedRoom,value); if (roomId === selectedRoom) teamLoadError = ''; }
    catch (error) { if (roomId === selectedRoom) teamLoadError = error.message; }
    finally { teamRequests.delete(selectedRoom); if (roomId === selectedRoom) renderTeam(); }
  })(); teamRequests.set(selectedRoom,request); return request;
}
function renderTeam() {
  const root = $('team-content'); if (!root) return;
  if ($('team-dialog').open) $('team-submit').disabled = teamBusy || !webConnected;
  const valid = !!roomId && !legacyId, data = teamValue(), goals = data?.goals || [], tasks = data?.tasks || [], meetings = data?.meetings || [], cards = data?.cards || [];
  $('team-open').classList.toggle('hidden',!valid);
  const review = tasks.filter(task => ['review','blocked','uncertain','failed'].includes(task.status)).length;
  $('team-open').textContent = review ? `协作 · ${review} 项待查看` : '协作';
  const signature = JSON.stringify([roomId,valid,data,webConnected,teamBusy,teamLoadError]); if (signature === teamSignature) return; teamSignature = signature;
  const expanded = new Set([...root.querySelectorAll('details[open]')].map(item => item.dataset.teamDetails));
  if (!valid) { root.innerHTML = '<p class="inspector-empty">先打开一个聊天室，再组织这项工作。</p>'; return; }
  if (!data) { root.innerHTML = `<p class="inspector-description">${escape(teamLoadError || (webConnected ? '正在读取这间办公室的协作记录…' : '当前没有已读取的协作记录。开启服务后可查看。'))}</p>${webConnected ? teamButton('重新读取','refresh') : ''}`; return; }
  const completed = tasks.filter(task => task.status === 'completed').length, currentGoals = goals.filter(goal => goal.status === 'active');
  let html = `<div class="team-summary"><div><span class="team-kicker">这间办公室正在推进</span><strong>${currentGoals.length ? `${currentGoals.length} 个目标` : '从一个明确的目标开始'}</strong><p>${tasks.length ? `${completed} / ${tasks.length} 项任务已验收` : '把目标交给秘书，再把工作分给具体成员。'}</p></div>${teamButton('新目标','goal')}</div>`;
  if (!webConnected) html += '<p class="team-notice">服务未连接，显示本机已保存的协作记录。开启后可以继续更新。</p>';
  if (data.delivery_issues?.length) html += `<details class="team-notice"><summary>${data.delivery_issues.length} 项协作通知未确认送达</summary>${data.delivery_issues.map(issue=>teamText(teamReadable(issue.error || '发送结果待核对',data))).join('')}<p class="team-meta">请核对成员连接与原委托，再继续安排工作。</p></details>`;
  if (teamLoadError) html += `<p class="error-note">${escape(teamLoadError)}</p>${teamButton('重新读取','refresh')}`;
  const brief = data.brief || {};
  html += `<details class="team-section team-brief" data-team-details="brief" ${expanded.has('brief') ? 'open' : ''}><summary>共同简报 <small>${brief.version ? `第 ${Number(brief.version)} 版` : '尚未形成'}</small></summary>${teamText(teamReadable(brief.content,data) || '会议形成纪要后，这里发布团队共享的简报。')}<p class="team-meta">${escape(time(brief.updated_at))}</p>${cards.length && brief.version ? `<div class="team-acknowledgments">${cards.map(card => `<span>${escape(card.name)} · ${Number(card.ack_version) >= Number(brief.version) ? '已确认此版' : '尚未确认'}</span>`).join('')}</div>${teamButton('记录已确认','brief_ack')}` : ''}</details>`;
  html += '<section class="team-section"><div class="team-section-heading"><h3>目标与进度</h3></div>';
  html += goals.length ? goals.map(goal => { const work = tasks.filter(task => task.goal_id === goal.id), done = work.filter(task => task.status === 'completed').length; return `<article class="team-card"><div class="team-card-heading"><strong>${escape(goal.title)}</strong>${teamStatus(goal.status)}</div>${teamText(goal.description)}<p class="team-meta">验收要求：${escape(goal.acceptance || '尚未填写')}</p>${work.length ? `<progress max="${work.length}" value="${done}" aria-label="${escape(goal.title)} 的任务验收进度"></progress><p class="team-meta">${done} / ${work.length} 项任务已验收</p>` : '<p class="team-meta">尚未拆分任务</p>'}${teamText(goal.result || goal.note,'team-result')}<div class="team-actions">${goal.status === 'active' ? teamButton('拆分任务','task',goal.id) + teamButton('验收目标','complete_goal',goal.id) + teamButton('停止目标','cancel_goal',goal.id) : ''}</div></article>`; }).join('') : '<p class="team-empty">写下想交付什么，以及怎样判断完成。</p>';
  html += `</section><section class="team-section"><div class="team-section-heading"><h3>任务</h3>${teamButton('派发任务','task')}</div>`;
  html += tasks.length ? tasks.map(task => {
    const actions = ['completed','cancelled'].includes(task.status) ? '' : task.status === 'review' ? teamButton('验收通过','task_approve',task.id) + teamButton('退回完善','task_request_changes',task.id) : task.status === 'uncertain' ? (task.message_id ? teamButton('先核实执行消息','message_reconcile',task.message_id) : '') + teamButton('核验任务结果','task_reconcile',task.id) : ['blocked','failed'].includes(task.status) ? teamButton('补充要求并继续','task_request_changes',task.id) + (task.status === 'blocked' ? teamButton('提交验收','task_submit',task.id) : '') + teamButton('停止任务','task_cancel',task.id) : `${task.status === 'queued' ? teamButton('接手推进','task_accept',task.id) : teamButton('记录进展','task_progress',task.id)}${teamButton('提交验收','task_submit',task.id)}${teamButton('记录阻碍','task_block',task.id)}${teamButton('停止任务','task_cancel',task.id)}`;
    return `<article class="team-card team-task" data-task-status="${escape(task.status)}"><div class="team-card-heading"><strong>${escape(task.title)}</strong>${teamStatus(task.status)}</div><p class="team-owner">${escape(teamName(task.assignee_id,data))}${task.goal_id ? ` · ${escape(goals.find(goal => goal.id === task.goal_id)?.title || '所属目标')}` : ''}</p>${teamText(task.note)}${teamText(task.result,'team-result')}<details data-team-details="task-${escape(task.id)}" ${expanded.has('task-'+task.id) ? 'open' : ''}><summary>交付要求与依据</summary>${teamText(task.description)}<p class="team-meta">交付物：${escape(task.deliverable || '尚未填写')}</p><p class="team-meta">验收：${escape(task.acceptance || '尚未填写')}</p>${task.depends_on?.length ? `<p class="team-meta">等待：${escape(task.depends_on.map(id => tasks.find(item => item.id === id)?.title || '前置任务').join('、'))}</p>` : ''}${teamEvidence(task.evidence)}</details><div class="team-actions">${actions}</div></article>`;
  }).join('') : '<p class="team-empty">任务明确负责人、交付物和验收标准，提交后再验收。</p>';
  html += `</section><section class="team-section"><div class="team-section-heading"><h3>团队会议</h3>${teamButton('开会','meeting')}</div>`;
  html += meetings.length ? meetings.map(meeting => `<article class="team-card"><div class="team-card-heading"><strong>${escape(meeting.title)}</strong>${teamStatus(meeting.status === 'review' ? 'meeting_review' : meeting.status)}</div>${teamText(meeting.agenda)}<p class="team-meta">第 ${(Number(meeting.round) || 0) + 1} 轮 · ${meeting.deadline_at ? `报告截止 ${escape(time(meeting.deadline_at))}` : '等待成员报告'}</p>${meeting.missing_member_ids?.length ? `<p class="team-warning">待报告：${escape(meeting.missing_member_ids.map(id => teamName(id,data)).join('、'))}</p>` : ''}<details data-team-details="meeting-${escape(meeting.id)}" ${expanded.has('meeting-'+meeting.id) ? 'open' : ''}><summary>成员报告 · ${(meeting.reports || []).length}</summary>${(meeting.reports || []).map(report => `<div class="team-report"><strong>${escape(teamName(report.member_id,data))} · 第 ${(Number(report.round) || 0) + 1} 轮${report.late ? ' · 截止后提交' : ''}</strong>${teamText(report.summary)}${teamText(report.completed ? `已完成：${report.completed}` : '')}${teamText(report.blockers ? `阻碍：${report.blockers}` : '')}${teamText(report.next_steps ? `下一步：${report.next_steps}` : '')}${teamEvidence(report.sources)}</div>`).join('') || '<p class="team-empty">还没有收到报告。</p>'}</details>${teamText(meeting.summary,'team-result')}${meeting.decisions?.length ? `<ul class="team-decisions">${meeting.decisions.map(item => `<li>${escape(typeof item === 'string' ? item : item.text || item.summary || JSON.stringify(item))}</li>`).join('')}</ul>` : ''}<div class="team-actions">${meeting.status !== 'cancelled' ? teamButton('补充报告','meeting_report',meeting.id) + (meeting.status === 'review' ? ((Number(meeting.round) || 0) < 2 ? teamButton('追加讨论','meeting_discuss',meeting.id) : '') + teamButton('形成纪要','meeting_close',meeting.id) : '') : ''}</div></article>`).join('') : '<p class="team-empty">开会收集各成员的进展和阻碍，再形成纪要与后续任务。</p>';
  const schedule = data.schedule || {};
  html += `<div class="team-schedule"><div><strong>周期会议</strong><p class="team-meta">${schedule.enabled ? `每 ${Number(schedule.interval_hours)} 小时 · ${escape(schedule.timezone || '')}${schedule.next_run_at ? ` · 下次 ${escape(time(schedule.next_run_at))}` : ''}` : '未开启，按需开会'}</p>${teamText(typeof schedule.last_result === 'string' ? schedule.last_result : schedule.last_result?.summary,'team-meta')}</div>${teamButton('设置','schedule')}</div></section>`;
  html += `<details class="team-section" data-team-details="cards" ${expanded.has('cards') ? 'open' : ''}><summary>成员与窗口信息 <small>${cards.length} 位</small></summary><p class="team-meta">记录这个成员负责什么、掌握哪些资料。资料来源与更新时间会一起保留。</p>${cards.map(card => `<article class="team-card"><div class="team-card-heading"><strong>${escape(card.name)}</strong><span class="team-meta">${card.can_wake ? '可后台处理' : '本人窗口领取'}</span></div>${teamText(card.role || '尚未指定职责')}${card.skills?.length ? `<p class="team-skills">${card.skills.map(skill => `<span>${escape(skill)}</span>`).join('')}</p>` : ''}${teamText(card.information)}${teamEvidence(card.sources)}<p class="team-meta">${card.updated_at ? `更新于 ${escape(time(card.updated_at))}` : '尚未补充信息'}</p><div class="team-actions">${teamButton('编辑信息','card',card.member_id)}</div></article>`).join('') || '<p class="team-empty">接入成员后可以记录职责与资料。</p>'}</details>`;
  root.innerHTML = html;
}
function teamEvidence(items) { return (items || []).length ? `<ul class="team-evidence">${items.map(item => `<li>${escape(typeof item === 'string' ? item : [item.note || item.summary,item.reference || item.source,item.observed_at ? time(item.observed_at) : ''].filter(Boolean).join(' · '))}</li>`).join('')}</ul>` : ''; }
function teamInput(name, label, value = '', options = {}) {
  const required = options.required ? 'required' : '', max = options.max || 4000;
  return `<label for="team-field-${name}">${escape(label)}${options.select ? `<select id="team-field-${name}" name="${name}" ${required}>${options.select.map(item => `<option value="${escape(item.value)}" ${String(item.value) === String(value) ? 'selected' : ''}>${escape(item.label)}</option>`).join('')}</select>` : options.area ? `<textarea id="team-field-${name}" name="${name}" rows="${options.rows || 3}" maxlength="${max}" ${required}>${escape(value)}</textarea>` : `<input id="team-field-${name}" name="${name}" type="${options.type || 'text'}" value="${escape(value)}" maxlength="${max}" ${options.min ? `min="${options.min}"` : ''} ${options.maxNumber ? `max="${options.maxNumber}"` : ''} ${required}>`}</label>`;
}
function teamChecks(name, label, items, selected = []) { return `<fieldset class="team-checks" data-team-checks="${name}"><legend>${escape(label)}</legend>${items.map(item => `<label><input type="checkbox" name="${name}" value="${escape(item.value)}" ${selected.includes(item.value) ? 'checked' : ''}>${escape(item.label)}</label>`).join('') || '<p class="team-meta">暂无可选项</p>'}</fieldset>`; }
function openTeamDialog(kind, id = '') {
  if (!webConnected || !roomId || teamBusy) return;
  const data = teamValue() || {}, tasks = data.tasks || [], goals = data.goals || [], cards = data.cards || [], meetings = data.meetings || [];
  if (kind === 'goal' && !data.secretary_id) { inspectorOpen=false;applyInspector();openSecretaryTutorial();toast('先为这间办公室指定秘书，再交代团队目标。');return; }
  if (kind === 'task' && !goals.some(goal => goal.status === 'active')) { toast('先交代一个团队目标，再拆分任务。');openTeamDialog('goal');return; }
  const task = tasks.find(item => item.id === id), goal = goals.find(item => item.id === id), card = cards.find(item => item.member_id === id), meeting = meetings.find(item => item.id === id);
  const members = cards.map(item => ({value:item.member_id,label:item.name})), goalOptions = [{value:'',label:'独立任务 / 会议'},...goals.filter(item => item.status === 'active').map(item => ({value:item.id,label:item.title}))];
  teamDialog = {kind,id,room_id:roomId,version:task?.version ?? card?.version ?? goal?.version,key:crypto.randomUUID(),observed_at:new Date().toISOString()}; let title = '', note = '', fields = '', submit = '保存';
  const evidence = () => teamInput('evidence_note','核实依据 / 结果说明','',{area:true,required:true}) + teamInput('evidence_source','依据位置（文件、记录或实际检查入口）','',{required:true});
  if (kind === 'goal') { title='交代团队目标'; note='目标交给 '+teamName(data.secretary_id,data)+' 组织。'+(cards.find(card=>card.member_id===data.secretary_id)?.can_wake?'写清交付和验收要求，方便团队判断是否完成。':'这位秘书使用信箱模式，需在本人窗口领取目标后才能推进。'); fields=teamInput('title','目标名称','',{required:true,max:160})+teamInput('description','背景与范围','',{area:true})+teamInput('acceptance','怎样算完成','',{area:true,required:true}); submit='交给秘书'; }
  else if (kind === 'task') { title='派发任务'; fields=teamInput('goal_id','所属目标',goal?.id || goals.find(item=>item.status==='active')?.id || '',{select:goalOptions.slice(1),required:true})+teamInput('title','任务名称','',{required:true,max:160})+teamInput('assignee_id','负责人',members[0]?.value || '',{select:members,required:true})+teamInput('description','任务说明','',{area:true})+teamInput('deliverable','需要交付什么','',{required:true})+teamInput('acceptance','验收标准','',{area:true,required:true})+teamChecks('depends_on','前置任务',tasks.filter(item => item.status !== 'cancelled' && item.goal_id === (goal?.id || goals.find(value=>value.status==='active')?.id)).map(item => ({value:item.id,label:item.title}))); submit='派发任务'; }
  else if (kind.startsWith('task_') && task) { const operation=kind.slice(5), names={accept:'接手推进',progress:'记录进展',block:'记录阻碍',submit:'提交验收',approve:'验收通过',request_changes:'退回完善',cancel:'停止任务',reconcile:'核验任务结果'}; title=names[operation]; note=task.title; fields=teamInput('note',operation==='block'?'遇到什么阻碍':operation==='request_changes'?'需要完善什么':'处理说明','',{area:true,required:['block','request_changes','cancel','approve'].includes(operation)}); if(['submit','reconcile'].includes(operation))fields+=teamInput('result',operation==='reconcile'?'核实后的交付结果（留空表示已核实停止）':'交付结果',task.result || '',{area:true,required:operation==='submit'})+evidence(); if(operation==='approve')fields='<div class="team-result">'+escape(task.result || '请核查任务交付与来源')+'</div>'+teamEvidence(task.evidence)+fields; if(operation==='reconcile')note+='。请先核实实际结果；记录不会重跑任务，也不能代替实际停止执行。'; submit=title; }
  else if (kind === 'complete_goal' && goal) { title='验收目标'; note=goal.title; fields=teamInput('result','最终交付与验收结论',goal.result || '',{area:true,required:true})+evidence(); submit='记录验收完成'; }
  else if (kind === 'cancel_goal' && goal) { title='停止协作目标'; note='先完成或停止这个目标下的任务，并形成相关会议纪要。这里记录目标停止，不会替代实际任务的停止与结果核查。'; fields=teamInput('note','停止原因','',{area:true,required:true}); submit='记录目标停止'; }
  else if (kind === 'card' && card) { title=`${card.name} 的窗口信息`; fields=teamInput('role','负责什么',card.role || '',{required:true})+teamInput('skills','擅长事项（用逗号分隔）',(card.skills || []).join('，'))+teamInput('information','这个窗口掌握的项目资料',card.information || '',{area:true,rows:5})+teamInput('source','新增资料来源')+teamInput('source_note','来源说明'); }
  else if (kind === 'meeting') { title='召开团队会议'; note='向所选成员收集报告。信箱成员仍需在本人窗口领取，会议不会替代它们的唤醒能力。'; fields=teamInput('goal_id','围绕哪个目标','',{select:goalOptions})+teamInput('title','会议主题','进展与下一步',{required:true,max:160})+teamInput('agenda','议程与需要回答的问题','',{area:true,required:true})+teamChecks('participant_ids','参会成员',members,members.map(item => item.value))+teamInput('deadline_minutes','报告时限（分钟）',5,{type:'number',min:1,maxNumber:1440,required:true}); submit='开始收集报告'; }
  else if (kind === 'meeting_report' && meeting) { title='补充会议报告'; note=meeting.title; fields=teamInput('member_id','报告成员',meeting.participant_ids?.[0] || '',{select:members.filter(item => (meeting.participant_ids || []).includes(item.value)),required:true})+teamInput('summary','报告摘要','',{area:true,required:true})+teamInput('completed','已完成','',{area:true})+teamInput('blockers','阻碍','',{area:true})+teamInput('next_steps','下一步','',{area:true})+teamInput('source','报告依据位置'); submit='记录报告'; }
  else if (kind === 'meeting_discuss' && meeting) { title='追加讨论'; note=meeting.title; fields=teamInput('member_id','请谁进一步说明',meeting.participant_ids?.[0] || '',{select:members.filter(item => (meeting.participant_ids || []).includes(item.value)),required:true})+teamInput('question','需要讨论的问题','',{area:true,required:true}); submit='发送讨论问题'; }
  else if (kind === 'meeting_close' && meeting) { title='形成会议纪要'; note=(meeting.missing_member_ids || []).length ? `仍有 ${meeting.missing_member_ids.length} 位成员未报告，纪要中请明确缺失信息。` : meeting.title; fields=teamInput('summary','会议结论',meeting.summary || '',{area:true,required:true})+teamInput('decisions','确定的决策（每行一项）',(meeting.decisions || []).join('\n'),{area:true})+teamChecks('action_task_ids','关联后续任务',tasks.map(item => ({value:item.id,label:item.title})),meeting.action_task_ids || []); submit='保存纪要'; }
  else if (kind === 'schedule') { const schedule=data.schedule || {}; title='周期会议'; note='开启后由本机服务按周期组织会议，可能调用成员所用模型。服务关闭期间不会开会。'; fields=teamInput('enabled','周期会议',String(!!schedule.enabled),{select:[{value:'false',label:'关闭，按需开会'},{value:'true',label:'开启周期会议'}]})+teamInput('interval_hours','间隔（小时）',schedule.interval_hours || 24,{type:'number',min:1,maxNumber:168,required:true})+teamInput('timezone','时区',schedule.timezone || 'Asia/Taipei',{required:true}); submit='保存周期设置'; }
  else if (kind === 'brief_ack') { title='记录共同简报确认'; note=`确认所选成员已实际阅读共同简报第 ${data.brief?.version || 0} 版。`; fields=teamInput('member_id','已阅读的成员',members[0]?.value || '',{select:members,required:true}); teamDialog.brief_version=data.brief?.version; submit='记录已确认'; }
  else if (kind === 'message_reconcile') { title='核实委托结果'; note='先核查实际执行和交付，再记录结案。这不会重新执行，也不会向成员发送停止指令。'; fields=teamInput('outcome','核实后的结果','completed',{select:[{value:'completed',label:'已实际完成'},{value:'failed',label:'已确认失败'},{value:'cancelled',label:'已确认停止'}]})+evidence()+teamInput('answer','补充实际回答 / 交付结果','',{area:true}); submit='记录核实结果'; }
  else return;
  $('team-dialog-title').textContent=title; $('team-dialog-room').textContent=history?.room?.title || '当前办公室'; $('team-dialog-note').textContent=note; $('team-dialog-fields').innerHTML=fields; $('team-dialog-error').classList.add('hidden'); $('team-submit').textContent=submit; $('team-submit').disabled=false; $('team-dialog').showModal();
}
async function submitTeamForm() {
  if (!teamDialog || teamBusy || !webConnected) return;
  const context={...teamDialog}, values=new FormData($('team-form')), get=name=>String(values.get(name) || '').trim(), list=name=>values.getAll(name).map(String), observed_at=context.observed_at;
  const base={room_id:context.room_id}, id=encodeURIComponent(context.id), withKey=value=>({...base,...value,idempotency_key:context.key}), evidence=get('evidence_note')?[{note:get('evidence_note'),reference:get('evidence_source'),observed_at}]:[];
  let route, body;
  if(context.kind==='goal'){route='/api/team/goals';body=withKey({title:get('title'),description:get('description'),acceptance:get('acceptance')});}
  else if(context.kind==='task'){route='/api/team/tasks';body=withKey({goal_id:get('goal_id')||null,title:get('title'),description:get('description'),assignee_id:get('assignee_id'),deliverable:get('deliverable'),acceptance:get('acceptance'),depends_on:list('depends_on')});}
  else if(context.kind.startsWith('task_')){route=`/api/team/tasks/${id}/update`;body={...base,action:context.kind.slice(5),note:get('note'),result:get('result'),evidence,expected_version:context.version};}
  else if(context.kind==='complete_goal'){route=`/api/team/goals/${id}/complete`;body={...base,result:get('result'),evidence};}
  else if(context.kind==='cancel_goal'){route=`/api/team/goals/${id}/cancel`;body={...base,note:get('note'),expected_version:context.version};}
  else if(context.kind==='card'){const card=teamValue(context.room_id)?.cards?.find(item=>item.member_id===context.id);route='/api/team/cards';body={...base,member_id:context.id,role:get('role'),skills:get('skills').split(/[,，\n]/u).map(item=>item.trim()).filter(Boolean),information:get('information'),sources:[...(card?.sources||[]),...(get('source')?[{reference:get('source'),note:get('source_note'),observed_at}]:[])],session_ref:card?.session_ref || '',expected_version:context.version};}
  else if(context.kind==='meeting'){if(!list('participant_ids').length)throw new Error('请至少选择一位参会成员。');route='/api/team/meetings';body=withKey({goal_id:get('goal_id')||null,title:get('title'),agenda:get('agenda'),participant_ids:list('participant_ids'),deadline_minutes:Number(get('deadline_minutes'))});}
  else if(context.kind==='meeting_report'){route=`/api/team/meetings/${id}/report`;body=withKey({member_id:get('member_id'),summary:get('summary'),completed:get('completed'),blockers:get('blockers'),next_steps:get('next_steps'),sources:get('source')?[{reference:get('source'),observed_at}]:[]});}
  else if(context.kind==='meeting_discuss'){route=`/api/team/meetings/${id}/discuss`;body=withKey({questions:[{member_id:get('member_id'),question:get('question')}]});}
  else if(context.kind==='meeting_close'){route=`/api/team/meetings/${id}/close`;body=withKey({summary:get('summary'),decisions:get('decisions').split('\n').map(item=>item.trim()).filter(Boolean),action_task_ids:list('action_task_ids')});}
  else if(context.kind==='schedule'){route='/api/team/schedule';body={...base,enabled:get('enabled')==='true',interval_hours:Number(get('interval_hours')),timezone:get('timezone')};}
  else if(context.kind==='brief_ack'){route='/api/team/brief/ack';body={...base,member_id:get('member_id'),version:context.brief_version};}
  else if(context.kind==='message_reconcile'){route=`/api/chat/messages/${id}/reconcile`;body={outcome:get('outcome'),evidence:{summary:get('evidence_note'),source:get('evidence_source'),observed_at},...(get('outcome')==='completed'&&get('answer')?{answer:get('answer')}:{})};}
  if (!route) return;
  const fingerprint=JSON.stringify([route,body]); if(context.fingerprint && context.fingerprint!==fingerprint && Object.hasOwn(body,'idempotency_key')){body.idempotency_key=crypto.randomUUID();teamDialog.key=body.idempotency_key;} teamDialog.fingerprint=JSON.stringify([route,body]);
  teamBusy=true;$('team-submit').disabled=true;$('team-dialog-error').classList.add('hidden');renderTeam();
  try { await api(route,body); if(teamDialog?.room_id===context.room_id&&teamDialog?.kind===context.kind){$('team-dialog').close();teamDialog=null;} await refreshTeam(context.room_id); await refresh(); toast('协作记录已更新。'); }
  catch(error){$('team-dialog-error').textContent=/^(Failed to fetch|Load failed|NetworkError)/i.test(error.message||'')?'暂未确认保存结果。请保留表单并核对记录；相同内容重试会复用这次请求。':error.message;$('team-dialog-error').classList.remove('hidden');}
  finally {teamBusy=false;$('team-submit').disabled=!webConnected;renderTeam();}
}
function renderAppearance(members=history?.participants||[],member=members.find(item=>item.id===inspectorMemberId)) {
  const select=$('appearance-member'); if(select.dataset.signature!==JSON.stringify(members.map(item=>[item.id,item.name]))){select.innerHTML=members.map(item=>`<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');select.dataset.signature=JSON.stringify(members.map(item=>[item.id,item.name]));}
  select.value=member?.id||'';
  const key=member?.id&&roomId?`${roomId}:${member.id}`:null,look=member?.appearance||{},signature=JSON.stringify(look);
  let stored=key?appearanceDrafts.get(key):null;
  if(!stored||(!stored.dirty&&!appearanceBusy&&!appearanceUploading&&stored.signature!==signature)) {stored={room_id:roomId,member_id:member?.id,preset:['auto','person','robot','sprite'].includes(look.preset)?look.preset:'auto',furniture:look.furniture==='beanbag'?'beanbag':'desk',scale:Number.isFinite(look.scale)?Math.max(.65,Math.min(1.35,look.scale)):1,color:/^#[0-9a-f]{6}$/i.test(look.color||'')?look.color:'#3a8a72',avatar_data:safeRaster(look.avatar_data),character_data:safeRaster(look.character_data),dirty:false,signature,status:''};if(key)appearanceDrafts.set(key,stored);}
  if(appearanceDraft!==stored){appearanceDraft=stored;appearanceDirty=stored.dirty;appearanceUploadVersion++;$('appearance-avatar').value='';$('appearance-character').value='';}
  const draft=appearanceDraft||{};$('appearance-preset').value=draft.preset||'auto';$('appearance-furniture').value=draft.furniture||'desk';$('appearance-accent').value=draft.accent||'auto';$('appearance-scale').value=draft.scale||1;$('appearance-scale-value').textContent=Math.round((draft.scale||1)*100)+'%';$('appearance-color').value=draft.color||'#3a8a72';
  const image=safeRaster(draft.character_data)||(draft.preset==='auto'?window.AgentOfficeScene?.characterSource?.({...member,appearance:draftLook(draft)},undefined,history?.participants):null);
  $('appearance-preview').innerHTML=member?`<div class="appearance-preview-person ${escape(draft.preset)}">${image?`<img class="appearance-character-image" src="${escape(image)}" alt="角色形象">`:`<span class="appearance-preview-head">${avatar(member.name,member.adapter,draftLook(draft),member.id)}</span><span class="appearance-preview-body ${escape(draft.preset)}"></span>`}<span class="appearance-preview-furniture ${escape(draft.furniture)}"></span></div><strong>${escape(member.name)}</strong>`:'<p>添加成员后可设置形象</p>';
  const previewPerson=$('appearance-preview').querySelector('.appearance-preview-person');if(previewPerson){previewPerson.style.setProperty('--character-color',draft.color||'');previewPerson.style.setProperty('--character-scale',String(Number(draft.scale)||1));}
  $('appearance-avatar-note').textContent=draft.avatar_data?'已选择本机头像':'使用默认 agent 标识';$('appearance-character-note').textContent=draft.character_data?'已选择完整角色形象':'使用内置办公室形象';
  for(const id of ['appearance-member','appearance-preset','appearance-furniture','appearance-accent','appearance-scale','appearance-color','appearance-avatar','appearance-character','appearance-save','appearance-reset','appearance-avatar-clear','appearance-character-clear']) $(id).disabled=!member||appearanceBusy||appearanceUploading||!webConnected;
  $('appearance-avatar-clear').classList.toggle('hidden',!draft.avatar_data);$('appearance-character-clear').classList.toggle('hidden',!draft.character_data);
  $('appearance-status').textContent=!webConnected&&member?'开启本机服务后可更改外观，已保存的形象仍可查看。':draft.status||'';
}
function markAppearanceChanged(){if(!appearanceDraft)return;appearanceDirty=true;appearanceDraft.dirty=true;appearanceDraft.status='更改未保存。';}
async function rasterImage(file,maximumSize=256) {
  if(!file || !['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择 PNG、JPEG 或 WebP 图片，暂不支持 SVG。');
  if(file.size>8*1024*1024)throw new Error('图片请小于 8 MB。');
  const bitmap=await createImageBitmap(file);try{if(bitmap.width>8192||bitmap.height>8192||bitmap.width*bitmap.height>32000000)throw new Error('图片尺寸过大，请先缩小图片。');for(const maximum of [...new Set([maximumSize,256,192,128,96])]){const scale=Math.min(1,maximum/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);const value=canvas.toDataURL('image/png');if((value.length-value.indexOf(',')-1)*3/4<=128*1024)return value;}throw new Error('图片压缩后仍太大，请换一张图片。');}finally{bitmap.close();}
}
async function chooseAppearanceImage(field,input) {
  const file=input.files?.[0],memberId=inspectorMemberId,selectedRoom=roomId,draft=appearanceDraft,version=++appearanceUploadVersion;if(!file||!draft||!webConnected||draft.room_id!==selectedRoom)return;
  appearanceUploading=true;draft.status='正在处理本机图片…';renderAppearance();
  try{const value=await rasterImage(file);if(version!==appearanceUploadVersion||memberId!==inspectorMemberId||selectedRoom!==roomId||appearanceDraft!==draft)return;draft[field]=value;markAppearanceChanged();draft.status='图片已准备，点击保存外观生效。';}
  catch(error){if(version===appearanceUploadVersion&&memberId===inspectorMemberId&&selectedRoom===roomId)draft.status='图片未导入，请选择有效的 PNG、JPEG 或 WebP。';throw error;}
  finally{appearanceUploading=false;renderAppearance();}
}
async function saveAppearance(reset=false) {
  const memberId=inspectorMemberId,selectedRoom=roomId,draft=appearanceDraft,version=appearanceUploadVersion;
  if(!memberId||appearanceBusy||appearanceUploading||!webConnected||!draft||draft.room_id!==selectedRoom||history?.room?.id!==selectedRoom)return;appearanceBusy=true;renderAppearance();
  try{const value=await api('/api/appearance',reset?{member_id:memberId,reset:true}:{member_id:memberId,preset:draft.preset,furniture:draft.furniture,accent:draft.accent&&draft.accent!=='auto'?Number(draft.accent):'auto',scale:draft.scale,color:draft.color,avatar_data:draft.avatar_data,character_data:draft.character_data});
    for(const member of [...(history?.room?.id===selectedRoom?history.participants||[]:[]),...(state?.chat?.members||[])])if(member.id===memberId)member.appearance=value;
    appearanceDrafts.delete(`${selectedRoom}:${memberId}`);
    if(version===appearanceUploadVersion&&selectedRoom===roomId&&memberId===inspectorMemberId){appearanceDraft=null;appearanceDirty=false;}
    if(history?.room?.id===selectedRoom&&roomId===selectedRoom)renderRoom(state.projects.find(item=>item.id===projectId));toast(reset?'已恢复默认外观。':'外观已保存在本机。');
  }finally{appearanceBusy=false;renderAppearance();}
}
function sceneConfig(value={}) {
  if(!value||typeof value!=='object')value={};
  const result={...sceneDefaults};
  if(typeof value.time_zone==='string'&&value.time_zone.length<=100)result.time_zone=value.time_zone;
  if(['auto','day','night'].includes(value.time_mode))result.time_mode=value.time_mode;
  if(Number.isInteger(value.columns)&&value.columns>=1&&value.columns<=3)result.columns=value.columns;
  if(Number.isFinite(value.spacing)&&value.spacing>=.8&&value.spacing<=1.3)result.spacing=value.spacing;
  for(const field of ['wall_color','floor_color'])if(/^#[0-9a-f]{6}$/i.test(value[field]||''))result[field]=value[field];
  for(const field of ['auto_layout','show_window','show_clock','show_plant','motion'])if(typeof value[field]==='boolean')result[field]=value[field];
  for(const [field]of sceneAssets)result[field]=safeRaster(value[field]);
  return result;
}
function sceneDraftFor(selectedRoom=roomId){
  if(!selectedRoom||legacyId)return null;
  const saved=sceneConfig(state?.office?.[selectedRoom]||{}),signature=JSON.stringify(saved);
  let draft=sceneDrafts.get(selectedRoom);
  if(!draft){draft={room_id:selectedRoom,config:saved,signature,dirty:false,version:0,status:'',uploading:false,saving:false};sceneDrafts.set(selectedRoom,draft);}
  else if(!draft.dirty&&!draft.uploading&&!draft.saving&&signature!==draft.signature){draft.config=saved;draft.signature=signature;draft.version++;draft.status='';}
  return draft;
}
function renderScene(){
  const draft=sceneDraftFor(),config=draft?.config||sceneConfig(),available=!!draft&&!!state?.chat?.rooms?.some(item=>item.id===roomId),disabled=!available||!webConnected||draft?.uploading||draft?.saving;
  const bindings={'scene-time-zone':'time_zone','scene-time-mode':'time_mode','scene-columns':'columns','scene-spacing':'spacing','scene-wall-color':'wall_color','scene-floor-color':'floor_color'};
  for(const [id,field]of Object.entries(bindings)){const control=$(id);if(document.activeElement!==control)control.value=config[field];}
  for(const field of ['auto_layout','show_window','show_clock','show_plant','motion'])$('scene-'+field.replaceAll('_','-')).checked=config[field];
  $('scene-spacing-value').textContent=Math.round(config.spacing*100)+'%';
  let timezone=config.time_zone==='auto'?Intl.DateTimeFormat().resolvedOptions().timeZone:config.time_zone;
  try{new Intl.DateTimeFormat('zh-CN',{timeZone:timezone}).format();$('scene-time-zone-note').textContent=(config.time_zone==='auto'?'跟随电脑：':'当前时区：')+timezone;}catch{$('scene-time-zone-note').textContent='请输入有效 IANA 时区，例如 Asia/Taipei。';}
  const assets=$('scene-assets');
  if(!assets.dataset.ready){assets.innerHTML=sceneAssets.map(([field,label])=>`<div class="scene-asset-card"><div class="scene-asset-heading"><strong>${escape(label)}</strong><img id="scene-${field}-preview" class="scene-asset-preview hidden" alt="${escape(label)}素材"></div><label class="appearance-upload" for="scene-${field}"><input type="file" id="scene-${field}" data-scene-asset="${field}" accept="image/png,image/jpeg,image/webp"><small id="scene-${field}-note">使用内置素材</small></label><button type="button" class="text-button asset-clear hidden" data-clear-scene-asset="${field}">恢复内置${escape(label)}</button></div>`).join('');assets.dataset.ready='true';}
  for(const [field]of sceneAssets){const source=safeRaster(config[field]),preview=$('scene-'+field+'-preview');preview.classList.toggle('hidden',!source);if(source){if(preview.getAttribute('src')!==source)preview.src=source;}else preview.removeAttribute('src');$('scene-'+field+'-note').textContent=source?'已选择本机素材':'使用内置素材';assets.querySelector(`[data-clear-scene-asset="${field}"]`).classList.toggle('hidden',!source);}
  $('scene-form').querySelectorAll('input,select,button').forEach(control=>control.disabled=disabled);
  $('scene-columns').disabled=disabled || config.auto_layout;
  $('scene-save').textContent=draft?.saving?'正在保存…':'保存场景';
  $('scene-status').textContent=!available?'选择一个房间后可设置场景。':!webConnected?'开启本机服务后可更改场景，已保存配置仍可查看。':draft.status||'';
}
function changeScene(field,value){const draft=sceneDraftFor();if(!draft||!webConnected||draft.uploading||draft.saving)return;draft.config[field]=value;draft.dirty=true;draft.version++;draft.status='更改未保存。';renderScene();}
async function chooseSceneImage(field,input){
  const file=input.files?.[0],selectedRoom=roomId,draft=sceneDraftFor(selectedRoom);if(!file||!draft||!webConnected||draft.saving||draft.uploading)return;
  const version=++draft.version;draft.uploading=true;draft.status='正在处理本机图片…';renderScene();
  try{const value=await rasterImage(file,512);if(sceneDrafts.get(selectedRoom)!==draft||draft.version!==version)return;draft.config[field]=value;draft.dirty=true;draft.status='素材已准备，点击保存场景生效。';}
  catch(error){if(sceneDrafts.get(selectedRoom)===draft&&draft.version===version)draft.status='素材未导入，请选择有效的 PNG、JPEG 或 WebP。';throw error;}
  finally{draft.uploading=false;input.value='';renderScene();}
}
async function saveScene(reset=false){
  const selectedRoom=roomId,draft=sceneDraftFor(selectedRoom);if(!draft||!webConnected||draft.saving||draft.uploading||history?.room?.id!==selectedRoom)return;
  const config={...draft.config};config.time_zone=(config.time_zone||'').trim()||'auto';
  if(!reset&&config.time_zone!=='auto'){try{new Intl.DateTimeFormat('zh-CN',{timeZone:config.time_zone}).format();}catch{draft.status='时区无效，请选择列表中的时区或输入 IANA 名称。';renderScene();$('scene-time-zone').focus();return;}}
  const version=draft.version;draft.saving=true;draft.status='正在保存到本机…';renderScene();
  try{const response=await api('/api/office',reset?{room_id:selectedRoom,reset:true}:{room_id:selectedRoom,...config}),saved=response?.scene||response?.config||response;
    if(!saved||typeof saved!=='object'||!Number.isInteger(saved.columns)||typeof saved.time_zone!=='string')throw new Error('服务未返回已保存场景，请检查后重试。');
    const value=sceneConfig(saved);
    state.office||={};state.office[selectedRoom]=value;
    if(sceneDrafts.get(selectedRoom)===draft&&draft.version===version){draft.config=value;draft.signature=JSON.stringify(value);draft.dirty=false;draft.version++;draft.status=reset?'已恢复默认场景。':'场景已保存在本机。';}
    if(selectedRoom===roomId){updateOfficeScene();renderScene();}
    toast(reset?'已恢复默认场景。':'场景已保存在本机。');
  }catch(error){if(sceneDrafts.get(selectedRoom)===draft)draft.status='未保存，当前更改仍保留。';throw error;}
  finally{draft.saving=false;renderScene();}
}
installDesktopChrome();
for (const id of ['add-project','welcome-project','mobile-add-project','launch-add-project']) $(id).onclick = showProject;
setProfessionalView(professionalView);
$('professional-toggle').onclick = () => setProfessionalView(!professionalView);
$('sidebar-toggle').onclick=()=>{const mobile=matchMedia('(max-width:760px)').matches,expanded=mobile?document.body.classList.toggle('mobile-sidebar-open'):!document.body.classList.toggle('sidebar-collapsed');$('sidebar-toggle').setAttribute('aria-expanded',String(expanded));$('sidebar-toggle').setAttribute('aria-label',expanded?'收起房间列表':'展开房间列表');};
$('sidebar-close').onclick=()=>{document.body.classList.remove('mobile-sidebar-open');$('sidebar-toggle').setAttribute('aria-expanded','false');$('sidebar-toggle').setAttribute('aria-label','展开房间列表');};
const mobileSidebarMedia=matchMedia('(max-width:760px)');function syncSidebarToggle(){const expanded=mobileSidebarMedia.matches?document.body.classList.contains('mobile-sidebar-open'):!document.body.classList.contains('sidebar-collapsed');$('sidebar-toggle').setAttribute('aria-expanded',String(expanded));$('sidebar-toggle').setAttribute('aria-label',expanded?'收起房间列表':'展开房间列表');}mobileSidebarMedia.addEventListener('change',syncSidebarToggle);syncSidebarToggle();
$('inspector-toggle').onclick=()=>{if(inspectorOpen){inspectorOpen=false;applyInspector();}else openInspector(inspectorTab);};
$('team-open').onclick=()=>{openInspector('team');action(()=>refreshTeam());};
$('team-content').onclick=event=>{const button=event.target.closest('[data-team-action]');if(!button||button.disabled)return;if(button.dataset.teamAction==='refresh')action(()=>refreshTeam());else openTeamDialog(button.dataset.teamAction,button.dataset.teamId);};
$('team-form').onsubmit=event=>{event.preventDefault();submitTeamForm().catch(error=>{$('team-dialog-error').textContent=error.message;$('team-dialog-error').classList.remove('hidden');});};
$('team-form').onchange=event=>{if(teamDialog?.kind==='task'&&event.target.name==='goal_id'){const items=(teamValue(teamDialog.room_id)?.tasks||[]).filter(task=>task.goal_id===event.target.value&&task.status!=='cancelled').map(task=>({value:task.id,label:task.title}));const field=$('team-form').querySelector('[data-team-checks="depends_on"]');if(field)field.outerHTML=teamChecks('depends_on','前置任务',items);}if(teamDialog?.kind==='message_reconcile'&&event.target.name==='outcome'){const answer=$('team-field-answer');answer.disabled=event.target.value!=='completed';answer.closest('label').classList.toggle('hidden',answer.disabled);}};
$('inspector-close').onclick=()=>{inspectorOpen=false;applyInspector();};
document.querySelectorAll('[data-inspector-tab]').forEach(button=>button.onclick=()=>openInspector(button.dataset.inspectorTab));
$('chat-view-button').onclick=()=>selectRoomView(false);$('office-view-button').onclick=()=>selectRoomView(true);
$('office-compose-launch').onclick=()=>toggleOfficeComposer(true);$('office-composer-close').onclick=()=>toggleOfficeComposer(false);
$('secretary-room-entry').onclick = openSecretaryTutorial;
$('secretary-dismiss').onclick = closeSecretaryTutorial; $('secretary-look-around').onclick = closeSecretaryTutorial;
$('secretary-member-options').onclick = event => {const button = event.target.closest('[data-secretary-select]');if(button && !button.disabled)action(()=>chooseSecretary(button.dataset.secretarySelect));};
$('secretary-selected-person').onclick = event => {if(event.target.closest('[data-secretary-change]')){secretaryPickingRoom=roomId;secretaryError='';renderSecretary();}};
$('secretary-role-card').onclick = event => {const button=event.target.closest('[data-secretary-open],[data-secretary-reset]');if(!button || button.disabled)return;if(button.dataset.secretaryReset!==undefined)action(clearSecretary);else openSecretaryTutorial();};
$('secretary-add-ai').onclick = openSecretaryConnect; $('secretary-add-others').onclick = openSecretaryConnect;
$('secretary-start').onclick = ()=>action(startSecretary); $('secretary-discuss').onclick = discussWithSecretary;
$('secretary-team-progress').onclick=()=>{closeSecretaryTutorial();openInspector('team');action(()=>refreshTeam());};
$('secretary-goal').oninput = ()=>{secretaryGoalVersion++;secretaryDrafts.set(roomId,{value:$('secretary-goal').value,dirty:true});renderSecretary();};
$('secretary-check-connection').onclick = ()=>{const member=secretaryMember();if(member)action(()=>showMemberSetup(member.id));};
$('secretary-message-history').onclick = ()=>{const id=currentSecretary().request_id;closeSecretaryTutorial();selectRoomView(false);if(id)requestAnimationFrame(()=>$('message-'+id)?.scrollIntoView({block:'center',behavior:'smooth'}));};
$('secretary-scan-agents').onclick = ()=>action(scanLaunch);
$('secretary-connect-candidates').onclick = event => {if(secretaryConnectRoom===roomId)$('launch-candidates').onclick(event);};
$('secretary-connect-progress').onclick = event => {if(secretaryConnectRoom===roomId)$('onboarding-jobs').onclick(event);};
$('secretary-connect-back').onclick = ()=>{$('secretary-connect-dialog').close();secretaryConnectJob=null;openSecretaryTutorial();};
$('secretary-connect-manual').onclick = ()=>{$('secretary-connect-dialog').close();secretaryConnectJob=null;action(showMembers);};
$('office-approval-alert').onclick=()=>{selectRoomView(false);requestAnimationFrame(()=>{$('approval-panel').scrollIntoView({block:'start',behavior:'smooth'});$('approval-panel').querySelector('input,button,a')?.focus({preventScroll:true});});};
window.visualViewport?.addEventListener('resize',updateOfficeKeyboardInset);window.visualViewport?.addEventListener('scroll',updateOfficeKeyboardInset);
$('composer').addEventListener('focusin',updateOfficeKeyboardInset);$('composer').addEventListener('focusout',()=>requestAnimationFrame(updateOfficeKeyboardInset));
$('chat-stream').addEventListener('scroll',rememberTextScroll,{passive:true});
$('appearance-member').onchange=()=>{inspectorMemberId=$('appearance-member').value;appearanceDraft=null;appearanceDirty=false;appearanceUploadVersion++;renderAppearance();};
$('appearance-preset').onchange=()=>{appearanceDraft.preset=$('appearance-preset').value;markAppearanceChanged();renderAppearance();};
$('appearance-accent').onchange=()=>{appearanceDraft.accent=$('appearance-accent').value;markAppearanceChanged();renderAppearance();};
$('appearance-furniture').onchange=()=>{appearanceDraft.furniture=$('appearance-furniture').value;markAppearanceChanged();renderAppearance();};
$('appearance-scale').oninput=()=>{appearanceDraft.scale=Number($('appearance-scale').value);markAppearanceChanged();renderAppearance();};
$('appearance-color').oninput=()=>{appearanceDraft.color=$('appearance-color').value;markAppearanceChanged();renderAppearance();};
$('appearance-avatar').onchange=()=>action(()=>chooseAppearanceImage('avatar_data',$('appearance-avatar')));
$('appearance-character').onchange=()=>action(()=>chooseAppearanceImage('character_data',$('appearance-character')));
$('appearance-avatar-clear').onclick=()=>{appearanceDraft.avatar_data=null;$('appearance-avatar').value='';markAppearanceChanged();renderAppearance();};
$('appearance-character-clear').onclick=()=>{appearanceDraft.character_data=null;$('appearance-character').value='';markAppearanceChanged();renderAppearance();};
$('appearance-form').onsubmit=event=>{event.preventDefault();action(()=>saveAppearance(false));};$('appearance-reset').onclick=()=>action(()=>saveAppearance(true));
for(const [id,field]of Object.entries({'scene-time-zone':'time_zone','scene-time-mode':'time_mode','scene-columns':'columns','scene-spacing':'spacing','scene-wall-color':'wall_color','scene-floor-color':'floor_color'}))$(id).addEventListener(['scene-time-zone','scene-spacing','scene-wall-color','scene-floor-color'].includes(id)?'input':'change',()=>changeScene(field,['columns','spacing'].includes(field)?Number($(id).value):$(id).value));
for(const field of ['auto_layout','show_window','show_clock','show_plant','motion'])$('scene-'+field.replaceAll('_','-')).onchange=()=>changeScene(field,$('scene-'+field.replaceAll('_','-')).checked);
$('scene-assets').onchange=event=>{const input=event.target.closest('[data-scene-asset]');if(input)action(()=>chooseSceneImage(input.dataset.sceneAsset,input));};
$('scene-assets').onclick=event=>{const button=event.target.closest('[data-clear-scene-asset]');if(button&&!button.disabled)changeScene(button.dataset.clearSceneAsset,null);};
$('scene-form').onsubmit=event=>{event.preventDefault();action(()=>saveScene(false));};$('scene-reset').onclick=()=>action(()=>saveScene(true));
$('inspector-member-connect').onclick=()=>inspectorMemberId&&action(()=>showMemberSetup(inspectorMemberId));$('inspector-member-recovery').onclick=()=>showResume(inspectorMemberId);$('inspector-settings').onclick=showSettings;
$('connection-doctor-run').onclick=()=>action(runConnectionDoctor);
$('connection-doctor-member').onchange=()=>{$('connection-doctor-old-member').value='';connectionDoctor=null;connectionDoctorError='';renderConnectionDoctor();};
$('connection-doctor-old-member').oninput=()=>{connectionDoctor=null;connectionDoctorError='';renderConnectionDoctor();};
$('connection-doctor-copy').onclick=()=>action(async()=>{await navigator.clipboard.writeText(doctorSummary());toast('诊断摘要已复制，不含入口凭据。');});
$('connection-doctor-select').onclick=()=>{$('connection-doctor-old-member').value='';$('connection-doctor-member').value='';connectionDoctor=null;connectionDoctorError='';renderConnectionDoctor();$('connection-doctor-member').focus();};
$('connection-doctor-resume').onclick=()=>{const member=doctorMember();if(member)showResume(member.id);};
$('connection-doctor-setup').onclick=()=>{const member=doctorMember();if(member)action(()=>showMemberSetup(member.id));};
$('launch-open-professional').onclick = () => setProfessionalView(true);
$('launch-project-select').onchange = () => { projectId = $('launch-project-select').value; roomId = null; legacyId = null; launchSession = null; launchError = ''; setReply(null); action(refresh); };
$('launch-scan').onclick = () => action(scanLaunch);
$('launch-candidates').onclick = event => { const button = event.target.closest('[data-onboarding-provider],[data-onboarding-requirements]'); if (!button || button.disabled) return; if (button.dataset.onboardingProvider) action(() => startOnboarding(button.dataset.onboardingProvider)); else { const candidate = (launchCandidates || []).find(item => launchProvider(item) === button.dataset.onboardingRequirements); if (candidate) showOnboardingRequirements(candidate); } };
$('onboarding-refresh').onclick = () => action(refreshOnboarding);
$('onboarding-jobs').onclick = event => { const button = event.target.closest('[data-onboarding-check],[data-onboarding-copy],[data-onboarding-config],[data-onboarding-operation]'); if (!button || button.disabled) return; action(async () => {
  const jobId = button.dataset.onboardingCheck || button.dataset.onboardingCopy || button.dataset.onboardingConfig || button.dataset.onboardingActionJob, job = onboardingJobs.get(jobId); if (!job) throw new Error('接入记录已更新，请检查进度。');
  button.disabled = true;
  try {
    if (button.dataset.onboardingCheck) await checkOnboarding(jobId);
    else if (button.dataset.onboardingOperation) {
      const operation = button.dataset.onboardingOperation;
      const response = operation === 'retry' || operation === 'install_runtime' ? await api(`/api/onboarding/jobs/${encodeURIComponent(jobId)}/retry`,operation === 'install_runtime' ? {install_runtime:true} : {}) : await api('/api/onboarding/action',{run_id:jobId,operation});
      const updated = onboardingView(response); if (updated?.id) onboardingJobs.set(updated.id,updated); renderLaunch(); action(refreshOnboarding); toast(response.action?.instruction || (operation === 'login_client' ? '首次配置入口已请求打开。完成后点击继续接入。' : '已请求继续接入这个成员。'));
    }
    else if (button.dataset.onboardingConfig) { const sessionId = job.launch_session_id || job.session_id; if (!sessionId) throw new Error('这个成员的导入配置尚未准备完成。'); await copyClientConfiguration(sessionId,job.provider); }
    else {
      let text, copyKind = button.dataset.onboardingCopyKind;
      if (copyKind === 'group') { const result = await api('/api/onboarding/action',{run_id:job.id,operation:'native_group_handoff'}); text = result.action?.instruction; }
      else if (copyKind) { const sessionId = job.launch_session_id || job.session_id; if (!sessionId) throw new Error('这个成员的接入说明尚未准备完成。'); const session = launchView(await api(`/api/launch/state?session_id=${encodeURIComponent(sessionId)}`)); if (!session) throw new Error('成员接入记录尚未返回。'); text = session.selected_handshakes?.find(item => item.provider === job.provider)?.instruction; }
      else { const value = onboardingAction(job); text = value?.command || value?.instruction || value?.prompt; }
      if (!text) throw new Error('接入说明尚未准备完成。'); await navigator.clipboard.writeText(text); toast(copyKind === 'group' ? '加群说明已复制。交给 Grok，只接入这次指定的成员。' : '已复制。请在这个成员自己的窗口完成首次配置。');
    }
  } finally { button.disabled = false; }
}); };
$('launch-candidates').onchange = event => { const input = event.target.closest('[data-launch-provider]'); if (!input || input.disabled) return; if (input.checked) launchSelection.add(input.dataset.launchProvider); else launchSelection.delete(input.dataset.launchProvider); renderLaunch(); };
$('launch-self-handshakes').onclick = event => { const button = event.target.closest('[data-launch-handshake],[data-launch-config]'); if (!button || button.disabled) return; action(async () => {
  const selected = launchSession, provider = button.dataset.launchHandshake || button.dataset.launchConfig;
  const handshake = selected?.room_id === roomId && selected.selected_handshakes?.find(item => item.provider === provider);
  if (!handshake) throw new Error('该成员的待接入状态已更新，请检查进度。');
  button.disabled = true;
  try {
    if (button.dataset.launchConfig) await copyClientConfiguration(selected.id,provider);
    else { if (!handshake.instruction) throw new Error('这个成员的本人握手说明尚未准备完成。'); await navigator.clipboard.writeText(handshake.instruction); toast('握手说明已复制。交给对应客户端自己的窗口执行。'); }
  } finally { button.disabled = false; }
}); };
$('launch-prepare').onclick = () => action(prepareLaunch);
$('launch-refresh').onclick = () => action(async () => { launchError = ''; await refreshLaunch(); });
$('launch-copy').onclick = () => action(async () => { if (!launchSession?.grok_prompt || !launchSession.handoff_file || launchSession.status === 'preparing' || launchBusy) return; try { await navigator.clipboard.writeText(launchSession.grok_prompt); toast('本次接入说明已复制，只包含你指定的成员。'); } catch (error) { document.querySelector('.launch-instructions').open = true; toast('自动复制未完成，本次说明已展开，可手动复制。'); } });
for (const id of ['add-room','welcome-room','mobile-add-room']) $(id).onclick = () => showRoom();
for (const id of ['settings-button','top-settings']) $(id).onclick = showSettings;
for (const id of ['welcome-members','room-member-add','empty-add-member']) $(id).onclick = () => action(showMembers);
document.querySelectorAll('.close-dialog').forEach(button => button.onclick = () => button.closest('dialog').close());
$('connector-fields-dialog').addEventListener('close',()=>{connectorFields=null;for(const name of ['name','transport','url','headers'])$('connector-'+name).value='';$('connector-instructions').textContent='';$('connector-docs').removeAttribute('href');});
$('connector-fields-dialog').onclick=event=>{const button=event.target.closest('[data-connector-copy]');if(!button||!connectorFields)return;action(async()=>{const name=button.dataset.connectorCopy,value=connectorFields[name];if(value===undefined)return;if(name==='headers'&&!Object.keys(value).length){toast('这个连接器不需要标头。');return;}await navigator.clipboard.writeText(typeof value==='string'?value:JSON.stringify(value,null,2));toast('已复制。只填写到这个 AI 本人的连接器设置。');});};
$('connector-copy-all').onclick=()=>action(async()=>{if(!connectorFields)return;const fields=connectorFields;await navigator.clipboard.writeText(`名称：${fields.name}\n连接方式：${fields.transport}\nURL：${fields.url}\n标头：${Object.keys(fields.headers).length?JSON.stringify(fields.headers,null,2):'无需填写'}`);toast('字段已复制。按名称、连接方式、URL 分别填写，不作为 JSON 导入。');});
$('projects').onclick = event => { const button = event.target.closest('[data-project]'); if (button) { projectId = button.dataset.project; roomId = null; legacyId = null; document.body.classList.remove('mobile-sidebar-open');syncSidebarToggle();setReply(null); action(refresh); } };
const onRoomListClick = event => { const manage=event.target.closest('[data-room-actions]');if(manage){showRoomActions(manage.dataset.roomActions);return;}const button = event.target.closest('[data-room]'); if (button) { roomId = button.dataset.room; legacyId = null;document.body.classList.remove('mobile-sidebar-open');syncSidebarToggle();setReply(null); setProfessionalView(true); action(refresh); } };
$('rooms').onclick=onRoomListClick;$('archived-rooms-list').onclick=onRoomListClick;
$('room-actions-archive').onclick=()=>action(toggleRoomArchive);
$('room-actions-delete').onclick=()=>{const id=managedRoomId;$('room-actions-dialog').close();managedRoomId=null;showDeleteRoom(id);};
$('room-actions-start').onclick=()=>action(()=>changeService('start_service'));
$('delete-room-confirm').onclick=()=>action(confirmDeleteRoom);
$('delete-room-blockers').onclick=event=>action(async()=>{const button=event.target.closest('[data-delete-blocker]'),target=state?.chat?.rooms?.find(room=>room.id===deleteRoomId);if(!button||!target)return;const kind=button.dataset.blockerKind,id=button.dataset.deleteBlocker;$('delete-room-dialog').close();roomId=target.id;projectId=target.project_id;legacyId=null;setReply(null);await refresh();if(kind==='message'){selectRoomView(false);requestAnimationFrame(()=>$('message-'+id)?.scrollIntoView({block:'center'}));}else openInspector(kind==='binding'?'connections':'team',kind==='binding'?id:undefined);});
$('discussions').onclick = event => { const button = event.target.closest('[data-discussion]'); if (button) { legacyId = button.dataset.discussion; setReply(null); action(refresh); } };
$('room-members').onclick = event => { const button = event.target.closest('[data-member]'); if (button) openInspector('connections',button.dataset.member); };
$('inspector-members').onclick = event => { const button = event.target.closest('[data-inspector-member]'); if (button) openInspector('connections',button.dataset.inspectorMember); };
$('inspector-add-member').onclick = () => setProfessionalView(false);
$('inspector-bridge').onclick = () => action(async () => { const bridge = history?.participants?.find(member => member.adapter === 'grok-bridge'); if (bridge) await showBridge(bridge.id); else {setProfessionalView(false);toast('先选中要接入的成员，再将加群说明交给 Grok Bot。');} });
$('continue-in-room').onclick = () => showRoom(history?.discussion?.title || '');
$('scan-agents').onclick = () => action(scanAgents);
$('discovered-agents').onclick = event => { const button = event.target.closest('[data-candidate]'); if (button) selectCandidate(button.dataset.candidate); };
$('member-adapter').onchange = () => { selectedCandidate = null; $('candidate-note').textContent = $('member-adapter').value === 'mailbox' ? '能使用 MCP 或本机命令的 agent，可以通过专属身份和通用通信入口加入。' : '将使用这个工具的原生适配器进行连接。'; renderCandidates(); };
$('member-form').onsubmit = event => { event.preventDefault(); action(async () => {
  if (!roomId || legacyId) { $('member-dialog').close(); showRoom(); toast('创建房间后，再添加成员。'); return; }
  const button = $('connect-member'); button.disabled = true; button.textContent = '正在添加…';
  try { const member = await api('/api/chat/members', {name:$('member-name').value.trim(),adapter:$('member-adapter').value,candidate_id:selectedCandidate || undefined}); await connectMember(member.id,member); }
  finally { button.disabled = false; button.innerHTML = '添加并连接 <span>↗</span>'; }
}); };
$('existing-members').onclick = event => { const button = event.target.closest('[data-join-member]'); if (button) action(async () => { button.disabled = true; try { await connectMember(button.dataset.joinMember); } finally { button.disabled = false; } }); };
$('member-setup-content').onclick = event => { const button = event.target.closest('[data-copy-setup]'); if (!button) return; action(async () => { const member = memberById(selectedSetupMember) || setupData?.member || {}; if (button.dataset.copySetup === 'instructions' && !['codex','native'].includes(member.adapter) && !member.verified_at && !setupData?.invite) { setupData = await api(`/api/chat/members/${encodeURIComponent(selectedSetupMember)}/connect`,{room_id:roomId}); renderSetup(); await refresh(); } await navigator.clipboard.writeText(button.dataset.copySetup === 'mcp' ? setupText(setupData?.mcp) : instructionsText(setupData || {})); toast('已复制成员的专属接入说明。'); }); };
$('member-grok-form').onsubmit = event => { event.preventDefault(); action(async () => { const button = $('member-grok-form').querySelector('button'); button.disabled = true; try { await api(`/api/chat/members/${encodeURIComponent(selectedSetupMember)}/grok-configure`,{url:$('member-grok-url').value,key:$('member-grok-key').value}); $('member-grok-key').value = ''; $('member-grok-url').value = ''; toast('这个桥接成员的通知连接已加密保存，原群回报仍需真实验证。'); await refresh(); } finally { button.disabled = false; } }); };
$('retry-member-connect').onclick = () => action(() => connectMember(selectedSetupMember));
$('leave-member').onclick = () => action(async () => { await api(`/api/chat/rooms/${encodeURIComponent(roomId)}/leave`, {member_id:selectedSetupMember}); $('member-setup-dialog').close(); setReply(null); await refresh(); toast('成员已移出这个房间，之前的消息仍保留。'); });
$('room-recovery').onclick = () => showResume();
$('member-view-entry').onclick = () => showResume(selectedSetupMember);
$('bridge-view-entry').onclick = () => showResume(bridgeMemberId);
$('member-connect-guide').onclick = event => { const button = event.target.closest('[data-copy-guide],[data-copy-bootstrap]'); if (!button) return; const bootstrap=button.hasAttribute('data-copy-bootstrap'),text=bootstrap?setupData?.client?.bootstrap:setupData?.client?.copy; if(!text)return; action(async () => { await navigator.clipboard.writeText(text); toast(bootstrap?'已复制。发到这位同事的 AI 对话里，之后无需按房间重新连接。':'已复制。粘贴到客户端的 MCP 设置，不能仅发给聊天模型。'); }); };
$('member-copy-entry').onclick = () => action(async () => { const button = $('member-copy-entry'); button.disabled = true; try { await copyResume(selectedSetupMember); } finally { button.disabled = false; } });
$('bridge-copy-entry').onclick = () => action(async () => { const button = $('bridge-copy-entry'); button.disabled = true; try { await copyResume(bridgeMemberId,bridgeRoomId); } finally { button.disabled = false; } });
$('resume-member').onchange = renderResume;
$('resume-copy').onclick = () => action(async () => { if (entryBusy) return; entryBusy = true; renderResume(); try { await copyResume($('resume-member').value); } finally { entryBusy = false; renderResume(); } });
$('resume-wake').onclick = () => action(async () => { const memberId = $('resume-member').value; entryBusy = true; renderResume(); try { await api('/api/runtime/wake',{room_id:roomId,member_id:memberId}); await refresh(); toast('已请求拉起该成员的后台工作会话。'); } finally { entryBusy = false; renderResume(); } });
$('resume-revoke').onclick = () => action(async () => { const memberId = $('resume-member').value; entryBusy = true; renderResume(); try { await api('/api/resume/revoke',{member_id:memberId,room_id:roomId}); for (const [key,entry] of Object.entries(resumeEntries)) if (entry.member_id === memberId && entry.room_id === roomId) delete resumeEntries[key]; localStorage.setItem(entryCacheKey,JSON.stringify(resumeEntries)); toast('该成员在这个房间的旧恢复入口已撤销，可以重新生成。'); await refresh(); } finally { entryBusy = false; renderResume(); } });
$('browse-folder').onclick = () => action(async () => { const button = $('browse-folder'); button.disabled = true; try { const result = await api('/api/folder-picker',{}); if (result.path) $('project-path').value = result.path; } finally { button.disabled = false; } });
$('project-form').onsubmit = event => { event.preventDefault(); action(async () => { const project = await api('/api/projects',{name:$('project-name').value,path:$('project-path').value,access:$('project-write').checked ? 'workspace-write' : 'read-only'}); projectId = project.id; roomId = null; legacyId = null; $('project-dialog').close(); await refresh(); showRoom(); }); };
$('room-form').onsubmit = event => { event.preventDefault(); action(async () => { const room = await api('/api/chat/rooms',{project_id:projectId,title:$('room-name').value}); roomId = room.id; legacyId = null; setReply(null); $('room-dialog').close(); await refresh(); $('prompt').focus(); }); };
$('check-codex').onclick = () => action(async () => { const button = $('check-codex'); button.disabled = true; button.textContent = '检查中…'; try { const result = await api('/api/codex/check',{}); toast(result.connected ? '本机 Codex 入口已连接。' : result.error); await refresh(); } finally { button.disabled = false; button.textContent = '检查连接'; } });
$('scene-time-zone').onfocus = () => $('scene-time-zone').select();
$('codex-path').oninput = () => { $('codex-path').dataset.dirty = '1'; };
$('save-codex-path').onclick = () => action(async () => { const input = $('codex-path'), submitted = input.value; await api('/api/codex/path',{path:submitted}); if (input.value === submitted) delete input.dataset.dirty; await refresh(); toast('Codex 路径已保存。'); });
$('edit-grok').onclick = () => { editingGrok = true; $('grok-form').classList.remove('hidden'); $('grok-url').focus(); };
$('grok-form').onsubmit = event => { event.preventDefault(); action(async () => { await api('/api/grok/configure',{url:$('grok-url').value,key:$('grok-key').value}); $('grok-key').value = ''; $('grok-url').value = ''; editingGrok = false; await refresh(); toast('连接已保存，成员接入仍需单独验证。'); }); };
async function copy(kind) { const data = await api('/api/onboarding'); await navigator.clipboard.writeText(kind === 'grok' ? data.grokInstructions : kind === 'mcp' ? JSON.stringify(data.mcp,null,2) : data.skill); toast('已复制。'); }
$('copy-grok-setup').onclick = () => action(() => copy('grok')); $('copy-mcp').onclick = () => action(() => copy('mcp')); $('copy-skill').onclick = () => action(() => copy('skill'));
$('recipient').onchange = updateRecipientNote; $('cancel-reply').onclick = () => setReply(null);
document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => { $('prompt').value = button.dataset.prompt; if (!$('recipient').value && history?.participants?.length) $('recipient').value = history.participants[0].id; updateRecipientNote(); $('prompt').focus(); });
$('attach-image').onclick=()=>$('image-input').click();
$('image-input').onchange=()=>{const files=Array.from($('image-input').files||[]);$('image-input').value='';action(()=>addChatImages(files));};
$('composer').addEventListener('paste',event=>{const files=Array.from(event.clipboardData?.files||[]);if(files.length){event.preventDefault();const text=event.clipboardData.getData('text/plain');if(text)$('prompt').setRangeText(text,$('prompt').selectionStart,$('prompt').selectionEnd,'end');action(()=>addChatImages(files));}});
$('composer').addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
$('composer').addEventListener('drop',event=>{if(event.dataTransfer?.files.length){event.preventDefault();action(()=>addChatImages(event.dataTransfer.files));}});
$('image-drafts').onclick=event=>{const button=event.target.closest('[data-remove-image]');if(button){imageDrafts.set(roomId,draftImages().filter(image=>image.id!==button.dataset.removeImage));renderImageDrafts();updateOfficeComposerPresentation();}};
$('messages').addEventListener('click',event=>{const link=event.target.closest('[data-show-image]');if(link){event.preventDefault();$('image-full').src='/api/chat/images/'+link.dataset.showImage;$('image-dialog').showModal();}});
$('image-close').onclick=()=>$('image-dialog').close();
$('composer').onsubmit = event => { event.preventDefault(); if (submitting) return; action(async () => {
  const text = $('prompt').value.trim(),images=draftImages().slice(); if ((!text&&!images.length) || !roomId || legacyId) return; const named = mentionedMember(text); if (named) { $('recipient').value = named.id; updateRecipientNote(); } const target = $('recipient').value || null, submittedRoom=roomId, fingerprint = JSON.stringify([submittedRoom,target,text,replyTo,images.map(image=>image.id)]);
  if (!pendingSubmission || pendingSubmission.fingerprint !== fingerprint) pendingSubmission = {fingerprint,key:crypto.randomUUID()}; submitting = true; $('send-button').disabled = true;
  try { await api('/api/chat/messages',{room_id:submittedRoom,sender_id:'user',to_member_id:target,text,idempotency_key:pendingSubmission.key,reply_to:replyTo,attachments:images.map(({name,data_url})=>({name,data_url}))}); pendingSubmission = null;
    const unchanged=JSON.stringify([roomId,$('recipient').value||null,$('prompt').value.trim(),replyTo,draftImages().map(image=>image.id)])===fingerprint;
    if(unchanged){$('prompt').value = ''; imageDrafts.delete(submittedRoom);renderImageDrafts();$('mention-choices').classList.add('hidden'); setReply(null); if(document.body.classList.contains('office-view'))toggleOfficeComposer(false);}else{const sentIds=new Set(images.map(image=>image.id));imageDrafts.set(submittedRoom,(imageDrafts.get(submittedRoom)||[]).filter(image=>!sentIds.has(image.id)));renderImageDrafts();}
    await refresh(); if(!officeView)$('chat-stream').scrollTop = $('chat-stream').scrollHeight;
  }finally { submitting = false; $('send-button').disabled = !webConnected;updateOfficeComposerPresentation(); }
}); };
$('prompt').oninput = ()=>{renderMentions();updateOfficeComposerPresentation();};
$('prompt').onkeydown = event => {
  if (event.isComposing || event.keyCode === 229) return;
  const picking = !$('mention-choices').classList.contains('hidden');
  if (picking && ['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); moveMention(event.key === 'ArrowDown' ? 1 : -1); return; }
  if (picking && !event.shiftKey && ['Tab','Enter'].includes(event.key)) { event.preventDefault(); $('mention-choices').querySelector('[data-mention].active')?.click(); return; }
  if (event.key === 'Escape') { $('mention-choices').classList.add('hidden'); if (!picking && document.body.classList.contains('office-view')) toggleOfficeComposer(false); }
  if (event.key === 'Enter' && !event.shiftKey && $('mention-choices').classList.contains('hidden')) { event.preventDefault(); $('composer').requestSubmit(); }
};
$('mention-choices').onclick = event => { const button = event.target.closest('[data-mention]'); if (!button) return; const member = memberById(button.dataset.mention), input = $('prompt'), before = input.value.slice(0,input.selectionStart), after = input.value.slice(input.selectionEnd), value = before.replace(/@([^\s@]*)$/u,() => `@${member.name} `); input.value = value + after; input.focus(); input.setSelectionRange(value.length,value.length); $('recipient').value = member.id; updateRecipientNote(); $('mention-choices').classList.add('hidden'); };
$('messages').onclick = event => { const button = event.target.closest('button'); if (!button) return; if(button.dataset.openMember)openInspector('connections',button.dataset.openMember);if(button.hasAttribute('data-open-team')){openInspector('team');action(()=>refreshTeam());}if (button.dataset.reconcileMessage) openTeamDialog('message_reconcile',button.dataset.reconcileMessage); if (button.dataset.reply) setReply(history.messages.find(message => message.id === button.dataset.reply)); if (button.dataset.cancelMessage) action(async () => { await api(`/api/chat/messages/${encodeURIComponent(button.dataset.cancelMessage)}/cancel`,{}); await refresh(); }); };
document.addEventListener('click', event => { if (event.target.closest('#cleanup-stale-members')) action(async () => { const result = await api('/api/chat/members/cleanup',{}); await refresh(); toast(`已把 ${result.removed.length} 个没接通的成员移出房间，聊天记录保留。`); }); });
document.addEventListener('click', event => { const button = event.target.closest('[data-onboarding-approve]'); if (!button) return; action(async () => { button.disabled = true; await api(`/api/approvals/${encodeURIComponent(button.dataset.onboardingApprove)}`,{decision:button.dataset.decision}); await refresh(); }); });
$('approval-panel').onclick = event => action(async () => { const button = event.target.closest('button'); if (!button) return; if (button.dataset.approve) await api(`/api/approvals/${encodeURIComponent(button.dataset.approve)}`,{decision:button.dataset.decision}); if (button.dataset.inputSubmit) { const answers = {}; button.closest('[data-approval]').querySelectorAll('[data-question]').forEach(input => answers[input.dataset.question] = input.value); await api(`/api/approvals/${encodeURIComponent(button.dataset.inputSubmit)}`,{answers}); } if (button.dataset.formSubmit) { const content = {}; button.closest('[data-approval]').querySelectorAll('[data-form-field]').forEach(input => content[input.dataset.formField] = input.dataset.fieldType === 'boolean' ? input.checked : input.dataset.fieldType === 'array' ? input.value.split(',').map(item => item.trim()).filter(Boolean) : input.value); await api(`/api/approvals/${encodeURIComponent(button.dataset.formSubmit)}`,{content}); } await refresh(); });
function bridgeKey() { return `${bridgeMemberId}:${bridgeRoomId}`; }
function showBridgeError(message = '') { $('bridge-error').textContent = message; $('bridge-error').classList.toggle('hidden', !message); }
async function showBridge(id) {
  if (!roomId || legacyId) throw new Error('先打开这个成员所在的聊天室。');
  bridgeMemberId = id; bridgeRoomId = roomId; bridgeSetup = null; bridgeEntries = []; bridgeTest = null; bridgeEntriesSignature = '';
  const cached = bridgePrompts.get(bridgeKey()); $('bridge-group-label').value = cached?.groupLabel || ''; $('bridge-webhook-key').value = ''; $('bridge-webhook-url').value = ''; $('bridge-conversation-ref').value = ''; showBridgeError();
  if ($('member-setup-dialog').open) $('member-setup-dialog').close();
  renderBridge(); if (!$('bridge-dialog').open) $('bridge-dialog').showModal();
  try { await refreshBridge(); } catch (error) { showBridgeError(error.message); }
}
async function refreshBridge() {
  if (!$('bridge-dialog').open || !bridgeMemberId || !bridgeRoomId) return;
  if (bridgeLoading) { bridgeRefreshAgain = true; return; }
  bridgeLoading = true;
  const selected = bridgeKey(), query = `member_id=${encodeURIComponent(bridgeMemberId)}&room_id=${encodeURIComponent(bridgeRoomId)}`;
  try {
    const [setup, entries] = await Promise.all([api(`/api/bridge/setup?${query}`),api(`/api/bridge/entries?${query}`)]);
    if (selected !== bridgeKey()) return;
    bridgeSetup = setup; saveBridgeEntry(setup); bridgeEntries = Array.isArray(entries) ? entries : entries.entries || [];
    if (bridgeTest?.id && ['waiting','running','queued'].includes(bridgeTest.status || bridgeTest.state)) bridgeTest = await api(`/api/bridge/tests/${encodeURIComponent(bridgeTest.id)}`);
    renderBridge();
  } finally {
    bridgeLoading = false; clearTimeout(bridgeTimer);
    if ($('bridge-dialog').open && (bridgeRefreshAgain || ['waiting','running','queued'].includes(bridgeTest?.status || bridgeTest?.state))) { bridgeRefreshAgain = false; bridgeTimer = setTimeout(() => action(refreshBridge),1500); }
  }
}
function bridgeTestState(test) { return test?.status || test?.state || ''; }
function bridgeReported(entry) { const receipt = entry.native_delivery_receipt; return Boolean(entry.origin?.provider === 'grok-bot' && entry.status === 'delivered' && receipt && typeof receipt === 'object' && receipt.external_reply_id && receipt.conversation_ref && (!entry.origin.conversation_ref || receipt.conversation_ref === entry.origin.conversation_ref)); }
function bridgeReceipt(entry) { return entry.origin?.provider === 'grok-bot' && entry.return_verification === 'human_confirmed'; }
function renderBridge() {
  const setup = bridgeSetup || {}, member = setup.member || memberById(bridgeMemberId) || {}, cached = bridgePrompts.get(bridgeKey()), tests = setup.tests || [], stages = setup.stages || [], bindings = setup.bindings || [];
  const verified = setup.connection?.verified === true;
  const latestTest = bridgeTest || tests.find(test => ['waiting','running','queued'].includes(bridgeTestState(test))) || tests.find(test => bridgeTestState(test) === 'passed') || tests[0];
  const localVerified = tests.some(test => bridgeTestState(test) === 'passed' && test.actual_grok !== true) || (bridgeTestState(bridgeTest) === 'passed' && bridgeTest.actual_grok !== true);
  const nativeVerified = bridgeEntries.some(bridgeReceipt);
  const prepared = Boolean(cached || stages.some(stage => stage.id === 'prompt' && stage.state === 'complete'));
  $('bridge-heading').textContent = member.name ? `接入 ${member.name}` : '接入 Grok 桥接 Bot';
  $('bridge-prompt-state').textContent = cached ? '已生成 · 待交给 Grok' : prepared ? '已生成过 · 可重新获取' : '尚未生成'; $('bridge-prompt-state').className = 'bridge-step-state';
  $('bridge-setup-prompt').textContent = cached?.prompt || setup.setup_prompt || '正在加载接入说明…';
  $('bridge-copy-prompt').disabled = bridgeCopying;
  $('bridge-regenerate-prompt').disabled = bridgeCopying;
  const sameLabel = cached && cached.groupLabel === $('bridge-group-label').value.trim();
  $('bridge-copy-prompt').innerHTML = bridgeCopying ? '正在生成…' : sameLabel ? '复制完整说明 <span>↗</span>' : cached ? '按新名称生成并复制 <span>↗</span>' : prepared ? '重新生成并复制说明 <span>↗</span>' : '生成并复制完整说明 <span>↗</span>';
  $('bridge-copy-note').textContent = cached ? '请发给 Grok。入口长期保留，接入进度另行验证。' : prepared ? '已生成过说明。可再次复制同一个房间的入口。' : '说明会带上同一个房间的长期本机入口。';
  $('bridge-handshake-state').textContent = verified ? '本机握手已验证' : '等待 Bot 加入'; $('bridge-handshake-state').className = `bridge-step-state ${verified ? 'verified' : ''}`;
  $('bridge-handshake-detail').textContent = verified ? '这个桥接成员已执行真实本机握手。接下来分别确认协作通路和 Grok 原群回报。' : 'Grok Bot 执行本机加入握手后，这里才会显示已验证。复制说明、创建 Bot 和通信接通是不同的步骤。';
  $('bridge-stage-list').innerHTML = stages.map(stage => { const status = stage.id === 'native_return' && !nativeVerified && stage.state === 'complete' ? 'needs_action' : stage.state, prompt = stage.id === 'prompt', complete = status === 'complete' && !prompt, label = prompt ? '完整接入说明' : stage.label, detail = prompt ? status === 'complete' ? '仅表示说明已生成，仍需交给 Grok 执行。' : '先生成说明，再交给 Grok 安排创建与接入。' : stage.detail; return `<div class="bridge-stage ${complete ? 'complete' : ''}"><span class="bridge-stage-icon">${complete ? '✓' : '○'}</span><div><strong>${escape(label)}</strong>${detail ? `<small>${escape(detail)}</small>` : ''}</div><span>${prompt && status === 'complete' ? '已生成说明' : complete ? '已确认' : status === 'needs_action' ? '需要操作' : '待确认'}</span></div>`; }).join('');
  $('bridge-local-proof').textContent = localVerified ? '本机通路已验证' : ['waiting','running','queued'].includes(bridgeTestState(latestTest)) ? '检查中…' : ['failed','uncertain'].includes(bridgeTestState(latestTest)) ? '检查未完成' : '尚未测试'; $('bridge-local-proof').className = localVerified ? 'proof-verified' : '';
  $('bridge-native-proof').textContent = nativeVerified ? '你已确认原群回报' : bridgeEntries.some(bridgeReported) ? 'Bot 已报告 · 等待你核对' : '尚未验证'; $('bridge-native-proof').className = nativeVerified ? 'proof-verified' : '';
  const selectedTarget = $('bridge-test-target').value, targets = state?.chat?.members?.filter(item => ['codex','native'].includes(item.adapter) && (history?.participants || []).some(participant => participant.id === item.id)) || [];
  $('bridge-test-target').innerHTML = targets.length ? targets.map(target => `<option value="${escape(target.id)}">${escape(target.name)}</option>`).join('') : '<option value="">先给聊天室添加 Codex 成员</option>';
  if (targets.some(target => target.id === selectedTarget)) $('bridge-test-target').value = selectedTarget;
  const waiting = bridgeTesting || ['waiting','running','queued'].includes(bridgeTestState(bridgeTest)); $('bridge-run-test').disabled = waiting || !targets.length; $('bridge-run-test').textContent = waiting ? '检查中…' : '检查本机通路';
  $('bridge-test-result').classList.toggle('hidden', !latestTest);
  $('bridge-test-result').textContent = latestTest ? `${latestTest.summary || (waiting ? '正在独立测试房间验证本机通路…' : '测试状态已保存。')}${latestTest.error ? `\n${latestTest.error}` : ''}\n这是本机通路检查，Grok 原群回报仍需实际验证。` : '';
  $('bridge-binding-list').innerHTML = bindings.length ? bindings.map(binding => { const current = binding.mode === 'current-context' || bridgeEntries.some(entry => entry.binding_id === binding.id && entry.origin?.mode === 'current-context'); return `<div class="bridge-binding"><span>◌</span><div><strong>${escape(binding.label || (current ? '发起请求的当前对话' : 'Grok 来源'))}</strong><small>${binding.provider === 'local-test' ? '本机隔离测试来源 · 不涉及 Grok' : current ? '仅保存当前对话关联 · 尚无原群定位值' : '已保存来源引用 · 原群回报另行核对'}</small></div><span class="status-pill">${current ? '当前对话关联' : '来源已保存'}</span></div>`; }).join('') : '<p class="bridge-record-empty">尚未绑定原群。Bot 接入后可保存真实来源，你无需提前查找或猜测群 ID。</p>';
  const entriesSignature = JSON.stringify([bridgeKey(),bridgeEntries]);
  if (entriesSignature !== bridgeEntriesSignature) {
    $('bridge-entry-list').querySelectorAll('.bridge-confirm-form').forEach(form => bridgeConfirmDrafts.set(form.dataset.entryId,form.elements.verification_code.value));
    $('bridge-entry-list').innerHTML = bridgeEntries.length ? bridgeEntries.map(entry => {
      const confirmed = bridgeReceipt(entry), reported = bridgeReported(entry), eligible = entry.origin?.provider === 'grok-bot' && ['answered','delivered'].includes(entry.status) && !confirmed;
      return `<article class="bridge-entry"><div class="bridge-entry-header"><strong>${escape(entry.origin?.label || '原群请求')}</strong><span>→ ${escape(entry.target_member_name || '房间成员')}</span><time>${time(entry.created)}</time></div><div class="bridge-entry-status">${pill(entry.status,entry.status === 'delivered' && !confirmed ? 'Bot 已报告发送' : entry.status === 'answered' ? '本机已有回答' : undefined)}<span class="receipt-label ${confirmed ? 'verified' : ''}">${entry.origin?.provider === 'local-test' ? '本机隔离测试 · 不涉及 Grok' : confirmed ? '你已确认回复回到原群' : reported ? '桥接 Bot 已报告发回原群（待核对）' : entry.response_text ? '本机已有回答 · 原群回报待确认' : '等待处理与原群回报'}</span></div>${entry.response_text ? `<pre class="message-content">${escape(entry.response_text)}</pre>` : ''}${entry.error ? `<div class="error-note">${escape(entry.error)}</div>` : ''}${eligible ? `<form class="bridge-confirm-form" data-entry-id="${escape(entry.id)}"><label>请填写你在 Grok 原群答复中看到的确认码<input name="verification_code" placeholder="从原群答复里复制确认码" required autocomplete="off" maxlength="120"></label><button type="submit" class="secondary">确认回复回到原群</button></form>` : ''}</article>`;
    }).join('') : '<p class="bridge-record-empty">这里会显示 Bot 实际带入的请求和回复。生成说明不会产生成功收发记录。</p>';
    $('bridge-entry-list').querySelectorAll('.bridge-confirm-form').forEach(form => { form.elements.verification_code.value = bridgeConfirmDrafts.get(form.dataset.entryId) || ''; });
    bridgeEntriesSignature = entriesSignature;
  }
}
$('bridge-group-label').oninput = renderBridge;
$('bridge-copy-prompt').onclick = () => action(async () => {
  if (bridgeCopying) return; const selected = bridgeKey(); bridgeCopying = true; showBridgeError(); renderBridge();
  try {
    const cached = bridgePrompts.get(selected), groupLabel = $('bridge-group-label').value.trim();
    if (!cached || cached.groupLabel !== groupLabel) { const setup = await api('/api/bridge/setup',{member_id:bridgeMemberId,room_id:bridgeRoomId,group_label:groupLabel || undefined,regenerate_invite:cached ? true : undefined}); if (!setup.setup_prompt) throw new Error('尚未返回完整接入说明，请重试。'); saveBridgeEntry(setup); bridgePrompts.set(selected,{prompt:setup.setup_prompt,groupLabel}); if (selected !== bridgeKey()) return; bridgeSetup = setup; }
    if (selected !== bridgeKey()) return;
    await navigator.clipboard.writeText(bridgePrompts.get(selected).prompt); toast('完整说明已复制。把它发给 Grok，接入成功会另行验证。');
  } catch (error) { showBridgeError(bridgePrompts.has(bridgeKey()) ? `说明已生成，但复制未完成：${error.message}。可展开完整说明手动复制。` : error.message); if (bridgePrompts.has(bridgeKey())) $('bridge-prompt-preview').open = true; }
  finally { bridgeCopying = false; renderBridge(); }
});
$('bridge-regenerate-prompt').onclick = () => action(async () => {
  if (bridgeCopying) return; const selected = bridgeKey(); bridgeCopying = true; showBridgeError(); renderBridge();
  try { const groupLabel = $('bridge-group-label').value.trim(), setup = await api('/api/bridge/setup',{member_id:bridgeMemberId,room_id:bridgeRoomId,group_label:groupLabel || undefined,regenerate_invite:true}); if (!setup.setup_prompt) throw new Error('尚未返回完整接入说明，请重试。'); saveBridgeEntry(setup); bridgePrompts.set(selected,{prompt:setup.setup_prompt,groupLabel}); if (selected !== bridgeKey()) return; bridgeSetup = setup; toast('接入说明已重新生成。点击复制，把新的说明交给 Grok。'); }
  catch (error) { showBridgeError(error.message); }
  finally { bridgeCopying = false; renderBridge(); }
});
$('bridge-refresh').onclick = () => action(async () => { showBridgeError(); try { await refreshBridge(); } catch (error) { showBridgeError(error.message); } });
$('bridge-refresh-records').onclick = $('bridge-refresh').onclick;
$('bridge-run-test').onclick = () => action(async () => {
  if (bridgeTesting || !$('bridge-test-target').value) return; const selected = bridgeKey(); bridgeTesting = true; showBridgeError(); renderBridge();
  try { const test = await api('/api/bridge/test',{member_id:bridgeMemberId,room_id:bridgeRoomId,target_member_id:$('bridge-test-target').value}); if (selected !== bridgeKey()) return; bridgeTest = {id:test.test_id,status:test.status || 'waiting',actual_grok:test.actual_grok,summary:'正在独立测试房间验证本机入口与 Codex 回复…'}; await refreshBridge(); }
  catch (error) { showBridgeError(error.message); }
  finally { bridgeTesting = false; renderBridge(); }
});
$('bridge-bind-form').onsubmit = event => { event.preventDefault(); action(async () => { const button = $('bridge-bind-form').querySelector('button'); button.disabled = true; try { await api('/api/bridge/bind',{member_id:bridgeMemberId,room_id:bridgeRoomId,provider:'grok-bot',conversation_ref:$('bridge-conversation-ref').value.trim(),label:$('bridge-group-label').value.trim() || undefined}); $('bridge-conversation-ref').value = ''; await refreshBridge(); toast('原群引用已保存，实际回报仍会单独验证。'); } catch (error) { showBridgeError(error.message); } finally { button.disabled = false; } }); };
$('bridge-webhook-form').onsubmit = event => { event.preventDefault(); action(async () => { const button = $('bridge-webhook-form').querySelector('button'); button.disabled = true; try { await api(`/api/chat/members/${encodeURIComponent(bridgeMemberId)}/grok-configure`,{url:$('bridge-webhook-url').value,key:$('bridge-webhook-key').value}); $('bridge-webhook-key').value = ''; $('bridge-webhook-url').value = ''; toast('桥接 Bot 通知连接已加密保存。'); await refreshBridge(); } catch (error) { showBridgeError(error.message); } finally { button.disabled = false; } }); };
$('bridge-entry-list').addEventListener('submit',event => {
  const form = event.target.closest('.bridge-confirm-form'); if (!form) return; event.preventDefault();
  action(async () => { const button = form.querySelector('button'), code = form.elements.verification_code.value.trim(); if (!code) return; button.disabled = true; showBridgeError(); try { await api(`/api/bridge/entries/${encodeURIComponent(form.dataset.entryId)}/confirm-return`,{verification_code:code}); bridgeConfirmDrafts.delete(form.dataset.entryId); form.elements.verification_code.value = ''; await refreshBridge(); toast('已保存你对原群回报的确认。'); } catch (error) { showBridgeError(error.message); } finally { button.disabled = false; } });
});
$('bridge-leave-member').onclick = () => action(async () => { await api(`/api/chat/rooms/${encodeURIComponent(bridgeRoomId)}/leave`,{member_id:bridgeMemberId}); $('bridge-dialog').close(); await refresh(); toast('成员已移出这个房间，之前的消息仍保留。'); });
$('bridge-dialog').addEventListener('close',() => { clearTimeout(bridgeTimer); $('bridge-webhook-key').value = ''; });
function connectEvents() { if (desktop?.offline) return; events?.close(); events = new EventSource('/api/events'); events.addEventListener('update',scheduleRefresh); events.onopen = scheduleRefresh; events.onerror = () => { setWebConnected(false);checkDesktopTransport(); $('footer-status').textContent = '处理程序未连接 · 已有成员入口可恢复房间'; setTimeout(() => action(refresh),1500); }; }
if (!desktop?.offline) connectEvents();
setInterval(() => { if (!document.hidden && (webConnected || desktop?.offline)) action(refresh); },15000);
document.addEventListener('visibilitychange',() => { if (!document.hidden) action(refresh); });
if (desktop) action(async () => {
  desktopState=await desktop.command('state'); desktopReady=true;
  const selected=desktopState?.snapshot?.chat?.rooms?.find(room=>room.id===desktopState.selected_room_id);
  if (selected) {roomId=selected.id;projectId=selected.project_id;}
  renderService(); await refresh();
});
else action(refresh);
