const fs = require('node:fs');
const path = require('node:path');
const { AdapterError } = require('./errors.cjs');

const FAMILY_SCHEMA_VERSION = '1.0.0';

function compareStableStrings(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const _readJsonCache = new Map();

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(filePath) {
  const resolvedPath = path.resolve(filePath);
  let stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new AdapterError(
        'SCENARIO_FAMILY_FILE_NOT_FOUND',
        'familyPath',
        `Scenario family file not found: ${resolvedPath}`,
        { fixHint: 'Verify the path passed to loadScenarioFamily points to an existing JSON file.' },
      );
    }
    throw error;
  }
  const cacheEntry = _readJsonCache.get(resolvedPath);
  if (
    cacheEntry &&
    cacheEntry.mtimeMs === stats.mtimeMs &&
    cacheEntry.size === stats.size
  ) {
    return cloneJson(cacheEntry.value);
  }

  const value = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  _readJsonCache.set(resolvedPath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    value,
  });
  return cloneJson(value);
}

function validateEvent(event, caseId, index) {
  if (!event || typeof event !== 'object') {
    throw new AdapterError('EVENT_NOT_OBJECT', 'events', `Case ${caseId} events[${index}] must be an object`, { fixHint: `Ensure events[${index}] in case ${caseId} is a plain object with type and atMs fields.` });
  }
  if (!String(event.type || '').trim()) {
    throw new AdapterError('EVENT_TYPE_REQUIRED', 'type', `Case ${caseId} events[${index}] is missing type`, { fixHint: 'Set the type field to a non-empty string on every event object.' });
  }
  if (!Number.isFinite(Number(event.atMs)) || Number(event.atMs) < 0) {
    throw new AdapterError('EVENT_ATMS_INVALID', 'atMs', `Case ${caseId} events[${index}] must declare a non-negative atMs`, { fixHint: `Set atMs to a non-negative finite number on events[${index}] in case ${caseId}.` });
  }
}

function validateScenarioCase(scenarioCase, familyId, index) {
  if (!scenarioCase || typeof scenarioCase !== 'object') {
    throw new AdapterError('CASE_NOT_OBJECT', 'cases', `Family ${familyId} cases[${index}] must be an object`, { fixHint: `Ensure cases[${index}] in family ${familyId} is a plain object with id, title, sequence, seed, initialState, events, and expectations fields.` });
  }
  if (!String(scenarioCase.id || '').trim()) {
    throw new AdapterError('CASE_ID_REQUIRED', 'id', `Family ${familyId} cases[${index}] is missing id`, { fixHint: `Set a non-empty id string on cases[${index}] in family ${familyId}.` });
  }
  if (!String(scenarioCase.title || '').trim()) {
    throw new AdapterError('CASE_TITLE_REQUIRED', 'title', `Family ${familyId} case ${scenarioCase.id} is missing title`, { fixHint: `Set a non-empty title string on case ${scenarioCase.id} in family ${familyId}.` });
  }
  if (!Number.isFinite(Number(scenarioCase.sequence))) {
    throw new AdapterError('CASE_SEQUENCE_INVALID', 'sequence', `Family ${familyId} case ${scenarioCase.id} must declare sequence`, { fixHint: `Set sequence to a finite number on case ${scenarioCase.id} in family ${familyId}.` });
  }
  if (!Number.isFinite(Number(scenarioCase.seed))) {
    throw new AdapterError('CASE_SEED_INVALID', 'seed', `Family ${familyId} case ${scenarioCase.id} must declare seed`, { fixHint: `Set seed to a finite number on case ${scenarioCase.id} in family ${familyId}.` });
  }
  if (!scenarioCase.initialState || typeof scenarioCase.initialState !== 'object' || Array.isArray(scenarioCase.initialState)) {
    throw new AdapterError('CASE_INITIAL_STATE_REQUIRED', 'initialState', `Family ${familyId} case ${scenarioCase.id} must declare initialState`, { fixHint: `Add a non-null initialState object to case ${scenarioCase.id} in family ${familyId}.` });
  }
  if (!Array.isArray(scenarioCase.events) || scenarioCase.events.length === 0) {
    throw new AdapterError('CASE_EVENTS_REQUIRED', 'events', `Family ${familyId} case ${scenarioCase.id} must declare events[]`, { fixHint: `Add a non-empty events array to case ${scenarioCase.id} in family ${familyId}.` });
  }
  scenarioCase.events.forEach((event, eventIndex) => validateEvent(event, scenarioCase.id, eventIndex));
  if (!scenarioCase.expectations || typeof scenarioCase.expectations !== 'object' || Array.isArray(scenarioCase.expectations)) {
    throw new AdapterError('CASE_EXPECTATIONS_REQUIRED', 'expectations', `Family ${familyId} case ${scenarioCase.id} must declare expectations`, { fixHint: `Add a non-null expectations object to case ${scenarioCase.id} in family ${familyId}.` });
  }
}

function validateWorldLock(worldLock, familyId) {
  if (!worldLock || typeof worldLock !== 'object' || Array.isArray(worldLock)) {
    throw new AdapterError('WORLD_LOCK_REQUIRED', 'worldLock', `Family ${familyId} must declare worldLock`, { fixHint: 'Add a non-null worldLock object to the scenario family JSON with schemaVersion, worldId, simulator, feeModel, latencyModel, marketModel, and riskPolicy fields.' });
  }
  if (worldLock.schemaVersion !== FAMILY_SCHEMA_VERSION) {
    throw new AdapterError('WORLD_LOCK_SCHEMA_VERSION', 'schemaVersion', `Family ${familyId} worldLock schemaVersion must be ${FAMILY_SCHEMA_VERSION}`, { fixHint: `Set worldLock.schemaVersion to ${FAMILY_SCHEMA_VERSION} in family ${familyId}.` });
  }
  for (const key of ['worldId', 'simulator', 'feeModel', 'latencyModel', 'marketModel', 'riskPolicy']) {
    if (worldLock[key] === undefined || worldLock[key] === null) {
      throw new AdapterError('WORLD_LOCK_FIELD_MISSING', key, `Family ${familyId} worldLock is missing ${key}`, { fixHint: `Add a non-null ${key} field to worldLock in family ${familyId}.` });
    }
  }
}

function loadScenarioFamily(familyPath) {
  const resolvedPath = path.resolve(familyPath);
  const family = readJson(resolvedPath);
  if (!family || typeof family !== 'object' || Array.isArray(family)) {
    throw new AdapterError('SCENARIO_FAMILY_NOT_OBJECT', 'family', `Scenario family must be a JSON object: ${resolvedPath}`, { fixHint: 'The scenario family file must contain a top-level JSON object.' });
  }
  if (family.schemaVersion !== FAMILY_SCHEMA_VERSION) {
    throw new AdapterError('SCENARIO_FAMILY_SCHEMA_VERSION', 'schemaVersion', `Scenario family schemaVersion must be ${FAMILY_SCHEMA_VERSION}: ${resolvedPath}`, { fixHint: `Set schemaVersion to ${FAMILY_SCHEMA_VERSION} in the scenario family JSON.` });
  }
  if (!String(family.familyId || '').trim()) {
    throw new AdapterError('SCENARIO_FAMILY_ID_REQUIRED', 'familyId', `Scenario family is missing familyId: ${resolvedPath}`, { fixHint: 'Add a non-empty familyId string to the top-level scenario family JSON object.' });
  }
  if (!String(family.title || '').trim()) {
    throw new AdapterError('SCENARIO_FAMILY_TITLE_REQUIRED', 'title', `Scenario family ${family.familyId} is missing title`, { fixHint: 'Add a non-empty title string to the scenario family JSON.' });
  }
  if (!String(family.description || '').trim()) {
    throw new AdapterError('SCENARIO_FAMILY_DESCRIPTION_REQUIRED', 'description', `Scenario family ${family.familyId} is missing description`, { fixHint: 'Add a non-empty description string to the scenario family JSON.' });
  }
  validateWorldLock(family.worldLock, family.familyId);
  if (!family.generator || typeof family.generator !== 'object' || Array.isArray(family.generator)) {
    throw new AdapterError('SCENARIO_FAMILY_GENERATOR_REQUIRED', 'generator', `Scenario family ${family.familyId} is missing generator`, { fixHint: 'Add a non-null generator object with at least a seed field to the scenario family JSON.' });
  }
  if (!Number.isFinite(Number(family.generator.seed))) {
    throw new AdapterError('SCENARIO_FAMILY_GENERATOR_SEED_INVALID', 'seed', `Scenario family ${family.familyId} generator must declare seed`, { fixHint: `Set generator.seed to a finite number in scenario family ${family.familyId}.` });
  }
  if (!Array.isArray(family.cases) || family.cases.length === 0) {
    throw new AdapterError('SCENARIO_FAMILY_CASES_REQUIRED', 'cases', `Scenario family ${family.familyId} must declare cases[]`, { fixHint: `Add a non-empty cases array to scenario family ${family.familyId}.` });
  }

  const cases = family.cases.slice().sort((left, right) => {
    const seqCompare = Number(left.sequence) - Number(right.sequence);
    if (seqCompare !== 0) return seqCompare;
    return compareStableStrings(left.id, right.id);
  });

  const ids = new Set();
  cases.forEach((scenarioCase, index) => {
    validateScenarioCase(scenarioCase, family.familyId, index);
    if (ids.has(scenarioCase.id)) {
      throw new AdapterError('SCENARIO_FAMILY_DUPLICATE_CASE_ID', 'id', `Scenario family ${family.familyId} contains duplicate case id: ${scenarioCase.id}`, { fixHint: `Remove or rename the duplicate case id ${scenarioCase.id} in scenario family ${family.familyId}.` });
    }
    ids.add(scenarioCase.id);
  });

  return {
    familyId: family.familyId,
    title: family.title,
    description: family.description,
    worldLock: cloneJson(family.worldLock),
    generator: cloneJson(family.generator),
    caseCount: cases.length,
    cases: cloneJson(cases),
    sourcePath: resolvedPath,
  };
}

module.exports = {
  FAMILY_SCHEMA_VERSION,
  loadScenarioFamily,
  validateScenarioCase,
  validateWorldLock,
};
