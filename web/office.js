/* Agent Office: a visual view of the same room. It never dispatches work. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentOfficeScene = Object.freeze({mount: api.mount,avatarSource:api.avatarSource,characterSource:api.characterSource,clockState:api.clockState,normalizeScene:api.normalizeScene});
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const ASSETS = '/assets/office/';
  const COLORS = {deepseek:'#4d6bfe',kimi:'#3b3f7a',codex:'#547b69',claude:'#c87958',qwen:'#8a76b7',grok:'#48545c',cursor:'#587994',doubao:'#5c9b96',gemini:'#6c86bc',opencode:'#6c727c',cline:'#637d94',roo:'#a98162',cherry:'#b97680',generic:'#8e815f'};
  // Original pixel characters; see web/pixel-art.js and scripts/generate-pixel-art.cjs.
  const PIXEL_CHARACTERS = new Set(['deepseek','doubao','claude','codex','grok','gemini','kimi','qwen','cursor']);
  const pixelKey = key => PIXEL_CHARACTERS.has(key) ? key : 'generic';
  // Several colleagues on the same model share one character; the 2nd, 3rd... get accessory
  // colour variants 1..4 (cycling) in the order they appear in the room.
  const VARIANTS = 4;
  function autoVariants(members, appearances) {
    const seen = new Map(), result = new Map();
    for (const member of members || []) {
      if (!member || !member.id) continue;
      const own = appearances && typeof appearances === 'object' ? appearances[member.id] : null, look = own && typeof own === 'object' ? own : member.appearance || {};
      const key = look.preset === 'robot' ? 'generic' : pixelKey(provider(member)), count = seen.get(key) || 0;
      seen.set(key, count + 1); result.set(member.id, count ? (count - 1) % VARIANTS + 1 : 0);
    }
    return result;
  }
  const LABELS = {online:'在线',worker_online:'后台在线',stale:'心跳已过期',offline:'离线',unknown:'在线性未知'};
  const PRESETS = new Set(['auto','person','robot','sprite']);
  const MAX_IMAGE_LENGTH = 450000;
  const CAMERA_LIMITS = Object.freeze({natural:1,max:1});
  const SCENE_DEFAULTS = Object.freeze({version:1,time_zone:'auto',time_mode:'auto',columns:3,auto_layout:true,spacing:1,wall_color:'#f8f7f3',floor_color:'#faf7ef',show_window:true,show_clock:true,show_plant:true,motion:true});
  function normalizeScene(value={}) {
    const result={...SCENE_DEFAULTS};
    if(!value||typeof value!=='object')return result;
    const number=(key,min,max)=>{if(Number.isFinite(value[key]))result[key]=Math.max(min,Math.min(max,value[key]));};
    number('columns',1,3);result.columns=Math.round(result.columns);number('spacing',.8,1.3);
    for(const key of ['wall_color','floor_color'])if(/^#[a-f0-9]{6}$/i.test(value[key]||''))result[key]=value[key];
    for(const key of ['show_window','show_clock','show_plant','motion','auto_layout'])if(typeof value[key]==='boolean')result[key]=value[key];
    if(['auto','day','night'].includes(value.time_mode))result.time_mode=value.time_mode;
    if(value.time_zone==='auto')result.time_zone='auto';
    else if(typeof value.time_zone==='string'&&value.time_zone.length<100){try{new Intl.DateTimeFormat('en',{timeZone:value.time_zone});result.time_zone=value.time_zone;}catch{}}
    for(const key of ['background_data','desk_data','beanbag_data','plant_data','door_data']){const src=safeImage(value[key]);if(src)result[key]=src;}
    return result;
  }
  // Fixed clock bands express the user's local time, not geographical sunrise.
  function clockState(timeZone='auto',timeMode='auto',now=Date.now()) {
    let zone=timeZone==='auto'?Intl.DateTimeFormat().resolvedOptions().timeZone:timeZone;
    try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}
    const stamp=new Date(now);if(!Number.isFinite(stamp.getTime()))throw new TypeError('办公室时间无效。');
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(stamp);
    const p=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
    const hour=Number(p.hour)%24,minute=Number(p.minute),second=Number(p.second),decimal=hour+minute/60+second/3600;
    let phase='night',daylight=0;
    if(decimal>=5.5&&decimal<8){phase='dawn';daylight=(decimal-5.5)/2.5;}
    else if(decimal>=8&&decimal<17){phase='day';daylight=1;}
    else if(decimal>=17&&decimal<19.5){phase='dusk';daylight=1-(decimal-17)/2.5;}
    if(timeMode==='day'){phase='day';daylight=1;}else if(timeMode==='night'){phase='night';daylight=0;}
    return {timeZone:zone,hour,minute,second,phase,daylight,time:`${p.hour}:${p.minute}`,date:`${p.year}-${p.month}-${p.day}`,hourAngle:(hour%12)*30+minute*.5,minuteAngle:minute*6+second*.1,secondAngle:second*6};
  }
  // Geometry is shared by the layout and walking path, never by a backend.
  // Every row has a walkway above its desks; the left aisle stays clear.
  const SKY = Object.freeze({dawn:'#f2a983',day:'#9fd3f5',dusk:'#e07a5f',night:'#1e2752'});
  // Bubbles are one glance long: drop Markdown markup so `**bold**` or fences never show raw.
  function plainText(text){return String(text||'').replace(/```[a-z0-9_-]*\n?/gi,' ').replace(/`([^`]*)`/g,'$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm,'').replace(/(\*\*|__|~~)(.+?)\1/g,'$2').replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g,'$1$2').replace(/\s+/g,' ').trim();}
  const GEOMETRY = Object.freeze({minimumWidth:334,maximumColumns:3,left:126,right:24,top:156,columnPitch:200,rowPitch:300,seatWidth:184,seatHeight:208,personX:92,personY:85,personHalfWidth:35,personHalfHeight:47,aisleX:64,doorX:64,doorY:116,walkwayY:4,minimumHeight:560});
  function allocateSlots(previous, memberIds) {
    const ids=[...new Set(memberIds || [])], next=new Map(), used=new Set();
    for(const id of ids) {
      const slot=previous?.get(id);
      if(Number.isSafeInteger(slot)&&slot>=0&&!used.has(slot)){next.set(id,slot);used.add(slot);}
    }
    let free=0;
    for(const id of ids)if(!next.has(id)){while(used.has(free))free++;next.set(id,free);used.add(free);}
    return next;
  }
  function layoutOffice(width, slotCount=0, settings={}, columnOverride=null) {
    const g=GEOMETRY;
    const config=normalizeScene(settings),rowPitch=g.rowPitch+(config.spacing-1)*60;
    width=Math.max(g.minimumWidth,Number.isFinite(width)?Math.floor(width):g.minimumWidth);
    slotCount=Math.max(0,Number.isSafeInteger(slotCount)?slotCount:0);
    const preferred=Number.isSafeInteger(columnOverride)?Math.max(1,Math.min(10,columnOverride)):config.columns;
    const columns=Math.min(preferred,columnOverride===null?g.maximumColumns:10,Math.max(1,Math.floor((width-g.left-g.right)/g.columnPitch)));
    const pitch=(width-g.left-g.right)/columns;
    const rows=Math.ceil(slotCount/columns);
    const height=Math.max(g.minimumHeight,g.top+rows*rowPitch+48);
    return {width,height,columns,rows,pitch,rowPitch,position(slot){
      const column=slot%columns,row=Math.floor(slot/columns);
      return {slot,column,row,x:g.left+column*pitch+(pitch-g.seatWidth)/2,y:g.top+row*rowPitch,width:g.seatWidth,height:g.seatHeight};
    }};
  }
  // The office has its own coordinates. A narrow window changes the camera,
  // not the desks or the entrance route. Bounds represent the transformed
  // room, avoiding the scroll overflow of a large, CSS-scaled layout box.
  function cameraLayout(viewportWidth, viewportHeight, slotCount=0, settings={}) {
    const finite=(value,fallback)=>Number.isFinite(value)&&value>0?value:fallback;
    const width=finite(viewportWidth,GEOMETRY.minimumWidth),height=finite(viewportHeight,GEOMETRY.minimumHeight);
    const config=normalizeScene(settings);
    const marginX=Math.min(12,width*.015),marginTop=Math.min(64,height*.18),marginBottom=Math.min(16,height*.05);
    const availableWidth=Math.max(1,width-marginX*2),availableHeight=Math.max(1,height-marginTop-marginBottom);
    // The room is a rectangular surface that fills its pane. Furniture keeps
    // its natural proportions; additional rows continue below the viewport.
    const scale=Math.min(CAMERA_LIMITS.natural,availableWidth/GEOMETRY.minimumWidth);
    const worldWidth=availableWidth/scale;
    const capacity=Math.max(1,Math.min(10,Math.floor((worldWidth-GEOMETRY.left-GEOMETRY.right)/246)));
    const aspect=availableWidth/availableHeight;
    const balanced=Math.max(1,Math.ceil(Math.sqrt(Math.max(1,slotCount)*aspect*GEOMETRY.rowPitch/246)));
    const columns=config.auto_layout?Math.min(capacity,balanced):Math.min(capacity,config.columns);
    const contentWidth=Math.min(worldWidth,GEOMETRY.left+columns*246+GEOMETRY.right);
    const content=layoutOffice(contentWidth,slotCount,config,columns);
    const offset=Math.max(0,(worldWidth-content.width)/2);
    const world={...content,width:worldWidth,height:Math.max(content.height,availableHeight/scale),position(slot){const value=content.position(slot);return {...value,x:value.x+offset};}};
    const scaledWidth=world.width*scale,scaledHeight=world.height*scale;
    const boundsWidth=Math.max(width,scaledWidth+marginX*2),boundsHeight=Math.max(height,scaledHeight+marginTop+marginBottom);
    return {world,auto:true,scale,fit:scale,width,height,scaledWidth,scaledHeight,boundsWidth,boundsHeight,
      x:marginX,y:marginTop};
  }
  function routeToSeat(position) {
    const g=GEOMETRY, target={x:position.x+g.personX,y:position.y+g.personY};
    const points=[{x:g.doorX,y:g.doorY},{x:g.aisleX,y:position.y+g.walkwayY},{x:target.x,y:position.y+g.walkwayY},target];
    let distance=0;
    const lengths=points.map((point,index)=>index?Math.hypot(point.x-points[index-1].x,point.y-points[index-1].y):0);
    for(const length of lengths)distance+=length;
    let travelled=0;
    return {points,target,distance,duration:Math.max(1000,Math.min(3200,distance*3)),keyframes:points.map((point,index)=>{
      travelled+=lengths[index];
      return {transform:`translate(${point.x-target.x}px, ${point.y-target.y}px)`,offset:distance?travelled/distance:1};
    })};
  }
  function joiningMembers(previous, next) {
    if(!previous.initialized||previous.roomId!==next.roomId||!previous.online||!next.online)return [];
    const old=new Set(previous.memberIds || []);
    return (next.memberIds || []).filter(id=>!old.has(id));
  }
  function provider(member = {}) {
    const adapter = String(member.adapter || member.provider || '').toLowerCase();
    if (adapter.startsWith('deepseek')) return 'deepseek';
    if (adapter.startsWith('kimi') || adapter.startsWith('moonshot')) return 'kimi';
    if (adapter.startsWith('claude')) return 'claude';
    if (adapter.startsWith('qwen')) return 'qwen';
    if (adapter.startsWith('codex')) return 'codex';
    if (adapter.startsWith('cursor')) return 'cursor';
    if (adapter.startsWith('doubao')) return 'doubao';
    if (adapter.startsWith('gemini')) return 'gemini';
    if (adapter.startsWith('opencode')) return 'opencode';
    if (adapter.startsWith('cline')) return 'cline';
    if (adapter === 'roo-code' || adapter === 'roo') return 'roo';
    if (adapter.startsWith('cherry')) return 'cherry';
    // A native group proxy represents its named backend, not a second Grok.
    const name = String(member.name || '').toLowerCase();
    for (const key of ['codex','claude','qwen','cursor','grok','gemini','opencode','cline']) if (name.includes(key)) return key;
    if (name.includes('roo code') || name.includes('roo-code')) return 'roo';
    if (name.includes('cherry studio') || name.includes('cherry-studio')) return 'cherry';
    if (name.includes('豆包') || name.includes('doubao')) return 'doubao';
    if (name.includes('deepseek') || name.includes('深度求索')) return 'deepseek';
    if (name.includes('kimi') || name.includes('月之暗面')) return 'kimi';
    if (name.includes('千问') || name.includes('通义')) return 'qwen';
    return adapter.startsWith('grok') ? 'grok' : 'generic';
  }
  function safeImage(value) {
    if (typeof value !== 'string' || value.length > MAX_IMAGE_LENGTH) return '';
    if (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return value;
    // Public packaged art only. Never load arbitrary external or file URLs.
    if (/^\/assets\/office\/[a-z0-9_-]+\.(?:svg|png|jpe?g|webp)$/i.test(value)) return value;
    return '';
  }
  function appearance(member, appearances, autoVariant = 0) {
    const own = appearances && typeof appearances === 'object' ? appearances[member.id] : null;
    const value = own && typeof own === 'object' ? own : member.appearance || {};
    const key = provider(member), variant = Number.isInteger(value.accent) && value.accent >= 0 && value.accent <= VARIANTS ? value.accent : autoVariant;
    return {
      preset: PRESETS.has(value.preset) ? value.preset : 'auto',
      color: /^#[a-f0-9]{6}$/i.test(value.color || '') ? value.color : COLORS[key],
      avatar: safeImage(value.avatar_data || value.avatar_url) || `${ASSETS}pixel-avatar-${pixelKey(key)}${variant ? `-v${variant}` : ''}.png`,
      variant,
      character: safeImage(value.character_data || value.character_url),
      furniture: value.furniture==='beanbag'?'beanbag':'desk',
      scale: Number.isFinite(value.scale)?Math.max(.65,Math.min(1.35,value.scale)):1,
      customized: !!(safeImage(value.avatar_data || value.avatar_url) || safeImage(value.character_data || value.character_url) || PRESETS.has(value.preset) && value.preset !== 'auto' || value.color && value.color !== COLORS[key] || value.furniture==='beanbag' || value.scale&&value.scale!==1),
      provider: key
    };
  }
  function participantPresence(member, runtime, online, now) {
    const observed = {...(runtime?.members || runtime?.presence || []).find(item => (item.id || item.member_id) === member.id), ...member.runtime_state};
    const original = member.presence || observed.presence || 'unknown';
    let status = typeof original === 'string' ? original : original.state || original.status || 'unknown';
    const expires = original?.lease_expires || observed.lease_expires;
    if (status === 'online' && expires && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= now) status = 'stale';
    const worker = observed.worker_online === true && (!observed.worker_lease_expires || Date.parse(observed.worker_lease_expires) > now);
    if (worker && status !== 'online') status = 'worker_online';
    if (!(status in LABELS)) status = 'unknown';
    if (!online && ['online','worker_online'].includes(status)) status = 'stale';
    return {status,label: online ? LABELS[status] : '服务已关闭',worker: online && worker,lastSeen:member.last_seen || observed.last_seen || null};
  }
  function roomMessages(input, roomId) {
    const messages = Array.isArray(input.messages) ? input.messages : [];
    return messages.filter(message => message && typeof message === 'object' && message.id && (!message.room_id || message.room_id === roomId));
  }
  function describe(input = {}, now = Date.now()) {
    const roomId = input.roomId || input.room?.id || '';
    const online = input.online === undefined ? input.runtime?.service?.online !== false : input.online === true;
    const raw = Array.isArray(input.participants) ? input.participants : Array.isArray(input.members) ? input.members : [];
    const ids = new Set();
    const members = raw.filter(member => member && member.id && !ids.has(member.id) && ids.add(member.id));
    const messages = roomMessages(input, roomId);
    const spoken = messages.filter(message => !['system','event'].includes(message.kind) && !['user','system'].includes(message.sender_id) && members.some(member => member.id === message.sender_id) && typeof message.text === 'string' && message.text.trim());
    const latest = new Map();
    for (const message of spoken) latest.set(message.sender_id, message);
    const answered = new Map();
    for (const message of messages) if (message.reply_to && ['reply','acknowledgment'].includes(message.kind)) { const senders = answered.get(message.reply_to) || new Set(); senders.add(message.sender_id); answered.set(message.reply_to,senders); }
    const visible = new Set(spoken.slice().reverse().filter((message,index,list) => list.findIndex(item => item.sender_id === message.sender_id) === index).slice(0,3).map(message => message.sender_id));
    const secretaryId=typeof input.secretary?.member_id==='string'?input.secretary.member_id:null, variants=autoVariants(members,input.appearances || input.appearance);
    return {
      roomId,online,messages,
      members: members.map(member => {
        const presence = participantPresence(member,input.runtime,online,now);
        const requests = messages.filter(message => message.to_member_id === member.id && !answered.get(message.id)?.has(member.id));
        const processing = presence.worker && requests.some(message => ['processing','running'].includes(message.status));
        const waiting = requests.some(message => ['queued','delivered','pending','consumed'].includes(message.status));
        const needsInput = requests.some(message => ['waiting_input','uncertain'].includes(message.status));
        const message = latest.get(member.id) || null;
        const created = message && Date.parse(message.created || message.created_at || '');
        const occupied=online&&['online','worker_online'].includes(presence.status);
        return {member,presence,occupied,appearance:appearance(member,input.appearances || input.appearance,variants.get(member.id)||0),secretary:member.id===secretaryId,processing,waiting,needsInput,message,showMessage:occupied&&visible.has(member.id),recent:occupied && Number.isFinite(created) && created <= now && now-created <= 15000};
      }),
      lastMessage: messages.slice().reverse().find(message => !['system','event'].includes(message.kind) && message.sender_id !== 'system' && typeof message.text === 'string' && message.text.trim()) || null
    };
  }
  function node(document, tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  }
  function image(document, className, src, alt = '') {
    const value = node(document,'img',className);
    if(src)value.src = src; value.alt = alt; value.draggable = false;
    return value;
  }
  function setArt(img, src) {
    if(img.dataset.requested===src)return;
    img.dataset.requested=src;img.classList.remove('ao-art-loaded');img.hidden=!src;
    if(src)img.src=src;else img.removeAttribute('src');
  }
  function watchArt(img, onLoaded) {
    img.addEventListener('load',()=>{img.hidden=false;img.classList.add('ao-art-loaded');onLoaded?.(true);});
    img.addEventListener('error',()=>{img.hidden=true;img.classList.remove('ao-art-loaded');onLoaded?.(false);});
  }
  function body(document) {
    const value = node(document,'span','ao-character');
    for (const part of ['shadow','leg-left','leg-right','arm-left','arm-right','torso','detail','antenna']) value.append(node(document,'span',`ao-body-${part}`));
    return value;
  }
  function mount(container, options = {}) {
    if (!container || typeof container.append !== 'function') throw new TypeError('办公室画面需要一个 DOM 容器。');
    const document = container.ownerDocument;
    const view = document.defaultView || window;
    const scene = node(document,'section','ao-scene');
    scene.setAttribute('aria-label','Agent 办公室画面');
    const top = node(document,'div','ao-toolbar');
    const heading = node(document,'div','ao-heading');
    heading.append(node(document,'span','ao-heading-mark','⌘'),node(document,'strong','','共同的办公室'));
    const count = node(document,'span','ao-count');
    heading.append(count);
    const health = node(document,'span','ao-health'); health.setAttribute('role','status');
    const toolbarRight=node(document,'div','ao-toolbar-right');
    const secretaryButton=node(document,'button','ao-secretary-button','秘书');secretaryButton.type='button';secretaryButton.hidden=typeof options.onChooseSecretary!=='function';secretaryButton.title='选择或管理 AI 秘书';secretaryButton.addEventListener('click',()=>options.onChooseSecretary?.());
    const settings=node(document,'button','ao-scene-settings','布置办公室');settings.type='button';settings.hidden=typeof options.onSceneSettings!=='function';settings.addEventListener('click',()=>options.onSceneSettings?.());
    const compose=node(document,'button','ao-compose-button','发消息');compose.type='button';compose.hidden=typeof options.onCompose!=='function';compose.addEventListener('click',()=>options.onCompose?.());
    toolbarRight.append(health,secretaryButton,settings,compose);top.append(heading,toolbarRight);
    const scroll = node(document,'div','ao-scroll');
    scroll.tabIndex=0;scroll.setAttribute('aria-label','自动适配的办公室画面，滚动查看更多工位');
    const worldBounds=node(document,'div','ao-world-bounds'),camera=node(document,'div','ao-camera');
    const floor = node(document,'div','ao-floor');
    const wall = node(document,'div','ao-wall'); wall.setAttribute('aria-hidden','true');
    const backdrop=image(document,'ao-background','');watchArt(backdrop);backdrop.setAttribute('aria-hidden','true');
    const outdoor=node(document,'div','ao-window');outdoor.setAttribute('aria-hidden','true');
    const sky=node(document,'div','ao-sky');sky.append(node(document,'span','ao-cloud ao-cloud-one'),node(document,'span','ao-cloud ao-cloud-two'),node(document,'span','ao-moon'),node(document,'span','ao-stars'));
    outdoor.append(sky,node(document,'span','ao-window-divider'),node(document,'span','ao-window-sill'));
    const light=node(document,'div','ao-light');light.setAttribute('aria-hidden','true');
    const clock=node(document,'div','ao-clock');
    const dial=node(document,'span','ao-clock-dial');dial.setAttribute('aria-hidden','true');
    const hourHand=node(document,'i','ao-hour-hand'),minuteHand=node(document,'i','ao-minute-hand');dial.append(hourHand,minuteHand,node(document,'i','ao-clock-pin'));
    const clockMeta=node(document,'span','ao-clock-meta'),clockTime=node(document,'time','ao-clock-time'),clockDate=node(document,'span','ao-clock-date'),clockZone=node(document,'span','ao-clock-zone');clockMeta.append(clockTime,clockDate,clockZone);clock.append(dial,clockMeta);
    const door=node(document,'div','ao-door');door.setAttribute('aria-hidden','true');
    const doorRecess=node(document,'span','ao-door-recess'),doorFrame=node(document,'span','ao-door-frame');
    const doorPanel=node(document,'span','ao-door-panel');doorPanel.append(node(document,'span','ao-door-inset'),node(document,'span','ao-door-knob'));door.append(doorRecess,doorPanel,doorFrame);
    const doorArt=image(document,'ao-door-art','');watchArt(doorArt);door.append(doorArt);
    const doorLabel=node(document,'span','ao-door-label','入口');doorLabel.setAttribute('aria-hidden','true');
    const entry = node(document,'div','ao-entry-sign','AGENT OFFICE'); entry.setAttribute('aria-hidden','true');
    const seats = node(document,'div','ao-seats');
    const plantHolder=node(document,'div','ao-plant ao-plant-right');
    const plantFallback=node(document,'span','ao-plant-fallback');plantFallback.append(node(document,'i'),node(document,'i'),node(document,'i'),node(document,'b'));
    const plantRight = image(document,'ao-plant-art',`${ASSETS}prop-plant.png`);watchArt(plantRight);plantHolder.append(plantFallback,plantRight);
    const empty = node(document,'div','ao-empty');
    const emptyChoose=node(document,'button','ao-empty-choose','选择 AI 秘书');emptyChoose.type='button';emptyChoose.hidden=typeof options.onChooseSecretary!=='function';emptyChoose.addEventListener('click',()=>options.onChooseSecretary?.());empty.append(emptyChoose);
    floor.append(backdrop,wall,outdoor,light,door,doorLabel,entry,clock,seats,plantHolder,empty);camera.append(floor);worldBounds.append(camera);scroll.append(worldBounds);
    scene.append(scroll,top);container.append(scene);
    const items = new Map();
    let current = {roomId:'',members:[],online:false,lastMessage:null}, destroyed=false, initialized=false, timer=null, clockTimer=null, intersecting=true, slots=new Map(), layout=null, config=normalizeScene(),cameraState=null;
    const selected = new Set();
    const reducedMotion=typeof view.matchMedia==='function'?view.matchMedia('(prefers-reduced-motion: reduce)'):null;
    function paused() {
      let hidden = document.hidden || !intersecting || !current.online;
      for (let element=container; !hidden && element; element=element.parentElement) hidden = element.hidden || element.classList?.contains('hidden') || element.getAttribute?.('aria-hidden') === 'true';
      scene.classList.toggle('ao-paused',!!hidden);
      scene.classList.toggle('ao-still',!config.motion||!!reducedMotion?.matches);
      return hidden;
    }
    function updateClock() {
      if(destroyed)return;
      const state=clockState(config.time_zone,config.time_mode);
      scene.dataset.phase=state.phase;scene.style.setProperty('--ao-daylight',state.daylight.toFixed(4));
      scene.style.setProperty('--ao-night',(1-state.daylight).toFixed(4));
      scene.style.setProperty('--ao-sky-color',SKY[state.phase]||SKY.day);
      hourHand.style.transform=`rotate(${state.hourAngle}deg)`;minuteHand.style.transform=`rotate(${state.minuteAngle}deg)`;
      clockTime.textContent=state.time;clockTime.dateTime=`${state.date}T${state.time}`;clockDate.textContent=state.date.replaceAll('-','.');clockZone.textContent=state.timeZone.replaceAll('_',' ');
      clock.title=`${state.date} ${state.time} · ${state.timeZone} · 昼夜按当地时间切换`;
      clock.setAttribute('aria-label',clock.title);
      // The clock remains accurate with the room service off. Environmental
      // animation stays paused, and hidden views need no interval work.
      if(clockTimer===null&&!document.hidden&&intersecting)clockTimer=view.setTimeout(()=>{clockTimer=null;updateClock();},15000);
    }
    function updateWorld() {
      scene.style.setProperty('--ao-wall-color',config.wall_color);scene.style.setProperty('--ao-floor-color',config.floor_color);
      outdoor.hidden=!config.show_window;clock.hidden=!config.show_clock;plantHolder.hidden=!config.show_plant;
      setArt(backdrop,config.background_data||'');setArt(doorArt,config.door_data||'');setArt(plantRight,config.plant_data||`${ASSETS}prop-plant.png`);
      updateClock();paused();
    }
    function refreshTimers() {
      if (timer !== null) view.clearTimeout(timer);
      timer=null;
      const hasTransient = [...items.values()].some(item => item.recent);
      if (!destroyed && hasTransient && !paused()) timer=view.setTimeout(() => {
        const now=Date.now();
        for (const item of items.values()) {
          if(item.recent && now-item.recent>15000) {item.root.classList.remove('ao-speaking');item.recent=0;}
        }
        refreshTimers();
      },700);
    }
    function callback(name, value) {
      if (typeof options[name] === 'function') options[name](value);
      else if (name === 'onSelectMember' && typeof options.onMemberClick === 'function') options.onMemberClick(value.id);
    }
    function createSeat(info) {
      const root=node(document,'div','ao-seat');root.dataset.memberId=info.member.id;
      const bubble=node(document,'button','ao-bubble');bubble.type='button';
      const bubbleLabel=node(document,'span','ao-bubble-label');
      const bubbleText=node(document,'span','ao-bubble-text');bubble.append(bubbleLabel,bubbleText);
      const furniture=node(document,'div','ao-furniture');
      const furnitureFallback=node(document,'span','ao-furniture-fallback');
      for(const part of ['chair','surface','leg-left','leg-right','monitor','keyboard','laptop'])furnitureFallback.append(node(document,'i',`ao-furniture-${part}`));
      const desk=image(document,'ao-desk','');watchArt(desk);furniture.append(furnitureFallback,desk);
      const character=node(document,'button','ao-person');character.type='button';
      const figure=node(document,'span','ao-figure');
      const shape=body(document),custom=image(document,'ao-custom-character','');custom.hidden=true;figure.append(shape,custom);
      const head=node(document,'span','ao-head');const avatar=image(document,'ao-avatar','');head.append(avatar);
      const aura=node(document,'span','ao-aura');
      const activity=node(document,'span','ao-work-indicator');activity.append(node(document,'i'),node(document,'i'),node(document,'i'));activity.setAttribute('aria-hidden','true');
      character.append(aura,figure,head,activity);
      const label=node(document,'button','ao-name');label.type='button';
      const name=node(document,'strong'),secretaryBadge=node(document,'span','ao-secretary-badge','秘书'),nameLine=node(document,'span','ao-name-line');secretaryBadge.hidden=true;nameLine.append(name,secretaryBadge);const status=node(document,'span','ao-seat-status');status.append(node(document,'i','ao-status-dot'),node(document,'span','ao-status-text'));label.append(nameLine,status);
      const customize=node(document,'button','ao-customize','✎');customize.type='button';customize.dataset.memberId=info.member.id;
      customize.hidden=typeof options.onCustomize!=='function';
      root.append(bubble,furniture,character,label,customize);
      const item={root,bubble,bubbleLabel,bubbleText,desk,furniture,character,figure,shape,custom,head,avatar,name,secretaryBadge,status:status.lastChild,label,customize,info:null,recent:0,messageId:null,entering:false,motion:null,motionToken:0,position:null,avatarSource:null};
      watchArt(custom,loaded=>{item.root.classList.toggle('ao-character-ready',loaded);});
      avatar.addEventListener('error',()=>{
        const key=item.info?.appearance.provider, fallback=`${ASSETS}pixel-avatar-generic.png`;
        if(avatar.getAttribute('src')!==fallback)avatar.src=fallback;
      });
      function choose() {selected.clear();selected.add(info.member.id);for(const entry of items.values())entry.root.classList.toggle('ao-selected',selected.has(entry.info.member.id));callback('onSelectMember',item.info.member);}
      character.addEventListener('click',choose);label.addEventListener('click',choose);
      bubble.addEventListener('click',() => {if(item.info.message)callback('onSelectMessage',item.info.message);});
      customize.addEventListener('click',() => callback('onCustomize',item.info.member));
      return item;
    }
    function updateSeat(item, info, allowSpeech=true) {
      const previousMessage=item.messageId;
      item.info=info;const {member,appearance,presence,message}=info;
      item.root.style.setProperty('--ao-accent',appearance.color);
      item.root.dataset.preset=appearance.preset;
      item.root.dataset.furniture=appearance.furniture;
      item.figure.style.setProperty('--ao-character-scale',String(appearance.scale));
      // The badge sits beyond the complete image box, including uploaded
      // opaque artwork and the largest allowed character scale.
      item.root.style.setProperty('--ao-badge-right',`${(8-(appearance.character?44:55)*appearance.scale).toFixed(2)}px`);
      item.root.dataset.presence=presence.status;
      if(!info.occupied&&item.entering)settleEntrance(item,false);
      item.root.classList.toggle('ao-vacant',!info.occupied);item.root.dataset.occupied=String(info.occupied);
      item.character.hidden=!info.occupied;
      item.root.classList.toggle('ao-working',info.occupied&&!item.entering&&info.processing&&!info.needsInput);item.root.classList.toggle('ao-waiting',info.occupied&&!item.entering&&!info.processing&&!info.needsInput&&info.waiting);
      item.root.classList.toggle('ao-offline',!current.online || ['offline','stale','unknown'].includes(presence.status));
      item.root.classList.toggle('ao-message-visible',!item.entering&&info.showMessage && !!message);
      item.root.classList.toggle('ao-selected',selected.has(member.id));
      item.name.textContent=member.name || 'Agent';
      item.secretaryBadge.hidden=!info.secretary;item.root.dataset.secretary=String(info.secretary);
      item.status.textContent=!info.occupied?`空位 · ${presence.label}${info.waiting&&current.online?' · 有待处理消息':''}`:info.processing?'处理中':info.needsInput?'等待确认':info.waiting&&current.online?'有待处理消息':presence.label;
      const title=`${member.name || 'Agent'} · ${item.status.textContent}${member.adapter?` · ${member.adapter}`:''}`;
      item.character.title=title;item.character.setAttribute('aria-label',`${title}，查看成员`);
      item.label.title=title;item.customize.title=`更换 ${member.name || 'Agent'} 的形象`;item.customize.setAttribute('aria-label',item.customize.title);
      item.root.classList.toggle('ao-custom-avatar',!appearance.avatar.startsWith(`${ASSETS}pixel-avatar-`));if(item.avatarSource!==appearance.avatar){item.avatarSource=appearance.avatar;item.avatar.src=appearance.avatar;}item.avatar.alt='';
      const bodySource=appearance.character||defaultCharacter(appearance);
      if(item.custom.dataset.requested!==bodySource)item.root.classList.remove('ao-character-ready');
      setArt(item.custom,bodySource);
      const furnitureSource=appearance.furniture==='beanbag'?(config.beanbag_data||`${ASSETS}furniture-beanbag.png`):(config.desk_data||`${ASSETS}pixel-desk.png`);
      item.furniture.classList.toggle('ao-custom-furniture',!!(appearance.furniture==='beanbag'?config.beanbag_data:config.desk_data));
      setArt(item.desk,furnitureSource);
      item.root.classList.toggle('ao-custom-body',!!appearance.character);
      item.bubble.hidden=!info.occupied||item.entering||!message;
      if(message) {
        item.bubble.dataset.messageId=message.id;
        item.bubbleLabel.textContent=!current.online?'历史发言':info.recent?'刚刚说':'最近发言';
        const brief=plainText(message.text);item.bubbleText.textContent=brief.slice(0,180);
        item.bubble.title=`${member.name || 'Agent'}：${message.text.slice(0,600)}`;
        item.bubble.setAttribute('aria-label',`查看 ${member.name || 'Agent'} 的原消息：${brief.slice(0,180)}`);
        if(initialized && !item.entering && allowSpeech && info.recent && previousMessage!==message.id){item.root.classList.add('ao-speaking');item.recent=Date.now();}
        if(!item.entering)item.messageId=message.id;
      } else {item.messageId=null;item.root.classList.remove('ao-speaking');item.recent=0;}
      // Entering a view or re-reading old history does not simulate new speech.
      if(!info.occupied || item.entering || !info.recent || !current.online){item.root.classList.remove('ao-speaking');item.recent=0;}
    }
    function updateDoor(){door.classList.toggle('ao-door-opening',[...items.values()].some(item=>item.entering));}
    function settleEntrance(item, allowSpeech=false) {
      item.motionToken++;
      const motion=item.motion;item.motion=null;item.entering=false;
      if(motion)motion.cancel();
      item.character.style.removeProperty('transform');item.root.classList.remove('ao-entering');
      if(item.info)updateSeat(item,item.info,allowSpeech);
      updateDoor();
    }
    function cancelEntrances(){for(const item of items.values())if(item.entering||item.motion)settleEntrance(item);}
    function applyLayout() {
      const width=scroll.clientWidth||container.clientWidth||GEOMETRY.minimumWidth;
      const height=scroll.clientHeight||container.clientHeight||GEOMETRY.minimumHeight;
      const slotCount=slots.size?Math.max(...slots.values())+1:0;
      const nextCamera=cameraLayout(width,height,slotCount,config),next=nextCamera.world;
      // Resizing changes the coordinate system, so complete active walks rather
      // than sending the same member through the door a second time.
      if(layout&&(layout.width!==next.width||layout.columns!==next.columns||layout.rowPitch!==next.rowPitch))cancelEntrances();
      layout=next;
      floor.style.width=`${next.width}px`;floor.style.height=`${next.height}px`;
      floor.style.transform=`scale(${nextCamera.scale})`;floor.dataset.scale=String(nextCamera.scale);
      camera.style.width=`${nextCamera.scaledWidth}px`;camera.style.height=`${nextCamera.scaledHeight}px`;
      camera.style.left=`${nextCamera.x}px`;camera.style.top=`${nextCamera.y}px`;
      worldBounds.style.width=`${nextCamera.boundsWidth}px`;worldBounds.style.height=`${nextCamera.boundsHeight}px`;
      scene.dataset.cameraMode='auto';scene.dataset.scale=String(nextCamera.scale);
      // Routine history and presence refreshes keep the user's row in view.
      scroll.scrollLeft=Math.min(scroll.scrollLeft,Math.max(0,nextCamera.boundsWidth-width));
      scroll.scrollTop=Math.min(scroll.scrollTop,Math.max(0,nextCamera.boundsHeight-height));
      cameraState=nextCamera;
      floor.style.setProperty('--ao-columns',String(next.columns));floor.dataset.columns=String(next.columns);
      for(const [id,item]of items){
        const position=next.position(slots.get(id));item.position=position;
        item.root.style.left=`${position.x}px`;item.root.style.top=`${position.y}px`;
        item.root.style.width=`${position.width}px`;item.root.style.height=`${position.height}px`;
        item.root.dataset.slot=String(position.slot);
      }
    }
    function enter(item, delay) {
      if(paused()||!config.motion||reducedMotion?.matches||typeof item.character.animate!=='function')return;
      const route=routeToSeat(item.position),token=++item.motionToken;
      item.entering=true;item.root.classList.add('ao-entering');updateSeat(item,item.info,false);updateDoor();
      const motion=item.character.animate(route.keyframes,{duration:route.duration,delay,fill:'both',easing:'linear'});
      item.motion=motion;
      motion.finished.then(()=>{
        if(!destroyed&&items.get(item.info.member.id)===item&&token===item.motionToken){settleEntrance(item,true);refreshTimers();}
      },()=>{});
    }
    function update(input = {}) {
      if(destroyed)return;
      const next=describe(input);
      const newIds=new Set(joiningMembers({roomId:current.roomId,online:current.online,initialized,memberIds:[...items.keys()]},{roomId:next.roomId,online:next.online,memberIds:next.members.map(info=>info.member.id)}));
      const changedRoom=initialized&&current.roomId!==next.roomId;
      if(changedRoom){cancelEntrances();for(const item of items.values())item.root.remove();items.clear();slots.clear();selected.clear();initialized=false;layout=null;cameraState=null;scroll.scrollTop=0;scroll.scrollLeft=0;}
      current=next;scene.dataset.roomId=next.roomId;scene.classList.toggle('ao-offline-room',!next.online);
      config=normalizeScene(input.scene);updateWorld();
      if(!next.online)cancelEntrances();
      count.textContent=`${next.members.length} 个工位`;
      health.textContent=next.online?'本机服务已连接':'离线历史 · 服务已关闭';
      health.classList.toggle('offline',!next.online);
      const roomName=input.room?.title||input.roomTitle;
      scene.setAttribute('aria-label',`${roomName?`${roomName} · `:''}Agent 办公室画面`);
      const memberIds=new Set(next.members.map(info=>info.member.id));
      for(const [id,item] of items){if(!memberIds.has(id)){settleEntrance(item);item.root.remove();items.delete(id);selected.delete(id);}}
      slots=allocateSlots(slots,[...memberIds]);
      for(const info of next.members) {
        let item=items.get(info.member.id);
        if(!item){item=createSeat(info);items.set(info.member.id,item);seats.append(item.root);}
        updateSeat(item,info,!newIds.has(info.member.id));
      }
      applyLayout();
      let enteringIndex=0;
      for(const id of newIds){const item=items.get(id);if(item?.info.occupied)enter(item,Math.min(enteringIndex++*100,600));}
      if(paused()||!config.motion||reducedMotion?.matches)cancelEntrances();
      updateDoor();
      empty.hidden=next.members.length>0||input.tutorialVisible===true;seats.hidden=next.members.length===0;
      initialized=true;paused();refreshTimers();
    }
    const onVisibility=()=>{if(paused()){cancelEntrances();}else if(!config.motion||reducedMotion?.matches)cancelEntrances();if(clockTimer!==null){view.clearTimeout(clockTimer);clockTimer=null;}updateClock();refreshTimers();};
    document.addEventListener('visibilitychange',onVisibility);
    if(reducedMotion?.addEventListener)reducedMotion.addEventListener('change',onVisibility);
    else reducedMotion?.addListener?.(onVisibility);
    let observer=null;
    if(typeof view.IntersectionObserver==='function'){observer=new view.IntersectionObserver(entries=>{intersecting=entries.some(entry=>entry.isIntersecting);onVisibility();});observer.observe(scene);}
    let mutation=null;
    if(typeof view.MutationObserver==='function'){mutation=new view.MutationObserver(onVisibility);for(let element=container;element&&element!==document.body;element=element.parentElement)mutation.observe(element,{attributes:true,attributeFilter:['class','hidden','aria-hidden']});}
    let resize=null;
    if(typeof view.ResizeObserver==='function'){resize=new view.ResizeObserver(()=>{if(!destroyed){applyLayout();onVisibility();}});resize.observe(scroll);}
    return Object.freeze({update,destroy(){if(destroyed)return;destroyed=true;cancelEntrances();if(timer!==null)view.clearTimeout(timer);if(clockTimer!==null)view.clearTimeout(clockTimer);document.removeEventListener('visibilitychange',onVisibility);if(reducedMotion?.removeEventListener)reducedMotion.removeEventListener('change',onVisibility);else reducedMotion?.removeListener?.(onVisibility);observer?.disconnect();mutation?.disconnect();resize?.disconnect();scene.remove();items.clear();slots.clear();}});
  }
  // `members` (optional) is the room roster, used to give same-model colleagues distinct accessories.
  function avatarSource(member = {}, appearances, members) {return appearance(member,appearances,members?autoVariants(members,appearances).get(member.id)||0:0).avatar;}
  function defaultCharacter(value){return `${ASSETS}pixel-${value.preset==='robot'?'generic':pixelKey(value.provider)}${value.variant?`-v${value.variant}`:''}.png`;}
  function characterSource(member={},appearances,members){const value=appearance(member,appearances,members?autoVariants(members,appearances).get(member.id)||0:0);return value.character||defaultCharacter(value);}
  return {mount,describe,provider,plainText,autoVariants,safeImage,avatarSource,characterSource,clockState,normalizeScene,SCENE_DEFAULTS,CAMERA_LIMITS,GEOMETRY,allocateSlots,layoutOffice,cameraLayout,routeToSeat,joiningMembers};
});
