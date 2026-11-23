export type VpnEvidence={
  wireguardState:'observed'|'unavailable';handshakeAt:string|null;
  serviceState:'ok'|'unconfigured'|'timeout'|'tls'|'connection'|'unexpected';latencyMs:number|null;
};
export type VpnObservation=VpnEvidence & {resourceId:string;checkedAt:string};

export function validVpnEvidence(value:unknown,stamp:number): value is VpnEvidence {
  if (!value || typeof value!=='object' || Array.isArray(value) ||
    Object.keys(value).some(key=>!['wireguardState','handshakeAt','serviceState','latencyMs'].includes(key))) return false;
  const v=value as VpnEvidence;
  const date=typeof v.handshakeAt==='string' ? Date.parse(v.handshakeAt):NaN;
  return ['observed','unavailable'].includes(v.wireguardState)
    && (v.handshakeAt===null || (v.wireguardState==='observed' && Number.isFinite(date) && date<=stamp))
    && ['ok','unconfigured','timeout','tls','connection','unexpected'].includes(v.serviceState)
    && (v.serviceState==='ok' ? Number.isInteger(v.latencyMs) && Number(v.latencyMs)>=0 && Number(v.latencyMs)<=5000 : v.latencyMs===null);
}

export function vpnState(item:VpnObservation,now:number) {
  const age=now-Date.parse(item.checkedAt);
  if (!Number.isFinite(age) || age<0 || age>15*60_000) return 'stale';
  const handshakeAge=Date.parse(item.checkedAt)-Date.parse(item.handshakeAt??'');
  if (!Number.isFinite(handshakeAge) || handshakeAge<0 || handshakeAge>3*60_000) {
    return item.serviceState==='ok'?'service_only':item.wireguardState==='observed'?'handshake_stale':'unknown';
  }
  return item.serviceState==='ok'?'handshake_and_service':'handshake_only';
}

export function vpnSummary(rows:readonly VpnObservation[],now:number) {
  const history=new Map<string,VpnObservation[]>();
  for (const row of rows) {
    const list=history.get(row.resourceId)??[];
    list.push(row);
    history.set(row.resourceId,list);
  }
  return [...history.values()].map(list=>{
    const latest=list[0];
    const lastSuccess=list.findIndex(row=>vpnState(row,Date.parse(row.checkedAt))==='handshake_and_service');
    return {...latest,state:vpnState(latest,now),
      lastSuccessfulAt:lastSuccess===-1?null:list[lastSuccess].checkedAt,
      consecutiveWithoutBoth:lastSuccess===-1?list.length:lastSuccess,
      recovered:lastSuccess===0 && list.length>1 && vpnState(list[1],Date.parse(list[1].checkedAt))!=='handshake_and_service'};
  });
}
