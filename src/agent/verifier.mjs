/** Verifies source coverage independently of a model's completion prose. */
export function verifyTaskResult({mode,context,observations,dirtySiteIds=[],evidence=[]}){
  const required=context.requiredSiteIds,dirty=new Set(dirtySiteIds);
  if(required.some(id=>dirty.has(id)||!observations.has(id)))return {status:'rejected',code:'AGENT_RESULT_UNVERIFIED',evidenceIds:[]};
  for(const id of required){const page=observations.get(id);if(typeof page?.text!=='string'||!page.text.trim()||!Array.isArray(page.elements)||page.elements.some(element=>element.credential))return {status:'rejected',code:'AGENT_RESULT_UNVERIFIED',evidenceIds:[]};}
  const evidenceIds=evidence.map(entry=>entry.id??entry.evidenceId).filter(id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id)).slice(-30);
  if(mode==='mock_browser'&&required.length===1&&required[0]==='interactive-mock'){
    const month=context.parameters.month??'2026-10',expected=month==='2026-09'?['SYN-091','9087']:month==='2026-10'?['SYN-101','12345']:[];
    const page=observations.get('interactive-mock');if(expected.length===2&&expected.every(value=>page.text.includes(value)))return {status:'verified',code:'SYNTHETIC_RESULT_VERIFIED',evidenceIds};
    return {status:'rejected',code:'AGENT_RESULT_UNVERIFIED',evidenceIds};
  }
  return {status:'needs_review',code:'USER_RESULT_REVIEW_REQUIRED',evidenceIds};
}
