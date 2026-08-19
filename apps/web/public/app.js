const $=(s)=>document.querySelector(s), $$=(s)=>[...document.querySelectorAll(s)];
const state={
  token:localStorage.getItem('agyToken')||'',
  ws:null,
  lastSeq:Number(localStorage.getItem('agySeq')||0),
  conversationId:null,
  conversationTitle:'',
  workspace:'',
  events:new Map(),
  terminalId:null,
  terminalText:'',
  selectedPageId:null
};

async function checkPairing(){
  if(window.location.hash.startsWith('#pair=')){
    const pairSecret=window.location.hash.slice(6).trim();
    if(pairSecret){
      try{
        const resp=await fetch('/api/v1/auth/pair',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({pairSecret,deviceLabel:navigator.userAgent})
        });
        const data=await resp.json();
        if(data.token){
          state.token=data.token;
          localStorage.setItem('agyToken',data.token);
          try{history.replaceState(null,'',window.location.pathname);}catch{}
          setTimeout(()=>toast('Paired successfully! Device session created.'),400);
          connectWs();
          loadStatus();
          loadConversations();
          return;
        }
      }catch(err){
        toast(`Pairing failed: ${err.message}`);
      }
    }
  }
  if(window.location.hash.startsWith('#token=')){
    const hashToken=window.location.hash.slice(7).trim();
    if(hashToken){
      state.token=hashToken;
      localStorage.setItem('agyToken',hashToken);
      try{history.replaceState(null,'',window.location.pathname);}catch{}
      setTimeout(()=>toast('Authenticated via bearer link'),400);
    }
  }
}
checkPairing();

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/sw.js').catch(err=>console.warn('[SW]',err));
}

async function notifyApproval(title,body){
  if(navigator.vibrate){
    try{navigator.vibrate([200,100,200]);}catch{}
  }
  if('serviceWorker' in navigator){
    try{
      const reg=await navigator.serviceWorker.ready;
      if(reg&&reg.showNotification){
        reg.showNotification(title,{
          body,
          icon:'/icon.svg',
          badge:'/icon.svg',
          vibrate:[200,100,200],
          tag:'agy-approval',
          renotify:true
        });
        return;
      }
    }catch{}
  }
  if('Notification' in window && Notification.permission==='granted'){
    try{new Notification(title,{body,icon:'/icon.svg'});}catch{}
  }
}

function toast(message){
  const el=$('#toast');
  el.textContent=message;
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),2200);
}
function escapeHtml(v=''){
  return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function token(){
  if(!state.token){
    state.token=prompt('Agy Remote bearer token')||'';
    if(state.token)localStorage.setItem('agyToken',state.token);
  }
  return state.token;
}
async function api(path,options={}){
  const headers={...(options.headers||{}),'Authorization':`Bearer ${token()}`};
  if(options.body&&typeof options.body!=='string'){
    headers['content-type']='application/json';
    options.body=JSON.stringify(options.body);
  }
  const r=await fetch(path,{...options,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data.message||`HTTP ${r.status}`);
  return data;
}

function connectWs(){
  if(state.ws&&state.ws.readyState<=1)return;
  const scheme=location.protocol==='https:'?'wss':'ws';
  state.ws=new WebSocket(`${scheme}://${location.host}/api/v1/events?token=${encodeURIComponent(token())}`);
  state.ws.onopen=()=>{
    state.ws.send(JSON.stringify({type:'resume',lastSeq:state.lastSeq}));
    if(state.conversationId)subscribe('conversation',state.conversationId);
    if(state.terminalId)subscribe('terminal',state.terminalId);
  };
  state.ws.onmessage=(e)=>{
    const m=JSON.parse(e.data);
    if(m.seq){
      state.lastSeq=m.seq;
      localStorage.setItem('agySeq',String(m.seq));
      handleEvent(m);
    }else if(m.type==='resync_required'&&state.conversationId){
      openConversation(state.conversationId);
    }
  };
  state.ws.onclose=()=>setTimeout(connectWs,1200);
  state.ws.onerror=()=>{};
}
function subscribe(channel,resourceId){
  if(state.ws?.readyState===1)state.ws.send(JSON.stringify({type:'subscribe',channel,resourceId}));
}
function unsubscribe(channel,resourceId){
  if(state.ws?.readyState===1)state.ws.send(JSON.stringify({type:'unsubscribe',channel,resourceId}));
}

function eventKey(e){
  return `${e.type}:${e.stepIndex??e.messageId??Math.random()}`;
}
function handleEvent(message){
  if(message.channel==='conversation'&&message.resourceId===state.conversationId){
    const e=message.event;
    if(e.type==='conversation.state'){
      const running=e.state?.status==='running';
      $('#stopBtn').disabled=!running;
      $('#statusText').textContent=running?'agent running':'connected';
      return;
    }
    state.events.set(eventKey(e),e);
    if(e.type==='approval.required'){
      const kind=e.interaction?.kind||'action';
      notifyApproval('Approval Required', `Antigravity requires your approval for: ${kind}`);
    }else if(e.type==='agent.question'){
      notifyApproval('Agent Question', 'Antigravity is waiting for your input.');
    }
    renderTimeline();
  }
  if(message.channel==='terminal'&&message.resourceId===state.terminalId){
    const e=message.event;
    if(e.output){
      state.terminalText+=e.output;
      const out=$('#terminalOutput');
      out.textContent=state.terminalText;
      out.scrollTop=out.scrollHeight;
    }
    if(e.exitCode!==undefined){
      state.terminalText+=`\n[process exited ${e.exitCode}]\n`;
      const out=$('#terminalOutput');
      out.textContent=state.terminalText;
      out.scrollTop=out.scrollHeight;
    }
  }
}

function renderTimeline(){
  const root=$('#timeline');
  const events=[...state.events.values()].sort((a,b)=>(a.stepIndex??0)-(b.stepIndex??0));
  if(!events.length){
    root.className='timeline empty';
    root.textContent='No visible events.';
    return;
  }
  root.className='timeline';
  root.innerHTML=events.map((e,idx)=>renderEvent(e,idx)).join('');
  bindEventActions(events);
  root.scrollTop=root.scrollHeight;
}

function renderEvent(e,index){
  const meta=`${e.type} · step ${e.stepIndex??'-'} · ${e.status||''}`;
  if(e.type==='user.message')return `<article class="event user"><div class="meta">${escapeHtml(meta)}</div><div>${escapeHtml(e.text)}</div></article>`;
  if(e.type==='assistant.message')return `<article class="event assistant"><div class="meta">${escapeHtml(meta)}${e.streaming?' · streaming':''}</div><pre>${escapeHtml(e.text)}</pre></article>`;
  if(e.type==='task.update')return `<article class="event task"><div class="meta">${escapeHtml(e.mode||'task')}</div><strong>${escapeHtml(e.name||'Task')}</strong><div>${escapeHtml(e.taskStatus||'')}</div><small>${escapeHtml(e.summary||'')}</small></article>`;
  if(e.type==='tool.command')return `<article class="event tool"><div class="meta">command · ${escapeHtml(e.status)}</div><pre>$ ${escapeHtml(e.command)}\n${escapeHtml(e.output||'')}</pre></article>`;
  if(e.type==='tool.file'||e.type==='tool.search'||e.type==='browser.action')return `<article class="event tool"><div class="meta">${escapeHtml(e.type)}</div><pre>${escapeHtml(JSON.stringify(e,null,2))}</pre></article>`;
  if(e.type==='subagent.update')return `<article class="event task"><div class="meta">subagent</div><strong>${escapeHtml(e.name||e.subagents?.[0]?.role||'Subagent')}</strong><div>${escapeHtml(e.prompt||'')}</div><small>${escapeHtml((e.results||[]).map(r=>r.conversationId).filter(Boolean).join(', '))}</small></article>`;
  
  if(e.type==='approval.required'){
    const kind=e.interaction?.kind||'generic';
    const inter=e.interaction||{};
    if(kind==='filePermission'){
      return `<article class="event approval">
        <div class="meta">file permission required · step ${e.stepIndex??'-'}</div>
        <div class="approval-card">
          <div><strong>File:</strong> <code>${escapeHtml(inter.path||'')}</code></div>
          ${inter.reason?`<div><small>Reason: ${escapeHtml(inter.reason)}</small></div>`:''}
          <div class="actions-wrap">
            <button class="primary-btn" data-act="file" data-idx="${index}" data-scope="PERMISSION_SCOPE_ONCE" data-allow="1">Allow Once</button>
            <button data-act="file" data-idx="${index}" data-scope="PERMISSION_SCOPE_CONVERSATION" data-allow="1">Allow Session</button>
            <button data-act="file" data-idx="${index}" data-scope="PERMISSION_SCOPE_WORKSPACE" data-allow="1">Allow Workspace</button>
            <button class="danger" data-act="file" data-idx="${index}" data-allow="0">Reject</button>
          </div>
        </div>
      </article>`;
    }
    if(kind==='runCommand'){
      const cmd=inter.proposedCommandLine||inter.command||'';
      return `<article class="event approval">
        <div class="meta">command execution approval · step ${e.stepIndex??'-'}</div>
        <div class="approval-card">
          <div><strong>Proposed Command:</strong></div>
          <pre>$ ${escapeHtml(cmd)}</pre>
          <div><label><small>Edit Command before running:</small></label><input id="cmd_input_${index}" value="${escapeHtml(cmd)}" /></div>
          <div class="actions-wrap">
            <button class="primary-btn" data-act="cmd" data-idx="${index}" data-allow="1">Run Command</button>
            <button class="danger" data-act="cmd" data-idx="${index}" data-allow="0">Reject</button>
          </div>
        </div>
      </article>`;
    }
    if(kind==='askQuestion'){
      const questions=inter.questions||[];
      return `<article class="event approval">
        <div class="meta">question from agent · step ${e.stepIndex??'-'}</div>
        <div class="approval-card" id="q_card_${index}">
          ${questions.map((q,qIdx)=>`
            <div class="question-item">
              <span class="question-label">${escapeHtml(q.question||q.prompt||`Question ${qIdx+1}`)}</span>
              ${(q.options||[]).length?`
                <div class="options-group">
                  ${q.options.map((opt,oIdx)=>`
                    <label class="option-label">
                      <input type="${q.isMultiSelect?'checkbox':'radio'}" name="q_opt_${index}_${qIdx}" value="${escapeHtml(opt)}" />
                      <span>${escapeHtml(opt)}</span>
                    </label>
                  `).join('')}
                </div>
              `:''}
              <input placeholder="Type answer or notes…" id="q_ans_${index}_${qIdx}" />
            </div>
          `).join('')}
          <div class="actions-wrap">
            <button class="primary-btn" data-act="q_submit" data-idx="${index}">Submit Answer</button>
            <button class="ghost" data-act="q_cancel" data-idx="${index}">Dismiss / Cancel</button>
          </div>
        </div>
      </article>`;
    }
    if(kind==='permission'){
      return `<article class="event approval">
        <div class="meta">permission required · step ${e.stepIndex??'-'}</div>
        <div class="approval-card">
          <div><strong>Resource:</strong> ${escapeHtml(inter.resource||'')}</div>
          ${inter.reason?`<div><small>${escapeHtml(inter.reason)}</small></div>`:''}
          <div class="actions-wrap">
            <button class="primary-btn" data-act="perm" data-idx="${index}" data-scope="PERMISSION_SCOPE_ONCE" data-allow="1">Allow Once</button>
            <button data-act="perm" data-idx="${index}" data-scope="PERMISSION_SCOPE_CONVERSATION" data-allow="1">Allow Session</button>
            <button class="danger" data-act="perm" data-idx="${index}" data-allow="0">Reject</button>
          </div>
        </div>
      </article>`;
    }
    return `<article class="event approval">
      <div class="meta">approval required · ${escapeHtml(kind)}</div>
      <pre>${escapeHtml(JSON.stringify(inter,null,2))}</pre>
      <div class="actions-wrap">
        <button class="primary-btn" data-act="generic" data-idx="${index}" data-allow="1">Allow</button>
        <button class="danger" data-act="generic" data-idx="${index}" data-allow="0">Reject</button>
      </div>
    </article>`;
  }

  if(e.type==='agent.notice'){
    const review=(e.reviewUris||[])[0];
    return `<article class="event approval">
      <div class="meta">agent notice · artifact review</div>
      <div>${escapeHtml(e.text)}</div>
      ${review?`
        <div class="approval-card" style="margin-top:8px;">
          <div><small>Artifact: <code>${escapeHtml(review)}</code></small></div>
          <input id="art_comment_${index}" placeholder="Optional feedback comment if rejecting…" />
          <div class="actions-wrap">
            <button class="primary-btn" data-act="art_appr" data-uri="${escapeHtml(review)}">Approve Artifact</button>
            <button class="danger" data-act="art_rej" data-idx="${index}" data-uri="${escapeHtml(review)}">Reject Artifact</button>
          </div>
        </div>
      `:''}
    </article>`;
  }

  if(e.type==='agent.question'){
    const questions=e.questions||[];
    return `<article class="event approval">
      <div class="meta">question</div>
      <div class="approval-card">
        ${questions.map((q,qIdx)=>`
          <div class="question-item">
            <span class="question-label">${escapeHtml(q.question||q.prompt||`Question ${qIdx+1}`)}</span>
            ${(q.options||[]).length?`
              <div class="options-group">
                ${q.options.map(opt=>`<div>• ${escapeHtml(opt)}</div>`).join('')}
              </div>
            `:''}
          </div>
        `).join('')}
      </div>
    </article>`;
  }

  if(e.type==='error')return `<article class="event error"><div class="meta">error</div>${escapeHtml(e.message)}</article>`;
  return `<article class="event tool"><div class="meta">${escapeHtml(e.type)}</div><pre>${escapeHtml(JSON.stringify(e,null,2))}</pre></article>`;
}

function bindEventActions(events){
  $$('[data-act]').forEach((btn)=>{
    const act=btn.dataset.act;
    const idx=Number(btn.dataset.idx);
    const e=events[idx];

    if(act==='file'){
      btn.onclick=async()=>{
        const allow=btn.dataset.allow==='1';
        const scope=btn.dataset.scope||'PERMISSION_SCOPE_ONCE';
        await sendInteraction(e,{
          kind:'filePermission',
          allow,
          scope,
          absolutePathUri:e.interaction?.path||''
        });
      };
    }else if(act==='cmd'){
      btn.onclick=async()=>{
        const allow=btn.dataset.allow==='1';
        const inputEl=$(`#cmd_input_${idx}`);
        const submittedCommandLine=inputEl?inputEl.value.trim():(e.interaction?.proposedCommandLine||'');
        await sendInteraction(e,{
          kind:'runCommand',
          confirm:allow,
          proposedCommandLine:e.interaction?.proposedCommandLine||'',
          submittedCommandLine
        });
      };
    }else if(act==='q_submit'){
      btn.onclick=async()=>{
        const questions=e.interaction?.questions||[];
        const responses=[];
        questions.forEach((q,qIdx)=>{
          const checked=$$(`input[name="q_opt_${idx}_${qIdx}"]:checked`).map(x=>x.value);
          const customAns=$(`#q_ans_${idx}_${qIdx}`)?.value.trim()||'';
          responses.push({
            questionId:q.id||q.questionId||String(qIdx),
            selectedOptions:checked,
            textResponse:customAns
          });
        });
        await sendInteraction(e,{kind:'askQuestion',responses,cancelled:false});
      };
    }else if(act==='q_cancel'){
      btn.onclick=async()=>{
        await sendInteraction(e,{kind:'askQuestion',responses:[],cancelled:true});
      };
    }else if(act==='perm'){
      btn.onclick=async()=>{
        const allow=btn.dataset.allow==='1';
        const scope=btn.dataset.scope||'PERMISSION_SCOPE_ONCE';
        await sendInteraction(e,{kind:'permission',allow,scope});
      };
    }else if(act==='generic'){
      btn.onclick=async()=>{
        const allow=btn.dataset.allow==='1';
        await sendInteraction(e,{kind:e.interaction?.kind||'generic',confirm:allow});
      };
    }else if(act==='art_appr'){
      btn.onclick=async()=>{
        await approveArtifact(btn.dataset.uri,true);
      };
    }else if(act==='art_rej'){
      btn.onclick=async()=>{
        const comment=$(`#art_comment_${idx}`)?.value.trim()||'';
        await approveArtifact(btn.dataset.uri,false,comment);
      };
    }
  });
}

async function sendInteraction(e,body){
  if(!state.conversationId)return;
  const payload={
    trajectoryId:e.trajectoryId,
    stepIndex:e.stepIndex,
    ...body
  };
  try{
    await api(`/api/v1/conversations/${encodeURIComponent(state.conversationId)}/interactions/respond`,{
      method:'POST',
      body:payload
    });
    toast('Interaction submitted');
  }catch(err){
    toast(err.message);
  }
}

async function approveArtifact(uri,approved=true,comment=''){
  if(!state.conversationId)return;
  try{
    const endpoint=approved?'approve':'reject';
    await api(`/api/v1/conversations/${encodeURIComponent(state.conversationId)}/artifacts/${endpoint}`,{
      method:'POST',
      body:{artifactUri:uri,approved,comment}
    });
    toast(approved?'Artifact approved':'Artifact rejected');
  }catch(err){
    toast(err.message);
  }
}

async function loadStatus(){
  try{
    const s=await api('/api/v1/status');
    $('#statusText').textContent=`connected · ${s.instances.length} LS`;
    if(!s.capabilities.integratedTerminal)$('#createTerminal').disabled=true;
  }catch(e){
    $('#statusText').textContent='not connected';
    toast(e.message);
  }
}
async function loadWorkspaces(){
  try{
    const d=await api('/api/v1/workspaces');
    $('#workspaceSelect').innerHTML='<option value="">Current workspace</option>'+d.workspaces.map(w=>`<option value="${escapeHtml(w)}">${escapeHtml(w.replace(/^file:\/\//,''))}</option>`).join('');
  }catch(e){
    toast(e.message);
  }
}
async function loadModels(){
  try{
    const d=await api('/api/v1/models');
    $('#modelSelect').innerHTML='<option value="">Default model</option>'+d.models.map(m=>`<option value="${escapeHtml(m.model)}">${escapeHtml(m.label)}</option>`).join('')}catch{}
}
async function loadConversations(){
  try{
    const d=await api('/api/v1/conversations');
    $('#conversationList').innerHTML=d.conversations.map(c=>`<div class="conversation ${c.id===state.conversationId?'active':''}" data-id="${escapeHtml(c.id)}"><strong>${escapeHtml(c.title)}</strong><small><span><i class="status-dot ${c.status}"></i>${escapeHtml(c.status)}</span><span>${c.stepCount}</span></small></div>`).join('');
    $$('.conversation').forEach(el=>el.onclick=()=>openConversation(el.dataset.id));
  }catch(e){
    toast(e.message);
  }
}
async function openConversation(id){
  try{
    if(state.conversationId&&state.conversationId!==id)unsubscribe('conversation',state.conversationId);
    state.conversationId=id;
    state.events.clear();
    const d=await api(`/api/v1/conversations/${encodeURIComponent(id)}`);
    for(const e of d.events||[])state.events.set(eventKey(e),e);
    $('#conversationHeader h2').textContent=id.slice(0,12);
    $('#promptInput').disabled=false;
    $('#sendBtn').disabled=false;
    $('#stopBtn').disabled=d.status!=='running';
    renderTimeline();
    subscribe('conversation',id);
    await loadConversations();
  }catch(e){
    toast(e.message);
  }
}

async function loadTerminals(){
  try{
    const q=state.conversationId?`?conversationId=${encodeURIComponent(state.conversationId)}`:'';
    const d=await api('/api/v1/terminals'+q);
    $('#terminalList').innerHTML=d.terminals.map(t=>`<button class="chip ${t.terminalId===state.terminalId?'active':''}" data-terminal="${escapeHtml(t.terminalId)}">${escapeHtml(t.title||t.terminalId.slice(0,8))}</button>`).join('');
    $$('[data-terminal]').forEach(b=>b.onclick=()=>selectTerminal(b.dataset.terminal));
  }catch(e){
    toast(e.message);
  }
}
function selectTerminal(id){
  if(state.terminalId&&state.terminalId!==id)unsubscribe('terminal',state.terminalId);
  state.terminalId=id;
  state.terminalText='';
  $('#terminalOutput').textContent='[terminal connected]\n';
  subscribe('terminal',id);
  loadTerminals();
}

function findBase64(obj,depth=0){
  if(!obj||depth>5)return null;
  if(typeof obj==='string'&&obj.length>100&&/^[A-Za-z0-9+/=\r\n]+$/.test(obj))return obj.replace(/\s/g,'');
  if(Array.isArray(obj)){
    for(const x of obj){
      const r=findBase64(x,depth+1);
      if(r)return r;
    }
  }else if(typeof obj==='object'){
    for(const k of ['inlineData','imageData','data','bytes','screenshot'])if(obj[k]){
      const r=findBase64(obj[k],depth+1);
      if(r)return r;
    }
    for(const v of Object.values(obj)){
      const r=findBase64(v,depth+1);
      if(r)return r;
    }
  }
  return null;
}
async function loadPages(){
  try{
    const d=await api('/api/v1/browser/pages');
    $('#pageList').innerHTML=d.pages.map((p,i)=>{
      const id=p.pageId||p.id||String(i);
      return `<div class="page ${id===state.selectedPageId?'active':''}" data-page="${escapeHtml(id)}"><strong>${escapeHtml(p.title||'Page')}</strong><small>${escapeHtml(p.url||id)}</small></div>`;
    }).join('');
    $$('[data-page]').forEach(el=>el.onclick=()=>{
      state.selectedPageId=el.dataset.page;
      capturePage(el.dataset.page);
    });
  }catch(e){
    toast(e.message);
  }
}
async function capturePage(id){
  try{
    state.selectedPageId=id;
    const d=await api(`/api/v1/browser/pages/${encodeURIComponent(id)}/screenshot`);
    const b64=findBase64(d);
    $('#browserPreview').innerHTML=b64?`<img alt="browser screenshot" src="data:image/png;base64,${b64}">`:`<pre>${escapeHtml(JSON.stringify(d,null,2))}</pre>`;
  }catch(e){
    toast(e.message);
  }
}

$$('.tab').forEach(btn=>btn.onclick=()=>{
  $$('.tab').forEach(x=>x.classList.toggle('active',x===btn));
  $$('.tab-panel').forEach(p=>p.classList.remove('active'));
  $(`#${btn.dataset.tab}Tab`).classList.add('active');
});
function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-(base64String.length%4))%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const rawData=window.atob(base64);
  const outputArray=new Uint8Array(rawData.length);
  for(let i=0;i<rawData.length;++i)outputArray[i]=rawData.charCodeAt(i);
  return outputArray;
}

$('#notifyBtn').onclick=async()=>{
  if(!('Notification' in window)){
    toast('Notifications not supported in this browser');
    return;
  }
  const perm=await Notification.requestPermission();
  if(perm!=='granted'){
    toast(`Notification permission: ${perm}`);
    return;
  }

  // Complete Web Push Subscription pipeline
  if('serviceWorker' in navigator && 'PushManager' in window){
    try{
      const reg=await navigator.serviceWorker.ready;
      const { publicKey }=await api('/api/v1/push/vapid-public-key');
      if(publicKey){
        const sub=await reg.pushManager.subscribe({
          userVisibleOnly:true,
          applicationServerKey:urlBase64ToUint8Array(publicKey)
        });
        await api('/api/v1/push/subscribe',{method:'POST',body:sub});
        toast('Web Push Subscribed! Testing background push...');
        await api('/api/v1/push/test',{
          method:'POST',
          body:{title:'Agy Remote Push Active',body:'Web Push is working even when app is closed!'}
        });
        return;
      }
    }catch(err){
      console.warn('[Push Subscribe]',err);
    }
  }

  toast('Foreground notifications enabled.');
  notifyApproval('Agy Remote Notifications', 'Notifications are active in foreground.');
};
$('#tokenBtn').onclick=()=>{
  const next=prompt('Agy Remote bearer token',state.token)||'';
  if(next){
    state.token=next;
    localStorage.setItem('agyToken',next);
    state.ws?.close();
    connectWs();
    loadStatus();
  }
};
$('#refreshConversations').onclick=loadConversations;
$('#newConversation').onclick=async()=>{
  try{
    const d=await api('/api/v1/conversations',{
      method:'POST',
      body:{
        workspaceUri:$('#workspaceSelect').value||undefined,
        model:$('#modelSelect').value||undefined
      }
    });
    await loadConversations();
    await openConversation(d.cascadeId);
  }catch(e){
    toast(e.message);
  }
};
$('#composer').onsubmit=async(e)=>{
  e.preventDefault();
  const text=$('#promptInput').value.trim();
  if(!text||!state.conversationId)return;
  $('#promptInput').value='';
  try{
    await api(`/api/v1/conversations/${encodeURIComponent(state.conversationId)}/messages`,{
      method:'POST',
      body:{text,model:$('#modelSelect').value||undefined}
    });
  }catch(err){
    toast(err.message);
  }
};
$('#stopBtn').onclick=()=>state.conversationId&&api(`/api/v1/conversations/${encodeURIComponent(state.conversationId)}/stop`,{method:'POST'}).catch(e=>toast(e.message));

$('#clearTerminal').onclick=()=>{
  state.terminalText='';
  $('#terminalOutput').textContent='';
};
$('#interruptTerminal').onclick=async()=>{
  if(!state.terminalId){
    toast('No active terminal selected');
    return;
  }
  try{
    await api(`/api/v1/terminals/${encodeURIComponent(state.terminalId)}/input`,{
      method:'POST',
      body:{input:'\x03'}
    });
    toast('Sent Ctrl+C');
  }catch(err){
    toast(err.message);
  }
};
$('#listTerminals').onclick=loadTerminals;
$('#createTerminal').onclick=async()=>{
  try{
    const workspaceUri=$('#workspaceSelect').value||undefined;
    if(!workspaceUri&&!state.conversationId){
      toast('Select a conversation or workspace first');
      return;
    }
    const t=await api('/api/v1/terminals',{
      method:'POST',
      body:{workspaceUri,conversationId:state.conversationId||''}
    });
    selectTerminal(t.terminalId);
    await loadTerminals();
  }catch(e){
    toast(e.message);
  }
};
$('#terminalForm').onsubmit=async(e)=>{
  e.preventDefault();
  if(!state.terminalId)return;
  const input=$('#terminalInput').value;
  $('#terminalInput').value='';
  try{
    await api(`/api/v1/terminals/${encodeURIComponent(state.terminalId)}/input`,{
      method:'POST',
      body:{input:input+'\n'}
    });
  }catch(err){
    toast(err.message);
  }
};

$('#refreshPages').onclick=loadPages;
$('#captureConsole').onclick=async()=>{
  if(!state.selectedPageId){
    toast('Select a browser page first');
    return;
  }
  try{
    const logs=await api(`/api/v1/browser/pages/${encodeURIComponent(state.selectedPageId)}/console`);
    const pre=$('#browserConsole');
    pre.style.display='block';
    pre.textContent=JSON.stringify(logs,null,2);
  }catch(e){
    toast(e.message);
  }
};
$('#openUrlForm').onsubmit=async(e)=>{
  e.preventDefault();
  const url=$('#openUrlInput').value.trim();
  if(!url)return;
  try{
    await api('/api/v1/browser/open',{method:'POST',body:{url}});
    setTimeout(loadPages,800);
  }catch(err){
    toast(err.message);
  }
};

if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
connectWs();
Promise.allSettled([loadStatus(),loadWorkspaces(),loadModels(),loadConversations()]);
