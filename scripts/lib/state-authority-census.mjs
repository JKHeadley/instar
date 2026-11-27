import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const KINDS = /^[a-z][a-z0-9-]*$/;
const isKind = value => typeof value === 'string' && KINDS.test(value);
const SCOPES = new Set(['agent', 'machine', 'tenant']);
const MODULE = /^(?:[\w-]+\/)*[\w.-]+\.[cm]?[jt]sx?$/;
const SINK_ARGUMENT = new Map([
  ['writeFile', 0], ['writeFileSync', 0], ['appendFile', 0], ['appendFileSync', 0],
  ['atomicWriteFileSync', 0], ['createWriteStream', 0], ['openDatabase', 0], ['Database', 0],
  ['DatabaseSync', 0], ['BetterSqlite3', 0], ['unlink', 0], ['unlinkSync', 0],
  ['rm', 0], ['rmSync', 0], ['safeUnlinkSync', 0], ['safeRmSync', 0],
  ['rename', 1], ['renameSync', 1], ['copyFile', 1], ['copyFileSync', 1],
]);

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDistinctList(value, predicate) {
  return Array.isArray(value) && value.length > 0
    && value.every(predicate) && new Set(value).size === value.length;
}

function validModule(value, sourceRoot) {
  return typeof value === 'string' && MODULE.test(value)
    && !value.split('/').includes('..') && fs.existsSync(path.join(sourceRoot, value));
}

function validPath(value) {
  return typeof value === 'string' && /^[\w.*][\w.*\/-]*$/.test(value)
    && !value.replace(/\/$/, '').split('/').some(part => !part || part === '..' || part === '.')
    && (!value.includes('*')
      || value.includes('/') && !value.endsWith('/') && !path.posix.dirname(value).includes('*'));
}

function locationsCanOverlap(left, right, sameStore) {
  if (left === right) return true;
  if (left.endsWith('/') || right.endsWith('/')) {
    return left.endsWith('/') && matchesLocation(left, right)
      || right.endsWith('/') && matchesLocation(right, left);
  }
  const leftGlob = left.includes('*');
  const rightGlob = right.includes('*');
  if (leftGlob && rightGlob) {
    // The supported patterns have a fixed parent and wildcard only in the
    // basename. Require different stores in the same parent to disambiguate
    // with exact locations rather than claiming two intersecting patterns.
    return !sameStore && path.posix.dirname(left) === path.posix.dirname(right);
  }
  if (leftGlob) return matchesLocation(left, right);
  return rightGlob && matchesLocation(right, left);
}

export function readAuthorityCensus(census, sourceRoot, categories) {
  if (census === undefined) return { physicalStores: [], contracts: [] };
  if (census?.version !== 1 || !Array.isArray(census.contracts) || !Array.isArray(census.stores)
    || !census.contracts.length || !census.stores.length) {
    throw new Error('authority census requires version 1, contracts and stores');
  }

  const stores = new Map();
  for (const store of census.stores) {
    if (!store || !isKind(store.id) || stores.has(store.id)) {
      throw new Error('authority census has a missing or duplicate store ID');
    }
    if (!['legacy', 'target', 'projection'].includes(store.role)
      || !categories.has(store.category)
      || !isDistinctList(store.adapters, module => validModule(module, sourceRoot))
      || !isDistinctList(store.locations, validPath)) {
      throw new Error(`invalid authority store "${store.id}" (role, category, adapter or location)`);
    }
    if (store.role === 'projection' && categories.get(store.category).scope !== 'derived-cache') {
      throw new Error(`projection "${store.id}" requires a derived-cache category`);
    }
    if (store.role !== 'projection' && categories.get(store.category).scope === 'derived-cache') {
      throw new Error(`authority store "${store.id}" cannot use a derived-cache category`);
    }
    if (store.sharedWith !== undefined && !isDistinctList(store.sharedWith, isText)) {
      throw new Error(`invalid shared ownership declaration for "${store.id}"`);
    }
    stores.set(store.id, store);
  }

  const contracts = new Set();
  const targets = new Set();
  const attached = new Set();
  for (const contract of census.contracts) {
    if (!contract || !isKind(contract.kind) || !SCOPES.has(contract.scope)) {
      throw new Error('authority contract requires a valid kind and scope');
    }
    const key = `${contract.kind}/${contract.scope}`;
    if (contracts.has(key)) throw new Error(`duplicate authority contract "${key}"`);
    contracts.add(key);
    if (contract.mode !== 'observe' || !validModule(contract.plannedOwner, sourceRoot)
      || !isDistinctList(contract.fields, field => /^[a-z][a-zA-Z0-9-]*$/.test(field))
      || !['identity', 'versionRule', 'retention', 'reconciliation', 'recovery'].every(field => isText(contract[field]))) {
      throw new Error(`invalid observe-mode authority contract "${key}"`);
    }
    const target = stores.get(contract.plannedStore);
    if (!target || target.role !== 'target' || targets.has(target.id) || !target.adapters.includes(contract.plannedOwner)) {
      throw new Error(`"${key}" requires one exclusively declared planned target store`);
    }
    targets.add(target.id);
    attached.add(target.id);
    if (!isDistinctList(contract.liveStores, id => ['legacy', 'target'].includes(stores.get(id)?.role))
      || !isText(contract.liveSelection)) {
      throw new Error(`"${key}" requires resolvable current stores and a live selection rule`);
    }
    for (const id of contract.liveStores) attached.add(id);
    if (!Array.isArray(contract.projections) || new Set(contract.projections).size !== contract.projections.length
      || contract.projections.some(id => stores.get(id)?.role !== 'projection')) {
      throw new Error(`"${key}" has an invalid projection edge`);
    }
    for (const id of contract.projections) {
      if (attached.has(id)) throw new Error(`projection "${id}" has multiple source owners`);
      attached.add(id);
    }
  }
  const locations = new Map();
  for (const store of stores.values()) {
    if (!attached.has(store.id)) throw new Error(`authority store "${store.id}" has no contract edge`);
    if (store.role === 'target' && !targets.has(store.id)) {
      throw new Error(`target store "${store.id}" has no planned owner`);
    }
    for (const location of store.locations) {
      for (const [declared, other] of locations) {
        if (locationsCanOverlap(location, declared, store.id === other)) {
          throw new Error(`overlapping protected locations in "${store.id}" and "${other}"`);
        }
      }
      locations.set(location, store.id);
    }
  }
  return { physicalStores: [...stores.values()], contracts: [...contracts] };
}

function nodeName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  return '';
}

function bindingScope(node) {
  let cursor = node.parent;
  while (cursor && !ts.isSourceFile(cursor) && !ts.isBlock(cursor)) cursor = cursor.parent;
  return cursor;
}

function visibleBinding(bindings, name, from) {
  let cursor = from;
  while (cursor) {
    const value = bindings.get(cursor)?.get(name);
    if (value) return value;
    cursor = cursor.parent;
  }
}

function staticPaths(node, bindings, seen = new Set()) {
  if (!node || seen.has(node)) return [];
  const nextSeen = new Set([...seen, node]);
  const resolve = child => staticPaths(child, bindings, nextSeen);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text + node.templateSpans.map(span => '~' + span.literal.text).join('')];
  }
  if (ts.isIdentifier(node)) {
    const declaration = visibleBinding(bindings, node.text, node);
    return declaration && declaration.kind === 'value' ? resolve(declaration.node) : [`@${node.text}`];
  }
  if (ts.isPropertyAccessExpression(node)) return [`@${node.name.text}`];
  if (ts.isParenthesizedExpression(node)) return resolve(node.expression);
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return [...resolve(node.left), ...resolve(node.right)];
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return resolve(node.left).flatMap(left => resolve(node.right).map(right => left + right)).slice(0, 16);
    }
  }
  if (ts.isConditionalExpression(node)) return [...resolve(node.whenTrue), ...resolve(node.whenFalse)];
  if (ts.isCallExpression(node) && ['join', 'resolve'].includes(nodeName(node.expression))) {
    let parts = [''];
    for (const arg of node.arguments) {
      const variants = resolve(arg);
      if (!variants.length) return [];
      parts = parts.flatMap(base => variants.map(value => base ? `${base}/${value}` : value)).slice(0, 16);
    }
    return parts;
  }
  return [];
}

function sinkName(node, bindings, seen = new Set()) {
  if (seen.has(node)) return '';
  if (ts.isIdentifier(node)) {
    const binding = visibleBinding(bindings, node.text, node);
    if (binding?.kind === 'sink') return binding.name;
    if (binding?.kind === 'value') return sinkName(binding.node, bindings, new Set([...seen, node]));
  }
  return nodeName(node);
}

function matchesLocation(location, value) {
  if (location.endsWith('/')) {
    const directory = location.slice(0, -1);
    return value === directory || value.startsWith(location);
  }
  if (location.includes('*')) {
    const pattern = location.split('*').map(literal => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    return new RegExp(`^${pattern}$`).test(value);
  }
  return value === location;
}

function ownsLocation(location, candidate) {
  const normalized = candidate.replace(/\\/g, '/');
  const match = normalized.replace(/\.(?:tmp|new|bak)$/, '').split('/');
  const prefix = match.findIndex(part => /^@\w*(?:stateDir|StateDir)$/.test(part) || part === '.instar');
  const fragments = prefix === -1 ? match : match.slice(prefix + 1);
  return matchesLocation(location, fragments.join('/'));
}

// Same-file static resolution only. Runtime and interprocedural writes remain census/review work.
export function findAuthorityWrites(content, relativeFile, stores) {
  if (!stores.length || !/writeFile|atomicWriteFileSync|appendFile|createWriteStream|Database|rename|copyFile|unlink|safeRm|\brm\b|rmSync/.test(content)) return [];
  const source = ts.createSourceFile(relativeFile, content, ts.ScriptTarget.Latest, true);
  const bindings = new Map();
  const register = (node, name, value) => {
    const scope = bindingScope(node);
    if (!bindings.has(scope)) bindings.set(scope, new Map());
    if (!bindings.get(scope).has(name)) bindings.get(scope).set(name, value);
    else bindings.get(scope).set(name, { kind: 'ambiguous' });
  };
  const collect = node => {
    if (ts.isImportSpecifier(node) && node.propertyName) {
      register(node, node.name.text, { kind: 'sink', name: node.propertyName.text });
    } else if (ts.isVariableDeclaration(node) && node.initializer
      && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      if (ts.isIdentifier(node.name)) register(node, node.name.text, { kind: 'value', node: node.initializer });
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const field of node.name.elements) {
          if (ts.isIdentifier(field.name)) register(node, field.name.text, { kind: 'sink', name: field.propertyName?.getText(source) ?? field.name.text });
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const findings = [];
  const visit = node => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const sink = sinkName(node.expression, bindings);
      const index = SINK_ARGUMENT.get(sink);
      if (index !== undefined) {
        const affected = sink === 'rename' || sink === 'renameSync' ? [0, index] : [index];
        const candidates = affected.flatMap(argument => staticPaths(node.arguments?.[argument], bindings));
        for (const store of stores) {
          if (store.adapters.includes(relativeFile)) continue;
          if (!store.locations.some(location => candidates.some(candidate => ownsLocation(location, candidate)))) continue;
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          findings.push({ line, store: store.id, role: store.role });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
