import {randomUUID} from 'node:crypto';

const fail=(code,effectState='not_started')=>Object.assign(new Error(code),{code,effectState});
const REF=/^r-[a-f0-9-]{36}-\d{1,3}$/;
const SAFE_CODE=/^[A-Z][A-Z0-9_]{1,79}$/;
const provenNotStarted=new Set(['STALE_REFERENCE','AGENT_TOOL_INPUT_INVALID','INVALID_BROWSER_ACTION','PAGE_CONTENT_CONSENT_REQUIRED','AGENT_TOOL_REJECTED','AGENT_TOOL_UNAVAILABLE','CREDENTIAL_FIELD_REQUIRES_TRUSTED_FILL','WRITE_CONFIRM_REQUIRED','INVALID_ELEMENT_ACTION','READ_ONLY_ACTION_INVALID']);

/** Serial, task-scoped executor. The ledger contains only metadata; page payloads remain in memory. */
export function createToolExecutor({registry,checkContext,onBudget=async()=>{},onEvidence=async()=>{},signal}){
  if(!registry||typeof registry.validate!=='function'||typeof checkContext!=='function')throw fail('AGENT_CONFIG_INVALID');
  const ledger=[],observations=new Map(),generations=new Map();let busy=false;
  const guard=async()=>{if(signal?.aborted)throw fail('CANCELLED');if(await checkContext()!==true)throw fail('AGENT_CONTEXT_CHANGED');if(signal?.aborted)throw fail('CANCELLED');};
  const invalidate=id=>{observations.delete(id);generations.set(id,(generations.get(id)??0)+1);};
  async function invoke(name,rawInput){
    if(busy)throw fail('AGENT_TOOL_BUSY');busy=true;
    let entry;
    try{
      await guard();const input=registry.validate(name,rawInput),descriptor=registry.descriptor(name);
      if(name==='browser_act'){
        const element=observations.get(input.siteId)?.elements.find(item=>item.ref===input.action.ref);
        if(!element||!REF.test(input.action.ref))throw fail('STALE_REFERENCE');
        if(element.credential===true)throw fail('CREDENTIAL_FIELD_REQUIRES_TRUSTED_FILL');
      }
      await onBudget({kind:'tool'});await guard();
      entry={id:randomUUID(),tool:name,version:descriptor.version,siteId:input.siteId,generation:generations.get(input.siteId)??0,status:'executing',effectState:'not_started'};ledger.push(entry);
      if(name!=='browser_observe')invalidate(input.siteId);
      entry.effectState='may_have_occurred';
      const output=await registry.execute(name,input);await guard();
      if(name==='browser_observe'){
        const valid=typeof output.text==='string'&&!!output.text.trim()&&!output.elements.some(item=>item.credential===true)&&output.mode!=='manual';
        const evidence={id:randomUUID(),tool:name,version:descriptor.version,siteId:input.siteId,generation:generations.get(input.siteId)??0,validRead:valid};
        observations.set(input.siteId,{elements:output.elements,evidence});
        entry.evidenceId=evidence.id;entry.effectState='observed';
        await onEvidence(structuredClone(evidence));await guard();
      }
      entry.status=name==='browser_handoff'||output.mode==='manual'?'awaiting_user':'succeeded';
      return {status:entry.status,effectState:entry.effectState,callId:entry.id,...(entry.evidenceId?{evidenceId:entry.evidenceId}:{}),output};
    }catch(error){
      const code=SAFE_CODE.test(error?.code??'')?error.code:'AGENT_TOOL_FAILED';
      const effectState=provenNotStarted.has(code)?'not_started':entry?'may_have_occurred':'not_started';
      if(entry){entry.status=effectState==='not_started'?'failed':'uncertain';entry.effectState=effectState;entry.code=code;}
      throw Object.assign(new Error(code),{code,effectState});
    }finally{busy=false;}
  }
  return Object.freeze({
    invoke,
    evidence:()=>[...observations.values()].map(item=>structuredClone(item.evidence)),
    ledger:()=>structuredClone(ledger),
    canComplete(requiredSiteIds){return requiredSiteIds.length>0&&requiredSiteIds.every(id=>observations.get(id)?.evidence.validRead===true);},
    invalidate
  });
}
