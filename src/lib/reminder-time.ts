const dayMs = 86_400_000;

export function wallClock(zone: string, date: Date) {
  return new Intl.DateTimeFormat('sv-SE', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date).replace(' ','T');
}

export function localInstant(local: string, zone: string): number {
  const nominal = Date.parse(local + 'Z');
  if (!Number.isFinite(nominal)) return Number.NaN;
  const offsets = new Set([-dayMs,0,dayMs].map(away => {
    const at = nominal + away;
    return Date.parse(wallClock(zone,new Date(at)) + 'Z') - at;
  }));
  const options = [...offsets].map(offset => nominal-offset).sort((a,b) => a-b);
  // For a fall-back overlap use the earlier instant. A spring-forward gap moves forward.
  return options.find(at => wallClock(zone,new Date(at)) === local)
    ?? options.find(at => wallClock(zone,new Date(at)) > local) ?? Number.NaN;
}
