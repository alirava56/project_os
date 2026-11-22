export const allocationId=/^split-[a-f0-9]{32}-[0-9]{1,3}$/;

export function splitSharedCost(total:bigint, projects:readonly string[]) {
  const ids=[...new Set(projects)].sort();
  if (ids.length<2 || ids.length>100 || total<BigInt(ids.length)) return [];
  const count=BigInt(ids.length);
  const share=total/count, remainder=total%count;
  return ids.map((projectId,index)=>({projectId,amount:share+(BigInt(index)<remainder?BigInt(1):BigInt(0))}));
}
