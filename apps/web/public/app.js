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
  selectedPageId:null,
  modelFamilies:new Map(),
  selectedThinking:'high'
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

// Markdown & Code Highlighter
function renderMarkdown(text=''){
  if(!text)return '';
  let html=escapeHtml(text);

  // Fenced code blocks with language badge and copy button
  html=html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,(match,lang,code)=>{
    const langBadge=lang?`<span class="code-lang">${lang}</span>`:'<span>code</span>';
    return `<div class="code-block">
      <div class="code-header">${langBadge}<button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button></div>
      <pre><code>${code.trim()}</code></pre>
    </div>`;
  });

  // Inline code
  html=html.replace(/`([^`\n]+)`/g,'<code class="inline-code">$1</code>');

  // Headers
  html=html.replace(/^###### (.*$)/gim,'<h6>$1</h6>');
  html=html.replace(/^##### (.*$)/gim,'<h5>$1</h5>');
  html=html.replace(/^#### (.*$)/gim,'<h4>$1</h4>');
  html=html.replace(/^### (.*$)/gim,'<h3>$1</h3>');
  html=html.replace(/^## (.*$)/gim,'<h2>$1</h2>');
  html=html.replace(/^# (.*$)/gim,'<h1>$1</h1>');

  // Bold, Italic, Strikethrough
  html=html.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  html=html.replace(/__([^_]+)__/g,'<strong>$1</strong>');
  html=html.replace(/\*([^*]+)\*/g,'<em>$1</em>');
  html=html.replace(/~~([^~]+)~~/g,'<del>$1</del>');

  // Blockquotes
  html=html.replace(/^\> (.*$)/gim,'<blockquote>$1</blockquote>');

  // Unordered lists
  html=html.replace(/^\s*[-*+]\s+(.*$)/gim,'<ul><li>$1</li></ul>');
  html=html.replace(/<\/ul>\s*<ul>/gim,'');

  // Ordered lists
  html=html.replace(/^\s*\d+\.\s+(.*$)/gim,'<ol><li>$1</li></ol>');
  html=html.replace(/<\/ol>\s*<ol>/gim,'');

  // Links
  html=html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Line breaks in paragraphs
  html=html.replace(/\n\n/g,'<br/><br/>');

  return html;
}

window.copyCode=function(btn){
  const code=btn.closest('.code-block')?.querySelector('code')?.innerText||'';
  if(code&&navigator.clipboard){
    navigator.clipboard.writeText(code).then(()=>{
      const orig=btn.innerText;
      btn.innerText='Copied!';
      btn.classList.add('copied');
      setTimeout(()=>{btn.innerText=orig;btn.classList.remove('copied');},1800);
    });
  }
};

// ANSI Cleaner for terminal
function cleanAnsi(text=''){
  if(!text)return '';
  return text
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g,'')
    .replace(/\x1b\]0;[^\x07\x1b]*[\x07\x1b\\]/g,'')
    .replace(/\x1b[=><()][0-9;]*[a-zA-Z]/g,'')
    .replace(/\[\?25[hl]/g,'')
    .replace(/\[2J/g,'')
    .replace(/\[m/g,'')
    .replace(/\[H/g,'');
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
      state.terminalText+=cleanAnsi(e.output);
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
  if(e.type==='assistant.message')return `<article class="event assistant"><div class="meta">${escapeHtml(meta)}${e.streaming?' · streaming':''}</div><div class="markdown-body">${renderMarkdown(e.text)}</div></article>`;
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
            <button class="primary-btn" data-act="question" data-idx="${index}" data-allow="1">Submit Answer</button>
            <button class="danger" data-act="question" data-idx="${index}" data-allow="0">Cancel</button>
          </div>
        </div>
      </article>`;
    }
  }

  if(e.type==='artifact.review'){
    return `<article class="event approval">
      <div class="meta">artifact review · step ${e.stepIndex??'-'}</div>
      <div class="approval-card">
        <div><strong>Artifact:</strong> <code>${escapeHtml(e.artifactUri||'')}</code></div>
        <div><label><small>Review Feedback (optional):</small></label><input id="artifact_comment_${index}" placeholder="Leave comment…" /></div>
        <div class="actions-wrap">
          <button class="primary-btn" data-act="artifact" data-idx="${index}" data-allow="1">Approve Artifact</button>
          <button class="danger" data-act="artifact" data-idx="${index}" data-allow="0">Reject</button>
        </div>
      </div>
    </article>`;
  }

  if(e.type==='agent.question')return `<article class="event task"><div class="meta">question</div><strong>Agent is asking for input</strong><div>${renderMarkdown(e.text||'')}</div></article>`;
  if(e.type==='error')return `<article class="event error"><div class="meta">error</div><div>${escapeHtml(e.message||'Unknown error')}</div></article>`;
  return `<article class="event"><div class="meta">${escapeHtml(e.type)}</div><pre>${escapeHtml(JSON.stringify(e,null,2))}</pre></article>`;
}

function bindEventActions(events){
  $$('[data-act="file"]').forEach(btn=>{
    btn.onclick=async()=>{
      const ev=events[Number(btn.dataset.idx)];
      const allow=btn.dataset.allow==='1';
      const scope=btn.dataset.scope||'PERMISSION_SCOPE_ONCE';
      try{
        await api(`/api/v1/conversations/${encodeURIComponent(state.conversationId)}/interactions/respond`,{
          method:'POST',
          body:{
            trajectoryId:ev.trajectoryId,
            stepIndex:ev.stepIndex,
            kind:'filePermission',
            confirm:allow,
            grantedPath:ev.interaction?.path,
            scope:allow?scope:'PERMISSION_SCOPE_UNSPECIFIED'
          }
        });
        toast(allow?`Allowed (${scope})`:'Rejected');
      }catch(err){
        toast(err.message);
      }
    };
  });

  $$('[data-act="cmd"]').forEach(btn=>{
    btn.onclick=async()=>{
      const idx=Number(btn.dataset.idx);
      const ev=events[idx];
      const allow=btn.dataset.allow==='1';
      const editedCmd=$(`#cmd_input_${idx}`)?.value||ev.interaction?.proposedCommandLine;
      try{
        await api(`/api/v1/conversations/${encodeURIComponent(state.conversationId)}/interactions/respond`,{
          method:'POST',
          body:{
            trajectoryId:ev.trajectoryId,
            stepIndex:ev.stepIndex,
            kind:'runCommand',
            confirm:allow,
            proposedCommandLine:ev.interaction?.proposedCommandLine,
            submittedCommandLine:allow?editedCmd:undefined
          }
        });
        toast(allow?'Command confirmed':'Command rejected');
      }catch(err){
        toast(err.message);
      }
    };
  });

  $$('[data-act="question"]').forEach(btn=>{
    btn.onclick=async()=>{
      const idx=Number(btn.dataset.idx);
      const ev=events[idx];
      const allow=btn.dataset.allow==='1';
      if(!allow){
        try{
          await api(`/api/v1/conversations/${encodeURIComponent(state.conversationId)}/interactions/respond`,{
            method:'POST',
            body:{
              trajectoryId:ev.trajectoryId,
              stepIndex:ev.stepIndex,
              kind:'askQuestion',
              responses:[],
              cancelled:true
            }
          });
          toast('Question cancelled');
        }catch(err){
          toast(err.message);
        }
        return;
      }

      const questions=ev.interaction?.questions||[];
      const responses=[];
      questions.forEach((q,qIdx)=>{
        const checked=$$(`input[name="q_opt_${idx}_${qIdx}"]:checked`).map(x=>x.value);
        const typed=$(`#q_ans_${idx}_${qIdx}`)?.value?.trim();
        const answers=[...checked];
        if(typed&&!answers.includes(typed))answers.push(typed);
        responses.push(answers.length?answers:['']);
      });

      try{
        await api(`/api/v1/conversations/${encodeURIComponent(state.conversationId)}/interactions/respond`,{
          method:'POST',
          body:{
            trajectoryId:ev.trajectoryId,
            stepIndex:ev.stepIndex,
            kind:'askQuestion',
            responses,
            cancelled:false
          }
        });
        toast('Answers submitted');
      }catch(err){
        toast(err.message);
      }
    };
  });

  $$('[data-act="artifact"]').forEach(btn=>{
    btn.onclick=async()=>{
      const idx=Number(btn.dataset.idx);
      const ev=events[idx];
      const approved=btn.dataset.allow==='1';
      const comment=$(`#artifact_comment_${idx}`)?.value||'';
      try{
        const endpoint=approved?'approve':'reject';
        await api(`/api/v1/conversations/${encodeURIComponent(state.conversationId)}/artifacts/${endpoint}`,{
          method:'POST',
          body:{
            artifactUri:ev.artifactUri,
            approved,
            comment,
            model:getSelectedModel()
          }
        });
        toast(approved?'Artifact approved':'Artifact rejected');
      }catch(err){
        toast(err.message);
      }
    };
  });
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

// Models vs Thinking Intensity Decoupling
async function loadModels(){
  try{
    const d=await api('/api/v1/models');
    state.modelFamilies.clear();

    for(const m of d.models||[]){
      const label=m.label||'';
      const match=label.match(/^(.*?)(?:\s*\((Low|Medium|High|Thinking|Fast|Pro)\))?$/i);
      const baseName=(match?match[1]:label).trim();
      const intensity=(match&&match[2]?match[2].toLowerCase():'default');

      if(!state.modelFamilies.has(baseName)){
        state.modelFamilies.set(baseName,{
          name:baseName,
          models:{},
          quota:m.quota
        });
      }
      const fam=state.modelFamilies.get(baseName);
      fam.models[intensity]=m.model;
      if(!fam.models.default)fam.models.default=m.model;
    }

    const select=$('#baseModelSelect');
    select.innerHTML='<option value="">Default model</option>'+
      [...state.modelFamilies.keys()].map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  }catch{}
}

function getSelectedModel(){
  const base=$('#baseModelSelect').value;
  if(!base||!state.modelFamilies.has(base))return undefined;
  const fam=state.modelFamilies.get(base);
  const intensity=state.selectedThinking;
  return fam.models[intensity]||fam.models.high||fam.models.medium||fam.models.default||Object.values(fam.models)[0];
}

// Thinking Budget Segmented Control
$$('#thinkingSegmented .seg-btn').forEach(btn=>{
  btn.onclick=()=>{
    $$('#thinkingSegmented .seg-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedThinking=btn.dataset.val;
  };
});

async function loadConversations(){
  try{
    const d=await api('/api/v1/conversations');
    $('#conversationList').innerHTML=d.conversations.map(c=>`<div class="conversation ${c.id===state.conversationId?'active':''}" data-id="${escapeHtml(c.id)}"><strong>${escapeHtml(c.title)}</strong><small><span><i class="status-dot ${c.status}"></i>${escapeHtml(c.status)}</span><span>${c.stepCount} steps</span></small></div>`).join('');
    $$('.conversation').forEach(el=>el.onclick=()=>{
      openConversation(el.dataset.id);
      $('#agentSidebar').classList.remove('drawer-open');
    });
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
    renderTimeline();
    subscribe('conversation',id);
    loadConversations();
  }catch(e){
    toast(e.message);
  }
}

async function loadTerminals(){
  try{
    const d=await api('/api/v1/terminals');
    $('#terminalList').innerHTML=d.terminals.map(t=>{
      const tid=t.terminalId||t.id;
      return `<button type="button" class="chip ${tid===state.terminalId?'active':''}" data-tid="${escapeHtml(tid)}">${escapeHtml(t.title||tid)}</button>`;
    }).join('');
    $$('[data-tid]').forEach(el=>el.onclick=()=>selectTerminal(el.dataset.tid));
  }catch(e){
    toast(e.message);
  }
}

function selectTerminal(tid){
  if(state.terminalId&&state.terminalId!==tid)unsubscribe('terminal',state.terminalId);
  state.terminalId=tid;
  state.terminalText='';
  $('#terminalOutput').textContent='Connecting to terminal...';
  subscribe('terminal',tid);
  loadTerminals();
}

// Drawer and Mobile Layout Controls
$('#drawerBtn').onclick=()=>$('#agentSidebar').classList.toggle('drawer-open');
$('#closeDrawerBtn').onclick=()=>$('#agentSidebar').classList.remove('drawer-open');

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
        model:getSelectedModel()
      }
    });
    await loadConversations();
    await openConversation(d.cascadeId);
    $('#agentSidebar').classList.remove('drawer-open');
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
      body:{text,model:getSelectedModel()}
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
    const d=await api('/api/v1/terminals',{method:'POST',body:{}});
    await loadTerminals();
    selectTerminal(d.terminal?.terminalId||d.terminalId);
  }catch(e){
    toast(e.message);
  }
};
$('#terminalForm').onsubmit=async(e)=>{
  e.preventDefault();
  const input=$('#terminalInput').value;
  if(!state.terminalId)return;
  $('#terminalInput').value='';
  try{
    await api(`/api/v1/terminals/${encodeURIComponent(state.terminalId)}/input`,{
      method:'POST',
      body:{input:`${input}\r\n`}
    });
  }catch(err){
    toast(err.message);
  }
};

$('#refreshPages').onclick=loadPages;
$('#captureConsole').onclick=async()=>{
  if(!state.selectedPageId){
    toast('Select a page first');
    return;
  }
  try{
    const d=await api(`/api/v1/browser/pages/${encodeURIComponent(state.selectedPageId)}/console`);
    const logs=$('#browserConsole');
    logs.style.display='block';
    logs.textContent=(d.logs||[]).join('\n')||'No console logs captured.';
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
    $('#openUrlInput').value='';
    await loadPages();
  }catch(e){
    toast(e.message);
  }
};

// Initial boot
connectWs();
loadStatus();
loadWorkspaces();
loadModels();
loadConversations();
loadTerminals();
loadPages();
