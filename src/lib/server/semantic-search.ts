import { suspiciousInRecord } from './credential-guard';
import { canSeeProject,projectPolicy,readTransaction,storedRecord,transaction,type Account } from './db';
import { MissingRecordError } from './record-service';
import type { Citation } from './project-memory';
import type { Doc } from '../types';

const model='multilingual-e5-base-v1';
const citationLimit=3;
type Entry={id:string;payload:string;record_version:number;updated_at:string;vectors?:number[][]};

function configuration() {
  const url=new URL(process.env.PROJECTOS_SEMANTIC_ORIGIN??'file:/');
  const token=process.env.PROJECTOS_SEMANTIC_TOKEN;
  if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.href!==url.origin+'/' || !url.port || !token || token.length<32) {
    throw new Error('Semantic model unavailable');
  }
  return {url:new URL('/embed',url),token};
}

async function embed(items:string[],role:'query'|'passage') {
  const {url,token}=configuration();
  const response=await fetch(url,{method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(35_000),
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({items,role})});
  const reader=response.body?.getReader();
  if (!response.ok || !reader) {await reader?.cancel();throw new Error('Semantic model unavailable');}
  let bytes=0, raw='';
  const decoder=new TextDecoder('utf8',{fatal:true});
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if (done) break;
      bytes+=value.length;
      if (bytes>350000) {await reader.cancel();throw new Error('Invalid embedding response');}
      raw+=decoder.decode(value,{stream:true});
    }
    const {model:actual,vectors,minimumBest,minimumCitation}=JSON.parse(raw+decoder.decode()) as {
      model:string;vectors:unknown;minimumBest?:number;minimumCitation?:number;
    };
    if (actual!==model || !Array.isArray(vectors) || vectors.length!==items.length || vectors.some(vector=>!validVector(vector))) {
      throw new Error('Invalid embedding response');
    }
    if (role==='query' && (!validSimilarity(minimumBest) || !validSimilarity(minimumCitation))) {
      throw new Error('Missing relevance calibration');
    }
    return {vectors:vectors as number[][],minimumBest,minimumCitation};
  } finally {reader.releaseLock();}
}

function validVector(vector:unknown):vector is number[] {
  return Array.isArray(vector) && vector.length===768
    && vector.every(value=>typeof value==='number' && Number.isFinite(value) && Math.abs(value)<=1);
}

function validSimilarity(score:unknown):score is number {
  return typeof score==='number' && Number.isFinite(score) && score>=0 && score<=1;
}

function documentChunks(doc:Doc) {
  if (suspiciousInRecord(doc) || /\[REDACTED/i.test(doc.title+'\n'+doc.body)) return [];
  const text=doc.body.trim();
  const chunks:string[]=[];
  for (let offset=0;offset<text.length && chunks.length<24;offset+=650) {
    const excerpt=text.slice(offset,offset+800).trim();
    if (excerpt) chunks.push(doc.title+'\n'+excerpt);
  }
  return chunks.length ? chunks : doc.title ? [doc.title] : [];
}

export async function rebuildSemanticIndex(account:Account,project:string,after:string) {
  configuration();
  const rows=await readTransaction(async db=>{
    if (!db.scopeIdentity) throw new Error('Semantic index requires PostgreSQL');
    await projectPolicy(db,account);
    if (!await storedRecord(db,account.workspaceId,'projects',project)) throw new MissingRecordError();
    return db.all<Entry>(`SELECT r.id,r.payload,r.record_version,r.updated_at FROM public.projectos_records r
      WHERE r.workspace_id=? AND r.project_id=? AND r.kind='docs' AND r.id>?
      ORDER BY r.id LIMIT 5`,account.workspaceId,project,after);
  });
  let indexed=0;
  for (const row of rows) {
    const chunks=documentChunks(JSON.parse(row.payload) as Doc);
    if (!chunks.length) continue;
    const {vectors}=await embed(chunks,'passage');
    const changed=await transaction(async db=>{
      await projectPolicy(db,account);
      const live=await storedRecord(db,account.workspaceId,'docs',row.id);
      if (live?.record_version!==row.record_version || live.project_id!==project) return 0;
      return db.run(`INSERT INTO semantic_index(workspace_id,document_id,revision,model,vectors) VALUES(?,?,?,?,?::jsonb)
        ON CONFLICT(workspace_id,document_id,model) DO UPDATE SET revision=excluded.revision,vectors=excluded.vectors`,
      account.workspaceId,row.id,row.record_version,model,JSON.stringify(vectors));
    });
    indexed+=changed;
  }
  return {indexed,after:rows.length===5?rows.at(-1)?.id:null};
}

export async function semanticSearch(account:Account,project:string,question:string) {
  // Check the live grant before any query text is sent to the local model.
  await readTransaction(async db=>{
    const policy=await projectPolicy(db,account);
    if (!db.scopeIdentity) throw new Error('Semantic index requires PostgreSQL');
    if (!canSeeProject(policy,project) || !await storedRecord(db,account.workspaceId,'projects',project)) throw new MissingRecordError();
  });
  const {vectors:[questionVector],minimumBest=1,minimumCitation=1}=await embed([question],'query');
  return readTransaction(async db=>{
    const policy=await projectPolicy(db,account);
    if (!canSeeProject(policy,project) || !await storedRecord(db,account.workspaceId,'projects',project)) throw new MissingRecordError();
    const rows=await db.all<Entry>(`SELECT r.id,r.payload,r.record_version,r.updated_at,i.vectors
      FROM semantic_index i JOIN public.projectos_records r ON r.workspace_id=i.workspace_id AND r.id=i.document_id
      AND r.record_version=i.revision AND r.kind='docs' WHERE i.workspace_id=? AND r.project_id=? AND i.model=?
      ORDER BY r.updated_at DESC,r.id LIMIT 150`,account.workspaceId,project,model);
    const result:{score:number;citation:Citation}[]=[];
    for (const row of rows) {
      const doc=JSON.parse(row.payload) as Doc;
      const chunks=documentChunks(doc);
      let best=minimumCitation, index=-1;
      row.vectors?.forEach((vector,offset)=>{
        if (chunks[offset] && validVector(vector)) {
          const score=vector.reduce((sum,value,position)=>sum+value*questionVector[position],0);
          if (score>best) {best=score;index=offset;}
        }
      });
      if (index>=0) result.push({score:best,citation:{id:'doc:'+row.id,kind:'doc',projectId:project,title:doc.title,
        href:'/docs?doc='+encodeURIComponent(row.id),updatedAt:row.updated_at,excerpt:chunks[index]}});
    }
    result.sort((a,b)=>b.score-a.score);
    return result[0]?.score>=minimumBest ? result.slice(0,citationLimit).map(item=>item.citation) : [];
  });
}
