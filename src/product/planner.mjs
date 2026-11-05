const fail=code=>Object.assign(new Error(code),{code});
export async function sponsoredPlan({client,modelId,text,month,consent,signal}){
  if(consent!==true)throw fail('MODEL_CONSENT_REQUIRED');
  if(typeof text!=='string'||!text.trim()||text.length>2000||!/^2026-(09|10)$/.test(month))throw fail('MODEL_INPUT_INVALID');
  if(/(?:password|api[_ -]?key|token|密码|密钥)\s*[:：=]/i.test(text))throw fail('SENSITIVE_TASK_TEXT');
  const tool={type:'function',function:{name:'propose_workflow_plan',description:'Propose the public purchase-monthly synthetic read-only recipe, never execute.',parameters:{type:'object',additionalProperties:false,properties:{recipeId:{type:['string','null'],enum:['purchase-monthly',null]},month:{type:'string'},explanation:{type:'string'},needsClarification:{type:'boolean'}},required:['recipeId','month','explanation','needsClarification']}}};
  const requester=await client.requester({modelId,consent:{taskText:true,pageContent:false}});
  const response=await requester({signal,messages:[{role:'system',content:'Use only public purchase-monthly: read approved synthetic procurement and warehouse records for 2026-09/10, match PO, generate local CSV draft. No writes, credentials or arbitrary tools. Return exactly one propose_workflow_plan call; unsupported requests use null recipe.'},{role:'user',content:JSON.stringify({task:text,selectedMonth:month})}],tools:[tool]});
  const calls=response?.tool_calls;if(calls?.length!==1||calls[0].function?.name!==tool.function.name)throw fail('MODEL_PLAN_INVALID');
  let plan;try{plan=JSON.parse(calls[0].function.arguments);}catch{throw fail('MODEL_PLAN_INVALID');}
  if(!plan||typeof plan!=='object'||Object.keys(plan).some(k=>!['recipeId','month','explanation','needsClarification','questions'].includes(k))||![null,'purchase-monthly'].includes(plan.recipeId)||plan.month!==month||typeof plan.explanation!=='string'||plan.explanation.length>1500||typeof plan.needsClarification!=='boolean')throw fail('MODEL_PLAN_INVALID');
  return {supported:plan.recipeId==='purchase-monthly'&&!plan.needsClarification,mode:'sponsored',recipeId:plan.recipeId,month,message:plan.explanation,questions:[],model:modelId};
}
