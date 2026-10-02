import { ContextCompactionEngine, type Message as CompactionMessage } from '../context-compaction-engine';
import type { CompactionSink } from '../types';

export interface BenchmarkMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
export interface BenchmarkFixture { version: 1; id: string; metadata: { model: string; tokenizer: string; seed: number }; messages: BenchmarkMessage[]; gold: { mustRetain: string[]; forbidden: string[] } }
export type BenchmarkPolicy = 'identity' | 'current-compaction' | 'duplicate-pruning';
export interface BenchmarkRun { fixtureId: string; policy: BenchmarkPolicy; tokenCount: { input: number; output: number; savings: number; ratio: number; kind: 'estimated'; counter: string }; wallTimeMs: 0; metrics: { retainedFacts: number; factCount: number; forbiddenLeaks: number; toolPairsValid: boolean } }
export interface FixtureReplay { fixtureId: string; version: 1; metadata: BenchmarkFixture['metadata']; runs: BenchmarkRun[] }
export interface Comparison { aggregate: { fixtureCount: number; policies: Record<string, { factRecall: number; forbiddenLeaks: number; tokenSavings: number }> }; worstCase: { fixtureId: string; policy: string; factRecall: number; forbiddenLeaks: number }; perFixture: FixtureReplay[] }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function validateMessage(v: unknown): asserts v is BenchmarkMessage {
  if (!record(v) || !['system','user','assistant','tool'].includes(String(v.role)) || typeof v.content !== 'string') throw new Error('Invalid fixture messages');
  if (v.tool_call_id !== undefined && (!nonempty(v.tool_call_id) || v.role !== 'tool')) throw new Error('Invalid tool result structure');
  if (v.tool_calls !== undefined) {
    if (v.role !== 'assistant' || !Array.isArray(v.tool_calls)) throw new Error('Invalid tool calls structure');
    for (const c of v.tool_calls) if (!record(c) || !nonempty(c.id) || c.type !== 'function' || !record(c.function) || !nonempty(c.function.name) || typeof c.function.arguments !== 'string') throw new Error('Invalid tool call structure');
  }
}
function pairsValid(messages: BenchmarkMessage[]): boolean {
  const pending = new Set<string>(), seen = new Set<string>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) { if (seen.has(call.id)) return false; seen.add(call.id); pending.add(call.id); }
    if (m.role === 'tool') { const id=m.tool_call_id; if (!id || !pending.has(id)) return false; pending.delete(id); }
  }
  return pending.size === 0;
}
export function loadFixture(value: unknown): BenchmarkFixture {
  if (!record(value)) throw new Error('Invalid fixture');
  if (value.version !== 1) throw new Error('Unsupported fixture version');
  const md=value.metadata, gold=value.gold;
  if (!nonempty(value.id) || !record(md) || !nonempty(md.model) || !nonempty(md.tokenizer) || !Number.isSafeInteger(md.seed) || (md.seed as number)<0 || !Array.isArray(value.messages) || !record(gold) || !Array.isArray(gold.mustRetain) || !gold.mustRetain.every(nonempty) || !Array.isArray(gold.forbidden) || !gold.forbidden.every(nonempty)) throw new Error('Invalid fixture metadata/schema');
  value.messages.forEach(validateMessage);
  return value as unknown as BenchmarkFixture;
}
function tokens(ms: BenchmarkMessage[]): number { return ms.reduce((n,m)=>n+Math.ceil(m.content.length/4)+4+(m.role==='assistant'?3:0)+(m.tool_calls??[]).reduce((x,c)=>x+Math.ceil((c.id.length+c.type.length+c.function.name.length+c.function.arguments.length)/4),0)+(m.tool_call_id?Math.ceil(m.tool_call_id.length/4):0),0); }
function leaks(ms: BenchmarkMessage[], p: string): boolean { return ms.some(m=>m.content.includes(p)||(m.tool_calls??[]).some(c=>c.function.arguments.includes(p)||c.function.name.includes(p))); }
const sink: CompactionSink={write:async()=>undefined};
export async function replayFixture(input: BenchmarkFixture): Promise<FixtureReplay> {
  const f=loadFixture(input), source=f.messages.map(m=>({...m}));
  const engine=new ContextCompactionEngine(sink,{maxContextTokens:1,autoCompactThreshold:0,keepRecentMessages:3,recentTailTokens:0,preCompactionFlush:false,protectToolPairs:true});
  const compacted=await engine.manualCompact(source as CompactionMessage[]);
  const output=compacted.compressed.map(m=>({...m} as BenchmarkMessage)), inputTokens=tokens(source);
  const eligible = (m: BenchmarkMessage) => m.role === 'assistant' && !m.tool_calls?.length;
  const keyOf = (m: BenchmarkMessage) => JSON.stringify([m.role, m.content, m.tool_call_id ?? null]);
  const seen = new Set<string>();
  const duplicatePruned = source.filter((m) => {
    if (!eligible(m)) return true;
    const key = keyOf(m);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const run=(policy:BenchmarkRun['policy'],ms:BenchmarkMessage[]):BenchmarkRun=>{const corpus=ms.map(m=>m.content).join('\n');return{fixtureId:f.id,policy,tokenCount:{input:inputTokens,output:tokens(ms),savings:inputTokens-tokens(ms),ratio:inputTokens?tokens(ms)/inputTokens:1,kind:'estimated',counter:'chars-div-4+role-structure-v1'},wallTimeMs:0,metrics:{retainedFacts:f.gold.mustRetain.filter(x=>corpus.includes(x)).length,factCount:f.gold.mustRetain.length,forbiddenLeaks:f.gold.forbidden.filter(p=>leaks(ms,p)).length,toolPairsValid:pairsValid(ms)}}};
  return{fixtureId:f.id,version:1,metadata:{...f.metadata},runs:[run('identity',source),run('current-compaction',output),run('duplicate-pruning',duplicatePruned)]};
}
export function compareRuns(replays:FixtureReplay[]):Comparison {
 const ids=new Set<string>(); for(const r of replays){if(ids.has(r.fixtureId))throw new Error(`Duplicate fixture ID: ${r.fixtureId}`);ids.add(r.fixtureId)}
 const unique=[...replays], policies=[...new Set(unique.flatMap(r=>r.runs.map(x=>x.policy)))].sort(), aggregate:Comparison['aggregate']['policies']={};
 for(const p of policies){const rs=unique.flatMap(r=>r.runs.filter(x=>x.policy===p)), count=rs.reduce((n,r)=>n+r.metrics.factCount,0);aggregate[p]={factRecall:count?rs.reduce((n,r)=>n+r.metrics.retainedFacts,0)/count:1,forbiddenLeaks:rs.reduce((n,r)=>n+r.metrics.forbiddenLeaks,0),tokenSavings:rs.reduce((n,r)=>n+r.tokenCount.input-r.tokenCount.output,0)}}
 const cs=unique.flatMap(r=>r.runs.map(x=>({fixtureId:r.fixtureId,policy:x.policy,factRecall:x.metrics.factCount?x.metrics.retainedFacts/x.metrics.factCount:1,forbiddenLeaks:x.metrics.forbiddenLeaks}))).sort((a,b)=>a.factRecall-b.factRecall||b.forbiddenLeaks-a.forbiddenLeaks||a.fixtureId.localeCompare(b.fixtureId)||a.policy.localeCompare(b.policy));
 return{aggregate:{fixtureCount:unique.length,policies:aggregate},worstCase:cs[0]??{fixtureId:'',policy:'',factRecall:1,forbiddenLeaks:0},perFixture:unique.sort((a,b)=>a.fixtureId.localeCompare(b.fixtureId))};
}
export function renderReport(comparison:Comparison):string{return JSON.stringify(comparison,null,2)+'\n'}
