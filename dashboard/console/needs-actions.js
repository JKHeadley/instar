export const needsContractHeaders = Object.freeze({ 'X-Instar-Needs-Contract': 'in-place-v1' });

const references = {
  approval: 'requestId',
  'approval-batch': 'disclosureId',
  credential: 'requestId',
};

export function readStrictAction(row) {
  if (!row || row.card != null || row.alsoOpens != null) return null;
  const { action } = row;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const keys = Object.keys(action);
  if (action.kind === 'instructions') {
    if (keys.length !== 2 || !keys.includes('steps') || !Array.isArray(action.steps)
      || action.steps.length < 1 || action.steps.length > 12
      || action.steps.some(step => typeof step !== 'string' || !step.trim())) return null;
    return { kind: action.kind, steps: action.steps.slice() };
  }
  const field = Object.hasOwn(references, action.kind) ? references[action.kind] : null;
  if (!field || keys.length !== 2 || !keys.includes(field)
    || typeof action[field] !== 'string' || !action[field].trim()) return null;
  return { kind: action.kind, [field]: action[field] };
}

export function canRenderStrictAction(row, adapters = {}) {
  const action = readStrictAction(row);
  return !!action && (action.kind === 'instructions' || typeof adapters[action.kind] === 'function');
}

// No strict row or detail is drawn unless it has one supported in-place action.
export function createStrictAction(row, adapters, doc = document) {
  const action = readStrictAction(row);
  if (!action) return null;
  if (action.kind === 'instructions') {
    const list = doc.createElement('ol');
    list.className = 'needs-instructions';
    for (const step of action.steps) {
      const item = doc.createElement('li');
      item.textContent = step;
      list.append(item);
    }
    return list;
  }
  const invoke = adapters[action.kind];
  if (typeof invoke !== 'function') return null;
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'link-btn needs-consent';
  button.textContent = action.kind === 'credential' ? 'Enter credential' : 'Review approval';
  button.addEventListener('click', () => invoke(action[references[action.kind]], button));
  return button;
}
