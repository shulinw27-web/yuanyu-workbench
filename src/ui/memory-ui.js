// Trusted local UI. User memory is rendered as text, never as HTML or executable instructions.
export function createMemoryUI({state,element,append,button,invoke,mutation,refresh,render,confirmAction,isLocked,planSkill}) {
  const nav=button('记忆','nav-item',null);nav.dataset.view='memory';document.querySelector('.nav-list').append(nav);
  const view=element('section','view');view.id='view-memory';view.hidden=true;view.setAttribute('aria-labelledby','memory-title');
  view.innerHTML='<div class="page-heading"><div><h1 id="memory-title">个人记忆</h1><p class="page-description">只记住你确认的信息。历史、记忆和工作流分别管理。</p></div></div><section class="settings-section"><h2>保存一条记忆</h2><form id="memory-form"><input id="memory-id" type="hidden"><input id="memory-revision" type="hidden"><label class="field-label" for="memory-kind">类型</label><select id="memory-kind" class="text-input"><option value="preference">个人偏好</option><option value="knowledge">业务口径</option><option value="lesson">操作经验</option></select><label class="field-label" for="memory-title-input">标题</label><input id="memory-title-input" class="text-input" maxlength="80" required><label class="field-label" for="memory-content">内容</label><textarea id="memory-content" class="text-input" rows="3" maxlength="1000" required></textarea><label class="field-label" for="memory-site">适用站点</label><select id="memory-site" class="text-input"><option value="">通用个人偏好</option></select><label class="field-label" for="memory-expires">有效至（可选）</label><input id="memory-expires" type="date" class="text-input"><p class="form-note">业务口径默认7天后需复核，操作经验默认90天。不要填写密码、密钥或业务明细。</p><div class="inline-actions"><button class="button primary small" type="submit" id="memory-submit">确认保存</button><button class="text-button" id="memory-reset" type="button">清空表单</button></div><p id="memory-error" class="form-error" role="alert" hidden></p></form></section><section class="settings-section"><h2>留存设置</h2><label class="model-consent"><input type="checkbox" id="memory-episodes">保存已完成任务的脱敏摘要，30天后过期</label><label class="model-consent"><input type="checkbox" id="memory-lessons">为已完成且有修正复验记录的任务生成待确认经验候选，7天未确认清理</label><p class="form-note">两项默认关闭，分别控制。不会保存页面正文、模型思考或业务明细；经验只含安全错误码与复验结论，需你明确核实后才会启用，不会自动修改工作流或权限。发送给模型前仍需本次逐条选择。</p><button type="button" class="text-button" id="memory-clear-history">清理30天以前的浏览器运行历史</button></section><section class="settings-section"><h2>已保存与待确认</h2><p id="memory-availability" class="form-note"></p><div id="memory-list"></div></section>';
  document.querySelector('#main-content').append(view);
  const $=s=>view.querySelector(s),entries=()=>state.snapshot.memory?.entries||[];
  let fingerprint='',candidates=[],recommended=[],selected=new Set(),currentPlan='',requestPending=false,limit=8,reflection=false;
  function resetSelection(){selected.clear();candidates=[];recommended=[];currentPlan='';}
  $('#memory-reset').onclick=()=>$('#memory-form').reset();
  $('#memory-form').onsubmit=async event=>{
    event.preventDefault();if(isLocked())return;
    const payload={kind:$('#memory-kind').value,title:$('#memory-title-input').value.trim(),content:$('#memory-content').value.trim(),siteIds:$('#memory-site').value?[$('#memory-site').value]:[]};
    if($('#memory-id').value){payload.id=$('#memory-id').value;payload.expectedRevision=Number($('#memory-revision').value);}
    if($('#memory-expires').value)payload.expiresAt=new Date($('#memory-expires').value+'T23:59:59.000Z').toISOString();
    $('#memory-error').hidden=true;$('#memory-submit').disabled=true;
    try{await invoke('memory.save',payload);$('#memory-form').reset();resetSelection();await refresh();}
    catch(error){$('#memory-error').textContent=error.message;$('#memory-error').hidden=false;}
    finally{$('#memory-submit').disabled=false;}
  };
  $('#memory-episodes').onchange=()=>mutation('memory.settings',{rememberEpisodes:$('#memory-episodes').checked,expectedRevision:state.snapshot.memory?.revision},'摘要留存设置已更新。');
  $('#memory-lessons').onchange=()=>mutation('memory.settings',{rememberLessons:$('#memory-lessons').checked,expectedRevision:state.snapshot.memory?.revision},'经验候选设置已更新。');
  $('#memory-clear-history').onclick=()=>confirmAction('清理浏览器历史','清理30天以前的已结束浏览器运行；保留工作流的最小来源凭证，不删除产物文件或固定采购历史。','清理历史',()=>mutation('agent.history.clear',{before:new Date(Date.now()-30*86400000).toISOString(),confirmed:true},'历史已清理，工作流来源凭证保留。'));
  function edit(entry){$('#memory-form').reset();$('#memory-id').value=entry.id;$('#memory-revision').value=entry.revision;$('#memory-kind').value=entry.kind;$('#memory-title-input').value=entry.title;$('#memory-content').value=entry.content;$('#memory-site').value=entry.siteBindings?.[0]?.id||'';$('#memory-expires').value=entry.expiresAt?.slice(0,10)||'';$('#memory-title-input').focus();}
  function renderMemory(){
    const snapshot=state.snapshot,memory=snapshot.memory;
    const next=JSON.stringify([snapshot.identity?.companyId,snapshot.identity?.userId,snapshot.product?.modelSource,snapshot.product?.sponsoredModelId,snapshot.modelProfiles?.activeId,snapshot.modelProfiles?.revision,snapshot.model?.model,snapshot.model?.host,memory?.revision]);
    if(next!==fingerprint){resetSelection();if(fingerprint.split(',').slice(0,2).join(',')!==next.split(',').slice(0,2).join(','))$('#memory-form').reset();fingerprint=next;}
    const scope=$('#memory-site'),oldScope=scope.value;scope.replaceChildren();const option=element('option','','通用个人偏好');option.value='';scope.append(option);
    for(const site of snapshot.agentSites||[]){const node=element('option','',site.label||site.id);node.value=site.id;scope.append(node);}scope.value=oldScope;
    $('#memory-availability').textContent=memory?.available?'本机加密保存；所选记忆仅在你确认的任务中发送。':'系统加密不可用或账号未登录，不能保存记忆。';
    $('#memory-episodes').checked=!!memory?.settings?.rememberEpisodes;$('#memory-episodes').disabled=isLocked()||!memory?.available;
    $('#memory-lessons').checked=!!memory?.settings?.rememberLessons;$('#memory-lessons').disabled=isLocked()||!memory?.available;
    $('#memory-submit').disabled=isLocked()||!memory?.available;$('#memory-clear-history').disabled=isLocked();
    const target=$('#memory-list');target.replaceChildren();
    for(const entry of entries()){
      const card=element('article','memory-card');append(card,element('strong','',entry.title),element('p','',entry.content),element('p','form-note',`${({active:'已启用',proposed:'待确认',paused:'已停用',stale:'需重新核实',superseded:'已被新版本替代'})[entry.status]||entry.status} · v${entry.revision} · 来源 ${entry.source?.type||'用户'}${entry.expiresAt?' · 有效至 '+entry.expiresAt.slice(0,10):''}`));
      const actions=element('div','inline-actions');
      if(entry.kind!=='episode')actions.append(button('编辑','text-button',()=>edit(entry),{disabled:isLocked()}));
      if(['proposed','stale'].includes(entry.status))actions.append(button('核实并采纳','text-button',()=>mutation('memory.confirm',{id:entry.id,expectedRevision:entry.revision},'已确认这条记忆。'),{disabled:isLocked()}));
      else if(entry.status!=='superseded')actions.append(button(entry.status==='active'?'停用':'重新启用','text-button',()=>mutation('memory.enabled',{id:entry.id,enabled:entry.status!=='active',expectedRevision:entry.revision},'记忆状态已更新。'),{disabled:isLocked()}));
      actions.append(button('永久遗忘','text-button danger-text',()=>confirmAction('永久遗忘',`遗忘“${entry.title}”及其历史和派生摘要？当前任务会停止，已有离线备份须另行清理。`,'永久遗忘',()=>mutation('memory.forget',{id:entry.id,expectedRevision:entry.revision},'本机有效记忆及派生内容已删除。')),{disabled:state.actionPending||state.switching}));
      card.append(actions);target.append(card);
    }
    if(!target.children.length)target.append(element('p','muted-text','还没有记忆。你可以先保存一条输出偏好。'));
  }
  function appendPlan(plan,target){
    if(plan.skillId)return;
    const key=JSON.stringify([plan.goal,plan.siteIds,plan.mode]);if(key!==currentPlan){selected.clear();candidates=[];recommended=[];currentPlan=key;}
    const block=element('div','memory-plan');
    const input=element('input','text-input compact-input');input.type='number';input.min='1';input.max='12';input.value=limit;input.setAttribute('aria-label','本任务模型请求上限');input.onchange=()=>{limit=Math.max(1,Math.min(12,Number(input.value)||8));input.value=limit;};
    block.append(append(element('label','memory-budget'),'本任务最多模型请求 ',input,element('span','form-note','含规划、复核与总结；继续不刷新预算。')));
    if(plan.mode==='compatible_browser'){
      const check=element('input');check.type='checkbox';check.checked=reflection;check.onchange=()=>{reflection=check.checked;};
      block.append(append(element('label','model-consent'),check,'允许一次额外模型复核，计入同一请求预算'));
      block.append(button(requestPending?'正在本机检索…':'选择本次参考记忆','text-button',async()=>{
        if(requestPending)return;requestPending=true;
        try{const result=await invoke('memory.preview',{query:plan.goal,siteIds:plan.siteIds,includeEpisodes:true});candidates=result.entries||[];recommended=result.recommendedSkills||[];}
        catch(error){candidates=[];block.append(element('p','form-error',error.message));}
        finally{requestPending=false;render();}
      },{disabled:requestPending||isLocked()}));
      for(const entry of candidates){
        const checkbox=element('input');checkbox.type='checkbox';checkbox.checked=selected.has(entry.id);checkbox.onchange=()=>{if(checkbox.checked&&selected.size<5)selected.add(entry.id);else{selected.delete(entry.id);checkbox.checked=false;}};
        block.append(append(element('label','model-consent'),checkbox,`${entry.title}：${entry.content}`));
      }
      if(candidates.length)block.append(element('p','form-note',`仅勾选条目会发送至 ${state.snapshot.model?.host||'当前模型'}（${state.snapshot.model?.model||'已选模型'}）。切换模型或修改记忆后需重新选择。`));
      for(const skill of recommended)block.append(button(`推荐本机工作流：${skill.name}`,'text-button',()=>{const value=(state.snapshot.agentSkills||[]).find(s=>s.id===skill.id);if(value)planSkill(value);}));
    }
    target.append(block);
  }
  return {render:renderMemory,appendPlan,reset:resetSelection,consent:()=>selected.size?{memory:true,memoryIds:[...selected]}:{},options:()=>({budgetOptions:{maxModelRequests:limit},enableReflection:reflection})};
}
