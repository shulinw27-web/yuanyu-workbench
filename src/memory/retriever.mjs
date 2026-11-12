import {memoryText,memoryBindings,memoryAssert,effectiveMemoryStatus,withinMemoryScope} from './policy.mjs';

/** Local-only ranking. Inputs must already belong to the current trusted owner. */
export function retrieveMemories({entries,query,siteBindings=[],includeEpisodes=false,ids,now=Date.now(),maxEntries=5,maxTokens=1500}){
  query=memoryText(query,2000);siteBindings=memoryBindings(siteBindings);memoryAssert(typeof includeEpisodes==='boolean'&&Array.isArray(entries));
  memoryAssert(Number.isInteger(maxEntries)&&maxEntries>=1&&maxEntries<=5&&Number.isInteger(maxTokens)&&maxTokens>=1&&maxTokens<=1500);
  if(ids!==undefined)memoryAssert(Array.isArray(ids)&&ids.length<=5&&new Set(ids).size===ids.length&&ids.every(id=>typeof id==='string'));
  const normalized=query.toLocaleLowerCase(),terms=[...new Set(normalized.match(/[a-z0-9_-]{2,}|[\p{Script=Han}]{1,2}/gu)||[])];
  const eligible=entries.filter(entry=>effectiveMemoryStatus(entry,now)==='active'&&withinMemoryScope(entry,siteBindings)&&(includeEpisodes||entry.kind!=='episode'));
  if(ids!==undefined)memoryAssert(ids.every(id=>eligible.some(entry=>entry.id===id)),'MEMORY_SELECTION_INVALID');
  const ranked=eligible.filter(entry=>ids===undefined||ids.includes(entry.id))
    .map(entry=>{const content=`${entry.title}\n${entry.content}`.toLocaleLowerCase();return {entry,score:terms.reduce((score,term)=>score+(content.includes(term)?1:0),0)+(entry.kind==='preference'?0.25:0)};})
    .filter(item=>item.score>0||ids?.includes(item.entry.id)).sort((a,b)=>b.score-a.score||b.entry.updatedAt.localeCompare(a.entry.updatedAt)||a.entry.id.localeCompare(b.entry.id));
  const result=[];let estimatedTokens=0;
  for(const {entry} of ranked){const cost=Buffer.byteLength(JSON.stringify(entry),'utf8');if(estimatedTokens+cost>maxTokens)continue;result.push(structuredClone(entry));estimatedTokens+=cost;if(result.length===maxEntries)break;}
  if(ids!==undefined)memoryAssert(result.length===ids.length,'MEMORY_CONTEXT_LIMIT');
  return {entries:result,estimatedTokens};
}
