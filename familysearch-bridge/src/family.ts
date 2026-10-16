import { formatCardEvent, type PersonCard } from './session-client.js';

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

export function personSummary(value: unknown) {
  const p = record(value);
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/i.test(String(p.id || ''))) return undefined;
  return { id: String(p.id), name: p.name, gender: p.gender || p.genderConclusion?.details?.gender,
    lifespan: p.lifespan, living: p.living, memoryCount: p.memoryCount };
}

export function familySummary(value: unknown) {
  const data = record(value);
  const group = (value: unknown) => {
    const f = record(value);
    return {
      parent1: personSummary(f.parent1 || f.spouse1), parent2: personSummary(f.parent2 || f.spouse2),
      preferred: f.preferred,
      children: (Array.isArray(f.children) ? f.children : []).map((value: unknown) => {
        const c = record(value);
        return { ...personSummary(c.child || c), relationshipId: c.relationshipId,
          lineage: (Array.isArray(c.lineageConclusions) ? c.lineageConclusions : []).map((value: unknown) => {
            const lineage = record(value); const details = record(lineage.details);
            return { type: details.type || lineage.type, parentId: details.relatedPersonId, title: details.title };
          }) };
      }).filter((p: any) => p.id),
    };
  };
  return {
    parents: (Array.isArray(data.parents) ? data.parents : []).map(group),
    spouses: (Array.isArray(data.spouses) ? data.spouses : []).map(group),
  };
}

export function cardSummary(card: PersonCard, personId: string) {
  return { ...personSummary({ ...card, id: personId }),
    birth: formatCardEvent(card.birth), death: formatCardEvent(card.death) };
}
