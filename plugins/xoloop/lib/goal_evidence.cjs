'use strict';

const fs = require('node:fs');
const path = require('node:path');

function appendEvidence(evidencePath, record) {
  const absolutePath = path.resolve(evidencePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.appendFileSync(absolutePath, `${JSON.stringify(record)}\n`, 'utf8');
  return absolutePath;
}

function readEvidence(evidencePath) {
  const absolutePath = path.resolve(evidencePath);
  if (!fs.existsSync(absolutePath)) return [];
  const text = fs.readFileSync(absolutePath, 'utf8');
  return text.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return {
          schema: 'xoloop.evidence.invalid',
          status: 'invalid',
          parse_error: err.message,
          raw: line,
        };
      }
    });
}

function currentVerificationRecords(records, goalId, manifestHash, artifactHash) {
  return records.filter((record) =>
    record &&
    record.schema === 'xoloop.evidence.v0.1' &&
    record.goal_id === goalId &&
    record.manifest_hash === manifestHash &&
    record.artifact_hash === artifactHash
  );
}

function latestRecord(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  return records[records.length - 1] || null;
}

function latestCounterexample(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record && record.counterexample) return record.counterexample;
  }
  return null;
}

function currentOptimiseEvents(records, goalId, manifestHash) {
  return records.filter((record) =>
    record &&
    record.schema === 'xoloop.optimise_event.v0.1' &&
    record.goal_id === goalId &&
    record.manifest_hash === manifestHash
  );
}

module.exports = {
  appendEvidence,
  currentOptimiseEvents,
  currentVerificationRecords,
  latestCounterexample,
  latestRecord,
  readEvidence,
};
