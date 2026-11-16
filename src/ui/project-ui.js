// Trusted local UI. Projects are directory registrations only; rendering never executes project content.
export function createProjectUI({state,element,append,button,invoke,mutation,refresh,render,confirmAction,isLocked,pickDirectory,toast}) {
  const navList=document.querySelector('.nav-list');
  const nav=button('项目','nav-item',null);nav.dataset.view='projects';
  navList.insertBefore(nav,navList.querySelector('[data-view="accounts"]'));
  const view=element('section','view');view.id='view-projects';view.hidden=true;view.setAttribute('aria-labelledby','projects-title');
  view.innerHTML='<div class="page-heading"><div><h1 id="projects-title">项目</h1><p class="page-description">以项目方式组织工作：从新建空目录开始，或登记一个本地已有文件夹。</p></div><span class="local-badge"><span class="dot"></span>记录保存在本机</span></div><section class="settings-section"><h2>创建空项目</h2><form id="project-create-form"><label class="field-label" for="project-create-name">项目名称</label><input id="project-create-name" class="text-input" maxlength="100" required><label class="field-label" for="project-create-root">存放位置</label><div class="inline-actions project-path-row"><input id="project-create-root" class="text-input" maxlength="2000" required placeholder="例如 D:\\work\\my-project"><button type="button" class="button secondary small" id="project-create-pick">选择位置…</button></div><p class="form-note">将在该位置新建文件夹；位置不存在或已为空文件夹时才会创建，不会覆盖任何已有内容。</p><div class="inline-actions"><button class="button primary small" type="submit" id="project-create-submit">创建并设为当前</button></div><p id="project-create-error" class="form-error" role="alert" hidden></p></form></section><section class="settings-section"><h2>从本地文件夹导入</h2><form id="project-import-form"><div class="inline-actions"><button type="button" class="button secondary small" id="project-import-pick">选择文件夹…</button><span id="project-import-selected" class="muted-text">尚未选择</span></div><input id="project-import-root" type="hidden"><label class="field-label" for="project-import-name">项目名称</label><input id="project-import-name" class="text-input" maxlength="100" placeholder="默认取文件夹名"><div class="inline-actions"><button class="button primary small" type="submit" id="project-import-submit">导入并设为当前</button></div><p class="form-note">只登记文件夹位置：不移动、不复制、不修改其中任何文件；删除项目也只移除登记记录。</p><p id="project-import-error" class="form-error" role="alert" hidden></p></form></section><section class="settings-section"><div class="section-heading"><h2>我的项目</h2><span id="project-count" class="tag">0</span></div><p class="form-note">当前项目会作为后续任务与产物整理的位置参考；任务数据仍按身份隔离保存在本机。</p><div id="project-list"></div></section>';
  document.querySelector('#main-content').append(view);
  const $=s=>view.querySelector(s);
  const projects=()=>state.snapshot.projects?.projects||[];
  const revision=()=>state.snapshot.projects?.revision;
  let editingId=null,importRoot='';
  async function pickInto(input,selected){
    if(typeof pickDirectory!=='function'){toast('当前环境不支持系统文件夹选择器，请手动输入路径。',true);return;}
    const result=await pickDirectory();
    if(!result||result.cancelled||typeof result.path!=='string')return;
    input.value=result.path;
    if(selected){importRoot=result.path;selected.textContent=result.path;const base=result.path.split(/[\\/]/).filter(Boolean).pop();if(base&&!$('#project-import-name').value)$('#project-import-name').value=base;}
  }
  $('#project-create-pick').onclick=()=>pickInto($('#project-create-root'));
  $('#project-import-pick').onclick=()=>pickInto($('#project-import-root'),$('#project-import-selected'));
  $('#project-create-form').onsubmit=async event=>{
    event.preventDefault();if(isLocked())return;
    const error=$('#project-create-error');error.hidden=true;$('#project-create-submit').disabled=true;
    try{await invoke('project.createEmpty',{name:$('#project-create-name').value.trim(),root:$('#project-create-root').value.trim(),expectedRevision:revision()});$('#project-create-form').reset();await refresh();toast('空项目已创建并设为当前项目。');}
    catch(fault){error.textContent=fault.message;error.hidden=false;}
    finally{$('#project-create-submit').disabled=false;render();}
  };
  $('#project-import-form').onsubmit=async event=>{
    event.preventDefault();if(isLocked())return;
    const error=$('#project-import-error');error.hidden=true;
    if(!importRoot){error.textContent='请先选择要导入的文件夹。';error.hidden=false;return;}
    const payload={root:importRoot,expectedRevision:revision()};
    if($('#project-import-name').value.trim())payload.name=$('#project-import-name').value.trim();
    $('#project-import-submit').disabled=true;
    try{await invoke('project.importFolder',payload);$('#project-import-form').reset();importRoot='';$('#project-import-selected').textContent='尚未选择';await refresh();toast('文件夹已导入并设为当前项目。');}
    catch(fault){error.textContent=fault.message;error.hidden=false;}
    finally{$('#project-import-submit').disabled=false;render();}
  };
  function projectCard(project){
    const card=element('article','reflection-card');
    const head=append(element('div','project-card-head'),element('strong','',project.name));
    if(project.id===state.snapshot.projects?.currentId)head.append(element('span','tag','当前项目'));
    head.append(element('span','tag',project.origin==='empty'?'新建空目录':'本地文件夹'));
    card.append(head,element('p','form-note',`位置：${project.root}`));
    card.append(element('p','form-note',`创建于 ${project.createdAt.slice(0,10)}${project.lastOpenedAt?` · 最近打开 ${project.lastOpenedAt.slice(0,10)}`:''}`));
    const actions=element('div','inline-actions');
    actions.append(
      button('打开所在位置','text-button',async()=>{
        try{await invoke('project.openFolder',{id:project.id});await refresh();}
        catch(fault){toast(fault.message,true);}
      },{disabled:isLocked()}),
      button(project.id===state.snapshot.projects?.currentId?'取消当前':'设为当前','text-button',()=>mutation('project.setCurrent',{id:project.id===state.snapshot.projects?.currentId?null:project.id,expectedRevision:revision()},'当前项目已更新。'),{disabled:isLocked()}),
      button('重命名','text-button',()=>{editingId=project.id;render();},{disabled:isLocked()}),
      button('删除记录','text-button danger-text',()=>confirmAction('删除项目记录',`将从工作台移除“${project.name}”的登记记录；文件夹及其中的文件不会被删除。`,'删除记录',()=>{if(editingId===project.id)editingId=null;return mutation('project.remove',{id:project.id,expectedRevision:revision()},'项目记录已删除，文件夹未改动。');}),{disabled:state.actionPending||state.switching})
    );
    card.append(actions);
    if(editingId===project.id){
      const row=element('div','inline-actions');
      const input=element('input','text-input compact-input');input.maxLength=100;input.value=project.name;input.setAttribute('aria-label','新的项目名称');
      row.append(input,
        button('保存名称','button primary small',async()=>{
          try{await invoke('project.rename',{id:project.id,name:input.value.trim(),expectedRevision:revision()});editingId=null;await refresh();toast('项目名称已更新。');}
          catch(fault){toast(fault.message,true);}
          finally{render();}
        },{disabled:isLocked()}),
        button('取消','text-button',()=>{editingId=null;render();})
      );
      card.append(row);
    }
    return card;
  }
  function renderProjects(){
    const locked=isLocked();
    $('#project-create-submit').disabled=locked;$('#project-import-submit').disabled=locked;
    $('#project-create-pick').disabled=locked;$('#project-import-pick').disabled=locked;
    const list=projects();
    $('#project-count').textContent=String(list.length);
    const target=$('#project-list');target.replaceChildren();
    for(const project of [...list].sort((a,b)=>(b.lastOpenedAt||b.createdAt).localeCompare(a.lastOpenedAt||a.createdAt)))target.append(projectCard(project));
    if(!list.length)target.append(element('p','muted-text','还没有项目。创建一个空目录，或导入一个本地文件夹开始。'));
  }
  return {render:renderProjects,reset(){editingId=null;}};
}
