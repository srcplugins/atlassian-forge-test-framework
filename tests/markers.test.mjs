import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacy } from './support/config.mjs';
import {
  isMarker,
  isRunMarker,
  legacyMarker,
  markerForms,
  markers,
  visibleMarkerPatterns,
} from '../src/core/markers.mjs';
const runId = '550e8400-e29b-41d4-a716-446655440000';
const current = [
  markers.fixtureProperty,
  markers.browserProject('demo-app'),
  markers.browserProjectName('forge-sandbox'),
  markers.disposableIssue(markers.runMarker(runId, 0)),
  markers.developmentProject,
  markers.developmentProjectName,
  markers.setupIssueSummary,
  markers.setupIssueLabel,
  markers.identityProject,
  markers.acceptance('setup', `${runId}/0`),
];

test('every written marker uses the configured namespace, never an earlier one', () => {
  assert.equal(markers.namespace, 'acme');
  for (const marker of current) {
    assert.match(marker, /acme/);
    assert.ok(!marker.includes(legacy.brand) && !marker.includes(legacy.slug), marker);
  }
  assert.equal(markers.runMarker(runId, 3), `acme-e2e-${runId}-3`);
  assert.equal(markers.acceptance('setup', 'detail'), 'acme acceptance setup: detail');
});

test('run markers are recognized in the current form and a legacy run prefix only', () => {
  const other = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  for (const marker of [markers.runMarker(runId, 0), `oa-e2e-${runId}-12`])
    assert.ok(isRunMarker(marker, runId), marker);
  for (const marker of [
    undefined,
    markers.runMarker(other, 0),
    `pls-e2e-${runId}-0`,
    `acme-e2e-${runId}-`,
    `acme-e2e-${runId}-0 `,
    `x-acme-e2e-${runId}-0`,
  ])
    assert.equal(isRunMarker(marker, runId), false, String(marker));
});

// Exact forms written under the earlier namespace, by marker shape.
test('earlier forms keep each marker shape: property key, label and prose', () => {
  assert.equal(legacyMarker(markers.fixtureProperty), `${legacy.slug}.fixture`);
  assert.equal(legacyMarker(markers.setupIssueLabel), `${legacy.slug}-setup-fixture`);
  assert.equal(
    legacyMarker(markers.browserProject('demo-app')),
    `${legacy.brand} browser fixtures v1: demo-app. Synthetic data only.`,
  );
  assert.equal(
    legacyMarker(markers.identityProject),
    `${legacy.brand} owned identity permission fixtures v1. Synthetic data only.`,
  );
  // Only the leading namespace is rewritten: an app slug containing it was written as is.
  const slugged = markers.browserProject('acme-widgets');
  assert.equal(
    legacyMarker(slugged),
    `${legacy.brand} browser fixtures v1: acme-widgets. Synthetic data only.`,
  );
  assert.ok(
    isMarker(`${legacy.brand} browser fixtures v1: acme-widgets. Synthetic data only.`, slugged),
  );
});

test('recognition accepts exactly the current marker or an earlier form', () => {
  for (const marker of current) {
    assert.deepEqual(markerForms(marker), [marker, legacyMarker(marker)]);
    assert.ok(isMarker(marker, marker));
    assert.ok(isMarker(legacyMarker(marker), marker));
  }
  const project = markers.browserProject('demo-app');
  for (const other of [
    undefined,
    null,
    '',
    'customer data',
    `${project} `,
    project.toUpperCase(),
    markers.browserProject('forge-sandbox'),
    legacyMarker(markers.browserProject('forge-sandbox')),
    legacyMarker(markers.identityProject),
  ])
    assert.equal(isMarker(other, project), false, String(other));
});

test('visible marker patterns cover the namespace and earlier brands as literal text', () => {
  const patterns = visibleMarkerPatterns().map((p) => new RegExp(p));
  for (const text of [
    markers.browserProjectName('x'),
    legacyMarker(markers.developmentProjectName),
    markers.runMarker(runId, 0),
    `oa-e2e-${runId}-0`,
    markers.acceptance('setup', 'detail'),
  ])
    assert.ok(
      patterns.some((p) => p.test(text)),
      text,
    );
  assert.ok(!patterns.some((p) => p.test('An ordinary issue summary')));
});
