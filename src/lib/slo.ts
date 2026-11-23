const bucketMs=15*60_000;
export const availabilityTarget=99.9;
type Observation={resourceId:string;checkedAt:string;state:string;source:string};

export function sampledAvailability(rows:readonly Observation[], now:number) {
  const end=Math.floor(now/bucketMs)*bucketMs;
  const expected=96;
  const buckets=new Map<string,Map<number,boolean>>();
  for (const row of rows) {
    const time=Date.parse(row.checkedAt);
    if (row.source!=='https' || !Number.isFinite(time) || time<end-expected*bucketMs || time>=end) continue;
    if (row.state!=='healthy' && row.state!=='unhealthy') continue;
    const slot=Math.floor(time/bucketMs);
    const resource=buckets.get(row.resourceId) ?? new Map<number,boolean>();
    resource.set(slot,row.state==='healthy' && resource.get(slot)!==false);
    buckets.set(row.resourceId,resource);
  }
  return [...buckets].map(([resourceId,slots])=>{
    const covered=slots.size;
    const failed=[...slots.values()].filter(healthy=>!healthy).length;
    const budget=covered*(1-availabilityTarget/100);
    return {resourceId,covered,expected,failed,availability:100*(covered-failed)/covered,
      errorBudgetRemaining:budget-failed};
  });
}
