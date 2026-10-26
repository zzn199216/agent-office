'use strict';
const viewTimers=window.AgentOfficePageActivity.create({document,host:window,onChange:handleViewActivity});
const setUITimeout=viewTimers.setTimeout,clearUITimeout=viewTimers.clearTimeout,setUIInterval=viewTimers.setInterval;
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
const onboardingFeedback = new Map();
const approvalResponding=new Set();
let onboardingTimer = null, onboardingFetching = false, onboardingSignature = '';
const desktop = window.AgentRoomDesktop || null;
let desktopState = null, desktopBusy = false, desktopReady = false, desktopProbe = null;
let desktopOperation = null, desktopError = '', desktopErrorSource = null;
let inspectorOpen = false, inspectorTab = 'members', inspectorMemberId = null, officeView = (()=>{try{return localStorage.getItem('agentoffice-room-view') !== 'chat';}catch{return true;}})(), officeScene = null, appearanceDraft = null, appearanceDirty = false, appearanceBusy = false, appearanceUploading = false, appearanceUploadVersion = 0;
let officeComposerOpen = false;
let connectionDoctor = null, connectionDoctorBusy = false, connectionDoctorError = '', connectionDoctorRoom = null, connectionDoctorSequence = 0;
let nativeSetupPending = null, nativeSetupFailure = null;
let grokSetupWatch = null, grokSetupWatchTimer = null, grokSetupWatchSequence = 0, grokSetupWatchError = '';
let deleteRoomId = null, deletingRoom = false, deletePreview = null;
let managedRoomId=null,managingRoom=false;
let secretaryOpenRoom = null, secretaryPickingRoom = null, secretaryBusy = false, secretaryStartBusy = false, secretaryError = '', secretaryConnectRoom = null, secretaryConnectJob = null, secretaryGoalVersion = 0;
let secretaryFinishing=false, secretaryNavigation=null;
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
const sceneDefaults = Object.freeze({time_zone:'auto',time_mode:'auto',lights_on:true,auto_layout:true,columns:3,spacing:1,wall_color:'#f8f7f3',floor_color:'#faf7ef',show_window:true,show_clock:true,show_plant:true,motion:true});
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
function nativeConnectionUnavailable(member={}){
  const connection=member?.desktop_connection;
  return !!connection&&!['manual','manual_mcp','configured_notification'].includes(member.connection_method)&&member.response_mode!=='manual_mailbox'&&connection.configured===true&&connection.can_wake===false&&(['offline','error','failed','reconnecting'].includes(connection.state)||!!connection.error);
}
function nativeConnectionMessage(value,member){return value==='fetch failed'&&nativeConnectionUnavailable(member)?'本人对话尚未连接。请查看这位成员的连接步骤，开启客户端连接后继续。':value;}
function nativeMemberEvidence(member={},fallback={}){const evidence=member?.runtime_state?.connection_evidence||fallback;return nativeConnectionUnavailable(member)?{...evidence,native_conversation_loaded:false,model_reply_verified:false,automatic_reply_verified:false}:evidence;}
function memberPresence(member = {}) {
  const observed = {...runtimeMember(member.id),...member.runtime_state}, value = member.presence || observed.presence || 'unknown';
  if(['connection_failed','failed','disabled','revoked','unavailable'].includes(member.status))return {status:'unavailable',label:'连接不可用 · 需重新接入',lastSeen:member.last_seen||observed.last_seen||null,canWake:false};
  if(nativeConnectionUnavailable(member))return {status:'offline',label:webConnected?'本人对话未连接 · 查看连接':'服务已关闭',lastSeen:member.last_seen||observed.last_seen||null,canWake:false};
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
function setWebConnected(connected) { webConnected = connected; renderRuntime(); renderLaunch(); renderService(); renderInspector(); renderSecretary(); updateOfficeScene(); updateRecipientNote(); if ($('resume-dialog').open) renderResume(); }
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
function nativeDesktopProvider(value) { return ['qwen-desktop','doubao','grok-bot'].includes(value?.provider || value?.id); }
function grokGuidedPerson(value){return (value?.provider==='grok-bot'||value?.adapter==='grok-bridge')&&value?.runtime_state?.connection_evidence?.native_conversation_loaded!==true;}
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
function onboardingRunning(job) { return job && !onboardingRepairRequired(job) && !onboardingRecheckPending(job) && ['running','queued','pending','detecting','installing','configuring','starting','handshaking','waiting'].includes(job.status); }
function onboardingRepairRequired(job){return job?.stage==='connection_repair_required'||['codex_auth_ownership_required','codex_personal_auth_owner_conflict'].includes(job?.error_code);}
function onboardingRecheckPending(job){return job?.stage==='connection_recheck_available';}
function onboardingCanRecheck(job){return onboardingRecheckPending(job)&&!onboardingRepairRequired(job)&&job.auth_mode==='shared-cache'&&job.recheck_auth_revision==='native-shared-cache-v1';}
function onboardingReady(job) {
  if(onboardingRepairRequired(job)||onboardingRecheckPending(job))return null;
  const ready=['ready_automatic','ready_mailbox'].includes(job?.status)?job.status:job?.status==='ready'&&['ready_automatic','ready_mailbox'].includes(job.stage)?job.stage:null;
  return job?.ready_for_office===false?null:ready;
}
function onboardingOfficeReady(job){
  const ready=onboardingReady(job);if(!ready||job?.ready_for_office!==true)return false;
  const native=job.connection_method==='native_desktop'||job.response_mode==='managed_desktop'||['qwen-desktop','doubao'].includes(job.provider)&&job.connection_method!=='manual_mcp';
  return !native||ready==='ready_automatic'&&job.can_wake===true;
}
function activeOnboardingJob(){const flow=typeof secretaryNavigation==='undefined'?null:secretaryNavigation;return flow?.roomId===roomId&&flow.projectId===projectId?onboardingJobs.get(flow.jobId):null;}
function onboardingForProvider(provider) { const active=activeOnboardingJob();if(active?.provider===provider&&(!active.room_id||active.room_id===roomId))return active;return [...onboardingJobs.values()].filter(job => job.provider === provider && (!job.room_id || job.room_id === roomId)).sort((a,b) => String(b.updated_at || b.updated || b.created_at || b.created || '').localeCompare(String(a.updated_at || a.updated || a.created_at || a.created || '')))[0]; }
function currentOnboardingJobs() { const providers = new Map(); for (const job of [...onboardingJobs.values()].filter(job => (!job.room_id || job.room_id === roomId) && (!job.project_id || job.project_id === projectId)).sort((a,b) => String(b.created_at || b.created || b.updated_at || b.updated || '').localeCompare(String(a.created_at || a.created || a.updated_at || a.updated || '')))) if (!providers.has(job.provider)) providers.set(job.provider,job);const active=activeOnboardingJob();if(active&&(!active.room_id||active.room_id===roomId)&&(!active.project_id||active.project_id===projectId))providers.set(active.provider,active);return [...providers.values()]; }
function renderLaunchCandidates() {
  const signature = JSON.stringify([launchScanning,launchBusy,launchCandidates,webConnected,projectId,[...onboardingStarting],[...onboardingJobs.values()].map(job => [job.id,job.status,job.stage,job.ready_for_office,job.updated_at||job.updated]),typeof onboardingFeedback==='undefined'?[]:[...onboardingFeedback]]);
  if (signature === lastLaunchCandidates) { $('launch-candidates').querySelectorAll('[data-launch-provider]').forEach(input => { input.checked = launchSelection.has(input.dataset.launchProvider); }); return; }
  lastLaunchCandidates = signature;
  const othersOpen = $('launch-candidates').querySelector('.launch-other-candidates')?.open === true;
  if (launchScanning) { $('launch-candidates').innerHTML = '<div class="launch-scan-note"><span class="pulse-dot"></span> 正在查看本机安装和运行情况…</div>'; return; }
  if (!launchCandidates) { $('launch-candidates').innerHTML = '<div class="launch-scan-note">点击扫描，找到想接入的成员，再点“一键接入”。</div>'; return; }
  const visible = launchCandidates.filter(candidate => candidate.id !== 'mailbox' && (candidate.installed || candidate.running || onboardingCanInstall(candidate) || candidate.capabilities?.automatic_launch || candidate.capabilities?.mcp_prepare));
  const renderCandidate = candidate => {
    const provider = launchProvider(candidate), selectable = launchSelectable(candidate), canJoin = onboardingSelectable(candidate), mode = onboardingMode(candidate), job = onboardingForProvider(provider), feedback=typeof onboardingFeedback==='undefined'?null:onboardingFeedback.get(job?.id),pending = onboardingStarting.has(provider) || onboardingRunning(job) || feedback?.pending;
    const availability = onboardingRepairRequired(job)?'连接已暂停 · 保护桌面登录':onboardingRecheckPending(job)?'已有登录可复用 · 等待重新验证':job?.stage==='awaiting_auth'?provider==='codex'?'请先在原 Codex 窗口登录 · 尚未接通':'需要后台账号授权 · 尚未接通':onboardingOfficeReady(job)?job.can_wake?'本次连接已验证 · 可以自动处理消息':'本次信箱连接已验证 · 需要本人窗口处理':pending?'正在验证本次连接':job?.error?'本次接入尚未完成 · 请查看下方原因':!canJoin ? candidate.support === 'unsupported' ? '已发现，接口待适配' : !candidate.installed ? mode === 'managed' ? '需安装官方 CLI · 查看说明' : '尚未安装 · 查看官方接入说明' : '已发现 · 待适配' : !candidate.installed ? '尚未安装 · 可安装接入' : candidate.running ? '已发现本机进程 · 尚未验证 AO 连接' : '已安装 · 尚未接入';
    const guidedGrok=provider==='grok-bot'&&candidate.capabilities?.native_direct_available!==true,native = nativeDesktopProvider(candidate)&&!guidedGrok, label = onboardingRepairRequired(job)?'查看连接保护说明':onboardingRecheckPending(job)?'查看重新验证步骤':feedback?.pending&&feedback.operation==='login_client'?'正在打开配置…':pending ? '正在接入…' : onboardingOfficeReady(job) ? '进入办公室' : job?.stage==='awaiting_auth'?provider==='codex'?'查看登录状态':'继续账号授权':job?.status === 'needs_action' ? '继续接入' : !candidate.installed && canJoin ? '安装并接入' : guidedGrok?'连接 Grok':native ? '连接本人对话' : '一键接入';
    const accountNote = guidedGrok?'复制一次说明到已有 Grok Bot，AO 自动检查；无需先建群':native ? provider === 'grok-bot' ? '为这位同事保留专用 Bot，连接后核对实际回复' : '沿用本人客户端的登录，为这位同事保留原生对话' : mode === 'bridge' ? '复用桥接 Bot 的本人窗口；复制接入说明后完成实际握手' : provider==='codex'?'沿用原 Codex 登录缓存，连接仍需本次真实验证':provider === 'qwen-code' ? '首次配置 API 或 Token 计划凭据' : provider === 'gemini-cli' ? '使用 Gemini CLI 自己的账号或 API；网页登录不会自动代替' : '';
    return `<article class="launch-candidate ${canJoin ? '' : 'unavailable'}"><label class="launch-candidate-select"><input type="checkbox" data-launch-provider="${escape(provider)}" aria-label="批量选择 ${escape(candidate.name || provider)}" ${launchSelection.has(provider) ? 'checked' : ''} ${selectable && !launchBusy ? '' : 'disabled'}></label>${avatar(candidate.name,provider)}<div class="launch-candidate-info"><strong>${escape(candidate.name || provider)}</strong><span class="launch-mode ${mode === 'managed' && canJoin ? 'automatic' : ''}">${escape(native ? '本人对话 · 连接后验证' : mode === 'bridge' ? '本人窗口 · 桥接' : mode === 'managed' ? '后台 CLI · 独立会话' : candidate.capabilities?.mcp_prepare ? '本人 MCP · 信箱' : '接口待适配')}</span><small>${escape(availability)}</small>${accountNote ? `<small>${escape(accountNote)}</small>` : ''}</div><button type="button" class="${canJoin ? 'primary' : 'secondary'} onboarding-start" ${canJoin ? 'data-onboarding-provider' : 'data-onboarding-requirements'}="${escape(provider)}" aria-label="${escape(candidate.name || provider)} ${escape(canJoin ? label : '查看接入要求')}" ${!pending && !launchBusy && !launchScanning && (webConnected || !canJoin) ? '' : 'disabled'}>${escape(canJoin ? label : '查看接入要求')}</button></article>`;
  };
  const running = visible.filter(candidate => candidate.running === true), others = visible.filter(candidate => candidate.running !== true);
  $('launch-candidates').innerHTML = (running.length ? running.map(renderCandidate).join('') : '<div class="launch-scan-note">未发现正在运行的成员。可以打开 AI 应用后重新扫描，或展开其他候选。</div>') + (others.length ? `<details class="launch-other-candidates" ${othersOpen ? 'open' : ''}><summary>其他已安装 / 可安装的成员（${others.length}）</summary>${others.map(renderCandidate).join('')}</details>` : '');
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
  clearUITimeout(launchTimer); if (!roomId || legacyId || !webConnected) { launchSession = null; renderLaunch(); return; }
  if (launchFetching) { launchAgain = true; return; } launchFetching = true; const selected = roomId;
  try { const response = await api(`/api/launch/state?room_id=${encodeURIComponent(selected)}`); if (selected !== roomId) return; launchSession = launchView(response); renderLaunch();renderInspector(); }
  catch (error) { if (selected === roomId) { launchError = error.message; renderLaunch(); } }
  finally { launchFetching = false; if (launchAgain) { launchAgain = false; launchTimer = setUITimeout(() => action(refreshLaunch),200); } else if (launchSession?.status === 'preparing') launchTimer = setUITimeout(() => action(refreshLaunch),2000); }
}
async function scanLaunch({quiet = false} = {}) {
  if (launchScanning || launchBusy) return;
  launchScanning = true; launchError = ''; renderLaunch();
  try { const result = await api('/api/launch/scan',{}); launchCandidates = result.candidates || []; launchScannedAt = result.scanned_at || result.at || new Date().toISOString(); launchSelection.clear(); if (!quiet) toast('扫描完成。点击成员旁的“一键接入”。'); }
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
let mirrorRoom = null, mirrorSession = null, mirrorBusy = false, mirrorTimer = null, mirrorDispatched = null;
function renderMirror(session) {
  if (!$('mirror-dialog').open || mirrorRoom !== roomId) return;
  mirrorSession = session;
  const selected = (session.proxies || []).filter(p => (session.selected_providers || []).includes(p.provider));
  const bound = selected.some(p => p.native_group_ref), reported = session.group_operation?.status === 'reported', membersReady = selected.every(p => p.local_verified) && !session.selected_handshakes?.length;
  $('mirror-status').textContent = session.status === 'preparing' ? '正在准备所选成员…' : session.dispatch_error ? session.dispatch_error : !membersReady ? '请先在成员连接中接通所选 AI，接通后会继续处理。' : session.group_operation?.status === 'needs_review' ? 'Grok 已回复，但本次群操作尚未确认完成。请查看对话中的结果。' : reported ? selected.every(p => p.can_wake) ? 'Grok 已回报建群，成员可以自动处理；请在群内验证回答。' : 'Grok 已回报建群，部分 AI 的自动连接还需恢复。' : session.group_operation?.message_id || mirrorDispatched === session.id ? '建群请求已发送给 Grok，等待实际建群回报。' : session.handoff_file ? '建群请求已准备，等待 Grok 创建群。' : '选择成员后创建；也可以直接在 Grok 对 Bot 提出建群请求。';
  $('mirror-members-status').innerHTML = selected.map(p => `<p>${escape(p.name)}：${p.can_wake ? '可自动处理' : '自动连接未就绪'} · ${p.native_group_ref ? 'Grok 已回报入群' : '等待入群'}</p>`).join('');
  $('mirror-create').textContent = bound ? '更新所选成员' : '创建镜像群';
  $('mirror-create').disabled = mirrorBusy || session.status === 'preparing' || ['pending','needs_review'].includes(session.group_operation?.status);
  $('mirror-prompt').textContent = session.grok_prompt || '';
  $('mirror-handoff').classList.toggle('hidden', !session.handoff_file || !membersReady || session.status === 'preparing' || !!reported || !!session.group_operation?.message_id || mirrorDispatched === session.id);
  const bridgeId=session.group_operation?.bridge_member_id||session.dispatch_member_id,bridge=bridgeId&&memberById(bridgeId);
  if(bridge&&!Array.from($('mirror-bridge').options).some(option=>option.value===bridge.id))$('mirror-bridge').add(new Option(bridge.name,bridge.id));
  if(bridgeId&&!$('mirror-bridge').value)$('mirror-bridge').value=bridgeId;
}
async function refreshMirror() {
  const selected = mirrorRoom, sessionId = mirrorSession?.id;
  if (!selected || selected !== roomId) return;
  const session = await api(`/api/launch/state?${sessionId ? `session_id=${encodeURIComponent(sessionId)}` : `room_id=${encodeURIComponent(selected)}`}`);
  if (selected === roomId && mirrorRoom === selected) renderMirror(session);
}
async function showMirror() {
  if (!roomId || legacyId || !history?.room) { toast('请先选择聊天室。'); return; }
  mirrorRoom = roomId; mirrorSession = null; $('mirror-error').textContent = '';
  $('mirror-name').value = `Agent Office · ${history.room.title} · 手机协作`;
  const people = (history.participants || []).filter(p => !['grok-proxy','grok-bridge'].includes(p.adapter));
  $('mirror-members').innerHTML = '<legend>选择入群的 AI</legend>' + people.map(p => `<label class="checkbox-row"><input type="checkbox" name="mirror-provider" value="${escape(p.provider || p.adapter)}">${escape(p.name)}</label>`).join('');
  $('mirror-bridge').innerHTML = (history.participants || []).filter(p => p.adapter === 'grok-bridge').map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('') || '<option value="">自动使用已接通的 Grok Bot</option>';
  $('mirror-handoff').classList.add('hidden'); $('mirror-dialog').showModal(); await refreshMirror();
  clearUITimeout(mirrorTimer); mirrorTimer = setUITimeout(() => action(pollMirror),2000);
}
async function pollMirror() {
  if (!$('mirror-dialog').open || mirrorRoom !== roomId) return;
  try { await dispatchMirror(); } finally {
    if ($('mirror-dialog').open && mirrorRoom === roomId) mirrorTimer = setUITimeout(() => action(pollMirror),3000);
  }
}
async function createMirror(event) {
  event.preventDefault(); if (mirrorBusy || mirrorRoom !== roomId) return;
  const selected = mirrorRoom, providers = [...new Set([...$('mirror-members').querySelectorAll('input:checked')].map(el => el.value))];
  if (!providers.length) { $('mirror-error').textContent = '请勾选要入群的 AI。'; return; }
  mirrorBusy = true; $('mirror-create').disabled = true; $('mirror-error').textContent = '';
  try {
    const session = await api('/api/launch/prepare',{room_id:selected,providers,group_name:$('mirror-name').value.trim(),install_clients:false,dispatch:true,dispatch_member_id:$('mirror-bridge').value||undefined});
    if (selected !== roomId || selected !== mirrorRoom) return;
    renderMirror(session);
  } catch (error) { if (selected === mirrorRoom) $('mirror-error').textContent = error.message; }
  finally { mirrorBusy = false; if (mirrorSession) renderMirror(mirrorSession); }
}
async function dispatchMirror() {
  await refreshMirror();
  if (!mirrorSession?.handoff_file || mirrorSession.status === 'preparing' || mirrorRoom !== roomId) return;
  if (mirrorSession.selected_handshakes?.length || (mirrorSession.proxies || []).some(p => mirrorSession.selected_providers?.includes(p.provider) && !p.local_verified)) return;
  if (mirrorDispatched === mirrorSession.id || mirrorSession.group_operation?.message_id || mirrorSession.group_operation?.status === 'reported' || !mirrorSession.dispatch_requested) return;
  const selected = mirrorRoom, memberId = $('mirror-bridge').value;
  if (!memberId) return;
  const result = await api('/api/launch/dispatch',{session_id:mirrorSession.id,member_id:memberId});
  if (selected !== roomId || selected !== mirrorRoom) return;
  if (result.dispatch?.status === 'queued') { mirrorDispatched = mirrorSession.id; renderMirror(result); }
}
function captureOnboardingAttempt(job){
  return {flow:secretaryNavigation,roomId,projectId,jobId:job.id,provider:job.provider,memberId:job.member_id||null,pickerJobId:secretaryConnectJob,pickerRoomId:secretaryConnectRoom};
}
function activateOnboardingOperation(job){
  if(job.room_id!==roomId||legacyId)throw Error('这次接入不属于当前房间，请回到原房间查看。');
  if($('secretary-connect-dialog').open&&secretaryConnectRoom===roomId&&!secretaryNavigationCurrent(secretaryNavigation)){
    const flow=beginSecretaryNavigation('picker');flow.jobId=job.id;secretaryConnectJob=job.id;
  }
}
function onboardingAttemptCurrent(attempt){return !!attempt&&attempt.roomId===roomId&&attempt.projectId===projectId&&attempt.flow===secretaryNavigation&&!legacyId;}
function adoptOnboardingJob(value,previous,attempt){
  const job=onboardingView(value);if(!job?.id)throw Error('尚未返回接入记录。请检查当前进度，不要重复发起。');
  if(previous&&(job.provider!==previous.provider||job.room_id!==previous.room_id||previous.member_id&&job.member_id&&job.member_id!==previous.member_id))throw Error('接入返回的成员或房间不匹配，原连接记录保留。');
  onboardingJobs.set(job.id,job);
  if(previous&&job.id!==previous.id&&typeof onboardingFeedback!=='undefined'&&onboardingFeedback.has(previous.id)){onboardingFeedback.set(job.id,onboardingFeedback.get(previous.id));onboardingFeedback.delete(previous.id);}
  const current=onboardingAttemptCurrent(attempt);
  if(current&&attempt.flow&&secretaryNavigationCurrent(attempt.flow)&&attempt.flow.jobId===previous?.id){attempt.flow.jobId=job.id;if(!attempt.flow.memberId&&job.member_id)attempt.flow.memberId=job.member_id;}
  if(current&&previous&&secretaryConnectRoom===attempt.pickerRoomId&&secretaryConnectJob===previous.id&&attempt.pickerJobId===previous.id)secretaryConnectJob=job.id;
  return job;
}
function onboardingActions(job) { const actions = job.next_actions || job.actions; return Array.isArray(actions) && actions.length ? actions : job.action || job.next_action ? [job.action || job.next_action] : []; }
function revealOnboardingAction(job){
  const flow=secretaryNavigation;
  if(!secretaryNavigationCurrent(flow)||flow.source!=='picker'||flow.jobId!==job?.id||secretaryConnectRoom!==roomId||!$('secretary-connect-dialog').open||!['needs_action','failed','error','interrupted'].includes(job.status))return false;
  const node=$('secretary-connect-progress').querySelector('.onboarding-action');if(!node)return false;
  const key=JSON.stringify([job.id,job.stage,onboardingActions(job).map(value=>value.operation||value.kind||value.type)]);
  flow.revealedOnboardingActions ||= new Set();
  if(!flow.revealedOnboardingActions.has(key)){flow.revealedOnboardingActions.add(key);node.scrollIntoView?.({block:'nearest'});}
  return true;
}
function onboardingFeedbackFor(job){return typeof onboardingFeedback==='undefined'?null:onboardingFeedback.get(job?.id)||null;}
function onboardingFeedbackMarkup(job){const feedback=onboardingFeedbackFor(job),step=onboardingAction(job);if(!feedback||!feedback.pending&&[job.message||job.detail,step?.detail||step?.description].some(value=>typeof value==='string'&&value.trim()===feedback.message.trim()))return '';return `<p class="${feedback.error?'error-note':'onboarding-job-detail'}" data-onboarding-feedback="${escape(job.id)}" role="${feedback.error?'alert':'status'}">${escape(feedback.message)}</p>`;}
function setOnboardingFeedback(job,message,{pending=false,error=false,operation=null}={}){
  onboardingFeedback.set(job.id,{message,pending,error,operation});renderLaunch();
  if($('secretary-connect-dialog').open){const node=$('secretary-connect-progress').querySelector('[data-onboarding-feedback]');if(node?.dataset.onboardingFeedback===job.id)node.scrollIntoView?.({block:'nearest'});}
}
async function runOnboardingOperation(job,operation){
  if(onboardingFeedbackFor(job)?.pending)return;
  activateOnboardingOperation(job);
  if(onboardingRepairRequired(job)){
    if(operation==='choose_connected_member'&&onboardingActions(job).some(value=>value.operation==='choose_connected_member')){
      secretaryNavigation=null;secretaryConnectJob=null;if($('secretary-connect-dialog').open)$('secretary-connect-dialog').close();openSecretaryTutorial();return job;
    }
    setOnboardingFeedback(job,'Codex 后台连接已暂停，避免影响你的登录。点「查看处理办法」了解怎么恢复。',{error:true,operation});return job;
  }
  if(onboardingRecheckPending(job)&&(!onboardingCanRecheck(job)||operation!=='retry'||!onboardingActions(job).some(value=>value.operation==='retry'))||job.provider==='codex'&&operation==='login_client'){
    setOnboardingFeedback(job,onboardingRecheckPending(job)?'请点「重新验证连接」。':'请先在 Codex 里登录，再点「我已登录，重新检查」。',{error:true,operation});return job;
  }
  const attempt=captureOnboardingAttempt(job);let current=job;
  setOnboardingFeedback(job,operation==='login_client'?'正在打开账号配置入口，请稍候…':operation==='open_native_client'?'正在开启客户端连接，请稍候…':operation==='manual_mcp'?'正在切换到 MCP 连接…':'正在连接…',{pending:true,operation});
  try{
    if(job.room_id!==attempt.roomId||legacyId)throw Error('这次接入不属于当前房间，请回到原房间查看。');
    if(operation==='open_fixed_room')return await openOnboardingFixedRoom(job);
    let response;
    if(operation==='manual_mcp'){
      if(!job.member_id||job.room_id!==attempt.roomId||!onboardingActions(job).some(value=>value.operation==='manual_mcp'&&value.target_member_id===job.member_id))throw Error('连接状态已更新，请刷新后再试。');
      response=await api('/api/onboarding/start',{room_id:job.room_id,provider:job.provider,target_member_id:job.member_id,connection_method:'manual_mcp'});
    }else if(operation==='reauthorize')response=await reauthorizeOnboarding(job,attempt);
    else response=operation==='retry'||operation==='install_runtime'?await api(`/api/onboarding/jobs/${encodeURIComponent(job.id)}/retry`,operation==='install_runtime'?{install_runtime:true}:{}):await api('/api/onboarding/action',{run_id:job.id,operation});
    if(!response)return;
    current=adoptOnboardingJob(response,job,attempt);
    if(operation==='login_client'&&response.action?.launched!==true)throw Error('登录页没有打开，请重试。');
    const message=response.action?.instruction||(operation==='login_client'?'登录页已打开。登录完成后点「登录后重新检查」。':operation==='manual_mcp'?'已切换到 MCP。点「复制配置」加到客户端，再点「复制那句话」发给它。':'正在核对连接…');
    setOnboardingFeedback(current,message,{operation});
    returnSecretaryAfterOnboarding();action(refresh);action(refreshOnboarding);return current;
  }catch(error){setOnboardingFeedback(current,error.message||'这一步未完成，请检查当前接入进度。',{error:true,operation});throw error;}
  finally{const feedback=onboardingFeedbackFor(current);if(feedback?.pending)setOnboardingFeedback(current,feedback.message,{...feedback,pending:false});}
}
function onboardingAction(job) { return onboardingActions(job)[0] || null; }
async function openOnboardingFixedRoom(job){
  const step=onboardingActions(job).find(value=>value.operation==='open_fixed_room'&&value.target_member_id===job.member_id),target=state?.chat?.rooms?.find(value=>value.id===step?.room_id);
  if(!step||!target||!job.member_id)throw Error('原房间暂不可用。请保留现有人物，在房间列表检查原连接。');
  secretaryNavigation=null;if($('secretary-connect-dialog').open)$('secretary-connect-dialog').close();if($('member-setup-dialog').open)$('member-setup-dialog').close();
  roomId=target.id;projectId=target.project_id;legacyId=null;rememberSelection();setReply(null);setProfessionalView(true);await refresh();
  if(roomId===target.id&&!legacyId)await showMemberSetup(job.member_id);
}
async function reauthorizeOnboarding(job,attempt=captureOnboardingAttempt(job)){
  const step=onboardingActions(job).find(value=>value.operation==='reauthorize'&&value.target_member_id===job.member_id),selectedRoom=roomId;
  if(!step||!job.member_id||job.room_id!==selectedRoom||legacyId)throw Error('这位成员的授权步骤已变化，请查看当前接入进度。');
  const updated=onboardingView(await api('/api/onboarding/start',{room_id:selectedRoom,provider:job.provider,target_member_id:job.member_id,reauthorize:true}));
  if(roomId!==selectedRoom)return null;
  if(updated?.member_id&&updated.member_id!==job.member_id)throw Error('返回的接入人物不匹配，原人物和连接保留。');
  return adoptOnboardingJob(updated,job,attempt);
}
// A connection that waits for the user's approval must ask right here, where
// the user is looking, not only in the chat room's approval panel.
function onboardingApprovalMarkup(job) {
  const pending = (state?.approvals || []).filter(approval => job.member_id && approval.request_id === `connect:${job.member_id}`);
  return pending.map(approval => `<div class="onboarding-approval" data-approval="${escape(approval.id)}"><strong>${escape(job.name || '这位成员')}需要你确认一步才能继续</strong>${approvalContentMarkup(approval,'data-onboarding-approve')}</div>`).join('');
}
function tickOnboardingElapsed() { for (const span of document.querySelectorAll('.onboarding-elapsed[data-since]')) { const seconds = Math.max(0, Math.round((Date.now() - Date.parse(span.dataset.since)) / 1000)); span.textContent = `已用 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}${seconds > 90 ? ' · 比平时久，可能在等登录或确认' : ''}`; } }
setUIInterval(tickOnboardingElapsed, 1000);
function onboardingJobMarkup(job) {
  // Same panel as the chat card; internal stage and backend wording stay out
  // of the list (errors remain under 详情).
  if(!job?.presentation)return '';
  return `<article class="onboarding-job ${job.presentation.state==='attention'?'failed':['connected','auto'].includes(job.presentation.state)?'ready':''}" data-onboarding-job="${escape(job.id)}"><div class="onboarding-job-heading">${avatar(job.presentation.name||job.name||job.provider,job.provider)}<div><strong>${escape(job.presentation.name||job.name||job.provider)}</strong></div></div>${connectionPanelMarkup(job.presentation,{source:'job',id:job.id},{pending:onboardingFeedbackFor(job)?.pending===true})}${job.presentation.busy?onboardingApprovalMarkup(job):''}${onboardingFeedbackFor(job)?.message&&onboardingFeedbackFor(job).message===job.presentation.details?.error?'':onboardingFeedbackMarkup(job)}</article>`;
}
function renderOnboarding() {
  const jobs = currentOnboardingJobs();
  $('onboarding-progress').classList.toggle('hidden',!jobs.length);
  const signature = JSON.stringify([jobs,webConnected,state?.approvals || [],typeof onboardingFeedback==='undefined'?[]:[...onboardingFeedback]]); if (signature === onboardingSignature) return; onboardingSignature = signature;
  setApprovalMarkup($('onboarding-jobs'),jobs.map(onboardingJobMarkup).join(''),state?.approvals||[]);tickOnboardingElapsed();
}
async function refreshOnboarding() {
  clearUITimeout(onboardingTimer); if (!webConnected || onboardingFetching) return; onboardingFetching = true;
  try {
    const response = await api(`/api/onboarding/jobs${roomId ? `?room_id=${encodeURIComponent(roomId)}` : projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`);
    for (const value of response.jobs || (Array.isArray(response) ? response : [])) { const job = onboardingView(value); if (job?.id) onboardingJobs.set(job.id,job); }
    renderLaunch(); returnSecretaryAfterOnboarding();
  } catch (error) { if (onboardingJobs.size && !/not.found|不存在/i.test(error.message)) toast(error.message); }
  finally { onboardingFetching = false; if ([...onboardingJobs.values()].some(onboardingRunning)) onboardingTimer = setUITimeout(() => action(refreshOnboarding),2000); }
}
async function checkOnboarding(jobId,{retry=true}={}) {
  const previous=onboardingJobs.get(jobId);if(!previous)throw Error('接入记录已更新，请检查当前进度。');if(onboardingFeedbackFor(previous)?.pending)return;
  const attempt=captureOnboardingAttempt(previous);let job=previous;setOnboardingFeedback(previous,'正在检查这次连接，请稍候…',{pending:true,operation:'check'});
  try{
    job=adoptOnboardingJob(await api(`/api/onboarding/jobs/${encodeURIComponent(jobId)}`),previous,attempt);
    if(retry&&!onboardingRepairRequired(previous)&&!onboardingRepairRequired(job)&&!onboardingRecheckPending(previous)&&!onboardingRecheckPending(job)&&onboardingAttemptCurrent(attempt)&&job.stage!=='awaiting_credential'&&!onboardingActions(job).some(value=>value.operation==='reauthorize')&&!onboardingReady(job) && !onboardingRunning(job) && ['codex','claude-code','qwen-code','gemini-cli'].includes(job.provider))job=adoptOnboardingJob(await api(`/api/onboarding/jobs/${encodeURIComponent(job.id)}/retry`,{}),previous,attempt);
    setOnboardingFeedback(job,onboardingRepairRequired(job)?'连接已暂停以保护桌面登录。请先修复 AO 的独立后台环境。':onboardingRecheckPending(job)?'已有登录可复用。请明确点击「沿用已有登录，重新验证」；查看进度没有重新发起连接。':onboardingOfficeReady(job)?'本次连接已验证。':job.stage==='awaiting_auth'?job.provider==='codex'?'请先在原 Codex 窗口完成登录，再检查连接；无需额外的后台登录。':'后台账号尚需授权。请打开首次配置，完成后继续验证。':typeof job.error==='string'?job.error:job.error?.message||'已读取本次进度，请按当前步骤继续。');
    await refreshLaunch();returnSecretaryAfterOnboarding();if(onboardingRunning(job))onboardingTimer=setUITimeout(()=>action(refreshOnboarding),2000);return job;
  }catch(error){setOnboardingFeedback(job,error.message||'连接检查未完成。',{error:true});throw error;}
}
function onboardingProgressTarget() { return $('secretary-connect-dialog').open ? $('secretary-connect-progress') : $('onboarding-progress'); }
function returnSecretaryAfterOnboarding() {
  const flow=secretaryNavigation;
  if(secretaryFinishing || !secretaryNavigationCurrent(flow))return;
  if(flow.source==='selection'){if(flow.accepted)finishSecretaryNavigation(flow,flow.accepted);return;}
  const job=onboardingJobs.get(flow.jobId);
  const reusedConnection=job?.reused_connection===true||job?.connection_reused===true;
  if(job?.provider==='grok-bot'&&job.member_id&&(!job.room_id||job.room_id===flow.roomId)&&reusedConnection&&onboardingOfficeReady(job)&&onboardingReady(job)==='ready_mailbox'){
    flow.source='member';flow.memberId=job.member_id;if(secretaryConnectRoom===flow.roomId&&$('secretary-connect-dialog').open)$('secretary-connect-dialog').close();
  }
  const grokHandoff=job?.stage==='awaiting_bridge_handshake'||job?.next_actions?.some(value=>value.operation==='copy_handshake_prompt')||onboardingReady(job)==='ready_mailbox';
  if(job?.provider==='grok-bot'&&job.member_id&&(!job.room_id||job.room_id===flow.roomId)&&job.native_direct_available!==true&&!reusedConnection&&grokHandoff&&!flow.grokGuideOpened){flow.grokGuideOpened=true;return action(()=>showMemberSetup(job.member_id,flow));}
  if(!job || !onboardingOfficeReady(job) || !job.member_id || (job.room_id && job.room_id!==flow.roomId))return;
  const selected=currentSecretary(),assign=flow.source!=='member'&&(!selected.member_id||selected.status!=='ready');
  if(flow.source!=='member'&&!sameSecretaryAssignment(flow.accepted||flow.assignment,selected)){secretaryNavigation=null;secretaryError='秘书设置已在其他窗口变更，已显示最新角色。请重新确认。';renderSecretary();return;}
  if(assign && !job.can_wake){secretaryError='这位成员的手动信箱已验证，但不会自动处理秘书任务。请选择可后台回答的 AI 作为秘书，或将它作为普通成员加入办公室。';setOnboardingFeedback(job,secretaryError,{error:true});return;}
  if(assign && flow.assignmentAttempted && !flow.accepted)return;
  flow.memberId=job.member_id;flow.requireAutomatic=assign;secretaryFinishing=true;
  return action(async()=>{
    try{
      if(assign && !flow.accepted){flow.assignmentAttempted=true;const accepted=secretaryResponse(await api('/api/secretary',{room_id:flow.roomId,member_id:job.member_id}),flow.roomId);if(!secretaryNavigationCurrent(flow))return;flow.accepted=accepted;}
      await refreshSecretaryState();if(!secretaryNavigationCurrent(flow))return;
      if(!finishSecretaryNavigation(flow,flow.accepted||flow.assignment)){
        secretaryError=sameSecretaryAssignment(flow.accepted||flow.assignment,currentSecretary())?'秘书尚未就绪，请继续完成接入。':'秘书设置已在其他窗口变更，已显示最新角色。请重新确认。';renderSecretary();
      }
    }catch(error){if(secretaryNavigationCurrent(flow)){secretaryError=error.message;renderSecretary();}throw error;}
  }).finally(()=>{secretaryFinishing=false;});
}
async function startOnboarding(provider) {
  if($('secretary-connect-dialog').open&&currentOnboardingJobs().some(onboardingRunning))return;
  const candidate = (launchCandidates || []).find(item => launchProvider(item) === provider); if (!candidate || !onboardingSelectable(candidate) || onboardingStarting.has(provider)) return;
  const project = state?.projects?.find(item => item.id === projectId); if (!project) { showProject(); return; }
  const secretaryConnecting = $('secretary-connect-dialog').open && secretaryConnectRoom === roomId;
  const flow=!legacyId?beginSecretaryNavigation(secretaryConnecting?'picker':professionalView?'member':'launch'):null;
  const selectedRoom=roomId,selectedProject=projectId,selectedLegacy=legacyId;
  const current = onboardingForProvider(provider); if (current?.status === 'needs_action' || onboardingReady(current)) { if(flow)flow.jobId=current.id;if(secretaryConnecting) secretaryConnectJob = current.id; onboardingProgressTarget().scrollIntoView({behavior:'smooth',block:'start'}); await checkOnboarding(current.id,{retry:false}); return; }
  onboardingStarting.add(provider); launchError = ''; renderLaunch();
  try {
    const job = onboardingView(await api('/api/onboarding/start',{provider,...roomId && !legacyId ? {room_id:roomId} : {project_id:project.id},mode:onboardingMode(candidate),install_client:true,...!candidate.installed && onboardingCanInstall(candidate) ? {install_runtime:true} : {},...$('launch-goal').value.trim() ? {goal:$('launch-goal').value.trim()} : {}}));
    if (!job?.id) throw new Error('尚未返回接入记录。请检查进度，避免重复发起。'); onboardingJobs.set(job.id,job);
    if(flow && secretaryNavigation!==flow)return;
    const unchanged=roomId===selectedRoom && projectId===selectedProject && legacyId===selectedLegacy;
    if (job.room_id && !selectedRoom && (unchanged || flow && secretaryNavigation===flow && projectId===selectedProject && !legacyId && (roomId===job.room_id || flow.autoRoomId && roomId===flow.autoRoomId))) { roomId = job.room_id; legacyId = null; rememberSelection();if(flow && secretaryNavigation===flow){flow.roomId=roomId;flow.assignment={...currentSecretary()};} }
    if(flow && secretaryNavigationCurrent(flow))flow.jobId=job.id;
    if(secretaryConnecting && unchanged && secretaryNavigation===flow) secretaryConnectJob = job.id;
    toast(`正在接入 ${candidate.name || provider}。`); renderLaunch(); if(!revealOnboardingAction(job))onboardingProgressTarget().scrollIntoView({behavior:'smooth',block:'nearest'}); returnSecretaryAfterOnboarding(); action(refresh); action(refreshOnboarding);
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
async function api(path, input, method = input === undefined ? 'GET' : 'POST', signal) {
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
  // Bound observations so a lost local HTTP response cannot lock every future
  // refresh. Business writes keep their existing no-replay/uncertain contract.
  if(method==='GET'&&typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function')options.signal=AbortSignal.timeout(15000);
  if(signal)options.signal=signal;
  try {
  let response = await fetch(path,options);
  // Only an explicit 401 proves the request was rejected before processing.
  // A transport failure may have accepted a POST and must never be replayed.
  if (response.status === 401) {
    if (!authRenewal) authRenewal = fetch('/',{credentials:'same-origin',cache:'no-store',redirect:'error',...(typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function'?{signal:AbortSignal.timeout(15000)}:{})}).then(result => { if (!result.ok) throw new Error('本机连接凭据更新未完成。'); }).finally(() => { authRenewal = null; });
    await authRenewal; response = await fetch(path,options);
    if (response.status === 401) throw new Error('本机连接尚未恢复，请使用成员入口检查原实例。');
  }
  const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || '操作失败'),{status:response.status,code:value.code,details:value.details}); return value;
  } catch(error){if(method==='GET'&&['TimeoutError','AbortError'].includes(error.name))throw Object.assign(new Error('读取本机服务超时。请重新检查服务状态，原任务没有重发。'),{code:'local_read_timeout'});throw error;}
}
function toast(text) { $('toast').textContent = text; $('toast').classList.remove('hidden'); clearUITimeout(toastTimer); toastTimer = setUITimeout(() => $('toast').classList.add('hidden'), 6000); }
async function action(fn) { try { return await fn(); } catch (error) { const networkFailure = error.code==='local_read_timeout'||/^(Failed to fetch|Load failed|NetworkError)/i.test(error.message || ''); if (networkFailure) {setWebConnected(false);checkDesktopTransport();} toast(error.code==='local_read_timeout'?error.message:networkFailure ? '本机处理程序未连接。已有成员入口可以恢复同一个房间。' : error.message); } }
function checkDesktopTransport({initial=false}={}) {
  if (!desktop) return Promise.resolve(null);
  if (desktopProbe) return desktopProbe;
  // This is an observation, never a retry of the failed message or a service start.
  desktopProbe=Promise.resolve().then(()=>desktop.command('state',!initial&&roomId ? {room_id:roomId} : {})).then(value=>{
    desktopState=value;desktopReady=true;
    const serviceError=value.service_error||value.connection_error;
    if(serviceError&&(value.service_error||!desktopError||desktopErrorSource==='state')){desktopError=serviceError;desktopErrorSource='state';}
    else if(desktopErrorSource==='state'||value.running===true&&desktopErrorSource==='start_service'){desktopError='';desktopErrorSource=null;}
    if(value.running!==true&&webConnected)setWebConnected(false);
    return value;
  }).catch(error=>{if(!desktopError||desktopErrorSource==='state'){desktopError=error.message||'无法读取本机服务状态。';desktopErrorSource='state';}return null;}).finally(()=>{desktopProbe=null;renderService();});
  renderService();return desktopProbe;
}
async function checkServiceState(){const value=await checkDesktopTransport();if(value)await refresh();return value;}
function memberById(id) { return state?.chat?.members?.find(member => member.id === id) || history?.participants?.find(member => member.id === id); }
function senderName(id) { return id === 'user' ? '你' : memberById(id)?.name || (id === 'system' ? '房间' : id || '成员'); }
function memberStatus(member) {
  if(nativeConnectionUnavailable(member))return {label:'本人对话未连接 · 查看连接',tone:'offline'};
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
setUIInterval(updatePhase,60000);requestAnimationFrame(updatePhase);
function rememberSelection() { localStorage.setItem('agentroom-project', projectId || ''); localStorage.setItem('agentroom-chat-room', roomId || ''); }
async function refresh() {
  if(!viewTimers.active)return;
  if (refreshing) { refreshAgain = true; return; } refreshing = true;
  try {
    const nextState=await api('/api/state');if(!viewTimers.active)return;state=nextState;state.chat ||= {rooms:[],members:[]}; state.chat.rooms ||= []; state.chat.members ||= []; state.approvals ||= []; state.discussions ||= [];
    if (!state.projects.some(project => project.id === projectId)) projectId = state.projects[0]?.id || null;
    if (legacyId && !state.discussions.some(discussion => discussion.id === legacyId && discussion.project_id === projectId)) legacyId = null;
    if (!state.chat.rooms.some(room => room.id === roomId && room.project_id === projectId)) {roomId = state.chat.rooms.find(room => room.project_id === projectId&&!room.archived)?.id || state.chat.rooms.find(room=>room.project_id===projectId)?.id || null;if(secretaryNavigation?.roomId===null && secretaryNavigation.projectId===projectId && !legacyId)secretaryNavigation.autoRoomId=roomId;}
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
    renderRuntime(); renderLaunch(); renderInspector(); renderService(); returnSecretaryAfterOnboarding(); action(refreshLaunch); action(refreshOnboarding); if ($('resume-dialog').open) renderResume(); if (!desktop?.offline && events?.readyState === EventSource.CLOSED) connectEvents();
  } catch (error) { setWebConnected(false); $('footer-status').textContent = '处理程序未连接 · 房间记录仍保存在磁盘'; throw error; }
  finally { refreshing = false; for(const resolve of refreshWaiters.splice(0))resolve(); if (refreshAgain) { refreshAgain = false; scheduleRefresh(); } }
}
function scheduleRefresh() { clearUITimeout(refreshTimer); refreshTimer = setUITimeout(() => action(refresh), 160); }
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
  $('room-actions-service-error').textContent=desktopError;$('room-actions-service-error').classList.toggle('hidden',!desktopError);
  $('room-actions-start').classList.toggle('hidden',webConnected||!desktop);$('room-actions-start').disabled=desktopBusy||!!desktopProbe;
  $('room-actions-start').textContent=desktopBusy?desktopOperation==='stopping'?'正在关闭服务…':desktopOperation==='updating'?'正在更新服务…':'正在开启服务…':desktopProbe?'正在检查服务…':desktopReady?'开启本机服务':'重新检查服务状态';
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
  const approvals=roomApprovals(messages),reviews=roomApprovalReviews(messages),typing = renderTyping(messages), signature = JSON.stringify([room.id,messages,participants.map(member=>[member.id,member.name,member.appearance]),state.chat?.activeMessages || [],typing,approvals,reviews,history.connection_assists||[]]);
  $('empty-room').classList.toggle('hidden',messages.length>0 || approvals.length>0 || reviews.length>0);
  if (signature !== lastTimeline) { const stream = $('chat-stream'), cached = textScroll.get(room.id), nearEnd = officeView ? cached?.atEnd !== false : stream.scrollHeight - stream.scrollTop - stream.clientHeight < 110, changedRoom = !lastTimeline.startsWith(`["${room.id}"`); setRoomTimeline(messages.map(message => renderMessage(message, messages)).join('') + typing + approvalTimelineMarkup(approvals,messages,reviews),approvals); lastTimeline = signature; if(!officeView){if(nearEnd||changedRoom)stream.scrollTop=messages.length||approvals.length||reviews.length?stream.scrollHeight:0;rememberTextScroll();}else if(changedRoom)textScroll.set(room.id,{top:0,atEnd:true}); }
  renderApprovals([]);updateOfficeApprovalAlert();
  renderService(); renderInspector(); renderSidebar(); applyRoomView(); updateOfficeScene();
}
function renderMessage(message, messages) {
  if(message.connection_verification){
    const check=message.connection_verification,name=senderName(check.member_id);
    if(check.status==='verified'&&check.phase==='request')return '';
    const text=check.status==='verified'?`${name} 的自动连接已验证。`:['failed','uncertain','waiting_result'].includes(check.status)?`${name} 的连接验证尚待核对，请查看接入进度。`:check.phase==='reply'?`已收到 ${name} 的连接验证回复，正在核对。`:`正在验证 ${name} 的自动回复…`;
    return `<div class="system-message" id="message-${escape(message.id)}"><span>${escape(text)}</span><time>${time(message.created || message.created_at)}</time></div>`;
  }
  const name = message.coordination ? '办公室安排' : senderName(message.sender_id), member = memberById(message.sender_id), target = message.to_member_id ? senderName(message.to_member_id) : '', quoted = message.reply_to && messages.find(item => item.id === message.reply_to);
  if (['system','event'].includes(message.kind) || message.sender_id === 'system') return `<div class="system-message"><span>${escape(message.text)}</span><time>${time(message.created || message.created_at)}</time></div>`;
  const running = ['queued','creating','running','processing','waiting_input','pending','delivered'].includes(message.status),recipient=memberById(message.to_member_id),messageError=nativeConnectionMessage(message.error,recipient);
  return `<article class="chat-message ${message.sender_id === 'user' && !message.coordination ? 'own-message' : ''}" id="message-${escape(message.id)}"><div class="message-header">${avatar(name, member?.adapter,member?.appearance)}<button type="button" class="message-sender" ${member ? `data-open-member="${escape(member.id)}"` : 'disabled'}>${escape(name)}</button>${target ? `<span class="message-target">→ ${escape(target)}</span>` : ''}<time>${time(message.created || message.created_at)}</time></div><div class="message-body">${quoted ? `<div class="quoted-message"><strong>${escape(senderName(quoted.sender_id))}</strong><span>${escape(quoted.coordination?.title || plainMarkdown(quoted.text))}</span></div>` : ''}${messageContent(message)}${renderConnectionAssists(message,messages)}<div class="message-images">${messageImages(message)}</div>${message.progress ? `<div class="progress-note">${escape(message.progress)}</div>` : ''}${messageError ? `<div class="error-note">${escape(messageError)}${messageError!==message.error?` <button type="button" class="text-button" data-open-member="${escape(recipient.id)}">查看连接</button>`:''}</div>` : ''}<div class="message-footer">${message.status && !['posted','completed','answered'].includes(message.status) ? pill(message.status) : ''}${desktop?.offline ? '' : `${messageCanReconcile(message) ? `<button class="text-button" data-reconcile-message="${escape(message.id)}">核实结果并结案</button>` : ''}<button class="text-button reply-button" data-reply="${escape(message.id)}">回复</button>${running ? `<button class="text-button danger" data-cancel-message="${escape(message.id)}">停止等待</button>` : ''}`}</div></div></article>`;
}
function renderConnectionAssists(message,messages=history.messages||[]) {
  // Keep one live card with the addressed member's first actual reply. While
  // waiting, the request itself owns it so the connection can proceed at once.
  const request=message.sender_id==='user'?message:messages.find(item=>item.id===message.reply_to);
  if(!request||request.sender_id!=='user'||request.kind!=='message'||request.coordination||request.room_id!==roomId||message.room_id!==roomId)return '';
  const reply=messages.find(item=>item.kind==='reply'&&!item.coordination&&!item.connection_verification&&item.room_id===roomId&&item.reply_to===request.id&&item.sender_id===request.to_member_id);
  if(message.id!==(reply?.id||request.id))return '';
  const items=(history.connection_assists||[]).filter(item=>item.message_id===request.id&&item.room_id===roomId&&item.member_id===request.to_member_id&&item.presentation);
  if(!items.length)return '';
  return `<section class="ao-system-card" aria-label="Agent Office 接入进度"><div class="ao-system-label">Agent Office · 当前连接状态</div>${items.map(item=>connectionPanelMarkup(item.presentation,{source:'assist',id:item.id})).join('')}</section>`;
}
// ---- Unified connection panel: one status, one primary action, details. ----
const connectionOperationsPending=new Set();
function connectionPanelMarkup(view,scope,{extraDetails='',pending:external=false}={}) {
  if(!view)return '';
  const key=`${scope.source}:${scope.id}`,pending=connectionOperationsPending.has(key)||external===true,busy=view.busy===true||pending;
  const actionButton=(action,kind)=>action?`<button type="button" class="${kind}" data-conn-op="${escape(action.operation)}" data-conn-source="${escape(scope.source)}" data-conn-id="${escape(scope.id)}"${action.target_member_id?` data-conn-target="${escape(action.target_member_id)}"`:''}${busy?' disabled':''}>${escape(pending&&kind==='primary'?'正在处理…':action.label)}</button>`:'';
  const buttons=actionButton(view.primary,'primary')+actionButton(view.secondary,'secondary');
  const steps=Array.isArray(view.steps)?`<ol class="connection-panel-steps">${view.steps.map(step=>`<li>${escape(step)}</li>`).join('')}</ol>`:'';
  const error=view.details?.error?`<p class="small-note">${escape(view.details.error)}</p>`:'';
  const details=error||extraDetails?`<details class="connection-panel-details"><summary>详情</summary>${error}${extraDetails}</details>`:'';
  return `<div class="connection-panel" data-conn-state="${escape(view.state)}"><div class="connection-panel-status"><span class="connection-dot ${escape(view.state)}${busy?' busy':''}" aria-hidden="true"></span><strong>${escape(view.headline)}</strong></div>${steps}${buttons?`<div class="actions">${buttons}</div>`:''}${details}</div>`;
}
// Keep spaces around Latin names only ("连接 Qwen", but "连接豆包").
const tidyText=text=>String(text).replace(/([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]) (?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g,'$1');
const CONNECTION_PASTE_HINTS={doubao:'已复制地址。填入豆包电脑版自定义连接器的服务器 URL，传输选 HTTP，保存后在本地任务中勾选 Agent Office。','qwen-desktop':'已复制配置。在 Qwen：MCP 设置 → 添加 MCP → 使用 JSON 添加，粘贴后保存并启用（类型 StreamableHTTP）。'};
async function connectionContext(source,id) {
  if(source==='assist'){
    const item=(history.connection_assists||[]).find(value=>value.id===id&&value.room_id===roomId);
    if(!item)throw Error('这条接入记录已更新，请刷新后再试。');
    let job=item.run_id&&typeof onboardingJobs!=='undefined'?onboardingJobs.get(item.run_id):null;
    if(!job&&item.run_id){job=onboardingView(await api(`/api/onboarding/jobs/${encodeURIComponent(item.run_id)}`));if(job?.id)onboardingJobs.set(job.id,job);}
    return {roomId:item.room_id,provider:item.provider,memberId:item.target_member_id||job?.member_id||null,job,view:item.presentation};
  }
  if(source==='job'){
    const job=onboardingJobs.get(id);if(!job)throw Error('接入记录已更新，请刷新后再试。');
    return {roomId:job.room_id,provider:job.provider,memberId:job.member_id||null,job,view:job.presentation};
  }
  if(source==='member'){
    const member=memberById(id)||setupData?.member,provider=setupData?.client?.provider||member?.provider;
    let job=typeof nativeSetupJob==='function'?nativeSetupJob(id,provider):null;
    if(!job){const assist=[...(history?.connection_assists||[])].reverse().find(item=>item.target_member_id===id&&item.room_id===roomId&&item.run_id);if(assist){job=onboardingView(await api(`/api/onboarding/jobs/${encodeURIComponent(assist.run_id)}`));if(job?.id)onboardingJobs.set(job.id,job);}}
    return {roomId,provider,memberId:id,job,view:setupData?.presentation};
  }
  throw Error('无法识别这个连接操作。');
}
async function connectionCopy(operation,ctx) {
  if(!ctx.memberId)throw Error('这位成员还没创建好，请先点「连接」。');
  const data=await api(`/api/chat/members/${encodeURIComponent(ctx.memberId)}/setup?room_id=${encodeURIComponent(ctx.roomId)}`);
  const client=data?.client||{},guide=client.kind==='native_desktop'?client.fallback||client:client,name=ctx.view?.name||ctx.provider;
  if(operation==='copy_config'){
    if(!guide.copy)throw Error(guide.error||'配置还没准备好，请稍后再试。');
    await navigator.clipboard.writeText(guide.copy);
    toast(tidyText(CONNECTION_PASTE_HINTS[ctx.provider]||`已复制配置。粘贴到 ${name} 的 MCP 设置，保存并启用。`));return;
  }
  const text=ctx.provider==='grok-bot'?client.copy||guide.copy:guide.bootstrap||client.bootstrap;
  if(!text)throw Error('这句话还没准备好，请稍后再试。');
  await navigator.clipboard.writeText(text);
  toast(tidyText(ctx.provider==='grok-bot'?'已复制。发到你的 Grok Bot 对话里，AO 会自动检查连接。':`已复制。在 ${name} 里启用 Agent Office 连接后发送，AO 会自动检查连接。`));
}
async function runConnectionOperation(operation,ctx,target) {
  const name=ctx.view?.name||ctx.provider;
  if(operation==='copy_config'||operation==='copy_handshake_prompt')return connectionCopy(operation,ctx);
  if(operation==='start'){await api('/api/onboarding/start',{room_id:ctx.roomId,provider:ctx.provider});return refreshAfterConnection();}
  if(operation==='new_member'){await api('/api/onboarding/start',{room_id:ctx.roomId,provider:ctx.provider,new_member:true});return refreshAfterConnection();}
  if(operation==='enable_wake'){
    if(!ctx.memberId)throw Error('请先连接这位成员。');
    if(!confirm(tidyText(`开启自动唤醒后，AO 可以主动叫 ${name} 处理新消息。\n\n需要关闭并重新打开 ${name}，请先保存正在进行的对话。继续吗？`)))return;
    await api('/api/onboarding/start',{room_id:ctx.roomId,provider:ctx.provider,target_member_id:ctx.memberId,connection_method:'native_desktop'});return refreshAfterConnection();
  }
  if(operation==='show_connection_repair'){openInspector('connections',ctx.memberId);return;}
  if(operation==='choose_connected_member'){openSecretaryTutorial();return;}
  if(!ctx.job&&ctx.memberId&&['retry','reauthorize','native_connect'].includes(operation)){
    await api('/api/onboarding/start',{room_id:ctx.roomId,provider:ctx.provider,target_member_id:ctx.memberId,...operation==='reauthorize'?{reauthorize:true}:{}});
    return refreshAfterConnection();
  }
  if(!ctx.job)throw Error('接入记录已更新，请刷新后再试。');
  if(operation==='native_connect'){
    let job=ctx.job;
    if(onboardingActions(job).some(value=>value.operation==='open_native_client'))job=await runOnboardingOperation(job,'open_native_client')||job;
    await connectOnboardingNative(job);return refreshAfterConnection();
  }
  if(operation==='open_native_client'&&!confirm(tidyText(`需要关闭并重新打开 ${name} 才能连接。请先保存正在进行的对话。继续吗？`)))return;
  await runOnboardingOperation(ctx.job,operation);return refreshAfterConnection();
}
async function refreshAfterConnection(){await refresh();if(typeof refreshOnboarding==='function')action(refreshOnboarding);if($('member-setup-dialog').open&&selectedSetupMember){lastSetupSignature='';action(()=>showMemberSetup(selectedSetupMember));}}
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-conn-op]');if(!button||button.disabled)return;
  const source=button.dataset.connSource,id=button.dataset.connId,key=`${source}:${id}`;
  if(connectionOperationsPending.has(key))return;
  action(async()=>{
    connectionOperationsPending.add(key);button.disabled=true;
    try{const ctx=await connectionContext(source,id);await runConnectionOperation(button.dataset.connOp,ctx,button.dataset.connTarget||null);}
    finally{connectionOperationsPending.delete(key);button.disabled=false;}
  });
});
function renderTyping(messages) {
  const states = {queued:'已排队，等待接手',pending:'等待接手',delivered:'已送达，等待接手',consumed:'已读取，等待回复',creating:'正在打开工作会话',running:'正在思考',processing:'正在思考',waiting_input:'在等你确认'};
  const active = new Set(state.chat?.activeMessages || []), approvals = roomApprovals(messages), replies = new Map(), owed = new Map();
  for (const message of messages) if (message.reply_to && ['reply','acknowledgment'].includes(message.kind)) { const senders = replies.get(message.reply_to) || new Set(); senders.add(message.sender_id); replies.set(message.reply_to,senders); }
  for (const message of messages) {
    if (!message.to_member_id || !states[message.status] || replies.get(message.id)?.has(message.to_member_id)) continue;
    if(message.status==='consumed'&&['reply','acknowledgment'].includes(message.kind))continue;
    if(message.status==='waiting_input' && approvals.some(approval=>(!approval.member_id || approval.member_id===message.to_member_id) && (approval.request_id===message.id || message.request_id && approval.request_id===message.request_id)))continue;
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
    // A verified notification endpoint can notify a Bot without proving that
    // its model has started. Only an actual per-message receipt says notified.
    else if(member.can_notify===true&&['queued','pending','delivered'].includes(message.status)){
      const notification=message.notification?.status,target=member.provider==='grok-bot'||member.adapter==='grok-bridge'?'Grok':'成员';
      label=notification==='accepted'?`已通知，等待 ${target} 处理`:notification==='sending'?`正在通知 ${target}`:notification==='uncertain'?'通知结果待核对，请查看连接状态':`已排队，等待通知 ${target}`;busy=false;needsYou=notification==='uncertain';
    }
    // A manual-only connection still needs its own window to receive work.
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
function approvalSessionAllowed(approval) { return approval.session_allowed===true && !['input','form','url'].includes(approval.type); }
function approvalQuestionMarkup(question) {
  const input=`<input data-question="${escape(question.id)}" placeholder="填写回答">`,options=Array.isArray(question.options)?question.options.filter(option=>typeof option?.label==='string' && option.label.trim()):[];
  if(!options.length)return `<label>${escape(question.question)}${input}</label>`;
  return `<div class="approval-question" data-approval-question="${escape(question.id)}"><strong>${escape(question.question)}</strong><div class="actions" role="group" aria-label="${escape(question.header||question.question)}">${options.map(option=>`<button type="button" class="secondary" data-question-choice="${escape(question.id)}" data-choice-value="${escape(option.label)}" aria-pressed="false"><strong>${escape(option.label)}</strong>${option.description?`<br><small>${escape(option.description)}</small>`:''}</button>`).join('')}</div><label>回答（也可自定义）${input}</label></div>`;
}
function syncApprovalQuestionChoices(input) {
  const group=input?.closest('[data-approval-question]');if(!group || input.dataset.question!==group.dataset.approvalQuestion)return;
  for(const button of group.querySelectorAll('[data-question-choice]')){
    const selected=button.dataset.questionChoice===input.dataset.question && button.dataset.choiceValue===input.value;
    button.setAttribute('aria-pressed',String(selected));button.classList.toggle('primary',selected);button.classList.toggle('secondary',!selected);
  }
}
function selectApprovalQuestionChoice(button) {
  if(!button || button.disabled || typeof button.dataset.choiceValue!=='string')return;
  const group=button.closest('[data-approval-question]');if(!group || button.dataset.questionChoice!==group.dataset.approvalQuestion)return;
  const input=[...group.querySelectorAll('[data-question]')].find(field=>field.dataset.question===button.dataset.questionChoice);if(!input)return;
  input.value=button.dataset.choiceValue;syncApprovalQuestionChoices(input);
}
function approvalContentMarkup(approval,attribute='data-approve') {
  const id=escape(approval.id);
  return `${approval.reason ? `<p>${escape(approval.reason)}</p>` : ''}${approval.command ? `<details class="approval-operation"><summary>查看具体操作</summary><pre>${escape(approval.command)}</pre></details>` : ''}${approval.type === 'url' && approval.url ? `<a class="secondary" href="${escape(approval.url)}" target="_blank" rel="noreferrer">在对应服务完成确认 ↗</a><button class="secondary" data-copy-approval-url="${escape(approval.url)}">复制链接</button>` : ''}${approval.type === 'input' ? (approval.questions || []).map(approvalQuestionMarkup).join('') : ''}${approval.type === 'form' ? Object.entries(approval.schema?.properties || {}).map(([key,property]) => `<label>${escape(property.title || property.description || key)}${property.type === 'boolean' ? `<input type="checkbox" data-form-field="${escape(key)}" data-field-type="boolean">` : `<input data-form-field="${escape(key)}" data-field-type="${escape(property.type || 'string')}" ${/password|secret|token|key/i.test(key) ? 'type="password"' : ''} placeholder="${property.enum ? escape(property.enum.join(' / ')) : '填写内容'}">`}</label>`).join('') : ''}<div class="actions">${approval.type === 'input' ? `<button class="primary" data-input-submit="${id}">提交回答</button>` : approval.type === 'form' ? `<button class="primary" data-form-submit="${id}">提交表单</button><button class="secondary" ${attribute}="${id}" data-decision="decline">取消</button>` : `<button class="primary" ${attribute}="${id}" data-decision="accept">${approval.type === 'url' ? '已完成，继续' : '允许这次操作'}</button>${approvalSessionAllowed(approval)?`<button class="secondary" ${attribute}="${id}" data-decision="acceptForSession">本会话允许此操作</button>`:''}<button class="secondary" ${attribute}="${id}" data-decision="decline">不允许</button>`}</div>${approvalSessionAllowed(approval)?'<p class="approval-note"><small>「本会话允许」由 Codex 原生记住这一类操作，此对话内后续同类请求不再询问；只想放行这一次，请选「允许这次操作」。</small></p>':''}`;
}
async function copyApprovalLink(button) {
  await navigator.clipboard.writeText(button.dataset.copyApprovalUrl);
  toast('已复制链接。在浏览器完成确认后，回到这里继续。');
}
function roomApprovals(messages) {
  const pending=new Map();
  for(const approval of Array.isArray(state?.approvals)?state.approvals:history?.approvals||[]){
    if(!approval.id || approval.room_id && approval.room_id!==roomId)continue;
    if(approval.room_id!==roomId && !messages.some(message=>message.id===approval.request_id || message.request_id===approval.request_id))continue;
    pending.set(approval.id,approval);
  }
  return [...pending.values()].sort((a,b)=>String(a.created||'').localeCompare(String(b.created||'')));
}
function renderApprovalMessage(approval,messages) {
  const task=messages.find(message=>message.id===approval.request_id || message.request_id===approval.request_id),member=memberById(approval.member_id || task?.to_member_id || (task?.sender_id!=='user'?task?.sender_id:null));
  const name=member?.name || '这位成员',summary=task && (task.coordination?.title || plainMarkdown(task.text)).slice(0,180);
  return `<article class="chat-message approval-message" data-approval="${escape(approval.id)}"><div class="message-header">${avatar(name,member?.adapter,member?.appearance,member?.id)}<button type="button" class="message-sender" ${member?`data-open-member="${escape(member.id)}"`:'disabled'}>${escape(name)}</button><span class="message-target">需要你确认</span><time>${time(approval.created)}</time></div><div class="message-body approval-card">${task?`<div class="quoted-message"><strong>当前任务</strong><span>${escape(summary)}</span><button type="button" class="text-button" data-approval-task="${escape(task.id)}">查看委托消息 ↗</button></div>`:''}<h3>${['input','form'].includes(approval.type)?'请补充这一步的信息':'请确认这一步操作'}</h3>${approvalContentMarkup(approval)}</div></article>`;
}
function roomApprovalReviews(messages) {
  const reviews=new Map();
  for(const review of Array.isArray(state?.approval_reviews)?state.approval_reviews:history?.approval_reviews||[]){
    if(!review.id || !['denied','timedOut','aborted'].includes(review.status) || review.room_id && review.room_id!==roomId)continue;
    if(review.room_id!==roomId && !messages.some(message=>message.id===review.request_id || message.request_id===review.request_id))continue;
    reviews.set(review.id,review);
  }
  return [...reviews.values()];
}
function approvalReviewActive(task) { return !!task && !['posted','answered','consumed','completed','failed','cancelled','uncertain'].includes(task.status); }
function renderApprovalReviewMessage(review,messages) {
  const task=messages.find(message=>message.id===review.request_id || message.request_id===review.request_id),member=memberById(review.member_id || task?.to_member_id),name=member?.name||'这位成员';
  return `<article class="chat-message approval-review-message" data-approval-review="${escape(review.id)}"${approvalReviewActive(task)?' data-review-active="1"':''}><div class="message-header">${avatar(name,member?.adapter,member?.appearance,member?.id)}<button type="button" class="message-sender" ${member?`data-open-member="${escape(member.id)}"`:'disabled'}>${escape(name)}</button><span class="message-target">${review.status==='denied'?'操作检查未通过':'操作检查未完成'}</span><time>${time(review.created)}</time></div><div class="message-body">${task?`<div class="quoted-message"><strong>当前任务</strong><span>${escape((task.coordination?.title||plainMarkdown(task.text)).slice(0,180))}</span><button type="button" class="text-button" data-approval-task="${escape(task.id)}">查看委托消息 ↗</button></div>`:''}<p>${escape(review.reason||'请补充操作目的与要求，让成员核对下一步。')}</p>${review.command?`<details class="approval-operation"><summary>查看具体操作</summary><pre>${escape(review.command)}</pre></details>`:''}${member?`<button type="button" class="secondary" data-review-member="${escape(member.id)}" ${task?`data-review-task="${escape(task.id)}"`:''}>补充要求</button>`:''}</div></article>`;
}
function approvalTimelineMarkup(approvals,messages,reviews=[]) {
  const cards=[...[...new Map(approvals.map(approval=>[approval.id,approval])).values()].map(value=>({value,review:false})),...[...new Map(reviews.map(review=>[review.id,review])).values()].map(value=>({value,review:true}))];
  return cards.sort((a,b)=>String(a.value.created||'').localeCompare(String(b.value.created||''))).map(({value,review})=>review?renderApprovalReviewMessage(value,messages):renderApprovalMessage(value,messages)).join('');
}
function setRoomTimeline(markup,approvals) {setApprovalMarkup($('messages'),markup,approvals);}
function setApprovalMarkup(host,markup,approvals) {
  const active=document.activeElement,retained=new Map([...host.querySelectorAll('[data-approval]')].map(card=>[card.dataset.approval,card]));
  host.innerHTML=markup;
  for(const card of host.querySelectorAll('[data-approval]')){
    const signature=JSON.stringify(approvals.find(approval=>approval.id===card.dataset.approval)),previous=retained.get(card.dataset.approval);
    // A new chat message must not erase an answer or form the user is typing.
    if(previous?.approvalSignature===signature){card.replaceWith(previous);if(previous.contains(active))active.focus({preventScroll:true});}else card.approvalSignature=signature;
  }
}
function renderApprovals(approvals) {
  const signature = JSON.stringify([roomId,legacyId,approvals]); if (signature === lastApprovalSignature) return; lastApprovalSignature = signature;
  $('approval-panel').innerHTML = approvals.map(approval => `<div class="approval-card" data-approval="${escape(approval.id)}"><h3>${['input','form'].includes(approval.type) ? '成员需要补充信息' : '成员需要你的确认'}</h3>${approvalContentMarkup(approval)}</div>`).join('');
  updateOfficeApprovalAlert();
}
async function respondToApproval(button) {
  if(!button || button.disabled)return;
  const id=button.dataset.approve || button.dataset.onboardingApprove || button.dataset.inputSubmit || button.dataset.formSubmit;if(!id || approvalResponding.has(id))return;
  approvalResponding.add(id);button.disabled=true;
  try{
    let payload;
    if(button.dataset.inputSubmit){const answers={};button.closest('[data-approval]').querySelectorAll('[data-question]').forEach(input=>answers[input.dataset.question]=input.value);payload={answers};}
    else if(button.dataset.formSubmit){const content={};button.closest('[data-approval]').querySelectorAll('[data-form-field]').forEach(input=>content[input.dataset.formField]=input.dataset.fieldType==='boolean'?input.checked:input.dataset.fieldType==='array'?input.value.split(',').map(item=>item.trim()).filter(Boolean):input.value);payload={content};}
    else {const decision=button.dataset.decision,approvals=Array.isArray(state?.approvals)?state.approvals:history?.approvals||[];if(decision==='acceptForSession' && !approvals.some(approval=>approval.id===id && approvalSessionAllowed(approval)))throw Error('当前操作未提供本会话授权，请选择允许这次操作或拒绝。');payload={decision};}
    await api(`/api/approvals/${encodeURIComponent(id)}`,payload);await refresh();
  }finally{approvalResponding.delete(id);button.disabled=false;}
}
let projectPicker = null;
async function browseProjectFolder() {
  if(projectPicker)return;
  const controller=new AbortController();projectPicker=controller;
  const button=$('browse-folder'),cancel=$('cancel-folder'),feedback=$('project-picker-status');
  button.disabled=true;button.textContent='正在选择…';cancel.classList.toggle('hidden',!!desktop);
  feedback.textContent='请在文件夹选择窗口中选择项目，也可以取消后直接填写路径。';
  try {
    const result=desktop?await desktop.command('pick_folder'):await api('/api/folder-picker',{},'POST',controller.signal);
    if(controller.signal.aborted||!$('project-dialog').open)return;
    if(result.path){
      $('project-path').value=result.path;
      if(!$('project-name').value.trim())$('project-name').value=result.path.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||'我的项目';
    }
    feedback.textContent='';
  } catch(error) { feedback.textContent=controller.signal.aborted?'已取消选择，可以直接填写文件夹路径。':error.message; }
  finally { if(projectPicker===controller){projectPicker=null;button.disabled=false;button.textContent='浏览';cancel.classList.add('hidden');} }
}
function showProject() { $('project-picker-status').textContent=''; $('project-dialog').showModal(); }
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
async function connectMember(id, knownMember) {
  if (!roomId || legacyId) throw new Error('先创建或打开一个聊天室。');
  const selectedRoom=roomId;
  await api(`/api/chat/rooms/${encodeURIComponent(selectedRoom)}/join`, {member_id:id}); await refresh();if(roomId!==selectedRoom||legacyId)return;$('member-dialog').close();
  const prepared=await api(`/api/chat/members/${encodeURIComponent(id)}/setup?room_id=${encodeURIComponent(selectedRoom)}`);
  if(roomId!==selectedRoom||legacyId)return;
  if(prepared.client?.kind==='native_desktop'){selectedSetupMember=id;setupData=prepared;nativeSetupFailure=null;openMemberSetupDialog();await connectNativeDesktop();return;}
  if(prepared.client?.kind==='grok_guided'){selectedSetupMember=id;setupData=prepared;nativeSetupFailure=null;openGrokSetup();return;}
  if ((memberById(id) || knownMember)?.adapter === 'grok-bridge') { await showBridge(id); return; }
  const result = await api(`/api/chat/members/${encodeURIComponent(id)}/connect`, {room_id:selectedRoom}); await refresh();if(roomId!==selectedRoom||legacyId)return; selectedSetupMember = id; setupData = result; openMemberSetupDialog();
}
async function showMemberSetup(id,expectedFlow=null) {
  if (!webConnected) return showResume(id);
  const selectedRoom=roomId;selectedSetupMember=id;nativeSetupFailure=null;$('member-grok-key').value='';$('member-grok-url').value='';
  const data=await api(`/api/chat/members/${encodeURIComponent(id)}/setup?room_id=${encodeURIComponent(selectedRoom)}`);
  if(selectedSetupMember!==id||roomId!==selectedRoom||expectedFlow&&!secretaryNavigationCurrent(expectedFlow))return;
  if(data.client?.kind==='native_desktop')await loadNativeSetupJob(data.client,id,selectedRoom);
  if(selectedSetupMember!==id||roomId!==selectedRoom||expectedFlow&&!secretaryNavigationCurrent(expectedFlow))return;
  if(data.client?.kind==='grok_guided'){setupData=data;openGrokSetup();return;}
  if(memberById(id)?.adapter==='grok-bridge'&&data.client?.kind!=='native_desktop')return showBridge(id);
  setupData=data;openMemberSetupDialog();
}
function openMemberSetupDialog(){
  const flow=secretaryNavigation,job=flow?.jobId&&onboardingJobs.get(flow.jobId);
  if(flow&&secretaryNavigationCurrent(flow)&&$('secretary-connect-dialog').open&&(job?.member_id===selectedSetupMember||flow.memberId===selectedSetupMember))flow.setupMemberId=selectedSetupMember;
  for(const id of ['member-dialog','secretary-connect-dialog','bridge-dialog'])if($(id).open)$(id).close();
  renderSetup();if(!$('member-setup-dialog').open)$('member-setup-dialog').showModal();
}
function setupText(value) { if (typeof value === 'string') return value; if (value == null) return ''; return JSON.stringify(value,null,2); }
function instructionsText(data) { const member = memberById(selectedSetupMember) || data.member || {}; return setupText((member.adapter === 'grok-bridge' && data.bridgeInstructions) || data.instructions || data.invite?.instructions || (typeof data.invite === 'string' ? data.invite : '')); }
function nativeReadinessMarkup(value={},evidence=value.connection_evidence) {
  const loaded=(value.native_conversation_loaded??evidence?.native_conversation_loaded)===true,reply=(value.model_reply_verified??evidence?.model_reply_verified)===true;
  return `<dl class="native-ready-evidence" aria-label="本人对话验证"><div><dt>原生会话</dt><dd class="${loaded?'observed':'pending'}">${loaded?'已加载本人对话':'待连接验证'}</dd></div><div><dt>实际回复</dt><dd class="${reply?'observed':'pending'}">${reply?'已核对原问题的真实回答':'待实际任务验证'}</dd></div></dl>`;
}
function nativeConnectNextStep(provider,error={}) {
  const name={'qwen-desktop':'Qwen',doubao:'豆包','grok-bot':'Grok Bot'}[provider]||'这个客户端',code=error.code||'';
  if(/revoked|reauthoriz/i.test(code))return '这位成员的原连接已撤销。请先在原接入记录中点击“重新授权这位成员”，再继续配置和握手。';
  if(code==='desktop_request_uncertain')return '本次接入结果尚待核对。请先查看连接诊断，沿用原记录继续核对。';
  if(code==='desktop_target_ambiguous')return `发现多个 ${name} 实例。保留你要连接的那个实例后再检查。`;
  if(/version|contract|adapter_unverified|SOURCE|IDENTITY/i.test(code))return '客户端版本或本人接口尚未通过核对。请使用兼容版本，或按下方步骤改用 MCP，在本人窗口实际握手。反复点击连接不会解决版本不兼容。';
  if(/auth|login|quota/i.test(code))return `请在 ${name} 本人客户端完成登录，或处理当前模型的额度，再继续连接。`;
  return `请先打开 ${name}。若提示本机连接未开启，请从客户端菜单或托盘完整退出，再点击“开启客户端连接”；之后核对本人对话。也可按下方步骤改用 MCP。`;
}
function nativeConnectErrorTitle(error={}){
  const code=error.code||'',message=typeof error.message==='string'?error.message:'';
  if(/revoked|reauthoriz/i.test(code))return '原连接已撤销，请先重新授权这位成员。';
  if(/version|contract|adapter_unverified|SOURCE|IDENTITY/i.test(code))return '当前客户端版本的本机连接暂不可用。';
  if(code==='desktop_bridge_unavailable'||/ECONNREFUSED|connection refused/i.test(message))return '桌面对话连接尚未开启。';
  return message||'本人对话连接尚未完成。';
}
function legacyConnectGuide(client,member,{hidePrivateValues=false}={}) {
  if(!client)return '';if(client.kind==='error')return `<p class="error-note">${escape(client.error)}</p>`;
  const verified = !!member.verified_at, fields = client.fields&&!hidePrivateValues ? `<dl class="connect-fields">${Object.entries(client.fields).map(([key,value]) => `<dt>${escape(key)}</dt><dd><code>${escape(value)}</code></dd>`).join('')}</dl>` : '';
  return `<h3>${escape(client.title||'兼容连接')}</h3>${client.installation_prompt ? `<div class="connect-actions"><button type="button" class="primary" data-copy-install>复制 AI 安装说明</button><span class="small-note">交给有本机配置能力的 AI，保留已有连接</span></div>${hidePrivateValues?'':`<details class="setup-block"><summary>查看 AI 安装说明</summary><pre class="setup-code">${escape(client.installation_prompt)}</pre></details>`}` : ''}<ol class="connect-steps">${(client.steps||[]).map(step => `<li>${escape(step)}</li>`).join('')}</ol>${fields}${client.copy ? `<div class="connect-actions"><button type="button" class="primary" data-copy-guide>${escape(client.copy_label || '复制')}</button><span class="connect-state">${verified ? '入口已有成功调用 · 当前对话仍须验证' : '导入后实际调用工具才算接通'}</span></div>${hidePrivateValues?'':`<details class="setup-block"><summary>查看 MCP 设置配置</summary><pre class="setup-code">${escape(client.copy)}</pre></details>`}` : ''}${client.bootstrap ? `<div class="connect-actions"><button type="button" class="secondary" data-copy-bootstrap>复制连接人物说明</button><span class="small-note">发到这位同事的 AI 对话，只需一次</span></div>${hidePrivateValues?'':`<details class="setup-block"><summary>查看连接人物说明</summary><pre class="setup-code">${escape(client.bootstrap)}</pre></details>`}` : ''}${client.note ? `<p class="small-note">${escape(client.note)}</p>` : ''}`;
}
function fallbackConnectGuide(client=setupData?.client){return client?.kind==='native_desktop'?client.fallback||client.legacy_guide||client.manual_guide||null:client;}
function nativeSetupJob(memberId,provider,selectedRoom=roomId){
  if(typeof onboardingJobs==='undefined')return null;
  return [...onboardingJobs.values()].reverse().filter(job=>job.member_id===memberId&&job.provider===provider&&job.room_id===selectedRoom).sort((a,b)=>String(b.updated||b.created||'').localeCompare(String(a.updated||a.created||'')))[0]||null;
}
async function loadNativeSetupJob(client,memberId,selectedRoom){
  if(nativeSetupJob(memberId,client.provider,selectedRoom)||typeof history==='undefined')return;
  const assist=[...(history?.connection_assists||[])].reverse().find(item=>item.target_member_id===memberId&&item.provider===client.provider&&item.room_id===selectedRoom&&item.run_id);
  if(!assist)return;
  try{
    const job=onboardingView(await api(`/api/onboarding/jobs/${encodeURIComponent(assist.run_id)}`));
    if(selectedSetupMember===memberId&&roomId===selectedRoom&&!legacyId&&job?.id===assist.run_id&&job.member_id===memberId&&job.provider===client.provider&&job.room_id===selectedRoom)onboardingJobs.set(job.id,job);
  }catch{} // Viewing a saved guide must remain available when progress cannot be read.
}
function nativeSetupOperation(job,operation){return !!job&&onboardingActions(job).some(value=>value.operation===operation&&(!['manual_mcp','reauthorize'].includes(operation)||value.target_member_id===job.member_id));}
function nativeMcpAllowed(client,member={},job=nativeSetupJob(member.id,client.provider)){
  const native=client.native_state||{},failure=nativeSetupFailure?.memberId===member.id&&nativeSetupFailure?.roomId===roomId?nativeSetupFailure:null,codes=[failure?.code,native.error_code,native.reconnect?.error_code,member.runtime_state?.connection_evidence?.last_error?.code];
  return !legacyId&&selectedSetupMember===member.id&&setupData?.member?.id===member.id&&(!setupData.room||setupData.room.id===roomId)&&(!member.provider||member.provider===client.provider)&&!['disabled','revoked'].includes(member.status)&&!grokSetupBlocked(client)&&!codes.some(code=>/revoked|reauthoriz/i.test(code||'')||code==='desktop_request_uncertain')&&native.state!=='creation_uncertain'&&!(nativeSetupPending?.memberId===member.id&&nativeSetupPending?.roomId===roomId)&&(!job||job.connection_method==='manual_mcp'||nativeSetupOperation(job,'manual_mcp'));
}
function nativeMcpGuide(client,member,job){
  const guide=fallbackConnectGuide(client);if(!guide||guide.kind==='error')return guide?.error?`<p class="setup-note">${escape(guide.error)}</p>`:'';
  const name={'qwen-desktop':'Qwen',doubao:'豆包','grok-bot':'Grok Bot'}[client.provider]||'这位同事的客户端';
  const manual=nativeSetupOperation(job,'manual_mcp');
  return `<section class="native-connect-fallback"><h3>用 MCP 连接 ${escape(name)} 本人窗口</h3><p>如果自动连接不可用，可${manual?'先点击下方“改用 MCP 连接”，再':''}按这两步接入。此方式由本人窗口处理 AO 消息，后台自动接手能力另行验证。</p>${manual?`<button type="button" class="secondary" data-native-operation="manual_mcp" data-native-job="${escape(job.id)}">改用 MCP 连接</button>`:''}<ol class="connect-steps"><li><strong>安装或更新 MCP</strong><p>还没配置、配置已失效或工具版本需要更新时，把安装提示词交给有本机配置能力的 AI 助手；它会保留已有连接。已经配置并启用的，可直接进行第二步。</p>${guide.installation_prompt?'<button type="button" class="primary" data-copy-install>复制安装 / 更新 MCP 提示词</button><p class="small-note">交给能访问这台电脑配置文件的 AI；普通聊天或云端代码解释器不能代装本机 MCP。</p>':''}${guide.copy?`<button type="button" class="secondary" data-copy-guide>${escape(guide.copy_label||'复制 MCP 配置')}</button><p class="small-note">手动配置时粘贴到 ${escape(name)} 的 MCP / 连接器设置。</p>`:''}<ol>${(guide.steps||[]).map(step=>`<li>${escape(step)}</li>`).join('')}</ol></li><li><strong>回到 ${escape(name)} 的对应对话完成握手</strong><p>启用 AO 连接器后，把下面的握手提示词粘贴到这位同事的 ${escape(name)} 对话并发送，让它实际调用 AO 工具；保存配置还不算接通。</p>${guide.bootstrap?'<button type="button" class="primary" data-copy-bootstrap>复制本人窗口握手提示词</button>':'<p class="setup-note">握手说明尚未准备好，请检查当前成员接入进度。</p>'}</li></ol>${guide.note?`<p class="small-note">${escape(guide.note)}</p>`:''}</section>`;
}
function stopGrokSetupWatch(){clearUITimeout(grokSetupWatchTimer);grokSetupWatchTimer=null;grokSetupWatch=null;grokSetupWatchSequence++;}
function grokSetupWatchCurrent(watch){return !!watch&&grokSetupWatch===watch&&watch.sequence===grokSetupWatchSequence&&watch.memberId===selectedSetupMember&&watch.roomId===roomId&&!legacyId&&$('member-setup-dialog').open&&setupData?.client?.kind==='grok_guided';}
function grokSetupReady(data){return data?.client?.ready_for_office===true&&data.client.handshake_verified===true;}
function grokSetupObservation(data){const value=Date.parse(data?.client?.handshake_observed_at);return Number.isFinite(value)?value:0;}
function grokSetupFresh(data,watch=grokSetupWatch){return !!watch&&grokSetupReady(data)&&grokSetupObservation(data)>watch.initialHandshakeObservation;}
function grokSetupBlocked(client){return client?.revoked===true||client?.needs_reauthorization===true||client?.entry_status==='revoked';}
function openGrokSetup(){
  stopGrokSetupWatch();grokSetupWatchError='';lastSetupSignature='';
  for(const id of ['member-dialog','secretary-connect-dialog','bridge-dialog'])if($(id).open)$(id).close();
  renderSetup();if(!$('member-setup-dialog').open)$('member-setup-dialog').showModal();
  grokSetupWatch={memberId:selectedSetupMember,roomId,sequence:grokSetupWatchSequence,copied:false,copying:false,initialHandshakeObservation:grokSetupObservation(setupData)};
  grokSetupWatchTimer=setUITimeout(()=>pollGrokSetup(),2500);
}
function enterGrokOffice(watch,{allowHistorical=false}={}){
  const fresh=grokSetupFresh(setupData,watch);
  if(!grokSetupWatchCurrent(watch)||!(fresh||allowHistorical&&grokSetupReady(setupData)))return false;
  const member=memberById(watch.memberId);if(!member||!history?.participants?.some(value=>value.id===watch.memberId)||history.room?.id!==watch.roomId)return false;
  stopGrokSetupWatch();$('member-setup-dialog').close();secretaryNavigation=null;closeSecretaryTutorial();setProfessionalView(true);selectRoomView(true);
  if(!$('recipient').value){$('recipient').value=member.id;updateRecipientNote();}
  toast(fresh?'Grok 本次真实连接已核对，已进入办公室。后台自动接手能力会单独核对。':'已进入办公室，原连接和记录保留；Grok 本次连接仍待核对。');return true;
}
async function pollGrokSetup(){
  clearUITimeout(grokSetupWatchTimer);
  const watch=grokSetupWatch;if(!watch||!grokSetupWatchCurrent(watch)){stopGrokSetupWatch();return;}
  try{
    if(watch.copying)return;
    if(!webConnected)throw Error('AO 服务暂时未连接。服务恢复后会继续检查，无需重新配置。');
    const data=await api(`/api/chat/members/${encodeURIComponent(watch.memberId)}/setup?room_id=${encodeURIComponent(watch.roomId)}`);
    if(!grokSetupWatchCurrent(watch))return;
    setupData=data;grokSetupWatchError='';await refresh();
    if(!grokSetupWatchCurrent(watch))return;
    renderSetup();if(grokSetupFresh(data,watch)&&enterGrokOffice(watch))return;
  }catch(error){if(grokSetupWatchCurrent(watch)){grokSetupWatchError=error.message||'暂时无法检查连接结果。';renderSetup();}}
  finally{if(grokSetupWatchCurrent(watch))grokSetupWatchTimer=setUITimeout(()=>pollGrokSetup(),grokSetupWatchError?6000:2500);}
}
function renderGrokConnectGuide(client,member){
  const ready=grokSetupFresh({client}),historical=grokSetupReady({client}),verified=ready,copied=grokSetupWatch?.memberId===member.id&&grokSetupWatch.copied;
  const blocked=grokSetupBlocked(client);
  const reason=client.error||client.native_error||member.error||'';
  return `<h3>${ready?'Grok 本机入口已接通':'把这位 Grok Bot 连进办公室'}</h3><p class="grok-connect-intro">把下面的连接说明发给你正在使用的 Grok，让它按说明连接这位 Bot。无需先建群，换房间或升级后仍沿用这位人物。</p><ol class="grok-connect-steps"><li><strong>复制连接说明</strong><p>${blocked?'这个连接已被撤销，请在原接入记录中明确重新授权后继续。':'说明已包含这位人物的连接入口，无需填写任何编号。'}</p><button type="button" class="primary" data-grok-copy ${(!client.copy&&!client.needs_prepare)||blocked||!webConnected||grokSetupWatch?.copying?'disabled':''}>${grokSetupWatch?.copying?'正在准备说明…':copied?'再次复制连接说明':'复制连接说明'}</button>${grokSetupWatch?.clipboardFailure?`<p>请选中下方说明复制，粘贴到 Grok Bot 对话：</p><textarea class="grok-handoff-copy" data-grok-copy-fallback readonly aria-label="Grok 连接说明，选中后复制">${escape(client.copy||'')}</textarea>`:''}</li><li><strong>发给 Grok，完成它提出的一次授权</strong><p>粘贴到你要连接的 Grok Bot 对话；如果当前是主 Grok，请明确让它按说明连接这位人物的专用 Bot。Grok 请求本机命令执行授权时，在 Grok 中确认。</p></li><li class="${verified?'verified':''}"><strong>${ready?'本次真实连接已核对':historical?'以前已验证，本次连接待核对':'回到这里，AO 自动检查连接'}</strong><p role="status">${ready?'可以进入办公室。连接已保留，今后无需重复粘贴。':historical?'原连接仍保留；尚未收到本次 Grok 调用。请把说明发给它，AO 会核对新的连接记录。':copied?'正在等待 Grok 执行连接说明。AO 会自动更新，无需重复点连接。':'复制后按第二步发送。AO 只在收到真实连接后显示成功。'}</p>${ready?'<button type="button" class="primary" data-grok-enter>进入办公室</button>':historical?'<button type="button" class="secondary" data-grok-enter-history>先进入办公室（本次待核对）</button>':''}</li></ol>${grokSetupWatchError?'<p class="setup-note">暂时无法检查结果；AO 会自动继续检查，保留当前说明即可。</p>':''}<p class="small-note">接通入口不等于能后台唤醒 Grok。自动接手会依据实际接口另行验证。</p><details class="native-connect-advanced"><summary>遇到问题？查看帮助与诊断</summary><p>如果 Grok 说“没有本机执行工具”，请使用具有本机命令能力的 Grok Bot 执行这份说明。无需删除 AO 人物或重新生成连接。</p><p>需要群聊时，连接成功后再让 Grok 创建群聊并邀请其他成员。</p>${reason||grokSetupWatchError?`<pre class="setup-code">${escape(grokSetupWatchError||reason)}</pre>`:''}<button type="button" class="secondary" data-native-diagnostics>查看连接诊断</button></details>`;
}
// The primary action binds an owned native dialogue. Protocol and actual model
// reply observations stay separate, including when a legacy entry was verified.
function renderConnectGuide(client, member) {
  const box=$('member-connect-guide');$('member-durable-card').classList.toggle('hidden',!!client);
  if(!client){box.innerHTML='';return;}
  if(client.kind==='grok_guided'){box.innerHTML=renderGrokConnectGuide(client,member);return;}
  if(client.kind!=='native_desktop'){box.innerHTML=legacyConnectGuide(client,member);return;}
  const native=client.native_state||{},evidence=nativeMemberEvidence(member,client.connection_evidence||native.connection_evidence||{});
  const busy=nativeSetupPending?.memberId===member.id&&nativeSetupPending?.roomId===roomId;
  const failure=nativeSetupFailure?.memberId===member.id&&nativeSetupFailure?.roomId===roomId?nativeSetupFailure:null;
  const observedCode=native.reconnect?.error_code||native.error_code||evidence.last_error?.code;
  const error=(failure||native.error)?failure||{message:native.error,code:observedCode}:observedCode==='resume_revoked'?{message:'原连接已撤销，请先重新授权这位成员。',code:observedCode}:member.error?{message:member.error,code:observedCode}:null;
  if(error)error.message=nativeConnectionMessage(error.message,member);
  const loaded=evidence.native_conversation_loaded===true,reply=evidence.model_reply_verified===true;
  const job=nativeSetupJob(member.id,client.provider),port={'qwen-desktop':19245,doubao:19246,'grok-bot':19247}[client.provider],blocked=/revoked|reauthoriz/i.test(error?.code||'')||grokSetupBlocked(client);
  const opening=nativeSetupOperation(job,'open_native_client')&&!blocked&&!loaded?`<div class="connect-actions"><button type="button" class="primary" data-native-operation="open_native_client" data-native-job="${escape(job.id)}" ${busy||!webConnected?'disabled':''}>开启客户端连接</button><span class="small-note">若客户端已打开，先从它的菜单或托盘完整退出，再点击这里。原聊天和登录继续沿用。</span></div>`:'';
  const mcp=nativeMcpAllowed(client,member,job)?nativeMcpGuide(client,member,job):'';
  box.innerHTML=`<h3>连接这位同事的本人对话</h3><p class="small-note">沿用本人客户端的登录，为这位同事保留独立的原生对话。加入新房间后继续沿用。</p>${nativeReadinessMarkup({},evidence)}${error?`<div class="native-connect-error" role="alert"><strong>${escape(nativeConnectErrorTitle(error))}</strong><p>${escape(nativeConnectNextStep(client.provider,error))}</p></div>`:''}${opening}<div class="connect-actions"><button type="button" class="${opening?'secondary':'primary'}" data-native-connect ${busy||!webConnected||blocked?'disabled':''}>${busy?'正在核对本人对话…':'连接本人对话'}</button><span class="connect-state">${escape(reply&&loaded?'本人的实际回复已核对':loaded?'本人对话已加载，接入时自动验证回复':'开启客户端连接后，点击这里核对本人会话')}</span></div>${blocked&&nativeSetupOperation(job,'reauthorize')?`<button type="button" class="primary" data-native-operation="reauthorize" data-native-job="${escape(job.id)}">重新授权这位成员</button>`:''}${!loaded?mcp:''}<details class="native-connect-advanced"><summary>高级：连接诊断与兼容 MCP</summary><p class="small-note">首次启用本机连接后，后续沿用这位同事的本人会话；版本变化时会重新核对接口。</p><button type="button" class="secondary" data-native-diagnostics>查看连接诊断</button>${error?`<pre class="setup-code">${escape(error.message||'')}${error.code?`\n${escape(error.code)}`:''}</pre>`:''}${port?`<p class="small-note">对应客户端的本机诊断端口：${port}。在客户端关闭后按该版本的启动说明开启一次。</p>`:''}${loaded?mcp:''}</details>`;
}
async function connectNativeDesktop() {
  const memberId=selectedSetupMember,selectedRoom=roomId,provider=setupData?.client?.provider;
  if(!memberId||!selectedRoom||legacyId||setupData?.client?.kind!=='native_desktop')throw new Error('先选择这位同事的本人对话连接。');
  if(nativeSetupPending)return;const request={memberId,roomId:selectedRoom,provider},previous=typeof onboardingJobs==='undefined'?null:onboardingJobs.get(secretaryNavigation?.jobId),attempt=previous?captureOnboardingAttempt(previous):null;nativeSetupPending=request;nativeSetupFailure=null;renderSetup();
  try{
    const result=await api('/api/desktop/connect',{member_id:memberId,room_id:selectedRoom,provider});
    const job=result?.onboarding?.job||result?.onboarding;
    if(job?.id&&job.member_id===memberId&&job.room_id===selectedRoom&&selectedSetupMember===memberId&&roomId===selectedRoom&&!legacyId){
      if(previous&&attempt)adoptOnboardingJob(job,previous,attempt);else onboardingJobs.set(job.id,job);
      let flow=secretaryNavigation;
      if(!attempt||onboardingAttemptCurrent(attempt)){
        if(!secretaryNavigationCurrent(flow)||flow.memberId&&flow.memberId!==memberId)flow=beginSecretaryNavigation('member');
        flow.jobId=job.id;flow.memberId=memberId;
      }
    }
    const data=await api(`/api/chat/members/${encodeURIComponent(memberId)}/setup?room_id=${encodeURIComponent(selectedRoom)}`);
    await refresh();
    if(selectedSetupMember===memberId&&roomId===selectedRoom){setupData=data;const evidence=memberById(memberId)?.runtime_state?.connection_evidence;toast(evidence?.model_reply_verified&&evidence?.native_conversation_loaded?'本人对话和实际回复已核对。':job?.stage==='verifying_reply'?'本人对话已加载，正在自动验证实际回复。':evidence?.native_conversation_loaded?'本人对话已加载；正在核对实际回复。':'连接已准备；请核对本人会话的加载状态。');if(job?.id){returnSecretaryAfterOnboarding();action(refreshOnboarding);}}
  }catch(error){
    if(selectedSetupMember===memberId&&roomId===selectedRoom){nativeSetupFailure={...request,message:error.message||'本人对话连接尚未完成。',code:error.code||''};toast(nativeSetupFailure.message);}
  }finally{if(nativeSetupPending===request)nativeSetupPending=null;if(selectedSetupMember===memberId&&roomId===selectedRoom){lastSetupSignature='';renderSetup();}}
}
async function connectOnboardingNative(job) {
  if(!job?.member_id||job.room_id!==roomId||!nativeDesktopProvider(job))throw new Error('这个本人对话接入记录不属于当前房间，请检查进度。');
  activateOnboardingOperation(job);
  await showMemberSetup(job.member_id);
  if(job.room_id!==roomId||legacyId)throw new Error('当前房间已切换，请回到原房间继续连接本人对话。');
  if(selectedSetupMember!==job.member_id||setupData?.client?.provider!==job.provider||setupData.client.kind!=='native_desktop')throw new Error('本人对话的接入方式已更新，请查看当前成员连接。');
  await connectNativeDesktop();await refreshOnboarding();renderLaunch();
}
function renderSetup() {
  const member = memberById(selectedSetupMember) || setupData?.member || {}, status = memberStatus(member), data = setupData || {}, instructions = instructionsText(data), mcp = data.mcp, isBridge = member.adapter === 'grok-bridge';
  const guided=data.client?.kind==='grok_guided';
  const done=$('member-setup-dialog').querySelector('.member-setup-actions .primary.close-dialog');if(done)done.textContent=guided&&!grokSetupFresh(data)?'稍后继续':'完成';
  const observed = memberPresence(member);
  $('member-runtime-status').innerHTML = guided?'':`<span class="member-dot ${observed.status}"></span><strong>${escape(observed.label)}</strong><span>${observed.lastSeen ? `最近响应 ${escape(time(observed.lastSeen))}` : '尚无近期响应记录'}</span>${observed.canWake ? '<small>可拉起后台工作会话</small>' : ''}`;
  // Read-only evidence includes a new observed_at on every query. The guided
  // view renders only these stable fields; timestamp-only reads must not replace
  // a focused button or the text the person is manually selecting to copy.
  const clientSignature=guided?[data.client.kind,data.client.provider,data.client.copy,data.client.needs_prepare,data.client.needs_reauthorization,data.client.entry_status,data.client.revoked,data.client.handshake_verified,data.client.handshake_observed_at,data.client.ready_for_office,data.client.error,data.client.native_error,webConnected]:data.client;
  const signature = JSON.stringify([selectedSetupMember,member.name,member.status,member.error,member.verified_at,guided?null:member.runtime_state?.connection_evidence,member.desktop_connection,member.connection_method,data.error,data.invite,clientSignature,guided?null:nativeSetupJob(selectedSetupMember,data.client?.provider),instructions,mcp,nativeSetupPending,nativeSetupFailure,grokSetupWatch?.copied===true,grokSetupWatch?.clipboardFailure===true,grokSetupWatchError]); if (signature === lastSetupSignature) return; lastSetupSignature = signature;
  const needsInvite = !['codex','native'].includes(member.adapter) && !member.verified_at && !data.invite;
  const native=data.client?.kind==='native_desktop',evidence=nativeMemberEvidence(member,data.client?.connection_evidence||data.client?.native_state?.connection_evidence||{});
  const connectionLabel=native?nativeConnectionUnavailable(member)?'本人对话未连接 · 查看连接':evidence.native_conversation_loaded===true?evidence.model_reply_verified===true?'本人实际回复已核对':'本人对话已加载':'本人对话待验证':status.label,connectionTone=native?evidence.native_conversation_loaded===true?'online':'connecting':status.tone;
  $('member-setup-heading').textContent = member.name ? `连接 ${member.name}` : '连接成员'; $('member-setup-status').innerHTML = `<span class="member-dot ${connectionTone}"></span><strong>${escape(connectionLabel)}</strong>${!native&&member.verified_at ? `<span>验证于 ${time(member.verified_at)}</span>` : ''}`;
  $('bridge-webhook-section').classList.toggle('hidden', member.adapter !== 'grok-bridge'||native);
  renderConnectGuide(data.client, member);
  if(data.client?.needs_reauthorization){
    $('member-setup-status').innerHTML='<span class="member-dot connecting"></span><strong>原连接已撤销 · 需要重新授权</strong>';
    $('member-runtime-status').innerHTML='';$('member-setup-content').innerHTML='';$('retry-member-connect').classList.add('hidden');$('leave-member').classList.toggle('hidden',!roomId||legacyId);applySetupPresentation(data);return;
  }
  if(guided){
    $('member-setup-status').innerHTML=`<span class="member-dot ${grokSetupFresh(data)?'online':'connecting'}"></span><strong>${grokSetupFresh(data)?'这位 Grok 本次连接已核对':grokSetupReady(data)?'以前已验证，本次连接待核对':'完成下面两步，AO 会自动检查'}</strong>`;
    $('member-runtime-status').innerHTML='';$('bridge-webhook-section').classList.add('hidden');$('member-setup-content').innerHTML='';$('retry-member-connect').classList.add('hidden');$('leave-member').classList.toggle('hidden',!roomId||legacyId);applySetupPresentation(data,{keepGuide:true});return;
  }
  $('member-setup-content').innerHTML = `${!native&&(member.error || data.error) ? `<div class="error-note">${escape(member.error || data.error)}</div>` : ''}${status.tone === 'connecting' ? `<p class="setup-note"><span class="pulse-dot"></span> ${native?'正在核对本人对话的连接；实际模型回复会在任务发送后单独验证。':'正在后台询问成员并验证通信。你可以关闭这个窗口，连接结果会更新到成员列表。'}</p>` : ''}${instructions && (!data.client||native) ? `<details class="setup-block"><summary>${native?'高级：兼容接入说明':'兼容接入说明'}</summary><div class="setup-block-heading"><strong>${isBridge ? '桥接 Bot 协作说明' : '旧邀请 / 原生握手说明'}</strong><button class="secondary" data-copy-setup="instructions">复制说明</button></div>${native?'<p class="small-note">按需复制兼容说明，房间由 AO 自动确定。</p>':`<pre class="setup-code">${escape(instructions)}</pre>`}</details>` : ''}${mcp && (!data.client||native) ? `<details class="setup-block"><summary>${native?'高级：兼容 MCP 配置':'MCP 配置'}</summary><button class="secondary" data-copy-setup="mcp">复制配置</button>${native?'<p class="small-note">配置只在明确复制时提供，用于本人客户端的兼容入口。</p>':`<pre class="setup-code">${escape(setupText(mcp))}</pre>`}</details>` : ''}${!native&&!instructions && !mcp && status.tone !== 'connecting' ? `<p class="setup-note">${member.verified_at ? '身份已验证。使用上方恢复入口可以继续访问这个房间。' : '长期接入请复制上方恢复入口，由成员在自己的窗口实际进入。'}</p>` : ''}${isBridge&&!native ? '<div class="bridge-note"><strong>把房间带进 Grok 群聊</strong><p>在 Grok 中添加一个桥接 Bot，把上面的说明交给它，再邀请它加入你的群聊。它负责把问题带到 AgentRoom，并把成员回复带回群聊。长期入口与原群回传分别验证，发现窗口或保存 Webhook 不代表已经接通群聊。</p></div>' : ''}`;
  if (needsInvite && !data.client) { const note = document.createElement('p'); note.className = 'small-note'; note.textContent = '下方保留兼容邀请方式。长期接入请使用上方“复制恢复入口”，无需每次重新领取邀请。'; $('member-setup-content').prepend(note); const copyButton = $('member-setup-content').querySelector('[data-copy-setup="instructions"]'); if (copyButton) copyButton.textContent = '生成兼容邀请'; }
  $('retry-member-connect').textContent = status.tone === 'connecting' ? '连接中…' : needsInvite ? '生成兼容邀请' : '重新验证连接'; $('retry-member-connect').classList.toggle('hidden', !!data.client && data.client.kind !== 'background'); $('retry-member-connect').disabled = status.tone === 'connecting'; $('leave-member').classList.toggle('hidden', !roomId || legacyId);
  if(applySetupPresentation(data))$('retry-member-connect').classList.add('hidden');
}
// The dialog shows the same status and actions as the chat card; the older
// step-by-step guide stays available, folded, for manual setup and diagnosis.
function applySetupPresentation(data,{keepGuide=false}={}) {
  if(!data?.presentation||!selectedSetupMember)return false;
  $('member-setup-status').innerHTML=connectionPanelMarkup(data.presentation,{source:'member',id:selectedSetupMember});
  $('member-runtime-status').innerHTML='';
  const box=$('member-connect-guide');
  if(!keepGuide&&box&&box.innerHTML.trim()&&!box.querySelector(':scope > details.connection-guide-details'))box.innerHTML=`<details class="connection-guide-details"><summary>手动配置与诊断</summary>${box.innerHTML}</details>`;
  return true;
}
function updateRecipientNote() {
  if (recipientRoom === roomId) roomRecipients.set(roomId,$('recipient').value);
  const target = memberById($('recipient').value), observed = target && memberPresence(target);
  $('recipient-note').textContent = !target ? '公告会保存到房间，不自动唤醒成员' : !webConnected ? '服务未连接，连接后可发送消息' : target.status==='ready'&&target.can_notify===true ? `交给 ${target.name} · 发送后会自动通知它处理` : observed.canWake ? `交给 ${target.name} · 可按需拉起工作会话` : ['online','worker_online'].includes(observed.status) ? `交给 ${target.name} · ${observed.label}` : `消息会保留 · ${target.name} ${observed.label}`;
}
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
  card.innerHTML = '<div class="service-status-heading"><span id="service-dot" class="service-dot"></span><strong id="service-label">正在启动办公室</strong><span class="service-local-label">本机</span></div><p id="service-detail">服务随软件启动，房间与消息保存在这台电脑。</p><p id="service-error" class="error-note hidden" role="alert"></p><details class="service-controls"><summary>服务管理</summary><button id="service-toggle" type="button" class="secondary" disabled>检查状态</button><button id="service-check" type="button" class="text-button hidden">重新检查状态</button></details><small>关闭软件停止服务 · 最小化继续工作</small>';
  document.querySelector('.sidebar-footer').before(card);
  const alert = document.createElement('div'); alert.id = 'desktop-offline-banner'; alert.className = 'desktop-offline-banner hidden'; alert.setAttribute('role','status');
  alert.innerHTML = '<span>服务已关闭，你仍可查看本机历史。</span><button id="offline-start-service" class="text-button">开启服务，继续交流 ↗</button>';
  document.querySelector('.content').prepend(alert);
  $('service-toggle').onclick = () => action(() => !desktopReady?checkServiceState():desktopState?.update_available || desktop?.offline || !webConnected ? changeService('start_service') : showServiceStop());
  $('service-check').onclick=()=>action(checkServiceState);
  $('offline-start-service').onclick = () => action(() => desktopReady?changeService('start_service'):checkServiceState());
  $('service-stop-confirm').onclick = () => action(() => changeService('stop_service'));
  document.querySelector('.local-indicator').innerHTML = '<i id="top-service-dot"></i><span id="top-service-label">本机服务</span>';
}
function currentServiceBusy() {
  // An online API snapshot supersedes a previous host observation. Offline
  // persisted member labels are history, not proof of a live task.
  if(webConnected&&state)return !!state.activeRequest || !!state.chat?.activeMessages?.length || !!state.approvals?.length || Object.values(state.activeSetup || {}).some(Number) || (state.chat?.members || []).some(member => member.status === 'connecting');
  return desktopState?.running===true&&desktopState?.busy?.is_busy===true;
}
function renderVersion() {
  const label=$('app-version');if(!label)return;
  const version=value=>typeof value==='string'&&value.trim()?value.trim():null;
  const server=webConnected?version(state?.version):null,client=version(desktopState?.client_version);
  const parts=[server?`服务 v${server}`:webConnected?'服务版本未知':'服务未连接'];
  if(client&&client!==server)parts.push(`软件 v${client}`);
  label.textContent=parts.join(' · ');
  label.title=server&&client&&server!==client?'服务与软件版本不同。'+parts.join(' · '):label.textContent;
  label.dataset.mismatch=String(!!(server&&client&&server!==client));
}
function renderService() {
  renderVersion();
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
  const operationLabel=desktopOperation==='stopping'?'正在关闭服务…':desktopOperation==='updating'?'正在更新服务…':'正在开启服务…';
  $('service-label').textContent = desktopBusy ? operationLabel : desktopProbe?'正在检查服务…':running ? busy ? '服务运行中 · 工作进行中' : '服务运行中' : desktopReady ? '服务已关闭' : desktopError?'服务状态未确认':'正在检查服务';
  $('service-detail').textContent = running ? '消息可处理，成员可按需协作。' : '历史与成员已保留；开启后继续交流。';
  $('service-error').textContent=desktopError;$('service-error').classList.toggle('hidden',!desktopError);
  $('service-dot').classList.toggle('online',running); $('service-dot').classList.toggle('busy',running && busy);
  $('service-toggle').disabled = desktopBusy || !!desktopProbe;
  $('service-toggle').textContent = desktopBusy ? operationLabel : desktopProbe?'正在检查…':!desktopReady?'重新检查状态':running ? '关闭服务' : '开启服务';
  if(desktopState?.update_available&&!desktopBusy&&!desktopProbe){$('service-label').textContent='后台版本待更新';$('service-detail').textContent=`后台 ${desktopState.snapshot?.version||'旧版本'} · 软件 ${desktopState.client_version}。${busy?'当前工作结束后再更新。':'更新后接入修复才会生效。'}`;$('service-toggle').textContent='更新后台';$('service-toggle').disabled=busy;}
  $('service-check').classList.toggle('hidden',!desktopError&&desktopReady&&running&&!desktopBusy);$('service-check').disabled=!!desktopProbe;
  $('desktop-service').querySelector('small').textContent='关闭软件停止服务 · 最小化继续工作';
  const serviceControls=$('desktop-service').querySelector('.service-controls');if(serviceControls&&(desktopError||desktopReady&&desktopState?.running===false&&!desktopBusy))serviceControls.open=true;
  $('top-service-label').textContent = running ? busy ? '成员正在工作' : '服务运行中' : '历史浏览';
  $('top-service-dot').classList.toggle('stopped',!running);
  const footer = document.querySelector('.sidebar-footer'); footer.querySelector('.local-dot').classList.toggle('stopped',!running); footer.querySelector('span:not(.local-dot)').textContent='记录保存在这台电脑';
  $('desktop-offline-banner').classList.toggle('hidden',running);
  $('offline-start-service').disabled = desktopBusy || !!desktopProbe;
  $('offline-start-service').textContent=!desktopReady?'重新检查服务状态 ↗':desktopBusy?operationLabel:'开启服务，继续交流 ↗';
  $('composer').classList.toggle('read-only',readOnly);
  $('prompt').placeholder = readOnly ? '开启协作服务后，就可以继续发送消息…' : '说点什么…选择成员，或 @成员 提问';
}
async function showServiceStop() {
  desktopState = await desktop.command('state',roomId ? {room_id:roomId} : {}); desktopReady = true;
  const busy = typeof desktopState?.busy?.is_busy === 'boolean' ? desktopState.busy.is_busy : currentServiceBusy();
  $('service-stop-detail').textContent = busy ? '当前有消息处理、授权或接入任务。请先在聊天室完成或停止这些工作，再暂停服务。' : '暂停服务后仍可查看历史；下次打开软件会自动启动服务。最小化窗口可让成员继续工作。';
  $('service-stop-confirm').disabled = busy; $('service-stop-dialog').showModal(); renderService();
}
async function changeService(operation) {
  if (!desktop || desktopBusy || desktopProbe) return;
  desktopBusy = true;desktopOperation=operation==='stop_service'?'stopping':desktopState?.update_available?'updating':'starting';desktopError='';desktopErrorSource=null;renderService();
  try {
    const result=await desktop.command(operation,roomId ? {room_id:roomId} : {});desktopState=result;desktopReady=true;
    if(result.service_error)throw Object.assign(new Error(result.service_error),{code:result.service_error_code||'desktop_service_failed'});
    if(operation==='start_service'&&result.running!==true)throw Object.assign(new Error(result.connection_error||'本机服务尚未启动成功。请重新检查状态或查看启动日志；房间与历史仍保留。'),{code:'desktop_start_unconfirmed'});
    if(operation==='start_service'&&result.update_available===true)throw Object.assign(new Error('后台仍为旧版本，更新尚未完成。请检查原有服务状态，没有自动重试。'),{code:'desktop_update_incomplete'});
    if(operation==='stop_service'&&result.running!==false)throw Object.assign(new Error('服务关闭结果尚未确认。请重新检查状态，不要重复关闭。'),{code:'desktop_stop_unconfirmed'});
    if ($('service-stop-dialog').open) $('service-stop-dialog').close();
    if (operation === 'stop_service') {events?.close();setWebConnected(false);toast('服务已关闭，房间和消息仍保留。');}
    else {toast('协作服务已开启。');if(!desktop.offline)scheduleRefresh();}
  } catch(error){desktopError=error.message||'本机服务操作未完成。';desktopErrorSource=operation;throw error;}
  finally {desktopBusy=false;desktopOperation=null;renderService();}
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
  // Choosing the text view is the person taking over; a pending guided flow must not pull them back.
  if(!office)secretaryNavigation=null;
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
function officeApprovalCards() {
  return [...$('approval-panel').querySelectorAll('[data-approval]'),...$('messages').querySelectorAll('[data-approval],[data-approval-review][data-review-active="1"]')];
}
function updateOfficeApprovalAlert() {
  // Finished tasks keep their denial note in the timeline, but it no longer asks for attention.
  const count=officeApprovalCards().length;
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
  secretaryNavigation=null;
  setProfessionalView(true); secretaryOpenRoom = roomId; secretaryError = ''; renderSecretary(); updateOfficeScene();
}
function closeSecretaryTutorial() {
  secretaryNavigation=null;
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
  }).join('') : visibleMembers(history?.participants).length ? `<div class="secretary-no-members"><p>有 ${visibleMembers(history?.participants).length} 位成员还没接通。先到已有成员列表检查连接，接通后就能选它当秘书。</p><button type="button" class="secondary" data-secretary-member-connections>查看已有成员连接 ↗</button></div>` : '<p class="secretary-no-members">办公室还没有成员。接入一位你常用的 AI，再选择它当秘书。</p>';
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
  $('secretary-connect-status').textContent = !webConnected ? '服务未连接，请先开启本机服务。' : secretaryConnectRoom === roomId ? '优先显示本机正在运行的 AI。选择成员接入，通信方式见每张卡片。' : '你已切换房间。关闭此页后，在目标房间重新接入。';
  $('secretary-scan-agents').disabled = !webConnected || launchScanning || secretaryConnectRoom !== roomId;
  const othersOpen = $('secretary-connect-candidates').querySelector('.launch-other-candidates')?.open === true;
  const candidateCopy = $('launch-candidates').cloneNode(true);
  candidateCopy.querySelectorAll('.launch-candidate-select').forEach(element=>element.remove());
  const otherCandidates = candidateCopy.querySelector('.launch-other-candidates');
  if (otherCandidates) otherCandidates.open = othersOpen;
  if ($('secretary-connect-candidates').innerHTML !== candidateCopy.innerHTML) $('secretary-connect-candidates').innerHTML = candidateCopy.innerHTML;
  const attempt=onboardingJobs.get(secretaryConnectJob)||currentOnboardingJobs().find(job=>onboardingRunning(job))||currentOnboardingJobs()[0];
  setApprovalMarkup($('secretary-connect-progress'),attempt?onboardingJobMarkup(attempt):'',state?.approvals||[]);
  $('secretary-connect-candidates').querySelectorAll('button').forEach(button => { if(secretaryConnectRoom !== roomId||onboardingRunning(attempt)) button.disabled = true; });
  $('secretary-connect-progress').querySelectorAll('button').forEach(button => { if(secretaryConnectRoom !== roomId || !webConnected) button.disabled = true; });
  if(attempt)revealOnboardingAction(attempt);
  const pickerError=launchError||(secretaryNavigationCurrent(secretaryNavigation)&&secretaryNavigation.source==='picker'?secretaryError:'');
  $('secretary-connect-error').textContent = pickerError; $('secretary-connect-error').classList.toggle('hidden',!pickerError);
}
function beginSecretaryNavigation(source) {
  return secretaryNavigation={source,roomId,projectId,jobId:null,memberId:null,assignment:{...currentSecretary()},accepted:null,assignmentAttempted:false};
}
function secretaryNavigationCurrent(flow) {
  return !!flow && secretaryNavigation===flow && flow.roomId===roomId && flow.projectId===projectId && !legacyId;
}
function finishSecretaryNavigation(flow,expected) {
  const selected=currentSecretary();
  const members=admittedMembers(history?.participants);
  if(!secretaryNavigationCurrent(flow) || history?.room?.id!==flow.roomId || flow.memberId && !members.some(member=>member.id===flow.memberId))return false;
  if(flow.source!=='member'&&(!sameSecretaryAssignment(expected,selected) || selected.status!=='ready' || !members.some(member=>member.id===selected.member_id)))return false;
  const job=flow.jobId && onboardingJobs.get(flow.jobId);
  if(flow.jobId && (!job || !onboardingOfficeReady(job) || job.member_id!==flow.memberId || job.room_id && job.room_id!==flow.roomId || flow.requireAutomatic && !job.can_wake))return false;
  // Consume only this user-initiated flow. Loading an already-ready room never navigates.
  secretaryNavigation=null;if(flow.jobId===secretaryConnectJob)secretaryConnectJob=null;
  if(flow.source==='picker' && secretaryConnectRoom===flow.roomId && $('secretary-connect-dialog').open)$('secretary-connect-dialog').close();
  if(selectedSetupMember===(flow.memberId||selected.member_id) && $('member-setup-dialog').open)$('member-setup-dialog').close();
  secretaryPickingRoom=null;closeSecretaryTutorial();setProfessionalView(true);selectRoomView(true);
  // Only a newly seated secretary becomes the recipient; connecting another member keeps the person's choice.
  if(flow.source==='member'){if(!$('recipient').value){$('recipient').value=flow.memberId;updateRecipientNote();}}
  else if(!flow.memberId || flow.memberId===selected.member_id){$('recipient').value=selected.member_id;updateRecipientNote();}
  toast(job?.reused_connection===true||job?.connection_reused===true?'已加入办公室，沿用原有连接和配置。':flow.source==='member'||flow.memberId && flow.memberId!==selected.member_id?onboardingReady(job)==='ready_mailbox'?'成员信箱已接通，已进入办公室。':'成员已真实接通，已进入办公室。':'秘书已真实接通，可以在办公室交代目标。');return true;
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
  const selectedRoom = roomId,flow=beginSecretaryNavigation('selection');flow.memberId=memberId;secretaryBusy = true; secretaryError = ''; renderSecretary();
  try {
    const accepted = secretaryResponse(await api('/api/secretary',{room_id:selectedRoom,member_id:memberId}),selectedRoom);if(!secretaryNavigationCurrent(flow))return;flow.accepted=accepted;await refreshSecretaryState();
    if(!secretaryNavigationCurrent(flow))return;
    if(sameSecretaryAssignment(accepted,currentSecretary())){secretaryPickingRoom=null;if(!finishSecretaryNavigation(flow,accepted)){secretaryOpenRoom=roomId;toast('秘书角色已保存，请继续完成接入。');}}
    else {secretaryNavigation=null;secretaryError = '秘书设置已在其他窗口变更，已显示最新角色。请重新确认。';}
  }
  catch(error){ if(secretaryNavigationCurrent(flow)){secretaryNavigation=null;secretaryError = error.message;}throw error; }
  finally {secretaryBusy = false; renderSecretary(); updateOfficeScene();}
}
async function clearSecretary() {
  if(secretaryBusy || secretaryStartBusy || !roomId) return; secretaryNavigation=null;const selectedRoom = roomId; secretaryBusy = true; renderSecretary();
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
  if (!roomId || !webConnected) return; secretaryNavigation=null;secretaryConnectRoom = roomId; secretaryConnectJob = null; secretaryError = ''; renderSecretary(); $('secretary-connect-dialog').showModal();
  void scanLaunch({quiet:true});
}
function updateOfficeScene() {
  if(!officeView || !professionalView || !history?.room || legacyId) return;
  if(!officeScene && window.AgentOfficeScene) officeScene=window.AgentOfficeScene.mount($('officeScene'),{onCompose:()=>toggleOfficeComposer(true),onChooseSecretary:openSecretaryTutorial,onSelectMember:member=>{if(nativeConnectionUnavailable(member)){action(()=>showMemberSetup(member.id));return;}if(!submitting && [...$('recipient').options].some(option=>option.value===member.id)){$('recipient').value=member.id;updateRecipientNote();}toggleOfficeComposer(true);},onCustomize:member=>openInspector('appearance',member.id),onSceneSettings:()=>openInspector('scene'),onToggleLights:on=>action(()=>setOfficeLighting(on)),onSelectMessage:message=>{selectRoomView(false);requestAnimationFrame(()=>$('message-'+message.id)?.scrollIntoView({block:'center',behavior:'smooth'}));}});
  officeScene?.update({roomId:history.room.id,participants:admittedMembers(history.participants),messages:(history.messages||[]).filter(message=>!message.connection_verification),runtime,online:webConnected,scene:state?.office?.[history.room.id]||{},secretary:currentSecretary(),tutorialVisible:secretaryTutorialVisible()});
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
  $('inspector-members').innerHTML = members.length ? members.map(member => {const presence=memberPresence(member),evidence=nativeMemberEvidence(member),hint=nativeConnectionUnavailable(member)?'本人对话尚未连接，点开查看连接步骤':grokGuidedPerson(member)?member.verified_at?'Grok 本机入口已验证，点开查看':'把连接说明发给 Grok，AO 自动检查':nativeDesktopProvider(member)?evidence.native_conversation_loaded===true?evidence.model_reply_verified===true?'本人实际回复已核对':'本人对话已加载，实际回复待验证':'本人对话连接待核对，点开继续':!member.verified_at ? (member.status === 'connection_failed' ? '接入失败，点开查看原因' : '还没接通，点开看怎么连接') : presence.canWake ? '发消息会自动开工' : '要在它自己的窗口里处理';return `<button type="button" class="inspector-member" data-inspector-member="${escape(member.id)}">${avatar(member.name,member.adapter,member.appearance)}<div><strong>${escape(member.name)}${currentSecretary().member_id === member.id ? ' <span class="secretary-inline-badge">秘书</span>' : ''}</strong><span><i class="member-dot ${presence.status}"></i>${escape(presence.label)}</span><small>${escape(hint)}</small></div><span class="inspector-member-arrow">›</span></button>`;}).join('') + (staleMembers().length ? `<button type="button" class="text-button danger" id="cleanup-stale-members">清理 ${staleMembers().length} 个没接通的旧成员</button>` : '') : '<p class="inspector-empty">房间成员会显示在这里。<br>只接入你选择的 agent。</p>';
  const bridge = members.find(member => member.adapter === 'grok-bridge'), proxies=launchSession&&room?.id&&launchSession.room_id===room.id?launchSession.proxies||[]:[], linked = proxies.filter(proxy=>proxy.native_group_status==='host_reported').length || members.filter(member=>member.native_group_status==='host_reported').length, groupRef=proxies.find(proxy=>proxy.native_group_ref)?.native_group_ref || (launchSession&&room?.id&&launchSession.room_id===room.id?launchSession.native_sync?.group_ref:null);
  $('inspector-bridge-detail').textContent = bridge ? `已有 ${bridge.name} 桥接入口。群里的问题和成员回复可以回到同一房间。` : linked ? 'Grok 已报告加群。原群状态与本机通信分别记录。' : '给 Grok Bot 接入说明后，可以在你指定的群里与这些成员交流。';
  $('inspector-bridge').disabled = !webConnected;
  $('inspector-project-details').innerHTML=detailRows([['项目',project?.name],['文件夹',project?.path||room?.project_path],['访问权限',project?.access==='workspace-write'?'允许项目修改':'仅查询资料']]);
  $('inspector-room-details').innerHTML=detailRows([['房间',room?.title],['成员',String(members.length)+' 位'],['保存消息',String(history?.messages?.length||0)+' 条'],['房间标识',room?.id],['记录位置',state.dataDirectory],['服务',webConnected?'本机服务运行中':'服务未连接，查看本机记录']]);
  $('inspector-native-detail').textContent=groupRef ? `Grok 已报告群引用：${groupRef}。${linked} 位成员已报告加群，原群状态仍需核对；桥接的请求和回复保存在本机。` : linked ? `${linked} 位成员已报告加群。通过本机桥接投递的消息保留在这里。` : bridge ? `已配置 ${bridge.name}。完整 Grok 群消息暂不自动同步，桥接的请求与回复会留在本机。` : '还未绑定 Grok 群聊。可在连接页查看桥接入口。';
  const member=members.find(item=>item.id===inspectorMemberId), presence=member?memberPresence(member):null,guidedGrok=grokGuidedPerson(member),native=nativeDesktopProvider(member)&&!guidedGrok,evidence=nativeMemberEvidence(member);
  $('inspector-selected-member').innerHTML=member?`${avatar(member.name,member.adapter,member.appearance)}<h3>${escape(member.name)}</h3><p>${escape(presence.label)} · ${escape(native?'本人客户端中的独立原生对话':guidedGrok?'Grok 本机入口 · 自动接手另行验证':presence.canWake?'可按需后台处理':'本人窗口领取消息')}</p>${native?nativeReadinessMarkup({},evidence):`<p>${escape(memberStatus(member).label)}</p>`}`:'<p class="inspector-description">先在成员页选择一位成员。</p>';
  $('inspector-member-connect').disabled=!member||!webConnected;$('inspector-member-connect').textContent=guidedGrok?'连接 Grok':native?'连接本人对话':'查看成员连接';$('inspector-member-connect').classList.toggle('primary',native||guidedGrok);$('inspector-member-connect').classList.toggle('secondary',!native&&!guidedGrok);$('inspector-member-recovery').disabled=!member;
  $('inspector-connection-note').textContent=guidedGrok?'复制一次连接说明，发给这位 Grok Bot。AO 自动检查真实连接，无需先建群，也无需填写编号。':native?'AO 为这位同事保留本人客户端中的原生对话。点击“连接本人对话”核对本机连接；会话加载与实际问题的回答分别验证。':'桌面信箱成员需要在本人窗口领取消息。窗口打开不会自动唤醒它。';
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
  for(const issue of data.coordination_issues||[])html+=`<p class="team-notice">${escape(issue)}</p>`;
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
const officeLightingPending=new Set();
async function setOfficeLighting(on){
  const selectedRoom=roomId;if(!selectedRoom||!webConnected||officeLightingPending.has(selectedRoom))return;
  officeLightingPending.add(selectedRoom);
  try{
    const response=await api('/api/office',{room_id:selectedRoom,lights_on:on}),saved=sceneConfig(response?.scene||response?.config||response);
    state.office={...state.office,[selectedRoom]:saved};
    const draft=sceneDrafts.get(selectedRoom);if(draft){draft.config.lights_on=saved.lights_on;draft.signature=JSON.stringify(saved);draft.version++;}
    if(roomId===selectedRoom){renderRoom(state.projects.find(item=>item.id===projectId));renderScene();}
  }finally{officeLightingPending.delete(selectedRoom);}
}
function sceneConfig(value={}) {
  if(!value||typeof value!=='object')value={};
  const result={...sceneDefaults};
  if(typeof value.time_zone==='string'&&value.time_zone.length<=100)result.time_zone=value.time_zone;
  if(['auto','day','night'].includes(value.time_mode))result.time_mode=value.time_mode;
  if(Number.isInteger(value.columns)&&value.columns>=1&&value.columns<=3)result.columns=value.columns;
  if(Number.isFinite(value.spacing)&&value.spacing>=.8&&value.spacing<=1.3)result.spacing=value.spacing;
  for(const field of ['wall_color','floor_color'])if(/^#[0-9a-f]{6}$/i.test(value[field]||''))result[field]=value[field];
  for(const field of ['auto_layout','show_window','show_clock','show_plant','motion','lights_on'])if(typeof value[field]==='boolean')result[field]=value[field];
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
  for(const field of ['auto_layout','show_window','show_clock','show_plant','motion','lights_on'])$('scene-'+field.replaceAll('_','-')).checked=config[field];
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
$('secretary-dismiss').onclick = closeSecretaryTutorial; $('secretary-look-around').onclick = () => {closeSecretaryTutorial();selectRoomView(true);};
$('secretary-member-options').onclick = event => {const button = event.target.closest('[data-secretary-select],[data-secretary-member-connections]');if(!button||button.disabled)return;if(button.hasAttribute('data-secretary-member-connections')){closeSecretaryTutorial();openInspector('members');return;}action(()=>chooseSecretary(button.dataset.secretarySelect));};
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
$('secretary-connect-back').onclick = ()=>{secretaryNavigation=null;$('secretary-connect-dialog').close();secretaryConnectJob=null;openSecretaryTutorial();};
$('secretary-connect-manual').onclick = ()=>{secretaryNavigation=null;$('secretary-connect-dialog').close();secretaryConnectJob=null;action(showMembers);};
$('secretary-connect-dialog').addEventListener('close',()=>{if(secretaryNavigation?.source==='picker'&&!secretaryNavigation.setupMemberId)secretaryNavigation=null;});
$('office-approval-alert').onclick=()=>{selectRoomView(false);requestAnimationFrame(()=>{const card=officeApprovalCards().at(-1);if(!card)return;card.scrollIntoView({block:'center',behavior:'smooth'});card.querySelector('input,button,a')?.focus({preventScroll:true});});};
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
for(const field of ['auto_layout','show_window','show_clock','show_plant','motion','lights_on'])$('scene-'+field.replaceAll('_','-')).onchange=()=>changeScene(field,$('scene-'+field.replaceAll('_','-')).checked);
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
$('launch-project-select').onchange = () => { secretaryNavigation=null;projectId = $('launch-project-select').value; roomId = null; legacyId = null; launchSession = null; launchError = ''; setReply(null); action(refresh); };
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
      if(operation==='native_desktop_connect'){await connectOnboardingNative(job);return;}
      await runOnboardingOperation(job,operation);
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
$('mirror-open').onclick = () => action(showMirror);
$('mirror-form').onsubmit = event => action(() => createMirror(event));
$('mirror-check').onclick = () => action(dispatchMirror);
$('mirror-copy').onclick = () => action(async () => {
  if (mirrorRoom !== roomId || !mirrorSession?.grok_prompt) return;
  await navigator.clipboard.writeText(mirrorSession.grok_prompt); toast('已复制，发给 Grok 即可继续。');
});
$('mirror-dialog').addEventListener('close', () => { clearUITimeout(mirrorTimer); mirrorRoom = null; mirrorSession = null; mirrorDispatched = null; });
$('launch-refresh').onclick = () => action(async () => { launchError = ''; await refreshLaunch(); });
$('launch-copy').onclick = () => action(async () => { if (!launchSession?.grok_prompt || !launchSession.handoff_file || launchSession.status === 'preparing' || launchBusy) return; try { await navigator.clipboard.writeText(launchSession.grok_prompt); toast('本次接入说明已复制，只包含你指定的成员。'); } catch (error) { document.querySelector('.launch-instructions').open = true; toast('自动复制未完成，本次说明已展开，可手动复制。'); } });
for (const id of ['add-room','welcome-room','mobile-add-room']) $(id).onclick = () => showRoom();
for (const id of ['settings-button','top-settings']) $(id).onclick = showSettings;
for (const id of ['welcome-members','room-member-add','empty-add-member']) $(id).onclick = () => action(showMembers);
document.querySelectorAll('.close-dialog').forEach(button => button.onclick = () => button.closest('dialog').close());
$('member-setup-dialog').addEventListener('close',()=>{stopGrokSetupWatch();grokSetupWatchError='';if(secretaryNavigation?.setupMemberId===selectedSetupMember)secretaryNavigation=null;});
$('connector-fields-dialog').addEventListener('close',()=>{connectorFields=null;for(const name of ['name','transport','url','headers'])$('connector-'+name).value='';$('connector-instructions').textContent='';$('connector-docs').removeAttribute('href');});
$('connector-fields-dialog').onclick=event=>{const button=event.target.closest('[data-connector-copy]');if(!button||!connectorFields)return;action(async()=>{const name=button.dataset.connectorCopy,value=connectorFields[name];if(value===undefined)return;if(name==='headers'&&!Object.keys(value).length){toast('这个连接器不需要标头。');return;}await navigator.clipboard.writeText(typeof value==='string'?value:JSON.stringify(value,null,2));toast('已复制。只填写到这个 AI 本人的连接器设置。');});};
$('connector-copy-all').onclick=()=>action(async()=>{if(!connectorFields)return;const fields=connectorFields;await navigator.clipboard.writeText(`名称：${fields.name}\n连接方式：${fields.transport}\nURL：${fields.url}\n标头：${Object.keys(fields.headers).length?JSON.stringify(fields.headers,null,2):'无需填写'}`);toast('字段已复制。按名称、连接方式、URL 分别填写，不作为 JSON 导入。');});
$('projects').onclick = event => { const button = event.target.closest('[data-project]'); if (button) { secretaryNavigation=null;projectId = button.dataset.project; roomId = null; legacyId = null; document.body.classList.remove('mobile-sidebar-open');syncSidebarToggle();setReply(null); action(refresh); } };
const onRoomListClick = event => { const manage=event.target.closest('[data-room-actions]');if(manage){showRoomActions(manage.dataset.roomActions);return;}const button = event.target.closest('[data-room]'); if (button) { secretaryNavigation=null;roomId = button.dataset.room; legacyId = null;document.body.classList.remove('mobile-sidebar-open');syncSidebarToggle();setReply(null); setProfessionalView(true); action(refresh); } };
$('rooms').onclick=onRoomListClick;$('archived-rooms-list').onclick=onRoomListClick;
$('room-actions-archive').onclick=()=>action(toggleRoomArchive);
$('room-actions-delete').onclick=()=>{const id=managedRoomId;$('room-actions-dialog').close();managedRoomId=null;showDeleteRoom(id);};
$('room-actions-start').onclick=()=>action(()=>desktopReady?changeService('start_service'):checkServiceState());
$('delete-room-confirm').onclick=()=>action(confirmDeleteRoom);
$('delete-room-blockers').onclick=event=>action(async()=>{const button=event.target.closest('[data-delete-blocker]'),target=state?.chat?.rooms?.find(room=>room.id===deleteRoomId);if(!button||!target)return;const kind=button.dataset.blockerKind,id=button.dataset.deleteBlocker;$('delete-room-dialog').close();roomId=target.id;projectId=target.project_id;legacyId=null;setReply(null);await refresh();if(kind==='message'){selectRoomView(false);requestAnimationFrame(()=>$('message-'+id)?.scrollIntoView({block:'center'}));}else openInspector(kind==='binding'?'connections':'team',kind==='binding'?id:undefined);});
$('discussions').onclick = event => { const button = event.target.closest('[data-discussion]'); if (button) { secretaryNavigation=null;legacyId = button.dataset.discussion; setReply(null); action(refresh); } };
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
$('member-setup-content').onclick = event => { const button = event.target.closest('[data-copy-setup]'); if (!button) return; action(async () => { const member = memberById(selectedSetupMember) || setupData?.member || {}; if (setupData?.client?.kind!=='native_desktop' && button.dataset.copySetup === 'instructions' && !['codex','native'].includes(member.adapter) && !member.verified_at && !setupData?.invite) { setupData = await api(`/api/chat/members/${encodeURIComponent(selectedSetupMember)}/connect`,{room_id:roomId}); renderSetup(); await refresh(); } await navigator.clipboard.writeText(button.dataset.copySetup === 'mcp' ? setupText(setupData?.mcp) : instructionsText(setupData || {})); toast('已复制成员的专属接入说明。'); }); };
$('member-grok-form').onsubmit = event => { event.preventDefault(); action(async () => { const button = $('member-grok-form').querySelector('button'); button.disabled = true; try { await api(`/api/chat/members/${encodeURIComponent(selectedSetupMember)}/grok-configure`,{url:$('member-grok-url').value,key:$('member-grok-key').value}); $('member-grok-key').value = ''; $('member-grok-url').value = ''; toast('这个桥接成员的通知连接已加密保存，原群回报仍需真实验证。'); await refresh(); } finally { button.disabled = false; } }); };
$('retry-member-connect').onclick = () => action(() => connectMember(selectedSetupMember));
$('leave-member').onclick = () => action(async () => { await api(`/api/chat/rooms/${encodeURIComponent(roomId)}/leave`, {member_id:selectedSetupMember}); $('member-setup-dialog').close(); setReply(null); await refresh(); toast('成员已移出这个房间，之前的消息仍保留。'); });
$('room-recovery').onclick = () => showResume();
$('member-view-entry').onclick = () => showResume(selectedSetupMember);
$('bridge-view-entry').onclick = () => showResume(bridgeMemberId);
$('member-connect-guide').onclick = event => {
  const button=event.target.closest('[data-native-connect],[data-native-operation],[data-native-diagnostics],[data-copy-guide],[data-copy-bootstrap],[data-copy-install],[data-grok-copy],[data-grok-enter],[data-grok-enter-history]');if(!button||button.disabled)return;
  if(button.hasAttribute('data-native-operation'))return action(async()=>{
    const memberId=selectedSetupMember,selectedRoom=roomId,client=setupData?.client,operation=button.dataset.nativeOperation,job=nativeSetupJob(memberId,client?.provider);
    if(legacyId||client?.kind!=='native_desktop'||!webConnected||!['open_native_client','manual_mcp','reauthorize'].includes(operation)||!job||job.id!==button.dataset.nativeJob||!nativeSetupOperation(job,operation))throw Error('这位成员的连接步骤已变化，请查看当前接入进度。');
    button.disabled=true;
    try{await runOnboardingOperation(job,operation);if(selectedSetupMember!==memberId||roomId!==selectedRoom||legacyId)return;const data=await api(`/api/chat/members/${encodeURIComponent(memberId)}/setup?room_id=${encodeURIComponent(selectedRoom)}`);if(selectedSetupMember===memberId&&roomId===selectedRoom&&!legacyId){setupData=data;nativeSetupFailure=null;lastSetupSignature='';renderSetup();}}
    finally{button.disabled=false;}
  });
  if(button.hasAttribute('data-grok-enter-history'))return enterGrokOffice(grokSetupWatch,{allowHistorical:true});
  if(button.hasAttribute('data-grok-enter'))return enterGrokOffice(grokSetupWatch);
  if(button.hasAttribute('data-grok-copy'))return action(async()=>{
    const watch=grokSetupWatch;if(!watch||!grokSetupWatchCurrent(watch)||watch.copying||grokSetupBlocked(setupData.client))return;
    watch.copying=true;lastSetupSignature='';renderSetup();
    try{
      if(setupData.client.needs_prepare){const data=await api(`/api/chat/members/${encodeURIComponent(watch.memberId)}/setup`,{room_id:watch.roomId});if(!grokSetupWatchCurrent(watch))return;setupData=data;}
      const text=setupData?.client?.copy;if(!text||grokSetupBlocked(setupData.client))throw Error('连接说明尚未准备好，请查看下方帮助，保留现有人物。');
      try{await navigator.clipboard.writeText(text);}catch(error){if(grokSetupWatchCurrent(watch)){watch.clipboardFailure=true;toast('未能自动复制。请选中页面中的连接说明，复制后发给 Grok。');}return;}if(!grokSetupWatchCurrent(watch))return;
      watch.clipboardFailure=false;watch.copied=true;toast('已复制。现在粘贴到 Grok 对话中，AO 会自动检查连接结果。');
    }finally{watch.copying=false;if(grokSetupWatchCurrent(watch)){lastSetupSignature='';renderSetup();}}
  });
  if(button.hasAttribute('data-native-connect'))return action(connectNativeDesktop);
  if(button.hasAttribute('data-native-diagnostics')){const memberId=selectedSetupMember;$('member-setup-dialog').close();openInspector('connections',memberId);$('connection-doctor-member').value=memberId;return action(runConnectionDoctor);}
  if(setupData?.client?.kind==='native_desktop'&&!nativeMcpAllowed(setupData.client,memberById(selectedSetupMember)||setupData.member))return toast('当前连接仍需核对或重新授权，请按这位成员的现有步骤继续。');
  const guide=fallbackConnectGuide(),install=button.hasAttribute('data-copy-install'),bootstrap=button.hasAttribute('data-copy-bootstrap'),text=install?guide?.installation_prompt:bootstrap?guide?.bootstrap:guide?.copy;if(!text)return;
  action(async()=>{await navigator.clipboard.writeText(text);toast(install?'已复制。交给有本机配置能力的安装 AI，按当前对话的真实工具调用验收。':bootstrap?'已复制。发到这位同事的 AI 对话里，验证当前对话实际加载的 AO 工具。':'已复制。粘贴到客户端的 MCP 设置，不能仅发给聊天模型。');});
};
$('member-copy-entry').onclick = () => action(async () => { const button = $('member-copy-entry'); button.disabled = true; try { await copyResume(selectedSetupMember); } finally { button.disabled = false; } });
$('bridge-copy-entry').onclick = () => action(async () => { const button = $('bridge-copy-entry'); button.disabled = true; try { await copyResume(bridgeMemberId,bridgeRoomId); } finally { button.disabled = false; } });
$('resume-member').onchange = renderResume;
$('resume-copy').onclick = () => action(async () => { if (entryBusy) return; entryBusy = true; renderResume(); try { await copyResume($('resume-member').value); } finally { entryBusy = false; renderResume(); } });
$('resume-wake').onclick = () => action(async () => { const memberId = $('resume-member').value; entryBusy = true; renderResume(); try { await api('/api/runtime/wake',{room_id:roomId,member_id:memberId}); await refresh(); toast('已请求拉起该成员的后台工作会话。'); } finally { entryBusy = false; renderResume(); } });
$('resume-revoke').onclick = () => action(async () => { const memberId = $('resume-member').value; entryBusy = true; renderResume(); try { await api('/api/resume/revoke',{member_id:memberId,room_id:roomId}); for (const [key,entry] of Object.entries(resumeEntries)) if (entry.member_id === memberId && entry.room_id === roomId) delete resumeEntries[key]; localStorage.setItem(entryCacheKey,JSON.stringify(resumeEntries)); toast('该成员在这个房间的旧恢复入口已撤销，可以重新生成。'); await refresh(); } finally { entryBusy = false; renderResume(); } });
$('browse-folder').onclick = () => action(browseProjectFolder);
$('cancel-folder').onclick = () => projectPicker?.abort();
$('project-dialog').addEventListener('close',()=>projectPicker?.abort());
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
$('prompt').oninput = ()=>{secretaryNavigation=null;renderMentions();updateOfficeComposerPresentation();};
$('prompt').onkeydown = event => {
  if (event.isComposing || event.keyCode === 229) return;
  const picking = !$('mention-choices').classList.contains('hidden');
  if (picking && ['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); moveMention(event.key === 'ArrowDown' ? 1 : -1); return; }
  if (picking && !event.shiftKey && ['Tab','Enter'].includes(event.key)) { event.preventDefault(); $('mention-choices').querySelector('[data-mention].active')?.click(); return; }
  if (event.key === 'Escape') { $('mention-choices').classList.add('hidden'); if (!picking && document.body.classList.contains('office-view')) toggleOfficeComposer(false); }
  if (event.key === 'Enter' && !event.shiftKey && $('mention-choices').classList.contains('hidden')) { event.preventDefault(); $('composer').requestSubmit(); }
};
$('mention-choices').onclick = event => { const button = event.target.closest('[data-mention]'); if (!button) return; const member = memberById(button.dataset.mention), input = $('prompt'), before = input.value.slice(0,input.selectionStart), after = input.value.slice(input.selectionEnd), value = before.replace(/@([^\s@]*)$/u,() => `@${member.name} `); input.value = value + after; input.focus(); input.setSelectionRange(value.length,value.length); $('recipient').value = member.id; updateRecipientNote(); $('mention-choices').classList.add('hidden'); };
$('messages').onclick = event => { const button = event.target.closest('button'); if (!button) return; if(button.dataset.approve || button.dataset.inputSubmit || button.dataset.formSubmit){action(()=>respondToApproval(button));return;}if(button.dataset.approvalTask){$('message-'+button.dataset.approvalTask)?.scrollIntoView({block:'center',behavior:'smooth'});return;}if(button.dataset.reviewMember){if(![...$('recipient').options].some(option=>option.value===button.dataset.reviewMember)){toast('这位成员当前未接通，请先查看成员连接。');openInspector('connections',button.dataset.reviewMember);return;}$('recipient').value=button.dataset.reviewMember;updateRecipientNote();const task=history.messages.find(message=>message.id===button.dataset.reviewTask);if(task)setReply(task);$('prompt').focus();return;}if(button.dataset.openMember)openInspector('connections',button.dataset.openMember);if(button.hasAttribute('data-open-team')){openInspector('team');action(()=>refreshTeam());}if (button.dataset.reconcileMessage) openTeamDialog('message_reconcile',button.dataset.reconcileMessage); if (button.dataset.reply) setReply(history.messages.find(message => message.id === button.dataset.reply)); if (button.dataset.cancelMessage) action(async () => { await api(`/api/chat/messages/${encodeURIComponent(button.dataset.cancelMessage)}/cancel`,{}); await refresh(); }); };
document.addEventListener('click', event => { if (event.target.closest('#cleanup-stale-members')) action(async () => { const result = await api('/api/chat/members/cleanup',{}); await refresh(); toast(`已把 ${result.removed.length} 个没接通的成员移出房间，聊天记录保留。`); }); });
document.addEventListener('click', event => { const button = event.target.closest('[data-onboarding-approve]'); if (button)action(()=>respondToApproval(button)); });
document.addEventListener('click', event => { const button=event.target.closest('[data-copy-approval-url]');if(button)action(()=>copyApprovalLink(button)); });
document.addEventListener('click',event=>{const button=event.target.closest('[data-question-choice]');if(button)selectApprovalQuestionChoice(button);});
document.addEventListener('input',event=>{const input=event.target.closest('[data-question]');if(input)syncApprovalQuestionChoices(input);});
document.addEventListener('click', event => {const button=event.target.closest('.onboarding-approval [data-input-submit],.onboarding-approval [data-form-submit]');if(button)action(()=>respondToApproval(button));});
$('approval-panel').onclick = event => action(()=>respondToApproval(event.target.closest('button')));
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
    bridgeLoading = false; clearUITimeout(bridgeTimer);
    if ($('bridge-dialog').open && (bridgeRefreshAgain || ['waiting','running','queued'].includes(bridgeTest?.status || bridgeTest?.state))) { bridgeRefreshAgain = false; bridgeTimer = setUITimeout(() => action(refreshBridge),1500); }
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
  $('bridge-copy-note').textContent = cached ? '请发给 Grok。入口长期保留，接入进度另行验证。' : prepared ? '已生成过说明。可再次复制这位 Bot 的入口。' : '说明会带上这位 Bot 的长期本机入口。';
  $('bridge-handshake-state').textContent = verified ? '本机握手已验证' : '等待 Bot 加入'; $('bridge-handshake-state').className = `bridge-step-state ${verified ? 'verified' : ''}`;
  $('bridge-handshake-detail').textContent = verified ? '这个桥接成员已执行真实本机握手。接下来分别确认协作通路和 Grok 原对话回报。' : 'Grok Bot 执行本机加入握手后，这里才会显示已验证。复制说明、创建 Bot 和通信接通是不同的步骤。';
  $('bridge-stage-list').innerHTML = stages.map(stage => { const status = stage.id === 'native_return' && !nativeVerified && stage.state === 'complete' ? 'needs_action' : stage.state, prompt = stage.id === 'prompt', complete = status === 'complete' && !prompt, label = prompt ? '完整接入说明' : stage.label, detail = prompt ? status === 'complete' ? '仅表示说明已生成，仍需交给 Grok 执行。' : '先生成说明，再交给 Grok 安排创建与接入。' : stage.detail; return `<div class="bridge-stage ${complete ? 'complete' : ''}"><span class="bridge-stage-icon">${complete ? '✓' : '○'}</span><div><strong>${escape(label)}</strong>${detail ? `<small>${escape(detail)}</small>` : ''}</div><span>${prompt && status === 'complete' ? '已生成说明' : complete ? '已确认' : status === 'needs_action' ? '需要操作' : '待确认'}</span></div>`; }).join('');
  $('bridge-local-proof').textContent = localVerified ? '本机通路已验证' : ['waiting','running','queued'].includes(bridgeTestState(latestTest)) ? '检查中…' : ['failed','uncertain'].includes(bridgeTestState(latestTest)) ? '检查未完成' : '尚未测试'; $('bridge-local-proof').className = localVerified ? 'proof-verified' : '';
  $('bridge-native-proof').textContent = nativeVerified ? '你已确认原对话回报' : bridgeEntries.some(bridgeReported) ? 'Bot 已报告 · 等待你核对' : '尚未验证'; $('bridge-native-proof').className = nativeVerified ? 'proof-verified' : '';
  const selectedTarget = $('bridge-test-target').value, targets = state?.chat?.members?.filter(item => ['codex','native'].includes(item.adapter) && (history?.participants || []).some(participant => participant.id === item.id)) || [];
  $('bridge-test-target').innerHTML = targets.length ? targets.map(target => `<option value="${escape(target.id)}">${escape(target.name)}</option>`).join('') : '<option value="">先给聊天室添加 Codex 成员</option>';
  if (targets.some(target => target.id === selectedTarget)) $('bridge-test-target').value = selectedTarget;
  const waiting = bridgeTesting || ['waiting','running','queued'].includes(bridgeTestState(bridgeTest)); $('bridge-run-test').disabled = waiting || !targets.length; $('bridge-run-test').textContent = waiting ? '检查中…' : '检查本机通路';
  $('bridge-test-result').classList.toggle('hidden', !latestTest);
  $('bridge-test-result').textContent = latestTest ? `${latestTest.summary || (waiting ? '正在独立测试房间验证本机通路…' : '测试状态已保存。')}${latestTest.error ? `\n${latestTest.error}` : ''}\n这是本机通路检查，Grok 原对话回报仍需实际验证。` : '';
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
$('bridge-dialog').addEventListener('close',() => { clearUITimeout(bridgeTimer); $('bridge-webhook-key').value = ''; });
function connectEvents({refreshOnOpen=true}={}) { if (desktop?.offline||!viewTimers.active) return; events?.close(); const stream=events=new EventSource('/api/events'); stream.addEventListener('update',scheduleRefresh); stream.onopen = () => {if(viewTimers.active&&events===stream&&refreshOnOpen)scheduleRefresh();}; stream.onerror = () => {if(!viewTimers.active||events!==stream)return;setWebConnected(false);checkDesktopTransport(); $('footer-status').textContent = '处理程序未连接 · 已有成员入口可恢复房间'; setUITimeout(() => action(refresh),1500); }; }
if (!desktop?.offline) connectEvents();
setUIInterval(() => { if (!document.hidden && (webConnected || desktop?.offline)) action(refresh); },15000);
function handleViewActivity(active){
  document.body.classList.toggle('view-paused',!active);officeScene?.setSuspended?.(!active);
  if(!active){events?.close();events=null;refreshAgain=false;launchAgain=false;return;}
  updatePhase();tickOnboardingElapsed();connectEvents({refreshOnOpen:false});
  action(async()=>{await refresh();if(grokSetupWatch)await pollGrokSetup();});
}
if (desktop) action(async () => {
  const initial=await checkDesktopTransport({initial:true});if(!initial)return;
  const selected=desktopState?.snapshot?.chat?.rooms?.find(room=>room.id===desktopState.selected_room_id);
  if (selected) {roomId=selected.id;projectId=selected.project_id;}
  renderService(); await refresh();
});
else action(refresh);
